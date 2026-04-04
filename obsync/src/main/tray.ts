import { Tray, Menu, BrowserWindow, app, nativeImage } from 'electron';
import path from 'path';
import { createLogger } from '../utils/logger.util';
import type { VaultService } from '../services/vault.service';
import type { GitSyncService } from '../services/git-sync.service';
import type { StorageService } from '../services/storage.service';

const logger = createLogger('Tray');

export class TrayManager {
  private tray: Tray | null = null;

  constructor(
    private readonly vaultService: VaultService,
    private readonly gitSyncService: GitSyncService,
    private readonly storageService: StorageService,
    private readonly getWindow: () => BrowserWindow | null,
  ) {}

  create(): void {
    // Use a simple programmatic icon (16x16 PNG as base64) — no external file needed
    const icon = this.buildIcon();
    this.tray = new Tray(icon);
    this.tray.setToolTip('Obsync — Vault sync running');
    this.updateMenu();

    this.tray.on('double-click', () => this.showWindow());
    logger.info('Tray created');
  }

  updateMenu(): void {
    if (!this.tray) return;

    const vaults = this.vaultService.list();
    const config = this.storageService.load();

    const vaultItems: Electron.MenuItemConstructorOptions[] = vaults.length === 0
      ? [{ label: 'No vaults configured', enabled: false }]
      : vaults.map(vault => {
          const autoSync = config.autoSyncConfigs?.[vault.id];
          const lastSync = vault.lastSyncedAt
            ? new Date(vault.lastSyncedAt).toLocaleTimeString()
            : 'Never';
          return {
            label: `${vault.name}`,
            sublabel: `Last sync: ${lastSync}${autoSync?.enabled ? ' · Auto' : ''}`,
            click: () => {
              this.showWindow();
            },
          };
        });

    const syncAllItem: Electron.MenuItemConstructorOptions = {
      label: 'Sync All Vaults Now',
      click: async () => {
        const win = this.getWindow();
        if (!win) return;
        for (const vault of vaults) {
          const cloudConfig = config.cloudConfigs[vault.id];
          if (cloudConfig) {
            await this.gitSyncService.push(vault.id, win);
          }
        }
      },
    };

    const contextMenu = Menu.buildFromTemplate([
      { label: 'Obsync', enabled: false },
      { type: 'separator' },
      ...vaultItems,
      { type: 'separator' },
      syncAllItem,
      { type: 'separator' },
      {
        label: 'Open Obsync',
        click: () => this.showWindow(),
      },
      {
        label: 'Quit',
        click: () => {
          app.quit();
        },
      },
    ]);

    this.tray.setContextMenu(contextMenu);
  }

  showWindow(): void {
    const win = this.getWindow();
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }

  destroy(): void {
    this.tray?.destroy();
    this.tray = null;
  }

  private buildIcon(): Electron.NativeImage {
    // Load the resized 32x32 tray icon from assets
    try {
      const fs = require('fs') as typeof import('fs');
      const iconPath = path.join(__dirname, '../../../assets/tray-icon.png');
      if (fs.existsSync(iconPath)) {
        const img = nativeImage.createFromPath(iconPath);
        if (!img.isEmpty()) return img;
      }
    } catch { /* ignore */ }

    // Fallback: programmatic purple diamond icon
    return this.buildPngIcon();
  }

  /**
   * Builds a 32x32 PNG icon programmatically.
   * Draws three stacked chevron/diamond shapes in Obsync purple (#7c6af7).
   * Uses raw PNG byte construction — no external dependencies.
   */
  private buildPngIcon(): Electron.NativeImage {
    const SIZE = 32;
    // RGBA pixel buffer
    const pixels = new Uint8Array(SIZE * SIZE * 4); // all transparent

    const purple = { r: 124, g: 106, b: 247 };

    // Draw a filled diamond (rhombus) row by row
    const drawDiamond = (
      centerY: number, halfH: number, halfW: number, alpha: number,
    ) => {
      for (let y = centerY - halfH; y <= centerY + halfH; y++) {
        if (y < 0 || y >= SIZE) continue;
        const t = 1 - Math.abs(y - centerY) / halfH;
        const xStart = Math.round(SIZE / 2 - t * halfW);
        const xEnd   = Math.round(SIZE / 2 + t * halfW);
        for (let x = xStart; x <= xEnd; x++) {
          if (x < 0 || x >= SIZE) continue;
          const idx = (y * SIZE + x) * 4;
          pixels[idx]     = purple.r;
          pixels[idx + 1] = purple.g;
          pixels[idx + 2] = purple.b;
          pixels[idx + 3] = alpha;
        }
      }
    };

    // Three stacked layers — bottom to top, increasing opacity
    drawDiamond(24, 5, 13, 90);   // bottom layer, faint
    drawDiamond(18, 5, 13, 160);  // middle layer
    drawDiamond(12, 5, 13, 255);  // top layer, full opacity

    // Encode as PNG using Electron's nativeImage from raw buffer
    const img = nativeImage.createFromBuffer(
      Buffer.from(pixels.buffer),
      { width: SIZE, height: SIZE, scaleFactor: 1 },
    );

    return img;
  }
}
