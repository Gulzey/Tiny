import { spawn } from 'node:child_process';
import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve, sep, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';

const root = fileURLToPath(new URL('../', import.meta.url));
const folder = await mkdtemp(join(tmpdir(), 'tiny-server-exe-test-'));
let running;
const executable = join(folder, 'Tiny-Server.exe');
const dataDir = join(folder, 'data');
const environment = {
  ...process.env,
  PATH: '',
  TINY_LOCAL_AUTH: 'true',
  TINY_ICE_SERVERS: '[]',
  // The SEA configuration forbids NODE_OPTIONS extensions. Its runtime must
  // start independently of the host's Node install or module search path.
  NODE_OPTIONS: '--tiny-server-invalid-node-option',
};

function spawnServer(args) {
  const child = spawn(
    executable,
    ['--no-pause', '--data-dir', dataDir, ...args],
    {
      cwd: folder,
      env: environment,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk;
  });
  child.stderr.on('data', (chunk) => {
    output += chunk;
  });
  return { child, output: () => output };
}

async function runOnce(args) {
  const instance = spawnServer(args);
  const code = await new Promise((accept, reject) => {
    const timer = setTimeout(() => {
      instance.child.kill();
      reject(new Error('Standalone server command timed out.'));
    }, 15_000);
    instance.child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    instance.child.once('exit', (code) => {
      clearTimeout(timer);
      accept(code);
    });
  });
  assert.equal(code, 0, instance.output());
  return instance.output();
}

async function start() {
  running = spawnServer(['--host', '127.0.0.1', '--port', '0']);
  let spawnError;
  running.child.once('error', (error) => {
    spawnError = error;
  });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (spawnError) throw spawnError;
    const match = /Server address on this PC: (http:\/\/127\.0\.0\.1:\d+)/.exec(
      running.output(),
    );
    if (match) return match[1];
    if (running.child.exitCode !== null)
      throw new Error(`Standalone server exited early: ${running.output()}`);
    await delay(100);
  }
  throw new Error(`Standalone server did not start: ${running.output()}`);
}

async function stop() {
  if (!running) return;
  const child = running.child;
  running = null;
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((accept, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Standalone server did not stop.')),
      5000,
    );
    child.once('exit', () => {
      clearTimeout(timer);
      accept();
    });
    child.kill();
  });
}

try {
  await copyFile(join(root, 'release', 'host', 'Tiny-Server.exe'), executable);
  await writeFile(
    join(folder, 'tiny-server.env'),
    'TINY_PORT=9999\nTINY_HOST=127.0.0.1\n',
  );
  assert.match(await runOnce(['--help']), /No separate Node\.js installation/);
  assert.match(await runOnce(['--seed-only']), /Test accounts are ready/);
  assert.match(await runOnce(['--seed-only']), /Test accounts are ready/);
  let base = await start();
  const request = async (
    path,
    token,
    body,
    method = body === undefined ? 'GET' : 'POST',
  ) => {
    const response = await fetch(base + path, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    assert.equal(
      response.status,
      200,
      `${path}: ${await response.clone().text()}`,
    );
    return response.json();
  };
  assert.equal((await request('/api/config')).localAuth, true);
  const account = await request('/api/auth/local', null, {
    handle: 'alice',
    password: 'tiny-local-demo',
  });
  const { token } = account;
  await request('/api/me', token, { displayName: 'Portable Alice' }, 'PATCH');
  await request('/api/conversations/tiny-demo-group/messages', token, {
    body: 'Saved by standalone Tiny Server',
    clientId: 'portable-smoke-message',
  });
  const socket = new WebSocket(base.replace('http:', 'ws:') + '/ws');
  await new Promise((accept, reject) => {
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error('Bundled WebSocket auth timed out.'));
    }, 5000);
    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.once('open', () =>
      socket.send(JSON.stringify({ type: 'auth', token })),
    );
    socket.on('message', (raw) => {
      if (JSON.parse(raw.toString()).type === 'ready') {
        clearTimeout(timer);
        socket.terminate();
        accept();
      }
    });
  });
  await stop();
  base = await start();
  assert.equal((await request('/api/me', token)).displayName, 'Portable Alice');
  const history = await request(
    '/api/conversations/tiny-demo-group/messages',
    token,
  );
  assert(
    history.messages.some(
      (message) => message.body === 'Saved by standalone Tiny Server',
    ),
  );
  console.log(
    'Standalone server passed: EXE copied without Node/modules, help, repeatable seed, API, WebSocket, persistent profile/messages/session across restart.',
  );
} finally {
  await stop();
  const target = resolve(folder);
  if (
    !target.startsWith(resolve(tmpdir()) + sep) ||
    !basename(target).startsWith('tiny-server-exe-test-')
  )
    throw new Error(
      'Refusing to remove an unexpected standalone test directory.',
    );
  await rm(target, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 200,
  });
}
