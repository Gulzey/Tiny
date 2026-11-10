import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { readSigningKey } from './release-utils.mjs';

// Signing secrets are never loaded from checked-in config or printed. This
// wrapper uses the already-created private key and never replaces it.
const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
try {
  const key = await readSigningKey({ root });
  if (!key) throw new Error('The configured updater signing key is empty.');
  const cli = require.resolve('@tauri-apps/cli/tauri.js');
  const result = await new Promise((accept, reject) => {
    const child = spawn(
      process.execPath,
      [cli, 'build', ...process.argv.slice(2)],
      {
        cwd: root,
        windowsHide: true,
        stdio: 'inherit',
        env: {
          ...process.env,
          TAURI_SIGNING_PRIVATE_KEY: key,
          TAURI_SIGNING_PRIVATE_KEY_PASSWORD:
            process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ?? '',
        },
      },
    );
    child.once('error', reject);
    child.once('exit', (code, signal) =>
      signal
        ? reject(new Error(`Desktop build stopped by ${signal}.`))
        : accept(code ?? 1),
    );
  });
  process.exitCode = result;
} catch (error) {
  console.error(`Tiny desktop build could not start: ${error.message}`);
  process.exitCode = 1;
}
