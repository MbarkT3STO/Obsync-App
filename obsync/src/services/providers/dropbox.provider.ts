import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import { createLogger } from '../../utils/logger.util';
import type { CloudCredentials, ICloudProvider, SyncResult } from '../../models/cloud-sync.model';

const logger = createLogger('DropboxCloudProvider');

interface DropboxApiResponse {
  status: number;
  data: any;
}

export class DropboxCloudProvider implements ICloudProvider {
  async getChanges(vaultPath: string, credentials: CloudCredentials, cursor?: string): Promise<SyncResult & { cursor?: string; entries?: any[] }> {
    try {
      const token = await this.getValidToken(credentials);
      const vaultName = path.basename(vaultPath);
      const rootDir = `/Obsync_${vaultName}`;
      
      let res;
      if (cursor) {
        res = await this.apiPost('files/list_folder/continue', token, { cursor });
      } else {
        // Initial cursor from root
        res = await this.apiPost('files/list_folder', token, { path: rootDir, recursive: true });
      }
      
      if (res.status !== 200) {
        return { success: false, message: `Dropbox Delta Error: ${res.status}` };
      }
      
      const { entries, cursor: nextCursor, has_more } = res.data;
      return { 
        success: true, 
        message: 'Changes fetched', 
        cursor: nextCursor, 
        entries: entries 
      };
    } catch (err) {
      return { success: false, message: `Delta sync failed: ${err instanceof Error ? err.message : 'Unknown'}` };
    }
  }

  /**
   * Dropbox doesn't use IDs for folders in the same way for basic sync, 
   * but we can use paths.
   */

  async init(vaultPath: string, credentials: CloudCredentials): Promise<SyncResult> {
    return { success: true, message: 'Dropbox ready for sync' };
  }

  async clone(vaultPath: string, credentials: CloudCredentials): Promise<SyncResult> {
    // For cloud providers, clone is essentially just a pull into a new directory
    if (!fs.existsSync(vaultPath)) fs.mkdirSync(vaultPath, { recursive: true });
    return this.pull(vaultPath, credentials);
  }

  async delete(vaultPath: string, relativePath: string, credentials: CloudCredentials): Promise<SyncResult> {
    try {
      const token = await this.getValidToken(credentials);
      const vaultName = path.basename(vaultPath);
      const dbxPath = `/Obsync_${vaultName}/${relativePath.replace(/\\/g, '/')}`;
      
      const res = await this.apiPost('files/delete_v2', token, { path: dbxPath });
      if (res.status === 200) {
        return { success: true, message: `Deleted ${relativePath} from Dropbox` };
      }
      return { success: false, message: `Dropbox delete error: ${JSON.stringify(res.data)}` };
    } catch (err) {
      return { success: false, message: `Delete failed: ${err instanceof Error ? err.message : 'Unknown'}` };
    }
  }

  /**
   * Dropbox doesn't use IDs for folders in the same way for basic sync, 
   * but we can use paths.
   */

  async validate(credentials: CloudCredentials): Promise<SyncResult> {
    try {
      const token = await this.getValidToken(credentials);
      const res = await this.apiPost('users/get_current_account', token, null);
      if (res.status === 200) {
        return { success: true, message: `Connected as ${res.data.name.display_name}` };
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
      const rootDir = `/Obsync_${vaultName}`;
      
      const files = this.getAllLocalFiles(vaultPath);
      let pushed = 0;

      for (const filePath of files) {
        const relativePath = path.relative(vaultPath, filePath).replace(/\\/g, '/');
        if (relativePath.includes('.git/') || relativePath.includes('.obsidian/workspace')) continue;

        const dropboxPath = `${rootDir}/${relativePath}`;
        const content = fs.readFileSync(filePath);
        
        logger.info(`Pushing file to Dropbox: ${dropboxPath}`);
        await this.uploadFile(dropboxPath, content, token);
        pushed++;
      }
 
      // Cloud Mirroring: Cleanup remote files that were deleted/renamed locally
      await this.cleanupRemote(rootDir, vaultPath, token, files);
 
      return { success: true, message: `Pushed ${pushed} file(s) to Dropbox (Cloud Mirrored)`, filesChanged: pushed };
    } catch (err) {
      logger.error('Dropbox Push Failed:', err);
      return { success: false, message: `Push failed: ${err instanceof Error ? err.message : 'Unknown'}` };
    }
  }

  private async cleanupRemote(rootDir: string, localVaultPath: string, token: string, localFiles: string[]): Promise<void> {
    const localRelativeFiles = new Set(localFiles.map(f => path.relative(localVaultPath, f).replace(/\\/g, '/')));
    
    const syncCleanup = async (dbxPath: string) => {
      const res = await this.apiPost('files/list_folder', token, { path: dbxPath });
      if (res.status !== 200) return;
      
      for (const entry of res.data.entries) {
        const relPath = entry.path_display.substring(rootDir.length + 1);
        
        if (entry['.tag'] === 'folder') {
          const localHasFolder = [...localRelativeFiles].some(f => f.startsWith(`${relPath}/`));
          if (!localHasFolder) {
            logger.info(`Mirroring: Deleting Dropbox folder ${relPath}`);
            await this.apiPost('files/delete_v2', token, { path: entry.path_display });
          } else {
            await syncCleanup(entry.path_display);
          }
        } else {
          if (!localRelativeFiles.has(relPath)) {
            logger.info(`Mirroring: Deleting Dropbox file ${relPath}`);
            await this.apiPost('files/delete_v2', token, { path: entry.path_display });
          }
        }
      }
    };
    
    await syncCleanup(rootDir);
  }
 
  async pushFile(vaultPath: string, relativePath: string, credentials: CloudCredentials): Promise<SyncResult> {
    try {
      const token = await this.getValidToken(credentials);
      const vaultName = path.basename(vaultPath);
      const dbxPath = `/Obsync_${vaultName}/${relativePath.replace(/\\/g, '/')}`;
      const fullPath = path.join(vaultPath, relativePath);
      if (!fs.existsSync(fullPath)) return { success: false, message: 'Local file not found' };
      
      const content = fs.readFileSync(fullPath);
      await this.uploadFile(dbxPath, content, token);
      return { success: true, message: `Pushed ${relativePath}` };
    } catch (err) {
      return { success: false, message: `Push file failed: ${err instanceof Error ? err.message : 'Unknown'}` };
    }
  }

  async pull(vaultPath: string, credentials: CloudCredentials): Promise<SyncResult> {
    try {
      const token = await this.getValidToken(credentials);
      const vaultName = path.basename(vaultPath);
      const rootDir = `/Obsync_${vaultName}`;

      // Check if folder exists
      const checkRes = await this.apiPost('files/get_metadata', token, { path: rootDir });
      if (checkRes.status !== 200) {
        return { success: true, message: 'Cloud folder not found. Please click "Push" first to upload your vault to Dropbox.' };
      }

      let pulled = 0;
      const remotePaths = new Set<string>();

      const syncFolder = async (dbxPath: string) => {
        const res = await this.apiPost('files/list_folder', token, { path: dbxPath === rootDir ? rootDir : dbxPath });
        
        for (const entry of res.data.entries) {
          const relativePath = entry.path_display.substring(rootDir.length + 1);
          remotePaths.add(relativePath);
          const localPath = path.join(vaultPath, relativePath);

          if (entry['.tag'] === 'folder') {
            if (!fs.existsSync(localPath)) fs.mkdirSync(localPath, { recursive: true });
            await syncFolder(entry.path_display);
          } else {
            let shouldDownload = !fs.existsSync(localPath);
            if (!shouldDownload) {
              const localStat = fs.statSync(localPath);
              const remoteTime = new Date(entry.client_modified).getTime();
              if (remoteTime > localStat.mtime.getTime() + 2000) {
                shouldDownload = true;
              }
            }

            if (shouldDownload) {
              const content = await this.downloadFile(entry.path_display, token);
              fs.writeFileSync(localPath, content);
              pulled++;
            }
          }
        }

        if (res.data.has_more) {
          // Add continuation logic if needed, simplify for now
        }
      };

      await syncFolder(rootDir);
 
      // Safety Cleanup: Remove local files that don't exist in cloud (Deletions/Renames)
      // BUT don't delete files that are newer than 10 seconds (allows for local creation buffer)
      const localFiles = this.getAllLocalFiles(vaultPath);
      const now = Date.now();
      
      for (const localFile of localFiles) {
        const relativePath = path.relative(vaultPath, localFile).replace(/\\/g, '/');
        if (relativePath.includes('.git/') || relativePath.includes('.obsidian/workspace')) continue;
        
        if (!remotePaths.has(relativePath)) {
          const stats = fs.statSync(localFile);
          if (now - stats.mtimeMs > 10000) { // Only delete if older than 10s
            logger.info(`Pull Sync: Deleting local file not found in cloud: ${relativePath}`);
            fs.unlinkSync(localFile);
          }
        }
      }
 
      return { success: true, message: `Pulled ${pulled} file(s) from Dropbox`, filesChanged: pulled };
    } catch (err) {
      logger.error('Dropbox Pull Failed:', err);
      return { success: false, message: `Pull failed: ${err instanceof Error ? err.message : 'Unknown'}` };
    }
  }

  async pullFile(vaultPath: string, relativePath: string, credentials: CloudCredentials): Promise<SyncResult> {
    try {
      const token = await this.getValidToken(credentials);
      const vaultName = path.basename(vaultPath);
      const dbxPath = `/Obsync_${vaultName}/${relativePath.replace(/\\/g, '/')}`;
      
      const content = await this.downloadFile(dbxPath, token);
      const localPath = path.join(vaultPath, relativePath);
      const localDir = path.dirname(localPath);
      if (!fs.existsSync(localDir)) fs.mkdirSync(localDir, { recursive: true });
      
      // Atomic write: write to temp file then rename
      const tempPath = `${localPath}.tmp`;
      fs.writeFileSync(tempPath, content);
      fs.renameSync(tempPath, localPath);
      
      return { success: true, message: `Pulled ${relativePath}` };
    } catch (err) {
      return { success: false, message: `Pull file failed: ${err instanceof Error ? err.message : 'Unknown'}` };
    }
  }

  /**
   * Dropbox doesn't use IDs for folders in the same way for basic sync, 
   * but we can use paths.
   */
  private async uploadFile(dbxPath: string, content: Buffer, token: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const options = {
        hostname: 'content.dropboxapi.com',
        path: '/2/files/upload',
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Dropbox-API-Arg': JSON.stringify({
            path: dbxPath,
            mode: 'overwrite',
            mute: true
          }),
          'Content-Type': 'application/octet-stream',
          'Content-Length': content.length,
          'User-Agent': 'Obsync/1.0.0'
        }
      };

      const req = https.request(options, (res) => {
        if (res.statusCode === 200) resolve();
        else {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => reject(new Error(`Dropbox Upload Error (${res.statusCode}): ${data}`)));
        }
      });
      req.on('error', reject);
      req.write(content);
      req.end();
    });
  }

  private async downloadFile(dbxPath: string, token: string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const options = {
        hostname: 'content.dropboxapi.com',
        path: '/2/files/download',
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Dropbox-API-Arg': JSON.stringify({ path: dbxPath }),
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

  private async apiPost(endpoint: string, token: string, body: any): Promise<DropboxApiResponse> {
    return new Promise((resolve, reject) => {
      const options = {
        hostname: 'api.dropboxapi.com',
        path: `/2/${endpoint}`,
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': body ? 'application/json' : '',
          'User-Agent': 'Obsync/1.0.0'
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
      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  }

  private async getValidToken(credentials: CloudCredentials): Promise<string> {
    try {
      if (!credentials.token) return '';
      const data = JSON.parse(credentials.token);
      if (typeof data === 'string') return data;

      if (data.expires_at && Date.now() < data.expires_at - 60000) {
        return data.access_token;
      }

      if (!data.refresh_token) return data.access_token;

      logger.info('Dropbox token expired, refreshing...');
      const refreshed = await this.refreshOAuthToken(data.refresh_token);
      return refreshed.access_token;
    } catch {
      return credentials.token;
    }
  }

  private async refreshOAuthToken(refreshToken: string): Promise<any> {
    return new Promise((resolve, reject) => {
      const params = new URLSearchParams({
        client_id: process.env.DROPBOX_CLIENT_ID || '',
        client_secret: process.env.DROPBOX_CLIENT_SECRET || '',
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

      const req = https.request('https://api.dropboxapi.com/oauth2/token', options, (res) => {
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
