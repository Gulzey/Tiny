import { createTinyServer } from './app.mjs';
import { resolveServerSettings } from './runtime.mjs';
import { resolve } from 'node:path';

const settings = resolveServerSettings({ executableDir: process.cwd() });
settings.staticDir = resolve('dist');
const app = createTinyServer(settings);
await app.listen();
console.log(
  `Tiny server: http://${settings.host}:${app.server.address().port}`,
);
console.log(`Database: ${settings.dbPath}`);
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, async () => {
    await app.close();
    process.exit(0);
  });
