import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { latestSignedRelease, updateEntry } from './build-updates.mjs';

const asset = { name: 'example.xpi', browser_download_url: 'https://github.com/example/repo/releases/download/v0.3.0/example.xpi' };
const release = (tag, extras = {}) => ({ tag_name: tag, draft: false, prerelease: false, assets: [asset], ...extras });

test('chooses the newest signed stable version independently for each extension', () => {
  const releases = [
    release('reddit-v0.2.0'),
    release('v0.3.0'),
    release('v0.10.0'),
    release('v0.11.0', { prerelease: true }),
    release('v1.0.0', { draft: true }),
    release('reddit-v0.3.0'),
    release('reddit-v0.5.0', { prerelease: true }),
  ];
  assert.equal(latestSignedRelease(releases, /^v(\d+)\.(\d+)\.(\d+)$/).tag_name, 'v0.10.0');
  assert.equal(latestSignedRelease(releases, /^reddit-v(\d+)\.(\d+)\.(\d+)$/).tag_name, 'reddit-v0.3.0');
  assert.equal(latestSignedRelease([], /^reddit-v(\d+)\.(\d+)\.(\d+)$/), undefined);
});

test('generates the update URL and hash from the actual signed release asset', () => {
  const bytes = Buffer.from('signed XPI fixture');
  const output = updateEntry(release('v0.3.0'), /^v(\d+)\.(\d+)\.(\d+)$/, bytes);
  assert.deepEqual(output, {
    version: '0.3.0',
    update_link: asset.browser_download_url,
    update_hash: 'sha256:' + createHash('sha256').update(bytes).digest('hex'),
  });
});

test('refuses releases without exactly one signed XPI', () => {
  assert.throws(() => updateEntry(release('reddit-v0.1.0', { assets: [] }), /^reddit-v(\d+)\.(\d+)\.(\d+)$/, Buffer.alloc(0)), /Expected one signed XPI/);
  assert.throws(() => updateEntry(release('v0.3.0', { assets: [asset, asset] }), /^v(\d+)\.(\d+)\.(\d+)$/, Buffer.alloc(0)), /Expected one signed XPI/);
});
