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
import type { SyncResult, CloudCredentials, ICloudProvider } from '../models/cloud-sync.model';
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
  // Prevent poll-pull from running concurrently with a flush
  flushing: boolean;
}

export class GitSyncService {
  private statusMap = new Map<string, VaultSyncStatus>();
  private watchers = new Map<string, WatcherEntry>();
  // Per-vault sync lock — prevents concurrent push/pull on the same vault
  private syncingVaults = new Set<string>();
  // Tracks paths uploaded recently so cloudFilePull won't re-download them.
  // Keyed as "vaultId:relPath" to avoid cross-vault collisions.
  private recentlyPushed = new Map<string, number>(); // "vaultId:relPath" → timestamp

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

    if (this.syncingVaults.has(vaultId)) {
      logger.info(`[${vaultId}] Push skipped — sync already in progress`);
      return err('Sync already in progress for this vault');
    }
    this.syncingVaults.add(vaultId);

    this.emitStatus(window, vaultId, 'syncing', 'Committing changes...');

    try {
      // ── Acquire sync lock (non-Git providers only) ─────────────────────
      this.emitStatus(window, vaultId, 'syncing', 'Checking sync lock...');
      const lockResult = await this.acquireSyncLock(vaultId);
      if (!lockResult.acquired) {
        const info = lockResult.lockInfo!;
        const msg2 = `Vault is being synced by another device (${info.hostname}). Try again in a moment.`;
        this.emitStatus(window, vaultId, 'error', msg2);
        if (!silent) this.emitComplete(window, vaultId, err(msg2));
        this.syncingVaults.delete(vaultId);
        return err(msg2);
      }

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
    } finally {
      this.syncingVaults.delete(vaultId);
      await this.releaseSyncLock(vaultId).catch(() => {});
    }
  }

  async pull(vaultId: string, window: BrowserWindow | null, silent = false): Promise<SyncResult> {
    const vault = this.vaultService.getById(vaultId);
    if (!vault) return err('Vault not found');
    const creds = this.cloudProvider.getCredentials(vaultId);
    if (!creds) return err('Provider not configured');

    if (this.syncingVaults.has(vaultId)) {
      logger.info(`[${vaultId}] Pull skipped — sync already in progress`);
      return err('Sync already in progress for this vault');
    }
    this.syncingVaults.add(vaultId);

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
    } finally {
      this.syncingVaults.delete(vaultId);
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

    const debounceMs = (config.debounceSeconds ?? 5) * 1000;
    const pollMs = Math.max((config.pollSeconds ?? 120) * 1000, 30_000);

    logger.info(`Starting auto-sync for vault: ${vault.name} (debounce: ${config.debounceSeconds ?? 5}s, poll: ${config.pollSeconds ?? 120}s)`);

    const entry: WatcherEntry = {
      watcher: null as any,
      debounceTimer: null,
      pollInterval: null,
      pendingUpserts: new Set(),
      pendingDeletes: new Set(),
      flushing: false,
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
        entry.flushing = true;
        try {
          await this.flushChanges(vaultId, vault.localPath, upserts, deletes, window);
        } finally {
          entry.flushing = false;
        }
        window.webContents.send(IPC.EVENT_AUTOSYNC_TRIGGERED, { vaultId });
      }, debounceMs);
    };

    entry.watcher.on('add',       (p) => { entry.pendingUpserts.add(toRel(p)); scheduleFlush(); });
    entry.watcher.on('change',    (p) => { entry.pendingUpserts.add(toRel(p)); scheduleFlush(); });
    entry.watcher.on('unlink',    (p) => { entry.pendingDeletes.add(toRel(p)); scheduleFlush(); });
    entry.watcher.on('unlinkDir', (p) => { entry.pendingDeletes.add(toRel(p)); scheduleFlush(); });
    entry.watcher.on('error',     (e) => logger.error('Watcher error', e));

    entry.pollInterval = setInterval(async () => {
      // Skip poll if a flush is in progress — avoids downloading files mid-rename
      if (entry.flushing) {
        logger.info(`Auto-sync: skipping poll for vault ${vaultId} (flush in progress)`);
        return;
      }
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
      await this.gitRemotePush(git, creds).catch(e =>
        logger.error('Auto-sync git push failed:', e)
      );
      return;
    }

    const provider = this.getProvider(creds);
    if (!provider) return;
    this.wireTokenRefresh(provider, vaultId);

    // ── Rename detection ───────────────────────────────────────────────────
    // Use git's own rename detection from the commit we just made.
    // git diff HEAD~1 HEAD --name-status -M detects renames natively.
    // This is reliable because the commit already recorded the rename.
    const renames = new Map<string, string>(); // oldPath → newPath

    if (provider.move && deletes.size > 0 && upserts.size > 0) {
      try {
        const diffOutput = await git.raw([
          'diff', 'HEAD~1', 'HEAD', '--name-status', '-M90', '--diff-filter=R'
        ]).catch(() => '');

        // Output format: "R100\toldName.md\tnewName.md"
        for (const line of diffOutput.split('\n')) {
          const parts = line.split('\t');
          if (parts.length === 3 && parts[0]!.startsWith('R')) {
            const oldPath = parts[1]!.trim();
            const newPath = parts[2]!.trim();
            // Only treat as rename if both sides are in our pending sets
            if (deletes.has(oldPath) && upserts.has(newPath)) {
              renames.set(oldPath, newPath);
              logger.info(`Rename detected via git: ${oldPath} → ${newPath}`);
            }
          }
        }
      } catch { /* git diff failed — no rename detection, fall through */ }
    }

    // ── Step 1: Execute renames atomically on cloud ────────────────────────
    for (const [oldPath, newPath] of renames) {
      try {
        await withRetry<SyncResult>(() => provider.move!(vaultPath, oldPath, newPath, creds));
        logger.info(`Auto-sync: moved ${oldPath} → ${newPath} on cloud`);
        // Remove from the individual upsert/delete sets — handled as rename
        upserts.delete(newPath);
        deletes.delete(oldPath);
        this.recentlyPushed.set(`${vaultId}:${newPath}`, Date.now());
      } catch (e) {
        logger.warn(`Auto-sync: move failed for ${oldPath} → ${newPath}, falling back to delete+upload:`, e);        // Leave in upserts/deletes to be handled below
      }
    }

    // ── Step 2: Delete removed files FIRST to avoid both names on cloud ────
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

    // ── Step 3: Upload new/modified files ──────────────────────────────────
    for (const relPath of upserts) {
      const absPath = path.join(vaultPath, relPath);
      if (!fs.existsSync(absPath)) {
        // Disappeared before debounce fired — already deleted above if needed
        continue;
      }
      try {
        if (provider.pushFile) {
          await withRetry<SyncResult>(() => provider.pushFile!(vaultPath, relPath, creds));
          logger.info(`Auto-sync: uploaded ${relPath}`);
          this.recentlyPushed.set(`${vaultId}:${relPath}`, Date.now());
        }
      } catch (e) {
        logger.error(`Auto-sync: failed to upload ${relPath}:`, e);
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

  // ── Vault Health Check ─────────────────────────────────────────────────────

  async healthCheck(vaultId: string): Promise<import('../models/history.model').HealthCheckResult> {
    const vault = this.vaultService.getById(vaultId);
    const issues: import('../models/history.model').HealthIssue[] = [];

    if (!vault) {
      return { vaultId, healthy: false, repairable: false, issues: [{ code: 'no_config', message: 'Vault not found', severity: 'error' }] };
    }

    const creds = this.cloudProvider.getCredentials(vaultId);
    if (!creds) {
      issues.push({ code: 'no_config', message: 'No cloud provider configured for this vault', severity: 'warning' });
    }

    const gitDir = path.join(vault.localPath, '.git');
    if (!fs.existsSync(gitDir)) {
      issues.push({ code: 'git_corrupt', message: 'Git repository not initialised (.git directory missing)', severity: 'error' });
      return { vaultId, healthy: false, repairable: true, issues };
    }

    try {
      const git = this.git(vault.localPath);

      // Check for detached HEAD
      try {
        const head = await git.raw(['symbolic-ref', '--short', 'HEAD']);
        if (!head.trim()) throw new Error('detached');
      } catch {
        issues.push({ code: 'detached_head', message: 'Git HEAD is detached — branch tracking may be broken', severity: 'warning' });
      }

      // Check for uncommitted changes
      try {
        const status = await git.status();
        if (status.files.length > 0) {
          issues.push({ code: 'uncommitted_changes', message: `${status.files.length} uncommitted change(s) in the working tree`, severity: 'warning' });
        }
      } catch {
        issues.push({ code: 'git_corrupt', message: 'Could not read git status — repository may be corrupt', severity: 'error' });
      }

      // Check remote reachability (Git providers only)
      if (creds && GIT_PROVIDERS.has(creds.provider)) {
        const remotes = await git.getRemotes().catch(() => []);
        if (!remotes.find(r => r.name === 'origin')) {
          issues.push({ code: 'no_remote', message: 'No git remote "origin" configured', severity: 'error' });
        } else {
          try {
            const authUrl = this.buildAuthUrl(creds.meta['repoUrl'], creds.token);
            await git.raw(['ls-remote', '--exit-code', '--heads', authUrl]);
          } catch (e) {
            const m = String(e);
            if (m.includes('Authentication') || m.includes('403') || m.includes('401')) {
              issues.push({ code: 'remote_unreachable', message: 'Remote authentication failed — token may be expired or invalid', severity: 'error' });
            } else if (m.includes('not found') || m.includes('404') || m.includes('Repository')) {
              issues.push({ code: 'remote_unreachable', message: 'Remote repository not found — URL may be incorrect', severity: 'error' });
            } else {
              issues.push({ code: 'remote_unreachable', message: `Remote unreachable: ${m.slice(0, 120)}`, severity: 'error' });
            }
          }
        }
      } else if (creds && !GIT_PROVIDERS.has(creds.provider)) {
        // Non-git: validate credentials via provider
        try {
          const result = await this.cloudProvider.validate(creds);
          if (!result.success) {
            issues.push({ code: 'remote_unreachable', message: `Cloud provider unreachable: ${result.message}`, severity: 'error' });
          }
        } catch (e) {
          issues.push({ code: 'remote_unreachable', message: `Could not reach cloud provider: ${msg(e)}`, severity: 'error' });
        }
      }

    } catch (e) {
      issues.push({ code: 'git_corrupt', message: `Git repository appears corrupt: ${msg(e)}`, severity: 'error' });
    }

    const hasErrors = issues.some(i => i.severity === 'error');
    const repairable = issues.some(i => i.code === 'git_corrupt' || i.code === 'no_remote' || i.code === 'detached_head');
    return { vaultId, healthy: !hasErrors, repairable, issues };
  }

  async repairVault(vaultId: string): Promise<SyncResult> {
    const vault = this.vaultService.getById(vaultId);
    if (!vault) return err('Vault not found');
    const creds = this.cloudProvider.getCredentials(vaultId);

    try {
      const git = this.git(vault.localPath);
      await this.ensureGitRepo(git, vault.localPath);

      // Re-attach HEAD if detached
      try {
        await git.raw(['symbolic-ref', '--short', 'HEAD']);
      } catch {
        const branch = creds?.meta['branch'] || 'main';
        await git.checkout(['-B', branch]).catch(() => {});
        logger.info(`[${vaultId}] Repair: re-attached HEAD to ${branch}`);
      }

      // Re-add remote if missing (Git providers)
      if (creds && GIT_PROVIDERS.has(creds.provider)) {
        const authUrl = this.buildAuthUrl(creds.meta['repoUrl'], creds.token);
        const remotes = await git.getRemotes();
        if (!remotes.find(r => r.name === 'origin')) {
          await git.addRemote('origin', authUrl);
          logger.info(`[${vaultId}] Repair: re-added remote origin`);
        } else {
          await git.remote(['set-url', 'origin', authUrl]);
        }
      }

      // Stage and commit any loose changes
      await git.add('.');
      const status = await git.status();
      if (status.files.length > 0) {
        await git.commit('obsync: repair commit').catch(() => {});
        logger.info(`[${vaultId}] Repair: committed ${status.files.length} loose file(s)`);
      }

      return ok('Vault repaired successfully');
    } catch (e) {
      return err(`Repair failed: ${msg(e)}`);
    }
  }

  // ── Multi-device sync lock ─────────────────────────────────────────────────
  // A lightweight JSON lock file is written to the cloud before any push.
  // Other machines check for this file and abort their push if the lock is held.
  // Locks auto-expire after LOCK_TTL_MS to prevent permanent deadlocks.

  private static readonly LOCK_FILE = '.obsync/sync.lock';
  private static readonly LOCK_TTL_MS = 5 * 60 * 1000; // 5 minutes

  private getMachineId(): string {
    // Use a stable per-machine identifier stored in app config
    const cfg = this.storageService.load();
    if ((cfg as any).machineId) return (cfg as any).machineId;
    const id = require('crypto').randomBytes(8).toString('hex');
    this.storageService.update({ ...(cfg as any), machineId: id } as any);
    return id;
  }

  async acquireSyncLock(vaultId: string): Promise<{ acquired: boolean; lockInfo?: import('../models/history.model').SyncLockInfo }> {
    const vault = this.vaultService.getById(vaultId);
    if (!vault) return { acquired: false };
    const creds = this.cloudProvider.getCredentials(vaultId);
    if (!creds) return { acquired: true }; // no cloud config — no lock needed

    // Git providers: lock is not needed (git itself serialises pushes via fast-forward rejection)
    if (GIT_PROVIDERS.has(creds.provider)) return { acquired: true };

    const provider = this.getProvider(creds);
    if (!provider?.pushFile || !provider?.pullFile) return { acquired: true };

    this.wireTokenRefresh(provider, vaultId);

    // Try to read existing lock
    const lockPath = path.join(vault.localPath, GitSyncService.LOCK_FILE);
    const lockDir = path.dirname(lockPath);
    if (!fs.existsSync(lockDir)) fs.mkdirSync(lockDir, { recursive: true });

    try {
      const res = await provider.pullFile(vault.localPath, GitSyncService.LOCK_FILE, creds);
      if (res.success && fs.existsSync(lockPath)) {
        const raw = fs.readFileSync(lockPath, 'utf-8');
        const existing: import('../models/history.model').SyncLockInfo = JSON.parse(raw);
        const expired = Date.now() > new Date(existing.expiresAt).getTime();
        if (!expired && existing.machineId !== this.getMachineId()) {
          return { acquired: false, lockInfo: existing };
        }
      }
    } catch { /* no lock file on cloud — proceed */ }

    // Write our lock
    const os = require('os');
    const lockInfo: import('../models/history.model').SyncLockInfo = {
      machineId: this.getMachineId(),
      hostname: os.hostname(),
      acquiredAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + GitSyncService.LOCK_TTL_MS).toISOString(),
    };
    fs.writeFileSync(lockPath, JSON.stringify(lockInfo, null, 2), 'utf-8');

    try {
      await provider.pushFile(vault.localPath, GitSyncService.LOCK_FILE, creds);
      logger.info(`[${vaultId}] Sync lock acquired by ${lockInfo.hostname}`);
    } catch (e) {
      logger.warn(`[${vaultId}] Could not upload sync lock: ${msg(e)}`);
    }

    return { acquired: true };
  }

  async releaseSyncLock(vaultId: string): Promise<void> {
    const vault = this.vaultService.getById(vaultId);
    if (!vault) return;
    const creds = this.cloudProvider.getCredentials(vaultId);
    if (!creds || GIT_PROVIDERS.has(creds.provider)) return;

    const provider = this.getProvider(creds);
    if (!provider?.delete) return;
    this.wireTokenRefresh(provider, vaultId);

    try {
      await provider.delete(vault.localPath, GitSyncService.LOCK_FILE, creds);
      logger.info(`[${vaultId}] Sync lock released`);
    } catch { /* best-effort */ }

    // Clean up local lock file
    const lockPath = path.join(vault.localPath, GitSyncService.LOCK_FILE);
    try { fs.rmSync(lockPath, { force: true }); } catch { /* ignore */ }
  }

  async checkSyncLock(vaultId: string): Promise<import('../models/history.model').SyncLockInfo | null> {
    const vault = this.vaultService.getById(vaultId);
    if (!vault) return null;
    const creds = this.cloudProvider.getCredentials(vaultId);
    if (!creds || GIT_PROVIDERS.has(creds.provider)) return null;

    const provider = this.getProvider(creds);
    if (!provider?.pullFile) return null;
    this.wireTokenRefresh(provider, vaultId);

    const lockPath = path.join(vault.localPath, GitSyncService.LOCK_FILE);
    const lockDir = path.dirname(lockPath);
    if (!fs.existsSync(lockDir)) fs.mkdirSync(lockDir, { recursive: true });

    try {
      const res = await provider.pullFile(vault.localPath, GitSyncService.LOCK_FILE, creds);
      if (res.success && fs.existsSync(lockPath)) {
        const raw = fs.readFileSync(lockPath, 'utf-8');
        const info: import('../models/history.model').SyncLockInfo = JSON.parse(raw);
        const expired = Date.now() > new Date(info.expiresAt).getTime();
        return expired ? null : info;
      }
    } catch { /* no lock */ }
    return null;
  }

  // ── Git helpers ────────────────────────────────────────────────────────────

  private git(baseDir: string): SimpleGit {
    return simpleGit({ baseDir, binary: 'git', maxConcurrentProcesses: 1 });
  }

  private async ensureGitRepo(git: SimpleGit, vaultPath: string): Promise<void> {
    const isNew = !fs.existsSync(path.join(vaultPath, '.git'));
    if (isNew) {
      await git.init(['-b', 'main']);
      await git.addConfig('user.email', 'obsync@local', false, 'local');
      await git.addConfig('user.name', 'Obsync', false, 'local');
    }

    // Write .gitignore only if it doesn't exist or content changed — avoids dirty state loops
    const gitignorePath = path.join(vaultPath, '.gitignore');
    const existing = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, 'utf-8') : '';
    if (existing !== GITIGNORE) {
      fs.writeFileSync(gitignorePath, GITIGNORE, 'utf-8');
    }

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

    if (!authUrl) return err('Repository URL is not configured');

    // Always update remote URL with current token
    const remotes = await git.getRemotes();
    if (remotes.find(r => r.name === 'origin')) {
      await git.remote(['set-url', 'origin', authUrl]);
    } else {
      await git.addRemote('origin', authUrl);
    }

    try {
      await git.push(['origin', branch, '--set-upstream']);
      return ok('Pushed to remote');
    } catch (pushErr) {
      const m = String(pushErr);

      if (m.includes('non-fast-forward') || m.includes('rejected')) {
        // Remote has commits we don't have — pull first, then push
        logger.info('Push rejected (non-fast-forward) — pulling first');
        const pullResult = await this.gitRemotePull(git, creds);
        if (!pullResult.success) return pullResult;
        await git.push(['origin', branch, '--set-upstream']);
        return ok('Pushed to remote (after pull)');
      }

      if (m.includes('does not have') || m.includes('src refspec') || m.includes('nothing to push')) {
        // Empty remote or branch doesn't exist yet — force push initial commit
        await git.push(['origin', `HEAD:refs/heads/${branch}`, '--set-upstream']);
        return ok('Pushed to remote (initial)');
      }

      throw pushErr;
    }
  }

  private async gitRemotePull(git: SimpleGit, creds: CloudCredentials): Promise<SyncResult> {
    const branch = creds.meta['branch'] || 'main';
    const authUrl = this.buildAuthUrl(creds.meta['repoUrl'], creds.token);

    if (!authUrl) return err('Repository URL is not configured');

    const remotes = await git.getRemotes();
    if (remotes.find(r => r.name === 'origin')) {
      await git.remote(['set-url', 'origin', authUrl]);
    } else {
      await git.addRemote('origin', authUrl);
    }

    // Stash any uncommitted local changes so pull doesn't fail
    const status = await git.status();
    const hasLocal = status.files.length > 0;
    if (hasLocal) {
      await git.stash(['push', '-u', '-m', 'obsync-autostash']).catch(() => {});
    }

    try {
      // Fetch first to check if remote branch exists
      await git.fetch('origin').catch(() => {});

      // Check if remote branch exists
      const remoteBranches = await git.branch(['-r']).catch(() => ({ all: [] as string[] }));
      const remoteHasBranch = remoteBranches.all.some(b => b.trim() === `origin/${branch}`);

      if (!remoteHasBranch) {
        if (hasLocal) await git.stash(['pop']).catch(() => {});
        return ok('Remote branch does not exist yet — nothing to pull', 0);
      }

      // Check if local branch exists
      const localBranches = await git.branchLocal();
      const localHasBranch = localBranches.all.includes(branch);

      let result;
      if (!localHasBranch) {
        // First pull — checkout the remote branch
        await git.checkout(['-b', branch, `origin/${branch}`]);
        result = { files: ['(initial checkout)'], summary: {} };
      } else {
        // Normal pull — use rebase=false to get a merge commit on conflict
        result = await git.pull('origin', branch, {
          '--no-rebase': null,
        }).catch(async (pullErr) => {
          const m = String(pullErr);
          if (m.includes('unrelated histories')) {
            return git.pull('origin', branch, { '--allow-unrelated-histories': null, '--no-rebase': null });
          }
          if (m.includes('Already up to date') || m.includes('up to date')) {
            return { files: [], summary: {} };
          }
          throw pullErr;
        });
      }

      // Pop stash
      if (hasLocal) await git.stash(['pop']).catch(() => {});

      if (!result.files || result.files.length === 0) {
        return ok('Already up to date', 0);
      }

      // Detect conflicts from git status after pull
      const postStatus = await git.status();
      if (postStatus.conflicted.length > 0) {
        return {
          success: false,
          message: `${postStatus.conflicted.length} conflict(s) detected`,
          conflicts: postStatus.conflicted.map(f => ({ filePath: f, localModified: '', remoteModified: '' })),
        };
      }

      return ok(`Pulled ${result.files.length} file(s)`, result.files.length);
    } catch (e) {
      if (hasLocal) await git.stash(['pop']).catch(() => {});
      const m = String(e);
      if (m.includes('Already up to date') || m.includes('up to date')) {
        return ok('Already up to date', 0);
      }
      throw e;
    }
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

    // Collect once — reuse for both the upload and the recentlyPushed cache
    const localFiles = collectVaultFiles(vaultPath);
    const pushResult = await withRetry<SyncResult>(() => provider.push(vaultPath, creds, false, localFiles));

    // Mark all local files as recently pushed so the next pull won't re-download them
    if (pushResult.success) {
      const now = Date.now();
      for (const absPath of localFiles) {
        const rel = path.relative(vaultPath, absPath).replace(/\\/g, '/');
        this.recentlyPushed.set(`${vaultId}:${rel}`, now);
      }
    }

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

    // ── Folder rename detection ────────────────────────────────────────────
    // When a folder is renamed on the cloud, the cloud listing shows files
    // under the new folder name but the old folder still exists locally.
    // Without this step the pull would download all files under the new name
    // AND leave the old folder intact (since the old files are "protected" by
    // the recentlyPushed / mtime guards), resulting in two copies.
    //
    // Strategy: find local files that are absent from the cloud but whose
    // filename+size matches a cloud file that is absent locally.  Group those
    // matches by their top-level directory prefix — if every file in an old
    // local directory maps 1-to-1 onto a new cloud directory, treat it as a
    // folder rename and move the files locally instead of download+delete.
    const renamedLocalPaths = new Set<string>(); // old paths handled by rename
    const renamedCloudPaths = new Set<string>();  // new paths handled by rename

    // Files only on cloud (candidates for "new path after rename")
    const cloudOnly = [...cloudFiles.keys()].filter(p => !localFiles.has(p));
    // Files only local (candidates for "old path before rename")
    const localOnly = [...localFiles.keys()].filter(p => !cloudFiles.has(p));

    if (cloudOnly.length > 0 && localOnly.length > 0) {
      // Build lookup: "filename:size" → [cloudRelPath, ...]
      const cloudOnlyByKey = new Map<string, string[]>();
      for (const cp of cloudOnly) {
        const key = `${path.basename(cp)}:${cloudFiles.get(cp)!.size}`;
        if (!cloudOnlyByKey.has(key)) cloudOnlyByKey.set(key, []);
        cloudOnlyByKey.get(key)!.push(cp);
      }

      // For each local-only file find a unique cloud match
      const localToCloud = new Map<string, string>(); // localRel → cloudRel
      for (const lp of localOnly) {
        const key = `${path.basename(lp)}:${localFiles.get(lp)!.size}`;
        const candidates = cloudOnlyByKey.get(key);
        if (candidates?.length === 1) {
          localToCloud.set(lp, candidates[0]!);
        }
      }

      // Group by old-dir → new-dir and check that ALL files in the old dir
      // are accounted for (avoids false positives on coincidental name+size matches)
      const dirPairs = new Map<string, { oldDir: string; newDir: string; files: Array<[string, string]> }>();
      for (const [lp, cp] of localToCloud) {
        const oldDir = lp.includes('/') ? lp.split('/')[0]! : '.';
        const newDir = cp.includes('/') ? cp.split('/')[0]! : '.';
        if (oldDir === newDir) continue; // same top-level dir — not a rename
        const key = `${oldDir}→${newDir}`;
        if (!dirPairs.has(key)) dirPairs.set(key, { oldDir, newDir, files: [] });
        dirPairs.get(key)!.files.push([lp, cp]);
      }

      for (const { oldDir, newDir, files } of dirPairs.values()) {
        // Verify every local file under oldDir is covered by this rename
        const allLocalInOldDir = localOnly.filter(p => p === oldDir || p.startsWith(`${oldDir}/`));
        if (files.length !== allLocalInOldDir.length) continue; // partial match — skip

        logger.info(`Folder rename detected on cloud: "${oldDir}" → "${newDir}" (${files.length} file(s))`);

        for (const [lp, cp] of files) {
          const srcAbs = path.join(vaultPath, lp);
          const dstAbs = path.join(vaultPath, cp);
          try {
            fs.mkdirSync(path.dirname(dstAbs), { recursive: true });
            fs.renameSync(srcAbs, dstAbs);
            logger.info(`  Renamed locally: ${lp} → ${cp}`);
            renamedLocalPaths.add(lp);
            renamedCloudPaths.add(cp);
            // Update localFiles map so the rest of the logic sees the new state
            const oldEntry = localFiles.get(lp);
            localFiles.delete(lp);
            localFiles.set(cp, { size: oldEntry?.size ?? cloudFiles.get(cp)!.size, mtime: Date.now() });
          } catch (e) {
            logger.warn(`  Failed to rename ${lp} → ${cp}:`, e);
          }
        }

        // Remove the now-empty old directory
        const oldDirAbs = path.join(vaultPath, oldDir);
        try {
          if (fs.existsSync(oldDirAbs) && fs.readdirSync(oldDirAbs).length === 0) {
            fs.rmdirSync(oldDirAbs);
            logger.info(`  Removed empty old directory: ${oldDir}`);
          }
        } catch { /* skip */ }
      }
    }

    let downloaded = 0;
    let deleted = 0;
    const failed: string[] = [];

    // ── Download: files on cloud that are new or newer than local ─────────
    // TTL must cover the full poll interval so a recently-pushed file is not
    // deleted locally before the next poll confirms it exists on the cloud.
    // Default poll is 120 s; use 10 min as a safe upper bound.
    const RECENTLY_PUSHED_TTL = 600_000; // 10 minutes
    const now = Date.now();
    const toDownload: string[] = [];
    for (const [relPath, cloud] of cloudFiles) {
      // Skip files already handled by folder rename
      if (renamedCloudPaths.has(relPath)) continue;
      // Skip files we just uploaded — their cloud lastmod will be newer than
      // local mtime (server receipt time), which would cause a spurious re-download
      const pushedAt = this.recentlyPushed.get(`${vaultId}:${relPath}`);
      if (pushedAt && now - pushedAt < RECENTLY_PUSHED_TTL) {
        logger.info(`cloudFilePull: skipping recently pushed file ${relPath}`);
        continue;
      }
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
    // Evict expired entries from recentlyPushed
    for (const [p, t] of this.recentlyPushed) {
      if (now - t >= RECENTLY_PUSHED_TTL) this.recentlyPushed.delete(p);
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
      for (const [relPath, local] of localFiles) {
        if (!cloudFiles.has(relPath)) {
          // Skip files already moved by folder rename detection above
          if (renamedLocalPaths.has(relPath)) continue;

          // Never delete a file we recently pushed — it may not yet appear in
          // the cloud listing (propagation delay) or the TTL window is still open.
          const pushedAt = this.recentlyPushed.get(`${vaultId}:${relPath}`);
          if (pushedAt && now - pushedAt < RECENTLY_PUSHED_TTL) {
            logger.info(`Skipping delete of recently pushed local file: ${relPath}`);
            continue;
          }

          // Only delete if the file hasn't been modified locally since the last
          // sync. A file modified very recently (within 10s) may be a new local
          // file that hasn't been pushed yet — don't delete it.
          const ageMs = now - local.mtime;
          if (ageMs < 10_000) {
            logger.info(`Skipping delete of recently modified local file: ${relPath}`);
            continue;
          }

          try {
            const absPath = path.join(vaultPath, relPath);
            await this.historyService.archiveFile(vaultPath, relPath);
            fs.rmSync(absPath, { force: true });
            deleted++;
            logger.info(`Deleted locally (removed from cloud): ${relPath}`);
          } catch { /* skip */ }
        }
      }

      // ── Remove empty directories left behind by file deletions ────────
      const cloudDirs = new Set<string>();
      for (const [relPath] of cloudFiles) {
        let dir = path.dirname(relPath).replace(/\\/g, '/');
        while (dir && dir !== '.') {
          cloudDirs.add(dir);
          dir = path.dirname(dir).replace(/\\/g, '/');
        }
      }

      const localDirs: string[] = [];
      const scanDirs = (dirPath: string, relBase: string) => {
        try {
          for (const entry of fs.readdirSync(dirPath)) {
            const full = path.join(dirPath, entry);
            const rel = relBase ? `${relBase}/${entry}` : entry;
            try {
              if (fs.statSync(full).isDirectory() && !rel.startsWith('.git') && !rel.startsWith('.obsync')) {
                localDirs.push(rel);
                scanDirs(full, rel);
              }
            } catch { /* skip */ }
          }
        } catch { /* skip */ }
      };
      scanDirs(vaultPath, '');

      // Deepest first so nested empty dirs are removed before their parents
      localDirs.sort((a, b) => b.split('/').length - a.split('/').length);

      for (const relDir of localDirs) {
        if (cloudDirs.has(relDir)) continue;
        const absDir = path.join(vaultPath, relDir);
        try {
          if (fs.readdirSync(absDir).length === 0) {
            fs.rmdirSync(absDir);
            logger.info(`Removed empty directory: ${relDir}`);
          }
        } catch { /* skip */ }
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

    if (!authUrl) throw new Error('Repository URL is required');

    // Already a git repo — just update remote and pull
    if (fs.existsSync(path.join(targetPath, '.git'))) {
      const git = this.git(targetPath);
      const remotes = await git.getRemotes();
      if (remotes.find(r => r.name === 'origin')) {
        await git.remote(['set-url', 'origin', authUrl]);
      } else {
        await git.addRemote('origin', authUrl);
      }
      await this.gitRemotePull(git, credentials);
      return;
    }

    // Empty directory — standard clone
    const entries = fs.readdirSync(targetPath).filter(e => e !== '.gitignore');
    if (entries.length === 0) {
      const parentDir = path.dirname(targetPath);
      const folderName = path.basename(targetPath);
      // Clone into a temp name then move, since clone requires the target to not exist
      const tempName = `${folderName}_obsync_tmp_${Date.now()}`;
      await simpleGit(parentDir).clone(authUrl, tempName, ['--branch', branch]);
      const tempPath = path.join(parentDir, tempName);
      // Move contents into targetPath
      for (const item of fs.readdirSync(tempPath)) {
        fs.renameSync(path.join(tempPath, item), path.join(targetPath, item));
      }
      try { fs.rmdirSync(tempPath); } catch {}
      return;
    }

    // Non-empty directory — init repo, add remote, fetch and merge
    const git = this.git(targetPath);
    await this.ensureGitRepo(git, targetPath);
    const remotes = await git.getRemotes();
    if (remotes.find(r => r.name === 'origin')) {
      await git.remote(['set-url', 'origin', authUrl]);
    } else {
      await git.addRemote('origin', authUrl);
    }
    await this.gitRemotePull(git, credentials);
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

  private getProvider(creds: CloudCredentials): ICloudProvider | null {
    return this.cloudProvider.getProvider(creds.provider);
  }

  private wireTokenRefresh(provider: ICloudProvider, vaultId: string): void {
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
