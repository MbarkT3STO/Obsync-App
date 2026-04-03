import simpleGit, { SimpleGit } from 'simple-git';
import fs from 'fs';
import path from 'path';
import { createLogger } from '../../utils/logger.util';
import type { 
  ICloudProvider, 
  CloudCredentials, 
  SyncResult, 
  ConflictInfo 
} from '../../models/cloud-sync.model';

const logger = createLogger('GitCloudProvider');

/** Implementation for all Git-based services (GitHub, GitLab, Self-hosted) */
export class GitCloudProvider implements ICloudProvider {
  
  async validate(creds: CloudCredentials): Promise<SyncResult> {
    try {
      // API check for GitHub/GitLab
      if (creds.provider === 'github' || creds.provider === 'gitlab') {
        const url = this.getApiUrl(creds);
        if (url) {
          const resp = await this.apiGet(url, creds.token);
          if (resp.status === 200) return { success: true, message: 'Connected' };
        }
      }

      // Fallback: list-remote for generic GIT
      const authUrl = this.buildAuthUrl(creds.meta['repoUrl'], creds.token);
      const tempGit = simpleGit();
      const result = await tempGit.listRemote([authUrl]);
      return !!result ? { success: true, message: 'Connected' } : { success: false, message: 'Failed to access remote' };
    } catch (err) {
      return { success: false, message: 'Invalid credentials' };
    }
  }

  async push(vaultPath: string, creds: CloudCredentials): Promise<SyncResult> {
    try {
      const git = this.buildGit(vaultPath);
      const isRepo = fs.existsSync(path.join(vaultPath, '.git'));
      if (!isRepo) {
        const initRes = await this.init(vaultPath, creds);
        if (!initRes.success) return initRes;
      }

      const branch = creds.meta['branch'] || 'main';
      const status = await git.status();
      const hasChanges = status.files.length > 0 || status.not_added.length > 0;
      if (!hasChanges) return { success: true, message: 'Already up to date', filesChanged: 0 };

      await git.add('.');
      await git.commit(`obsync: sync ${new Date().toISOString()}`);

      try {
        await git.push(['origin', branch, '--set-upstream']);
      } catch (pushErr) {
        const msg = String(pushErr);
        if (msg.includes('non-fast-forward') || msg.includes('rejected')) {
          await git.pull(['origin', branch, '--allow-unrelated-histories', '--no-rebase']);
          await git.push(['origin', branch, '--set-upstream']);
        } else throw pushErr;
      }

      return { success: true, message: `Pushed ${status.files.length} file(s)`, filesChanged: status.files.length };
    } catch (err) {
      return { success: false, message: err instanceof Error ? err.message : 'Push failed' };
    }
  }

  async pull(vaultPath: string, creds: CloudCredentials): Promise<SyncResult> {
    try {
      const git = this.buildGit(vaultPath);
      const branch = creds.meta['branch'] || 'main';
      
      const authUrl = this.buildAuthUrl(creds.meta['repoUrl'], creds.token);
      await git.remote(['set-url', 'origin', authUrl]);

      const result = await git.pull('origin', branch);
      
      if (result.files.length === 0) return { success: true, message: 'Already up to date' };

      const conflicts = this.detectConflicts(JSON.stringify(result.summary || {}));
      if (conflicts.length > 0) return { success: false, message: 'Conflicts', conflicts };

      return { success: true, message: `Pulled ${result.files.length} file(s)` };
    } catch (err) {
      const msg = String(err);
      if (msg.includes('Already up to date')) return { success: true, message: 'Already up to date' };
      return { success: false, message: 'Pull failed' };
    }
  }

  async init(vaultPath: string, creds: CloudCredentials): Promise<SyncResult> {
    const branch = creds.meta['branch'] || 'main';
    const repoUrl = creds.meta['repoUrl'];
    const git = this.buildGit(vaultPath);
    
    if (!fs.existsSync(path.join(vaultPath, '.git'))) {
      await git.init(['-b', branch]);
    }

    const authUrl = this.buildAuthUrl(repoUrl, creds.token);
    const remotes = await git.getRemotes();
    if (remotes.find(r => r.name === 'origin')) {
      await git.remote(['set-url', 'origin', authUrl]);
    } else {
      await git.addRemote('origin', authUrl);
    }

    await git.addConfig('user.email', 'obsync@local', false, 'local');
    await git.addConfig('user.name', 'Obsync', false, 'local');

    return { success: true, message: 'Init success' };
  }

  async clone(vaultPath: string, creds: CloudCredentials): Promise<SyncResult> {
    const parentDir = path.dirname(vaultPath);
    const folderName = path.basename(vaultPath);
    const git = simpleGit(parentDir);
    const authUrl = this.buildAuthUrl(creds.meta['repoUrl'], creds.token);
    await git.clone(authUrl, folderName, ['--branch', creds.meta['branch'] || 'main']);
    return { success: true, message: 'Cloned' };
  }

  private buildGit(baseDir: string): SimpleGit {
    return simpleGit({ baseDir, binary: 'git', maxConcurrentProcesses: 1 });
  }

  private buildAuthUrl(repoUrl: string, token: string): string {
    return repoUrl.replace('https://', `https://${token}@`);
  }

  private getApiUrl(creds: CloudCredentials): string | null {
    const repoUrl = creds.meta['repoUrl'] || '';
    if (creds.provider === 'github') {
      const match = repoUrl.match(/github\.com[/:]([^/]+)\/([^/.]+)/);
      if (match) return `https://api.github.com/repos/${match[1]}/${match[2]}`;
    }
    if (creds.provider === 'gitlab') {
      const match = repoUrl.match(/gitlab\.com[/:]([^/]+)\/([^/.]+)/);
      if (match) {
        const proj = encodeURIComponent(`${match[1]}/${match[2].replace('.git', '')}`);
        return `https://gitlab.com/api/v4/projects/${proj}`;
      }
    }
    return null;
  }

  private apiGet(url: string, token: string): Promise<{ status: number }> {
    return new Promise((resolve, reject) => {
      const https = require('https') as typeof import('https');
      const parsedUrl = new URL(url);
      const req = https.request({
        hostname: parsedUrl.hostname,
        path: parsedUrl.pathname + parsedUrl.search,
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${token}`,
          'User-Agent': 'Obsync/1.0.0',
        },
      }, (res) => { res.resume(); resolve({ status: res.statusCode ?? 0 }); });
      req.on('error', reject);
      req.end();
    });
  }

  private detectConflicts(summary: string): ConflictInfo[] {
    if (!summary.includes('CONFLICT')) return [];
    // simplified parser for this refactor
    return [{ filePath: 'Conflicted files found', localModified: '', remoteModified: '' }];
  }
}
