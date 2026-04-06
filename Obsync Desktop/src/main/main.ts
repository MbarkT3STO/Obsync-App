import { app, BrowserWindow, Menu } from 'electron';
import * as dotenv from 'dotenv';
import path from 'path';

// Load environment variables from .env file
dotenv.config();

import { StorageService } from '../services/storage.service';
import { VaultService } from '../services/vault.service';
import { CloudProviderService } from '../services/cloud-provider.service';
import { HistoryService } from '../services/history.service';
import { OAuthService } from '../services/oauth.service';
import { GitSyncService } from '../services/git-sync.service';
import { TrayManager } from './tray';
import { registerIpcHandlers } from './ipc-handlers';
import { createLogger } from '../utils/logger.util';
import { IPC } from '../config/ipc-channels';

// ── New multi-provider architecture ───────────────────────────────────────
import { VaultManager } from '../vault/VaultManager';
import { TokenStore } from '../auth/TokenStore';
import { OAuthManager } from '../auth/OAuthManager';
import { SyncEngine } from '../core/SyncEngine';
import { ManifestManager } from '../core/ManifestManager';
import { registerSyncHandlers } from '../ipc/syncHandlers';
import { registerVaultHandlers } from '../ipc/vaultHandlers';
import { registerOAuthHandlers } from '../ipc/oauthHandlers';
import { registerAutoSyncHandlers } from '../ipc/autoSyncHandlers';
import { AutoSyncEngine } from '../core/AutoSyncEngine';

const logger = createLogger('Main');

// ── Composition root ───────────────────────────────────────────────────────
const storageService  = new StorageService();
const vaultService    = new VaultService(storageService);
const cloudProvider   = new CloudProviderService(storageService);
const historyService  = new HistoryService(vaultService, cloudProvider);
const gitSyncService  = new GitSyncService(vaultService, cloudProvider, historyService, storageService);
const oauthService    = new OAuthService();

// ── New multi-provider composition root ───────────────────────────────────
const tokenStore      = new TokenStore();
const vaultManager    = new VaultManager();
const manifestManager = new ManifestManager();
const syncEngine      = new SyncEngine();
const oauthManager    = new OAuthManager(tokenStore);
const autoSyncEngine  = new AutoSyncEngine(syncEngine, vaultManager, tokenStore);

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
    icon: path.join(__dirname, '../../../assets/icon.png'),
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'), 
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: true, // throttle timers/animations when window is hidden
    },
  });

  win.loadFile(path.join(__dirname, '../../../src/renderer/index.html'));

  // Block all DevTools access — keyboard shortcuts and programmatic open
  win.webContents.on('before-input-event', (_event, input) => {
    const ctrl = input.control || input.meta;
    if (
      input.key === 'F12' ||
      (ctrl && input.shift && (input.key === 'I' || input.key === 'i')) ||
      (ctrl && input.shift && (input.key === 'J' || input.key === 'j')) ||
      (ctrl && input.shift && (input.key === 'C' || input.key === 'c'))
    ) {
      _event.preventDefault();
    }
  });

  // Respect startMinimized — only show the window if not starting to tray
  if (!settings.startMinimized) {
    win.show();
  }

  win.on('close', (e) => {
    const cfg = storageService.load().settings;
    if (!isQuitting && cfg.minimizeToTray) {
      e.preventDefault();
      win.hide();
      trayManager?.updateMenu();
    }
  });

  win.webContents.once('did-finish-load', async () => {
    // Restore auto-sync watchers using new git-based service
    gitSyncService.restoreAll(win);

    // Restore new multi-provider auto-sync watchers
    for (const vault of vaultManager.list()) {
      if (vault.syncOptions.autoSync) {
        autoSyncEngine.start(vault.id);
      }
    }

    // Update tray whenever auto-sync completes so last-sync time stays fresh
    win.webContents.on('ipc-message', (_e, channel) => {
      if (channel === IPC.EVENT_AUTOSYNC_TRIGGERED) {
        trayManager?.updateMenu();
      }
    });

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
    if (!config.cloudConfigs[vault.id]) continue;
    const result = await gitSyncService.pull(vault.id, win);
    results.push({ name: vault.name, success: result.success, message: result.message });
  }

  win.webContents.send('event:startup-pull-done', results);
}

// ── App lifecycle ──────────────────────────────────────────────────────────
app.whenReady().then(() => {
  // Hint to the OS that this is a background utility — reduces scheduling priority
  // when the window is hidden, which lowers CPU/battery impact.
  try { app.setAppUserModelId('com.obsync.app'); } catch { /* non-Windows */ }

  // Disable default menu
  Menu.setApplicationMenu(null);

  // Apply auto-start setting from persisted config
  const cfg = storageService.load();
  applyLoginItemSetting(cfg.settings.launchOnStartup ?? true);
  registerIpcHandlers(
    vaultService, cloudProvider,
    storageService, historyService,
    oauthService,
    () => mainWindow,
    gitSyncService,
    () => trayManager,
  );

  // Register new multi-provider IPC handlers
  registerSyncHandlers(vaultManager, tokenStore, syncEngine, () => mainWindow);
  registerVaultHandlers(vaultManager, tokenStore, manifestManager);
  registerOAuthHandlers(oauthManager, tokenStore);
  registerAutoSyncHandlers(autoSyncEngine, vaultManager, () => mainWindow);

  const win = createWindow();

  // Create tray
  trayManager = new TrayManager(vaultService, gitSyncService, storageService, () => mainWindow);
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
  gitSyncService.stopAll();
  autoSyncEngine.stopAll();
  trayManager?.destroy();
  if (process.platform !== 'darwin') app.quit();
});
