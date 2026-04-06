/**
 * UpdaterService — lightweight auto-updater using GitHub Releases API.
 *
 * Uses Node's built-in https module — no electron-updater dependency.
 * Only runs in packaged builds (app.isPackaged === true).
 *
 * Flow:
 *  1. 30s after launch → silent check
 *  2. If newer version found → download .exe/.dmg in background
 *  3. Progress events → renderer (thin progress bar at top of window)
 *  4. On download complete → "Update ready" banner in renderer
 *  5. "Restart Now" → shell.openPath(installer) + app.quit()
 *  6. "Later" → banner dismissed for session; installer stays on disk
 *  7. Errors → logged only, never shown to user (unless manual check)
 */

import https from 'https';
import fs from 'fs';
import path from 'path';
import { app, BrowserWindow, shell } from 'electron';
import { createLogger } from '../utils/logger.util';
import { IPC } from '../config/ipc-channels';

const logger = createLogger('UpdaterService');

const GITHUB_OWNER = 'MbarkT3STO';
const GITHUB_REPO  = 'Obsync-App';
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // re-check every 4 hours

export interface UpdateInfo {
  version: string;
  releaseUrl: string;
  downloadUrl: string;
  publishedAt: string;
}

export class UpdaterService {
  private checkTimer: ReturnType<typeof setTimeout> | null = null;
  private intervalTimer: ReturnType<typeof setInterval> | null = null;
  private pendingInstaller: string | null = null;
  private dismissed = false;
  private lastChecked: Date | null = null;
  private lastCheckResult: 'up-to-date' | 'update-available' | 'error' | null = null;

  private getWindow: () => BrowserWindow | null;

  constructor(getWindow: () => BrowserWindow | null) {
    this.getWindow = getWindow;
  }

  /** Start the updater — called once after app is ready. */
  start(): void {
    if (!app.isPackaged) {
      logger.info('Updater disabled in development mode');
      return;
    }

    // First check: 30 seconds after launch
    this.checkTimer = setTimeout(() => {
      this.silentCheck();
      // Then re-check every 4 hours
      this.intervalTimer = setInterval(() => this.silentCheck(), CHECK_INTERVAL_MS);
    }, 30_000);
  }

  stop(): void {
    if (this.checkTimer)    clearTimeout(this.checkTimer);
    if (this.intervalTimer) clearInterval(this.intervalTimer);
  }

  /** Silent background check — errors are swallowed. */
  private async silentCheck(): Promise<void> {
    try {
      const info = await this.fetchLatestRelease();
      if (!info) return;
      this.lastChecked = new Date();
      this.lastCheckResult = 'up-to-date';

      if (this.isNewer(info.version, app.getVersion())) {
        this.lastCheckResult = 'update-available';
        logger.info(`Update available: ${info.version}`);
        await this.downloadInBackground(info);
      }
    } catch (e) {
      logger.warn('Silent update check failed:', e);
      this.lastCheckResult = 'error';
    }
  }

  /** Manual check triggered from Settings — surfaces errors to the caller. */
  async manualCheck(): Promise<{ upToDate: boolean; version?: string; error?: string }> {
    try {
      const info = await this.fetchLatestRelease();
      this.lastChecked = new Date();

      if (!info) {
        this.lastCheckResult = 'up-to-date';
        return { upToDate: true };
      }

      if (this.isNewer(info.version, app.getVersion())) {
        this.lastCheckResult = 'update-available';
        // Start download if not already downloading
        if (!this.pendingInstaller) {
          await this.downloadInBackground(info);
        }
        return { upToDate: false, version: info.version };
      }

      this.lastCheckResult = 'up-to-date';
      return { upToDate: true };
    } catch (e) {
      this.lastCheckResult = 'error';
      const msg = e instanceof Error ? e.message : String(e);
      logger.error('Manual update check failed:', e);
      return { upToDate: false, error: msg };
    }
  }

  /** Install the downloaded update immediately. */
  async installNow(): Promise<void> {
    if (!this.pendingInstaller || !fs.existsSync(this.pendingInstaller)) {
      logger.warn('installNow called but no installer on disk');
      return;
    }
    logger.info(`Installing update: ${this.pendingInstaller}`);
    await shell.openPath(this.pendingInstaller);
    app.quit();
  }

  /** Dismiss the banner for this session (update still installs on next quit). */
  dismiss(): void {
    this.dismissed = true;
  }

  getLastChecked(): Date | null { return this.lastChecked; }
  getLastCheckResult() { return this.lastCheckResult; }
  getCurrentVersion(): string { return app.getVersion(); }

  // ── Private helpers ────────────────────────────────────────────────────────

  private async fetchLatestRelease(): Promise<UpdateInfo | null> {
    const data = await this.httpsGet(
      `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`
    );
    const release = JSON.parse(data);

    if (!release?.tag_name) return null;

    const version = release.tag_name.replace(/^v/, '');
    const platform = process.platform;

    // Find the right asset for this platform
    const assets: Array<{ name: string; browser_download_url: string }> = release.assets ?? [];
    let downloadUrl = '';

    if (platform === 'win32') {
      const asset = assets.find(a => a.name.endsWith('.exe') && !a.name.includes('arm'));
      downloadUrl = asset?.browser_download_url ?? '';
    } else if (platform === 'darwin') {
      const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
      const asset = assets.find(a => a.name.endsWith('.dmg') && a.name.includes(arch))
        ?? assets.find(a => a.name.endsWith('.dmg'));
      downloadUrl = asset?.browser_download_url ?? '';
    }

    if (!downloadUrl) return null;

    return {
      version,
      releaseUrl: release.html_url,
      downloadUrl,
      publishedAt: release.published_at,
    };
  }

  private async downloadInBackground(info: UpdateInfo): Promise<void> {
    const win = this.getWindow();
    const tmpDir = app.getPath('temp');
    const ext = info.downloadUrl.split('.').pop() ?? 'exe';
    const dest = path.join(tmpDir, `obsync-update-${info.version}.${ext}`);

    // Already downloaded
    if (fs.existsSync(dest)) {
      this.pendingInstaller = dest;
      if (!this.dismissed) this.sendUpdateReady(info);
      return;
    }

    logger.info(`Downloading update ${info.version} to ${dest}`);

    try {
      await this.downloadFile(info.downloadUrl, dest, (percent) => {
        win?.webContents.send(IPC.EVENT_UPDATE_PROGRESS, { percent });
      });

      this.pendingInstaller = dest;
      logger.info(`Update downloaded: ${dest}`);

      if (!this.dismissed) {
        this.sendUpdateReady(info);
      }
    } catch (e) {
      logger.error('Update download failed:', e);
      // Clean up partial file
      if (fs.existsSync(dest)) fs.unlinkSync(dest);
    }
  }

  private sendUpdateReady(info: UpdateInfo): void {
    const win = this.getWindow();
    win?.webContents.send(IPC.EVENT_UPDATE_READY, {
      version: info.version,
      publishedAt: info.publishedAt,
    });
  }

  private isNewer(remote: string, current: string): boolean {
    const parse = (v: string) => v.split('.').map(n => parseInt(n, 10) || 0);
    const [rMaj = 0, rMin = 0, rPat = 0] = parse(remote);
    const [cMaj = 0, cMin = 0, cPat = 0] = parse(current);
    if (rMaj !== cMaj) return rMaj > cMaj;
    if (rMin !== cMin) return rMin > cMin;
    return rPat > cPat;
  }

  private httpsGet(url: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const req = https.get(url, {
        headers: { 'User-Agent': `Obsync/${app.getVersion()}` },
        timeout: 10_000,
      }, (res) => {
        // Follow redirects
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          resolve(this.httpsGet(res.headers.location));
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => resolve(data));
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
    });
  }

  private downloadFile(
    url: string,
    dest: string,
    onProgress: (percent: number) => void,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const doDownload = (downloadUrl: string) => {
        const file = fs.createWriteStream(dest);
        const req = https.get(downloadUrl, {
          headers: { 'User-Agent': `Obsync/${app.getVersion()}` },
          timeout: 5 * 60 * 1000, // 5 min timeout for large files
        }, (res) => {
          // Follow redirects (GitHub releases redirect to CDN)
          if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            file.close();
            fs.unlinkSync(dest);
            doDownload(res.headers.location);
            return;
          }
          if (res.statusCode !== 200) {
            file.close();
            reject(new Error(`HTTP ${res.statusCode}`));
            return;
          }

          const total = parseInt(res.headers['content-length'] ?? '0', 10);
          let received = 0;

          res.on('data', (chunk: Buffer) => {
            received += chunk.length;
            if (total > 0) onProgress(Math.round((received / total) * 100));
          });

          res.pipe(file);
          file.on('finish', () => { file.close(); resolve(); });
          file.on('error', (e) => { fs.unlinkSync(dest); reject(e); });
        });
        req.on('error', (e) => { file.close(); reject(e); });
        req.on('timeout', () => { req.destroy(); reject(new Error('Download timed out')); });
      };

      doDownload(url);
    });
  }
}
