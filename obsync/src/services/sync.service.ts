import * as fs from 'fs';
import * as path from 'path';
import { BrowserWindow } from 'electron';
import { createLogger } from '../utils/logger.util';
import { IPC } from '../config/ipc-channels';
import type { SyncResult, CloudCredentials } from '../models/cloud-sync.model';
import type { VaultSyncStatus } from '../models/vault.model';
import type { VaultService } from './vault.service';
import type { CloudProviderService } from './cloud-provider.service';
import type { ManifestService } from './manifest.service';

const logger = createLogger('SyncService');

export class SyncService {
  private statusMap: Map<string, VaultSyncStatus> = new Map();

  constructor(
    private readonly vaultService: VaultService,
    private readonly cloudProvider: CloudProviderService,
    private readonly manifestService: ManifestService,
  ) {}

  async push(vaultId: string, window: BrowserWindow | null, silent = false): Promise<SyncResult> {
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

  async pushFile(vaultId: string, relativePath: string): Promise<SyncResult> {
    const vault = this.vaultService.getById(vaultId);
    if (!vault) return { success: false, message: 'Vault not found' };
    const creds = this.cloudProvider.getCredentials(vaultId);
    if (!creds) return { success: false, message: 'Provider not configured' };
    
    const provider = (this.cloudProvider as any).providers[creds.provider];
    if (!provider || !provider.pushFile) return this.push(vaultId, null, true);
    
    return provider.pushFile(vault.localPath, relativePath, creds);
  }

  async pull(vaultId: string, window: BrowserWindow | null, silent = false): Promise<SyncResult> {
    const vault = this.vaultService.getById(vaultId);
    if (!vault) return { success: false, message: 'Vault not found' };

    this.emitStatus(window, vaultId, 'syncing', 'Checking for changes...');

    const creds = this.cloudProvider.getCredentials(vaultId);
    if (!creds) return { success: false, message: 'Not configured' };
    const provider = (this.cloudProvider as any).providers[creds.provider];

    // If provider supports Delta sync, use it
    if (provider.getChanges) {
      const manifest = this.manifestService.load(vault.localPath, vaultId);
      const delta = await provider.getChanges(vault.localPath, creds, manifest.cursor);
      
      if (delta.success && delta.entries) {
        let changed = 0;
        for (const entry of delta.entries) {
          const relPath = entry.path_display ? entry.path_display.split(`/Obsync_${path.basename(vault.localPath)}/`)[1] : null;
          if (!relPath) continue;

          if (entry['.tag'] === 'deleted') {
             const localPath = path.join(vault.localPath, relPath);
             if (fs.existsSync(localPath)) {
               fs.rmSync(localPath, { recursive: true, force: true });
               this.manifestService.removeFile(manifest, relPath);
               changed++;
             }
          } else if (entry['.tag'] === 'file') {
             // Atomic Pull
             await provider.pullFile?.(vault.localPath, relPath, creds);
             changed++;
          }
        }
        manifest.cursor = delta.cursor;
        this.manifestService.save(vault.localPath, manifest);
        
        if (changed > 0) {
          this.emitStatus(window, vaultId, 'synced', `Synced ${changed} changes`);
        } else {
          this.emitStatus(window, vaultId, 'synced', 'Up to date');
        }
        return { success: true, message: `Delta sync: ${changed} changes` };
      }
    }

    // Fallback to full pull if Delta not supported or failed
    const result = await this.cloudProvider.pull(vault.localPath, vaultId);
    if (result.success) {
      this.vaultService.updateLastSynced(vaultId);
      const msg = result.message || 'Pulled successfully';
      this.emitStatus(window, vaultId, 'synced', msg);
    } else if (result.conflicts && result.conflicts.length > 0) {
      this.emitStatus(window, vaultId, 'conflict', 'Conflicts detected');
      if (window) window.webContents.send(IPC.EVENT_CONFLICT_DETECTED, { vaultId, conflicts: result.conflicts });
    } else {
      this.emitStatus(window, vaultId, 'error', result.message);
    }
    this.emitComplete(window, vaultId, result);
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

  async delete(vaultId: string, relativePath: string): Promise<SyncResult> {
    const vault = this.vaultService.getById(vaultId);
    if (!vault) return { success: false, message: 'Vault not found' };
    const creds = this.cloudProvider.getCredentials(vaultId);
    if (!creds) return { success: false, message: 'Provider not configured' };
    
    const provider = (this.cloudProvider as any).providers[creds.provider];
    if (!provider || !provider.delete) return { success: false, message: 'Provider does not support deletion' };
    
    return provider.delete(vault.localPath, relativePath, creds);
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
    window: BrowserWindow | null,
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
    if (window) window.webContents.send(IPC.EVENT_SYNC_PROGRESS, syncStatus);
    logger.info(`[${vaultId}] status → ${status}: ${message ?? ''}`);
  }

  private emitComplete(window: BrowserWindow | null, vaultId: string, result: SyncResult): void {
    if (window) window.webContents.send(IPC.EVENT_SYNC_COMPLETE, { vaultId, result });
  }
}
