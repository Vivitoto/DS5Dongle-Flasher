import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFlashManifest, normalizeRelease, selectZipAsset } from '../src/github.js';

test('selectZipAsset prefers zip assets', () => {
  const asset = selectZipAsset([
    { id: 1, name: 'notes.txt', content_type: 'text/plain' },
    { id: 2, name: 'bundle.zip', content_type: 'application/octet-stream' },
    { id: 3, name: 'bundle-two.zip', content_type: 'application/zip' },
  ]);

  assert.equal(asset.id, 3);
  assert.equal(asset.name, 'bundle-two.zip');
});

test('normalizeRelease keeps release metadata and the selected asset', () => {
  const release = normalizeRelease({
    id: 7,
    tag_name: 'v9.1',
    name: 'v9.1',
    published_at: '2026-09-04T10:31:25Z',
    prerelease: false,
    draft: false,
    assets: [{ id: 88, name: 'firmware.zip', content_type: 'application/zip', browser_download_url: 'https://example.test/firmware.zip' }],
  }, true);

  assert.equal(release.tagName, 'v9.1');
  assert.equal(release.isLatest, true);
  assert.equal(release.asset.name, 'firmware.zip');
});

test('buildFlashManifest picks standard and HS firmware files', () => {
  const files = [
    'ds5dongle-bl618-lctech616-v3.19/partition.bin',
    'ds5dongle-bl618-lctech616-v3.19/boot2_bl616_isp_release_v8.1.8.bin',
    'ds5dongle-bl618-lctech616-v3.19/ds5dongle-lctech616.bin',
    'ds5dongle-bl618-lctech616-v3.19/ds5dongle-lctech616-hs.bin',
    'ds5dongle-bl618-lctech616-v3.19/flash_prog_cfg.ini',
    'ds5dongle-bl618-lctech616-v3.19/partition_cfg_4M.toml',
    'ds5dongle-bl618-lctech616-v3.19/partition_cfg_4M_nosec.toml',
    'ds5dongle-bl618-lctech616-v3.19/README.txt',
  ];

  const stdManifest = buildFlashManifest(files, 'std');
  const hsManifest = buildFlashManifest(files, 'hs');

  assert.match(stdManifest.firmware, /ds5dongle-lctech616\.bin$/);
  assert.match(hsManifest.firmware, /ds5dongle-lctech616-hs\.bin$/);
  assert.match(stdManifest.boot2, /boot2_bl616_isp_release_v8\.1\.8\.bin$/);
  assert.match(stdManifest.partition, /partition\.bin$/);
});

