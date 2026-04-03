import { ipcMain, dialog, BrowserWindow } from 'electron';
import { IPC } from '../config/ipc-channels';
import type { IpcResponse } from '../models/app-state.model';
import type { GitHubCredentials } from '../models/github.model';
import type { VaultService } from '../services/vault.service';
import type { GitHubService } from '../services/github.service';
import type { SyncService } from '../services/sync.service';
import type { StorageService } from '../services/storage.service';
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
    // Return config WITHOUT the encrypted token
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
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) return reply(false, undefined, 'No window');
    const result = await syncService.push(vaultId, window);
    return reply(result.success, result, result.success ? undefined : result.message);
  });

  ipcMain.handle(IPC.SYNC_PULL, async (event, vaultId: string) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) return reply(false, undefined, 'No window');
    const result = await syncService.pull(vaultId, window);
    return reply(result.success, result, result.success ? undefined : result.message);
  });

  ipcMain.handle(IPC.SYNC_STATUS, async (_event, vaultId: string) => {
    return reply(true, syncService.getStatus(vaultId));
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
