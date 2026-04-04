import * as fs from 'fs';
import * as path from 'path';
import { createLogger } from '../utils/logger.util';

const logger = createLogger('ManifestService');

export interface ManifestEntry {
  path: string;
  hash?: string;
  remoteId?: string; // Critical for move detection
  version?: string;
  mtime: number;
  size: number;
}

export interface SyncManifest {
  vaultId: string;
  lastSync: string;
  cursor?: string; // For Delta APIs
  files: Record<string, ManifestEntry>;
}

export class ManifestService {
  private getManifestPath(vaultPath: string): string {
    const obsyncDir = path.join(vaultPath, '.obsync');
    if (!fs.existsSync(obsyncDir)) fs.mkdirSync(obsyncDir, { recursive: true });
    return path.join(obsyncDir, 'manifest.json');
  }

  load(vaultPath: string, vaultId: string): SyncManifest {
    const manifestPath = this.getManifestPath(vaultPath);
    if (!fs.existsSync(manifestPath)) {
      return { vaultId, lastSync: new Date(0).toISOString(), files: {} };
    }
    try {
      const data = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      return data;
    } catch (err) {
      logger.error('Failed to load manifest', err);
      return { vaultId, lastSync: new Date(0).toISOString(), files: {} };
    }
  }

  save(vaultPath: string, manifest: SyncManifest): void {
    try {
      const manifestPath = this.getManifestPath(vaultPath);
      manifest.lastSync = new Date().toISOString();
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    } catch (err) {
      logger.error('Failed to save manifest', err);
    }
  }

  updateFile(manifest: SyncManifest, entry: ManifestEntry): void {
    manifest.files[entry.path] = entry;
  }

  removeFile(manifest: SyncManifest, relativePath: string): void {
    delete manifest.files[relativePath];
  }
}
