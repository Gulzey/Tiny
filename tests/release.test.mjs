import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createUpdateManifest,
  readSigningKey,
  UPDATE_ENDPOINT,
} from '../scripts/release-utils.mjs';

// Format fixture only. The native updater integration tests verify real
// cryptographic signatures; this unit test checks safe release metadata.
const signature = Buffer.from('synthetic signature format fixture').toString(
  'base64',
);

test('release manifest embeds signature content and a version-specific HTTPS installer URL', () => {
  const manifest = createUpdateManifest({
    version: '0.2.0',
    signature: `\n${signature}\n`,
    notes: 'A desktop update',
    publishedAt: '2026-11-10T12:00:00Z',
  });
  assert.equal(manifest.platforms['windows-x86_64'].signature, signature);
  assert.equal(
    manifest.platforms['windows-x86_64'].url,
    'https://github.com/Gulzey/Tiny-Releases/releases/download/v0.2.0/Tiny-Setup.exe',
  );
  assert.equal(manifest.pub_date, '2026-11-10T12:00:00.000Z');
  assert.equal(manifest.version, '0.2.0');
  assert.equal(new URL(UPDATE_ENDPOINT).protocol, 'https:');
  assert.equal(new URL(manifest.platforms['windows-x86_64'].url).username, '');
  assert.equal(
    manifest.platforms['windows-x86_64'].url.includes('/latest/'),
    false,
  );
});

test('release manifest rejects missing signatures, signature paths/URLs, malformed versions, and dates', () => {
  for (const invalid of [
    '',
    'C:\\secret\\installer.sig',
    'https://example.com/installer.sig',
    'not valid base64',
    'AAA',
  ])
    assert.throws(
      () => createUpdateManifest({ version: '0.2.0', signature: invalid }),
      /sig/,
    );
  for (const version of [
    '0.2',
    'v0.2.0',
    '01.2.0',
    '0.2.0-01',
    '0.2.0/../../private',
  ])
    assert.throws(() => createUpdateManifest({ version, signature }), /SemVer/);
  assert.throws(
    () =>
      createUpdateManifest({
        version: '0.2.0',
        signature,
        publishedAt: 'invalid',
      }),
    /date/,
  );
  assert.equal(
    createUpdateManifest({ version: '0.3.0-beta.1', signature }).version,
    '0.3.0-beta.1',
  );
});

test('desktop build reads an existing private key without generating or replacing it', async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'tiny-signing-test-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  await assert.rejects(
    readSigningKey({ root: folder, configured: '' }),
    /private updater signing key/,
  );
  await mkdir(join(folder, '.build', 'update-keys'), { recursive: true });
  await writeFile(
    join(folder, '.build', 'update-keys', 'tiny.key'),
    'test-fixture-key\n',
  );
  assert.equal(
    await readSigningKey({ root: folder, configured: '' }),
    'test-fixture-key',
  );
  assert.equal(
    await readSigningKey({
      root: folder,
      configured: '.build/update-keys/tiny.key',
    }),
    'test-fixture-key',
  );
  const rawFixture = Buffer.from('not a real private key').toString('base64');
  assert.equal(
    await readSigningKey({ root: folder, configured: rawFixture }),
    rawFixture,
  );
  await assert.rejects(
    readSigningKey({ root: folder, configured: 'missing/private.key' }),
    /not found/,
  );
});
