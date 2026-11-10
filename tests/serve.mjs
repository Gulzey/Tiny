import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTinyServer } from '../server/app.mjs';

const dir = await mkdtemp(join(tmpdir(), 'tiny-e2e-'));
const app = createTinyServer({ dbPath: join(dir, 'test.sqlite'), port: 8878 });
await app.listen();
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
    process.exit(0);
  });
}
