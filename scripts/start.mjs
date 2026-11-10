import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

// Prefer the compiled Tauri app; fall back to the PC's installed browser.
const root = fileURLToPath(new URL('../', import.meta.url));
const executable = join(root, 'src-tauri', 'target', 'release', 'tiny.exe');
async function launch(command, args) {
  const child = spawn(command, args, { detached: true, stdio: 'ignore' });
  await new Promise((accept, reject) => {
    child.once('spawn', accept);
    child.once('error', reject);
  });
  child.unref();
}

if (
  process.platform === 'win32' &&
  existsSync(executable) &&
  !process.env.TINY_APP_URL
) {
  // The native client has its own saved server address. It must remain possible
  // to open it and configure another server while the local server is stopped.
  try {
    await launch(executable, []);
    console.log(
      'Opened the Tiny desktop app. Start its local server with: npm run server',
    );
  } catch (error) {
    console.error(`Tiny could not open: ${error.message}`);
    process.exitCode = 1;
  }
} else {
  let url;
  try {
    url = new URL(process.env.TINY_APP_URL || 'http://127.0.0.1:8787');
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password
    )
      throw new Error(
        'Use an HTTP or HTTPS address without embedded credentials.',
      );
  } catch (error) {
    console.error(`Invalid TINY_APP_URL: ${error.message}`);
    process.exit(1);
  }
  if (
    !process.env.TINY_APP_URL &&
    !existsSync(join(root, 'dist', 'index.html'))
  ) {
    console.error('Build Tiny’s interface first: npm run build');
    process.exit(1);
  }
  try {
    const response = await fetch(new URL('/api/config', url), {
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
  } catch (error) {
    console.error(
      `Tiny's server at ${url.origin} is unavailable (${error.message}). Start it with: npm run server`,
    );
    process.exit(1);
  }
  if (process.platform === 'win32') {
    const candidates = [
      `${process.env['ProgramFiles(x86)']}/Microsoft/Edge/Application/msedge.exe`,
      `${process.env.ProgramFiles}/Microsoft/Edge/Application/msedge.exe`,
      `${process.env.LOCALAPPDATA}/Microsoft/Edge/Application/msedge.exe`,
    ];
    const edge = candidates.find(existsSync);
    if (edge) {
      // execFile/spawn args preserve spaces without shell interpolation.
      try {
        await launch(edge, [`--app=${url.href}`]);
        console.log(`Opened Tiny at ${url.href}`);
      } catch (error) {
        console.error(
          `Edge could not open Tiny: ${error.message}. Open ${url.href} in Chrome or Edge.`,
        );
        process.exitCode = 1;
      }
    } else {
      console.log(`Open ${url.href} in Chrome or Edge to use Tiny.`);
    }
  } else {
    console.log(`Open ${url.href} in Chrome or Edge, or use npm run desktop.`);
  }
}
