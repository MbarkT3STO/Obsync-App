/**
 * OneDriveProvider — syncs vault files to Microsoft OneDrive.
 *
 * Storage layout:
 *   Obsync/{vaultName}/                  ← vault root folder
 *   Obsync/{vaultName}/obsync-manifest.json
 *
 * Auth: OAuth 2.0 via Microsoft identity platform.
 *
 * Setup (free tier — 5 GB):
 *   1. Go to https://portal.azure.com/ → Azure Active Directory → App registrations
 *   2. New registration → Supported account types: "Accounts in any organizational directory and personal Microsoft accounts"
 *   3. Redirect URI → Public client/native → http://localhost
 *   4. API permissions → Microsoft Graph → Files.ReadWrite, offline_access
 *   5. Set ONEDRIVE_CLIENT_ID and ONEDRIVE_CLIENT_SECRET in .env
 */

import https from 'https';
import type {
  SyncProvider,
  ProviderCredentials,
  FileManifest,
} from '../SyncProvider';
import { createLogger } from '../../utils/logger.util';

const logger = createLogger('OneDriveProvider');
const MANIFEST_NAME = 'obsync-manifest.json';
const REMOTE_ROOT = 'Obsync';

export class OneDriveProvider implements SyncProvider {
  readonly id = 'onedrive';
  readonly name = 'Microsoft OneDrive';
  readonly type = 'cloud' as const;
  readonly icon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor">
    <path d="M10.318 6.527A7.5 7.5 0 0 1 24 10.5a5.5 5.5 0 0 1-.79 10.997H6.5a5.5 5.5 0 0
    1-.663-10.963 7.5 7.5 0 0 1 4.481-4.007z"/>
  </svg>`;

  onTokenRefreshed?: (newTokenJson: string) => void;

  private credentials: ProviderCredentials | null = null;
  private vaultName: string = '';

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  async connect(credentials: ProviderCredentials): Promise<void> {
    this.credentials = credentials;
  }

  async disconnect(): Promise<void> {
    this.credentials = null;
  }

  async testConnection(): Promise<boolean> {
    try {
      const token = await this.getValidToken();
      const res = await this.graph('GET', 'me', token);
      return res.status === 200;
    } catch {
      return false;
    }
  }

  setVaultName(name: string): void {
    this.vaultName = name;
  }

  // ── Core sync operations ──────────────────────────────────────────────────

  async getRemoteManifest(): Promise<FileManifest | null> {
    try {
      const token = await this.getValidToken();
      const remotePath = `${REMOTE_ROOT}/${this.vaultName}/${MANIFEST_NAME}`;
      const content = await this.downloadByPath(remotePath, token);
      return JSON.parse(content.toString('utf-8')) as FileManifest;
    } catch {
      return null;
    }
  }

  async uploadFile(relativePath: string, content: Buffer): Promise<void> {
    const token = await this.getValidToken();
    const remotePath = `${REMOTE_ROOT}/${this.vaultName}/${relativePath.replace(/\\/g, '/')}`;
    await this.uploadByPath(remotePath, content, token);
  }

  async downloadFile(relativePath: string): Promise<Buffer> {
    const token = await this.getValidToken();
    const remotePath = `${REMOTE_ROOT}/${this.vaultName}/${relativePath.replace(/\\/g, '/')}`;
    return this.downloadByPath(remotePath, token);
  }

  async deleteRemoteFile(relativePath: string): Promise<void> {
    try {
      const token = await this.getValidToken();
      const remotePath = `${REMOTE_ROOT}/${this.vaultName}/${relativePath.replace(/\\/g, '/')}`;
      await this.graph('DELETE', `me/drive/root:/${this.encodePath(remotePath)}`, token);
    } catch (e) {
      logger.warn(`Delete failed for ${relativePath}:`, e);
    }
  }

  async uploadManifest(manifest: FileManifest): Promise<void> {
    const content = Buffer.from(JSON.stringify(manifest, null, 2), 'utf-8');
    await this.uploadFile(MANIFEST_NAME, content);
  }

  // ── Token management ──────────────────────────────────────────────────────

  private async getValidToken(): Promise<string> {
    const creds = this.credentials;
    if (!creds) throw new Error('OneDriveProvider: not connected');

    let data: any;
    try { data = JSON.parse(creds.token); } catch { return creds.token; }
    if (typeof data === 'string') return data;

    if (data.expires_at && Date.now() < data.expires_at - 60_000) return data.access_token;
    if (!data.refresh_token) return data.access_token;

    logger.info('OneDrive: refreshing token');
    const refreshed = await this.refreshToken(data.refresh_token);
    const newJson = JSON.stringify({
      access_token: refreshed.access_token,
      refresh_token: refreshed.refresh_token ?? data.refresh_token,
      expires_in: refreshed.expires_in,
      expires_at: Date.now() + (refreshed.expires_in ?? 3600) * 1000,
    });
    this.credentials = { ...creds, token: newJson };
    this.onTokenRefreshed?.(newJson);
    return refreshed.access_token;
  }

  private refreshToken(refreshToken: string): Promise<any> {
    return new Promise((resolve, reject) => {
      const params = new URLSearchParams({
        client_id: process.env['ONEDRIVE_CLIENT_ID'] ?? '',
        client_secret: process.env['ONEDRIVE_CLIENT_SECRET'] ?? '',
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
        scope: 'files.readwrite offline_access',
      });
      const body = params.toString();
      const req = https.request(
        'https://login.microsoftonline.com/common/oauth2/v2.0/token',
        { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': body.length } },
        (res) => {
          let d = '';
          res.on('data', (c) => (d += c));
          res.on('end', () => {
            try {
              const j = JSON.parse(d);
              j.access_token ? resolve(j) : reject(new Error(j.error_description ?? 'Refresh failed'));
            } catch { reject(new Error('Parse error')); }
          });
        },
      );
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  // ── Graph API helpers ─────────────────────────────────────────────────────

  private async uploadByPath(remotePath: string, content: Buffer, token: string): Promise<void> {
    const CHUNK = 320 * 1024; // OneDrive requires multiples of 320 KB
    if (content.length <= 4 * 1024 * 1024) {
      const res = await this.graph('PUT', `me/drive/root:/${this.encodePath(remotePath)}:/content`, token, content);
      if (res.status >= 400) throw new Error(`OneDrive upload error ${res.status}`);
      return;
    }
    // Resumable upload for large files
    const sessionRes = await this.graph(
      'POST',
      `me/drive/root:/${this.encodePath(remotePath)}:/createUploadSession`,
      token,
      { item: { '@microsoft.graph.conflictBehavior': 'replace' } },
    );
    if (sessionRes.status !== 200) throw new Error('Failed to create upload session');
    const uploadUrl: string = sessionRes.data.uploadUrl;
    let start = 0;
    while (start < content.length) {
      const end = Math.min(start + CHUNK, content.length);
      const chunk = content.slice(start, end);
      await this.uploadChunk(uploadUrl, chunk, start, content.length);
      start = end;
    }
  }

  private uploadChunk(url: string, chunk: Buffer, start: number, total: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const parsed = new URL(url);
      const req = https.request(
        { hostname: parsed.hostname, path: parsed.pathname + parsed.search, method: 'PUT',
          headers: { 'Content-Length': chunk.length, 'Content-Range': `bytes ${start}-${start + chunk.length - 1}/${total}`, 'Content-Type': 'application/octet-stream' } },
        (res) => { res.resume(); res.on('end', resolve); },
      );
      req.on('error', reject);
      req.write(chunk);
      req.end();
    });
  }

  private downloadByPath(remotePath: string, token: string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const req = https.request(
        { hostname: 'graph.microsoft.com', path: `/v1.0/me/drive/root:/${this.encodePath(remotePath)}:/content`, method: 'GET',
          headers: { 'Authorization': `Bearer ${token}` } },
        (res) => {
          if (res.statusCode === 302 && res.headers.location) {
            https.get(res.headers.location, (r) => {
              const chunks: Buffer[] = [];
              r.on('data', (c) => chunks.push(c));
              r.on('end', () => resolve(Buffer.concat(chunks)));
            }).on('error', reject);
          } else {
            const chunks: Buffer[] = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
              if ((res.statusCode ?? 0) >= 400) reject(new Error(`OneDrive download ${res.statusCode}`));
              else resolve(Buffer.concat(chunks));
            });
          }
        },
      );
      req.on('error', reject);
      req.end();
    });
  }

  private graph(method: string, endpoint: string, token: string, body?: any): Promise<{ status: number; data: any }> {
    return new Promise((resolve, reject) => {
      const isBuffer = body instanceof Buffer;
      const bodyBytes = body ? (isBuffer ? body : Buffer.from(JSON.stringify(body), 'utf-8')) : null;
      const headers: Record<string, string | number> = { 'Authorization': `Bearer ${token}` };
      if (bodyBytes) {
        headers['Content-Type'] = isBuffer ? 'application/octet-stream' : 'application/json';
        headers['Content-Length'] = bodyBytes.length;
      }
      const isFullUrl = endpoint.startsWith('https://');
      const parsed = isFullUrl ? new URL(endpoint) : null;
      const req = https.request(
        {
          hostname: parsed?.hostname ?? 'graph.microsoft.com',
          path: parsed ? parsed.pathname + parsed.search : `/v1.0/${endpoint}`,
          method,
          headers,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf-8');
            try { resolve({ status: res.statusCode ?? 0, data: raw ? JSON.parse(raw) : {} }); }
            catch { resolve({ status: res.statusCode ?? 0, data: raw }); }
          });
        },
      );
      req.on('error', reject);
      if (bodyBytes) req.write(bodyBytes);
      req.end();
    });
  }

  private encodePath(p: string): string {
    return p.split('/').map((s) => encodeURIComponent(s)).join('/');
  }
}
