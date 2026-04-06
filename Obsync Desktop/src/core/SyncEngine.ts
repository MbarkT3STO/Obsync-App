/**
 * SyncEngine — the only class the Electron main process calls for sync operations.
 *
 * It accepts any SyncProvider, delegates manifest diffing to ManifestManager,
 * resolves conflicts via ConflictResolver, and emits progress events throughout.
 *
 * RULE: This class has ZERO imports from any specific provider file.
 */

import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import { ManifestManager } from './ManifestManager';
import { ConflictResolver } from './ConflictResolver';
import { FileHasher } from './FileHasher';
import { buildIgnorePatterns } from './ObsidianIgnorePatterns';
import type {
  SyncProvider,
  SyncResult,
  SyncOptions,
  ConflictFile,
  FileManifest,
} from '../providers/SyncProvider';
import { createLogger } from '../utils/logger.util';

const logger = createLogger('SyncEngine');

// ── Event types ────────────────────────────────────────────────────────────

export interface SyncProgressEvent {
  vaultId: string;
  phase: 'scanning' | 'uploading' | 'downloading' | 'resolving' | 'finalising';
  current: number;
  total: number;
  currentFile?: string;
}

export interface SyncCompleteEvent {
  vaultId: string;
  result: SyncResult;
  durationMs: number;
}

// ── Engine ─────────────────────────────────────────────────────────────────

export class SyncEngine extends EventEmitter {
  private readonly manifestManager: ManifestManager;
  private readonly conflictResolver: ConflictResolver;

  constructor() {
    super();
    this.manifestManager = new ManifestManager();
    this.conflictResolver = new ConflictResolver();
  }

  /**
   * Perform a full bidirectional sync for a vault.
   *
   * @param vaultId    Unique vault identifier (used for manifest persistence)
   * @param vaultPath  Absolute local path to the vault
   * @param provider   The connected SyncProvider to sync against
   * @param deviceId   Stable machine identifier
   * @param options    Sync behaviour overrides
   */
  async sync(
    vaultId: string,
    vaultPath: string,
    provider: SyncProvider,
    deviceId: string,
    options: SyncOptions = {},
  ): Promise<SyncResult> {
    const startMs = Date.now();
    const result: SyncResult = { uploaded: [], downloaded: [], conflicts: [], errors: [] };

    const ignorePatterns = buildIgnorePatterns(
      options.ignorePatterns ?? [],
      true, // syncObsidianConfig — callers can override via ignorePatterns
    );

    try {
      // ── Phase 1: Scan local vault ────────────────────────────────────────
      this.emitProgress(vaultId, 'scanning', 0, 1);
      const localLast = this.manifestManager.loadLocal(vaultId);
      const localCurrent = await this.manifestManager.buildFromDisk(
        vaultPath,
        deviceId,
        ignorePatterns,
      );
      this.emitProgress(vaultId, 'scanning', 1, 1);

      // ── Phase 2: Fetch remote manifest ───────────────────────────────────
      const remote = await provider.getRemoteManifest();

      // ── Phase 3: Compute changeset ───────────────────────────────────────
      const changes = this.manifestManager.diff(localLast, localCurrent, remote);

      const totalOps =
        changes.toUpload.length +
        changes.toDownload.length +
        changes.conflicts.length +
        changes.toDeleteRemote.length +
        changes.toDeleteLocal.length;

      if (totalOps === 0) {
        logger.info(`[${vaultId}] Already up to date`);
        this.emit('complete', { vaultId, result, durationMs: Date.now() - startMs } as SyncCompleteEvent);
        return result;
      }

      if (options.dryRun) {
        logger.info(`[${vaultId}] Dry run — ${totalOps} operation(s) would be performed`);
        this.emit('complete', { vaultId, result, durationMs: Date.now() - startMs } as SyncCompleteEvent);
        return result;
      }

      let opsDone = 0;

      // ── Phase 4: Upload local changes ────────────────────────────────────
      for (const relPath of changes.toUpload) {
        this.emitProgress(vaultId, 'uploading', opsDone, totalOps, relPath);
        try {
          const absPath = path.join(vaultPath, relPath);
          const content = fs.readFileSync(absPath);
          await provider.uploadFile(relPath, content);
          result.uploaded.push(relPath);
          logger.info(`[${vaultId}] Uploaded: ${relPath}`);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          result.errors.push({ file: relPath, error: msg, recoverable: true });
          logger.error(`[${vaultId}] Upload failed for ${relPath}:`, e);
        }
        opsDone++;
      }

      // ── Phase 5: Download remote changes ─────────────────────────────────
      for (const relPath of changes.toDownload) {
        this.emitProgress(vaultId, 'downloading', opsDone, totalOps, relPath);
        try {
          const content = await provider.downloadFile(relPath);
          const absPath = path.join(vaultPath, relPath);
          const dir = path.dirname(absPath);
          if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
          const tmp = `${absPath}.tmp`;
          fs.writeFileSync(tmp, content);
          fs.renameSync(tmp, absPath);
          result.downloaded.push(relPath);
          logger.info(`[${vaultId}] Downloaded: ${relPath}`);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          result.errors.push({ file: relPath, error: msg, recoverable: true });
          logger.error(`[${vaultId}] Download failed for ${relPath}:`, e);
        }
        opsDone++;
      }

      // ── Phase 6: Resolve conflicts ────────────────────────────────────────
      if (changes.conflicts.length > 0) {
        this.emitProgress(vaultId, 'resolving', opsDone, totalOps);

        // Build ConflictFile objects with actual content
        const conflictFiles: ConflictFile[] = [];
        for (const c of changes.conflicts) {
          try {
            const localContent = fs.readFileSync(path.join(vaultPath, c.path));
            const remoteContent = await provider.downloadFile(c.path);
            const localEntry = localCurrent.files[c.path]!;
            const remoteEntry = remote?.files[c.path];
            conflictFiles.push({
              path: c.path,
              localVersion: localContent,
              remoteVersion: remoteContent,
              localModified: localEntry.lastModified,
              remoteModified: remoteEntry?.lastModified ?? 0,
            });
          } catch (e) {
            logger.error(`[${vaultId}] Could not load conflict content for ${c.path}:`, e);
          }
        }

        const strategy = options.conflictStrategy ?? 'ask';

        const resolutions = await this.conflictResolver.resolve(
          conflictFiles,
          vaultPath,
          provider,
          strategy,
          strategy === 'ask'
            ? (conflict) => this.askUserForConflictResolution(vaultId, conflict)
            : undefined,
        );

        for (const r of resolutions) {
          if (r.action === 'uploaded') result.uploaded.push(r.path);
          else if (r.action === 'downloaded') result.downloaded.push(r.path);
          else if (r.action === 'kept-both') {
            result.uploaded.push(r.path);
            result.downloaded.push(r.path);
          } else {
            // pending-ui — surface as conflict for the renderer
            const cf = conflictFiles.find((c) => c.path === r.path);
            if (cf) result.conflicts.push(cf);
          }
          opsDone++;
        }
      }

      // ── Phase 7: Delete remote files ──────────────────────────────────────
      for (const relPath of changes.toDeleteRemote) {
        try {
          await provider.deleteRemoteFile(relPath);
          logger.info(`[${vaultId}] Deleted remote: ${relPath}`);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          result.errors.push({ file: relPath, error: msg, recoverable: true });
        }
        opsDone++;
      }

      // ── Phase 8: Delete local files ───────────────────────────────────────
      for (const relPath of changes.toDeleteLocal) {
        try {
          const absPath = path.join(vaultPath, relPath);
          if (fs.existsSync(absPath)) fs.unlinkSync(absPath);
          logger.info(`[${vaultId}] Deleted local: ${relPath}`);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          result.errors.push({ file: relPath, error: msg, recoverable: true });
        }
        opsDone++;
      }

      // ── Phase 9: Update manifest ──────────────────────────────────────────
      this.emitProgress(vaultId, 'finalising', opsDone, totalOps);

      // Rebuild manifest after all changes are applied
      const finalManifest = await this.manifestManager.buildFromDisk(
        vaultPath,
        deviceId,
        ignorePatterns,
      );
      this.manifestManager.saveLocal(vaultId, finalManifest);

      // Upload manifest for cloud providers (git providers ignore this)
      try {
        await provider.uploadManifest(finalManifest);
      } catch (e) {
        logger.warn(`[${vaultId}] Could not upload manifest:`, e);
      }

      const durationMs = Date.now() - startMs;
      logger.info(
        `[${vaultId}] Sync complete in ${durationMs}ms — ` +
        `↑${result.uploaded.length} ↓${result.downloaded.length} ` +
        `⚡${result.conflicts.length} ✗${result.errors.length}`,
      );

      this.emit('complete', { vaultId, result, durationMs } as SyncCompleteEvent);
      return result;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logger.error(`[${vaultId}] Sync engine error:`, e);
      result.errors.push({ file: '*', error: msg, recoverable: false });
      this.emit('complete', { vaultId, result, durationMs: Date.now() - startMs } as SyncCompleteEvent);
      return result;
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private emitProgress(
    vaultId: string,
    phase: SyncProgressEvent['phase'],
    current: number,
    total: number,
    currentFile?: string,
  ): void {
    this.emit('progress', { vaultId, phase, current, total, currentFile } as SyncProgressEvent);
  }

  /**
   * Emit a conflict event and wait for the UI to respond with a resolution.
   * Times out after 5 minutes and defaults to 'keep-local'.
   */
  private askUserForConflictResolution(
    vaultId: string,
    conflict: ConflictFile,
  ): Promise<'keep-local' | 'keep-remote' | 'keep-both'> {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        logger.warn(`[${vaultId}] Conflict resolution timed out for ${conflict.path} — defaulting to keep-local`);
        resolve('keep-local');
      }, 5 * 60 * 1000);

      this.emit('conflict', {
        vaultId,
        conflict,
        resolve: (strategy: 'keep-local' | 'keep-remote' | 'keep-both') => {
          clearTimeout(timeout);
          resolve(strategy);
        },
      });
    });
  }
}
