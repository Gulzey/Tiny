import { build } from 'esbuild';
import postject from 'postject';
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  writeFile,
} from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';

// Node's documented SEA workflow, using the exact installed Node executable:
// https://nodejs.org/download/release/v24.14.0/docs/api/single-executable-applications.html
if (
  process.platform !== 'win32' ||
  Number(process.versions.node.split('.')[0]) < 24
)
  throw new Error('Build Tiny-Server.exe on Windows with Node.js 24 or newer.');
const root = fileURLToPath(new URL('../', import.meta.url));
const working = join(root, 'build', 'server');
const output = join(root, 'release', 'host');
await mkdir(working, { recursive: true });
await mkdir(output, { recursive: true });

function run(command, args) {
  return new Promise((accept, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      stdio: 'inherit',
      windowsHide: true,
    });
    child.once('error', reject);
    child.once('exit', (code) =>
      code === 0
        ? accept()
        : reject(new Error(`${command} exited with code ${code}.`)),
    );
  });
}

const bundled = join(working, 'server.cjs');
await build({
  entryPoints: [join(root, 'server', 'packaged.mjs')],
  outfile: bundled,
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'cjs',
  // ws's optional native accelerators are unnecessary for this small prototype.
  external: ['bufferutil', 'utf-8-validate'],
  define: {
    'process.env.WS_NO_BUFFER_UTIL': '"1"',
    'process.env.WS_NO_UTF_8_VALIDATE': '"1"',
  },
  minify: false,
  legalComments: 'eof',
});
const blob = join(working, 'server.blob');
const configuration = join(working, 'sea-config.json');
await writeFile(
  configuration,
  JSON.stringify(
    {
      main: bundled,
      output: blob,
      disableExperimentalSEAWarning: true,
      useSnapshot: false,
      useCodeCache: false,
      execArgv: ['--disable-warning=ExperimentalWarning'],
      execArgvExtension: 'none',
    },
    null,
    2,
  ),
);
await run(process.execPath, ['--experimental-sea-config', configuration]);
const executable = join(output, 'Tiny-Server.exe');
await copyFile(process.execPath, executable);

// Removing Node's signature avoids retaining an invalid signature after injection.
// It does not sign Tiny; signing Tiny later needs the distributor's certificate.
let signtool = process.env.TINY_SIGNTOOL;
if (!signtool) {
  const sdk = join(
    process.env['ProgramFiles(x86)'] || 'C:/Program Files (x86)',
    'Windows Kits',
    '10',
    'bin',
  );
  const versions = existsSync(sdk) ? await readdir(sdk) : [];
  for (const version of versions.sort((a, b) =>
    b.localeCompare(a, undefined, { numeric: true }),
  )) {
    const candidate = join(
      sdk,
      version,
      process.arch === 'arm64' ? 'arm64' : 'x64',
      'signtool.exe',
    );
    if (existsSync(candidate)) {
      signtool = candidate;
      break;
    }
  }
}
if (signtool) await run(resolve(signtool), ['remove', '/s', executable]);
else
  console.log(
    'Windows SDK signtool not found; postject may warn about replacing Node’s original signature.',
  );
await postject.inject(executable, 'NODE_SEA_BLOB', await readFile(blob), {
  sentinelFuse: 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
});
await copyFile(
  join(root, 'server', 'tiny-server.env.example'),
  join(output, 'tiny-server.env.example'),
);

// Keep distribution notices beside the executable; end users need no npm files.
const require = createRequire(import.meta.url);
const wsLicense = join(dirname(require.resolve('ws/package.json')), 'LICENSE');
const nodeLicense = join(dirname(process.execPath), 'LICENSE');
let notices = `Tiny Server bundles Node.js ${process.versions.node} and ws.\nNode.js: https://github.com/nodejs/node/blob/v${process.versions.node}/LICENSE\n\n`;
if (existsSync(nodeLicense)) notices += await readFile(nodeLicense, 'utf8');
else {
  const license = await fetch(
    `https://raw.githubusercontent.com/nodejs/node/v${process.versions.node}/LICENSE`,
    { signal: AbortSignal.timeout(20_000) },
  );
  if (!license.ok)
    throw new Error(
      'Could not retrieve Node’s distribution license. Keep its LICENSE beside node.exe and rebuild.',
    );
  notices += await license.text();
}
notices += '\n\n--- ws ---\n' + (await readFile(wsLicense, 'utf8'));
await writeFile(join(output, 'THIRD-PARTY-NOTICES.txt'), notices);
console.log(`Standalone server ready: ${executable}`);
console.log(
  'Copy Tiny-Server.exe and the notices to the host PC. No Node.js install is needed there.',
);
