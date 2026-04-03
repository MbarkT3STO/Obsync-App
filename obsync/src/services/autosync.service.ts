import chokidar from 'chokidar';
import { BrowserWindow } from 'electron';
import { createLogger } from '../utils/logger.util';
import type { FSWatcher } from 'chokidar';
import type { AutoSyncConfig } from '../models/history.model';
import type { StorageService } from './storage.service';
import type { SyncService } from './sync.service';
import type { VaultService } from './vault.service';
import { IPC } from '../config/ipc-channels';

const logger = createLogger('AutoSyncService');

interface WatcherEntry {
  watcher: FSWatcher;
  debounceTimer: ReturnType<typeof setTimeout> | null;
  vaultId: string;
}

export class AutoSyncService {
  private watchers: Map<string, WatcherEntry> = new Map();

  constructor(
    private readonly storage: StorageService,
    private readonly vaultService: VaultService,
    private readonly syncService: SyncService,
  ) {}

  /** Start watching a vault if auto-sync is enabled for it */
  startWatcher(vaultId: string, window: BrowserWindow): void {
    const config = this.getConfig(vaultId);
    if (!config?.enabled) return;

    this.stopWatcher(vaultId);

    const vault = this.vaultService.getById(vaultId);
    if (!vault) return;

    logger.info(`Starting file watcher for vault: ${vault.name}`);

    const watcher: FSWatcher = chokidar.watch(vault.localPath, {
      ignored: [
        /(^|[/\\])\../,
        /\.git[/\\]/,
        /node_modules/,
        /\.obsidian[/\\]workspace/,
      ],
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 1000, pollInterval: 200 },
    });

    const entry: WatcherEntry = { watcher, debounceTimer: null, vaultId };
    this.watchers.set(vaultId, entry);

    const triggerSync = (eventPath: string) => {
      logger.info(`File change detected: ${eventPath}`);
      if (entry.debounceTimer) clearTimeout(entry.debounceTimer);
      const debounceMs = (config.debounceSeconds ?? 30) * 1000;
      entry.debounceTimer = setTimeout(async () => {
        logger.info(`Auto-sync triggered for vault ${vaultId}`);
        window.webContents.send(IPC.EVENT_AUTOSYNC_TRIGGERED, { vaultId });
        await this.syncService.push(vaultId, window);
      }, debounceMs);
    };

    watcher.on('add', triggerSync);
    watcher.on('change', triggerSync);
    watcher.on('unlink', triggerSync);
    watcher.on('error', (err) => logger.error('Watcher error', err));
  }

  stopWatcher(vaultId: string): void {
    const entry = this.watchers.get(vaultId);
    if (!entry) return;

    if (entry.debounceTimer) clearTimeout(entry.debounceTimer);
    entry.watcher.close().catch(() => {});
    this.watchers.delete(vaultId);
    logger.info(`Stopped file watcher for vault ${vaultId}`);
  }

  stopAll(): void {
    for (const vaultId of this.watchers.keys()) {
      this.stopWatcher(vaultId);
    }
  }

  setConfig(vaultId: string, config: AutoSyncConfig): void {
    const appConfig = this.storage.load();
    this.storage.update({
      autoSyncConfigs: { ...appConfig.autoSyncConfigs, [vaultId]: config },
    });
  }

  getConfig(vaultId: string): AutoSyncConfig | null {
    return this.storage.load().autoSyncConfigs?.[vaultId] ?? null;
  }

  isWatching(vaultId: string): boolean {
    return this.watchers.has(vaultId);
  }

  /** Restart all active watchers (e.g. after app restart) */
  restoreAll(window: BrowserWindow): void {
    const config = this.storage.load();
    for (const [vaultId, autoConfig] of Object.entries(config.autoSyncConfigs ?? {})) {
      if (autoConfig.enabled) {
        this.startWatcher(vaultId, window);
      }
    }
  }
}
