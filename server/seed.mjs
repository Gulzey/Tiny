import { resolve } from 'node:path';
import { openDatabase, seedDatabase } from './database.mjs';
const db = openDatabase(resolve(process.env.TINY_DB || 'data/tiny.sqlite'));
try {
  await seedDatabase(db);
  console.log(
    'Ready: alice, bob, charlie. Password for newly created demo accounts: tiny-local-demo',
  );
  console.log(
    'They are already friends and share a group chat. Existing account passwords are never changed.',
  );
} finally {
  db.close();
}
