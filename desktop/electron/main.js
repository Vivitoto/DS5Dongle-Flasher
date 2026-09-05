import { app, BrowserWindow, session } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../server.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let serverHandle = null;
let mainWindow = null;

async function ensureDesktopDataDir() {
  const dataDir = path.join(app.getPath('userData'), 'data');
  await fs.mkdir(dataDir, { recursive: true });
  process.env.DATA_DIR = dataDir;
  return dataDir;
}

async function startDesktopServer() {
  if (serverHandle) return serverHandle;
  await ensureDesktopDataDir();
  serverHandle = await startServer({
    host: '127.0.0.1',
    port: 0,
    env: process.env,
    proxyResolver: (url) => session.defaultSession.resolveProxy(url),
  });
  return serverHandle;
}

async function createWindow() {
  const { port } = await startDesktopServer();
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 980,
    minWidth: 1220,
    minHeight: 820,
    backgroundColor: '#081018',
    title: 'DS5Dongle Flasher',
    autoHideMenuBar: true,
    vibrancy: 'under-window',
    titleBarStyle: 'hiddenInset',
    roundedCorners: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: true,
    },
  });

  await mainWindow.loadURL(`http://127.0.0.1:${port}`);
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

async function shutdown() {
  if (serverHandle?.server) {
    await new Promise((resolve) => serverHandle.server.close(resolve));
    serverHandle = null;
  }
}

app.setName('DS5Dongle Flasher');
app.setAppUserModelId('com.nousresearch.ds5dongleflasher.desktop');

app.whenReady().then(async () => {
  await createWindow();
  app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await createWindow();
    }
  });
}).catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  app.quit();
});

app.on('window-all-closed', async () => {
  if (process.platform !== 'darwin') {
    await shutdown();
    app.quit();
  }
});

process.on('SIGINT', async () => {
  await shutdown();
  process.exit(0);
});
