/**
 * vaultHandlers — IPC handlers for the new VaultManager (multi-provider vaults).
 *
 * These are NEW channels that complement the existing vault:* channels in ipc-handlers.ts.
 * The existing channels continue to work for legacy vaults.
 */

import { ipcMain, dialog } from 'electron';
import { VaultManager } from '../vault/VaultManager';
import { TokenStore } from '../auth/TokenStore';
import { ManifestManager } from '../core/ManifestManager';
import type { VaultConfig } from '../vault/VaultConfig';
import { createLogger } from '../utils/logger.util';

const logger = createLogger('VaultHandlers');

export function registerVaultHandlers(
  vaultManager: VaultManager,
  tokenStore: TokenStore,
  manifestManager: ManifestManager,
): void {

  /** List all vaults managed by the new VaultManager. */
  ipcMain.handle('vault:list-v2', async () => {
    return { success: true, data: vaultManager.list() };
  });

  /** Add a new vault with provider configuration. */
  ipcMain.handle('vault:add-v2', async (_event, localPath: string, providerId: string, providerConfig: VaultConfig['providerConfig'], syncOptions: Partial<VaultConfig['syncOptions']>) => {
    try {
      const vault = vaultManager.add(localPath, providerId, providerConfig, syncOptions);
      return { success: true, data: vault };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : 'Failed to add vault' };
    }
  });

  /** Update vault configuration. */
  ipcMain.handle('vault:update', async (_event, vaultId: string, partial: Partial<VaultConfig>) => {
    try {
      const vault = vaultManager.update(vaultId, partial);
      return { success: true, data: vault };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : 'Failed to update vault' };
    }
  });

  /** Remove a vault and clean up its credentials and manifest. */
  ipcMain.handle('vault:remove-v2', async (_event, vaultId: string) => {
    try {
      const vault = vaultManager.getById(vaultId);
      if (vault) {
        tokenStore.deleteAllForVault(vaultId);
        manifestManager.deleteLocal(vaultId);
      }
      vaultManager.remove(vaultId);
      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : 'Failed to remove vault' };
    }
  });

  /** Get a single vault by ID. */
  ipcMain.handle('vault:get', async (_event, vaultId: string) => {
    const vault = vaultManager.getById(vaultId);
    if (!vault) return { success: false, error: 'Vault not found' };
    return { success: true, data: vault };
  });
}
