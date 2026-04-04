import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import { createLogger } from '../../utils/logger.util';
import { PathUtils } from '../../utils/path.util';
import { withRetry } from '../../utils/retry.util';
import { shouldSkipDir, shouldSyncFile, collectVaultFiles } from '../../utils/obsidian-filter.util';
import type { CloudCredentials, ICloudProvider, SyncResult } from '../../models/cloud-sync.model';
import { getCloudVaultName } from '../../utils/vault-name.util';

const logger = createLogger('OneDriveCloudProvider');

export class OneDriveCloudProvider implements ICloudProvider {
  onTokenRefreshed?: (newTokenJson: string) => void;
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
      const vaultName = getCloudVaultName(vaultPath, credentials);
      const rootPath = `Obsync_${vaultName}`;
      const onedrivePath = `${rootPath}/${relativePath.replace(/\\/g, '/')}`;
      
      const res = await this.graphRequest('DELETE', `me/drive/root:/${this.encodePath(onedrivePath)}`, token);
      if (res.status === 204 || res.status === 200) {
        return { success: true, message: `Deleted ${relativePath} from OneDrive` };
      }
      return { success: false, message: `OneDrive delete error: ${JSON.stringify(res.data)}` };
    } catch (err) {
      return { success: false, message: `Delete failed: ${err instanceof Error ? err.message : 'Unknown'}` };
    }
  }

  async getChanges(vaultPath: string, credentials: CloudCredentials, cursor?: string): Promise<SyncResult & { cursor?: string; entries?: any[] }> {
    try {
      const token = await this.getValidToken(credentials);
      const vaultName = getCloudVaultName(vaultPath, credentials);
      const rootPath = `Obsync_${vaultName}`;

      // Validate cursor — must be a full HTTPS URL (OneDrive deltaLink).
      // If it's missing, empty, or a leftover relative path from an old version, start fresh.
      const isValidCursor = (c?: string): boolean => {
        if (!c) return false;
        try { return new URL(c).protocol === 'https:'; } catch { return false; }
      };

      let firstUrl: string;
      if (isValidCursor(cursor)) {
        firstUrl = cursor!;
      } else {
        if (cursor) logger.warn(`OneDrive: discarding invalid cursor "${cursor.slice(0, 40)}..." — starting fresh`);
        firstUrl = `https://graph.microsoft.com/v1.0/me/drive/root:/${this.encodePath(rootPath)}:/delta`;
      }

      const allEntries: any[] = [];
      let nextUrl: string | null = firstUrl;
      let finalDeltaLink: string | undefined;

      while (nextUrl) {
        const res = await this.graphRequest('GET', nextUrl, token, undefined, undefined, true);

        if (res.status === 410) {
          logger.warn('OneDrive delta token expired (410), restarting full delta scan');
          return this.getChanges(vaultPath, credentials, undefined);
        }

        if (res.status === 400) {
          logger.warn(`OneDrive delta 400: ${JSON.stringify(res.data)} — falling back to full scan`);
          return this.getChanges(vaultPath, credentials, undefined);
        }

        if (res.status !== 200) {
          return { success: false, message: `OneDrive Delta Error: ${res.status} — ${JSON.stringify(res.data)}` };
        }

        allEntries.push(...(res.data.value || []));

        if (res.data['@odata.deltaLink']) {
          finalDeltaLink = res.data['@odata.deltaLink'];
          break;
        }

        nextUrl = res.data['@odata.nextLink'] || null;
      }

      const mappedEntries = allEntries.map((item: any) => {
        if (!item) return null;
        const isDeleted = !!item.deleted;
        const parentPath = PathUtils.decodeCloudPath(item.parentReference?.path || '');
        const cloudPath = parentPath ? `${parentPath}/${item.name}` : item.name;
        const relPath = PathUtils.toCloudRelative(cloudPath, rootPath);
        if (relPath === null) return null;
        return {
          '.tag': isDeleted ? 'deleted' : (item.folder ? 'folder' : 'file'),
          id: item.id,
          name: item.name,
          path_display: relPath,
          lastmod: item.lastModifiedDateTime,
          size: item.size ?? 0,
        };
      }).filter(Boolean);

      return {
        success: true,
        message: `${mappedEntries.length} change(s) fetched`,
        cursor: finalDeltaLink,
        entries: mappedEntries,
      };
    } catch (err) {
      return { success: false, message: `Delta sync failed: ${err instanceof Error ? err.message : 'Unknown'}` };
    }
  }

  async pullFile(vaultPath: string, relativePath: string, credentials: CloudCredentials): Promise<SyncResult> {
    try {
      const token = await this.getValidToken(credentials);
      const vaultName = getCloudVaultName(vaultPath, credentials);
      const rootPath = `Obsync_${vaultName}`;
      const onedrivePath = `${rootPath}/${relativePath.replace(/\\/g, '/')}`;
      
      const content = await this.downloadFile(`me/drive/root:/${this.encodePath(onedrivePath)}:/content`, token);
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

  async move(vaultPath: string, oldRelativePath: string, newRelativePath: string, credentials: CloudCredentials): Promise<SyncResult> {
    try {
      const token = await this.getValidToken(credentials);
      const vaultName = getCloudVaultName(vaultPath, credentials);
      const rootPath = `Obsync_${vaultName}`;
      const oldPath = `${rootPath}/${oldRelativePath.replace(/\\/g, '/')}`;
      const newPath = `${rootPath}/${newRelativePath.replace(/\\/g, '/')}`;
      const newDir = path.dirname(newPath);
      const newName = path.basename(newPath);

      const res = await this.graphRequest('PATCH', `me/drive/root:/${this.encodePath(oldPath)}`, token, {
        parentReference: { path: `/drive/root:/${newDir}` },
        name: newName
      });

      if (res.status === 200) {
        return { success: true, message: `Moved ${oldRelativePath} to ${newRelativePath}` };
      }
      return { success: false, message: `OneDrive move error: ${JSON.stringify(res.data)}` };
    } catch (err) {
      return { success: false, message: `Move failed: ${err instanceof Error ? err.message : 'Unknown'}` };
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

  async listVaults(credentials: CloudCredentials): Promise<string[]> {
    try {
      const token = await this.getValidToken(credentials);
      const res = await this.graphRequest('GET', 'me/drive/root/children?%24select=name%2Cfolder', token);
      if (res.status !== 200 || !res.data.value) return [];
      return (res.data.value as any[])
        .filter((item: any) => item.folder && item.name.startsWith('Obsync_'))
        .map((item: any) => item.name.replace(/^Obsync_/, ''));
    } catch {
      return [];
    }
  }

  async push(vaultPath: string, credentials: CloudCredentials): Promise<SyncResult> {
    try {
      const token = await this.getValidToken(credentials);
      const vaultName = getCloudVaultName(vaultPath, credentials);
      const rootPath = `Obsync_${vaultName}`;

      const files = collectVaultFiles(vaultPath);
      let pushed = 0;
      const failed: string[] = [];

      for (const filePath of files) {
        const relativePath = path.relative(vaultPath, filePath).replace(/\\/g, '/');
        try {
          const onedrivePath = `${rootPath}/${relativePath}`;
          const content = fs.readFileSync(filePath);
          await this.uploadFile(onedrivePath, content, token);
          pushed++;
        } catch (err) {
          logger.error(`Failed to push ${relativePath}:`, err);
          failed.push(relativePath);
        }
      }

      if (files.length > 0) {
        await this.cleanupRemote(rootPath, vaultPath, token, files);
      }

      const msg = failed.length
        ? `Pushed ${pushed} file(s), ${failed.length} failed: ${failed.slice(0, 3).join(', ')}${failed.length > 3 ? '...' : ''}`
        : `Pushed ${pushed} file(s) to OneDrive`;
      return { success: true, message: msg, filesChanged: pushed };
    } catch (err) {
      logger.error('OneDrive Push Failed:', err);
      return { success: false, message: `Push failed: ${err instanceof Error ? err.message : 'Unknown'}` };
    }
  }

  private async cleanupRemote(rootPath: string, localVaultPath: string, token: string, localFiles: string[]): Promise<void> {
    const localSet = new Set(
      localFiles.map(f => path.relative(localVaultPath, f).replace(/\\/g, '/'))
    );

    const scanAndDelete = async (currentPath: string) => {
      const res = await this.graphRequest('GET', `me/drive/root:/${this.encodePath(currentPath)}:/children`, token);
      if (res.status !== 200 || !res.data.value) return;

      for (const item of res.data.value) {
        const currentRel = currentPath.substring(rootPath.length).replace(/^\//, '');
        const relPath = currentRel ? `${currentRel}/${item.name}` : item.name;

        if (item.folder) {
          const localHasFolder = Array.from(localSet).some(f => f.startsWith(`${relPath}/`));
          if (!localHasFolder) {
            logger.info(`Mirroring: Deleting OneDrive folder ${relPath}`);
            await this.graphRequest('DELETE', `me/drive/items/${item.id}`, token);
          } else {
            await scanAndDelete(`${rootPath}/${relPath}`);
          }
        } else {
          if (!localSet.has(relPath)) {
            logger.info(`Mirroring: Deleting OneDrive file ${relPath}`);
            await this.graphRequest('DELETE', `me/drive/items/${item.id}`, token);
          }
        }
      }
    };

    await scanAndDelete(rootPath);
  }
 
  async pushFile(vaultPath: string, relativePath: string, credentials: CloudCredentials): Promise<SyncResult> {
    try {
      const token = await this.getValidToken(credentials);
      const vaultName = getCloudVaultName(vaultPath, credentials);
      const rootPath = `Obsync_${vaultName}`;
      const onedrivePath = `${rootPath}/${relativePath.replace(/\\/g, '/')}`;
      const fullPath = path.join(vaultPath, relativePath);
      if (!fs.existsSync(fullPath)) return { success: false, message: 'Local file not found' };
      
      const content = fs.readFileSync(fullPath);
      await withRetry(() => this.uploadFile(onedrivePath, content, token));
      return { success: true, message: `Pushed ${relativePath}` };
    } catch (err) {
      return { success: false, message: `Push file failed: ${err instanceof Error ? err.message : 'Unknown'}` };
    }
  }

  async pull(vaultPath: string, credentials: CloudCredentials): Promise<SyncResult & { entries?: any[] }> {
    try {
      const token = await this.getValidToken(credentials);
      const vaultName = getCloudVaultName(vaultPath, credentials);
      const rootPath = `Obsync_${vaultName}`;

      const entries: any[] = [];
      const syncFolder = async (currentPath: string) => {
        const endpoint = `me/drive/root:/${this.encodePath(currentPath)}:/children`;
        const res = await this.graphRequest('GET', endpoint, token);
        
        if (res.status === 404) return;
        if (!res.data.value) return;

        for (const item of res.data.value) {
          const cloudPath = PathUtils.decodeCloudPath(item.parentReference.path) + '/' + item.name;
          const relativePath = PathUtils.toCloudRelative(cloudPath, rootPath);
          if (relativePath === null) continue;
          
          entries.push({
            id: item.id,
            path_display: relativePath,
            name: item.name,
            size: item.size || 0,
            lastmod: item.lastModifiedDateTime,
            '.tag': item.folder ? 'folder' : 'file'
          });

          if (item.folder) {
            await syncFolder(`${rootPath}/${relativePath}`);
          }
        }
      };

      await syncFolder(rootPath);
 
      return { success: true, message: `Scanned ${entries.length} items from OneDrive`, entries };
    } catch (err) {
      logger.error('OneDrive Pull Failed:', err);
      return { success: false, message: `Pull failed: ${err instanceof Error ? err.message : 'Unknown'}` };
    }
  }

  private async uploadFile(onedrivePath: string, content: Buffer, token: string): Promise<void> {
    const CHUNK_SIZE = 320 * 1024; // OneDrive requires multiples of 320 KB
    const fileSize = content.length;

    // ── Simple upload for files ≤ 4 MB ──────────────────────────────────────
    if (fileSize <= 4 * 1024 * 1024) {
      const res = await this.graphRequest('PUT', `me/drive/root:/${this.encodePath(onedrivePath)}:/content`, token, content);
      if (res.status >= 400) {
        throw new Error(`OneDrive Simple Upload Error (${res.status}): ${JSON.stringify(res.data)}`);
      }
      return;
    }

    // ── Resumable upload session for large files ─────────────────────────────
    logger.info(`Starting chunked upload for ${onedrivePath} (${fileSize} bytes)`);
    const sessionRes = await this.graphRequest(
      'POST',
      `me/drive/root:/${this.encodePath(onedrivePath)}:/createUploadSession`,
      token,
      { item: { '@microsoft.graph.conflictBehavior': 'replace' } },
    );

    if (sessionRes.status !== 200) {
      throw new Error(`Failed to create OneDrive upload session: ${JSON.stringify(sessionRes.data)}`);
    }

    const uploadUrl: string = sessionRes.data.uploadUrl;
    let start = 0;

    while (start < fileSize) {
      const end = Math.min(start + CHUNK_SIZE, fileSize);
      const chunk = content.slice(start, end);
      const range = `bytes ${start}-${end - 1}/${fileSize}`;

      const chunkRes = await this.uploadChunk(uploadUrl, chunk, range);

      if (chunkRes.status !== 202 && chunkRes.status !== 201 && chunkRes.status !== 200) {
        throw new Error(`OneDrive Chunk Upload Failed at ${range}: ${JSON.stringify(chunkRes.data)}`);
      }
      start = end;
    }
  }

  /** Sends a single chunk to a pre-authenticated OneDrive upload session URL.
   *  Must NOT include an Authorization header — the URL itself carries the credentials. */
  private uploadChunk(uploadUrl: string, chunk: Buffer, range: string): Promise<{ status: number; data: any }> {
    return new Promise((resolve, reject) => {
      const url = new URL(uploadUrl);
      const options = {
        hostname: url.hostname,
        path: url.pathname + url.search,
        method: 'PUT',
        headers: {
          'Content-Length': chunk.length.toString(),
          'Content-Range': range,
          'Content-Type': 'application/octet-stream',
        },
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode ?? 0, data: data ? JSON.parse(data) : {} });
          } catch {
            resolve({ status: res.statusCode ?? 0, data });
          }
        });
      });
      req.on('error', reject);
      req.write(chunk);
      req.end();
    });
  }

  private async downloadFile(encodedEndpoint: string, token: string): Promise<Buffer> {
    // encodedEndpoint is already encoded by the caller (e.g. "me/drive/root:/Obsync_X%2FNotes.md:/content")
    return new Promise((resolve, reject) => {
      const options = {
        hostname: 'graph.microsoft.com',
        path: `/v1.0/${encodedEndpoint}`,
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${token}`,
          'User-Agent': 'Obsync/1.0.0'
        }
      };

      const req = https.request(options, (res) => {
        if (res.statusCode === 302) {
          const redirectUrl = res.headers.location;
          if (!redirectUrl) return reject(new Error('No redirect URL for OneDrive download'));
          https.get(redirectUrl, (redirectRes) => {
            const chunks: Buffer[] = [];
            redirectRes.on('data', (c: Buffer) => chunks.push(c));
            redirectRes.on('end', () => resolve(Buffer.concat(chunks)));
          }).on('error', reject);
        } else {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => resolve(Buffer.concat(chunks)));
        }
      });
      req.on('error', reject);
      req.end();
    });
  }

  /**
   * Encodes each segment of a slash-separated path with encodeURIComponent,
   * preserving the `/` separators. Used for Graph API path-based addressing:
   *   me/drive/root:/{encodePath(path)}:/content
   */
  private encodePath(p: string): string {
    return p.split('/').map(segment => encodeURIComponent(segment)).join('/');
  }

  private async graphRequest(method: string, endpoint: string, token: string, body?: any, extraHeaders?: Record<string, string>, isFullUrl = false): Promise<any> {
    return new Promise((resolve, reject) => {
      const isBuffer = body instanceof Buffer;
      const isJson = body && typeof body === 'object' && !isBuffer;

      // Serialise body up front so we know the exact byte length
      const bodyBytes: Buffer | null = body
        ? (isBuffer ? body : Buffer.from(JSON.stringify(body), 'utf8'))
        : null;

      let hostname: string;
      let urlPath: string;

      if (isFullUrl) {
        const url = new URL(endpoint);
        hostname = url.hostname;
        urlPath = url.pathname + url.search;
      } else {
        hostname = 'graph.microsoft.com';
        // endpoint is already correctly encoded by the caller — use as-is
        urlPath = `/v1.0/${endpoint}`;
      }

      const headers: Record<string, string> = {
        'Authorization': `Bearer ${token}`,
        'User-Agent': 'Obsync/1.0.0',
        ...extraHeaders,
      };

      if (bodyBytes) {
        headers['Content-Type'] = isJson ? 'application/json' : 'application/octet-stream';
        headers['Content-Length'] = bodyBytes.length.toString();
      }

      const options = { hostname, path: urlPath, method, headers };

      const req = https.request(options, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          try {
            resolve({ status: res.statusCode ?? 0, data: raw ? JSON.parse(raw) : {} });
          } catch {
            resolve({ status: res.statusCode ?? 0, data: raw });
          }
        });
      });
      req.on('error', reject);
      if (bodyBytes) req.write(bodyBytes);
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
      // Persist the refreshed token
      const newTokenJson = JSON.stringify({
        access_token: refreshed.access_token,
        refresh_token: refreshed.refresh_token || data.refresh_token,
        expires_in: refreshed.expires_in,
        expires_at: Date.now() + ((refreshed.expires_in ?? 3600) * 1000),
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

  private getAllLocalFiles(vaultPath: string, dirPath: string = vaultPath, result: string[] = []): string[] {
    return collectVaultFiles(vaultPath, dirPath, result);
  }
}
