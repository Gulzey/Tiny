import { createTinyServer } from './app.mjs';
import { resolve } from 'node:path';

const host = process.env.TINY_HOST || '127.0.0.1';
const port = Number(process.env.TINY_PORT || 8787);
let iceServers;
try {
  iceServers = JSON.parse(process.env.TINY_ICE_SERVERS || '[]');
} catch {
  console.error('TINY_ICE_SERVERS must be a JSON array.');
  process.exit(1);
}
const app = createTinyServer({
  dbPath: resolve(process.env.TINY_DB || 'data/tiny.sqlite'),
  host,
  port,
  localAuth: process.env.TINY_LOCAL_AUTH !== 'false',
  iceServers,
  allowedOrigins: process.env.TINY_ALLOWED_ORIGINS?.split(',')
    .map((s) => s.trim())
    .filter(Boolean),
});
await app.listen();
console.log(`Tiny server: http://${host}:${app.server.address().port}`);
console.log(`Database: ${resolve(process.env.TINY_DB || 'data/tiny.sqlite')}`);
if (process.env.TINY_LOCAL_AUTH !== 'false')
  console.log(
    'LOCAL TEST AUTH enabled. Do not expose this development server publicly.',
  );
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, async () => {
    await app.close();
    process.exit(0);
  });
