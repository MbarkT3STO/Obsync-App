/**
 * syncHandlers — new IPC handlers for multi-provider sync operations.
 *
 * These ADD new channels without removing any existing ones.
 * Existing channels (sync:push, sync:pull, etc.) remain in ipc-handlers.ts.
 */

import { ipcMain, BrowserWindow } from 'electron';
import { PROVIDER_METADATA, createProvider, getProviderMeta } from '../providers/ProviderRegistry';
import { SyncEngine } from '../core/SyncEngine';
import { TokenStore } from '../auth/TokenStore';
import { VaultManager } from '../vault/VaultManager';
import { buildIgnorePatterns } from '../core/ObsidianIgnorePatterns';
import type { ProviderCredentials } from '../providers/SyncProvider';
import type { BaseGitProvider } from '../providers/git/BaseGitProvider';
import type { GoogleDriveProvider } from '../providers/cloud/GoogleDriveProvider';
import type { OneDriveProvider } from '../providers/cloud/OneDriveProvider';
import type { DropboxProvider } from '../providers/cloud/DropboxProvider';
import { IPC } from '../config/ipc-channels';
import { createLogger } from '../utils/logger.util';
import os from 'os';
import crypto from 'crypto';

const logger = createLogger('SyncHandlers');

/** Stable device ID — SHA-256 of hostname + platform, cached in memory. */
function getDeviceId(): string {
  return crypto
    .createHash('sha256')
    .update(`${os.hostname()}:${process.platform}`)
    .digest('hex')
    .slice(0, 16);
}

export function registerSyncHandlers(
  vaultManager: VaultManager,
  tokenStore: TokenStore,
  syncEngine: SyncEngine,
  getWindow: () => BrowserWindow | null,
): void {

  // ── Provider discovery ────────────────────────────────────────────────────

  /** Returns metadata for all available providers (safe for renderer). */
  ipcMain.handle('sync:get-providers', async () => {
    return { success: true, data: PROVIDER_METADATA };
  });

  // ── Provider connection ───────────────────────────────────────────────────

  /** Connect a vault to a provider and store credentials. */
  ipcMain.handle('sync:connect-provider', async (_event, vaultId: string, providerId: string, credentials: ProviderCredentials) => {
    try {
      tokenStore.save(vaultId, providerId, credentials);
      // Update vault config with the new provider
      const vault = vaultManager.getById(vaultId);
      if (vault) {
        vaultManager.update(vaultId, { providerId });
      }
      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : 'Failed to connect' };
    }
  });

  /** Remove credentials for a vault+provider. */
  ipcMain.handle('sync:disconnect-provider', async (_event, vaultId: string, providerId: string) => {
    try {
      tokenStore.delete(vaultId, providerId);
      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : 'Failed to disconnect' };
    }
  });

  /** Test connectivity for a vault's configured provider. */
  ipcMain.handle('sync:test-connection', async (_event, vaultId: string) => {
    try {
      const vault = vaultManager.getById(vaultId);
      if (!vault) return { success: false, error: 'Vault not found' };

      const creds = tokenStore.load(vaultId, vault.providerId);
      if (!creds) return { success: false, error: 'No credentials stored — please connect first' };

      const provider = createProvider(vault.providerId);
      await provider.connect(creds);
      const ok = await provider.testConnection();
      await provider.disconnect();
      return { success: ok, error: ok ? undefined : 'Connection test failed' };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : 'Test failed' };
    }
  });

  /** Returns which provider a vault is configured to use. */
  ipcMain.handle('sync:get-vault-provider', async (_event, vaultId: string) => {
    const vault = vaultManager.getById(vaultId);
    if (!vault) return { success: false, error: 'Vault not found' };
    const meta = getProviderMeta(vault.providerId);
    return { success: true, data: meta };
  });

  // ── Sync engine operations ────────────────────────────────────────────────

  /**
   * Full bidirectional sync via the new SyncEngine.
   * Emits progress events to the renderer window.
   */
  ipcMain.handle('sync:run', async (event, vaultId: string) => {
    const win = BrowserWindow.fromWebContents(event.sender) ?? getWindow();

    try {
      const vault = vaultManager.getById(vaultId);
      if (!vault) return { success: false, error: 'Vault not found' };

      const creds = tokenStore.load(vaultId, vault.providerId);
      if (!creds) return { success: false, error: 'No credentials — please connect a provider first' };

      const provider = createProvider(vault.providerId);

      // Wire token refresh persistence
      provider.onTokenRefreshed = (newTokenJson: string) => {
        const updated: ProviderCredentials = { ...creds, token: newTokenJson };
        tokenStore.save(vaultId, vault.providerId, updated);
        win?.webContents.send(IPC.EVENT_TOKEN_REFRESHED, { vaultId });
      };

      // Set vault path / name on the provider
      if (provider.type === 'git') {
        (provider as BaseGitProvider).setVaultPath(vault.localPath);
      } else {
        const folderName = vault.providerConfig.remoteFolderName ?? vault.name;
        (provider as GoogleDriveProvider | OneDriveProvider | DropboxProvider).setVaultName(folderName);
      }

      await provider.connect(creds);

      // Forward progress events to renderer
      const onProgress = (data: unknown) => win?.webContents.send(IPC.EVENT_SYNC_PROGRESS, data);
      syncEngine.on('progress', onProgress);

      const ignorePatterns = buildIgnorePatterns(
        vault.syncOptions.ignorePatterns,
        vault.syncOptions.syncObsidianConfig,
      );

      const result = await syncEngine.sync(
        vaultId,
        vault.localPath,
        provider,
        getDeviceId(),
        {
          conflictStrategy: vault.syncOptions.conflictStrategy,
          ignorePatterns,
        },
      );

      syncEngine.off('progress', onProgress);
      await provider.disconnect();

      vaultManager.updateLastSync(vaultId);

      win?.webContents.send(IPC.EVENT_SYNC_COMPLETE, { vaultId, result });
      return { success: true, data: result };
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Sync failed';
      logger.error(`sync:run failed for ${vaultId}:`, err);
      return { success: false, error: msg };
    }
  });
}
