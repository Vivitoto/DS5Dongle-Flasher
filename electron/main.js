import { app, BrowserWindow } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../server.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
let serverHandle = null;

async function startDesktopServer() {
  if (serverHandle) {
    return serverHandle;
  }

  const userDataDir = path.join(app.getPath('userData'), 'data');
  await fs.mkdir(userDataDir, { recursive: true });
  process.env.DATA_DIR = userDataDir;

  serverHandle = await startServer({
    host: '127.0.0.1',
    port: 0,
    env: process.env,
  });

  return serverHandle;
}

async function createWindow() {
  const { port } = await startDesktopServer();
  const win = new BrowserWindow({
    width: 1440,
    height: 940,
    backgroundColor: '#0f1720',
    title: 'DS5Dongle Flasher',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  await win.loadURL(`http://127.0.0.1:${port}`);

  win.on('closed', () => {
    if (serverHandle?.server && !serverHandle.server.listening) {
      serverHandle = null;
    }
  });
}

app.setName('DS5Dongle Flasher');

app.whenReady().then(async () => {
  await createWindow();

  app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    if (serverHandle?.server) {
      serverHandle.server.close();
      serverHandle = null;
    }
    app.quit();
  }
});
