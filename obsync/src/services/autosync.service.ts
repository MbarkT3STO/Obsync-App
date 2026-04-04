import chokidar from 'chokidar';
import path from 'path';
import { BrowserWindow } from 'electron';
import { createLogger } from '../utils/logger.util';
import { getChokidarIgnorePatterns, shouldSyncFile } from '../utils/obsidian-filter.util';
import type { FSWatcher } from 'chokidar';
import type { AutoSyncConfig } from '../models/history.model';
import type { StorageService } from './storage.service';
import type { SyncService } from './sync.service';
import type { VaultService } from './vault.service';
import { IPC } from '../config/ipc-channels';

const logger = createLogger('AutoSyncService');

interface WatcherEntry {
  watcher: FSWatcher;
  pendingActions: Map<string, 'push' | 'delete'>; // Path -> Action
  debounceTimer: ReturnType<typeof setTimeout> | null;
  remotePollInterval: ReturnType<typeof setInterval> | null;
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

    const intervalSeconds = config.debounceSeconds ?? 30;
    logger.info(`Starting auto-sync for vault: ${vault.name} (Period: ${intervalSeconds}s)`);

    //── 1. Local Files Watcher (Chokidar) ────────────────────────────────────
    const watcher: FSWatcher = chokidar.watch(vault.localPath, {
      ignored: getChokidarIgnorePatterns(),
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 1500, pollInterval: 200 },
    });

    const entry: WatcherEntry = { 
      watcher, 
      pendingActions: new Map(),
      debounceTimer: null, 
      remotePollInterval: null, 
      vaultId 
    };
    this.watchers.set(vaultId, entry);

    // Trigger local push
    // Process queued actions
    const triggerLocalAction = (action: 'push' | 'delete', eventPath: string) => {
      const relativePath = path.relative(vault.localPath, eventPath).replace(/\\/g, '/');
      // Use the shared filter — only queue files we actually want to sync
      if (action === 'push' && !shouldSyncFile(relativePath)) return;

      // Queue the action
      entry.pendingActions.set(relativePath, action);
      
      if (entry.debounceTimer) clearTimeout(entry.debounceTimer);
      
      const debounceMs = (config.debounceSeconds ?? 2) * 1000;
      entry.debounceTimer = setTimeout(async () => {
        const actionsToProcess = Array.from(entry.pendingActions.entries());
        entry.pendingActions.clear();
        
        for (const [relPath, act] of actionsToProcess) {
          logger.info(`Auto-sync processing: ${act} ${relPath}`);
          if (act === 'push') {
            await this.syncService.pushFile(vaultId, relPath);
          } else {
            await this.syncService.delete(vaultId, relPath);
          }
        }
        window.webContents.send(IPC.EVENT_AUTOSYNC_TRIGGERED, { vaultId });
      }, debounceMs);
    };

    watcher.on('add', (path) => triggerLocalAction('push', path));
    watcher.on('change', (path) => triggerLocalAction('push', path));
    watcher.on('unlink', (path) => triggerLocalAction('delete', path));
    watcher.on('unlinkDir', (path) => triggerLocalAction('delete', path));
    watcher.on('error', (err) => logger.error('Watcher error', err));

    //── 2. Remote Poller (Periodic Pull) ─────────────────────────────────────
    // Use the same period as local sync
    const pollMs = intervalSeconds * 1000;
    entry.remotePollInterval = setInterval(async () => {
      logger.info(`Auto-pull check (${intervalSeconds}s) for vault ${vaultId}`);
      await this.syncService.pull(vaultId, window, true); // silent=true
    }, pollMs);

    // Initial remote pull when starting watcher
    this.syncService.pull(vaultId, window, true).catch(() => {});
  }

  stopWatcher(vaultId: string): void {
    const entry = this.watchers.get(vaultId);
    if (!entry) return;

    if (entry.debounceTimer) clearTimeout(entry.debounceTimer);
    if (entry.remotePollInterval) clearInterval(entry.remotePollInterval);
    
    entry.watcher.close().catch(() => {});
    this.watchers.delete(vaultId);
    logger.info(`Stopped auto-sync watchers for vault ${vaultId}`);
  }

  stopAll(): void {
    for (const vaultId of Array.from(this.watchers.keys())) {
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
