import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildFlashManifest,
  normalizeRelease,
  parseProxyDirective,
  resolveProxyStatus,
  resolveProxyUrl,
  resolveRepoConfig,
  selectZipAsset,
} from '../src/github.js';

test('resolveRepoConfig prefers injected data dir and repo slug', () => {
  const config = resolveRepoConfig({
    GITHUB_REPO: 'Acme/Dongle-Flasher',
    DATA_DIR: '/tmp/ds5-data',
    APPDATA: 'C:/Users/Test/AppData/Roaming',
  });

  assert.equal(config.owner, 'Acme');
  assert.equal(config.repo, 'Dongle-Flasher');
  assert.equal(config.dataDir, '/tmp/ds5-data');
  assert.equal(config.port, 3000);
});

test('normalizeRelease selects zip assets and preserves metadata', () => {
  const release = normalizeRelease({
    id: 1,
    tag_name: 'v1.2.3',
    name: 'Release 1.2.3',
    published_at: '2025-01-02T03:04:05Z',
    body: 'notes',
    prerelease: false,
    draft: false,
    assets: [
      { id: 10, name: 'release.zip', size: 11, content_type: 'application/zip', browser_download_url: 'https://example.com/release.zip' },
      { id: 11, name: 'notes.txt', size: 2, content_type: 'text/plain' },
    ],
  });

  assert.equal(release.tagName, 'v1.2.3');
  assert.equal(release.asset.name, 'release.zip');
  assert.equal(release.assets.length, 2);
});

test('buildFlashManifest detects firmware and support files', () => {
  const manifest = buildFlashManifest([
    'firmware.bin',
    'boot2.bin',
    'partition.bin',
    'flash_prog_cfg.ini',
    'partition_cfg_4m.toml',
    'partition_cfg_4m_nosec.toml',
    'readme.txt',
  ], 'std');

  assert.equal(manifest.firmware, 'firmware.bin');
  assert.equal(manifest.boot2, 'boot2.bin');
  assert.equal(manifest.partition, 'partition.bin');
  assert.equal(manifest.flashProgConfig, 'flash_prog_cfg.ini');
  assert.equal(manifest.partitionToml, 'partition_cfg_4m.toml');
  assert.equal(manifest.partitionNoSecToml, 'partition_cfg_4m_nosec.toml');
  assert.equal(manifest.readme, 'readme.txt');
});

test('selectZipAsset prefers application/zip assets', () => {
  const asset = selectZipAsset([
    { name: 'firmware.bin', content_type: 'application/octet-stream' },
    { name: 'bundle.zip', content_type: 'application/octet-stream' },
    { name: 'bundle.zip', content_type: 'application/zip' },
  ]);

  assert.equal(asset.name, 'bundle.zip');
});

test('parseProxyDirective handles Windows proxy syntax', () => {
  assert.equal(parseProxyDirective('PROXY 127.0.0.1:7890'), 'http://127.0.0.1:7890');
  assert.equal(parseProxyDirective('HTTPS 127.0.0.1:7890'), 'https://127.0.0.1:7890');
  assert.equal(parseProxyDirective('SOCKS5 127.0.0.1:7891'), 'socks5://127.0.0.1:7891');
  assert.equal(parseProxyDirective('DIRECT'), '');
});

test('resolveProxyUrl prefers explicit github proxy env', async () => {
  const proxy = await resolveProxyUrl('https://api.github.com', { GITHUB_PROXY: 'http://127.0.0.1:7890' }, async () => 'PROXY 127.0.0.1:9999');
  assert.equal(proxy, 'http://127.0.0.1:7890');
});

test('resolveProxyStatus reports system proxy when resolver returns one', async () => {
  const status = await resolveProxyStatus('https://api.github.com', {}, async () => 'PROXY 127.0.0.1:7890');
  assert.equal(status.mode, 'proxy');
  assert.equal(status.source, 'system');
  assert.equal(status.proxyUrl, 'http://127.0.0.1:7890');
});

test('resolveProxyStatus reports direct when nothing is configured', async () => {
  const status = await resolveProxyStatus('https://api.github.com', {}, async () => 'DIRECT');
  assert.equal(status.mode, 'direct');
  assert.equal(status.source, 'none');
  assert.equal(status.proxyUrl, '');
});
