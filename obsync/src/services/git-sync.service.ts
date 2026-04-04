/**
 * GitSyncService — unified sync engine for ALL providers.
 *
 * Strategy:
 *  • Git providers (github/gitlab/bitbucket/git-custom):
 *      standard git push/pull against the remote URL.
 *
 *  • Non-Git providers (onedrive/dropbox/googledrive/webdav):
 *      - Git is used LOCALLY for change tracking, history, and conflict detection.
 *      - Files are synced to the cloud as actual readable files (not bundles).
 *      - On PUSH  → git add + commit → upload changed files to cloud via provider API.
 *      - On PULL  → download changed files from cloud → git add + commit locally.
 *      - Conflict → git detects it, user resolves via UI.
 *
 * Users see their actual vault files in OneDrive/Dropbox/Google Drive/WebDAV.
 * Git provides local history, conflict detection, and atomic commits.
 */

import * as fs from 'fs';
import * as path from 'path';
import { BrowserWindow } from 'electron';
import simpleGit, { SimpleGit } from 'simple-git';
import { createLogger } from '../utils/logger.util';
import { getChokidarIgnorePatterns, collectVaultFiles } from '../utils/obsidian-filter.util';
import { withRetry } from '../utils/retry.util';
import { IPC } from '../config/ipc-channels';
import type { SyncResult, CloudCredentials } from '../models/cloud-sync.model';
import type { VaultSyncStatus } from '../models/vault.model';
import type { VaultService } from './vault.service';
import type { CloudProviderService } from './cloud-provider.service';
import type { HistoryService } from './history.service';
import type { StorageService } from './storage.service';
import type { AutoSyncConfig } from '../models/history.model';
import chokidar, { FSWatcher } from 'chokidar';

const logger = createLogger('GitSyncService');

// ── Git providers that use native remote push/pull ─────────────────────────
const GIT_PROVIDERS = new Set(['github', 'gitlab', 'bitbucket', 'git-custom']);

// ── .gitignore written into every managed vault ────────────────────────────
const GITIGNORE = [
  '.obsidian/workspace',
  '.obsidian/workspace.json',
  '.obsidian/workspace-mobile',
  '.obsidian/workspace-mobile.json',
  '.obsidian/cache',
  '.obsidian/.trash/',
  '.obsync/',
  '.trash/',
  '*.tmp',
  '*.bak',
  '*.swp',
  '*~',
  '*.lock',
  '.DS_Store',
  'Thumbs.db',
  'desktop.ini',
].join('\n');

interface WatcherEntry {
  watcher: FSWatcher;
  debounceTimer: ReturnType<typeof setTimeout> | null;
  pollInterval: ReturnType<typeof setInterval> | null;
  // Track pending changes by type so we handle deletes/renames correctly
  pendingUpserts: Set<string>; // vault-relative paths to upload
  pendingDeletes: Set<string>; // vault-relative paths to delete from cloud
}

export class GitSyncService {
  private statusMap = new Map<string, VaultSyncStatus>();
  private watchers = new Map<string, WatcherEntry>();

  constructor(
    private readonly vaultService: VaultService,
    private readonly cloudProvider: CloudProviderService,
    private readonly historyService: HistoryService,
    private readonly storageService: StorageService,
  ) {}

  // ── Public API ─────────────────────────────────────────────────────────────

  async initRepo(vaultId: string): Promise<SyncResult> {
    const vault = this.vaultService.getById(vaultId);
    if (!vault) return err('Vault not found');
    const creds = this.cloudProvider.getCredentials(vaultId);
    if (!creds) return err('Provider not configured');

    try {
      const git = this.git(vault.localPath);
      await this.ensureGitRepo(git, vault.localPath);

      if (GIT_PROVIDERS.has(creds.provider)) {
        const authUrl = this.buildAuthUrl(creds.meta['repoUrl'], creds.token);
        const remotes = await git.getRemotes();
        if (remotes.find(r => r.name === 'origin')) {
          await git.remote(['set-url', 'origin', authUrl]);
        } else {
          await git.addRemote('origin', authUrl);
        }
      }

      return ok('Repository initialised');
    } catch (e) {
      return err(`Init failed: ${msg(e)}`);
    }
  }

  async push(vaultId: string, window: BrowserWindow | null, silent = false): Promise<SyncResult> {
    const vault = this.vaultService.getById(vaultId);
    if (!vault) return err('Vault not found');
    const creds = this.cloudProvider.getCredentials(vaultId);
    if (!creds) return err('Provider not configured');

    this.emitStatus(window, vaultId, 'syncing', 'Committing changes...');

    try {
      const git = this.git(vault.localPath);
      await this.ensureGitRepo(git, vault.localPath);

      // Stage everything
      await git.add('.');
      const status = await git.status();
      const changedFiles = [
        ...status.staged,
        ...status.not_added,
        ...status.modified,
        ...status.deleted,
      ];
      const hasChanges = changedFiles.length > 0;

      if (!hasChanges) {
        this.emitStatus(window, vaultId, 'synced', 'Already up to date');
        if (!silent) this.emitComplete(window, vaultId, ok('Already up to date', 0));
        return ok('Already up to date', 0);
      }

      await git.add('.');
      await git.commit(`obsync: ${new Date().toISOString()}`);

      let result: SyncResult;
      if (GIT_PROVIDERS.has(creds.provider)) {
        result = await this.gitRemotePush(git, creds);
      } else {
        result = await this.cloudFilePush(vault.localPath, vaultId, creds, window);
      }

      if (result.success) {
        this.vaultService.updateLastSynced(vaultId);
        this.emitStatus(window, vaultId, 'synced', result.message);
      } else {
        this.emitStatus(window, vaultId, 'error', result.message);
      }

      const final = { ...result, filesChanged: changedFiles.length };
      if (!silent) this.emitComplete(window, vaultId, final);
      return final;
    } catch (e) {
      const message = `Push failed: ${msg(e)}`;
      this.emitStatus(window, vaultId, 'error', message);
      if (!silent) this.emitComplete(window, vaultId, err(message));
      return err(message);
    }
  }

  async pull(vaultId: string, window: BrowserWindow | null, silent = false): Promise<SyncResult> {
    const vault = this.vaultService.getById(vaultId);
    if (!vault) return err('Vault not found');
    const creds = this.cloudProvider.getCredentials(vaultId);
    if (!creds) return err('Provider not configured');

    this.emitStatus(window, vaultId, 'syncing', 'Pulling changes...');

    try {
      const git = this.git(vault.localPath);
      await this.ensureGitRepo(git, vault.localPath);

      let result: SyncResult;
      if (GIT_PROVIDERS.has(creds.provider)) {
        result = await this.gitRemotePull(git, creds);
      } else {
        result = await this.cloudFilePull(git, vault.localPath, vaultId, creds, window);
      }

      if (result.success) {
        this.vaultService.updateLastSynced(vaultId);
        this.emitStatus(window, vaultId, 'synced', result.message);
      } else if (result.conflicts && result.conflicts.length > 0) {
        this.emitStatus(window, vaultId, 'conflict', 'Conflicts detected');
        if (window) {
          window.webContents.send(IPC.EVENT_CONFLICT_DETECTED, {
            vaultId,
            conflicts: result.conflicts.map(c => ({ filePath: c.filePath })),
          });
        }
      } else {
        this.emitStatus(window, vaultId, 'error', result.message);
      }

      if (!silent || !result.success || (result.filesChanged ?? 0) > 0) {
        this.emitComplete(window, vaultId, result);
      }
      return result;
    } catch (e) {
      const message = `Pull failed: ${msg(e)}`;
      this.emitStatus(window, vaultId, 'error', message);
      return err(message);
    }
  }

  async clone(targetPath: string, credentials: CloudCredentials): Promise<SyncResult> {
    try {
      if (!fs.existsSync(targetPath)) fs.mkdirSync(targetPath, { recursive: true });

      if (GIT_PROVIDERS.has(credentials.provider)) {
        await this.cloneFromGitRemote(targetPath, credentials);
      } else {
        await this.cloneFromCloud(targetPath, credentials);
      }

      let vault: import('../models/vault.model').Vault;
      try {
        vault = this.vaultService.add(targetPath);
      } catch {
        const existing = this.vaultService.list().find(v => v.localPath === targetPath);
        if (!existing) throw new Error('Failed to register vault');
        vault = existing;
      }

      this.cloudProvider.saveConfig(vault.id, credentials);
      return { success: true, message: 'Vault imported successfully', data: vault as any };
    } catch (e) {
      return err(`Import failed: ${msg(e)}`);
    }
  }

  async resolveConflict(vaultId: string, filePath: string, strategy: 'local' | 'cloud' | 'both'): Promise<SyncResult> {
    const vault = this.vaultService.getById(vaultId);
    if (!vault) return err('Vault not found');

    try {
      const git = this.git(vault.localPath);
      const absPath = path.join(vault.localPath, filePath);

      if (strategy === 'local') {
        await git.checkout(['--ours', filePath]);
        await git.add([filePath]);
        return ok(`Kept local version of ${filePath}`);
      } else if (strategy === 'cloud') {
        await this.historyService.archiveFile(vault.localPath, filePath);
        await git.checkout(['--theirs', filePath]);
        await git.add([filePath]);
        return ok(`Kept cloud version of ${filePath}`);
      } else {
        if (fs.existsSync(absPath)) {
          const ext = path.extname(filePath);
          const base = filePath.slice(0, -ext.length);
          fs.copyFileSync(absPath, path.join(vault.localPath, `${base} (Conflict)${ext}`));
        }
        await git.checkout(['--theirs', filePath]);
        await git.add([filePath]);
        return ok(`Kept both versions of ${filePath}`);
      }
    } catch (e) {
      return err(`Resolution failed: ${msg(e)}`);
    }
  }

  getStatus(vaultId: string): VaultSyncStatus {
    return this.statusMap.get(vaultId) ?? {
      vaultId,
      status: 'idle',
      lastChecked: new Date().toISOString(),
    };
  }

  // ── Auto-sync ──────────────────────────────────────────────────────────────

  startWatcher(vaultId: string, window: BrowserWindow): void {
    const config = this.getAutoSyncConfig(vaultId);
    if (!config?.enabled) return;

    this.stopWatcher(vaultId);

    const vault = this.vaultService.getById(vaultId);
    if (!vault) return;

    const debounceMs = (config.debounceSeconds ?? 30) * 1000;
    const pollMs = Math.max(debounceMs, 60_000);

    logger.info(`Starting auto-sync for vault: ${vault.name} (debounce: ${config.debounceSeconds}s)`);

    const entry: WatcherEntry = {
      watcher: null as any,
      debounceTimer: null,
      pollInterval: null,
      pendingUpserts: new Set(),
      pendingDeletes: new Set(),
    };

    entry.watcher = chokidar.watch(vault.localPath, {
      ignored: getChokidarIgnorePatterns(),
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 1500, pollInterval: 200 },
    });

    const toRel = (absPath: string) =>
      path.relative(vault.localPath, absPath).replace(/\\/g, '/');

    const scheduleFlush = () => {
      if (entry.debounceTimer) clearTimeout(entry.debounceTimer);
      entry.debounceTimer = setTimeout(async () => {
        const upserts = new Set(entry.pendingUpserts);
        const deletes = new Set(entry.pendingDeletes);
        entry.pendingUpserts.clear();
        entry.pendingDeletes.clear();

        // A rename shows up as delete-old + add-new.
        // If a path appears in both, it was re-added — treat as upsert only.
        for (const p of upserts) deletes.delete(p);

        logger.info(`Auto-sync flush: ${upserts.size} upsert(s), ${deletes.size} delete(s)`);
        await this.flushChanges(vaultId, vault.localPath, upserts, deletes, window);
        window.webContents.send(IPC.EVENT_AUTOSYNC_TRIGGERED, { vaultId });
      }, debounceMs);
    };

    entry.watcher.on('add',       (p) => { entry.pendingUpserts.add(toRel(p)); scheduleFlush(); });
    entry.watcher.on('change',    (p) => { entry.pendingUpserts.add(toRel(p)); scheduleFlush(); });
    entry.watcher.on('unlink',    (p) => { entry.pendingDeletes.add(toRel(p)); scheduleFlush(); });
    entry.watcher.on('unlinkDir', (p) => { entry.pendingDeletes.add(toRel(p)); scheduleFlush(); });
    entry.watcher.on('error',     (e) => logger.error('Watcher error', e));

    entry.pollInterval = setInterval(async () => {
      logger.info(`Auto-sync: polling remote for vault ${vaultId}`);
      await this.pull(vaultId, window, true);
    }, pollMs);

    // Initial pull on start
    this.pull(vaultId, window, true).catch(() => {});

    this.watchers.set(vaultId, entry);
  }

  /** Incrementally sync a known set of changed/deleted paths — fast path for auto-sync. */
  private async flushChanges(
    vaultId: string,
    vaultPath: string,
    upserts: Set<string>,
    deletes: Set<string>,
    window: BrowserWindow | null,
  ): Promise<void> {
    const creds = this.cloudProvider.getCredentials(vaultId);
    if (!creds) return;

    // Commit locally first so git history is accurate
    const git = this.git(vaultPath);
    await this.ensureGitRepo(git, vaultPath);
    await git.add('.').catch(() => {});
    const status = await git.status();
    if (status.files.length > 0) {
      await git.commit(`obsync: auto ${new Date().toISOString()}`).catch(() => {});
    }

    if (GIT_PROVIDERS.has(creds.provider)) {
      // For git providers just do a normal push
      await this.gitRemotePush(git, creds).catch(e =>
        logger.error('Auto-sync git push failed:', e)
      );
      return;
    }

    const provider = this.getProvider(creds);
    if (!provider) return;
    this.wireTokenRefresh(provider, vaultId);

    // Upload upserted files
    for (const relPath of upserts) {
      const absPath = path.join(vaultPath, relPath);
      if (!fs.existsSync(absPath)) {
        // File was deleted before debounce fired — treat as delete
        deletes.add(relPath);
        continue;
      }
      try {
        if (provider.pushFile) {
          await withRetry<SyncResult>(() => provider.pushFile!(vaultPath, relPath, creds));
          logger.info(`Auto-sync: uploaded ${relPath}`);
        }
      } catch (e) {
        logger.error(`Auto-sync: failed to upload ${relPath}:`, e);
      }
    }

    // Delete removed files from cloud
    for (const relPath of deletes) {
      try {
        if (provider.delete) {
          await withRetry<SyncResult>(() => provider.delete!(vaultPath, relPath, creds));
          logger.info(`Auto-sync: deleted ${relPath} from cloud`);
        }
      } catch (e) {
        logger.error(`Auto-sync: failed to delete ${relPath} from cloud:`, e);
      }
    }

    this.vaultService.updateLastSynced(vaultId);
    this.emitStatus(window, vaultId, 'synced',
      `Auto-synced: +${upserts.size} ~${deletes.size}`);
  }

  stopWatcher(vaultId: string): void {
    const entry = this.watchers.get(vaultId);
    if (!entry) return;
    if (entry.debounceTimer) clearTimeout(entry.debounceTimer);
    if (entry.pollInterval) clearInterval(entry.pollInterval);
    entry.watcher?.close().catch(() => {});
    this.watchers.delete(vaultId);
    logger.info(`Stopped auto-sync for vault ${vaultId}`);
  }

  stopAll(): void {
    for (const id of Array.from(this.watchers.keys())) this.stopWatcher(id);
  }

  restoreAll(window: BrowserWindow): void {
    const cfg = this.storageService.load();
    for (const [vaultId, autoConfig] of Object.entries(cfg.autoSyncConfigs ?? {})) {
      if (autoConfig.enabled) this.startWatcher(vaultId, window);
    }
  }

  setAutoSyncConfig(vaultId: string, config: AutoSyncConfig): void {
    const appConfig = this.storageService.load();
    this.storageService.update({
      autoSyncConfigs: { ...appConfig.autoSyncConfigs, [vaultId]: config },
    });
  }

  getAutoSyncConfig(vaultId: string): AutoSyncConfig | null {
    return this.storageService.load().autoSyncConfigs?.[vaultId] ?? null;
  }

  isWatching(vaultId: string): boolean {
    return this.watchers.has(vaultId);
  }

  // ── Git helpers ────────────────────────────────────────────────────────────

  private git(baseDir: string): SimpleGit {
    return simpleGit({ baseDir, binary: 'git', maxConcurrentProcesses: 1 });
  }

  private async ensureGitRepo(git: SimpleGit, vaultPath: string): Promise<void> {
    if (!fs.existsSync(path.join(vaultPath, '.git'))) {
      await git.init(['-b', 'main']);
      await git.addConfig('user.email', 'obsync@local', false, 'local');
      await git.addConfig('user.name', 'Obsync', false, 'local');
    }

    // Always keep .gitignore up to date
    fs.writeFileSync(path.join(vaultPath, '.gitignore'), GITIGNORE, 'utf-8');

    // Need at least one commit for git operations to work
    const log = await git.log().catch(() => ({ total: 0 }));
    if (log.total === 0) {
      await git.add('.gitignore');
      await git.commit('obsync: init', ['--allow-empty']).catch(() => {});
    }
  }

  private async gitRemotePush(git: SimpleGit, creds: CloudCredentials): Promise<SyncResult> {
    const branch = creds.meta['branch'] || 'main';
    const authUrl = this.buildAuthUrl(creds.meta['repoUrl'], creds.token);
    await git.remote(['set-url', 'origin', authUrl]);

    try {
      await git.push(['origin', branch, '--set-upstream']);
    } catch (pushErr) {
      const m = String(pushErr);
      if (m.includes('non-fast-forward') || m.includes('rejected')) {
        await git.pull(['origin', branch, '--allow-unrelated-histories', '--no-rebase']);
        await git.push(['origin', branch, '--set-upstream']);
      } else throw pushErr;
    }
    return ok('Pushed to remote');
  }

  private async gitRemotePull(git: SimpleGit, creds: CloudCredentials): Promise<SyncResult> {
    const branch = creds.meta['branch'] || 'main';
    const authUrl = this.buildAuthUrl(creds.meta['repoUrl'], creds.token);
    await git.remote(['set-url', 'origin', authUrl]);

    const result = await git.pull('origin', branch, { '--allow-unrelated-histories': null });
    if (result.files.length === 0) return ok('Already up to date', 0);

    const conflicts = result.files.filter(f => f.includes('CONFLICT'));
    if (conflicts.length > 0) {
      return {
        success: false,
        message: 'Merge conflicts detected',
        conflicts: conflicts.map(f => ({ filePath: f, localModified: '', remoteModified: '' })),
      };
    }
    return ok(`Pulled ${result.files.length} file(s)`, result.files.length);
  }

  // ── Cloud file push/pull (non-Git providers) ───────────────────────────────
  // Files are uploaded/downloaded as actual files — visible in OneDrive/Dropbox/etc.
  // Git is used locally for change tracking and conflict detection only.

  private async cloudFilePush(
    vaultPath: string,
    vaultId: string,
    creds: CloudCredentials,
    window: BrowserWindow | null,
  ): Promise<SyncResult> {
    const provider = this.getProvider(creds);
    if (!provider) return err(`No provider for ${creds.provider}`);
    this.wireTokenRefresh(provider, vaultId);

    this.emitStatus(window, vaultId, 'syncing', 'Uploading to cloud...');

    // provider.push() uploads all local files and removes cloud orphans (cleanupRemote)
    const pushResult = await withRetry<SyncResult>(() => provider.push(vaultPath, creds));
    return pushResult;
  }

  private async cloudFilePull(
    git: SimpleGit,
    vaultPath: string,
    vaultId: string,
    creds: CloudCredentials,
    window: BrowserWindow | null,
  ): Promise<SyncResult> {
    const provider = this.getProvider(creds);
    if (!provider) return err(`No provider for ${creds.provider}`);
    this.wireTokenRefresh(provider, vaultId);

    this.emitStatus(window, vaultId, 'syncing', 'Scanning cloud for changes...');

    // Get the full cloud file listing
    const scanResult: SyncResult & { entries?: any[] } = await withRetry<SyncResult & { entries?: any[] }>(
      () => provider.pull(vaultPath, creds)
    );
    if (!scanResult.success) return scanResult;

    const cloudEntries: any[] = scanResult.entries ?? [];

    // Build a map of cloud files: relPath → { size, lastmod }
    // path_display is now vault-relative (e.g. "Notes/file.md") in all providers
    const cloudFiles = new Map<string, { size: number; lastmod: number }>();
    for (const entry of cloudEntries) {
      if (!entry || entry['.tag'] === 'folder') continue;
      const relPath: string = (entry.path_display ?? '').replace(/\\/g, '/').replace(/^\/+/, '');
      if (!relPath) continue;
      cloudFiles.set(relPath, {
        size: entry.size ?? 0,
        lastmod: entry.lastmod ? new Date(entry.lastmod).getTime() : 0,
      });
    }

    // Build a map of local files: relPath → { size, mtime }
    const localFiles = new Map<string, { size: number; mtime: number }>();
    for (const absPath of collectVaultFiles(vaultPath)) {
      const rel = path.relative(vaultPath, absPath).replace(/\\/g, '/');
      try {
        const stat = fs.statSync(absPath);
        localFiles.set(rel, { size: stat.size, mtime: stat.mtimeMs });
      } catch { /* skip */ }
    }

    let downloaded = 0;
    let deleted = 0;
    const failed: string[] = [];

    // ── Download: files on cloud that are new or newer than local ─────────
    const toDownload: string[] = [];
    for (const [relPath, cloud] of cloudFiles) {
      const local = localFiles.get(relPath);
      if (!local) {
        // New file on cloud
        toDownload.push(relPath);
      } else {
        // Exists locally — download if cloud is meaningfully newer (>2s grace)
        // and size differs (avoids re-downloading identical files)
        if (cloud.lastmod > local.mtime + 2000 && cloud.size !== local.size) {
          toDownload.push(relPath);
        }
      }
    }

    this.emitStatus(window, vaultId, 'syncing',
      `Downloading ${toDownload.length} file(s)...`);

    for (const relPath of toDownload) {
      try {
        if (provider.pullFile) {
          const res = await withRetry<SyncResult>(() =>
            provider.pullFile!(vaultPath, relPath, creds)
          );
          if (res.success) {
            downloaded++;
            logger.info(`Pulled: ${relPath}`);
          } else {
            failed.push(relPath);
            logger.warn(`Failed to pull ${relPath}: ${res.message}`);
          }
        }
      } catch (e) {
        failed.push(relPath);
        logger.error(`Error pulling ${relPath}:`, e);
      }
    }

    // ── Delete: files that exist locally but are gone from cloud ──────────
    // Safety: if cloud returned 0 files, something went wrong with the scan —
    // never delete local files when the cloud listing looks empty.
    if (cloudFiles.size === 0 && localFiles.size > 0) {
      logger.warn('Cloud returned 0 files but vault has local files — skipping delete pass to avoid data loss');
    } else {
      for (const [relPath] of localFiles) {
        if (!cloudFiles.has(relPath)) {
          try {
            const tracked = await git.raw(['ls-files', '--error-unmatch', relPath])
              .then(() => true)
              .catch(() => false);

            if (tracked) {
              const absPath = path.join(vaultPath, relPath);
              await this.historyService.archiveFile(vaultPath, relPath);
              fs.rmSync(absPath, { force: true });
              deleted++;
              logger.info(`Deleted locally (removed from cloud): ${relPath}`);
            }
          } catch { /* skip */ }
        }
      }
    }

    // ── Commit everything into local git ──────────────────────────────────
    await git.add('.').catch(() => {});
    const status = await git.status();
    if (status.files.length > 0) {
      await git.commit(`obsync: pull ${new Date().toISOString()}`).catch(() => {});
    }

    const total = downloaded + deleted;
    const message = total > 0
      ? `Pulled ${downloaded} file(s), removed ${deleted} locally`
      : 'Already up to date';

    if (failed.length > 0) {
      logger.warn(`Pull completed with ${failed.length} failure(s): ${failed.slice(0, 5).join(', ')}`);
    }

    return ok(message, total);
  }

  // ── Clone helpers ──────────────────────────────────────────────────────────

  private async cloneFromGitRemote(targetPath: string, credentials: CloudCredentials): Promise<void> {
    const branch = credentials.meta['branch'] || 'main';
    const authUrl = this.buildAuthUrl(credentials.meta['repoUrl'], credentials.token);

    if (fs.existsSync(path.join(targetPath, '.git'))) {
      const git = this.git(targetPath);
      await git.remote(['set-url', 'origin', authUrl]).catch(() => git.addRemote('origin', authUrl));
      await git.pull('origin', branch, { '--allow-unrelated-histories': null });
      return;
    }

    const entries = fs.readdirSync(targetPath);
    if (entries.length > 0) {
      const git = this.git(targetPath);
      await this.ensureGitRepo(git, targetPath);
      await git.addRemote('origin', authUrl).catch(() => git.remote(['set-url', 'origin', authUrl]));
      await git.fetch('origin', branch);
      await git.raw(['reset', '--hard', `origin/${branch}`]);
      return;
    }

    const parentDir = path.dirname(targetPath);
    const folderName = path.basename(targetPath);
    await simpleGit(parentDir).clone(authUrl, folderName, ['--branch', branch]);
  }

  private async cloneFromCloud(targetPath: string, credentials: CloudCredentials): Promise<void> {
    const provider = this.getProvider(credentials);
    if (!provider) throw new Error(`No provider for ${credentials.provider}`);

    // Ensure cloudVaultName is set in meta so the provider looks for the right folder.
    // If not provided, default to the local folder name.
    const credsWithName: CloudCredentials = {
      ...credentials,
      meta: {
        ...credentials.meta,
        cloudVaultName: (credentials.meta['cloudVaultName'] as string | undefined)?.trim()
          || path.basename(targetPath),
      },
    };

    // Download all files from cloud into the target directory
    const pullResult = await provider.pull(targetPath, credsWithName);
    if (!pullResult.success) throw new Error(pullResult.message);

    // Initialize local git repo and commit the downloaded files
    const git = this.git(targetPath);
    await this.ensureGitRepo(git, targetPath);
    await git.add('.');
    const status = await git.status();
    if (status.staged.length > 0 || status.not_added.length > 0) {
      await git.commit('obsync: imported from cloud').catch(() => {});
    }
  }

  // ── Provider access ────────────────────────────────────────────────────────

  private getProvider(creds: CloudCredentials): any {
    return (this.cloudProvider as any).providers[creds.provider] ?? null;
  }

  private wireTokenRefresh(provider: any, vaultId: string): void {
    provider.onTokenRefreshed = (newTokenJson: string) => {
      this.cloudProvider.persistRefreshedToken(vaultId, newTokenJson);
    };
  }

  // ── Utilities ──────────────────────────────────────────────────────────────

  private buildAuthUrl(repoUrl: string, token: string): string {
    if (!repoUrl) return '';
    return repoUrl.replace('https://', `https://${token}@`);
  }

  private emitStatus(window: BrowserWindow | null, vaultId: string, status: VaultSyncStatus['status'], message?: string): void {
    const s: VaultSyncStatus = { vaultId, status, message, lastChecked: new Date().toISOString() };
    this.statusMap.set(vaultId, s);
    if (window) window.webContents.send(IPC.EVENT_SYNC_PROGRESS, s);
    logger.info(`[${vaultId}] ${status}: ${message ?? ''}`);
  }

  private emitComplete(window: BrowserWindow | null, vaultId: string, result: SyncResult): void {
    if (window) window.webContents.send(IPC.EVENT_SYNC_COMPLETE, { vaultId, result });
  }
}

function ok(message: string, filesChanged?: number): SyncResult {
  return { success: true, message, filesChanged };
}
function err(message: string): SyncResult {
  return { success: false, message };
}
function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
