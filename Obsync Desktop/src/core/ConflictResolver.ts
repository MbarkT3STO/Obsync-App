/**
 * ConflictResolver — applies a ConflictStrategy to a set of conflicting files.
 *
 * Strategies:
 *  'ask'         → emit a conflict event and wait for the UI to respond
 *  'keep-local'  → always prefer the local version (upload it)
 *  'keep-remote' → always prefer the remote version (download it)
 *  'keep-both'   → rename local to filename.conflict.md, then download remote
 */

import fs from 'fs';
import path from 'path';
import type { ConflictFile, ConflictStrategy } from '../providers/SyncProvider';
import type { SyncProvider } from '../providers/SyncProvider';
import { createLogger } from '../utils/logger.util';

const logger = createLogger('ConflictResolver');

export interface ConflictResolution {
  path: string;
  action: 'uploaded' | 'downloaded' | 'kept-both' | 'pending-ui';
}

export class ConflictResolver {
  /**
   * Resolve a list of conflicts according to the given strategy.
   *
   * @param conflicts    Conflict descriptors from ManifestManager.diff()
   * @param vaultPath    Absolute path to the local vault root
   * @param provider     The active SyncProvider (used for upload/download)
   * @param strategy     How to resolve conflicts
   * @param onAsk        Callback invoked for 'ask' strategy — must return the chosen strategy
   */
  async resolve(
    conflicts: ConflictFile[],
    vaultPath: string,
    provider: SyncProvider,
    strategy: ConflictStrategy,
    onAsk?: (conflict: ConflictFile) => Promise<'keep-local' | 'keep-remote' | 'keep-both'>,
  ): Promise<ConflictResolution[]> {
    const resolutions: ConflictResolution[] = [];

    for (const conflict of conflicts) {
      try {
        const effectiveStrategy =
          strategy === 'ask' && onAsk
            ? await onAsk(conflict)
            : (strategy as 'keep-local' | 'keep-remote' | 'keep-both');

        const resolution = await this.applyStrategy(
          conflict,
          vaultPath,
          provider,
          effectiveStrategy,
        );
        resolutions.push(resolution);
      } catch (e) {
        logger.error(`Failed to resolve conflict for ${conflict.path}:`, e);
        resolutions.push({ path: conflict.path, action: 'pending-ui' });
      }
    }

    return resolutions;
  }

  private async applyStrategy(
    conflict: ConflictFile,
    vaultPath: string,
    provider: SyncProvider,
    strategy: 'keep-local' | 'keep-remote' | 'keep-both',
  ): Promise<ConflictResolution> {
    const absPath = path.join(vaultPath, conflict.path);

    switch (strategy) {
      case 'keep-local': {
        await provider.uploadFile(conflict.path, conflict.localVersion);
        logger.info(`Conflict resolved (keep-local): ${conflict.path}`);
        return { path: conflict.path, action: 'uploaded' };
      }

      case 'keep-remote': {
        const dir = path.dirname(absPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(absPath, conflict.remoteVersion);
        logger.info(`Conflict resolved (keep-remote): ${conflict.path}`);
        return { path: conflict.path, action: 'downloaded' };
      }

      case 'keep-both': {
        // Rename local to filename.conflict.ext, then write remote as the canonical file
        const ext = path.extname(conflict.path);
        const base = conflict.path.slice(0, -ext.length);
        const conflictPath = `${base}.conflict${ext}`;
        const absConflictPath = path.join(vaultPath, conflictPath);

        fs.writeFileSync(absConflictPath, conflict.localVersion);
        fs.writeFileSync(absPath, conflict.remoteVersion);

        // Upload the conflict copy so the other device sees it too
        await provider.uploadFile(conflictPath, conflict.localVersion);
        logger.info(`Conflict resolved (keep-both): ${conflict.path} + ${conflictPath}`);
        return { path: conflict.path, action: 'kept-both' };
      }
    }
  }
}
