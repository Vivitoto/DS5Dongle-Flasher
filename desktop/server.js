import express from 'express';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  fetchReleases,
  prepareReleasePackage,
  resolveProxyStatus,
  resolveRepoConfig,
  resolveStorageConfig,
} from './src/github.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, 'public');

function createApp(config, env = process.env, proxyResolver = null) {
  const app = express();

  app.use(express.json({ limit: '256kb' }));
  app.use((req, res, next) => {
    const started = Date.now();
    res.on('finish', () => {
      const ms = Date.now() - started;
      process.stdout.write(`${new Date().toISOString()} ${req.method} ${req.originalUrl} ${res.statusCode} ${ms}ms\n`);
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
      userDataDir: config.userDataDir,
    });
  });

  app.get('/api/releases', async (req, res) => {
    try {
      const releases = await fetchReleases(config, env, proxyResolver);
      res.json({ releases });
    } catch (error) {
      res.status(502).json({ error: error instanceof Error ? error.message : 'Failed to fetch releases' });
    }
  });

  app.get('/api/proxy-status', async (req, res) => {
    try {
      const target = String(req.query.url || 'https://api.github.com');
      const status = await resolveProxyStatus(target, env, proxyResolver);
      res.json({ target, ...status });
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to resolve proxy status' });
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

    try {
      const prepared = await prepareReleasePackage({
        config,
        tag,
        variant,
        env,
        log: (message) => emit('log', { message }),
        progress: (value, message) => emit('progress', { value, message }),
        proxyResolver,
      });
      emit('ready', prepared);
    } catch (error) {
      emit('error', { message: error instanceof Error ? error.message : 'Failed to prepare release' });
    } finally {
      res.end();
    }
  });

  app.get('/api/packages/:packageId', async (req, res) => {
    const manifestPath = path.join(config.dataDir, 'packages', req.params.packageId, 'manifest.json');
    try {
      const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
      res.json(manifest);
    } catch {
      res.status(404).json({ error: 'Package not found' });
    }
  });

  app.post('/api/packages/:packageId/open', async (req, res) => {
    const packageId = req.params.packageId;
    const packageDir = path.join(config.dataDir, 'packages', packageId);
    try {
      await fs.access(packageDir);
      if (process.platform === 'win32') {
        const { spawn } = await import('node:child_process');
        spawn('explorer', [packageDir], { detached: true, stdio: 'ignore' }).unref();
      } else if (process.platform === 'darwin') {
        const { spawn } = await import('node:child_process');
        spawn('open', [packageDir], { detached: true, stdio: 'ignore' }).unref();
      } else {
        const { spawn } = await import('node:child_process');
        spawn('xdg-open', [packageDir], { detached: true, stdio: 'ignore' }).unref();
      }
      res.json({ ok: true, packageDir });
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
      const resolvedBase = path.resolve(baseDir);
      const absPath = path.resolve(baseDir, relativePath);
      if (absPath !== resolvedBase && !absPath.startsWith(`${resolvedBase}${path.sep}`)) {
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

  return app;
}

export async function startServer({ port, host = '127.0.0.1', env = process.env, proxyResolver = null } = {}) {
  const config = resolveRepoConfig(env);
  const storage = resolveStorageConfig(env, config);
  const resolvedConfig = { ...config, ...storage };
  const listenPort = Number.isFinite(Number(port)) ? Number(port) : config.port;
  const app = createApp(resolvedConfig, env, proxyResolver);

  const server = await new Promise((resolve, reject) => {
    const instance = app.listen(listenPort, host, () => resolve(instance));
    instance.on('error', reject);
  });

  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : listenPort;
  process.stdout.write(`DS5Dongle Flasher listening on http://${host}:${actualPort}\n`);
  return { app, server, config: resolvedConfig, port: actualPort };
}

const isDirectRun = (() => {
  if (!process.argv[1]) return false;
  return import.meta.url === pathToFileURL(process.argv[1]).href;
})();

if (isDirectRun) {
  startServer({ env: process.env }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

export { createApp };
