import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir, cpus, networkInterfaces } from 'node:os';
import { join, resolve, sep, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, expect } from '@playwright/test';
import { createTinyServer } from '../server/app.mjs';
import { seedDatabase } from '../server/database.mjs';

// Runs the actual release executable against an isolated SQLite database.
// CDP and fake media are enabled only for this child process.
const root = fileURLToPath(new URL('../', import.meta.url));
const executable = join(root, 'src-tauri', 'target', 'release', 'tiny.exe');
if (process.platform !== 'win32' || !existsSync(executable))
  throw new Error('Build Tiny on Windows first: npm run build:desktop');

async function unusedLoopbackPort() {
  const socket = createServer();
  await new Promise((accept, reject) => {
    socket.once('error', reject);
    socket.listen(0, '127.0.0.1', accept);
  });
  const port = socket.address().port;
  await new Promise((accept, reject) =>
    socket.close((error) => (error ? reject(error) : accept())),
  );
  return port;
}

const data = await mkdtemp(join(tmpdir(), 'tiny-desktop-test-'));
let app;
let child;
let browser;
try {
  // Ephemeral ports avoid the user's running Tiny server and developer browsers.
  const lanAddress = process.argv.includes('--test-lan')
    ? Object.values(networkInterfaces())
        .flat()
        .find(
          (item) =>
            item &&
            item.family === 'IPv4' &&
            !item.internal &&
            /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(item.address),
        )?.address
    : undefined;
  if (process.argv.includes('--test-lan') && !lanAddress)
    throw new Error('No private IPv4 LAN adapter is available to test.');
  app = createTinyServer({
    dbPath: join(data, 'test.sqlite'),
    host: lanAddress || '127.0.0.1',
    port: 0,
  });
  await seedDatabase(app.db);
  await app.listen();
  const api = `http://${lanAddress || '127.0.0.1'}:${app.server.address().port}`;
  const debugging = `http://127.0.0.1:${await unusedLoopbackPort()}`;
  child = spawn(executable, [], {
    windowsHide: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      WEBVIEW2_USER_DATA_FOLDER: join(data, 'webview'),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${new URL(debugging).port} --use-fake-ui-for-media-stream --use-fake-device-for-media-stream`,
    },
  });
  await new Promise((accept, reject) => {
    child.once('spawn', accept);
    child.once('error', reject);
  });
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error(
        `Tiny exited before its webview was ready: ${child.exitCode ?? child.signalCode}`,
      );
    try {
      const response = await fetch(`${debugging}/json/version`, {
        signal: AbortSignal.timeout(750),
      });
      if (response.ok) {
        ready = true;
        break;
      }
    } catch {
      /* WebView2 is still starting. */
    }
    await delay(500);
  }
  if (!ready)
    throw new Error('Tiny’s WebView2 debugging endpoint did not start.');
  browser = await chromium.connectOverCDP(debugging, { timeout: 10_000 });
  const context = browser.contexts()[0];
  if (!context)
    throw new Error('Tiny’s webview did not expose a browser context.');
  const page =
    context.pages()[0] ||
    (await context.waitForEvent('page', { timeout: 10_000 }));
  await expect(page).toHaveURL(/^http:\/\/tauri\.localhost/);
  await expect(page.locator('body')).toContainText('Tiny');
  await expect(page.locator('input[type="password"]')).toBeVisible();
  await expect(page.getByLabel('Server URL', { exact: true })).toHaveCount(0);
  await expect(page.getByText('TINY NETWORK', { exact: true })).toBeVisible();
  const capabilities = await page.evaluate(() => ({
    secure: window.isSecureContext,
    microphone: typeof navigator.mediaDevices?.getUserMedia === 'function',
    screen: typeof navigator.mediaDevices?.getDisplayMedia === 'function',
  }));
  expect(capabilities).toEqual({
    secure: true,
    microphone: true,
    screen: true,
  });
  // Test native-origin CORS without touching the user's normal server/database.
  const response = await page.evaluate(async (api) => {
    const result = await fetch(`${api}/api/auth/local`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ handle: 'alice', password: 'tiny-local-demo' }),
    });
    return { ok: result.ok, body: await result.json() };
  }, api);
  expect(response.ok).toBe(true);
  expect(response.body.user.handle).toBe('alice');
  if (lanAddress)
    console.log(
      'Native client successfully authenticated to an HTTP API using the PC’s private LAN address.',
    );
  if (process.argv.includes('--measure-idle')) {
    // Measure the installed release app and all of its WebView2 children,
    // never the developer server, test browser, or unrelated Edge windows.
    await delay(2000);
    const execute = promisify(execFile);
    const snapshot = async (minimize) => {
      const result = await execute(
        'powershell.exe',
        [
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          join(root, 'scripts', 'process-snapshot.ps1'),
          '-AppProcessId',
          String(child.pid),
          ...(minimize ? ['-Minimize'] : []),
        ],
        { windowsHide: true },
      );
      return JSON.parse(result.stdout);
    };
    await snapshot(true);
    await delay(2000);
    const background = await page.evaluate(
      () => document.documentElement.dataset.activity === 'background',
    );
    if (!background)
      throw new Error(
        'The native window did not enter background mode; refusing to label this a minimized measurement.',
      );
    const before = await snapshot(false);
    await delay(20000);
    const after = await snapshot(false);
    const elapsedMs = after.sampledAt - before.sampledAt;
    const cpuMs = after.processes.reduce(
      (sum, item) =>
        sum +
        Math.max(
          0,
          item.cpuMs -
            (before.processes.find((p) => p.id === item.id)?.cpuMs || 0),
        ),
      0,
    );
    const report = {
      measuredAt: new Date().toISOString(),
      conditions:
        'Login screen, minimized; no call or screen sharing. Release executable plus all its WebView2 children. CDP attached for this test only.',
      background,
      sampleSeconds: Number((elapsedMs / 1000).toFixed(2)),
      logicalProcessors: cpus().length,
      processCount: after.processes.length,
      cpuTimeMs: Number(cpuMs.toFixed(2)),
      cpuPercentOneCore: Number(((cpuMs / elapsedMs) * 100).toFixed(3)),
      cpuPercentWholeMachine: Number(
        (((cpuMs / elapsedMs) * 100) / cpus().length).toFixed(3),
      ),
      summedWorkingSetMiB: Number(
        (
          after.processes.reduce((n, p) => n + p.workingSet, 0) / 1048576
        ).toFixed(1),
      ),
      privateCommitMiB: Number(
        (
          after.processes.reduce((n, p) => n + p.privateCommit, 0) / 1048576
        ).toFixed(1),
      ),
      limits:
        'Working sets include shared pages; private commit is not resident RAM. Short idle sample, not an FPS, GPU, or active-call benchmark. Hardware/network workloads vary.',
    };
    await mkdir(join(root, 'release'), { recursive: true });
    await writeFile(
      join(root, 'release', 'idle-measurement.json'),
      JSON.stringify(report, null, 2),
    );
    console.log(JSON.stringify(report, null, 2));
  }
  await mkdir(join(root, 'test-results'), { recursive: true });
  await page.screenshot({
    path: join(root, 'test-results', 'tiny-desktop.png'),
  });
  const closed = new Promise((accept) =>
    child.once('exit', () => accept(true)),
  );
  await promisify(execFile)(
    'powershell.exe',
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      join(root, 'scripts', 'process-snapshot.ps1'),
      '-AppProcessId',
      String(child.pid),
      '-Close',
    ],
    { windowsHide: true },
  );
  expect(await Promise.race([closed, delay(5000).then(() => false)])).toBe(
    true,
  );
  console.log(
    'Desktop passed: real executable, rendered UI, secure media APIs, isolated local sign-in API, normal window close exits the client.',
  );
} finally {
  if (browser) await browser.close().catch(() => {});
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = new Promise((accept) => child.once('exit', accept));
    child.kill();
    await Promise.race([exited, delay(3000, undefined, { ref: false })]);
  }
  if (app) await app.close();
  // Confirm that recursive cleanup is confined to this run's temporary folder.
  const target = resolve(data);
  if (
    !target.startsWith(resolve(tmpdir()) + sep) ||
    !basename(target).startsWith('tiny-desktop-test-')
  )
    throw new Error('Refusing to remove an unexpected desktop-test directory.');
  // WebView2 can take a moment to release profile files after its parent exits.
  await rm(target, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 300,
  }).catch((error) =>
    console.warn(`Desktop test profile could not be removed: ${error.message}`),
  );
}
