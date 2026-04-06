/**
 * ManifestManager — builds, persists, and diffs FileManifests.
 *
 * Responsibilities:
 *  1. Scan a local vault directory and produce a FileManifest (SHA-256 each file).
 *  2. Load/save the last-known local manifest from Electron userData (per vault ID).
 *  3. Perform a 3-way diff: localCurrent vs localLast vs remoteCurrent.
 *     Returns a ChangeSet describing exactly what needs to happen.
 */

import fs from 'fs';
import path from 'path';
import { app } from 'electron';
import { FileHasher } from './FileHasher';
import { matchesIgnorePattern } from './ObsidianIgnorePatterns';
import type { FileManifest } from '../providers/SyncProvider';
import { createLogger } from '../utils/logger.util';

const logger = createLogger('ManifestManager');

export interface ChangeSet {
  toUpload: string[];
  toDownload: string[];
  conflicts: Array<{ path: string; localHash: string; remoteHash: string }>;
  toDeleteRemote: string[];
  toDeleteLocal: string[];
}

export class ManifestManager {
  private readonly manifestDir: string;

  constructor() {
    this.manifestDir = path.join(app.getPath('userData'), 'manifests');
    if (!fs.existsSync(this.manifestDir)) {
      fs.mkdirSync(this.manifestDir, { recursive: true });
    }
  }

  // ── Manifest I/O ──────────────────────────────────────────────────────────

  /** Load the last persisted manifest for a vault. Returns null on first run. */
  loadLocal(vaultId: string): FileManifest | null {
    const p = this.manifestPath(vaultId);
    if (!fs.existsSync(p)) return null;
    try {
      return JSON.parse(fs.readFileSync(p, 'utf-8')) as FileManifest;
    } catch (e) {
      logger.warn(`Failed to load manifest for ${vaultId}:`, e);
      return null;
    }
  }

  /** Persist a manifest to disk (atomic write). */
  saveLocal(vaultId: string, manifest: FileManifest): void {
    const p = this.manifestPath(vaultId);
    const tmp = `${p}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2), 'utf-8');
    fs.renameSync(tmp, p);
  }

  /** Delete the persisted manifest (e.g. when a vault is removed). */
  deleteLocal(vaultId: string): void {
    const p = this.manifestPath(vaultId);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }

  // ── Manifest building ─────────────────────────────────────────────────────

  /**
   * Scan the vault directory and build a fresh FileManifest.
   * Files matching ignorePatterns are excluded.
   */
  async buildFromDisk(
    vaultPath: string,
    deviceId: string,
    ignorePatterns: string[] = [],
  ): Promise<FileManifest> {
    const files: FileManifest['files'] = {};
    const allPaths = this.collectFiles(vaultPath, ignorePatterns);

    await Promise.all(
      allPaths.map(async (absPath) => {
        const relPath = path.relative(vaultPath, absPath).replace(/\\/g, '/');
        try {
          const stat = fs.statSync(absPath);
          const hash = await FileHasher.hashFile(absPath);
          files[relPath] = {
            hash,
            size: stat.size,
            lastModified: stat.mtimeMs,
          };
        } catch (e) {
          logger.warn(`Skipping unreadable file ${relPath}:`, e);
        }
      }),
    );

    return {
      version: 1,
      lastSync: new Date().toISOString(),
      deviceId,
      files,
    };
  }

  // ── 3-way diff ────────────────────────────────────────────────────────────

  /**
   * Compute what needs to happen to bring local and remote into sync.
   *
   * Truth table:
   * | Local Changed | Remote Changed | Action           |
   * |---------------|----------------|------------------|
   * | Yes           | No             | Upload           |
   * | No            | Yes            | Download         |
   * | Yes           | Yes            | Conflict         |
   * | No            | No             | Skip             |
   * | Exists local  | Missing remote | Upload           |
   * | Missing local | Exists remote  | Download         |
   * | Deleted local | Exists remote  | Delete remote    |
   * | Exists local  | Deleted remote | Delete local     |
   */
  diff(
    localLast: FileManifest | null,
    localCurrent: FileManifest,
    remote: FileManifest | null,
  ): ChangeSet {
    const result: ChangeSet = {
      toUpload: [],
      toDownload: [],
      conflicts: [],
      toDeleteRemote: [],
      toDeleteLocal: [],
    };

    const lastFiles = localLast?.files ?? {};
    const currentFiles = localCurrent.files;
    const remoteFiles = remote?.files ?? {};

    // All paths across all three manifests
    const allPaths = new Set([
      ...Object.keys(currentFiles),
      ...Object.keys(lastFiles),
      ...Object.keys(remoteFiles),
    ]);

    for (const p of allPaths) {
      const inCurrent = p in currentFiles;
      const inLast = p in lastFiles;
      const inRemote = p in remoteFiles;

      const localChanged = inCurrent
        ? !inLast || currentFiles[p]!.hash !== lastFiles[p]!.hash
        : inLast; // was in last but gone now → deleted locally

      const remoteChanged = inRemote
        ? !inLast || remoteFiles[p]!.hash !== lastFiles[p]!.hash
        : inLast; // was in last but gone remotely → deleted remotely

      if (!inCurrent && !inRemote) continue; // both deleted — nothing to do

      if (inCurrent && !inRemote) {
        // Exists locally, missing remotely
        if (inLast && !remoteChanged) {
          // Was synced before, remote deleted it → delete local
          result.toDeleteLocal.push(p);
        } else {
          // New local file or remote never had it → upload
          result.toUpload.push(p);
        }
        continue;
      }

      if (!inCurrent && inRemote) {
        // Missing locally, exists remotely
        if (inLast && !localChanged) {
          // Was synced before, local deleted it → delete remote
          result.toDeleteRemote.push(p);
        } else {
          // New remote file or local never had it → download
          result.toDownload.push(p);
        }
        continue;
      }

      // Both exist
      if (!localChanged && !remoteChanged) continue; // identical — skip

      if (localChanged && !remoteChanged) {
        result.toUpload.push(p);
      } else if (!localChanged && remoteChanged) {
        result.toDownload.push(p);
      } else {
        // Both changed — conflict
        result.conflicts.push({
          path: p,
          localHash: currentFiles[p]!.hash,
          remoteHash: remoteFiles[p]!.hash,
        });
      }
    }

    return result;
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private manifestPath(vaultId: string): string {
    return path.join(this.manifestDir, `${vaultId}.json`);
  }

  private collectFiles(vaultPath: string, ignorePatterns: string[]): string[] {
    const result: string[] = [];
    const stack: string[] = [vaultPath];

    while (stack.length > 0) {
      const dir = stack.pop()!;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of entries) {
        const abs = path.join(dir, entry.name);
        const rel = path.relative(vaultPath, abs).replace(/\\/g, '/');

        if (matchesIgnorePattern(rel, ignorePatterns)) continue;

        if (entry.isDirectory()) {
          stack.push(abs);
        } else if (entry.isFile()) {
          result.push(abs);
        }
      }
    }

    return result;
  }
}
