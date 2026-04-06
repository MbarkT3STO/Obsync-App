/**
 * GoogleDriveProvider — syncs vault files to Google Drive.
 *
 * Storage layout:
 *   Obsync/{vaultName}/                  ← vault root folder
 *   Obsync/{vaultName}/obsync-manifest.json
 *
 * Auth: OAuth 2.0 with offline access (refresh token stored in TokenStore).
 *
 * Setup (free tier):
 *   1. Go to https://console.cloud.google.com/
 *   2. Create a project → Enable "Google Drive API"
 *   3. OAuth consent screen → External → add your email as test user
 *   4. Credentials → Create OAuth 2.0 Client ID → Desktop app
 *   5. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env
 */

import fs from 'fs';
import path from 'path';
import https from 'https';
import type {
  SyncProvider,
  ProviderCredentials,
  FileManifest,
} from '../SyncProvider';
import { createLogger } from '../../utils/logger.util';

const logger = createLogger('GoogleDriveProvider');
const MANIFEST_NAME = 'obsync-manifest.json';
const REMOTE_ROOT = 'Obsync';

export class GoogleDriveProvider implements SyncProvider {
  readonly id = 'googledrive';
  readonly name = 'Google Drive';
  readonly type = 'cloud' as const;
  readonly icon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor">
    <path d="M4.433 22.396l2.666-4.615H22.5l-2.666 4.615zm5.333-9.23L4.433 4.5H14.1l5.333
    9.23zm7.334 0l-2.667-4.615h5.334l2.666 4.615z"/>
  </svg>`;

  onTokenRefreshed?: (newTokenJson: string) => void;

  private credentials: ProviderCredentials | null = null;
  private vaultName: string = '';
  /** In-memory cache: vault-relative path → Drive file ID */
  private idCache = new Map<string, string>();

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  async connect(credentials: ProviderCredentials): Promise<void> {
    this.credentials = credentials;
  }

  async disconnect(): Promise<void> {
    this.credentials = null;
    this.idCache.clear();
  }

  async testConnection(): Promise<boolean> {
    try {
      const token = await this.getValidToken();
      const res = await this.api('GET', 'about?fields=user', token);
      return res.status === 200;
    } catch {
      return false;
    }
  }

  /** Must be called before any sync operations. */
  setVaultName(name: string): void {
    this.vaultName = name;
    this.idCache.clear();
  }

  // ── Core sync operations ──────────────────────────────────────────────────

  async getRemoteManifest(): Promise<FileManifest | null> {
    try {
      const token = await this.getValidToken();
      const rootId = await this.getOrCreateFolder('root', `${REMOTE_ROOT}/${this.vaultName}`, token);
      const fileId = await this.findFile(rootId, MANIFEST_NAME, token);
      if (!fileId) return null;
      const content = await this.downloadById(fileId, token);
      return JSON.parse(content.toString('utf-8')) as FileManifest;
    } catch (e) {
      logger.warn('Could not fetch remote manifest:', e);
      return null;
    }
  }

  async uploadFile(relativePath: string, content: Buffer): Promise<void> {
    const token = await this.getValidToken();
    const parts = relativePath.replace(/\\/g, '/').split('/');
    const fileName = parts.pop()!;
    const rootId = await this.getOrCreateFolder('root', `${REMOTE_ROOT}/${this.vaultName}`, token);
    const parentId = await this.ensureFolderPath(rootId, parts, token);
    await this.upsertFile(parentId, fileName, content, token, relativePath);
  }

  async downloadFile(relativePath: string): Promise<Buffer> {
    const token = await this.getValidToken();
    const parts = relativePath.replace(/\\/g, '/').split('/');
    const fileName = parts.pop()!;
    const rootId = await this.getOrCreateFolder('root', `${REMOTE_ROOT}/${this.vaultName}`, token);
    const parentId = await this.ensureFolderPath(rootId, parts, token);
    const fileId = await this.findFile(parentId, fileName, token);
    if (!fileId) throw new Error(`File not found on Drive: ${relativePath}`);
    return this.downloadById(fileId, token);
  }

  async deleteRemoteFile(relativePath: string): Promise<void> {
    try {
      const token = await this.getValidToken();
      const parts = relativePath.replace(/\\/g, '/').split('/');
      const fileName = parts.pop()!;
      const rootId = await this.getOrCreateFolder('root', `${REMOTE_ROOT}/${this.vaultName}`, token);
      const parentId = await this.ensureFolderPath(rootId, parts, token);
      const fileId = await this.findFile(parentId, fileName, token);
      if (fileId) {
        await this.api('DELETE', `files/${fileId}`, token);
        this.idCache.delete(`file:${relativePath}`);
      }
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
    if (!creds) throw new Error('GoogleDriveProvider: not connected');

    let data: any;
    try { data = JSON.parse(creds.token); } catch { return creds.token; }
    if (typeof data === 'string') return data;

    const buffer = 60_000;
    if (data.expires_at && Date.now() < data.expires_at - buffer) return data.access_token;
    if (!data.refresh_token) return data.access_token;

    logger.info('Google Drive: refreshing token');
    const refreshed = await this.refreshToken(data.refresh_token);
    const newJson = JSON.stringify({
      access_token: refreshed.access_token,
      refresh_token: data.refresh_token,
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
        client_id: process.env['GOOGLE_CLIENT_ID'] ?? '',
        client_secret: process.env['GOOGLE_CLIENT_SECRET'] ?? '',
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      });
      const body = params.toString();
      const req = https.request(
        'https://oauth2.googleapis.com/token',
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

  // ── Drive helpers ─────────────────────────────────────────────────────────

  private async getOrCreateFolder(parentId: string, folderPath: string, token: string): Promise<string> {
    const parts = folderPath.split('/').filter(Boolean);
    let currentId = parentId;
    let accumulated = '';
    for (const part of parts) {
      accumulated = accumulated ? `${accumulated}/${part}` : part;
      const cacheKey = `dir:${accumulated}`;
      if (this.idCache.has(cacheKey)) {
        currentId = this.idCache.get(cacheKey)!;
        continue;
      }
      const q = encodeURIComponent(
        `name = '${part}' and '${currentId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
      );
      const res = await this.api('GET', `files?q=${q}&fields=files(id)`, token);
      if (res.data.files?.length) {
        currentId = res.data.files[0].id;
      } else {
        const created = await this.api('POST', 'files', token, {
          name: part,
          mimeType: 'application/vnd.google-apps.folder',
          parents: [currentId],
        });
        currentId = created.data.id;
      }
      this.idCache.set(cacheKey, currentId);
    }
    return currentId;
  }

  private async ensureFolderPath(rootId: string, parts: string[], token: string): Promise<string> {
    if (parts.length === 0) return rootId;
    return this.getOrCreateFolder(rootId, parts.join('/'), token);
  }

  private async findFile(parentId: string, name: string, token: string): Promise<string | null> {
    const q = encodeURIComponent(
      `name = '${name}' and '${parentId}' in parents and mimeType != 'application/vnd.google-apps.folder' and trashed = false`,
    );
    const res = await this.api('GET', `files?q=${q}&fields=files(id)`, token);
    return res.data.files?.[0]?.id ?? null;
  }

  private async upsertFile(parentId: string, name: string, content: Buffer, token: string, pathKey: string): Promise<void> {
    const cacheKey = `file:${pathKey}`;
    let fileId = this.idCache.get(cacheKey) ?? await this.findFile(parentId, name, token);

    if (fileId) {
      await this.uploadMultipart(fileId, 'PATCH', name, content, token);
    } else {
      const res = await this.uploadMultipart(null, 'POST', name, content, token, parentId);
      fileId = res.data.id;
    }
    if (fileId) this.idCache.set(cacheKey, fileId);
  }

  private uploadMultipart(
    fileId: string | null,
    method: string,
    name: string,
    content: Buffer,
    token: string,
    parentId?: string,
  ): Promise<{ status: number; data: any }> {
    return new Promise((resolve, reject) => {
      const boundary = '-------obsync314159';
      const meta: any = { name };
      if (parentId) meta.parents = [parentId];
      const body = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}`),
        Buffer.from(`\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`),
        content,
        Buffer.from(`\r\n--${boundary}--`),
      ]);
      const type = fileId
        ? `files/${fileId}?uploadType=multipart`
        : 'files?uploadType=multipart';
      const url = new URL(`https://www.googleapis.com/upload/drive/v3/${type}`);
      const req = https.request(
        { hostname: url.hostname, path: url.pathname + url.search, method,
          headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': `multipart/related; boundary=${boundary}`, 'Content-Length': body.length } },
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

  private downloadById(fileId: string, token: string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const url = new URL(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`);
      const req = https.request(
        { hostname: url.hostname, path: url.pathname + url.search, method: 'GET',
          headers: { 'Authorization': `Bearer ${token}` } },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => resolve(Buffer.concat(chunks)));
        },
      );
      req.on('error', reject);
      req.end();
    });
  }

  private api(method: string, endpoint: string, token: string, body?: any): Promise<{ status: number; data: any }> {
    return new Promise((resolve, reject) => {
      const url = new URL(`https://www.googleapis.com/drive/v3/${endpoint}`);
      const bodyBytes = body ? Buffer.from(JSON.stringify(body), 'utf-8') : null;
      const headers: Record<string, string | number> = {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      };
      if (bodyBytes) headers['Content-Length'] = bodyBytes.length;
      const req = https.request(
        { hostname: url.hostname, path: url.pathname + url.search, method, headers },
        (res) => {
          let d = '';
          res.on('data', (c) => (d += c));
          res.on('end', () => {
            try {
              const json = d ? JSON.parse(d) : {};
              if ((res.statusCode ?? 0) >= 400) {
                return reject(new Error(`Drive API ${res.statusCode}: ${json.error?.message ?? d}`));
              }
              resolve({ status: res.statusCode ?? 0, data: json });
            } catch { resolve({ status: res.statusCode ?? 0, data: d }); }
          });
        },
      );
      req.on('error', reject);
      if (bodyBytes) req.write(bodyBytes);
      req.end();
    });
  }
}
