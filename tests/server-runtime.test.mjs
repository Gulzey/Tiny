import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import {
  parseServerArguments,
  resolveServerSettings,
} from '../server/runtime.mjs';

test('packaged server defaults are loopback, persistent AppData, and no demo accounts', () => {
  const executableDir = resolve('test-executable');
  const env = { LOCALAPPDATA: resolve('test-app-data') };
  const settings = resolveServerSettings({ env, executableDir });
  assert.equal(settings.host, '127.0.0.1');
  assert.equal(settings.port, 8787);
  assert.equal(
    settings.dbPath,
    join(env.LOCALAPPDATA, 'Tiny Server', 'tiny.sqlite'),
  );
  assert.equal(settings.localAuth, true);
  assert.deepEqual(settings.rtcConfig('user').iceServers, []);
  assert.deepEqual(parseServerArguments([]), {});
});

test('packaged server command switches override host, port, and relative database settings', () => {
  const executableDir = resolve('test-executable');
  const options = parseServerArguments([
    '--host',
    '0.0.0.0',
    '--port',
    '0',
    '--data-dir',
    'isolated',
    '--seed-demo',
    '--no-pause',
  ]);
  const settings = resolveServerSettings({
    options,
    executableDir,
    env: {
      TINY_HOST: 'localhost',
      TINY_PORT: '9999',
      TINY_DB: 'ignored.sqlite',
      TINY_LOCAL_AUTH: 'false',
      TINY_ALLOWED_ORIGINS: 'https://tauri.localhost, http://localhost:1420',
    },
  });
  assert.equal(settings.host, '0.0.0.0');
  assert.equal(settings.port, 0);
  assert.equal(settings.dbPath, join(executableDir, 'isolated', 'tiny.sqlite'));
  assert.equal(settings.localAuth, false);
  assert.deepEqual(settings.allowedOrigins, [
    'https://tauri.localhost',
    'http://localhost:1420',
  ]);
  assert.equal(options.seedDemo, true);
  assert.equal(options.noPause, true);
  const relative = resolveServerSettings({
    executableDir,
    env: { TINY_DB: 'data/host.sqlite' },
  });
  assert.equal(relative.dbPath, join(executableDir, 'data', 'host.sqlite'));
});

test('packaged server rejects malformed switches and settings before opening a database', () => {
  for (const args of [['--port'], ['--host', '--seed-demo'], ['--anything']])
    assert.throws(() => parseServerArguments(args));
  for (const port of ['-1', '65536', '1.5', 'not-a-port'])
    assert.throws(
      () => resolveServerSettings({ env: { TINY_PORT: port } }),
      /port/,
    );
  assert.throws(
    () => resolveServerSettings({ env: { TINY_HOST: 'http://localhost' } }),
    /listening address/,
  );
  assert.throws(
    () =>
      resolveServerSettings({
        env: { TINY_TURN_URLS: 'https://not-turn.example' },
      }),
    /TURN/i,
  );
  assert.throws(
    () =>
      resolveServerSettings({
        env: { TINY_TURN_URLS: 'turn:turn.example', TINY_TURN_SECRET: 'short' },
      }),
    /secret/i,
  );
  assert.equal(parseServerArguments(['--seed-only']).seedOnly, true);
});
