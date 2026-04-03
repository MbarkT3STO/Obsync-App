import { app, BrowserWindow } from 'electron';
import path from 'path';
import { StorageService } from '../services/storage.service';
import { VaultService } from '../services/vault.service';
import { GitHubService } from '../services/github.service';
import { SyncService } from '../services/sync.service';
import { registerIpcHandlers } from './ipc-handlers';
import { createLogger } from '../utils/logger.util';

const logger = createLogger('Main');

// Dependency injection composition root
const storageService = new StorageService();
const vaultService = new VaultService(storageService);
const githubService = new GitHubService(storageService);
const syncService = new SyncService(vaultService, githubService);

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 800,
    minHeight: 560,
    backgroundColor: '#1a1a2e',
    titleBarStyle: 'default',
    frame: true,
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.loadFile(path.join(__dirname, '../../../src/renderer/index.html'));
  win.webContents.openDevTools();

  return win;
}

app.whenReady().then(() => {
  registerIpcHandlers(vaultService, githubService, syncService, storageService);
  createWindow();
  logger.info('Obsync started');

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
