import { createHmac } from 'node:crypto';

function urls(value, label) {
  const items = Array.isArray(value) ? value : [value];
  if (
    !items.length ||
    items.some(
      (item) =>
        typeof item !== 'string' || !new RegExp(`^${label}:`, 'i').test(item),
    )
  )
    throw new Error(
      `${label.toUpperCase()} URLs must use the ${label}: scheme.`,
    );
  return items;
}

export function createRtcConfig({
  stunUrls = [],
  turnUrls = [],
  turnSecret = '',
  credentialTtlSeconds = 3600,
  now = () => Date.now(),
} = {}) {
  const stun = stunUrls.length ? urls(stunUrls, 'stun') : [];
  const turn = turnUrls.length ? urls(turnUrls, 'turns?') : [];
  if (turn.length && (!turnSecret || turnSecret.length < 32))
    throw new Error('TINY_TURN_SECRET must be at least 32 characters.');
  if (
    !Number.isSafeInteger(credentialTtlSeconds) ||
    credentialTtlSeconds < 300 ||
    credentialTtlSeconds > 86400
  )
    throw new Error('TURN credential lifetime must be 300-86400 seconds.');

  return (userId) => {
    const iceServers = [];
    if (stun.length) iceServers.push({ urls: stun });
    let expiresAt = null;
    if (turn.length) {
      const expires = Math.floor(now() / 1000) + credentialTtlSeconds;
      const username = `${expires}:${userId}`;
      const credential = createHmac('sha1', turnSecret)
        .update(username)
        .digest('base64');
      expiresAt = new Date(expires * 1000).toISOString();
      iceServers.push({ urls: turn, username, credential });
    }
    return { iceServers, expiresAt };
  };
}

export function parseUrlList(value, name) {
  if (!value?.trim()) return [];
  const result = value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  if (!result.length) throw new Error(`${name} must contain at least one URL.`);
  return result;
}
