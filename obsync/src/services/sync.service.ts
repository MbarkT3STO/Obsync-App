import { BrowserWindow } from 'electron';
import { createLogger } from '../utils/logger.util';
import { IPC } from '../config/ipc-channels';
import type { SyncResult, GitHubCredentials } from '../models/github.model';
import type { VaultSyncStatus } from '../models/vault.model';
import type { VaultService } from './vault.service';
import type { GitHubService } from './github.service';

const logger = createLogger('SyncService');

export class SyncService {
  private statusMap: Map<string, VaultSyncStatus> = new Map();

  constructor(
    private readonly vaultService: VaultService,
    private readonly githubService: GitHubService,
  ) {}

  async push(vaultId: string, window: BrowserWindow): Promise<SyncResult> {
    const vault = this.vaultService.getById(vaultId);
    if (!vault) return { success: false, message: 'Vault not found' };

    this.emitStatus(window, vaultId, 'syncing', 'Pushing changes...');

    const result = await this.githubService.push(vault.localPath, vaultId);

    if (result.success) {
      this.vaultService.updateLastSynced(vaultId);
      this.emitStatus(window, vaultId, 'synced', result.message);
    } else {
      this.emitStatus(window, vaultId, 'error', result.message);
    }

    this.emitComplete(window, vaultId, result);
    return result;
  }

  async pull(vaultId: string, window: BrowserWindow): Promise<SyncResult> {
    const vault = this.vaultService.getById(vaultId);
    if (!vault) return { success: false, message: 'Vault not found' };

    this.emitStatus(window, vaultId, 'syncing', 'Pulling changes...');

    const result = await this.githubService.pull(vault.localPath, vaultId);

    if (result.success) {
      this.vaultService.updateLastSynced(vaultId);
      this.emitStatus(window, vaultId, 'synced', result.message);
    } else if (result.conflicts && result.conflicts.length > 0) {
      this.emitStatus(window, vaultId, 'conflict', 'Conflicts detected');
      window.webContents.send(IPC.EVENT_CONFLICT_DETECTED, { vaultId, conflicts: result.conflicts });
    } else {
      this.emitStatus(window, vaultId, 'error', result.message);
    }

    this.emitComplete(window, vaultId, result);
    return result;
  }

  async initRepo(vaultId: string): Promise<SyncResult> {
    const vault = this.vaultService.getById(vaultId);
    if (!vault) return { success: false, message: 'Vault not found' };

    const config = this.githubService.getConfig(vaultId);
    if (!config) return { success: false, message: 'GitHub not configured' };

    const token = this.githubService.getDecryptedToken(vaultId);
    if (!token) return { success: false, message: 'Could not read token' };

    return this.githubService.initRepo(vault.localPath, {
      token,
      repoUrl: config.repoUrl,
      branch: config.branch,
    });
  }

  async clone(targetPath: string, credentials: GitHubCredentials): Promise<SyncResult> {
    const result = await this.githubService.clone(targetPath, credentials);
    if (!result.success) return result;

    try {
      const vault = this.vaultService.add(targetPath);
      this.githubService.saveConfig(vault.id, credentials);
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
