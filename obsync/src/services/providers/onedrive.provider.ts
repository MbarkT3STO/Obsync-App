import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import { createLogger } from '../../utils/logger.util';
import type { CloudCredentials, ICloudProvider, SyncResult } from '../../models/cloud-sync.model';

const logger = createLogger('OneDriveCloudProvider');

export class OneDriveCloudProvider implements ICloudProvider {
  async init(vaultPath: string, credentials: CloudCredentials): Promise<SyncResult> {
    return { success: true, message: 'OneDrive ready for sync' };
  }

  async clone(vaultPath: string, credentials: CloudCredentials): Promise<SyncResult> {
    if (!fs.existsSync(vaultPath)) fs.mkdirSync(vaultPath, { recursive: true });
    return this.pull(vaultPath, credentials);
  }

  async delete(vaultPath: string, relativePath: string, credentials: CloudCredentials): Promise<SyncResult> {
    try {
      const token = await this.getValidToken(credentials);
      const vaultName = path.basename(vaultPath);
      const rootPath = `Obsync_${vaultName}`;
      const onedrivePath = `${rootPath}/${relativePath.replace(/\\/g, '/')}`;
      const encodedPath = encodeURIComponent(onedrivePath);
      
      const res = await this.graphRequest('DELETE', `me/drive/root:/${encodedPath}`, token);
      // OneDrive returns 204 No Content on successful delete
      if (res.status === 204 || res.status === 200) {
        return { success: true, message: `Deleted ${relativePath} from OneDrive` };
      }
      return { success: false, message: `OneDrive delete error: ${JSON.stringify(res.data)}` };
    } catch (err) {
      return { success: false, message: `Delete failed: ${err instanceof Error ? err.message : 'Unknown'}` };
    }
  }

  async validate(credentials: CloudCredentials): Promise<SyncResult> {
    try {
      const token = await this.getValidToken(credentials);
      const res = await this.graphRequest('GET', 'me', token);
      if (res.status === 200) {
        return { success: true, message: `Connected as ${res.data.displayName}` };
      }
      return { success: false, message: `Access denied (Status ${res.status})` };
    } catch (err) {
      return { success: false, message: `Connection failed: ${err instanceof Error ? err.message : 'Unknown'}` };
    }
  }

  async push(vaultPath: string, credentials: CloudCredentials): Promise<SyncResult> {
    try {
      const token = await this.getValidToken(credentials);
      const vaultName = path.basename(vaultPath);
      const rootPath = `Obsync_${vaultName}`;
      
      const files = this.getAllLocalFiles(vaultPath);
      let pushed = 0;

      for (const filePath of files) {
        const relativePath = path.relative(vaultPath, filePath).replace(/\\/g, '/');
        if (relativePath.includes('.git/') || relativePath.includes('.obsidian/workspace')) continue;

        const onedrivePath = `${rootPath}/${relativePath}`;
        const content = fs.readFileSync(filePath);
        
        await this.uploadFile(onedrivePath, content, token);
        pushed++;
      }
 
      // Cloud Mirroring: Cleanup remote files that were deleted/renamed locally
      await this.cleanupRemote(rootPath, vaultPath, token, files);
 
      return { success: true, message: `Pushed ${pushed} file(s) to OneDrive (Cloud Mirrored)`, filesChanged: pushed };
    } catch (err) {
      logger.error('OneDrive Push Failed:', err);
      return { success: false, message: `Push failed: ${err instanceof Error ? err.message : 'Unknown'}` };
    }
  }

  private async cleanupRemote(rootPath: string, localVaultPath: string, token: string, localFiles: string[]): Promise<void> {
    const localRelativeFiles = new Set(localFiles.map(f => path.relative(localVaultPath, f).replace(/\\/g, '/')));
    
    const syncCleanup = async (currentPath: string) => {
      const res = await this.graphRequest('GET', `me/drive/root:/${currentPath}:/children`, token);
      if (res.status !== 200 || !res.data.value) return;
      
      for (const item of res.data.value) {
        const itemRelativePath = item.parentReference.path.includes(rootPath)
          ? item.parentReference.path.split(`${rootPath}:/`)[1] || ''
          : '';
        const relPath = itemRelativePath ? `${itemRelativePath}/${item.name}` : item.name;
        
        if (item.folder) {
          const localHasFolder = [...localRelativeFiles].some(f => f.startsWith(`${relPath}/`));
          if (!localHasFolder) {
            logger.info(`Mirroring: Deleting OneDrive folder ${relPath}`);
            await this.graphRequest('DELETE', `me/drive/items/${item.id}`, token);
          } else {
            await syncCleanup(`${rootPath}/${relPath}`);
          }
        } else {
          if (!localRelativeFiles.has(relPath)) {
            logger.info(`Mirroring: Deleting OneDrive file ${relPath}`);
            await this.graphRequest('DELETE', `me/drive/items/${item.id}`, token);
          }
        }
      }
    };
    
    await syncCleanup(rootPath);
  }
 
  async pushFile(vaultPath: string, relativePath: string, credentials: CloudCredentials): Promise<SyncResult> {
    try {
      const token = await this.getValidToken(credentials);
      const vaultName = path.basename(vaultPath);
      const rootPath = `Obsync_${vaultName}`;
      const onedrivePath = `${rootPath}/${relativePath.replace(/\\/g, '/')}`;
      const fullPath = path.join(vaultPath, relativePath);
      if (!fs.existsSync(fullPath)) return { success: false, message: 'Local file not found' };
      
      const content = fs.readFileSync(fullPath);
      await this.uploadFile(onedrivePath, content, token);
      return { success: true, message: `Pushed ${relativePath}` };
    } catch (err) {
      return { success: false, message: `Push file failed: ${err instanceof Error ? err.message : 'Unknown'}` };
    }
  }

  async pull(vaultPath: string, credentials: CloudCredentials): Promise<SyncResult> {
    try {
      const token = await this.getValidToken(credentials);
      const vaultName = path.basename(vaultPath);
      const rootPath = `Obsync_${vaultName}`;

      let pulled = 0;
      const remotePaths = new Set<string>();

      const syncFolder = async (currentPath: string) => {
        const endpoint = currentPath === rootPath 
          ? `me/drive/root:/${currentPath}:/children` 
          : `me/drive/root:/${currentPath}:/children`;
          
        const res = await this.graphRequest('GET', endpoint, token);
        
        if (res.status === 404) return; // Folder doesn't exist yet
        if (!res.data.value) return;

        for (const item of res.data.value) {
          const itemRelativePath = item.parentReference.path.includes(rootPath)
            ? item.parentReference.path.split(`${rootPath}:/`)[1] || ''
            : '';
          
          const relativePath = itemRelativePath ? `${itemRelativePath}/${item.name}` : item.name;
          remotePaths.add(relativePath);
          const localFilePath = path.join(vaultPath, relativePath);

          if (item.folder) {
            if (!fs.existsSync(localFilePath)) fs.mkdirSync(localFilePath, { recursive: true });
            await syncFolder(`${rootPath}/${relativePath}`);
          } else {
            let shouldDownload = !fs.existsSync(localFilePath);
            if (!shouldDownload) {
              const localStat = fs.statSync(localFilePath);
              const remoteTime = new Date(item.lastModifiedDateTime).getTime();
              if (remoteTime > localStat.mtime.getTime() + 2000) {
                shouldDownload = true;
              }
            }

            if (shouldDownload) {
              const content = await this.downloadFile(item.id, token);
              fs.writeFileSync(localFilePath, content);
              pulled++;
            }
          }
        }
      };

      await syncFolder(rootPath);
 
      // Safety Cleanup: Remove local files that don't exist in cloud (Deletions/Renames)
      const localFiles = this.getAllLocalFiles(vaultPath);
      const now = Date.now();
      
      for (const localFile of localFiles) {
        const relativePath = path.relative(vaultPath, localFile).replace(/\\/g, '/');
        if (relativePath.includes('.git/') || relativePath.includes('.obsidian/workspace')) continue;
        
        if (!remotePaths.has(relativePath)) {
          const stats = fs.statSync(localFile);
          if (now - stats.mtimeMs > 10000) {
            logger.info(`Pull Sync: Deleting local file missing from OneDrive: ${relativePath}`);
            fs.unlinkSync(localFile);
          }
        }
      }
 
      return { success: true, message: `Pulled ${pulled} file(s) from OneDrive`, filesChanged: pulled };
    } catch (err) {
      logger.error('OneDrive Pull Failed:', err);
      return { success: false, message: `Pull failed: ${err instanceof Error ? err.message : 'Unknown'}` };
    }
  }

  private async uploadFile(onedrivePath: string, content: Buffer, token: string): Promise<void> {
    const encodedPath = encodeURIComponent(onedrivePath);
    const res = await this.graphRequest('PUT', `me/drive/root:/${encodedPath}:/content`, token, content, {
      'Content-Type': 'application/octet-stream'
    });
    if (res.status >= 400) {
      throw new Error(`OneDrive Upload Error (${res.status}): ${JSON.stringify(res.data)}`);
    }
  }

  private async downloadFile(itemId: string, token: string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const options = {
        hostname: 'graph.microsoft.com',
        path: `/v1.0/me/drive/items/${itemId}/content`,
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${token}`,
          'User-Agent': 'Obsync/1.0.0'
        }
      };

      const req = https.request(options, (res) => {
        if (res.statusCode === 302) {
          // Handle redirect
          const redirectUrl = res.headers.location;
          if (!redirectUrl) return reject(new Error('No redirect URL provided for OneDrive download'));
          https.get(redirectUrl, (redirectRes) => {
            const chunks: Buffer[] = [];
            redirectRes.on('data', chunk => chunks.push(chunk));
            redirectRes.on('end', () => resolve(Buffer.concat(chunks)));
          }).on('error', reject);
        } else {
          const chunks: Buffer[] = [];
          res.on('data', chunk => chunks.push(chunk));
          res.on('end', () => resolve(Buffer.concat(chunks)));
        }
      });
      req.on('error', reject);
      req.end();
    });
  }

  private async graphRequest(method: string, endpoint: string, token: string, body?: any, extraHeaders?: any): Promise<any> {
    return new Promise((resolve, reject) => {
      const options = {
        hostname: 'graph.microsoft.com',
        path: `/v1.0/${endpoint}`,
        method: method,
        headers: {
          'Authorization': `Bearer ${token}`,
          'User-Agent': 'Obsync/1.0.0',
          ...extraHeaders
        }
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const json = data ? JSON.parse(data) : {};
            resolve({ status: res.statusCode || 0, data: json });
          } catch (e) {
            resolve({ status: res.statusCode || 0, data });
          }
        });
      });
      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    });
  }

  private async getValidToken(credentials: CloudCredentials): Promise<string> {
    try {
      if (!credentials.token) return '';
      const data = JSON.parse(credentials.token);
      if (typeof data === 'string') return data;
      if (data.expires_at && Date.now() < data.expires_at - 60000) return data.access_token;
      if (!data.refresh_token) return data.access_token;

      logger.info('OneDrive token expired, refreshing...');
      const refreshed = await this.refreshOAuthToken(data.refresh_token);
      return refreshed.access_token;
    } catch {
      return credentials.token;
    }
  }

  private async refreshOAuthToken(refreshToken: string): Promise<any> {
    return new Promise((resolve, reject) => {
      const params = new URLSearchParams({
        client_id: process.env.ONEDRIVE_CLIENT_ID || '',
        client_secret: process.env.ONEDRIVE_CLIENT_SECRET || '',
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
        scope: 'files.readwrite offline_access'
      });

      const options = {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': params.toString().length
        }
      };

      const req = https.request('https://login.microsoftonline.com/common/oauth2/v2.0/token', options, (res) => {
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
