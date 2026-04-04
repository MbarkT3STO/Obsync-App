import * as fs from 'fs';
import * as path from 'path';
import { BrowserWindow } from 'electron';
import pLimit from 'p-limit';
import * as CryptoJS from 'crypto-js';
import { createLogger } from '../utils/logger.util';
import { withRetry } from '../utils/retry.util';
import { shouldSkipDir, shouldSyncFile, collectVaultFiles } from '../utils/obsidian-filter.util';
import { IPC } from '../config/ipc-channels';
import type { SyncResult, CloudCredentials } from '../models/cloud-sync.model';
import type { VaultSyncStatus } from '../models/vault.model';
import type { VaultService } from './vault.service';
import type { CloudProviderService } from './cloud-provider.service';
import type { ManifestService } from './manifest.service';
import type { HistoryService } from './history.service';
import { PathUtils } from '../utils/path.util';

const logger = createLogger('SyncService');

interface FileState {
  path: string;
  mtime: number;
  size: number;
  remoteId?: string;
  hash?: string;
  tag?: 'file' | 'folder' | 'deleted';
}

export class SyncService {
  private statusMap: Map<string, VaultSyncStatus> = new Map();
  private limit = pLimit(5); // Parallel limit for cloud operations

  constructor(
    private readonly vaultService: VaultService,
    private readonly cloudProvider: CloudProviderService,
    private readonly manifestService: ManifestService,
    private readonly historyService: HistoryService,
  ) {}

  private getAllLocalFiles(dirPath: string, vaultRoot: string, result: string[] = []): string[] {
    return collectVaultFiles(vaultRoot, dirPath, result);
  }

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

  async move(vaultId: string, oldRelativePath: string, newRelativePath: string): Promise<SyncResult> {
    const vault = this.vaultService.getById(vaultId);
    if (!vault) return { success: false, message: 'Vault not found' };
    const creds = this.cloudProvider.getCredentials(vaultId);
    if (!creds) return { success: false, message: 'Provider not configured' };
    
    return this.cloudProvider.move(vault.localPath, oldRelativePath, newRelativePath, creds);
  }

  private async getFileFingerprint(filePath: string): Promise<string> {
    try {
      const stats = fs.statSync(filePath);
      // For speed, only hash the small files or first/last bits of large ones
      // This is the 'Solid and Efficient' way
      if (stats.size < 1024 * 1024) {
        const content = fs.readFileSync(filePath);
        return CryptoJS.MD5(content.toString()).toString();
      }
      return `${stats.size}-${stats.mtimeMs}`;
    } catch {
      return '';
    }
  }

  async pull(vaultId: string, window: BrowserWindow | null, silent = false): Promise<SyncResult> {
    const vault = this.vaultService.getById(vaultId);
    if (!vault) return { success: false, message: 'Vault not found' };

    this.emitStatus(window, vaultId, 'syncing', 'Scanning for changes...');
    const creds = this.cloudProvider.getCredentials(vaultId);
    if (!creds) return { success: false, message: 'Not configured' };
    const provider = (this.cloudProvider as any).providers[creds.provider];

    try {
      const manifest = this.manifestService.load(vault.localPath, vaultId);
      const vaultName = path.basename(vault.localPath);
      const cloudRoot = `Obsync_${vaultName}`;
      
      // 🕵️ Stage 1: Discovery (Parallel)
      const localPaths = this.getAllLocalFiles(vault.localPath, vault.localPath);
      const localStates = new Map<string, FileState>();
      
      await Promise.all(localPaths.map(p => this.limit(async () => {
        const rel = path.relative(vault.localPath, p).replace(/\\/g, '/');
        const stat = fs.statSync(p);
        localStates.set(rel, { path: rel, size: stat.size, mtime: stat.mtimeMs });
      })));

      const remoteStates = new Map<string, FileState>();
      let cloudData: SyncResult & { cursor?: string; entries?: any[] };

      if (provider.getChanges) {
        // Delta-capable providers (Dropbox, OneDrive, GDrive)
        cloudData = await withRetry(() =>
          provider.getChanges!(vault.localPath, creds, manifest.cursor)
        );
      } else {
        // Full-scan providers (WebDAV, Git) — pull returns entries
        cloudData = await withRetry(() => provider.pull(vault.localPath, creds));
      }

      if (!cloudData.success && !cloudData.entries) {
        // Provider did a direct pull (e.g. Git) — no 3-way merge needed
        if (cloudData.success === false) {
          this.emitStatus(window, vaultId, 'error', cloudData.message);
          return cloudData;
        }
      }

      if (cloudData.entries) {
        for (const entry of cloudData.entries) {
          if (!entry) continue;
          const rel = PathUtils.toCloudRelative(entry.path_display || '', cloudRoot);
          if (rel) {
            remoteStates.set(rel, { 
              path: rel, 
              size: entry.size || 0, 
              mtime: new Date(entry.lastmod || entry.client_modified || Date.now()).getTime(),
              remoteId: entry.id,
              tag: entry['.tag'] === 'deleted' ? 'deleted' : (entry['.tag'] === 'folder' ? 'folder' : 'file')
            });
          }
        }
      }

      // 🧠 Stage 2: The Decision Matrix (3-Way Merge)
      const actions: { type: 'PUSH' | 'PULL' | 'DELETE_REMOTE' | 'DELETE_LOCAL' | 'MOVE_REMOTE' | 'CONFLICT'; relPath: string; oldPath?: string }[] = [];
      const allPaths = new Set([...localStates.keys(), ...remoteStates.keys(), ...Object.keys(manifest.files)]);

      for (const relPath of allPaths) {
        const L = localStates.get(relPath);
        const R = remoteStates.get(relPath);
        const B = manifest.files[relPath];

        const lChanged = L ? (!B || Math.abs(L.mtime - B.mtime) > 2000 || L.size !== B.size) : !!B;
        const rChanged = R ? (!B || Math.abs(R.mtime - B.mtime) > 2000 || R.size !== B.size || R.tag === 'deleted') : !!B;

        if (lChanged && rChanged) {
          if (R?.tag === 'deleted' && !L) {
             // Both deleted? Fine.
          } else if (R?.tag === 'deleted' && L) {
             actions.push({ type: 'DELETE_LOCAL', relPath });
          } else if (!R && L) {
             actions.push({ type: 'DELETE_REMOTE', relPath });
          } else if (L && R && L.size === R.size) {
             // Heuristic: Content likely same despite timestamp. Skip conflict.
             this.manifestService.updateFile(manifest, { path: relPath, size: L.size, mtime: L.mtime, remoteId: R.remoteId });
          } else {
             actions.push({ type: 'CONFLICT', relPath });
          }
        } else if (lChanged) {
          if (!L) {
            actions.push({ type: 'DELETE_REMOTE', relPath });
          } else {
            actions.push({ type: 'PUSH', relPath });
          }
        } else if (rChanged) {
          if (!R || R.tag === 'deleted') {
            actions.push({ type: 'DELETE_LOCAL', relPath });
          } else {
            actions.push({ type: 'PULL', relPath });
          }
        }
      }

      // 🚀 Stage 3: Execution (Throttled)
      let changed = 0;
      this.emitStatus(window, vaultId, 'syncing', `Applying ${actions.length} changes...`);

      await Promise.all(actions.map(action => this.limit(async () => {
        try {
          if (action.type === 'PUSH') {
            const res = await withRetry(() => this.pushFile(vaultId, action.relPath));
            if (res.success) {
              const s = fs.statSync(path.join(vault.localPath, action.relPath));
              const hash = await this.getFileFingerprint(path.join(vault.localPath, action.relPath));
              this.manifestService.updateFile(manifest, { path: action.relPath, mtime: s.mtimeMs, size: s.size, hash });
              changed++;
            }
          } else if (action.type === 'PULL') {
            const res = await withRetry<SyncResult>(() => provider.pullFile!(vault.localPath, action.relPath, creds));
            if (res.success) {
               const localFilePath = path.join(vault.localPath, action.relPath);
               if (fs.existsSync(localFilePath)) {
                 const s = fs.statSync(localFilePath);
                 const hash = await this.getFileFingerprint(localFilePath);
                 this.manifestService.updateFile(manifest, { path: action.relPath, mtime: s.mtimeMs, size: s.size, hash });
               }
               changed++;
            }
          } else if (action.type === 'DELETE_REMOTE') {
            await withRetry<SyncResult>(() => this.delete(vaultId, action.relPath));
            this.manifestService.removeFile(manifest, action.relPath);
            changed++;
          } else if (action.type === 'DELETE_LOCAL') {
            const p = path.join(vault.localPath, action.relPath);
            if (fs.existsSync(p)) {
              await this.historyService.archiveFile(vault.localPath, action.relPath);
              fs.rmSync(p, { recursive: true, force: true });
            }
            this.manifestService.removeFile(manifest, action.relPath);
            changed++;
          } else if (action.type === 'CONFLICT') {
            if (window) window.webContents.send(IPC.EVENT_CONFLICT_DETECTED, { vaultId, conflicts: [{ filePath: action.relPath }] });
          }
        } catch (e) {
          logger.error(`Failed action ${action.type} on ${action.relPath}`, e);
        }
      })));

      // Update cursor: save new one if provided, clear stale one if provider reset
      if (cloudData.cursor) {
        manifest.cursor = cloudData.cursor;
      } else if (cloudData.entries !== undefined) {
        // Provider returned entries but no cursor — it reset, clear the stale cursor
        manifest.cursor = undefined;
      }
      this.manifestService.save(vault.localPath, manifest);

      this.emitStatus(window, vaultId, 'synced', changed > 0 ? `Synced ${changed} changes` : 'Up to date');
      return { success: true, message: `Sync complete: ${changed} changes` };

    } catch (err) {
      logger.error('Solid Matrix Sync Failed:', err);
      return { success: false, message: `Sync error: ${err instanceof Error ? err.message : 'Unknown'}` };
    }
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

  async resolveConflict(vaultId: string, filePath: string, strategy: 'local' | 'cloud' | 'both'): Promise<SyncResult> {
    const vault = this.vaultService.getById(vaultId);
    if (!vault) return { success: false, message: 'Vault not found' };
    const creds = this.cloudProvider.getCredentials(vaultId);
    if (!creds) return { success: false, message: 'Provider not configured' };
    
    const localPath = path.join(vault.localPath, filePath);
    
    try {
      if (strategy === 'local') {
        // Local wins -> Update manifest to match local mtime
        const manifest = this.manifestService.load(vault.localPath, vaultId);
        if (fs.existsSync(localPath)) {
          const stat = fs.statSync(localPath);
          const existing = manifest.files[filePath];
          this.manifestService.updateFile(manifest, {
            path: filePath,
            mtime: stat.mtimeMs,
            size: stat.size,
            remoteId: existing?.remoteId
          });
          this.manifestService.save(vault.localPath, manifest);
        }
        return { success: true, message: `Conflict Resolved: Kept local version of ${filePath}` };
      } else if (strategy === 'cloud') {
        // Cloud wins -> Force pull this file
        await this.historyService.archiveFile(vault.localPath, filePath);
        return this.cloudProvider.pullFile(vault.localPath, filePath, creds);
      } else if (strategy === 'both') {
        // Both win -> Rename local to (Conflict), then pull cloud
        if (fs.existsSync(localPath)) {
          const ext = path.extname(filePath);
          const base = filePath.substring(0, filePath.length - ext.length);
          const conflictPath = `${base} (Conflict)${ext}`;
          
          fs.renameSync(localPath, path.join(vault.localPath, conflictPath));
          return this.cloudProvider.pullFile(vault.localPath, filePath, creds);
        }
        return { success: false, message: 'Local file missing, cannot keep both' };
      }
    } catch (err) {
      return { success: false, message: `Resolution failed: ${err instanceof Error ? err.message : 'Unknown'}` };
    }
    return { success: false, message: 'Invalid strategy' };
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
