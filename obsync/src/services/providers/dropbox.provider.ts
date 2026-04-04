import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import { createLogger } from '../../utils/logger.util';
import { PathUtils } from '../../utils/path.util';
import { withRetry } from '../../utils/retry.util';
import { shouldSkipDir, shouldSyncFile, collectVaultFiles } from '../../utils/obsidian-filter.util';
import type { CloudCredentials, ICloudProvider, SyncResult } from '../../models/cloud-sync.model';
import { getCloudVaultName } from '../../utils/vault-name.util';

const logger = createLogger('DropboxCloudProvider');

interface DropboxApiResponse {
  status: number;
  data: any;
}

export class DropboxCloudProvider implements ICloudProvider {
  onTokenRefreshed?: (newTokenJson: string) => void;
  async getChanges(vaultPath: string, credentials: CloudCredentials, cursor?: string): Promise<SyncResult & { cursor?: string; entries?: any[] }> {
    try {
      const token = await this.getValidToken(credentials);
      const vaultName = getCloudVaultName(vaultPath, credentials);
      const rootDir = `/Obsync_${vaultName}`;

      let res;
      if (cursor) {
        res = await this.apiPost('files/list_folder/continue', token, { cursor });
        // Expired or invalid cursor — reset and do a full listing
        if (res.status === 400 || res.status === 401 || res.data?.error?.['.tag'] === 'reset') {
          logger.warn(`Dropbox cursor invalid (${res.status}) — restarting full listing`);
          res = await this.apiPost('files/list_folder', token, { path: rootDir, recursive: true });
        }
      } else {
        res = await this.apiPost('files/list_folder', token, { path: rootDir, recursive: true });
      }

      if (res.status !== 200) {
        return { success: false, message: `Dropbox Delta Error: ${res.status}` };
      }

      const { entries, cursor: nextCursor, has_more } = res.data;

      const mappedEntries = (entries as any[]).map((entry: any) => {
        if (!entry) return null;
        const relPath = PathUtils.toCloudRelative(entry.path_display || '', `Obsync_${vaultName}`);
        if (relPath === null) return null;
        return { ...entry, path_display: relPath };
      }).filter(Boolean);

      return {
        success: true,
        message: 'Changes fetched',
        cursor: nextCursor,
        entries: mappedEntries,
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
      const vaultName = getCloudVaultName(vaultPath, credentials);
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

  async move(vaultPath: string, oldRelativePath: string, newRelativePath: string, credentials: CloudCredentials): Promise<SyncResult> {
    try {
      const token = await this.getValidToken(credentials);
      const vaultName = getCloudVaultName(vaultPath, credentials);
      const rootDir = `/Obsync_${vaultName}`;
      const fromPath = `${rootDir}/${oldRelativePath.replace(/\\/g, '/')}`;
      const toPath = `${rootDir}/${newRelativePath.replace(/\\/g, '/')}`;

      const res = await this.apiPost('files/move_v2', token, {
        from_path: fromPath,
        to_path: toPath,
        allow_shared_folder: true,
        autorename: false,
        allow_ownership_transfer: false
      });

      if (res.status === 200) {
        return { success: true, message: `Moved ${oldRelativePath} to ${newRelativePath}` };
      }
      return { success: false, message: `Dropbox move error: ${JSON.stringify(res.data)}` };
    } catch (err) {
      return { success: false, message: `Move failed: ${err instanceof Error ? err.message : 'Unknown'}` };
    }
  }

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

  async listVaults(credentials: CloudCredentials): Promise<string[]> {
    try {
      const token = await this.getValidToken(credentials);
      const res = await this.apiPost('files/list_folder', token, { path: '', recursive: false });
      if (res.status !== 200 || !res.data.entries) return [];
      return (res.data.entries as any[])
        .filter((e: any) => e['.tag'] === 'folder' && e.name.startsWith('Obsync_'))
        .map((e: any) => e.name.replace(/^Obsync_/, ''));
    } catch {
      return [];
    }
  }

  async push(vaultPath: string, credentials: CloudCredentials): Promise<SyncResult> {
    try {
      const token = await this.getValidToken(credentials);
      const vaultName = getCloudVaultName(vaultPath, credentials);
      const rootDir = `/Obsync_${vaultName}`;

      const files = collectVaultFiles(vaultPath);
      let pushed = 0;
      const failed: string[] = [];

      for (const filePath of files) {
        const relativePath = path.relative(vaultPath, filePath).replace(/\\/g, '/');
        const dropboxPath = `${rootDir}/${relativePath}`;
        try {
          const content = fs.readFileSync(filePath);
          logger.info(`Pushing to Dropbox: ${dropboxPath}`);
          await this.uploadFile(dropboxPath, content, token);
          pushed++;
        } catch (err) {
          logger.error(`Failed to push ${relativePath}:`, err);
          failed.push(relativePath);
        }
      }

      await this.cleanupRemote(rootDir, vaultPath, token, files);

      const msg = failed.length
        ? `Pushed ${pushed} file(s), ${failed.length} failed: ${failed.slice(0, 3).join(', ')}${failed.length > 3 ? '...' : ''}`
        : `Pushed ${pushed} file(s) to Dropbox`;
      return { success: true, message: msg, filesChanged: pushed };
    } catch (err) {
      logger.error('Dropbox Push Failed:', err);
      return { success: false, message: `Push failed: ${err instanceof Error ? err.message : 'Unknown'}` };
    }
  }

  private async cleanupRemote(rootDir: string, localVaultPath: string, token: string, localFiles: string[]): Promise<void> {
    // Dropbox normalizes all paths to lowercase — match that when comparing
    const localSet = new Set(
      localFiles.map(f => path.relative(localVaultPath, f).replace(/\\/g, '/').toLowerCase())
    );

    const scanAndDelete = async (dbxPath: string) => {
      const res = await this.apiPost('files/list_folder', token, { path: dbxPath, recursive: false });
      if (res.status !== 200) return;

      for (const entry of res.data.entries) {
        // Strip the root prefix to get the vault-relative path, then lowercase
        const relPath = entry.path_lower.substring(rootDir.toLowerCase().length + 1);
        if (!relPath) continue;

        if (entry['.tag'] === 'folder') {
          const localHasFolder = Array.from(localSet).some(f => f.startsWith(`${relPath}/`));
          if (!localHasFolder) {
            logger.info(`Mirroring: Deleting Dropbox folder ${relPath}`);
            await this.apiPost('files/delete_v2', token, { path: entry.path_display });
          } else {
            await scanAndDelete(entry.path_display);
          }
        } else {
          if (!localSet.has(relPath)) {
            logger.info(`Mirroring: Deleting Dropbox file ${relPath}`);
            await this.apiPost('files/delete_v2', token, { path: entry.path_display });
          }
        }
      }
    };

    await scanAndDelete(rootDir);
  }
 
  async pushFile(vaultPath: string, relativePath: string, credentials: CloudCredentials): Promise<SyncResult> {
    try {
      const token = await this.getValidToken(credentials);
      const vaultName = getCloudVaultName(vaultPath, credentials);
      const dbxPath = `/Obsync_${vaultName}/${relativePath.replace(/\\/g, '/')}`;
      const fullPath = path.join(vaultPath, relativePath);
      if (!fs.existsSync(fullPath)) return { success: false, message: 'Local file not found' };
      
      const content = fs.readFileSync(fullPath);
      await withRetry(() => this.uploadFile(dbxPath, content, token));
      return { success: true, message: `Pushed ${relativePath}` };
    } catch (err) {
      return { success: false, message: `Push file failed: ${err instanceof Error ? err.message : 'Unknown'}` };
    }
  }

  async pull(vaultPath: string, credentials: CloudCredentials): Promise<SyncResult & { entries?: any[] }> {
    try {
      const token = await this.getValidToken(credentials);
      const vaultName = getCloudVaultName(vaultPath, credentials);
      const rootDir = `/Obsync_${vaultName}`;

      const entries: any[] = [];
      const syncFolder = async (dbxPath: string) => {
        const res = await this.apiPost('files/list_folder', token, { path: dbxPath, recursive: true });
        if (res.status !== 200) return;
        
        for (const entry of res.data.entries) {
          const relativePath = PathUtils.toCloudRelative(entry.path_display || '', rootDir);
          if (relativePath === null) continue;
          
          entries.push({
            id: entry.id,
            path_display: relativePath,
            name: entry.name,
            size: entry.size || 0,
            lastmod: entry.client_modified || entry.server_modified,
            '.tag': entry['.tag']
          });
        }

        if (res.data.has_more) {
           // Basic recursive true handles most, but if has_more we'd need list_folder/continue
           // For pull scan, recursive:true in Dropbox covers the whole tree in one go usually
        }
      };

      await syncFolder(rootDir);
      return { success: true, message: `Scanned ${entries.length} items from Dropbox`, entries };
    } catch (err) {
      logger.error('Dropbox Fetch Failed:', err);
      return { success: false, message: `Cloud scan failed: ${err instanceof Error ? err.message : 'Unknown'}` };
    }
  }

  async pullFile(vaultPath: string, relativePath: string, credentials: CloudCredentials): Promise<SyncResult> {
    try {
      const token = await this.getValidToken(credentials);
      const vaultName = getCloudVaultName(vaultPath, credentials);
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
    const CHUNK_SIZE = 4 * 1024 * 1024; // 4MB chunks
    const fileSize = content.length;

    // Simple upload for small files (under 5MB)
    if (fileSize <= 5 * 1024 * 1024) {
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
            res.on('end', () => reject(new Error(`Dropbox Simple Upload Error (${res.statusCode}): ${data}`)));
          }
        });
        req.on('error', reject);
        req.write(content);
        req.end();
      });
    }

    // Large file: Chunked upload session
    logger.info(`Starting Dropbox chunked upload for ${dbxPath} (${fileSize} bytes)`);
    
    // 1. Start Session
    const startRes = await this.apiPostRaw('files/upload_session/start', 'content', token, Buffer.alloc(0), {
      'Dropbox-API-Arg': JSON.stringify({ close: false })
    });
    if (startRes.status !== 200) throw new Error(`Dropbox Start Session Failed: ${JSON.stringify(startRes.data)}`);
    
    const sessionId = startRes.data.session_id;
    let start = 0;

    // 2. Append Chunks
    while (start < fileSize) {
      const end = Math.min(start + CHUNK_SIZE, fileSize);
      const chunk = content.slice(start, end);
      const isLast = end === fileSize;

      if (!isLast) {
        const appendRes = await this.apiPostRaw('files/upload_session/append_v2', 'content', token, chunk, {
          'Dropbox-API-Arg': JSON.stringify({
             cursor: { session_id: sessionId, offset: start },
             close: false
          })
        });
        if (appendRes.status !== 200) throw new Error(`Dropbox Append Failed at ${start}: ${JSON.stringify(appendRes.data)}`);
      } else {
        // 3. Finish Session
        const finishRes = await this.apiPostRaw('files/upload_session/finish', 'content', token, chunk, {
          'Dropbox-API-Arg': JSON.stringify({
             cursor: { session_id: sessionId, offset: start },
             commit: { path: dbxPath, mode: 'overwrite', mute: true }
          })
        });
        if (finishRes.status !== 200) throw new Error(`Dropbox Finish Failed: ${JSON.stringify(finishRes.data)}`);
      }
      start = end;
    }
  }

  private async apiPostRaw(endpoint: string, subdomain: 'api' | 'content', token: string, body: Buffer, extraHeaders: any): Promise<DropboxApiResponse> {
    return new Promise((resolve, reject) => {
      const options = {
        hostname: `${subdomain}.dropboxapi.com`,
        path: `/2/${endpoint}`,
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/octet-stream',
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
      req.write(body);
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
      // Persist the refreshed token
      const newTokenJson = JSON.stringify({
        access_token: refreshed.access_token,
        refresh_token: data.refresh_token, // Dropbox doesn't rotate refresh tokens
        expires_in: refreshed.expires_in,
        expires_at: Date.now() + ((refreshed.expires_in ?? 14400) * 1000),
      });
      this.onTokenRefreshed?.(newTokenJson);
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

  private getAllLocalFiles(vaultPath: string, dirPath: string = vaultPath, result: string[] = []): string[] {
    return collectVaultFiles(vaultPath, dirPath, result);
  }
}
