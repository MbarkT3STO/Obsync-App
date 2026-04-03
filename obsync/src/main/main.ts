import { app, BrowserWindow } from 'electron';
import path from 'path';
import { StorageService } from '../services/storage.service';
import { VaultService } from '../services/vault.service';
import { GitHubService } from '../services/github.service';
import { SyncService } from '../services/sync.service';
import { HistoryService } from '../services/history.service';
import { AutoSyncService } from '../services/autosync.service';
import { TrayManager } from './tray';
import { registerIpcHandlers } from './ipc-handlers';
import { createLogger } from '../utils/logger.util';

const logger = createLogger('Main');

// ── Composition root ───────────────────────────────────────────────────────
const storageService  = new StorageService();
const vaultService    = new VaultService(storageService);
const githubService   = new GitHubService(storageService);
const syncService     = new SyncService(vaultService, githubService);
const historyService  = new HistoryService(vaultService, githubService);
const autoSyncService = new AutoSyncService(storageService, vaultService, syncService);

let mainWindow: BrowserWindow | null = null;
let trayManager: TrayManager | null = null;
let isQuitting = false;

// ── Login item (auto-start) ────────────────────────────────────────────────
export function applyLoginItemSetting(enabled: boolean): void {
  if (process.platform === 'linux') return; // not supported on Linux via this API

  app.setLoginItemSettings({
    openAtLogin: enabled,
    openAsHidden: storageService.load().settings.startMinimized,
    // On Windows, point to the actual exe
    ...(process.platform === 'win32' ? { path: process.execPath } : {}),
  });

  logger.info(`Launch on startup: ${enabled}`);
}

// ── Window ─────────────────────────────────────────────────────────────────
function createWindow(): BrowserWindow {
  const settings = storageService.load().settings;

  const win = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 800,
    minHeight: 560,
    backgroundColor: '#0e0e16',
    titleBarStyle: 'default',
    frame: true,
    show: !settings.startMinimized,
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.loadFile(path.join(__dirname, '../../../src/renderer/index.html'));

  // Minimize to tray instead of closing
  win.on('close', (e) => {
    const cfg = storageService.load().settings;
    if (!isQuitting && cfg.minimizeToTray) {
      e.preventDefault();
      win.hide();
      trayManager?.updateMenu();
    }
  });

  win.webContents.once('did-finish-load', async () => {
    // Restore auto-sync watchers
    autoSyncService.restoreAll(win);

    // Sync on startup
    const cfg = storageService.load();
    if (cfg.settings.syncOnStartup) {
      await runStartupPull(win);
    }
  });

  mainWindow = win;
  return win;
}

async function runStartupPull(win: BrowserWindow): Promise<void> {
  const vaults = vaultService.list();
  const config = storageService.load();
  const results: Array<{ name: string; success: boolean; message: string }> = [];

  logger.info(`Startup pull: ${vaults.length} vault(s)`);

  for (const vault of vaults) {
    if (!config.githubConfigs[vault.id]) continue;
    const result = await syncService.pull(vault.id, win);
    results.push({ name: vault.name, success: result.success, message: result.message });
  }

  win.webContents.send('event:startup-pull-done', results);
}

// ── App lifecycle ──────────────────────────────────────────────────────────
app.whenReady().then(() => {
  // Apply auto-start setting from persisted config
  const cfg = storageService.load();
  applyLoginItemSetting(cfg.settings.launchOnStartup ?? true);
  registerIpcHandlers(
    vaultService, githubService, syncService,
    storageService, historyService, autoSyncService,
    () => mainWindow,
  );

  const win = createWindow();

  // Create tray
  trayManager = new TrayManager(vaultService, syncService, storageService, () => mainWindow);
  trayManager.create();

  // If startMinimized, show tray notification
  const settings = storageService.load().settings;
  if (settings.startMinimized) {
    trayManager.updateMenu();
  }

  logger.info('Obsync started');

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else mainWindow?.show();
  });
});

app.on('before-quit', () => {
  isQuitting = true;
});

app.on('window-all-closed', () => {
  autoSyncService.stopAll();
  trayManager?.destroy();
  if (process.platform !== 'darwin') app.quit();
});
