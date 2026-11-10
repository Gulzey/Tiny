import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const release = join(root, 'release');
const { version } = JSON.parse(
  await readFile(join(root, 'package.json'), 'utf8'),
);
await mkdir(release, { recursive: true });
await copyFile(
  join(
    root,
    'src-tauri',
    'target',
    'release',
    'bundle',
    'nsis',
    `Tiny_${version}_x64-setup.exe`,
  ),
  join(release, 'Tiny-Setup.exe'),
);
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
  'Ready to send: release/Tiny-Setup.exe (friends), release/Tiny-Host.zip (host only).',
);
