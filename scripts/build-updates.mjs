import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const EXTENSIONS = [
  { directory: 'x-account-location-flags', tagPattern: /^v(\d+)\.(\d+)\.(\d+)$/ },
  { directory: 'reddit-direct-images', tagPattern: /^reddit-v(\d+)\.(\d+)\.(\d+)$/ },
];

export function latestSignedRelease(releases, tagPattern) {
  return releases
    .filter(release => !release.draft && !release.prerelease && tagPattern.test(release.tag_name))
    .sort((a, b) => {
      const left = a.tag_name.match(tagPattern).slice(1).map(Number);
      const right = b.tag_name.match(tagPattern).slice(1).map(Number);
      for (let i = 0; i < left.length; i++) {
        if (left[i] !== right[i]) return right[i] - left[i];
      }
      return 0;
    })[0];
}

export function updateEntry(release, tagPattern, bytes) {
  const assets = release.assets.filter(asset => asset.name.endsWith('.xpi'));
  if (assets.length !== 1) {
    throw new Error(`Expected one signed XPI in release ${release.tag_name}`);
  }
  return {
    version: release.tag_name.match(tagPattern).slice(1).join('.'),
    update_link: assets[0].browser_download_url,
    update_hash: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
  };
}

async function main() {
  const repository = process.env.GITHUB_REPOSITORY;
  const token = process.env.GITHUB_TOKEN;
  if (!repository || !token) throw new Error('GITHUB_REPOSITORY and GITHUB_TOKEN are required');

  const releases = [];
  for (let page = 1; ; page++) {
    const response = await fetch(`https://api.github.com/repos/${repository}/releases?per_page=100&page=${page}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    if (!response.ok) throw new Error(`GitHub releases API: HTTP ${response.status}`);
    const batch = await response.json();
    releases.push(...batch);
    if (batch.length < 100) break;
  }

  const addons = {};
  for (const { directory, tagPattern } of EXTENSIONS) {
    const release = latestSignedRelease(releases, tagPattern);
    if (!release) continue;
    const assets = release.assets.filter(asset => asset.name.endsWith('.xpi'));
    if (assets.length !== 1) throw new Error(`Expected one signed XPI in ${release.tag_name}`);
    const download = await fetch(assets[0].browser_download_url);
    if (!download.ok) throw new Error(`Failed to download ${assets[0].name}: HTTP ${download.status}`);
    const bytes = Buffer.from(await download.arrayBuffer());
    const manifest = JSON.parse(await readFile(`extensions/${directory}/manifest.json`, 'utf8'));
    addons[manifest.browser_specific_settings.gecko.id] = {
      updates: [updateEntry(release, tagPattern, bytes)],
    };
  }

  await mkdir('site', { recursive: true });
  await writeFile('site/updates.json', JSON.stringify({ addons }, null, 2) + '\n');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await main();
}
