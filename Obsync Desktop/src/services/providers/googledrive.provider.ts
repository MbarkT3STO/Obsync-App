import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import { createLogger } from '../../utils/logger.util';
import { withRetry } from '../../utils/retry.util';
import { shouldSkipDir, shouldSyncFile, collectVaultFiles } from '../../utils/obsidian-filter.util';
import type { CloudCredentials, ICloudProvider, SyncResult } from '../../models/cloud-sync.model';
import { getCloudVaultName } from '../../utils/vault-name.util';

const logger = createLogger('GoogleDriveCloudProvider');

interface DriveApiResponse {
  status: number;
  data: any;
}

export class GoogleDriveCloudProvider implements ICloudProvider {
  onTokenRefreshed?: (newTokenJson: string) => void;
  async getChanges(vaultPath: string, credentials: CloudCredentials, cursor?: string): Promise<SyncResult & { cursor?: string; entries?: any[] }> {
    try {
      const token = await this.getValidToken(credentials);
      const vaultName = getCloudVaultName(vaultPath, credentials);
      const cloudRoot = `Obsync_${vaultName}`;

      // Find the vault root folder ID
      const rootRes = await withRetry(() =>
        this.driveApiRequest('GET', `files?q=${encodeURIComponent(`name = '${cloudRoot}' and 'root' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`)}&fields=files(id)`, token)
      );
      if (!rootRes.data.files?.length) {
        return { success: true, message: 'Vault folder not found on Drive', entries: [] };
      }
      const rootId = rootRes.data.files[0].id;

      // Use Drive Changes API with a page token (cursor).
      // Validate: Google Drive page tokens are numeric strings, not ISO dates or URLs.
      // Discard any cursor that looks like a legacy timestamp or is otherwise invalid.
      const isValidPageToken = (t?: string): boolean => {
        if (!t) return false;
        // Old code stored ISO timestamps — discard those
        if (t.includes('T') && t.includes('Z')) return false;
        // Must be a non-empty string that isn't a URL
        return t.length > 0 && !t.startsWith('http');
      };

      let pageToken = isValidPageToken(cursor) ? cursor : undefined;

      if (!pageToken) {
        if (cursor) logger.warn(`GDrive: discarding invalid cursor "${cursor.slice(0, 40)}" — starting fresh`);
        const startRes = await withRetry(() =>
          this.driveApiRequest('GET', 'changes/startPageToken', token)
        );
        pageToken = startRes.data.startPageToken;
        return this.listAllFiles(rootId, cloudRoot, token, pageToken);
      }

      // Fetch changes since last cursor
      const changesRes = await withRetry(() =>
        this.driveApiRequest('GET', `changes?pageToken=${pageToken}&fields=changes(file(id,name,mimeType,modifiedTime,size,parents,trashed)),nextPageToken,newStartPageToken`, token)
      );

      const nextCursor = changesRes.data.newStartPageToken || changesRes.data.nextPageToken || pageToken;
      const rawChanges: any[] = changesRes.data.changes || [];

      // Filter to only files within our vault root
      const entries: any[] = [];
      for (const change of rawChanges) {
        const file = change.file;
        if (!file) continue;
        // Check if this file is under our vault root by traversing parents
        const relPath = await this.getRelativePath(file.id, rootId, file.name, token);
        if (relPath === null) continue;

        entries.push({
          '.tag': file.trashed ? 'deleted' : (file.mimeType === 'application/vnd.google-apps.folder' ? 'folder' : 'file'),
          id: file.id,
          name: file.name,
          path_display: relPath,
          lastmod: file.modifiedTime,
          size: file.size || 0,
        });
      }

      return { success: true, message: `${entries.length} changes`, cursor: nextCursor, entries };
    } catch (err) {
      return { success: false, message: `GDrive Changes error: ${err instanceof Error ? err.message : 'Unknown'}` };
    }
  }

  /** Lists all files in the vault root folder (used on first sync) */
  private async listAllFiles(rootId: string, cloudRoot: string, token: string, nextCursor?: string): Promise<SyncResult & { cursor?: string; entries?: any[] }> {
    const entries: any[] = [];
    const scanFolder = async (folderId: string, relPrefix: string) => {
      const q = encodeURIComponent(`'${folderId}' in parents and trashed = false`);
      const res = await withRetry(() =>
        this.driveApiRequest('GET', `files?q=${q}&fields=files(id,name,mimeType,modifiedTime,size)`, token)
      );
      for (const file of res.data.files || []) {
        const relPath = relPrefix ? `${relPrefix}/${file.name}` : file.name;
        entries.push({
          '.tag': file.mimeType === 'application/vnd.google-apps.folder' ? 'folder' : 'file',
          id: file.id,
          name: file.name,
          path_display: relPath,
          lastmod: file.modifiedTime,
          size: file.size || 0,
        });
        if (file.mimeType === 'application/vnd.google-apps.folder') {
          await scanFolder(file.id, relPath);
        }
      }
    };
    await scanFolder(rootId, '');
    return { success: true, message: `Listed ${entries.length} files`, cursor: nextCursor, entries };
  }

  /** Resolves a file's path relative to the vault root, returns null if not under root */
  private async getRelativePath(fileId: string, rootId: string, fileName: string, token: string): Promise<string | null> {
    try {
      const parts: string[] = [fileName];
      let currentId = fileId;
      // Walk up the parent chain (max 20 levels)
      for (let i = 0; i < 20; i++) {
        const res = await this.driveApiRequest('GET', `files/${currentId}?fields=parents,name`, token);
        const parents: string[] = res.data.parents || [];
        if (parents.includes(rootId)) {
          return parts.slice(0, -1).reverse().join('/') || parts[0]!;
        }
        if (!parents.length) return null;
        const parentRes = await this.driveApiRequest('GET', `files/${parents[0]}?fields=id,name,parents`, token);
        if (parentRes.data.id === rootId) {
          return parts.reverse().join('/');
        }
        parts.push(parentRes.data.name);
        currentId = parents[0]!;
      }
      return null;
    } catch {
      return null;
    }
  }

  async pullFile(vaultPath: string, relativePath: string, credentials: CloudCredentials): Promise<SyncResult> {
    try {
      const token = await this.getValidToken(credentials);
      const parts = relativePath.replace(/\\/g, '/').split('/');
      const fileName = parts.pop()!;
      const vaultName = getCloudVaultName(vaultPath, credentials);
      
      const rootRes = await this.driveApiRequest('GET', `files?q=${encodeURIComponent(`name = 'Obsync_${vaultName}' and 'root' in parents`)}&fields=files(id)`, token);
      if (!rootRes.data.files?.length) return { success: false, message: 'Vault root not found' };
      
      const parentId = await this.getOrCreateFolderForPath(rootRes.data.files[0].id, parts, token);
      const q = encodeURIComponent(`name = '${fileName}' and '${parentId}' in parents and trashed = false`);
      const res = await this.driveApiRequest('GET', `files?q=${q}&fields=files(id)`, token);
      
      if (!res.data.files?.length) return { success: false, message: 'File not found on Drive' };
      
      const content = await this.downloadFile(res.data.files[0].id, token);
      const localPath = path.join(vaultPath, relativePath);
      const localDir = path.dirname(localPath);
      if (!fs.existsSync(localDir)) fs.mkdirSync(localDir, { recursive: true });
      
      const tempPath = `${localPath}.tmp`;
      fs.writeFileSync(tempPath, content);
      fs.renameSync(tempPath, localPath);
      
      return { success: true, message: `Pulled ${relativePath}` };
    } catch (err) {
      return { success: false, message: `Pull file failed: ${err instanceof Error ? err.message : 'Unknown'}` };
    }
  }

  async delete(vaultPath: string, relativePath: string, credentials: CloudCredentials): Promise<SyncResult> {
    try {
      const token = await this.getValidToken(credentials);
      const parts = relativePath.replace(/\\/g, '/').split('/');
      const fileName = parts.pop()!;
      const vaultName = getCloudVaultName(vaultPath, credentials);
      
      // Find root folder
      const rootRes = await this.driveApiRequest('GET', `files?q=${encodeURIComponent(`name = 'Obsync_${vaultName}' and 'root' in parents`)}&fields=files(id)`, token);
      if (!rootRes.data.files?.length) return { success: true, message: 'Root not found' };
      
      let currentParentId = rootRes.data.files[0].id;
      
      // Traverse to the file's parent
      for (const folderName of parts) {
        const q = encodeURIComponent(`name = '${folderName}' and '${currentParentId}' in parents and trashed = false`);
        const res = await this.driveApiRequest('GET', `files?q=${q}&fields=files(id)`, token);
        if (!res.data.files?.length) return { success: true, message: 'Path not found' };
        currentParentId = res.data.files[0].id;
      }
      
      // Find the actual file
      const q = encodeURIComponent(`name = '${fileName}' and '${currentParentId}' in parents and trashed = false`);
      const res = await this.driveApiRequest('GET', `files?q=${q}&fields=files(id)`, token);
      
      if (res.data.files && res.data.files.length > 0) {
        const fileId = res.data.files[0].id;
        await this.driveApiRequest('DELETE', `files/${fileId}`, token);
        // Clear from cache
        const cacheKey = `file:${relativePath.replace(/\\/g, '/')}`;
        this.idCache.delete(cacheKey);
        return { success: true, message: `Deleted ${relativePath}` };
      }
      
      return { success: true, message: 'File already gone' };
    } catch (err) {
      return { success: false, message: `Delete failed: ${err instanceof Error ? err.message : 'Unknown'}` };
    }
  }

  /** 
   * Maps relative paths to Google Drive IDs to avoid searching every time 
   */
  private idCache: Map<string, string> = new Map();

  async validate(credentials: CloudCredentials): Promise<SyncResult> {
    try {
      const token = await this.getValidToken(credentials);
      const res = await this.driveApiRequest('GET', 'about?fields=user', token);
      if (res.status === 200) {
        return { success: true, message: 'Google Drive connected' };
      }
      return { success: false, message: `Access denied (Status ${res.status})` };
    } catch (err) {
      return { success: false, message: `Connection failed: ${err instanceof Error ? err.message : 'Unknown'}` };
    }
  }

  async listVaults(credentials: CloudCredentials): Promise<string[]> {
    try {
      const token = await this.getValidToken(credentials);
      const q = encodeURIComponent(`'root' in parents and mimeType = 'application/vnd.google-apps.folder' and name contains 'Obsync_' and trashed = false`);
      const res = await this.driveApiRequest('GET', `files?q=${q}&fields=files(name)`, token);
      if (!res.data.files) return [];
      return (res.data.files as any[])
        .filter((f: any) => f.name.startsWith('Obsync_'))
        .map((f: any) => f.name.replace(/^Obsync_/, ''));
    } catch {
      return [];
    }
  }

  async push(vaultPath: string, credentials: CloudCredentials, skipCleanup = false, localFiles?: string[]): Promise<SyncResult> {
    try {
      const token = await this.getValidToken(credentials);
      const vaultName = getCloudVaultName(vaultPath, credentials);
      const rootFolderId = await this.getOrCreateFolder('root', `Obsync_${vaultName}`, token);

      const files = localFiles ?? collectVaultFiles(vaultPath);
      let pushed = 0;
      const failed: string[] = [];

      for (const filePath of files) {
        const relativePath = path.relative(vaultPath, filePath).replace(/\\/g, '/');
        try {
          const parts = relativePath.split('/');
          const fileName = parts.pop()!;
          const parentId = await this.getOrCreateFolderForPath(rootFolderId, parts, token);
          const content = fs.readFileSync(filePath);
          await this.uploadFile(parentId, fileName, content, token, relativePath);
          pushed++;
        } catch (err) {
          logger.error(`Failed to push ${relativePath}:`, err);
          failed.push(relativePath);
        }
      }

      if (!skipCleanup) {
        await this.cleanupRemote(rootFolderId, vaultPath, token, files);
      }

      const msg = failed.length
        ? `Pushed ${pushed} file(s), ${failed.length} failed: ${failed.slice(0, 3).join(', ')}${failed.length > 3 ? '...' : ''}`
        : `Pushed ${pushed} file(s) to Google Drive`;
      return { success: true, message: msg, filesChanged: pushed };
    } catch (err) {
      logger.error('Google Drive Push Failed:', err);
      return { success: false, message: `Push failed: ${err instanceof Error ? err.message : 'Unknown'}` };
    }
  }

  private async cleanupRemote(parentId: string, localVaultPath: string, token: string, localFiles: string[]): Promise<void> {
    const localSet = new Set(
      localFiles.map(f => path.relative(localVaultPath, f).replace(/\\/g, '/'))
    );

    const scanAndDelete = async (folderId: string, folderRelPath: string) => {
      const q = encodeURIComponent(`'${folderId}' in parents and trashed = false`);
      const res = await this.driveApiRequest('GET', `files?q=${q}&fields=files(id,name,mimeType)`, token);
      if (!res.data.files) return;

      for (const file of res.data.files) {
        const relPath = folderRelPath ? `${folderRelPath}/${file.name}` : file.name;

        if (file.mimeType === 'application/vnd.google-apps.folder') {
          const localHasFolder = Array.from(localSet).some(f => f.startsWith(`${relPath}/`));
          if (!localHasFolder) {
            logger.info(`Mirroring: Deleting remote folder ${relPath}`);
            await this.driveApiRequest('DELETE', `files/${file.id}`, token);
          } else {
            await scanAndDelete(file.id, relPath);
          }
        } else {
          if (!localSet.has(relPath)) {
            logger.info(`Mirroring: Deleting remote file ${relPath}`);
            await this.driveApiRequest('DELETE', `files/${file.id}`, token);
          }
        }
      }
    };

    await scanAndDelete(parentId, '');
  }
 
  async pushFile(vaultPath: string, relativePath: string, credentials: CloudCredentials): Promise<SyncResult> {
    try {
      const token = await this.getValidToken(credentials);
      const vaultName = getCloudVaultName(vaultPath, credentials);
      const rootFolderId = await this.getOrCreateFolder('root', `Obsync_${vaultName}`, token);
      
      const fullPath = path.join(vaultPath, relativePath);
      if (!fs.existsSync(fullPath)) return { success: false, message: 'Local file not found' };
      
      const parts = relativePath.replace(/\\/g, '/').split('/');
      const fileName = parts.pop()!;
      const parentId = await this.getOrCreateFolderForPath(rootFolderId, parts, token);
      
      const content = fs.readFileSync(fullPath);
      await withRetry(() => this.uploadFile(parentId, fileName, content, token, relativePath.replace(/\\/g, '/')));
      return { success: true, message: `Pushed ${relativePath}` };
    } catch (err) {
      return { success: false, message: `Push file failed: ${err instanceof Error ? err.message : 'Unknown'}` };
    }
  }

  private async getOrCreateFolderForPath(rootId: string, parts: string[], token: string): Promise<string> {
    let currentParentId = rootId;
    let subPath = '';
    for (const folderName of parts) {
      subPath = subPath ? `${subPath}/${folderName}` : folderName;
      currentParentId = await this.getOrCreateFolder(currentParentId, folderName, token, subPath);
    }
    return currentParentId;
  }

  async pull(vaultPath: string, credentials: CloudCredentials): Promise<SyncResult> {
    try {
      const token = await this.getValidToken(credentials);
      logger.info(`Starting pull from Google Drive to ${vaultPath}`);
      const vaultName = getCloudVaultName(vaultPath, credentials);
      const q = encodeURIComponent(`name = 'Obsync_${vaultName}' and 'root' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`);
      const rootRes = await this.driveApiRequest('GET', `files?q=${q}&fields=files(id)`, token);
      
      if (!rootRes.data.files || rootRes.data.files.length === 0) {
        return { success: true, message: 'Google Drive vault not found' };
      }

      const rootFolderId = rootRes.data.files[0].id;
      let pulled = 0;
      const remotePaths = new Set<string>();

      // Recursive cloud listing and downloading
      const syncFolder = async (folderId: string, currentLocalPath: string) => {
        const query = encodeURIComponent(`'${folderId}' in parents and trashed = false`);
        const res = await this.driveApiRequest('GET', `files?q=${query}&fields=files(id, name, mimeType, modifiedTime, size)`, token);
        
        for (const file of res.data.files) {
          const localFilePath = path.join(currentLocalPath, file.name);
          const relativePath = path.relative(vaultPath, localFilePath).replace(/\\/g, '/');
          remotePaths.add(relativePath);

          if (file.mimeType === 'application/vnd.google-apps.folder') {
            if (!fs.existsSync(localFilePath)) fs.mkdirSync(localFilePath, { recursive: true });
            await syncFolder(file.id, localFilePath);
          } else {
            // Check if local file exists and is older than remote
            let shouldDownload = !fs.existsSync(localFilePath);
            if (!shouldDownload) {
              const localStat = fs.statSync(localFilePath);
              const remoteTime = new Date(file.modifiedTime).getTime();
              // Drive modifiedTime precision is ms, but local can vary. Add 2s grace.
              if (remoteTime > localStat.mtime.getTime() + 2000) {
                shouldDownload = true;
              }
            }

            if (shouldDownload) {
              logger.info(`Downloading changed file: ${file.name}`);
              const content = await this.downloadFile(file.id, token);
              fs.writeFileSync(localFilePath, content);
              pulled++;
            }
          }
        }
      };

      await syncFolder(rootFolderId, vaultPath);
 
      // Safety Cleanup: Remove local files that don't exist in cloud (Deletions/Renames)
      const localFiles = collectVaultFiles(vaultPath);
      const now = Date.now();
      
      for (const localFile of localFiles) {
        const relativePath = path.relative(vaultPath, localFile).replace(/\\/g, '/');
        
        if (!remotePaths.has(relativePath)) {
          const stats = fs.statSync(localFile);
          if (now - stats.mtimeMs > 10000) {
            logger.info(`Pull Sync: Deleting local file missing from Drive: ${relativePath}`);
            fs.unlinkSync(localFile);
          }
        }
      }
 
      return { success: true, message: `Pulled ${pulled} file(s) from Google Drive`, filesChanged: pulled };
    } catch (err) {
      logger.error('Google Drive Pull Failed:', err);
      return { success: false, message: `Pull failed: ${err instanceof Error ? err.message : 'Unknown'}` };
    }
  }

  private async downloadFile(fileId: string, token: string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const fullUrl = new URL(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`);
      const options = {
        hostname: fullUrl.hostname,
        path: fullUrl.pathname + fullUrl.search,
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${token}`,
          'User-Agent': 'Obsync/1.0.0'
        }
      };
      const req = https.request(options, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => resolve(Buffer.concat(chunks)));
      });
      req.on('error', reject);
      req.end();
    });
  }

  async init(vaultPath: string, credentials: CloudCredentials): Promise<SyncResult> {
    return { success: true, message: 'Google Drive ready for sync' };
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private async getOrCreateFolder(parentId: string, folderName: string, token: string, pathKey?: string): Promise<string> {
    const cacheKey = pathKey ? `dir:${pathKey}` : `dir:${parentId}:${folderName}`;
    if (this.idCache.has(cacheKey)) return this.idCache.get(cacheKey)!;

    // Search
    const q = encodeURIComponent(`name = '${folderName}' and '${parentId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`);
    const res = await this.driveApiRequest('GET', `files?q=${q}&fields=files(id)`, token);
    
    if (res.data.files && res.data.files.length > 0) {
      const id = res.data.files[0].id;
      this.idCache.set(cacheKey, id);
      return id;
    }

    // Create
    const createRes = await this.driveApiRequest('POST', 'files', token, {
      name: folderName,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentId]
    });
    
    this.idCache.set(cacheKey, createRes.data.id);
    return createRes.data.id;
  }

  private async uploadFile(parentId: string, fileName: string, content: Buffer, token: string, pathKey: string): Promise<string> {
    const cacheKey = `file:${pathKey}`;
    let fileId = this.idCache.get(cacheKey);

    if (!fileId) {
      const q = encodeURIComponent(`name = '${fileName}' and '${parentId}' in parents and mimeType != 'application/vnd.google-apps.folder' and trashed = false`);
      const res = await this.driveApiRequest('GET', `files?q=${q}&fields=files(id)`, token);
      if (res.data.files && res.data.files.length > 0) {
        fileId = res.data.files[0].id;
        this.idCache.set(cacheKey, fileId!);
      }
    }

    if (fileId) {
      // Update existing
      await this.driveApiUpload(fileId, 'PATCH', fileName, content, token);
      return fileId;
    } else {
      // Create new
      const res = await this.driveApiUpload(null, 'POST', fileName, content, token, parentId);
      this.idCache.set(cacheKey, res.data.id);
      return res.data.id;
    }
  }

  private async driveApiRequest(method: string, endpoint: string, token: string, body?: any): Promise<DriveApiResponse> {
    return new Promise((resolve, reject) => {
      // Use URL class for safe construction to avoid double-encoding
      const fullUrl = new URL(`https://www.googleapis.com/drive/v3/${endpoint}`);
      
      const options = {
        hostname: fullUrl.hostname,
        path: fullUrl.pathname + fullUrl.search,
        method: method,
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'User-Agent': 'Obsync/1.0.0'
        }
      };

      const req = https.request(options, (res: any) => {
        let data = '';
        res.on('data', (chunk: any) => data += chunk);
        res.on('end', () => {
          try {
            const json = data ? JSON.parse(data) : {};
            if (res.statusCode && res.statusCode >= 400) {
              let msg = json.error?.message || data;
              if (res.statusCode === 401) {
                msg = 'Access expired. Please sign in again in settings to enable auto-refresh.';
              }
              return reject(new Error(`Drive API Error (${res.statusCode}): ${msg}`));
            }
            resolve({ status: res.statusCode || 0, data: json });
          } catch (e) {
            resolve({ status: res.statusCode || 0, data });
          }
        });
      });

      req.on('error', reject);
      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  }

  private async driveApiUpload(fileId: string | null, method: string, name: string, content: Buffer, token: string, parentId?: string): Promise<DriveApiResponse> {
    return new Promise((resolve, reject) => {
      const boundary = '-------314159265358979323846';
      const delimiter = `--${boundary}\r\n`;
      const midDelimiter = `\r\n--${boundary}\r\n`;
      const closeDelimiter = `\r\n--${boundary}--`;

      const metadata: any = { name };
      if (parentId) metadata.parents = [parentId];

      const multipartBody = Buffer.concat([
        Buffer.from(delimiter + 'Content-Type: application/json; charset=UTF-8\r\n\r\n' + JSON.stringify(metadata)),
        Buffer.from(midDelimiter + 'Content-Type: application/octet-stream\r\n\r\n'),
        content,
        Buffer.from(closeDelimiter)
      ]);

      const type = fileId ? `files/${fileId}?uploadType=multipart` : 'files?uploadType=multipart';
      const fullUrl = new URL(`https://www.googleapis.com/upload/drive/v3/${type}`);

      const options = {
        hostname: fullUrl.hostname,
        path: fullUrl.pathname + fullUrl.search,
        method: method,
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': `multipart/related; boundary=${boundary}`,
          'Content-Length': multipartBody.length,
          'User-Agent': 'Obsync/1.0.0'
        }
      };

      const req = https.request(options, (res: any) => {
        let data = '';
        res.on('data', (chunk: any) => data += chunk);
        res.on('end', () => {
          try {
            const json = JSON.parse(data || '{}');
            if (res.statusCode && res.statusCode >= 400) {
              let msg = json.error?.message || data;
              if (res.statusCode === 401) {
                msg = 'Access expired. Please sign in again in settings to enable auto-refresh.';
              }
              return reject(new Error(`Drive Upload Error (${res.statusCode}): ${msg}`));
            }
            resolve({ status: res.statusCode || 0, data: json });
          } catch (e) {
            resolve({ status: res.statusCode || 0, data });
          }
        });
      });

      req.on('error', reject);
      req.write(multipartBody);
      req.end();
    });
  }

  private async getValidToken(credentials: CloudCredentials): Promise<string> {
    try {
      if (!credentials.token) return '';
      const length = credentials.token.length;
      const isJson = credentials.token.trim().startsWith('{');
      logger.info(`Processing token (length: ${length}, isJson: ${isJson})`);

      const data = JSON.parse(credentials.token);
      if (typeof data === 'string') return data;

      const buffer = 60 * 1000;
      if (data.expires_at && Date.now() < data.expires_at - buffer) {
        return data.access_token;
      }

      if (!data.refresh_token) {
        return data.access_token;
      }

      logger.info('Google Drive token expired, refreshing...');
      const refreshed = await this.refreshOAuthToken(data.refresh_token);
      // Persist the refreshed token
      const newTokenJson = JSON.stringify({
        access_token: refreshed.access_token,
        refresh_token: data.refresh_token,
        expires_in: refreshed.expires_in,
        expires_at: Date.now() + ((refreshed.expires_in ?? 3600) * 1000),
      });
      this.onTokenRefreshed?.(newTokenJson);
      return refreshed.access_token;
    } catch (e) {
      return credentials.token;
    }
  }

  private async refreshOAuthToken(refreshToken: string): Promise<any> {
    return new Promise((resolve, reject) => {
      const https = require('https') as typeof import('https');
      const params = new URLSearchParams({
        client_id: process.env.GOOGLE_CLIENT_ID || '',
        client_secret: process.env.GOOGLE_CLIENT_SECRET || '',
        refresh_token: refreshToken,
        grant_type: 'refresh_token'
      });

      const options = {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': params.toString().length
        }
      };

      const req = https.request('https://oauth2.googleapis.com/token', options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            if (json.access_token) resolve(json);
            else reject(new Error(json.error_description || 'Refresh failed'));
          } catch (e) {
            reject(new Error('Failed to parse refresh response'));
          }
        });
      });
      req.on('error', reject);
      req.write(params.toString());
      req.end();
    });
  }

  private getAllLocalFiles(vaultPath: string, dirPath: string = vaultPath, result: string[] = []): string[] {
    return collectVaultFiles(vaultPath, dirPath, result);
  }
}
