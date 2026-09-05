import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';
import extractZip from 'extract-zip';
import { ProxyAgent } from 'undici';

const githubApiVersion = '2022-11-28';
const proxyCache = new Map();

function envValue(env, keys) {
  for (const key of keys) {
    const value = env[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return '';
}

function safeSegment(value) {
  return String(value)
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'item';
}

function normalizePath(file) {
  if (typeof file === 'string') {
    return file.replace(/\\/g, '/');
  }
  return String(file?.relativePath || file?.path || file?.name || '')
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '');
}

function basename(file) {
  return path.posix.basename(normalizePath(file)).toLowerCase();
}

function toSerializableFile(file, packageId) {
  const relativePath = normalizePath(file);
  return {
    name: path.posix.basename(relativePath),
    relativePath,
    size: file.size || 0,
    url: `/api/packages/${encodeURIComponent(packageId)}/file?path=${encodeURIComponent(relativePath)}`,
  };
}

function parseNoProxy(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function hostMatchesNoProxy(hostname, pattern) {
  if (pattern === '*') {
    return true;
  }

  const normalizedHost = hostname.toLowerCase();
  const normalizedPattern = pattern.toLowerCase().replace(/^\./, '');
  return normalizedHost === normalizedPattern || normalizedHost.endsWith(`.${normalizedPattern}`);
}

function shouldBypassProxy(urlString, env) {
  const noProxy = parseNoProxy(env.NO_PROXY || env.no_proxy);
  if (!noProxy.length) {
    return false;
  }

  try {
    const { hostname } = new URL(urlString);
    return noProxy.some((pattern) => hostMatchesNoProxy(hostname, pattern));
  } catch {
    return false;
  }
}

function getProxyUrl(env) {
  return envValue(env, ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy']);
}

function getDispatcher(urlString, env) {
  if (shouldBypassProxy(urlString, env)) {
    return undefined;
  }

  const proxyUrl = getProxyUrl(env);
  if (!proxyUrl) {
    return undefined;
  }

  if (!proxyCache.has(proxyUrl)) {
    proxyCache.set(proxyUrl, new ProxyAgent(proxyUrl));
  }

  return proxyCache.get(proxyUrl);
}

async function githubFetch(url, env, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set('Accept', init.accept || 'application/vnd.github+json');
  headers.set('X-GitHub-Api-Version', githubApiVersion);
  headers.set('User-Agent', 'ds5dongle-flasher/0.1.0');

  const token = envValue(env, ['GITHUB_TOKEN', 'github_token']);
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }

  const response = await fetch(url, {
    ...init,
    headers,
    dispatcher: getDispatcher(url, env),
  });

  if (!response.ok) {
    const details = await response.text().catch(() => '');
    throw new Error(`GitHub request failed (${response.status}): ${details || response.statusText}`);
  }

  return response;
}

export function resolveRepoConfig(env = process.env) {
  const repoSlug = envValue(env, ['GITHUB_REPO', 'github_repo']) || 'ds5dongle-bl618-opensource';
  const [repoOwnerFromSlug, repoNameFromSlug] = repoSlug.includes('/') ? repoSlug.split('/', 2) : ['', repoSlug];
  const owner = envValue(env, ['GITHUB_OWNER', 'github_owner']) || repoOwnerFromSlug || 'sqlCRT';
  const repo = repoNameFromSlug || repoSlug;

  return {
    owner,
    repo,
    dataDir: '/app/data',
    port: 3000,
  };
}

export function selectZipAsset(assets = []) {
  const normalized = assets.map((asset) => ({
    id: asset.id,
    name: asset.name,
    size: asset.size,
    contentType: asset.content_type || asset.contentType || '',
    apiUrl: asset.url || asset.apiUrl || '',
    downloadUrl: asset.browser_download_url || asset.url || asset.downloadUrl || '',
  }));

  return normalized.find((asset) => asset.contentType === 'application/zip')
    || normalized.find((asset) => asset.name.toLowerCase().endsWith('.zip'))
    || null;
}

export function normalizeRelease(raw, isLatest = false) {
  const asset = selectZipAsset(raw.assets || []);
  const assets = (raw.assets || []).map((item) => ({
    id: item.id,
    name: item.name,
    size: item.size,
    contentType: item.content_type || '',
    apiUrl: item.url || '',
    downloadUrl: item.browser_download_url || '',
  }));

  return {
    id: raw.id,
    tagName: raw.tag_name,
    name: raw.name || raw.tag_name,
    publishedAt: raw.published_at || raw.created_at || '',
    body: raw.body || '',
    prerelease: Boolean(raw.prerelease),
    draft: Boolean(raw.draft),
    isLatest,
    asset,
    assets,
  };
}

export async function fetchReleases(config, env = process.env) {
  const url = `https://api.github.com/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}/releases?per_page=30`;
  const response = await githubFetch(url, env);
  const rawReleases = await response.json();
  const filtered = rawReleases.filter((release) => !release.draft);
  filtered.sort((a, b) => {
    const left = new Date(a.published_at || a.created_at || 0).getTime();
    const right = new Date(b.published_at || b.created_at || 0).getTime();
    return right - left;
  });

  return filtered.map((release, index) => normalizeRelease(release, index === 0));
}

function chooseFirmware(files, variant) {
  const candidates = files.filter((file) => {
    const name = basename(file);
    return name.endsWith('.bin') && !name.includes('boot2') && !name.includes('partition');
  });
  if (variant === 'hs') {
    return candidates.find((file) => /hs/i.test(basename(file))) || null;
  }

  return candidates.find((file) => !/hs/i.test(basename(file))) || null;
}

function pickByPattern(files, pattern) {
  return files.find((file) => pattern.test(basename(file))) || null;
}

export function buildFlashManifest(files, variant) {
  const normalized = files.map((file) => (typeof file === 'string' ? { relativePath: file } : file));
  const firmware = chooseFirmware(normalized, variant);
  const boot2 = pickByPattern(normalized, /boot2.*\.bin$/i);
  const partition = pickByPattern(normalized, /(^|\/)partition\.bin$/i);
  const flashProg = pickByPattern(normalized, /flash_prog_cfg\.ini$/i);
  const partitionToml = pickByPattern(normalized, /partition_cfg_4m\.toml$/i);
  const partitionNoSecToml = pickByPattern(normalized, /partition_cfg_4m_nosec\.toml$/i);
  const readme = pickByPattern(normalized, /readme\.txt$/i);

  return {
    variant,
    firmware: firmware ? normalizePath(firmware) : null,
    boot2: boot2 ? normalizePath(boot2) : null,
    partition: partition ? normalizePath(partition) : null,
    flashProgConfig: flashProg ? normalizePath(flashProg) : null,
    partitionToml: partitionToml ? normalizePath(partitionToml) : null,
    partitionNoSecToml: partitionNoSecToml ? normalizePath(partitionNoSecToml) : null,
    readme: readme ? normalizePath(readme) : null,
  };
}

async function listFilesRecursive(rootDir, currentDir = rootDir) {
  const entries = await fs.readdir(currentDir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const abs = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listFilesRecursive(rootDir, abs));
      continue;
    }

    const stat = await fs.stat(abs);
    files.push({
      name: entry.name,
      relativePath: path.relative(rootDir, abs).replace(/\\/g, '/'),
      size: stat.size,
    });
  }

  return files;
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function cacheExists(manifestPath) {
  try {
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    return manifest && manifest.packageId;
  } catch {
    return false;
  }
}

export async function prepareReleasePackage({ config, tag, variant, env = process.env, log = () => {}, progress = () => {} }) {
  const releases = await fetchReleases(config, env);
  const release = releases.find((item) => item.tagName === tag);
  if (!release) {
    throw new Error(`Release ${tag} not found`);
  }

  if (!release.asset || (!release.asset.downloadUrl && !release.asset.apiUrl)) {
    throw new Error(`Release ${tag} does not have a zip asset`);
  }

  const packageId = [
    safeSegment(config.owner),
    safeSegment(config.repo),
    safeSegment(release.tagName),
    safeSegment(variant),
    safeSegment(release.asset.id),
  ].join('__');

  const packageDir = path.join(config.dataDir, 'packages', packageId);
  const extractDir = path.join(packageDir, 'extract');
  const zipPath = path.join(packageDir, 'asset.zip');
  const manifestPath = path.join(packageDir, 'manifest.json');
  const ready = await cacheExists(manifestPath);

  if (ready) {
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    progress(100, 'Package loaded from cache');
    return manifest;
  }

  await ensureDir(packageDir);
  await fs.rm(extractDir, { recursive: true, force: true });
  await ensureDir(extractDir);

  log(`Selected ${release.tagName} / ${release.asset.name}`);
  progress(8, 'Downloading zip asset');

  const response = await githubFetch(release.asset.apiUrl || release.asset.downloadUrl, env, {
    redirect: 'follow',
    accept: 'application/octet-stream',
  });
  const total = Number(response.headers.get('content-length') || 0);
  let downloaded = 0;

  const tracker = new Transform({
    transform(chunk, enc, callback) {
      downloaded += chunk.length;
      if (total > 0) {
        const pct = Math.min(72, 8 + Math.round((downloaded / total) * 64));
        progress(pct, `Downloaded ${downloaded} of ${total} bytes`);
      } else {
        progress(20, `Downloaded ${downloaded} bytes`);
      }
      callback(null, chunk);
    },
  });

  await pipeline(
    Readable.fromWeb(response.body),
    tracker,
    createWriteStream(zipPath),
  );

  progress(78, 'Extracting package');
  await extractZip(zipPath, { dir: extractDir });

  progress(90, 'Indexing files');
  const files = await listFilesRecursive(extractDir);
  const flashManifest = buildFlashManifest(files, variant);
  const serializableFiles = files.map((file) => toSerializableFile(file, packageId));

  const manifest = {
    packageId,
    owner: config.owner,
    repo: config.repo,
    tagName: release.tagName,
    releaseName: release.name,
    publishedAt: release.publishedAt,
    variant,
    asset: release.asset,
    files: serializableFiles,
    flashManifest,
    selectedFiles: {
      boot2: flashManifest.boot2 ? serializableFiles.find((file) => file.relativePath === flashManifest.boot2) || null : null,
      partition: flashManifest.partition ? serializableFiles.find((file) => file.relativePath === flashManifest.partition) || null : null,
      firmware: flashManifest.firmware ? serializableFiles.find((file) => file.relativePath === flashManifest.firmware) || null : null,
      flashProgConfig: flashManifest.flashProgConfig ? serializableFiles.find((file) => file.relativePath === flashManifest.flashProgConfig) || null : null,
      partitionToml: flashManifest.partitionToml ? serializableFiles.find((file) => file.relativePath === flashManifest.partitionToml) || null : null,
      partitionNoSecToml: flashManifest.partitionNoSecToml ? serializableFiles.find((file) => file.relativePath === flashManifest.partitionNoSecToml) || null : null,
      readme: flashManifest.readme ? serializableFiles.find((file) => file.relativePath === flashManifest.readme) || null : null,
    },
    warnings: [],
  };

  for (const [key, value] of Object.entries(manifest.selectedFiles)) {
    if (!value) {
      manifest.warnings.push(`Missing ${key}`);
    }
  }

  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  progress(100, 'Package ready');

  return manifest;
}
