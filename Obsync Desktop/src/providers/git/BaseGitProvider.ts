/**
 * BaseGitProvider — common git sync logic shared by all git-based providers.
 *
 * Subclasses override:
 *  - getRemoteUrl()    → construct the authenticated HTTPS remote URL
 *  - getProviderName() → human-readable name for logging
 *
 * Git providers treat the git history as the manifest, so getRemoteManifest()
 * returns null and uploadManifest() is a no-op.
 */

import simpleGit, { SimpleGit } from 'simple-git';
import fs from 'fs';
import path from 'path';
import type {
  SyncProvider,
  ProviderCredentials,
  FileManifest,
  CommitEntry,
} from '../SyncProvider';
import { createLogger } from '../../utils/logger.util';

const logger = createLogger('BaseGitProvider');

/** .gitignore written into every managed vault on first push */
const VAULT_GITIGNORE = [
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

export abstract class BaseGitProvider implements SyncProvider {
  abstract readonly id: string;
  abstract readonly name: string;
  abstract readonly icon: string;
  readonly type = 'git' as const;

  onTokenRefreshed?: (newTokenJson: string) => void;

  protected credentials: ProviderCredentials | null = null;
  protected vaultPath: string = '';

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  async connect(credentials: ProviderCredentials): Promise<void> {
    this.credentials = credentials;
    logger.info(`${this.name}: connected`);
  }

  async disconnect(): Promise<void> {
    this.credentials = null;
    logger.info(`${this.name}: disconnected`);
  }

  async testConnection(): Promise<boolean> {
    if (!this.credentials) return false;
    try {
      const remoteUrl = this.getRemoteUrl(this.credentials);
      const git = simpleGit();
      const result = await git.listRemote([remoteUrl]);
      return typeof result === 'string';
    } catch {
      return false;
    }
  }

  /** Set the vault path — must be called before any sync operations. */
  setVaultPath(vaultPath: string): void {
    this.vaultPath = vaultPath;
  }

  // ── Core sync operations ──────────────────────────────────────────────────

  /**
   * Git providers use git history as the manifest.
   * Returns null so SyncEngine falls back to full-scan diff.
   */
  async getRemoteManifest(): Promise<FileManifest | null> {
    return null;
  }

  /**
   * Stage and upload a single file.
   * For git providers, files are staged here and committed+pushed in bulk
   * by the SyncEngine after all uploads complete.
   */
  async uploadFile(relativePath: string, content: Buffer): Promise<void> {
    if (!this.vaultPath) throw new Error('vaultPath not set — call setVaultPath() first');
    const absPath = path.join(this.vaultPath, relativePath);
    const dir = path.dirname(absPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(absPath, content);
    const git = this.git();
    await git.add(relativePath);
  }

  async downloadFile(relativePath: string): Promise<Buffer> {
    if (!this.vaultPath) throw new Error('vaultPath not set');
    // For git providers, download = git pull then read the file
    const git = this.git();
    const creds = this.requireCredentials();
    const branch = creds.extra?.['branch'] ?? 'main';
    const remoteUrl = this.getRemoteUrl(creds);
    await git.remote(['set-url', 'origin', remoteUrl]);
    await git.pull('origin', branch, ['--no-rebase']);
    const absPath = path.join(this.vaultPath, relativePath);
    if (!fs.existsSync(absPath)) throw new Error(`File not found after pull: ${relativePath}`);
    return fs.readFileSync(absPath);
  }

  async deleteRemoteFile(relativePath: string): Promise<void> {
    if (!this.vaultPath) throw new Error('vaultPath not set');
    const git = this.git();
    const absPath = path.join(this.vaultPath, relativePath);
    if (fs.existsSync(absPath)) {
      fs.unlinkSync(absPath);
      await git.rm([relativePath]);
    }
  }

  /** No-op for git providers — git history IS the manifest. */
  async uploadManifest(_manifest: FileManifest): Promise<void> {
    // Commit and push all staged changes
    if (!this.vaultPath) return;
    const git = this.git();
    const creds = this.requireCredentials();
    const branch = creds.extra?.['branch'] ?? 'main';
    const remoteUrl = this.getRemoteUrl(creds);

    const status = await git.status();
    if (status.files.length === 0) return;

    await git.commit(`obsync: ${new Date().toISOString()}`);

    await git.remote(['set-url', 'origin', remoteUrl]);
    try {
      await git.push(['origin', branch, '--set-upstream']);
    } catch (pushErr) {
      const msg = String(pushErr);
      if (msg.includes('non-fast-forward') || msg.includes('rejected')) {
        await git.pull(['origin', branch, '--allow-unrelated-histories', '--no-rebase']);
        await git.push(['origin', branch, '--set-upstream']);
      } else {
        throw pushErr;
      }
    }
  }

  // ── Git-specific operations ───────────────────────────────────────────────

  async getCommitHistory(): Promise<CommitEntry[]> {
    if (!this.vaultPath) return [];
    try {
      const git = this.git();
      const log = await git.log(['--max-count=50', '--stat']);
      return log.all.map((c) => ({
        hash: c.hash,
        shortHash: c.hash.slice(0, 7),
        message: c.message,
        author: c.author_name,
        date: c.date,
        filesChanged: 0,
        insertions: 0,
        deletions: 0,
      }));
    } catch {
      return [];
    }
  }

  async getFileDiff(commitHash: string, filePath: string): Promise<string> {
    if (!this.vaultPath) return '';
    try {
      const git = this.git();
      return await git.diff([`${commitHash}~1`, commitHash, '--', filePath]);
    } catch {
      return '';
    }
  }

  // ── Initialisation helpers ────────────────────────────────────────────────

  /**
   * Ensure the vault directory is a git repo with the correct remote.
   * Called by the IPC init handler before the first sync.
   */
  async initRepo(): Promise<void> {
    if (!this.vaultPath) throw new Error('vaultPath not set');
    const creds = this.requireCredentials();
    const git = this.git();
    const branch = creds.extra?.['branch'] ?? 'main';

    if (!fs.existsSync(path.join(this.vaultPath, '.git'))) {
      await git.init(['-b', branch]);
      await git.addConfig('user.email', 'obsync@local', false, 'local');
      await git.addConfig('user.name', 'Obsync', false, 'local');
    }

    // Write .gitignore on first init
    const gitignorePath = path.join(this.vaultPath, '.gitignore');
    if (!fs.existsSync(gitignorePath)) {
      fs.writeFileSync(gitignorePath, VAULT_GITIGNORE, 'utf-8');
    }

    const remoteUrl = this.getRemoteUrl(creds);
    const remotes = await git.getRemotes();
    if (remotes.find((r) => r.name === 'origin')) {
      await git.remote(['set-url', 'origin', remoteUrl]);
    } else {
      await git.addRemote('origin', remoteUrl);
    }
  }

  // ── Subclass contract ─────────────────────────────────────────────────────

  /**
   * Construct the authenticated HTTPS remote URL for this provider.
   * e.g. https://{token}@github.com/user/repo.git
   */
  protected abstract getRemoteUrl(credentials: ProviderCredentials): string;

  // ── Internal helpers ──────────────────────────────────────────────────────

  protected git(): SimpleGit {
    return simpleGit({
      baseDir: this.vaultPath,
      binary: 'git',
      maxConcurrentProcesses: 1,
    });
  }

  protected requireCredentials(): ProviderCredentials {
    if (!this.credentials) throw new Error(`${this.name}: not connected — call connect() first`);
    return this.credentials;
  }
}
