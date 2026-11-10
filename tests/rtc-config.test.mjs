import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createRtcConfig } from '../server/rtc.mjs';

test('RTC configuration issues short-lived coturn REST credentials per account', () => {
  const secret = 'a-secure-test-secret-that-is-long-enough';
  const now = Date.UTC(2026, 10, 10, 12, 0, 0);
  const issue = createRtcConfig({
    stunUrls: ['stun:tiny.example:3478'],
    turnUrls: [
      'turn:tiny.example:3478?transport=udp',
      'turns:tiny.example:5349?transport=tcp',
    ],
    turnSecret: secret,
    credentialTtlSeconds: 3600,
    now: () => now,
  });
  const result = issue('user-123');
  assert.deepEqual(result.iceServers[0], {
    urls: ['stun:tiny.example:3478'],
  });
  const turn = result.iceServers[1];
  assert.equal(turn.username, `${Math.floor(now / 1000) + 3600}:user-123`);
  assert.equal(
    turn.credential,
    createHmac('sha1', secret).update(turn.username).digest('base64'),
  );
  assert.equal(result.expiresAt, '2026-11-10T13:00:00.000Z');
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test('TURN configuration rejects missing secrets and unsafe credential lifetimes', () => {
  assert.throws(
    () => createRtcConfig({ turnUrls: ['turn:tiny.example:3478'] }),
    /secret/i,
  );
  assert.throws(
    () =>
      createRtcConfig({
        turnUrls: ['turn:tiny.example:3478'],
        turnSecret: 'x'.repeat(32),
        credentialTtlSeconds: 60,
      }),
    /lifetime/i,
  );
});
