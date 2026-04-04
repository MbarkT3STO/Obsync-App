import * as fs from 'fs';
import * as path from 'path';
import type { WebDAVClient } from 'webdav';
import { createLogger } from '../../utils/logger.util';
import { PathUtils } from '../../utils/path.util';
import { withRetry } from '../../utils/retry.util';
import { shouldSkipDir, shouldSyncFile, collectVaultFiles } from '../../utils/obsidian-filter.util';
import type { CloudCredentials, ICloudProvider, SyncResult } from '../../models/cloud-sync.model';
import { getCloudVaultName } from '../../utils/vault-name.util';

const logger = createLogger('WebDavCloudProvider');

export class WebDavCloudProvider implements ICloudProvider {
  private clients: Map<string, WebDAVClient> = new Map();
  onTokenRefreshed?: (newTokenJson: string) => void; // WebDAV uses basic auth, no refresh needed

  async init(vaultPath: string, credentials: CloudCredentials): Promise<SyncResult> {
    try {
      await this.getClient(credentials);
      return { success: true, message: 'WebDAV connected' };
    } catch (err) {
      return { success: false, message: `WebDAV init failed: ${err instanceof Error ? err.message : 'Unknown'}` };
    }
  }

  async clone(vaultPath: string, credentials: CloudCredentials): Promise<SyncResult> {
    if (!fs.existsSync(vaultPath)) fs.mkdirSync(vaultPath, { recursive: true });
    return this.pull(vaultPath, credentials);
  }

  async move(vaultPath: string, oldRelativePath: string, newRelativePath: string, credentials: CloudCredentials): Promise<SyncResult> {
    try {
      const client = await this.getClient(credentials);
      const vaultName = getCloudVaultName(vaultPath, credentials);
      const remoteRoot = `Obsync_${vaultName}`;
      
      const oldPath = `${remoteRoot}/${oldRelativePath.replace(/\\/g, '/')}`;
      const newPath = `${remoteRoot}/${newRelativePath.replace(/\\/g, '/')}`;
      
      const newDir = path.dirname(newPath);
      await this.ensureRemoteDir(client, newDir);

      await client.moveFile(oldPath, newPath);
      return { success: true, message: `Moved ${oldRelativePath} to ${newRelativePath}` };
    } catch (err) {
      return { success: false, message: `Move failed: ${err instanceof Error ? err.message : 'Unknown'}` };
    }
  }

  async validate(credentials: CloudCredentials): Promise<SyncResult> {
    try {
      const client = await this.getClient(credentials);
      const res = await client.getDirectoryContents('/');
      if (res) return { success: true, message: 'WebDAV Connection Valid' };
      return { success: false, message: 'Failed to list directory' };
    } catch (err) {
      return { success: false, message: `Validation failed: ${err instanceof Error ? err.message : 'Unknown'}` };
    }
  }

  async push(vaultPath: string, credentials: CloudCredentials): Promise<SyncResult> {
    try {
      const client = await this.getClient(credentials);
      const vaultName = getCloudVaultName(vaultPath, credentials);
      const remoteRoot = `/Obsync_${vaultName}`;

      const files = collectVaultFiles(vaultPath);
      let pushed = 0;
      const failed: string[] = [];

      if (!(await client.exists(remoteRoot))) {
        await client.createDirectory(remoteRoot);
      }

      for (const filePath of files) {
        const relativePath = PathUtils.toRelative(vaultPath, filePath);
        const remoteFilePath = `${remoteRoot}/${relativePath}`;
        try {
          const remoteDir = path.dirname(remoteFilePath);
          await this.ensureRemoteDir(client, remoteDir);
          const content = fs.readFileSync(filePath);
          await withRetry(() => client.putFileContents(remoteFilePath, content));
          pushed++;
        } catch (err) {
          logger.error(`Failed to push ${relativePath}:`, err);
          failed.push(relativePath);
        }
      }

      if (files.length > 0) {
        await this.cleanupRemote(client, remoteRoot, vaultPath, files);
      }

      const msg = failed.length
        ? `Pushed ${pushed} file(s), ${failed.length} failed: ${failed.slice(0, 3).join(', ')}${failed.length > 3 ? '...' : ''}`
        : `Pushed ${pushed} file(s) to WebDAV`;
      return { success: true, message: msg, filesChanged: pushed };
    } catch (err) {
      logger.error('WebDAV Push Failed:', err);
      return { success: false, message: `Push failed: ${err instanceof Error ? err.message : 'Unknown'}` };
    }
  }

  async pull(vaultPath: string, credentials: CloudCredentials): Promise<SyncResult & { entries?: any[] }> {
    try {
      const client = await this.getClient(credentials);
      const vaultName = getCloudVaultName(vaultPath, credentials);
      const remoteRoot = `Obsync_${vaultName}`;

      if (!(await client.exists(remoteRoot))) {
        return { success: true, message: 'Cloud folder not found', entries: [] };
      }

      const entries: any[] = [];
      const scanItems = async (remoteDirPath: string) => {
        const items = await client.getDirectoryContents(remoteDirPath) as any[];
        for (const item of items) {
          const relPath = PathUtils.toCloudRelative(item.filename, `Obsync_${vaultName}`);
          if (relPath === null || relPath === '') continue;
          
          entries.push({
            id: item.filename,
            path_display: relPath,
            name: item.basename,
            size: item.size || 0,
            lastmod: item.lastmod,
            '.tag': item.type === 'directory' ? 'folder' : 'file'
          });

          if (item.type === 'directory') {
            await scanItems(item.filename);
          }
        }
      };

      await scanItems(remoteRoot);
      return { success: true, message: 'Scanned WebDAV cloud state', entries };
    } catch (err) {
      logger.error('WebDAV Fetch Failed:', err);
      return { success: false, message: `Cloud scan failed: ${err instanceof Error ? err.message : 'Unknown'}` };
    }
  }

  async pullFile(vaultPath: string, relativePath: string, credentials: CloudCredentials): Promise<SyncResult> {
    try {
      const client = await this.getClient(credentials);
      const vaultName = getCloudVaultName(vaultPath, credentials);
      const remotePath = `/Obsync_${vaultName}/${PathUtils.normalize(relativePath)}`;
      
      const content = await client.getFileContents(remotePath);
      const localPath = path.join(vaultPath, relativePath);
      const localDir = path.dirname(localPath);
      if (!fs.existsSync(localDir)) fs.mkdirSync(localDir, { recursive: true });
      
      fs.writeFileSync(localPath, content as Buffer);
      return { success: true, message: `Pulled ${relativePath}` };
    } catch (err) {
      return { success: false, message: `Pull failed: ${err instanceof Error ? err.message : 'Unknown'}` };
    }
  }

  async pushFile(vaultPath: string, relativePath: string, credentials: CloudCredentials): Promise<SyncResult> {
    try {
      const client = await this.getClient(credentials);
      const vaultName = getCloudVaultName(vaultPath, credentials);
      const remotePath = `/Obsync_${vaultName}/${PathUtils.normalize(relativePath)}`;
      const localPath = path.join(vaultPath, relativePath);
      
      if (!fs.existsSync(localPath)) return { success: false, message: 'Local file missing' };
      
      await this.ensureRemoteDir(client, path.dirname(remotePath));
      const content = fs.readFileSync(localPath);
      await withRetry(() => client.putFileContents(remotePath, content));
      return { success: true, message: `Pushed ${relativePath}` };
    } catch (err) {
      return { success: false, message: `Push failed: ${err instanceof Error ? err.message : 'Unknown'}` };
    }
  }

  async delete(vaultPath: string, relativePath: string, credentials: CloudCredentials): Promise<SyncResult> {
    try {
      const client = await this.getClient(credentials);
      const vaultName = getCloudVaultName(vaultPath, credentials);
      const remotePath = `/Obsync_${vaultName}/${PathUtils.normalize(relativePath)}`;
      
      if (await client.exists(remotePath)) {
        await client.deleteFile(remotePath);
      }
      return { success: true, message: `Deleted ${relativePath}` };
    } catch (err) {
      return { success: false, message: `Delete failed: ${err instanceof Error ? err.message : 'Unknown'}` };
    }
  }

  private async getClient(credentials: CloudCredentials): Promise<WebDAVClient> {
    const key = `${credentials.provider}_${credentials.token}`;
    if (this.clients.has(key)) return this.clients.get(key)!;

    let url = '';
    let username = '';
    let password = '';

    try {
      const data = JSON.parse(credentials.token);
      url = data.url;
      username = data.username;
      password = data.password;
    } catch {
      throw new Error('Invalid WebDAV credentials format');
    }

    const { createClient } = (await import('webdav')) as any;
    const client = createClient(url, { username, password });
    this.clients.set(key, client);
    return client;
  }

  private async ensureRemoteDir(client: WebDAVClient, dirPath: string): Promise<void> {
    if (dirPath === '/' || dirPath === '.') return;
    if (await client.exists(dirPath)) return;
    
    // Ensure parent
    await this.ensureRemoteDir(client, path.dirname(dirPath));
    await client.createDirectory(dirPath);
  }

  private async cleanupRemote(client: WebDAVClient, rootPath: string, localVaultPath: string, localFiles: string[]): Promise<void> {
    const localSet = new Set(localFiles.map(f => PathUtils.toRelative(localVaultPath, f)));
    const vaultName = path.basename(localVaultPath);
    const prefix = `Obsync_${vaultName}/`;

    const scanAndDelete = async (remotePath: string) => {
      let items: any[];
      try {
        items = await client.getDirectoryContents(remotePath) as any[];
      } catch {
        return;
      }

      for (const item of items) {
        // Derive relPath by stripping everything up to and including "Obsync_VaultName/"
        const idx = item.filename.indexOf(prefix);
        const rel = idx >= 0 ? PathUtils.normalize(item.filename.substring(idx + prefix.length)) : '';
        if (!rel) continue;

        if (item.type === 'directory') {
          const localHasFolder = Array.from(localSet).some(f => f.startsWith(`${rel}/`));
          if (!localHasFolder) {
            logger.info(`Mirroring: Deleting WebDAV folder ${rel}`);
            await client.deleteFile(item.filename);
          } else {
            await scanAndDelete(item.filename);
          }
        } else {
          if (!localSet.has(rel)) {
            logger.info(`Mirroring: Deleting WebDAV file ${rel}`);
            await client.deleteFile(item.filename);
          }
        }
      }
    };

    await scanAndDelete(rootPath);
  }

  private getAllLocalFiles(vaultPath: string, dirPath: string = vaultPath, result: string[] = []): string[] {
    return collectVaultFiles(vaultPath, dirPath, result);
  }
}
