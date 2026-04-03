import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import { createLogger } from '../../utils/logger.util';
import type { CloudCredentials, ICloudProvider, SyncResult } from '../../models/cloud-sync.model';

const logger = createLogger('GoogleDriveCloudProvider');

interface DriveApiResponse {
  status: number;
  data: any;
}

export class GoogleDriveCloudProvider implements ICloudProvider {
  /** 
   * Maps relative paths to Google Drive IDs to avoid searching every time 
   */
  private idCache: Map<string, string> = new Map();

  async validate(credentials: CloudCredentials): Promise<SyncResult> {
    try {
      const res = await this.driveApiRequest('GET', 'about?fields=user', credentials.token);
      if (res.status === 200) {
        return { success: true, message: 'Google Drive connected' };
      }
      return { success: false, message: `Access denied (Status ${res.status})` };
    } catch (err) {
      return { success: false, message: `Connection failed: ${err instanceof Error ? err.message : 'Unknown'}` };
    }
  }

  async push(vaultPath: string, credentials: CloudCredentials): Promise<SyncResult> {
    try {
      logger.info(`Starting push to Google Drive for ${vaultPath}`);
      const vaultName = path.basename(vaultPath);
      const rootFolderId = await this.getOrCreateFolder('root', `Obsync_${vaultName}`, credentials.token);
      
      const files = this.getAllLocalFiles(vaultPath);
      let pushed = 0;

      for (const filePath of files) {
        const relativePath = path.relative(vaultPath, filePath).replace(/\\/g, '/');
        // Ignore .git and temp obsidian files
        if (relativePath.includes('.git/') || relativePath.includes('.obsidian/workspace')) continue;

        const parts = relativePath.split('/');
        const fileName = parts.pop()!;
        let currentParentId = rootFolderId;

        // Traverse / create subfolders
        let subPath = '';
        for (const folderName of parts) {
          subPath = subPath ? `${subPath}/${folderName}` : folderName;
          currentParentId = await this.getOrCreateFolder(currentParentId, folderName, credentials.token, subPath);
        }

        // Upload file
        const content = fs.readFileSync(filePath);
        await this.uploadFile(currentParentId, fileName, content, credentials.token, relativePath);
        pushed++;
      }

      return { success: true, message: `Pushed ${pushed} file(s) to Google Drive`, filesChanged: pushed };
    } catch (err) {
      logger.error('Google Drive Push Failed:', err);
      return { success: false, message: `Push failed: ${err instanceof Error ? err.message : 'Unknown'}` };
    }
  }

  async pull(vaultPath: string, credentials: CloudCredentials): Promise<SyncResult> {
    try {
      logger.info(`Starting pull from Google Drive to ${vaultPath}`);
      const vaultName = path.basename(vaultPath);
      const q = encodeURIComponent(`name = 'Obsync_${vaultName}' and 'root' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`);
      const rootRes = await this.driveApiRequest('GET', `files?q=${q}&fields=files(id)`, credentials.token);
      
      if (!rootRes.data.files || rootRes.data.files.length === 0) {
        return { success: true, message: 'Google Drive vault not found' };
      }

      const rootFolderId = rootRes.data.files[0].id;
      let pulled = 0;
      const remotePaths = new Set<string>();

      // Recursive cloud listing and downloading
      const syncFolder = async (folderId: string, currentLocalPath: string) => {
        const query = encodeURIComponent(`'${folderId}' in parents and trashed = false`);
        const res = await this.driveApiRequest('GET', `files?q=${query}&fields=files(id, name, mimeType, modifiedTime, size)`, credentials.token);
        
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
              const content = await this.downloadFile(file.id, credentials.token);
              fs.writeFileSync(localFilePath, content);
              pulled++;
            }
          }
        }
      };

      await syncFolder(rootFolderId, vaultPath);

      // Cleanup local files that don't exist in cloud (Deletions/Renames)
      const localFiles = this.getAllLocalFiles(vaultPath);
      for (const localFile of localFiles) {
        const relativePath = path.relative(vaultPath, localFile).replace(/\\/g, '/');
        // Don't delete .git or obsidian workspace
        if (relativePath.includes('.git/') || relativePath.includes('.obsidian/workspace')) continue;
        
        if (!remotePaths.has(relativePath)) {
          logger.info(`Deleting local file not found in cloud: ${relativePath}`);
          fs.unlinkSync(localFile);
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
              return reject(new Error(`Drive API Error (${res.statusCode}): ${json.error?.message || data}`));
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
              return reject(new Error(`Drive Upload Error (${res.statusCode}): ${json.error?.message || data}`));
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

  private getAllLocalFiles(dirPath: string, arrayOfFiles: string[] = []): string[] {
    const files = fs.readdirSync(dirPath);
    files.forEach((file: string) => {
      const fullPath = path.join(dirPath, file);
      if (fs.statSync(fullPath).isDirectory()) {
        arrayOfFiles = this.getAllLocalFiles(fullPath, arrayOfFiles);
      } else {
        arrayOfFiles.push(fullPath);
      }
    });
    return arrayOfFiles;
  }
}
