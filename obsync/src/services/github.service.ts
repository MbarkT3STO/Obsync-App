import simpleGit, { SimpleGit, SimpleGitOptions } from 'simple-git';
import fs from 'fs';
import path from 'path';
import { createLogger } from '../utils/logger.util';
import { encrypt, decrypt } from '../utils/crypto.util';
import type { GitHubConfig, GitHubCredentials, SyncResult, ConflictInfo } from '../models/github.model';
import type { StorageService } from './storage.service';

const logger = createLogger('GitHubService');

export class GitHubService {
  constructor(private readonly storage: StorageService) {}

  saveConfig(vaultId: string, credentials: GitHubCredentials): void {
    const config = this.storage.load();
    const githubConfig: GitHubConfig = {
      repoUrl: credentials.repoUrl,
      branch: credentials.branch,
      encryptedToken: encrypt(credentials.token),
    };
    this.storage.update({
      githubConfigs: { ...config.githubConfigs, [vaultId]: githubConfig },
    });
    logger.info(`GitHub config saved for vault ${vaultId}`);
  }

  getConfig(vaultId: string): GitHubConfig | null {
    return this.storage.load().githubConfigs[vaultId] ?? null;
  }

  getDecryptedToken(vaultId: string): string | null {
    const config = this.getConfig(vaultId);
    if (!config) return null;
    try {
      return decrypt(config.encryptedToken);
    } catch {
      logger.error(`Failed to decrypt token for vault ${vaultId}`);
      return null;
    }
  }

  async validate(credentials: GitHubCredentials): Promise<boolean> {
    try {
      // Parse owner/repo from URL: https://github.com/owner/repo or https://github.com/owner/repo.git
      const match = credentials.repoUrl.match(/github\.com[/:]([^/]+)\/([^/.]+)/);
      if (!match) {
        logger.warn('Could not parse owner/repo from URL:', credentials.repoUrl);
        return false;
      }
      const [, owner, repo] = match;

      // Use GitHub REST API to check repo access — no git binary needed
      const response = await this.githubApiRequest(
        `/repos/${owner}/${repo}`,
        credentials.token,
      );
      logger.info(`Validation response status: ${response.status}`);
      return response.status === 200;
    } catch (err) {
      logger.warn('GitHub validation failed', err);
      return false;
    }
  }

  private githubApiRequest(endpoint: string, token: string): Promise<{ status: number }> {
    return new Promise((resolve, reject) => {
      const https = require('https') as typeof import('https');
      const options = {
        hostname: 'api.github.com',
        path: endpoint,
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${token}`,
          'User-Agent': 'Obsync/1.0.0',
          'Accept': 'application/vnd.github+json',
        },
      };
      const req = https.request(options, (res) => {
        // Drain the response body so the socket closes cleanly
        res.resume();
        resolve({ status: res.statusCode ?? 0 });
      });
      req.on('error', reject);
      req.setTimeout(10000, () => { req.destroy(); reject(new Error('Request timed out')); });
      req.end();
    });
  }

  async initRepo(vaultPath: string, credentials: GitHubCredentials): Promise<SyncResult> {
    try {
      const isRepo = fs.existsSync(path.join(vaultPath, '.git'));
      const git = this.buildGit(vaultPath);

      if (!isRepo) {
        await git.init(['-b', credentials.branch]);
        logger.info(`Initialized git repo at ${vaultPath} on branch ${credentials.branch}`);
      } else {
        // Ensure local branch matches configured branch
        const branchSummary = await git.branchLocal();
        const currentBranch = branchSummary.current;
        if (currentBranch !== credentials.branch) {
          logger.info(`Renaming branch ${currentBranch} → ${credentials.branch}`);
          await git.branch(['-m', currentBranch, credentials.branch]);
        }
      }

      // Always ensure remote is set with current auth token
      const remotes = await git.getRemotes();
      const authUrl = this.buildAuthUrl(credentials.repoUrl, credentials.token);

      if (remotes.find(r => r.name === 'origin')) {
        await git.remote(['set-url', 'origin', authUrl]);
      } else {
        await git.addRemote('origin', authUrl);
      }

      // Ensure git identity is set locally (needed for commits)
      await git.addConfig('user.email', 'obsync@local', false, 'local');
      await git.addConfig('user.name', 'Obsync', false, 'local');

      return { success: true, message: 'Repository initialized' };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      logger.error('Init repo failed', err);
      return { success: false, message };
    }
  }

  async push(vaultPath: string, vaultId: string): Promise<SyncResult> {
    const credentials = this.getCredentials(vaultId);
    if (!credentials) return { success: false, message: 'GitHub not configured for this vault' };

    logger.info(`Push started for vault: ${vaultPath}`);

    try {
      const git = this.buildGit(vaultPath);

      // Ensure repo is initialized and remote auth URL is fresh
      const isRepo = fs.existsSync(path.join(vaultPath, '.git'));
      logger.info(`Is git repo: ${isRepo}, path: ${vaultPath}`);

      if (!isRepo) {
        logger.info('No .git found — initializing repo first');
        const initResult = await this.initRepo(vaultPath, credentials);
        logger.info(`Init result: ${JSON.stringify(initResult)}`);
        if (!initResult.success) return initResult;
      } else {
        const authUrl = this.buildAuthUrl(credentials.repoUrl, credentials.token);
        const remotes = await git.getRemotes();
        logger.info(`Existing remotes: ${JSON.stringify(remotes.map(r => r.name))}`);
        if (remotes.find(r => r.name === 'origin')) {
          await git.remote(['set-url', 'origin', authUrl]);
        } else {
          await git.addRemote('origin', authUrl);
        }
        await git.addConfig('user.email', 'obsync@local', false, 'local');
        await git.addConfig('user.name', 'Obsync', false, 'local');
      }

      logger.info('Running git status...');
      const status = await git.status();

      // Ensure we're on the right branch
      const branchSummary = await git.branchLocal();
      if (branchSummary.current !== credentials.branch) {
        logger.info(`Branch mismatch: ${branchSummary.current} vs ${credentials.branch} — renaming`);
        await git.branch(['-m', branchSummary.current, credentials.branch]);
      }

      logger.info(`files: ${status.files.length}, not_added: ${status.not_added.length}, isClean: ${status.isClean()}`);
      logger.info(`not_added list: ${JSON.stringify(status.not_added)}`);
      logger.info(`files list: ${JSON.stringify(status.files)}`);

      const hasChanges = status.files.length > 0 || status.not_added.length > 0;

      if (!hasChanges) {
        const diskFiles = fs.readdirSync(vaultPath).filter(f => f !== '.git');
        logger.info(`Disk files (${diskFiles.length}): ${JSON.stringify(diskFiles.slice(0, 10))}`);

        if (diskFiles.length === 0) {
          return { success: true, message: 'Nothing to push — vault is empty', filesChanged: 0 };
        }

        logger.info('Files on disk but git sees nothing — forcing git add --all');
        await git.add('--all');
        const statusAfterAdd = await git.status();
        logger.info(`After force add — files: ${statusAfterAdd.files.length}`);

        if (statusAfterAdd.files.length === 0) {
          return { success: true, message: 'Nothing to push — already up to date', filesChanged: 0 };
        }

        await git.commit(`obsync: sync ${new Date().toISOString()}`);
        await git.push(['origin', credentials.branch, '--set-upstream']);
        return { success: true, message: `Pushed ${statusAfterAdd.files.length} file(s)`, filesChanged: statusAfterAdd.files.length };
      }

      const totalFiles = status.files.length + status.not_added.length;
      await git.add('.');
      await git.commit(`obsync: sync ${new Date().toISOString()}`);

      // Try push — if rejected (non-fast-forward), pull with unrelated histories then push
      try {
        await git.push(['origin', credentials.branch, '--set-upstream']);
      } catch (pushErr) {
        const pushMsg = pushErr instanceof Error ? pushErr.message : '';
        if (pushMsg.includes('non-fast-forward') || pushMsg.includes('rejected')) {
          logger.info('Push rejected — pulling with --allow-unrelated-histories first');
          await git.pull(['origin', credentials.branch, '--allow-unrelated-histories', '--no-rebase']);
          await git.push(['origin', credentials.branch, '--set-upstream']);
        } else {
          throw pushErr;
        }
      }

      logger.info(`Pushed ${totalFiles} file(s) for vault ${vaultId}`);
      return { success: true, message: `Pushed ${totalFiles} file(s)`, filesChanged: totalFiles };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Push failed';
      logger.error('Push EXCEPTION:', err);
      return { success: false, message };
    }
  }

  async pull(vaultPath: string, vaultId: string): Promise<SyncResult> {
    const credentials = this.getCredentials(vaultId);
    if (!credentials) return { success: false, message: 'GitHub not configured for this vault' };

    try {
      const isRepo = fs.existsSync(path.join(vaultPath, '.git'));

      if (!isRepo) {
        // Clone into the vault directory
        const parentDir = path.dirname(vaultPath);
        const folderName = path.basename(vaultPath);
        const parentGit = simpleGit(parentDir);
        await parentGit.clone(this.buildAuthUrl(credentials.repoUrl, credentials.token), folderName);
        return { success: true, message: 'Repository cloned successfully' };
      }

      const git = this.buildGit(vaultPath);

      // Refresh remote auth URL
      const authUrl = this.buildAuthUrl(credentials.repoUrl, credentials.token);
      const remotes = await git.getRemotes();
      if (remotes.find(r => r.name === 'origin')) {
        await git.remote(['set-url', 'origin', authUrl]);
      } else {
        await git.addRemote('origin', authUrl);
      }

      const result = await git.pull('origin', credentials.branch);
      const conflicts = this.detectConflicts(String(result.summary?.changes ?? ''));

      if (conflicts.length > 0) {
        return { success: false, message: 'Conflicts detected', conflicts };
      }

      return { success: true, message: `Pulled — ${result.summary?.changes ?? 'up to date'}` };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Pull failed';
      logger.error('Pull failed', err);
      return { success: false, message };
    }
  }

  private getCredentials(vaultId: string): GitHubCredentials | null {
    const config = this.getConfig(vaultId);
    if (!config) return null;
    const token = this.getDecryptedToken(vaultId);
    if (!token) return null;
    return { token, repoUrl: config.repoUrl, branch: config.branch };
  }

  private buildGit(baseDir: string): SimpleGit {
    const options: Partial<SimpleGitOptions> = {
      baseDir,
      binary: 'git',
      maxConcurrentProcesses: 1,
    };
    const git = simpleGit(options);
    git.env('GIT_ASKPASS', 'echo');
    git.env('GIT_TERMINAL_PROMPT', '0');
    return git;
  }

  private buildAuthUrl(repoUrl: string, token: string): string {
    // Inject token into HTTPS URL: https://token@github.com/user/repo.git
    return repoUrl.replace('https://', `https://${token}@`);
  }

  private detectConflicts(summary: string): ConflictInfo[] {
    // Basic conflict detection from git output
    const conflicts: ConflictInfo[] = [];
    const lines = summary.split('\n');
    for (const line of lines) {
      if (line.includes('CONFLICT')) {
        const match = line.match(/CONFLICT.*?:\s+(.+)/);
        if (match?.[1]) {
          conflicts.push({
            filePath: match[1].trim(),
            localModified: new Date().toISOString(),
            remoteModified: new Date().toISOString(),
          });
        }
      }
    }
    return conflicts;
  }
}
