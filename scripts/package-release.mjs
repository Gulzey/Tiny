import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createUpdateManifest, UPDATE_ENDPOINT } from './release-utils.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const release = join(root, 'release');
const { version } = JSON.parse(
  await readFile(join(root, 'package.json'), 'utf8'),
);
const tauri = JSON.parse(
  await readFile(join(root, 'src-tauri', 'tauri.conf.json'), 'utf8'),
);
if (tauri.version !== version)
  throw new Error('package.json and Tauri must use the same release version.');
if (
  tauri.bundle?.createUpdaterArtifacts !== true ||
  !tauri.plugins?.updater?.pubkey
)
  throw new Error(
    'Enable Tauri updater artifacts and configure its public key before packaging.',
  );
if (!tauri.plugins.updater.endpoints?.includes(UPDATE_ENDPOINT))
  throw new Error(
    'Tauri updater endpoint does not match the public release manifest endpoint.',
  );
const installer = join(
  root,
  'src-tauri',
  'target',
  'release',
  'bundle',
  'nsis',
  `Tiny_${version}_x64-setup.exe`,
);
const signature = await readFile(`${installer}.sig`, 'utf8').catch(() => {
  throw new Error(
    'The signed installer .sig is missing. Run npm run build:desktop with the private signing key first.',
  );
});
const manifest = createUpdateManifest({
  version,
  signature,
  notes:
    process.env.TINY_RELEASE_NOTES ||
    `Tiny ${version}: desktop improvements and signed updates.`,
});
await mkdir(release, { recursive: true });
await mkdir(join(release, 'host'), { recursive: true });
await copyFile(installer, join(release, 'Tiny-Setup.exe'));
await copyFile(`${installer}.sig`, join(release, 'Tiny-Setup.exe.sig'));
await writeFile(
  join(release, 'latest.json'),
  JSON.stringify(manifest, null, 2) + '\n',
);
await copyFile(join(root, 'docs', 'UPDATES.md'), join(release, 'UPDATES.md'));
await copyFile(
  join(root, 'docs', 'SHARING.md'),
  join(release, 'READ-ME-FIRST.md'),
);
await copyFile(
  join(root, 'docs', 'SHARING.md'),
  join(release, 'host', 'HOSTING.md'),
);
await copyFile(
  join(root, 'server', 'tiny-server.env.example'),
  join(release, 'host', 'tiny-server.env.example'),
);
await new Promise((accept, reject) => {
  const child = spawn(
    'powershell.exe',
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      join(dirname(fileURLToPath(import.meta.url)), 'archive-host.ps1'),
      '-ReleaseFolder',
      release,
    ],
    { windowsHide: true, stdio: 'inherit' },
  );
  child.once('error', reject);
  child.once('exit', (code) =>
    code === 0 ? accept() : reject(new Error(`Host archive exited ${code}`)),
  );
});
console.log(
  'Prepared locally: Tiny-Setup.exe, its .sig, latest.json, and Tiny-Host.zip. No files were published.',
);
console.log(`Updater manifest after publication: ${UPDATE_ENDPOINT}`);
