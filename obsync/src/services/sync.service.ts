import { BrowserWindow } from 'electron';
import { createLogger } from '../utils/logger.util';
import { IPC } from '../config/ipc-channels';
import type { SyncResult, CloudCredentials } from '../models/cloud-sync.model';
import type { VaultSyncStatus } from '../models/vault.model';
import type { VaultService } from './vault.service';
import type { CloudProviderService } from './cloud-provider.service';

const logger = createLogger('SyncService');

export class SyncService {
  private statusMap: Map<string, VaultSyncStatus> = new Map();

  constructor(
    private readonly vaultService: VaultService,
    private readonly cloudProvider: CloudProviderService,
  ) {}

  async push(vaultId: string, window: BrowserWindow, silent = false): Promise<SyncResult> {
    const vault = this.vaultService.getById(vaultId);
    if (!vault) return { success: false, message: 'Vault not found' };

    this.emitStatus(window, vaultId, 'syncing', 'Pushing...');

    const result = await this.cloudProvider.push(vault.localPath, vaultId);

    if (result.success) {
      this.vaultService.updateLastSynced(vaultId);
      const msg = result.message || 'Pushed successfully';
      this.emitStatus(window, vaultId, 'synced', msg);
    } else {
      this.emitStatus(window, vaultId, 'error', result.message);
    }

    if (!silent || !result.success || (result.filesChanged ?? 0) > 0) {
      this.emitComplete(window, vaultId, result);
    }
    return result;
  }

  async pull(vaultId: string, window: BrowserWindow, silent = false): Promise<SyncResult> {
    const vault = this.vaultService.getById(vaultId);
    if (!vault) return { success: false, message: 'Vault not found' };

    this.emitStatus(window, vaultId, 'syncing', 'Pulling...');

    const result = await this.cloudProvider.pull(vault.localPath, vaultId);

    if (result.success) {
      this.vaultService.updateLastSynced(vaultId);
      const msg = result.message || 'Pulled successfully';
      this.emitStatus(window, vaultId, 'synced', msg);
    } else if (result.conflicts && result.conflicts.length > 0) {
      this.emitStatus(window, vaultId, 'conflict', 'Conflicts detected');
      window.webContents.send(IPC.EVENT_CONFLICT_DETECTED, { vaultId, conflicts: result.conflicts });
    } else {
      this.emitStatus(window, vaultId, 'error', result.message);
    }

    // Only emit complete (UI toast) if not silent, or if there were actual changes/errors
    const hasChanges = result.message !== 'Already up to date';
    if (!silent || !result.success || hasChanges) {
      this.emitComplete(window, vaultId, result);
    }
    return result;
  }

  async initRepo(vaultId: string): Promise<SyncResult> {
    const vault = this.vaultService.getById(vaultId);
    if (!vault) return { success: false, message: 'Vault not found' };

    const config = this.cloudProvider.getConfig(vaultId);
    if (!config) return { success: false, message: 'Sync not configured' };

    const token = this.cloudProvider.getDecryptedToken(vaultId);
    if (!token) return { success: false, message: 'Could not read token' };

    return this.cloudProvider.initRepo(vault.localPath, {
      provider: config.provider,
      token,
      meta: config.meta
    });
  }

  async clone(targetPath: string, credentials: CloudCredentials): Promise<SyncResult> {
    const result = await this.cloudProvider.clone(targetPath, credentials);
    if (!result.success) return result;

    try {
      const vault = this.vaultService.add(targetPath);
      this.cloudProvider.saveConfig(vault.id, credentials);
      return { success: true, message: 'Vault imported and cloned successfully', data: vault as any };
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      logger.error('Failed to register vault after clone', err);
      return { success: false, message: `Clone succeeded but failed to register vault: ${msg}` };
    }
  }

  getStatus(vaultId: string): VaultSyncStatus {
    return this.statusMap.get(vaultId) ?? {
      vaultId,
      status: 'idle',
      lastChecked: new Date().toISOString(),
    };
  }

  private emitStatus(
    window: BrowserWindow,
    vaultId: string,
    status: VaultSyncStatus['status'],
    message?: string,
  ): void {
    const syncStatus: VaultSyncStatus = {
      vaultId,
      status,
      message,
      lastChecked: new Date().toISOString(),
    };
    this.statusMap.set(vaultId, syncStatus);
    window.webContents.send(IPC.EVENT_SYNC_PROGRESS, syncStatus);
    logger.info(`[${vaultId}] status → ${status}: ${message ?? ''}`);
  }

  private emitComplete(window: BrowserWindow, vaultId: string, result: SyncResult): void {
    window.webContents.send(IPC.EVENT_SYNC_COMPLETE, { vaultId, result });
  }
}
