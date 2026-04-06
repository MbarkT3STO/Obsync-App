/**
 * DropboxProvider — syncs vault files to Dropbox.
 *
 * Storage layout:
 *   /Obsync/{vaultName}/                  ← vault root
 *   /Obsync/{vaultName}/obsync-manifest.json
 *
 * Auth: OAuth 2.0 PKCE with offline access (long-lived refresh token).
 *
 * Setup (free tier — 2 GB):
 *   1. Go to https://www.dropbox.com/developers/apps
 *   2. Create app → Scoped access → Full Dropbox
 *   3. Permissions: files.content.write, files.content.read, files.metadata.write,
 *      files.metadata.read, account_info.read
 *   4. Set DROPBOX_CLIENT_ID and DROPBOX_CLIENT_SECRET in .env
 */

import https from 'https';
import type {
  SyncProvider,
  ProviderCredentials,
  FileManifest,
} from '../SyncProvider';
import { createLogger } from '../../utils/logger.util';

const logger = createLogger('DropboxProvider');
const MANIFEST_NAME = 'obsync-manifest.json';
const REMOTE_ROOT = '/Obsync';

export class DropboxProvider implements SyncProvider {
  readonly id = 'dropbox';
  readonly name = 'Dropbox';
  readonly type = 'cloud' as const;
  readonly icon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor">
    <path d="M6 2L0 6l6 4-6 4 6 4 6-4-6-4 6-4zm12 0l-6 4 6 4-6 4 6 4 6-4-6-4 6-4zM6 16.5
    L12 20.5l6-4-6-4z"/>
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
      const res = await this.apiPost('users/get_current_account', token, null);
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
      const dbxPath = `${REMOTE_ROOT}/${this.vaultName}/${MANIFEST_NAME}`;
      const content = await this.downloadFromDropbox(dbxPath, token);
      return JSON.parse(content.toString('utf-8')) as FileManifest;
    } catch {
      return null;
    }
  }

  async uploadFile(relativePath: string, content: Buffer): Promise<void> {
    const token = await this.getValidToken();
    const dbxPath = `${REMOTE_ROOT}/${this.vaultName}/${relativePath.replace(/\\/g, '/')}`;
    await this.uploadToDropbox(dbxPath, content, token);
  }

  async downloadFile(relativePath: string): Promise<Buffer> {
    const token = await this.getValidToken();
    const dbxPath = `${REMOTE_ROOT}/${this.vaultName}/${relativePath.replace(/\\/g, '/')}`;
    return this.downloadFromDropbox(dbxPath, token);
  }

  async deleteRemoteFile(relativePath: string): Promise<void> {
    try {
      const token = await this.getValidToken();
      const dbxPath = `${REMOTE_ROOT}/${this.vaultName}/${relativePath.replace(/\\/g, '/')}`;
      await this.apiPost('files/delete_v2', token, { path: dbxPath });
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
    if (!creds) throw new Error('DropboxProvider: not connected');

    let data: any;
    try { data = JSON.parse(creds.token); } catch { return creds.token; }
    if (typeof data === 'string') return data;

    if (data.expires_at && Date.now() < data.expires_at - 60_000) return data.access_token;
    if (!data.refresh_token) return data.access_token;

    logger.info('Dropbox: refreshing token');
    const refreshed = await this.refreshToken(data.refresh_token);
    const newJson = JSON.stringify({
      access_token: refreshed.access_token,
      refresh_token: data.refresh_token, // Dropbox doesn't rotate refresh tokens
      expires_in: refreshed.expires_in,
      expires_at: Date.now() + (refreshed.expires_in ?? 14400) * 1000,
    });
    this.credentials = { ...creds, token: newJson };
    this.onTokenRefreshed?.(newJson);
    return refreshed.access_token;
  }

  private refreshToken(refreshToken: string): Promise<any> {
    return new Promise((resolve, reject) => {
      const params = new URLSearchParams({
        client_id: process.env['DROPBOX_CLIENT_ID'] ?? '',
        client_secret: process.env['DROPBOX_CLIENT_SECRET'] ?? '',
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      });
      const body = params.toString();
      const req = https.request(
        'https://api.dropboxapi.com/oauth2/token',
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

  // ── Dropbox API helpers ───────────────────────────────────────────────────

  private async uploadToDropbox(dbxPath: string, content: Buffer, token: string): Promise<void> {
    const CHUNK = 4 * 1024 * 1024;
    if (content.length <= 5 * 1024 * 1024) {
      await new Promise<void>((resolve, reject) => {
        const req = https.request(
          {
            hostname: 'content.dropboxapi.com',
            path: '/2/files/upload',
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${token}`,
              'Dropbox-API-Arg': JSON.stringify({ path: dbxPath, mode: 'overwrite', mute: true }),
              'Content-Type': 'application/octet-stream',
              'Content-Length': content.length,
            },
          },
          (res) => { res.resume(); res.on('end', () => res.statusCode === 200 ? resolve() : reject(new Error(`Dropbox upload ${res.statusCode}`))); },
        );
        req.on('error', reject);
        req.write(content);
        req.end();
      });
      return;
    }
    // Chunked upload session
    const startRes = await this.contentPost('files/upload_session/start', token, Buffer.alloc(0), { 'Dropbox-API-Arg': JSON.stringify({ close: false }) });
    const sessionId = startRes.data.session_id;
    let offset = 0;
    while (offset < content.length) {
      const end = Math.min(offset + CHUNK, content.length);
      const chunk = content.slice(offset, end);
      const isLast = end === content.length;
      if (!isLast) {
        await this.contentPost('files/upload_session/append_v2', token, chunk, {
          'Dropbox-API-Arg': JSON.stringify({ cursor: { session_id: sessionId, offset }, close: false }),
        });
      } else {
        await this.contentPost('files/upload_session/finish', token, chunk, {
          'Dropbox-API-Arg': JSON.stringify({ cursor: { session_id: sessionId, offset }, commit: { path: dbxPath, mode: 'overwrite', mute: true } }),
        });
      }
      offset = end;
    }
  }

  private contentPost(endpoint: string, token: string, body: Buffer, extraHeaders: Record<string, string>): Promise<{ status: number; data: any }> {
    return new Promise((resolve, reject) => {
      const req = https.request(
        {
          hostname: 'content.dropboxapi.com',
          path: `/2/${endpoint}`,
          method: 'POST',
          headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/octet-stream', ...extraHeaders },
        },
        (res) => {
          let d = '';
          res.on('data', (c) => (d += c));
          res.on('end', () => {
            try { resolve({ status: res.statusCode ?? 0, data: d ? JSON.parse(d) : {} }); }
            catch { resolve({ status: res.statusCode ?? 0, data: d }); }
          });
        },
      );
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  private downloadFromDropbox(dbxPath: string, token: string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const req = https.request(
        {
          hostname: 'content.dropboxapi.com',
          path: '/2/files/download',
          method: 'POST',
          headers: { 'Authorization': `Bearer ${token}`, 'Dropbox-API-Arg': JSON.stringify({ path: dbxPath }) },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            if ((res.statusCode ?? 0) >= 400) reject(new Error(`Dropbox download ${res.statusCode}`));
            else resolve(Buffer.concat(chunks));
          });
        },
      );
      req.on('error', reject);
      req.end();
    });
  }

  private apiPost(endpoint: string, token: string, body: any): Promise<{ status: number; data: any }> {
    return new Promise((resolve, reject) => {
      const bodyBytes = body ? Buffer.from(JSON.stringify(body), 'utf-8') : null;
      const req = https.request(
        {
          hostname: 'api.dropboxapi.com',
          path: `/2/${endpoint}`,
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            ...(bodyBytes ? { 'Content-Type': 'application/json', 'Content-Length': bodyBytes.length } : {}),
          },
        },
        (res) => {
          let d = '';
          res.on('data', (c) => (d += c));
          res.on('end', () => {
            try { resolve({ status: res.statusCode ?? 0, data: d ? JSON.parse(d) : {} }); }
            catch { resolve({ status: res.statusCode ?? 0, data: d }); }
          });
        },
      );
      req.on('error', reject);
      if (bodyBytes) req.write(bodyBytes);
      req.end();
    });
  }
}
