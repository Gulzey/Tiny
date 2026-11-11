import { DatabaseSync } from 'node:sqlite';
import {
  randomBytes,
  randomUUID,
  scrypt as scryptCallback,
  timingSafeEqual,
  createHash,
} from 'node:crypto';
import { promisify } from 'node:util';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const scrypt = promisify(scryptCallback);
export const digest = (token) =>
  createHash('sha256').update(token).digest('hex');
export const publicUser = (row) =>
  row && {
    id: row.id,
    handle: row.handle,
    displayName: row.display_name,
    avatar: row.avatar,
    banner: row.banner || null,
    presenceMode: row.presence_mode || 'online',
  };

export function openDatabase(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, handle TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL,
      avatar TEXT, banner TEXT, presence_mode TEXT NOT NULL DEFAULT 'online', password_hash TEXT NOT NULL, salt TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS friends (
      user_id TEXT NOT NULL REFERENCES users(id), friend_id TEXT NOT NULL REFERENCES users(id),
      created_at TEXT, PRIMARY KEY (user_id, friend_id), CHECK (user_id != friend_id)
    );
    CREATE TABLE IF NOT EXISTS friend_requests (
      requester_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      recipient_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      PRIMARY KEY (requester_id, recipient_id),
      CHECK (requester_id != recipient_id)
    );
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, is_group INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS members (
      conversation_id TEXT NOT NULL REFERENCES conversations(id), user_id TEXT NOT NULL REFERENCES users(id),
      PRIMARY KEY (conversation_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT, conversation_id TEXT NOT NULL REFERENCES conversations(id),
      sender_id TEXT NOT NULL REFERENCES users(id), body TEXT NOT NULL, created_at TEXT NOT NULL,
      client_id TEXT NOT NULL, edited_at TEXT, deleted_at TEXT, UNIQUE(sender_id, client_id)
    );
    CREATE INDEX IF NOT EXISTS messages_conversation ON messages(conversation_id, id);
    CREATE INDEX IF NOT EXISTS members_user ON members(user_id);
    CREATE INDEX IF NOT EXISTS friend_requests_recipient
      ON friend_requests(recipient_id, created_at);
  `);
  const userColumns = db.prepare('PRAGMA table_info(users)').all();
  if (!userColumns.some((column) => column.name === 'password_version'))
    db.exec(
      'ALTER TABLE users ADD COLUMN password_version INTEGER NOT NULL DEFAULT 1',
    );
  if (!userColumns.some((column) => column.name === 'banner'))
    db.exec('ALTER TABLE users ADD COLUMN banner TEXT');
  if (!userColumns.some((column) => column.name === 'presence_mode'))
    db.exec(
      "ALTER TABLE users ADD COLUMN presence_mode TEXT NOT NULL DEFAULT 'online'",
    );
  const friendColumns = db.prepare('PRAGMA table_info(friends)').all();
  if (!friendColumns.some((column) => column.name === 'created_at'))
    db.exec('ALTER TABLE friends ADD COLUMN created_at TEXT');
  const messageColumns = db.prepare('PRAGMA table_info(messages)').all();
  if (!messageColumns.some((column) => column.name === 'edited_at'))
    db.exec('ALTER TABLE messages ADD COLUMN edited_at TEXT');
  if (!messageColumns.some((column) => column.name === 'deleted_at'))
    db.exec('ALTER TABLE messages ADD COLUMN deleted_at TEXT');
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
  return db;
}

export async function createAccount(db, handle, password, displayName) {
  const salt = randomBytes(16).toString('hex');
  const hash = await scrypt(password, salt, 64, {
    N: 1 << 15,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  });
  const id = randomUUID();
  db.prepare(
    'INSERT INTO users (id,handle,display_name,password_hash,salt,password_version) VALUES (?,?,?,?,?,2)',
  ).run(id, handle, displayName, hash.toString('hex'), salt);
  return publicUser(db.prepare('SELECT * FROM users WHERE id=?').get(id));
}

export async function verifyPassword(row, password) {
  // Do equivalent expensive work for missing accounts to reduce username probing by timing.
  const modern = row?.password_version === 2;
  const hash = await scrypt(
    password,
    row?.salt || 'tiny-no-account-salt',
    64,
    modern
      ? { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }
      : { N: 1 << 14, r: 8, p: 1, maxmem: 32 * 1024 * 1024 },
  );
  return Boolean(
    row && timingSafeEqual(hash, Buffer.from(row.password_hash, 'hex')),
  );
}

export function issueSession(db, userId) {
  const token = randomBytes(32).toString('base64url');
  // Bound account session growth before creating a new seven-day session.
  db.prepare(
    `DELETE FROM sessions WHERE token_hash IN (
      SELECT token_hash FROM sessions WHERE user_id=?
      ORDER BY expires_at DESC LIMIT -1 OFFSET 7
    )`,
  ).run(userId);
  db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(
    digest(token),
    userId,
    Date.now() + 7 * 86400_000,
  );
  return token;
}

export function sessionUser(db, token) {
  if (typeof token !== 'string' || token.length > 256) return null;
  return publicUser(
    db
      .prepare(
        'SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?',
      )
      .get(digest(token), Date.now()),
  );
}

export function sessionUserId(db, token) {
  if (typeof token !== 'string' || token.length > 256) return null;
  return (
    db
      .prepare(
        'SELECT user_id FROM sessions WHERE token_hash=? AND expires_at>?',
      )
      .get(digest(token), Date.now())?.user_id || null
  );
}

export function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export async function seedDatabase(db) {
  const users = [];
  for (const [handle, name] of [
    ['alice', 'Alice'],
    ['bob', 'Bob'],
    ['charlie', 'Charlie'],
  ]) {
    const existing = db
      .prepare('SELECT * FROM users WHERE handle=?')
      .get(handle);
    users.push(
      existing
        ? publicUser(existing)
        : await createAccount(db, handle, 'tiny-local-demo', name),
    );
  }
  transaction(db, () => {
    for (const user of users)
      for (const friend of users)
        if (user.id !== friend.id) {
          db.prepare(
            'INSERT OR IGNORE INTO friends (user_id,friend_id) VALUES (?,?)',
          ).run(user.id, friend.id);
        }
    if (
      !db
        .prepare("SELECT id FROM conversations WHERE id='tiny-demo-group'")
        .get()
    ) {
      db.prepare('INSERT INTO conversations VALUES (?,?,1,?)').run(
        'tiny-demo-group',
        'The little corner',
        new Date().toISOString(),
      );
      for (const user of users)
        db.prepare('INSERT INTO members VALUES (?,?)').run(
          'tiny-demo-group',
          user.id,
        );
      db.prepare(
        'INSERT INTO messages (conversation_id,sender_id,body,created_at,client_id) VALUES (?,?,?,?,?)',
      ).run(
        'tiny-demo-group',
        users[1].id,
        'Welcome to our little corner. Say hello, or join a call!',
        new Date().toISOString(),
        'tiny-demo-welcome',
      );
    }
  });
  return users;
}
