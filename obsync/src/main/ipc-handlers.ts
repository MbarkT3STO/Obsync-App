import { ipcMain, dialog, BrowserWindow } from 'electron';
import { IPC } from '../config/ipc-channels';
import type { IpcResponse, AppSettings } from '../models/app-state.model';
import type { GitHubCredentials } from '../models/github.model';
import type { AutoSyncConfig } from '../models/history.model';
import type { VaultService } from '../services/vault.service';
import type { GitHubService } from '../services/github.service';
import type { SyncService } from '../services/sync.service';
import type { StorageService } from '../services/storage.service';
import type { HistoryService } from '../services/history.service';
import type { AutoSyncService } from '../services/autosync.service';
import { createLogger } from '../utils/logger.util';

const logger = createLogger('IpcHandlers');

function reply<T>(success: boolean, data?: T, error?: string): IpcResponse<T> {
  return { success, data, error };
}

export function registerIpcHandlers(
  vaultService: VaultService,
  githubService: GitHubService,
  syncService: SyncService,
  storageService: StorageService,
  historyService: HistoryService,
  autoSyncService: AutoSyncService,
  getWindow: () => BrowserWindow | null,
): void {

  // ── Vault ──────────────────────────────────────────────────────────────────

  ipcMain.handle(IPC.VAULT_SELECT_FOLDER, async () => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'] });
    if (result.canceled || result.filePaths.length === 0) return reply(false, null, 'Cancelled');
    return reply(true, result.filePaths[0]);
  });

  ipcMain.handle(IPC.VAULT_ADD, async (_event, localPath: string) => {
    try {
      const vault = vaultService.add(localPath);
      return reply(true, vault);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to add vault';
      logger.error(msg);
      return reply(false, undefined, msg);
    }
  });

  ipcMain.handle(IPC.VAULT_REMOVE, async (_event, vaultId: string) => {
    try {
      autoSyncService.stopWatcher(vaultId);
      vaultService.remove(vaultId);
      return reply(true);
    } catch (err) {
      return reply(false, undefined, err instanceof Error ? err.message : 'Failed');
    }
  });

  ipcMain.handle(IPC.VAULT_LIST, async () => {
    return reply(true, vaultService.list());
  });

  // ── GitHub ─────────────────────────────────────────────────────────────────

  ipcMain.handle(IPC.GITHUB_SAVE_CONFIG, async (_event, vaultId: string, credentials: GitHubCredentials) => {
    try {
      githubService.saveConfig(vaultId, credentials);
      return reply(true);
    } catch (err) {
      return reply(false, undefined, err instanceof Error ? err.message : 'Failed to save');
    }
  });

  ipcMain.handle(IPC.GITHUB_GET_CONFIG, async (_event, vaultId: string) => {
    const config = githubService.getConfig(vaultId);
    if (!config) return reply(false, undefined, 'No config found');
    return reply(true, { repoUrl: config.repoUrl, branch: config.branch });
  });

  ipcMain.handle(IPC.GITHUB_VALIDATE, async (_event, credentials: GitHubCredentials) => {
    const valid = await githubService.validate(credentials);
    return reply(valid, valid, valid ? undefined : 'Invalid credentials or repository');
  });

  // ── Sync ───────────────────────────────────────────────────────────────────

  ipcMain.handle(IPC.SYNC_INIT, async (_event, vaultId: string) => {
    const result = await syncService.initRepo(vaultId);
    return reply(result.success, result, result.success ? undefined : result.message);
  });

  ipcMain.handle(IPC.SYNC_PUSH, async (event, vaultId: string) => {
    const win = BrowserWindow.fromWebContents(event.sender) ?? getWindow();
    if (!win) return reply(false, undefined, 'No window');
    const result = await syncService.push(vaultId, win);
    return reply(result.success, result, result.success ? undefined : result.message);
  });

  ipcMain.handle(IPC.SYNC_PULL, async (event, vaultId: string) => {
    const win = BrowserWindow.fromWebContents(event.sender) ?? getWindow();
    if (!win) return reply(false, undefined, 'No window');
    const result = await syncService.pull(vaultId, win);
    return reply(result.success, result, result.success ? undefined : result.message);
  });

  ipcMain.handle(IPC.SYNC_STATUS, async (_event, vaultId: string) => {
    return reply(true, syncService.getStatus(vaultId));
  });

  ipcMain.handle(IPC.SYNC_ALL_PULL, async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender) ?? getWindow();
    if (!win) return reply(false, undefined, 'No window');
    const vaults = vaultService.list();
    const config = storageService.load();
    const results = [];
    for (const vault of vaults) {
      if (!config.githubConfigs[vault.id]) continue;
      const r = await syncService.pull(vault.id, win);
      results.push({ vaultId: vault.id, name: vault.name, ...r });
    }
    return reply(true, results);
  });

  // ── History ────────────────────────────────────────────────────────────────

  ipcMain.handle(IPC.HISTORY_GET, async (_event, vaultId: string, limit: number) => {
    const commits = await historyService.getCommits(vaultId, limit ?? 30);
    return reply(true, commits);
  });

  ipcMain.handle(IPC.HISTORY_GET_DIFF, async (_event, vaultId: string, filePath: string) => {
    const diff = await historyService.getFileDiff(vaultId, filePath);
    if (!diff) return reply(false, undefined, 'Could not get diff');
    return reply(true, diff);
  });

  // ── Auto-sync ──────────────────────────────────────────────────────────────

  ipcMain.handle(IPC.AUTOSYNC_SET, async (event, vaultId: string, config: AutoSyncConfig) => {
    const win = BrowserWindow.fromWebContents(event.sender) ?? getWindow();
    autoSyncService.setConfig(vaultId, config);
    if (config.enabled && win) {
      autoSyncService.startWatcher(vaultId, win);
    } else {
      autoSyncService.stopWatcher(vaultId);
    }
    return reply(true);
  });

  ipcMain.handle(IPC.AUTOSYNC_GET, async (_event, vaultId: string) => {
    const config = autoSyncService.getConfig(vaultId);
    return reply(true, config ?? { enabled: false, debounceSeconds: 30 });
  });

  // ── Settings ───────────────────────────────────────────────────────────────

  ipcMain.handle(IPC.SETTINGS_GET, async () => {
    const cfg = storageService.load();
    return reply(true, cfg.settings);
  });

  ipcMain.handle(IPC.SETTINGS_SET, async (_event, settings: Partial<AppSettings>) => {
    const cfg = storageService.load();
    storageService.update({ settings: { ...cfg.settings, ...settings } });
    return reply(true);
  });

  // ── Theme ──────────────────────────────────────────────────────────────────

  ipcMain.handle(IPC.THEME_GET, async () => {
    return reply(true, storageService.load().theme);
  });

  ipcMain.handle(IPC.THEME_SET, async (_event, theme: 'dark' | 'light') => {
    storageService.update({ theme });
    return reply(true);
  });
}
