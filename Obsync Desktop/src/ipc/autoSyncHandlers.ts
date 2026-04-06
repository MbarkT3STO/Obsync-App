/**
 * autoSyncHandlers — IPC handlers for the new AutoSyncEngine.
 *
 * New channels (additive — legacy autosync:set / autosync:get untouched):
 *   autosync:start          → start watcher for a vault
 *   autosync:stop           → stop watcher
 *   autosync:pause          → pause without destroying watcher
 *   autosync:resume         → resume from paused
 *   autosync:force-now      → skip debounce, sync immediately
 *   autosync:status         → return current state for vaultId
 *   autosync:update-config  → hot-reload debounceMs / pollIntervalMs
 *   autosync:state-changed  → outbound event to renderer (not invokable)
 */

import { ipcMain, BrowserWindow } from 'electron';
import { AutoSyncEngine } from '../core/AutoSyncEngine';
import type { AutoSyncStateEvent, AutoSyncConfig } from '../core/AutoSyncEngine';
import { VaultManager } from '../vault/VaultManager';
import { IPC } from '../config/ipc-channels';
import { createLogger } from '../utils/logger.util';

const logger = createLogger('AutoSyncHandlers');

export function registerAutoSyncHandlers(
  autoSyncEngine: AutoSyncEngine,
  vaultManager: VaultManager,
  getWindow: () => BrowserWindow | null,
): void {

  // Forward state-changed events from the engine to the renderer
  autoSyncEngine.on('state-changed', (event: AutoSyncStateEvent) => {
    getWindow()?.webContents.send(IPC.AUTOSYNC_STATE_CHANGED, event);
  });

  /** Start the auto-sync watcher for a vault. */
  ipcMain.handle(IPC.AUTOSYNC_START, async (_event, vaultId: string) => {
    try {
      autoSyncEngine.start(vaultId);
      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : 'Failed to start' };
    }
  });

  /** Stop the auto-sync watcher for a vault. */
  ipcMain.handle(IPC.AUTOSYNC_STOP, async (_event, vaultId: string) => {
    try {
      autoSyncEngine.stop(vaultId);
      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : 'Failed to stop' };
    }
  });

  /** Pause syncing — keeps watcher alive but suppresses sync execution. */
  ipcMain.handle(IPC.AUTOSYNC_PAUSE, async (_event, vaultId: string) => {
    autoSyncEngine.pause(vaultId);
    return { success: true };
  });

  /** Resume from paused state. */
  ipcMain.handle(IPC.AUTOSYNC_RESUME, async (_event, vaultId: string) => {
    autoSyncEngine.resume(vaultId);
    return { success: true };
  });

  /** Skip debounce and sync immediately. */
  ipcMain.handle(IPC.AUTOSYNC_FORCE_NOW, async (_event, vaultId: string) => {
    try {
      await autoSyncEngine.forceNow(vaultId);
      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : 'Force sync failed' };
    }
  });

  /** Return the current auto-sync state for a vault. */
  ipcMain.handle(IPC.AUTOSYNC_STATUS, async (_event, vaultId: string) => {
    return { success: true, data: { state: autoSyncEngine.getState(vaultId) } };
  });

  /**
   * Hot-reload debounceMs and/or pollIntervalMs without restarting the watcher.
   * Also persists the new values to VaultConfig.
   */
  ipcMain.handle(IPC.AUTOSYNC_UPDATE_CONFIG, async (_event, vaultId: string, config: Partial<AutoSyncConfig>) => {
    try {
      // Persist to VaultConfig
      const vault = vaultManager.getById(vaultId);
      if (vault) {
        const updates: Partial<typeof vault.syncOptions> = {};
        if (config.debounceMs !== undefined) updates.autoSyncDebounceMs = config.debounceMs;
        if (config.enabled !== undefined) updates.autoSync = config.enabled;
        vaultManager.update(vaultId, {
          syncOptions: { ...vault.syncOptions, ...updates },
        });
      }

      // Hot-reload the running engine
      autoSyncEngine.updateConfig(vaultId, config);

      // If enabled changed, start or stop accordingly
      if (config.enabled === true && autoSyncEngine.getState(vaultId) === 'idle') {
        autoSyncEngine.start(vaultId);
      } else if (config.enabled === false) {
        autoSyncEngine.stop(vaultId);
      }

      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : 'Update failed' };
    }
  });
}
