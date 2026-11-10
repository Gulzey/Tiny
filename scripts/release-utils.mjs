import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export const RELEASE_REPOSITORY = 'Gulzey/Tinycom';
export const UPDATE_ENDPOINT = `https://github.com/${RELEASE_REPOSITORY}/releases/latest/download/latest.json`;

function validVersion(version) {
  if (typeof version !== 'string' || version.length > 128) return false;
  const match =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(
      version,
    );
  return Boolean(
    match &&
    (!match[4] ||
      match[4]
        .split('.')
        .every(
          (part) =>
            !/^\d+$/.test(part) || part === '0' || !part.startsWith('0'),
        )),
  );
}

export function createUpdateManifest({
  version,
  signature,
  notes = '',
  publishedAt = new Date().toISOString(),
}) {
  if (!validVersion(version))
    throw new Error('Release version must be valid SemVer, such as 0.2.0.');
  const signedContent = typeof signature === 'string' ? signature.trim() : '';
  // Tauri's .sig is encoded signature content. Paths, URLs, missing files, and
  // whitespace placeholders must never silently become an update manifest.
  if (
    !signedContent ||
    signedContent.length > 16384 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(signedContent) ||
    Buffer.from(signedContent, 'base64').toString('base64') !== signedContent
  )
    throw new Error(
      'The installer needs its generated Tauri .sig content, not a path or URL.',
    );
  if (typeof notes !== 'string') throw new Error('Release notes must be text.');
  const date = new Date(publishedAt);
  if (!Number.isFinite(date.getTime()))
    throw new Error('Release publication date is invalid.');
  return {
    version,
    notes,
    pub_date: date.toISOString(),
    platforms: {
      'windows-x86_64': {
        url: `https://github.com/${RELEASE_REPOSITORY}/releases/download/${encodeURIComponent(`v${version}`)}/Tiny-Setup.exe`,
        signature: signedContent,
      },
    },
  };
}

export async function readSigningKey({
  root,
  configured = process.env.TAURI_SIGNING_PRIVATE_KEY,
}) {
  if (configured && configured.trim()) {
    // The Tauri environment variable supports either a filename or key content.
    // Never print either value: the key is passed only to the child build.
    try {
      return (await readFile(resolve(root, configured), 'utf8')).trim();
    } catch (error) {
      if (!['ENOENT', 'ENAMETOOLONG', 'EINVAL'].includes(error.code))
        throw new Error('The configured signing key file could not be read.');
      if (
        !configured.includes('\n') &&
        !/^[A-Za-z0-9+/]+={0,2}$/.test(configured.trim())
      )
        throw new Error(
          'The configured signing key file was not found. Check TAURI_SIGNING_PRIVATE_KEY.',
        );
      return configured.trim();
    }
  }
  try {
    const key = (
      await readFile(resolve(root, '.build', 'update-keys', 'tiny.key'), 'utf8')
    ).trim();
    if (!key) throw new Error('empty');
    return key;
  } catch {
    throw new Error(
      'A private updater signing key is required. Set TAURI_SIGNING_PRIVATE_KEY or place the existing key in .build/update-keys/tiny.key. See docs/UPDATES.md.',
    );
  }
}
