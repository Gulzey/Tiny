import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { Resvg } from '@resvg/resvg-js';

// The app and native icons share this one editable, original vector mark.
const source = readFileSync(
  new URL('../src/assets/tiny-logo.svg', import.meta.url),
  'utf8',
);
const directory = new URL('../src-tauri/icons/', import.meta.url);
const sizes = [16, 24, 32, 48, 64, 128, 256];
const render = (size) =>
  Buffer.from(
    new Resvg(source, { fitTo: { mode: 'width', value: size } })
      .render()
      .asPng(),
  );

// Windows chooses the entry that matches the taskbar/desktop's current scale.
// PNG-compressed images preserve alpha, including outside the rounded tile.
const entries = sizes.map((size) => ({ size, png: render(size) }));
const header = Buffer.alloc(6 + entries.length * 16);
header.writeUInt16LE(1, 2); // ICO, rather than CUR.
header.writeUInt16LE(entries.length, 4);
let offset = header.length;
for (const [index, { size, png }] of entries.entries()) {
  const start = 6 + index * 16;
  header[start] = size === 256 ? 0 : size;
  header[start + 1] = size === 256 ? 0 : size;
  header.writeUInt16LE(1, start + 4);
  header.writeUInt16LE(32, start + 6);
  header.writeUInt32LE(png.length, start + 8);
  header.writeUInt32LE(offset, start + 12);
  offset += png.length;
}

mkdirSync(directory, { recursive: true });
writeFileSync(
  new URL('icon.ico', directory),
  Buffer.concat([header, ...entries.map(({ png }) => png)]),
);
writeFileSync(new URL('icon.png', directory), render(512));

// A generated browser favicon, kept identical to the desktop mark.
const publicDirectory = new URL('../public/', import.meta.url);
mkdirSync(publicDirectory, { recursive: true });
writeFileSync(new URL('favicon.svg', publicDirectory), source);
console.log(`Generated Tiny icons (${sizes.join(', ')} px) and favicon.`);
