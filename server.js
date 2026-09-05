import express from 'express';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveRepoConfig, fetchReleases, prepareReleasePackage } from './src/github.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, 'public');
const app = express();
const config = resolveRepoConfig(process.env);

app.use(express.json({ limit: '256kb' }));

app.use((req, res, next) => {
  const started = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - started;
    const line = `${new Date().toISOString()} ${req.method} ${req.originalUrl} ${res.statusCode} ${ms}ms`;
    process.stdout.write(`${line}\n`);
  });
  next();
});

app.use(express.static(publicDir, { extensions: ['html'] }));

app.get('/api/config', (req, res) => {
  res.json({
    owner: config.owner,
    repo: config.repo,
    dataDir: config.dataDir,
    port: config.port,
  });
});

app.get('/api/releases', async (req, res) => {
  try {
    const releases = await fetchReleases(config, process.env);
    res.json({ releases });
  } catch (error) {
    res.status(502).json({ error: error instanceof Error ? error.message : 'Failed to fetch releases' });
  }
});

app.get('/api/releases/:tag/prepare/stream', async (req, res) => {
  const tag = decodeURIComponent(req.params.tag);
  const variant = String(req.query.variant || 'std').toLowerCase() === 'hs' ? 'hs' : 'std';

  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const emit = (event, payload) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  const log = (message) => emit('log', { message });
  const progress = (value, message) => emit('progress', { value, message });

  try {
    const prepared = await prepareReleasePackage({
      config,
      tag,
      variant,
      env: process.env,
      log,
      progress,
    });

    emit('ready', prepared);
    res.end();
  } catch (error) {
    emit('error', { message: error instanceof Error ? error.message : 'Failed to prepare release' });
    res.end();
  }
});

app.get('/api/packages/:packageId', async (req, res) => {
  const packageId = req.params.packageId;
  const manifestPath = path.join(config.dataDir, 'packages', packageId, 'manifest.json');

  try {
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    res.json(manifest);
  } catch {
    res.status(404).json({ error: 'Package not found' });
  }
});

app.get('/api/packages/:packageId/file', async (req, res) => {
  const packageId = req.params.packageId;
  const relativePath = String(req.query.path || '');

  if (!relativePath) {
    res.status(400).json({ error: 'Missing path' });
    return;
  }

  try {
    const baseDir = path.join(config.dataDir, 'packages', packageId, 'extract');
    const absPath = path.resolve(baseDir, relativePath);
    if (!absPath.startsWith(path.resolve(baseDir) + path.sep) && absPath !== path.resolve(baseDir)) {
      res.status(400).json({ error: 'Invalid path' });
      return;
    }

    await fs.access(absPath);
    res.download(absPath, path.basename(absPath));
  } catch {
    res.status(404).json({ error: 'File not found' });
  }
});

app.get('*', async (req, res, next) => {
  if (req.path.startsWith('/api/')) {
    next();
    return;
  }

  const indexPath = path.join(publicDir, 'index.html');
  const stream = createReadStream(indexPath);
  stream.on('error', next);
  res.type('html');
  stream.pipe(res);
});

const port = config.port;

app.listen(port, () => {
  process.stdout.write(`DS5Dongle Flasher listening on http://0.0.0.0:${port}\n`);
});
