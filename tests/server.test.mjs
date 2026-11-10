import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { DatabaseSync } from 'node:sqlite';
import { scrypt as scryptCallback } from 'node:crypto';
import { promisify } from 'node:util';
import { createTinyServer, validateAvatar } from '../server/app.mjs';
import {
  seedDatabase,
  digest,
  openDatabase,
  verifyPassword,
  createAccount,
} from '../server/database.mjs';

const password = 'test-password-123';
const scrypt = promisify(scryptCallback);
async function setup(t, options = {}) {
  const app = createTinyServer({ port: 0, ...options });
  await app.listen();
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const request = async (
    path,
    { token, method = 'GET', body, headers = {} } = {},
  ) => {
    const response = await fetch(base + path, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  const account = async (handle) => {
    const response = await request('/api/auth/local', {
      method: 'POST',
      body: { handle, password, create: true, displayName: handle },
    });
    assert.equal(response.status, 200);
    return response.body;
  };
  t.after(() => app.close());
  return { app, request, account, base };
}

async function connect(base, token) {
  const ws = new WebSocket(base.replace('http:', 'ws:') + '/ws');
  const pending = [];
  const queue = [];
  ws.on('message', (raw) => {
    const event = JSON.parse(raw.toString());
    const index = pending.findIndex((p) => p.predicate(event));
    if (index < 0) queue.push(event);
    else {
      const [waiter] = pending.splice(index, 1);
      clearTimeout(waiter.timeout);
      waiter.resolve(event);
    }
  });
  const next = (type, match = () => true) => {
    const predicate = (event) => event.type === type && match(event);
    const index = queue.findIndex(predicate);
    if (index >= 0) return Promise.resolve(queue.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const waiter = {
        predicate,
        resolve,
        timeout: setTimeout(() => {
          const at = pending.indexOf(waiter);
          if (at >= 0) pending.splice(at, 1);
          reject(new Error(`Timed out waiting for ${type}`));
        }, 3000),
      };
      pending.push(waiter);
    });
  };
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  ws.send(JSON.stringify({ type: 'auth', token }));
  const ready = await next('ready');
  return {
    ws,
    next,
    peerId: ready.peerId,
    send: (event) => ws.send(JSON.stringify(event)),
  };
}

async function makeFriends(request, sender, recipient) {
  const sent = await request('/api/friend-requests', {
    token: sender.token,
    method: 'POST',
    body: { handle: recipient.user.handle },
  });
  assert.equal(sent.status, 200);
  const accepted = await request(`/api/friend-requests/${sender.user.id}`, {
    token: recipient.token,
    method: 'PATCH',
    body: { action: 'accept' },
  });
  assert.equal(accepted.status, 200);
}

test('local accounts use passwords; sessions, origins, and disabled auth are enforced', async (t) => {
  const { request, account } = await setup(t);
  const alice = await account('alice');
  assert.equal((await request('/api/me')).status, 401);
  assert.equal(
    (await request('/api/me', { token: 'forged-token' })).status,
    401,
  );
  assert.equal(
    (await request('/api/me', { token: alice.token })).body.handle,
    'alice',
  );
  assert.equal(
    (
      await request('/api/auth/local', {
        method: 'POST',
        body: { handle: 'alice', password: 'wrong-password' },
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await request('/api/auth/local', {
        method: 'POST',
        body: { handle: 'alice', password, create: true },
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await request('/api/auth/local', {
        method: 'POST',
        body: { handle: 'alice', password },
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await request('/api/config', {
        headers: { Origin: 'https://untrusted.example' },
      })
    ).status,
    403,
  );
  assert.equal(
    (await request('/api/logout', { token: alice.token, method: 'POST' }))
      .status,
    200,
  );
  assert.equal((await request('/api/me', { token: alice.token })).status, 401);
  const disabled = await setup(t, { localAuth: false });
  assert.equal((await disabled.request('/api/config')).body.localAuth, false);
  assert.equal(
    (
      await disabled.request('/api/auth/local', {
        method: 'POST',
        body: { handle: 'alice', password, create: true },
      })
    ).status,
    403,
  );
});

test('database migration preserves legacy password hashes and adds friend requests', async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'tiny-legacy-'));
  const path = join(folder, 'tiny.sqlite');
  t.after(() => rm(folder, { recursive: true, force: true }));
  const legacy = new DatabaseSync(path);
  legacy.exec(`CREATE TABLE users (
    id TEXT PRIMARY KEY, handle TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL,
    avatar TEXT, password_hash TEXT NOT NULL, salt TEXT NOT NULL
  )`);
  const salt = 'legacy-test-salt';
  const hash = await scrypt('legacy-password', salt, 64, {
    N: 1 << 14,
    r: 8,
    p: 1,
    maxmem: 32 * 1024 * 1024,
  });
  legacy
    .prepare('INSERT INTO users VALUES (?,?,?,?,?,?)')
    .run('legacy-id', 'legacy', 'Legacy', null, hash.toString('hex'), salt);
  legacy.close();
  const migrated = openDatabase(path);
  try {
    const row = migrated
      .prepare('SELECT * FROM users WHERE id=?')
      .get('legacy-id');
    assert.equal(row.password_version, 1);
    assert.equal(await verifyPassword(row, 'legacy-password'), true);
    assert.equal(await verifyPassword(row, 'wrong-password'), false);
    const created = await createAccount(
      migrated,
      'modern',
      'modern-password-123',
      'Modern',
    );
    const modern = migrated
      .prepare('SELECT * FROM users WHERE id=?')
      .get(created.id);
    assert.equal(modern.password_version, 2);
    assert.equal(await verifyPassword(modern, 'modern-password-123'), true);
    assert.equal(await verifyPassword(modern, 'wrong-password'), false);
    assert.equal(
      migrated.prepare('SELECT count(*) AS count FROM users').get().count,
      2,
    );
    assert.equal(
      migrated
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name='friend_requests'",
        )
        .get()['1'],
      1,
    );
  } finally {
    migrated.close();
  }
});

test('friend requests require acceptance and support decline, cancel, duplicates, and live updates', async (t) => {
  const { request, account, base } = await setup(t);
  const alice = await account('request_alice');
  const bob = await account('request_bob');
  const a = await connect(base, alice.token);
  const b = await connect(base, bob.token);
  t.after(() => {
    a.ws.terminate();
    b.ws.terminate();
  });
  assert.equal(
    (
      await request('/api/friend-requests', {
        method: 'POST',
        body: { handle: bob.user.handle },
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await request('/api/friend-requests', {
        token: alice.token,
        method: 'POST',
        body: { handle: alice.user.handle },
      })
    ).status,
    400,
  );
  await request('/api/friend-requests', {
    token: alice.token,
    method: 'POST',
    body: { handle: bob.user.handle },
  });
  await Promise.all([a.next('state'), b.next('state')]);
  assert.equal(
    (
      await request('/api/friend-requests', {
        token: alice.token,
        method: 'POST',
        body: { handle: bob.user.handle },
      })
    ).status,
    409,
  );
  let state = (await request('/api/state', { token: bob.token })).body;
  assert.equal(state.friends.length, 0);
  assert.equal(state.friendRequests.incoming[0].user.id, alice.user.id);
  await request(`/api/friend-requests/${alice.user.id}`, {
    token: bob.token,
    method: 'PATCH',
    body: { action: 'decline' },
  });
  await request('/api/friend-requests', {
    token: alice.token,
    method: 'POST',
    body: { handle: bob.user.handle },
  });
  await request(`/api/friend-requests/${bob.user.id}`, {
    token: alice.token,
    method: 'PATCH',
    body: { action: 'cancel' },
  });
  assert.equal(
    (await request('/api/state', { token: alice.token })).body.friendRequests
      .outgoing.length,
    0,
  );
  await makeFriends(request, alice, bob);
  state = (await request('/api/state', { token: bob.token })).body;
  assert.equal(state.friends[0].id, alice.user.id);
  assert.equal(
    (
      await request('/api/friend-requests', {
        token: alice.token,
        method: 'POST',
        body: { handle: bob.user.handle },
      })
    ).status,
    409,
  );
});

test('friendship, private/group membership, durable messages and idempotent retries', async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'tiny-test-'));
  let app = createTinyServer({ dbPath: join(folder, 'tiny.sqlite'), port: 0 });
  await app.listen();
  t.after(async () => {
    if (app) await app.close();
    await rm(folder, { recursive: true, force: true });
  });
  let base = `http://127.0.0.1:${app.server.address().port}`;
  const request = async (path, token, body) => {
    const response = await fetch(base + path, {
      method: body?.action ? 'PATCH' : body ? 'POST' : 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, body: await response.json() };
  };
  const register = async (handle) =>
    (await request('/api/auth/local', '', { handle, password, create: true }))
      .body;
  const alice = await register('alice');
  const bob = await register('bob');
  const charlie = await register('charlie');
  assert.equal(
    (
      await request('/api/conversations', alice.token, {
        memberIds: [bob.user.id],
      })
    ).status,
    403,
  );
  assert.equal(
    (await request('/api/friend-requests', alice.token, { handle: 'alice' }))
      .status,
    400,
  );
  assert.equal(
    (await request('/api/friend-requests', alice.token, { handle: 'bob' }))
      .status,
    200,
  );
  assert.equal((await request('/api/state', bob.token)).body.friends.length, 0);
  assert.equal(
    (await request('/api/state', bob.token)).body.friendRequests.incoming[0]
      .user.id,
    alice.user.id,
  );
  assert.equal(
    (
      await request(`/api/friend-requests/${alice.user.id}`, bob.token, {
        action: 'accept',
      })
    ).status,
    200,
  );
  assert.equal(
    (await request('/api/state', bob.token)).body.friends[0].id,
    alice.user.id,
  );
  const direct = await request('/api/conversations', alice.token, {
    memberIds: [bob.user.id],
  });
  assert.equal(direct.status, 201);
  assert.equal(
    (
      await request('/api/conversations', bob.token, {
        memberIds: [alice.user.id],
      })
    ).body.id,
    direct.body.id,
  );
  const path = `/api/conversations/${direct.body.id}/messages`;
  assert.equal((await request(path, charlie.token)).status, 403);
  assert.equal(
    (
      await request(path, charlie.token, {
        body: 'intrusion',
        clientId: 'intrusion',
      })
    ).status,
    403,
  );
  const message = await request(path, alice.token, {
    body: 'Hello Bob',
    clientId: 'first',
  });
  assert.equal(message.status, 200);
  assert.equal(
    (await request(path, alice.token, { body: 'Hello Bob', clientId: 'first' }))
      .body.id,
    message.body.id,
  );
  assert.equal(
    (
      await request(path, alice.token, {
        body: 'Different message',
        clientId: 'first',
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await request(path, alice.token, {
        body: 'x'.repeat(4001),
        clientId: 'long',
      })
    ).status,
    400,
  );
  assert.equal((await request(path, bob.token)).body.messages.length, 1);
  await request('/api/friend-requests', alice.token, { handle: 'charlie' });
  await request(`/api/friend-requests/${alice.user.id}`, charlie.token, {
    action: 'accept',
  });
  const group = await request('/api/conversations', alice.token, {
    memberIds: [bob.user.id, charlie.user.id],
    title: 'Our group',
  });
  assert.equal(group.body.members.length, 3);
  assert.equal(group.body.isGroup, true);
  assert.equal(
    (
      await request(
        `/api/conversations/${group.body.id}/messages`,
        alice.token,
        { body: 'Hello Bob', clientId: 'first' },
      )
    ).status,
    409,
  );
  assert.equal(
    (
      await request('/api/conversations', alice.token, {
        memberIds: [bob.user.id],
        title: 42,
      })
    ).status,
    400,
  );
  assert.equal(
    (await request(path + '?before=' + '9'.repeat(100), alice.token)).status,
    400,
  );
  assert.equal(
    (
      await request('/api/conversations', alice.token, {
        memberIds: [bob.user.id, charlie.user.id, 'other', 'another'],
      })
    ).status,
    400,
  );
  await app.close();
  app = null;
  app = createTinyServer({ dbPath: join(folder, 'tiny.sqlite'), port: 0 });
  await app.listen();
  base = `http://127.0.0.1:${app.server.address().port}`;
  assert.equal(
    (await request(path, bob.token)).body.messages[0].body,
    'Hello Bob',
  );
  assert.equal(
    (await request('/api/state', alice.token)).body.conversations.length,
    2,
  );
});

test('profile validation accepts PNG/JPEG/GIF and rejects disguised or oversized images', async (t) => {
  const { request, account } = await setup(t);
  const alice = await account('alice');
  const validImages = [
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nWQAAAAASUVORK5CYII=',
    'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
    'data:image/jpeg;base64,/9j/2Q==',
  ];
  for (const avatar of validImages) {
    const result = await request('/api/me', {
      token: alice.token,
      method: 'PATCH',
      body: { displayName: 'Alice New', avatar },
    });
    assert.equal(result.status, 200);
    assert.equal(result.body.avatar, avatar);
  }
  assert.throws(
    () =>
      validateAvatar(
        'data:image/png;base64,' +
          Buffer.from('<script>alert(1)</script>').toString('base64'),
      ),
    /content/,
  );
  assert.throws(() => validateAvatar('data:image/svg+xml;base64,AAAA'), /PNG/);
  assert.throws(
    () =>
      validateAvatar(
        'data:image/gif;base64,' +
          Buffer.alloc(2 * 1024 * 1024 + 1).toString('base64'),
      ),
    /smaller/,
  );
  assert.equal(
    (
      await request('/api/me', {
        token: alice.token,
        method: 'PATCH',
        body: { displayName: ' ' },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await request('/api/me', {
        token: alice.token,
        method: 'PATCH',
        body: { avatar: null },
      })
    ).body.avatar,
    null,
  );
});

test('WebSockets deliver messages, isolate call signaling, and remove disconnected participants', async (t) => {
  const { request, account, base } = await setup(t);
  const alice = await account('alice');
  const bob = await account('bob');
  const charlie = await account('charlie');
  await makeFriends(request, alice, bob);
  const chat = (
    await request('/api/conversations', {
      token: alice.token,
      method: 'POST',
      body: { memberIds: [bob.user.id] },
    })
  ).body;
  const a = await connect(base, alice.token);
  const b = await connect(base, bob.token);
  const c = await connect(base, charlie.token);
  t.after(() => {
    a.ws.terminate();
    b.ws.terminate();
    c.ws.terminate();
  });
  await request(`/api/conversations/${chat.id}/messages`, {
    token: alice.token,
    method: 'POST',
    body: { body: 'A real-time hello', clientId: 'socket-message' },
  });
  assert.equal((await b.next('message')).message.body, 'A real-time hello');
  c.send({ type: 'call:join', conversationId: chat.id });
  assert.match((await c.next('error')).message, /not available/);
  a.send({ type: 'call:join', conversationId: chat.id });
  assert.equal((await a.next('call:joined')).peers.length, 0);
  b.send({ type: 'call:join', conversationId: chat.id });
  assert.equal((await b.next('call:joined')).peers[0].peerId, a.peerId);
  assert.equal((await a.next('call:peer-joined')).peerId, b.peerId);
  a.send({
    type: 'signal',
    conversationId: chat.id,
    to: c.peerId,
    description: { type: 'offer', sdp: 'test-offer' },
  });
  assert.match((await a.next('error')).message, /not in your call/);
  c.send({
    type: 'signal',
    conversationId: chat.id,
    to: a.peerId,
    description: { type: 'offer', sdp: 'test-offer' },
  });
  assert.match((await c.next('error')).message, /Join this call/);
  a.send({
    type: 'signal',
    conversationId: chat.id,
    to: b.peerId,
    description: { type: 'offer', sdp: 'test-offer' },
  });
  assert.equal((await b.next('signal')).from, a.peerId);
  a.ws.terminate();
  assert.equal((await b.next('call:peer-left')).peerId, a.peerId);
  b.send({ type: 'call:leave' });
  const state = await b.next(
    'call:state',
    (event) => event.participants.length === 0,
  );
  assert.equal(state.conversationId, chat.id);
});

test('demo seed is repeatable without duplicate friends, chats, or messages', async (t) => {
  const { app } = await setup(t);
  await seedDatabase(app.db);
  await seedDatabase(app.db);
  assert.equal(app.db.prepare('SELECT count(*) AS n FROM users').get().n, 3);
  assert.equal(app.db.prepare('SELECT count(*) AS n FROM friends').get().n, 6);
  assert.equal(
    app.db.prepare('SELECT count(*) AS n FROM conversations').get().n,
    1,
  );
  assert.equal(app.db.prepare('SELECT count(*) AS n FROM messages').get().n, 1);
});

test('call capacity is four and failed joins preserve the caller’s current room', async (t) => {
  const { app, request, account, base } = await setup(t);
  const accounts = [];
  for (const handle of [
    'alpha',
    'bravo',
    'charlie',
    'delta',
    'echo',
    'foxtrot',
  ])
    accounts.push(await account(handle));
  // Simulate a stored future/migrated larger chat to test the call cap independently
  // from this version's stricter four-member chat creation limit.
  app.db
    .prepare('INSERT INTO conversations VALUES (?,?,1,?)')
    .run('larger-chat', 'Larger imported chat', new Date().toISOString());
  for (const user of accounts.slice(0, 5))
    app.db
      .prepare('INSERT INTO members VALUES (?,?)')
      .run('larger-chat', user.user.id);
  await makeFriends(request, accounts[4], accounts[5]);
  const oldChat = (
    await request('/api/conversations', {
      token: accounts[4].token,
      method: 'POST',
      body: { memberIds: [accounts[5].user.id] },
    })
  ).body;
  const peers = [];
  t.after(() => peers.forEach((peer) => peer.ws.terminate()));
  for (const account of accounts.slice(0, 5))
    peers.push(await connect(base, account.token));
  for (const peer of peers.slice(0, 4)) {
    peer.send({ type: 'call:join', conversationId: 'larger-chat' });
    await peer.next('call:joined');
  }
  const fifth = peers[4];
  fifth.send({ type: 'call:join', conversationId: oldChat.id });
  await fifth.next('call:joined');
  fifth.send({ type: 'call:join', conversationId: 'larger-chat' });
  assert.match((await fifth.next('error')).message, /full.*four/);
  const state = (await request('/api/state', { token: accounts[4].token }))
    .body;
  assert.equal(
    state.conversations.find((chat) => chat.id === oldChat.id)
      .callParticipants[0].peerId,
    fifth.peerId,
  );
  assert.equal(
    state.conversations.find((chat) => chat.id === 'larger-chat')
      .callParticipants.length,
    4,
  );
  peers[0].send({ type: 'call:leave' });
  await peers[1].next(
    'call:peer-left',
    (event) => event.peerId === peers[0].peerId,
  );
  fifth.send({ type: 'call:join', conversationId: 'larger-chat' });
  assert.equal(
    (
      await fifth.next(
        'call:joined',
        (event) => event.conversationId === 'larger-chat',
      )
    ).peers.length,
    3,
  );
  const after = (await request('/api/state', { token: accounts[4].token }))
    .body;
  assert.equal(
    after.conversations.find((chat) => chat.id === oldChat.id).callParticipants
      .length,
    0,
  );
  assert.equal(
    after.conversations.find((chat) => chat.id === 'larger-chat')
      .callParticipants.length,
    4,
  );
});

test('malformed signals are rejected and expired or logged-out socket sessions close', async (t) => {
  const { app, request, account, base } = await setup(t);
  const alice = await account('alice');
  const bob = await account('bob');
  await makeFriends(request, alice, bob);
  const chat = (
    await request('/api/conversations', {
      token: alice.token,
      method: 'POST',
      body: { memberIds: [bob.user.id] },
    })
  ).body;
  const a = await connect(base, alice.token);
  const b = await connect(base, bob.token);
  t.after(() => {
    a.ws.terminate();
    b.ws.terminate();
  });
  a.send({ type: 'call:join', conversationId: chat.id });
  await a.next('call:joined');
  b.send({ type: 'call:join', conversationId: chat.id });
  await b.next('call:joined');
  for (const invalid of [
    { description: { type: 'offer' } },
    { description: { type: 'offer', sdp: 42 } },
    { candidate: { candidate: 'test', sdpMLineIndex: -1 } },
    { candidate: { candidate: 'test', sdpMid: {} } },
  ]) {
    a.send({
      type: 'signal',
      conversationId: chat.id,
      to: b.peerId,
      ...invalid,
    });
    assert.match((await a.next('error')).message, /Invalid/);
  }
  a.send({
    type: 'signal',
    conversationId: chat.id,
    to: b.peerId,
    candidate: {
      candidate: 'candidate:example',
      sdpMid: '0',
      sdpMLineIndex: 0,
      extra: 'not-relayed',
    },
  });
  const signal = await b.next('signal');
  assert.equal(signal.candidate.extra, undefined);
  assert.equal(signal.candidate.sdpMLineIndex, 0);
  const aClosed = new Promise((resolve) =>
    a.ws.once('close', (code) => resolve(code)),
  );
  app.db
    .prepare('UPDATE sessions SET expires_at=? WHERE token_hash=?')
    .run(Date.now() - 1, digest(alice.token));
  a.send({ type: 'call:leave' });
  assert.equal(await aClosed, 4001);
  await b.next('call:peer-left', (event) => event.peerId === a.peerId);
  assert.equal((await request('/api/me', { token: alice.token })).status, 401);
  const bClosed = new Promise((resolve) =>
    b.ws.once('close', (code) => resolve(code)),
  );
  await request('/api/logout', { token: bob.token, method: 'POST' });
  assert.equal(await bClosed, 4001);
  assert.equal((await request('/api/me', { token: bob.token })).status, 401);
});
