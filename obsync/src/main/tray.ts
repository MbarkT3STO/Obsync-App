import { Tray, Menu, BrowserWindow, app, nativeImage } from 'electron';
import path from 'path';
import { createLogger } from '../utils/logger.util';
import type { VaultService } from '../services/vault.service';
import type { SyncService } from '../services/sync.service';
import type { StorageService } from '../services/storage.service';

const logger = createLogger('Tray');

export class TrayManager {
  private tray: Tray | null = null;

  constructor(
    private readonly vaultService: VaultService,
    private readonly syncService: SyncService,
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
          const ghConfig = config.githubConfigs[vault.id];
          if (ghConfig) {
            await this.syncService.push(vault.id, win);
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
    // Try loading from assets first, fall back to empty icon
    try {
      const iconPath = path.join(__dirname, '../../../assets/tray-icon.png');
      const fs = require('fs') as typeof import('fs');
      if (fs.existsSync(iconPath)) {
        return nativeImage.createFromPath(iconPath);
      }
    } catch { /* ignore */ }

    // Minimal 16x16 white square as fallback (valid PNG base64)
    return nativeImage.createFromDataURL(
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAABHNCSVQICAgIfAhkiAAAAAlwSFlzAAAAdgAAAHYBTnsmCAAAABl0RVh0U29mdHdhcmUAd3d3Lmlua3NjYXBlLm9yZ5vuPBoAAABOSURBVDiNY/z//z8DJYCJgUIwasCoAaMGjBowasCoAaMGjBowasCoAaMGjBowasCoAaMGjBowasCoAaMGjBowasCoAaMGjBowasCoAaQDAACMDQ8BnFWkAAAAAElFTkSuQmCC'
    );
  }
}
