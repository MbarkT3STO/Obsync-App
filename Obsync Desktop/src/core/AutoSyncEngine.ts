/**
 * AutoSyncEngine — provider-agnostic auto-sync for the new multi-provider architecture.
 *
 * Responsibilities:
 *  - File watcher (chokidar) per vault → debounced PUSH via SyncEngine
 *  - Poll loop per vault → manifest-diff PULL via SyncEngine
 *  - State machine: idle | pending | syncing | success | error | paused | offline
 *  - Queue: at most ONE pending sync while a sync is running
 *  - Collision prevention: pull wins over push
 *  - Network awareness: queues sync when offline, retries every 30s
 *  - Hot-reload: debounceMs and pollIntervalMs can be updated live
 *  - Git commit squashing: if last N auto-sync commits are all obsync auto-sync, squash them
 *
 * RULE: All sync operations go through SyncEngine.sync(). This class never calls
 * a provider directly.
 */

import { EventEmitter } from 'events';
import path from 'path';
import { net } from 'electron';
import chokidar, { FSWatcher } from 'chokidar';
import simpleGit from 'simple-git';
import { SyncEngine } from './SyncEngine';
import { buildIgnorePatterns } from './ObsidianIgnorePatterns';
import { getChokidarIgnorePatterns } from '../utils/obsidian-filter.util';
import { createProvider } from '../providers/ProviderRegistry';
import { TokenStore } from '../auth/TokenStore';
import { VaultManager } from '../vault/VaultManager';
import type { SyncProvider, ProviderCredentials } from '../providers/SyncProvider';
import type { BaseGitProvider } from '../providers/git/BaseGitProvider';
import type { GoogleDriveProvider } from '../providers/cloud/GoogleDriveProvider';
import type { OneDriveProvider } from '../providers/cloud/OneDriveProvider';
import type { DropboxProvider } from '../providers/cloud/DropboxProvider';
import { createLogger } from '../utils/logger.util';
import os from 'os';
import crypto from 'crypto';

const logger = createLogger('AutoSyncEngine');

// ── Types ──────────────────────────────────────────────────────────────────

export type AutoSyncState =
  | 'idle'      // watching, no changes
  | 'pending'   // changes detected, debounce timer running
  | 'syncing'   // SyncEngine.sync() in progress
  | 'success'   // last sync completed successfully
  | 'error'     // last sync failed
  | 'paused'    // user manually paused
  | 'offline';  // no network, changes queued

export interface AutoSyncStateMeta {
  timestamp?: string;
  filesUploaded?: number;
  filesDownloaded?: number;
  errorMessage?: string;
  retryIn?: number; // seconds until next retry
}

export interface AutoSyncStateEvent {
  vaultId: string;
  state: AutoSyncState;
  meta?: AutoSyncStateMeta;
}

export interface AutoSyncConfig {
  enabled: boolean;
  debounceMs: number;
  pollIntervalMs: number;
}

interface VaultEntry {
  vaultId: string;
  watcher: FSWatcher | null;
  debounceTimer: ReturnType<typeof setTimeout> | null;
  pollInterval: ReturnType<typeof setInterval> | null;
  offlineRetryInterval: ReturnType<typeof setInterval> | null;
  state: AutoSyncState;
  /** True while SyncEngine.sync() is running */
  syncing: boolean;
  /** True if a sync was requested while syncing was true */
  pendingSync: boolean;
  /** True if the user has paused this vault */
  paused: boolean;
  /** True if offline and a sync is queued */
  offlinePending: boolean;
  config: AutoSyncConfig;
}

// ── Stable device ID ───────────────────────────────────────────────────────
function getDeviceId(): string {
  return crypto
    .createHash('sha256')
    .update(`${os.hostname()}:${process.platform}`)
    .digest('hex')
    .slice(0, 16);
}

// ── AutoSyncEngine ─────────────────────────────────────────────────────────

export class AutoSyncEngine extends EventEmitter {
  private readonly entries = new Map<string, VaultEntry>();

  constructor(
    private readonly syncEngine: SyncEngine,
    private readonly vaultManager: VaultManager,
    private readonly tokenStore: TokenStore,
  ) {
    super();
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Start watching a vault. Idempotent — calling again with the same vaultId
   * stops the existing watcher first.
   */
  start(vaultId: string): void {
    this.stop(vaultId);

    const vault = this.vaultManager.getById(vaultId);
    if (!vault) { logger.warn(`AutoSync start: vault ${vaultId} not found`); return; }

    const cfg = vault.syncOptions;
    const config: AutoSyncConfig = {
      enabled: cfg.autoSync,
      debounceMs: cfg.autoSyncDebounceMs ?? 5000,
      pollIntervalMs: 120_000, // default; updated via updateConfig
    };

    const entry: VaultEntry = {
      vaultId,
      watcher: null,
      debounceTimer: null,
      pollInterval: null,
      offlineRetryInterval: null,
      state: 'idle',
      syncing: false,
      pendingSync: false,
      paused: false,
      offlinePending: false,
      config,
    };

    this.entries.set(vaultId, entry);
    this.startWatcher(entry, vault.localPath);
    this.startPollLoop(entry, vault.localPath);

    logger.info(`AutoSync started for vault ${vaultId} (debounce: ${config.debounceMs}ms, poll: ${config.pollIntervalMs}ms)`);
  }

  /** Stop watching a vault and clean up all timers. */
  stop(vaultId: string): void {
    const entry = this.entries.get(vaultId);
    if (!entry) return;
    this.clearEntry(entry);
    this.entries.delete(vaultId);
    logger.info(`AutoSync stopped for vault ${vaultId}`);
  }

  /** Stop all watchers (called on app quit). */
  stopAll(): void {
    for (const id of [...this.entries.keys()]) this.stop(id);
  }

  /** Pause syncing — keeps the watcher alive but suppresses sync execution. */
  pause(vaultId: string): void {
    const entry = this.entries.get(vaultId);
    if (!entry) return;
    entry.paused = true;
    if (entry.debounceTimer) { clearTimeout(entry.debounceTimer); entry.debounceTimer = null; }
    this.setState(entry, 'paused');
  }

  /** Resume from paused state. */
  resume(vaultId: string): void {
    const entry = this.entries.get(vaultId);
    if (!entry) return;
    entry.paused = false;
    this.setState(entry, 'idle');
  }

  /** Skip debounce and sync immediately. */
  async forceNow(vaultId: string): Promise<void> {
    const entry = this.entries.get(vaultId);
    if (!entry) return;
    if (entry.debounceTimer) { clearTimeout(entry.debounceTimer); entry.debounceTimer = null; }
    await this.executeSync(entry);
  }

  /** Get the current state for a vault. */
  getState(vaultId: string): AutoSyncState {
    return this.entries.get(vaultId)?.state ?? 'idle';
  }

  /**
   * Hot-reload config without restarting the watcher.
   * Updates debounce timer and poll interval live.
   */
  updateConfig(vaultId: string, config: Partial<AutoSyncConfig>): void {
    const entry = this.entries.get(vaultId);
    if (!entry) return;

    const oldPollMs = entry.config.pollIntervalMs;
    entry.config = { ...entry.config, ...config };

    // Hot-reload poll interval
    if (config.pollIntervalMs !== undefined && config.pollIntervalMs !== oldPollMs) {
      if (entry.pollInterval) clearInterval(entry.pollInterval);
      entry.pollInterval = null;
      const vault = this.vaultManager.getById(vaultId);
      if (vault) this.startPollLoop(entry, vault.localPath);
    }

    // debounceMs is read at fire-time from entry.config — no restart needed
    logger.info(`AutoSync config updated for vault ${vaultId}: debounce=${entry.config.debounceMs}ms, poll=${entry.config.pollIntervalMs}ms`);
  }

  // ── Watcher ────────────────────────────────────────────────────────────────

  private startWatcher(entry: VaultEntry, vaultPath: string): void {
    entry.watcher = chokidar.watch(vaultPath, {
      ignored: getChokidarIgnorePatterns(),
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 1500, pollInterval: 200 },
    });

    const scheduleFlush = () => {
      if (entry.paused) return;
      // Cancel any running debounce and restart it
      if (entry.debounceTimer) clearTimeout(entry.debounceTimer);
      this.setState(entry, 'pending');

      entry.debounceTimer = setTimeout(async () => {
        entry.debounceTimer = null;
        await this.onDebounceExpired(entry);
      }, entry.config.debounceMs);
    };

    entry.watcher.on('add',       scheduleFlush);
    entry.watcher.on('change',    scheduleFlush);
    entry.watcher.on('unlink',    scheduleFlush);
    entry.watcher.on('unlinkDir', scheduleFlush);
    entry.watcher.on('error',     (e) => logger.error(`Watcher error for ${entry.vaultId}:`, e));
  }

  // ── Debounce expiry ────────────────────────────────────────────────────────

  private async onDebounceExpired(entry: VaultEntry): Promise<void> {
    if (entry.paused) return;

    // Check network first
    if (!this.isOnline()) {
      entry.offlinePending = true;
      this.setState(entry, 'offline');
      this.startOfflineRetry(entry);
      return;
    }

    // If a sync is already running, queue one pending sync
    if (entry.syncing) {
      entry.pendingSync = true;
      logger.info(`AutoSync [${entry.vaultId}]: sync queued (another sync in progress)`);
      return;
    }

    await this.executeSync(entry);
  }

  // ── Poll loop ──────────────────────────────────────────────────────────────

  private startPollLoop(entry: VaultEntry, vaultPath: string): void {
    if (entry.config.pollIntervalMs <= 0) return; // 0 = disabled

    entry.pollInterval = setInterval(async () => {
      if (entry.paused || entry.syncing || entry.state === 'offline') return;

      const hasRemoteChanges = await this.checkRemoteChanges(entry.vaultId, vaultPath);
      if (!hasRemoteChanges) return;

      logger.info(`AutoSync [${entry.vaultId}]: remote changes detected by poll — pulling`);

      // Pull wins: cancel any pending push debounce
      if (entry.debounceTimer) {
        clearTimeout(entry.debounceTimer);
        entry.debounceTimer = null;
      }

      await this.executeSync(entry);
    }, entry.config.pollIntervalMs);

    // Unref so the interval doesn't keep the process alive alone
    entry.pollInterval?.unref?.();
  }

  /**
   * Check whether the remote has changes the local doesn't.
   * Git: git fetch --dry-run then compare FETCH_HEAD to HEAD.
   * Cloud: fetch remote manifest and compare lastSync + file hashes.
   */
  private async checkRemoteChanges(vaultId: string, vaultPath: string): Promise<boolean> {
    try {
      const vault = this.vaultManager.getById(vaultId);
      if (!vault) return false;

      const creds = this.tokenStore.load(vaultId, vault.providerId);
      if (!creds) return false;

      const provider = createProvider(vault.providerId);
      this.wireTokenRefresh(provider, vaultId, creds);
      this.setProviderContext(provider, vault);
      await provider.connect(creds);

      if (provider.type === 'git') {
        // git fetch and compare HEAD vs FETCH_HEAD
        const git = simpleGit({ baseDir: vaultPath, binary: 'git', maxConcurrentProcesses: 1 });
        const branch = creds.extra?.['branch'] ?? 'main';
        try {
          await git.fetch('origin', branch);
          const localHead = await git.revparse(['HEAD']).catch(() => '');
          const fetchHead = await git.revparse(['FETCH_HEAD']).catch(() => '');
          if (!localHead || !fetchHead) return false;
          return localHead.trim() !== fetchHead.trim();
        } catch {
          return false;
        }
      } else {
        // Cloud: compare remote manifest lastSync to local manifest
        const remote = await provider.getRemoteManifest();
        await provider.disconnect();
        if (!remote) return false;

        // Load local manifest
        const { ManifestManager } = await import('./ManifestManager');
        const mm = new ManifestManager();
        const local = mm.loadLocal(vaultId);
        if (!local) return true; // no local manifest → definitely need to sync

        // Remote is newer if its lastSync is after ours
        return new Date(remote.lastSync) > new Date(local.lastSync);
      }
    } catch (e) {
      logger.warn(`AutoSync [${vaultId}]: remote check failed:`, e);
      return false;
    }
  }

  // ── Sync execution ─────────────────────────────────────────────────────────

  private async executeSync(entry: VaultEntry): Promise<void> {
    if (entry.syncing) {
      entry.pendingSync = true;
      return;
    }

    const vault = this.vaultManager.getById(entry.vaultId);
    if (!vault) return;

    const creds = this.tokenStore.load(entry.vaultId, vault.providerId);
    if (!creds) {
      logger.warn(`AutoSync [${entry.vaultId}]: no credentials — skipping`);
      return;
    }

    entry.syncing = true;
    entry.pendingSync = false;
    this.setState(entry, 'syncing');

    try {
      const provider = createProvider(vault.providerId);
      this.wireTokenRefresh(provider, entry.vaultId, creds);
      this.setProviderContext(provider, vault);
      await provider.connect(creds);

      // Git providers: commit staged changes before sync
      if (provider.type === 'git') {
        await this.commitLocalChanges(vault.localPath, creds);
      }

      const ignorePatterns = buildIgnorePatterns(
        vault.syncOptions.ignorePatterns,
        vault.syncOptions.syncObsidianConfig,
      );

      const result = await this.syncEngine.sync(
        entry.vaultId,
        vault.localPath,
        provider,
        getDeviceId(),
        {
          conflictStrategy: vault.syncOptions.conflictStrategy,
          ignorePatterns,
        },
      );

      await provider.disconnect();

      // Git providers: squash auto-sync commits if needed
      if (provider.type === 'git') {
        await this.squashAutoSyncCommits(vault.localPath).catch(() => {});
      }

      this.vaultManager.updateLastSync(entry.vaultId);

      const hasErrors = result.errors.length > 0;
      this.setState(entry, hasErrors ? 'error' : 'success', {
        timestamp: new Date().toISOString(),
        filesUploaded: result.uploaded.length,
        filesDownloaded: result.downloaded.length,
        errorMessage: hasErrors ? result.errors[0]?.error : undefined,
      });

      logger.info(`AutoSync [${entry.vaultId}]: complete — ↑${result.uploaded.length} ↓${result.downloaded.length} ✗${result.errors.length}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logger.error(`AutoSync [${entry.vaultId}]: sync failed:`, e);
      this.setState(entry, 'error', { errorMessage: msg, timestamp: new Date().toISOString() });
    } finally {
      entry.syncing = false;

      // Execute queued sync if one was requested during this sync
      if (entry.pendingSync && !entry.paused) {
        entry.pendingSync = false;
        // Small delay to avoid hammering on rapid changes
        setTimeout(() => this.executeSync(entry), 500);
      }
    }
  }

  // ── Git helpers ────────────────────────────────────────────────────────────

  /**
   * Stage and commit all local changes before a git sync.
   * Commit message format: "obsync: auto-sync {ISO} ({N} files changed)"
   */
  private async commitLocalChanges(vaultPath: string, creds: ProviderCredentials): Promise<void> {
    try {
      const git = simpleGit({ baseDir: vaultPath, binary: 'git', maxConcurrentProcesses: 1 });
      await git.add('.');
      const status = await git.status();
      if (status.files.length === 0) return;
      const n = status.files.length;
      const msg = `obsync: auto-sync ${new Date().toISOString()} (${n} file${n === 1 ? '' : 's'} changed)`;
      await git.commit(msg);
    } catch { /* not a git repo yet — SyncEngine will handle init */ }
  }

  /**
   * If the last N commits are all obsync auto-sync commits, squash them into one.
   * Squash message: "obsync: squashed auto-sync ({first date} → {last date})"
   */
  private async squashAutoSyncCommits(vaultPath: string, threshold = 10): Promise<void> {
    try {
      const git = simpleGit({ baseDir: vaultPath, binary: 'git', maxConcurrentProcesses: 1 });
      const log = await git.log([`--max-count=${threshold}`, '--format=%H %s']);
      const commits = log.all;

      if (commits.length < threshold) return;

      const allAutoSync = commits.every(c => c.message.startsWith('obsync: auto-sync'));
      if (!allAutoSync) return;

      const oldest = commits[commits.length - 1]!;
      const newest = commits[0]!;

      // Extract dates from messages: "obsync: auto-sync {ISO} ..."
      const extractDate = (msg: string) => msg.replace('obsync: auto-sync ', '').split(' ')[0] ?? '';
      const firstDate = extractDate(oldest.message);
      const lastDate = extractDate(newest.message);

      const squashMsg = `obsync: squashed auto-sync (${firstDate} → ${lastDate})`;

      // Soft-reset to before the oldest commit, then recommit
      await git.reset(['--soft', `HEAD~${threshold}`]);
      await git.commit(squashMsg);
      logger.info(`AutoSync: squashed ${threshold} auto-sync commits into one`);
    } catch { /* squash is best-effort */ }
  }

  // ── Network awareness ──────────────────────────────────────────────────────

  private isOnline(): boolean {
    // net.isOnline() is synchronous and reliable on all platforms
    return net.isOnline?.() ?? true;
  }

  private startOfflineRetry(entry: VaultEntry): void {
    if (entry.offlineRetryInterval) return; // already running

    let retryCountdown = 30;
    this.setState(entry, 'offline', { retryIn: retryCountdown });

    entry.offlineRetryInterval = setInterval(async () => {
      retryCountdown--;
      if (retryCountdown > 0) {
        this.setState(entry, 'offline', { retryIn: retryCountdown });
        return;
      }

      retryCountdown = 30;

      if (!this.isOnline()) {
        this.setState(entry, 'offline', { retryIn: retryCountdown });
        return;
      }

      // Back online
      logger.info(`AutoSync [${entry.vaultId}]: back online — executing queued sync`);
      if (entry.offlineRetryInterval) {
        clearInterval(entry.offlineRetryInterval);
        entry.offlineRetryInterval = null;
      }
      entry.offlinePending = false;
      await this.executeSync(entry);
    }, 1000);

    entry.offlineRetryInterval?.unref?.();
  }

  // ── State machine ──────────────────────────────────────────────────────────

  private setState(entry: VaultEntry, state: AutoSyncState, meta?: AutoSyncStateMeta): void {
    entry.state = state;
    const event: AutoSyncStateEvent = { vaultId: entry.vaultId, state, meta };
    this.emit('state-changed', event);
  }

  // ── Provider helpers ───────────────────────────────────────────────────────

  private setProviderContext(provider: SyncProvider, vault: ReturnType<VaultManager['getById']> & {}): void {
    if (provider.type === 'git') {
      (provider as BaseGitProvider).setVaultPath(vault.localPath);
    } else {
      const folderName = vault.providerConfig.remoteFolderName ?? vault.name;
      (provider as GoogleDriveProvider | OneDriveProvider | DropboxProvider).setVaultName(folderName);
    }
  }

  private wireTokenRefresh(provider: SyncProvider, vaultId: string, creds: ProviderCredentials): void {
    provider.onTokenRefreshed = (newTokenJson: string) => {
      const vault = this.vaultManager.getById(vaultId);
      if (!vault) return;
      const updated: ProviderCredentials = { ...creds, token: newTokenJson };
      this.tokenStore.save(vaultId, vault.providerId, updated);
    };
  }

  // ── Cleanup ────────────────────────────────────────────────────────────────

  private clearEntry(entry: VaultEntry): void {
    if (entry.debounceTimer) { clearTimeout(entry.debounceTimer); entry.debounceTimer = null; }
    if (entry.pollInterval) { clearInterval(entry.pollInterval); entry.pollInterval = null; }
    if (entry.offlineRetryInterval) { clearInterval(entry.offlineRetryInterval); entry.offlineRetryInterval = null; }
    entry.watcher?.close().catch(() => {});
    entry.watcher = null;
  }
}
