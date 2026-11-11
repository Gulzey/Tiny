import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import {
  openDatabase,
  createAccount,
  publicUser,
  verifyPassword,
  issueSession,
  sessionUser,
  sessionUserId,
  digest,
  transaction,
} from './database.mjs';

const DEFAULT_ORIGINS = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:1420',
  'http://127.0.0.1:1420',
  'http://localhost:4173',
  'http://127.0.0.1:4173',
  'http://localhost:8787',
  'http://127.0.0.1:8787',
  'http://tauri.localhost',
  'https://tauri.localhost',
  'tauri://localhost',
];
const MAX_AVATAR = 10 * 1024 * 1024;
const MAX_BODY = MAX_AVATAR * 2.8 + 8192;
const MAX_CALL = 4;
const fail = (status, message) => {
  throw Object.assign(new Error(message), { status });
};
const cleanText = (value, max, label) => {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max)
    fail(400, `${label} must contain 1–${max} characters.`);
  return value.trim();
};
const messageView = (row) => ({
  id: row.id,
  conversationId: row.conversation_id,
  senderId: row.sender_id,
  body: row.deleted_at ? '' : row.body,
  createdAt: row.created_at,
  editedAt: row.edited_at || null,
  deletedAt: row.deleted_at || null,
  clientId: row.client_id,
});

export function validateAvatar(avatar) {
  if (avatar === null) return null;
  if (typeof avatar !== 'string' || avatar.length > MAX_BODY)
    fail(400, 'Choose a PNG, JPEG, or GIF image smaller than 10 MB.');
  const match =
    /^data:image\/(png|jpeg|gif);base64,([A-Za-z0-9+/]+={0,2})$/.exec(avatar);
  if (!match) fail(400, 'Choose a PNG, JPEG, or GIF image.');
  const bytes = Buffer.from(match[2], 'base64');
  if (
    !bytes.length ||
    bytes.length > MAX_AVATAR ||
    bytes.toString('base64') !== match[2]
  )
    fail(400, 'Image must be smaller than 10 MB and use valid base64.');
  const valid =
    match[1] === 'png'
      ? bytes
          .subarray(0, 8)
          .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      : match[1] === 'jpeg'
        ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
        : ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString());
  if (!valid)
    fail(400, 'Image content does not match its PNG, JPEG, or GIF format.');
  return avatar;
}

export function createTinyServer({
  dbPath = ':memory:',
  host = '127.0.0.1',
  port = 8787,
  localAuth = true,
  registrationEnabled = true,
  allowedOrigins = DEFAULT_ORIGINS,
  rtcConfig = () => ({ iceServers: [], expiresAt: null }),
  trustProxy = false,
  staticDir = resolve('dist'),
} = {}) {
  if (typeof rtcConfig !== 'function')
    throw new Error('rtcConfig must issue ICE configuration per user.');
  const origins = new Set(allowedOrigins);
  const db = openDatabase(dbPath);
  const sockets = new Map(); // peerId -> authenticated connection
  const calls = new Map(); // conversationId -> Set<peerId>
  const rates = new Map();
  let closing = false;
  const permittedOrigin = (origin) => !origin || origins.has(origin);
  const clientIp = (req) => {
    const remote = req.socket.remoteAddress || 'unknown';
    const loopback = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote);
    if (!trustProxy || !loopback) return remote;
    const forwarded = req.headers['x-forwarded-for'];
    const first = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    return first?.split(',')[0]?.trim().slice(0, 64) || remote;
  };
  function throttle(key, max, windowMs) {
    const now = Date.now();
    const rate = rates.get(key);
    if (!rate || rate.until < now) {
      rates.set(key, { n: 1, until: now + windowMs });
      return;
    }
    if (++rate.n > max)
      fail(429, 'Too many requests. Wait a moment and try again.');
  }
  const usersIn = (conversationId) =>
    db
      .prepare(
        'SELECT u.* FROM users u JOIN members m ON m.user_id=u.id WHERE m.conversation_id=? ORDER BY u.handle',
      )
      .all(conversationId)
      .map(publicUser);
  function requireMember(userId, conversationId) {
    if (
      !db
        .prepare('SELECT 1 FROM members WHERE user_id=? AND conversation_id=?')
        .get(userId, conversationId)
    )
      fail(403, 'This chat is not available to your account.');
  }
  const callParticipants = (id) =>
    [...(calls.get(id) || [])]
      .map((peerId) => ({ peerId, userId: sockets.get(peerId)?.user.id }))
      .filter((p) => p.userId);
  function conversation(id) {
    const row = db.prepare('SELECT * FROM conversations WHERE id=?').get(id);
    if (!row) fail(404, 'Chat not found.');
    const last = db
      .prepare(
        'SELECT * FROM messages WHERE conversation_id=? ORDER BY id DESC LIMIT 1',
      )
      .get(id);
    return {
      id: row.id,
      title: row.title,
      isGroup: Boolean(row.is_group),
      members: usersIn(id),
      lastMessage: last ? messageView(last) : null,
      callParticipants: callParticipants(id),
    };
  }
  function send(ws, event) {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(event));
  }
  function broadcastUsers(userIds, event) {
    const recipients = new Set(userIds);
    for (const connection of sockets.values())
      if (recipients.has(connection.user.id)) send(connection.ws, event);
  }
  function broadcastConversation(id, event) {
    broadcastUsers(
      usersIn(id).map((u) => u.id),
      event,
    );
  }
  function broadcastPresence() {
    for (const connection of sockets.values()) {
      const ids = new Set(
        db
          .prepare('SELECT friend_id FROM friends WHERE user_id=?')
          .all(connection.user.id)
          .map((r) => r.friend_id),
      );
      ids.add(connection.user.id);
      send(connection.ws, {
        type: 'presence',
        userIds: [
          ...new Set(
            [...sockets.values()]
              .map((c) => c.user.id)
              .filter((id) => ids.has(id)),
          ),
        ],
      });
    }
  }
  function leaveCall(connection) {
    const id = connection.call;
    if (!id) return;
    connection.call = null;
    const room = calls.get(id);
    room?.delete(connection.peerId);
    for (const peer of room || [])
      send(sockets.get(peer).ws, {
        type: 'call:peer-left',
        conversationId: id,
        peerId: connection.peerId,
        userId: connection.user.id,
      });
    if (!room?.size) calls.delete(id);
    broadcastConversation(id, {
      type: 'call:state',
      conversationId: id,
      participants: callParticipants(id),
    });
  }
  async function readJson(req) {
    if (!(req.headers['content-type'] || '').startsWith('application/json'))
      fail(415, 'Send JSON with Content-Type application/json.');
    let length = 0;
    const chunks = [];
    for await (const chunk of req) {
      length += chunk.length;
      if (length > MAX_BODY)
        fail(
          413,
          'Request too large. Profile pictures must be smaller than 10 MB.',
        );
      chunks.push(chunk);
    }
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!body || typeof body !== 'object' || Array.isArray(body))
        fail(400, 'Send a JSON object.');
      return body;
    } catch (error) {
      if (error.status) throw error;
      fail(400, 'Invalid JSON.');
    }
  }
  const server = createServer(async (req, res) => {
    const origin = req.headers.origin;
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-site');
    res.setHeader(
      'Permissions-Policy',
      'camera=(), microphone=(self), display-capture=(self)',
    );
    const json = (status, value) => {
      res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
      });
      res.end(JSON.stringify(value));
    };
    try {
      if (!permittedOrigin(origin))
        fail(
          403,
          'This app origin is not allowed. Add it to TINY_ALLOWED_ORIGINS on the server.',
        );
      if (origin) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
        res.setHeader(
          'Access-Control-Allow-Headers',
          'Authorization, Content-Type',
        );
        res.setHeader(
          'Access-Control-Allow-Methods',
          'GET, POST, PATCH, DELETE, OPTIONS',
        );
      }
      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }
      const url = new URL(req.url, 'http://tiny.local');
      const path = url.pathname;
      if (path === '/api/health' && req.method === 'GET') {
        db.prepare('SELECT 1').get();
        return json(200, { ok: true });
      }
      if (path === '/api/config' && req.method === 'GET')
        return json(200, {
          localAuth,
          registrationEnabled,
          maxCallParticipants: MAX_CALL,
        });
      if (path === '/api/auth/local' && req.method === 'POST') {
        if (!localAuth)
          fail(403, 'Password sign-in is disabled on this server.');
        throttle(`auth-ip:${clientIp(req)}`, 20, 60_000);
        const body = await readJson(req);
        const handle =
          typeof body.handle === 'string'
            ? body.handle.trim().toLowerCase()
            : '';
        if (!/^[a-z0-9_]{3,24}$/.test(handle))
          fail(
            400,
            'Handle must be 3–24 lowercase letters, numbers, or underscores.',
          );
        if (
          typeof body.password !== 'string' ||
          body.password.length < 8 ||
          body.password.length > 128
        )
          fail(400, 'Test password must be 8–128 characters.');
        const existing = db
          .prepare('SELECT * FROM users WHERE handle=?')
          .get(handle);
        let user;
        if (body.create === true) {
          if (!registrationEnabled)
            fail(403, 'New account registration is temporarily closed.');
          throttle(`register-ip:${clientIp(req)}`, 15, 15 * 60_000);
          if (body.password.length < 12)
            fail(400, 'New passwords must contain at least 12 characters.');
          if (existing) fail(409, 'That account could not be created.');
          const name = cleanText(
            body.displayName || handle,
            48,
            'Display name',
          );
          try {
            user = await createAccount(db, handle, body.password, name);
          } catch (error) {
            if (/UNIQUE/.test(error.message))
              fail(409, 'That account could not be created.');
            throw error;
          }
        } else {
          throttle(`login:${clientIp(req)}:${handle}`, 10, 15 * 60_000);
          if (!(await verifyPassword(existing, body.password)))
            fail(401, 'Handle or password is incorrect.');
          user = publicUser(existing);
        }
        return json(200, { token: issueSession(db, user.id), user });
      }
      if (path.startsWith('/api/')) {
        const token = req.headers.authorization?.replace(/^Bearer /, '');
        const user = sessionUser(db, token);
        if (!user) fail(401, 'Your session has ended. Sign in again.');
        throttle(`http:${user.id}`, 240, 60_000);
        if (path === '/api/me' && req.method === 'GET') return json(200, user);
        if (path === '/api/rtc/config' && req.method === 'GET')
          return json(200, rtcConfig(user.id));
        if (path === '/api/logout' && req.method === 'POST') {
          db.prepare('DELETE FROM sessions WHERE token_hash=?').run(
            digest(token),
          );
          for (const connection of sockets.values())
            if (connection.token === token)
              connection.ws.close(4001, 'Signed out');
          return json(200, { ok: true });
        }
        if (path === '/api/me' && req.method === 'PATCH') {
          const body = await readJson(req);
          const name =
            body.displayName === undefined
              ? user.displayName
              : cleanText(body.displayName, 48, 'Display name');
          const avatar =
            body.avatar === undefined
              ? user.avatar
              : validateAvatar(body.avatar);
          const banner =
            body.banner === undefined
              ? user.banner
              : validateAvatar(body.banner);
          const presenceMode =
            body.presenceMode === undefined
              ? user.presenceMode
              : ['online', 'afk', 'dnd'].includes(body.presenceMode)
                ? body.presenceMode
                : fail(400, 'Choose Online, AFK, or Do Not Disturb.');
          db.prepare(
            'UPDATE users SET display_name=?,avatar=?,banner=?,presence_mode=? WHERE id=?',
          ).run(name, avatar, banner, presenceMode, user.id);
          const friendIds = db
            .prepare('SELECT friend_id FROM friends WHERE user_id=?')
            .all(user.id)
            .map((r) => r.friend_id);
          broadcastUsers([user.id, ...friendIds], { type: 'state' });
          return json(
            200,
            publicUser(
              db.prepare('SELECT * FROM users WHERE id=?').get(user.id),
            ),
          );
        }
        if (path === '/api/state' && req.method === 'GET') {
          const friends = db
            .prepare(
              'SELECT u.*, f.created_at AS friend_since FROM friends f JOIN users u ON u.id=f.friend_id WHERE f.user_id=? ORDER BY u.display_name',
            )
            .all(user.id)
            .map((row) => ({
              ...publicUser(row),
              friendsSince: row.friend_since || null,
            }));
          const conversations = db
            .prepare(
              'SELECT c.id FROM conversations c JOIN members m ON m.conversation_id=c.id WHERE m.user_id=? ORDER BY c.created_at DESC',
            )
            .all(user.id)
            .map((row) => conversation(row.id));
          const incoming = db
            .prepare(
              `SELECT r.created_at, u.* FROM friend_requests r
               JOIN users u ON u.id=r.requester_id
               WHERE r.recipient_id=? ORDER BY r.created_at DESC`,
            )
            .all(user.id)
            .map((row) => ({
              user: publicUser(row),
              createdAt: row.created_at,
            }));
          const outgoing = db
            .prepare(
              `SELECT r.created_at, u.* FROM friend_requests r
               JOIN users u ON u.id=r.recipient_id
               WHERE r.requester_id=? ORDER BY r.created_at DESC`,
            )
            .all(user.id)
            .map((row) => ({
              user: publicUser(row),
              createdAt: row.created_at,
            }));
          return json(200, {
            user,
            friends,
            friendRequests: { incoming, outgoing },
            conversations,
          });
        }
        if (path === '/api/friend-requests' && req.method === 'POST') {
          const body = await readJson(req);
          const friend = db
            .prepare('SELECT * FROM users WHERE handle=?')
            .get(
              typeof body.handle === 'string'
                ? body.handle.trim().toLowerCase()
                : '',
            );
          if (!friend) fail(404, 'No Tiny account uses that handle.');
          if (friend.id === user.id)
            fail(400, 'Choose a friend other than yourself.');
          if (
            db
              .prepare('SELECT 1 FROM friends WHERE user_id=? AND friend_id=?')
              .get(user.id, friend.id)
          )
            fail(409, 'You are already friends.');
          if (
            db
              .prepare(
                'SELECT 1 FROM friend_requests WHERE requester_id=? AND recipient_id=?',
              )
              .get(user.id, friend.id)
          )
            fail(409, 'That friend request is already pending.');
          if (
            db
              .prepare(
                'SELECT 1 FROM friend_requests WHERE requester_id=? AND recipient_id=?',
              )
              .get(friend.id, user.id)
          )
            fail(
              409,
              'This person already sent you a request. Accept it instead.',
            );
          db.prepare('INSERT INTO friend_requests VALUES (?,?,?)').run(
            user.id,
            friend.id,
            new Date().toISOString(),
          );
          broadcastUsers([user.id, friend.id], { type: 'state' });
          return json(200, publicUser(friend));
        }
        const friendRequestRoute = /^\/api\/friend-requests\/([^/]+)$/.exec(
          path,
        );
        if (friendRequestRoute && req.method === 'PATCH') {
          const otherId = friendRequestRoute[1];
          const body = await readJson(req);
          if (!['accept', 'decline', 'cancel'].includes(body.action))
            fail(400, 'Choose accept, decline, or cancel.');
          if (body.action === 'cancel') {
            const result = db
              .prepare(
                'DELETE FROM friend_requests WHERE requester_id=? AND recipient_id=?',
              )
              .run(user.id, otherId);
            if (!result.changes)
              fail(404, 'That outgoing request is no longer pending.');
          } else {
            const pending = db
              .prepare(
                'SELECT 1 FROM friend_requests WHERE requester_id=? AND recipient_id=?',
              )
              .get(otherId, user.id);
            if (!pending)
              fail(404, 'That incoming request is no longer pending.');
            transaction(db, () => {
              if (body.action === 'accept') {
                db.prepare(
                  'INSERT OR IGNORE INTO friends (user_id,friend_id,created_at) VALUES (?,?,?)',
                ).run(user.id, otherId, new Date().toISOString());
                db.prepare(
                  'INSERT OR IGNORE INTO friends (user_id,friend_id,created_at) VALUES (?,?,?)',
                ).run(otherId, user.id, new Date().toISOString());
              }
              db.prepare(
                'DELETE FROM friend_requests WHERE requester_id=? AND recipient_id=?',
              ).run(otherId, user.id);
            });
          }
          broadcastUsers([user.id, otherId], { type: 'state' });
          if (body.action === 'accept') broadcastPresence();
          return json(200, { ok: true });
        }
        const friendshipRoute = /^\/api\/friends\/([^/]+)$/.exec(path);
        if (friendshipRoute && req.method === 'DELETE') {
          const otherId = friendshipRoute[1];
          const removed = transaction(db, () => {
            const a = db
              .prepare('DELETE FROM friends WHERE user_id=? AND friend_id=?')
              .run(user.id, otherId);
            db.prepare(
              'DELETE FROM friends WHERE user_id=? AND friend_id=?',
            ).run(otherId, user.id);
            return a.changes;
          });
          if (!removed) fail(404, 'That friendship no longer exists.');
          broadcastUsers([user.id, otherId], { type: 'state' });
          broadcastPresence();
          return json(200, { ok: true });
        }
        if (path === '/api/conversations' && req.method === 'POST') {
          const body = await readJson(req);
          if (
            !Array.isArray(body.memberIds) ||
            body.memberIds.some((id) => typeof id !== 'string')
          )
            fail(400, 'Choose friends for this chat.');
          const members = [
            ...new Set(body.memberIds.filter((id) => id !== user.id)),
          ];
          if (!members.length || members.length > 3)
            fail(400, 'Choose 1–3 friends (up to four people including you).');
          for (const id of members)
            if (
              !db
                .prepare(
                  'SELECT 1 FROM friends WHERE user_id=? AND friend_id=?',
                )
                .get(user.id, id)
            )
              fail(403, 'Add every participant as a friend first.');
          if (body.title !== undefined && typeof body.title !== 'string')
            fail(400, 'Group name must be text.');
          const group = members.length > 1 || Boolean(body.title?.trim());
          if (!group) {
            const existing = db
              .prepare(
                'SELECT c.id FROM conversations c JOIN members a ON a.conversation_id=c.id JOIN members b ON b.conversation_id=c.id WHERE c.is_group=0 AND a.user_id=? AND b.user_id=?',
              )
              .get(user.id, members[0]);
            if (existing) return json(200, conversation(existing.id));
          }
          const title = group
            ? cleanText(body.title || 'A little group', 64, 'Group name')
            : '';
          const id = randomUUID();
          transaction(db, () => {
            db.prepare('INSERT INTO conversations VALUES (?,?,?,?)').run(
              id,
              title,
              group ? 1 : 0,
              new Date().toISOString(),
            );
            for (const member of [user.id, ...members])
              db.prepare('INSERT INTO members VALUES (?,?)').run(id, member);
          });
          broadcastUsers([user.id, ...members], { type: 'state' });
          return json(201, conversation(id));
        }
        const conversationRoute = /^\/api\/conversations\/([^/]+)$/.exec(path);
        if (conversationRoute && req.method === 'DELETE') {
          const id = conversationRoute[1];
          requireMember(user.id, id);
          for (const connection of sockets.values())
            if (connection.user.id === user.id && connection.call === id)
              leaveCall(connection);
          const remaining = transaction(db, () => {
            db.prepare(
              'DELETE FROM members WHERE conversation_id=? AND user_id=?',
            ).run(id, user.id);
            const ids = db
              .prepare('SELECT user_id FROM members WHERE conversation_id=?')
              .all(id)
              .map((row) => row.user_id);
            if (!ids.length) {
              db.prepare('DELETE FROM messages WHERE conversation_id=?').run(
                id,
              );
              db.prepare('DELETE FROM conversations WHERE id=?').run(id);
            }
            return ids;
          });
          broadcastUsers([user.id, ...remaining], { type: 'state' });
          return json(200, { ok: true });
        }
        const messageRoute = /^\/api\/conversations\/([^/]+)\/messages$/.exec(
          path,
        );
        if (messageRoute) {
          const id = messageRoute[1];
          requireMember(user.id, id);
          if (req.method === 'GET') {
            const before = url.searchParams.get('before');
            if (
              before &&
              (!/^\d+$/.test(before) || !Number.isSafeInteger(Number(before)))
            )
              fail(400, 'Invalid message cursor.');
            const rows = before
              ? db
                  .prepare(
                    'SELECT * FROM messages WHERE conversation_id=? AND id<? ORDER BY id DESC LIMIT 101',
                  )
                  .all(id, Number(before))
              : db
                  .prepare(
                    'SELECT * FROM messages WHERE conversation_id=? ORDER BY id DESC LIMIT 101',
                  )
                  .all(id);
            return json(200, {
              messages: rows.slice(0, 100).reverse().map(messageView),
              hasMore: rows.length > 100,
            });
          }
          if (req.method === 'POST') {
            const body = await readJson(req);
            const text = cleanText(body.body, 4000, 'Message');
            const clientId = cleanText(
              body.clientId,
              128,
              'Message identifier',
            );
            let row = db
              .prepare(
                'SELECT * FROM messages WHERE sender_id=? AND client_id=?',
              )
              .get(user.id, clientId);
            if (row && (row.conversation_id !== id || row.body !== text))
              fail(409, 'Message identifier is already in use.');
            if (!row) {
              const result = db
                .prepare(
                  'INSERT INTO messages (conversation_id,sender_id,body,created_at,client_id) VALUES (?,?,?,?,?)',
                )
                .run(id, user.id, text, new Date().toISOString(), clientId);
              row = db
                .prepare('SELECT * FROM messages WHERE id=?')
                .get(result.lastInsertRowid);
              broadcastConversation(id, {
                type: 'message',
                message: messageView(row),
              });
            }
            return json(200, messageView(row));
          }
        }
        const messageItemRoute = /^\/api\/messages\/(\d+)$/.exec(path);
        if (messageItemRoute && ['PATCH', 'DELETE'].includes(req.method)) {
          const row = db
            .prepare('SELECT * FROM messages WHERE id=?')
            .get(Number(messageItemRoute[1]));
          if (!row) fail(404, 'Message not found.');
          requireMember(user.id, row.conversation_id);
          if (row.sender_id !== user.id)
            fail(403, 'Only the message author can change it.');
          if (row.deleted_at) fail(409, 'That message was already deleted.');
          if (req.method === 'PATCH') {
            const body = await readJson(req);
            const text = cleanText(body.body, 4000, 'Message');
            db.prepare(
              'UPDATE messages SET body=?, edited_at=? WHERE id=?',
            ).run(text, new Date().toISOString(), row.id);
          } else {
            db.prepare(
              "UPDATE messages SET body='', deleted_at=? WHERE id=?",
            ).run(new Date().toISOString(), row.id);
          }
          const updated = db
            .prepare('SELECT * FROM messages WHERE id=?')
            .get(row.id);
          broadcastConversation(row.conversation_id, {
            type: 'message:update',
            message: messageView(updated),
          });
          return json(200, messageView(updated));
        }
        fail(404, 'API route not found.');
      }
      if (req.method !== 'GET' && req.method !== 'HEAD')
        fail(405, 'Method not allowed.');
      let decoded;
      try {
        decoded = decodeURIComponent(path);
      } catch {
        fail(400, 'Invalid path.');
      }
      let file = resolve(
        staticDir,
        `.${decoded === '/' ? '/index.html' : decoded}`,
      );
      if (!file.startsWith(resolve(staticDir) + sep))
        fail(403, 'Invalid file path.');
      try {
        if (!(await stat(file)).isFile()) fail(404, 'File not found.');
      } catch {
        if (!extname(decoded)) file = resolve(staticDir, 'index.html');
        else fail(404, 'File not found.');
      }
      let contents;
      try {
        contents = await readFile(file);
      } catch {
        fail(
          404,
          'Tiny frontend is not built yet. Run npm run build, or use npm run dev.',
        );
      }
      const mime =
        {
          '.html': 'text/html; charset=utf-8',
          '.js': 'text/javascript; charset=utf-8',
          '.css': 'text/css; charset=utf-8',
          '.svg': 'image/svg+xml',
          '.png': 'image/png',
          '.ico': 'image/x-icon',
        }[extname(file)] || 'application/octet-stream';
      res.setHeader(
        'Content-Security-Policy',
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self' http: https: ws: wss:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
      );
      res.writeHead(200, { 'Content-Type': mime });
      res.end(req.method === 'HEAD' ? undefined : contents);
    } catch (error) {
      if (!error.status) console.error('Tiny request failed:', error);
      if (!res.headersSent)
        json(error.status || 500, {
          error: error.status
            ? error.message
            : 'The server could not complete this request.',
        });
      else res.end();
    }
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 128 * 1024 });
  server.on('upgrade', (req, socket, head) => {
    if (req.url !== '/ws' || !permittedOrigin(req.headers.origin)) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) =>
      wss.emit('connection', ws, req),
    );
  });
  wss.on('connection', (ws, req) => {
    let connection;
    let alive = true;
    let frameRate = { n: 0, until: Date.now() + 10_000 };
    const authTimeout = setTimeout(() => ws.close(4001, 'Sign in first'), 5000);
    ws.on('pong', () => {
      alive = true;
    });
    ws.tinyAlive = () => {
      if (!alive) return false;
      alive = false;
      return true;
    };
    ws.on('message', (raw) => {
      try {
        const now = Date.now();
        if (now > frameRate.until) frameRate = { n: 0, until: now + 10_000 };
        if (++frameRate.n > 150) {
          ws.close(4008, 'Too many messages');
          return;
        }
        let event;
        try {
          event = JSON.parse(raw.toString());
        } catch {
          fail(400, 'Invalid socket JSON.');
        }
        if (!event || typeof event !== 'object')
          fail(400, 'Invalid socket event.');
        if (!connection) {
          throttle(`ws-auth:${clientIp(req)}`, 100, 60_000);
          if (event.type !== 'auth') fail(401, 'Sign in first.');
          const userId = sessionUserId(db, event.token);
          if (!userId) {
            ws.close(4001, 'Session expired');
            return;
          }
          clearTimeout(authTimeout);
          connection = {
            ws,
            user: { id: userId },
            token: event.token,
            peerId: randomUUID(),
            call: null,
          };
          sockets.set(connection.peerId, connection);
          send(ws, { type: 'ready', peerId: connection.peerId });
          broadcastPresence();
          return;
        }
        if (!sessionUserId(db, connection.token)) {
          ws.close(4001, 'Session expired');
          return;
        }
        if (event.type === 'call:leave') {
          leaveCall(connection);
          return;
        }
        if (event.type === 'call:join') {
          const id = event.conversationId;
          if (typeof id !== 'string')
            fail(400, 'Choose a chat before joining a call.');
          requireMember(connection.user.id, id);
          if (connection.call === id) {
            send(ws, {
              type: 'call:joined',
              conversationId: id,
              peers: callParticipants(id).filter(
                (p) => p.peerId !== connection.peerId,
              ),
            });
            return;
          }
          const participants = callParticipants(id);
          if (participants.some((p) => p.userId === connection.user.id))
            fail(
              409,
              'Your account already joined this call in another window.',
            );
          if (participants.length >= MAX_CALL)
            fail(409, 'This call is full (four people maximum).');
          leaveCall(connection);
          if (!calls.has(id)) calls.set(id, new Set());
          calls.get(id).add(connection.peerId);
          connection.call = id;
          send(ws, {
            type: 'call:joined',
            conversationId: id,
            peers: participants,
          });
          for (const peer of participants)
            send(sockets.get(peer.peerId).ws, {
              type: 'call:peer-joined',
              conversationId: id,
              peerId: connection.peerId,
              userId: connection.user.id,
            });
          broadcastConversation(id, {
            type: 'call:state',
            conversationId: id,
            participants: callParticipants(id),
          });
          return;
        }
        if (event.type === 'signal') {
          if (connection.call !== event.conversationId || !connection.call)
            fail(403, 'Join this call before signaling.');
          const recipient = sockets.get(event.to);
          if (
            !recipient ||
            recipient.call !== connection.call ||
            recipient.peerId === connection.peerId
          )
            fail(403, 'That peer is not in your call.');
          const payload = {
            type: 'signal',
            conversationId: connection.call,
            from: connection.peerId,
          };
          if (event.description) {
            const description = event.description;
            if (
              typeof description !== 'object' ||
              Array.isArray(description) ||
              !['offer', 'answer', 'rollback'].includes(description.type)
            )
              fail(400, 'Invalid session description.');
            if (
              description.type !== 'rollback' &&
              (typeof description.sdp !== 'string' ||
                !description.sdp ||
                description.sdp.length > 100_000)
            )
              fail(400, 'Invalid session description.');
            payload.description =
              description.type === 'rollback'
                ? { type: 'rollback' }
                : { type: description.type, sdp: description.sdp };
          } else if (event.candidate !== undefined) {
            const candidate = event.candidate;
            if (
              candidate !== null &&
              (typeof candidate !== 'object' ||
                Array.isArray(candidate) ||
                typeof candidate.candidate !== 'string' ||
                candidate.candidate.length > 4096 ||
                (candidate.sdpMid != null &&
                  (typeof candidate.sdpMid !== 'string' ||
                    candidate.sdpMid.length > 256)) ||
                (candidate.sdpMLineIndex != null &&
                  (!Number.isInteger(candidate.sdpMLineIndex) ||
                    candidate.sdpMLineIndex < 0 ||
                    candidate.sdpMLineIndex > 65535)) ||
                (candidate.usernameFragment != null &&
                  (typeof candidate.usernameFragment !== 'string' ||
                    candidate.usernameFragment.length > 256)))
            )
              fail(400, 'Invalid ICE candidate.');
            payload.candidate =
              candidate === null
                ? null
                : {
                    candidate: candidate.candidate,
                    sdpMid: candidate.sdpMid ?? null,
                    sdpMLineIndex: candidate.sdpMLineIndex ?? null,
                    ...(candidate.usernameFragment == null
                      ? {}
                      : { usernameFragment: candidate.usernameFragment }),
                  };
          } else
            fail(400, 'Signal must include a description or ICE candidate.');
          send(recipient.ws, payload);
          return;
        }
        fail(400, 'Unknown socket event.');
      } catch (error) {
        send(ws, {
          type: 'error',
          message: error.status
            ? error.message
            : 'Unable to process socket event.',
        });
      }
    });
    ws.on('error', () => {});
    ws.on('close', () => {
      clearTimeout(authTimeout);
      if (!connection || closing) return;
      leaveCall(connection);
      sockets.delete(connection.peerId);
      broadcastPresence();
    });
  });
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.tinyAlive()) ws.terminate();
      else ws.ping();
    }
    for (const [key, rate] of rates)
      if (rate.until < Date.now()) rates.delete(key);
    for (const connection of sockets.values())
      if (!sessionUserId(db, connection.token))
        connection.ws.close(4001, 'Session expired');
  }, 30_000);
  heartbeat.unref();
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  return {
    server,
    db,
    listen: () =>
      new Promise((accept, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          accept(server.address());
        });
      }),
    close: async () => {
      closing = true;
      clearInterval(heartbeat);
      for (const ws of wss.clients) ws.terminate();
      await new Promise((accept) => wss.close(accept));
      if (server.listening)
        await new Promise((accept, reject) =>
          server.close((error) => (error ? reject(error) : accept())),
        );
      db.close();
    },
  };
}
