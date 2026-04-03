import { createLogger } from '../utils/logger.util';
import type { CommitEntry, FileDiff, DiffHunk, DiffLine } from '../models/history.model';
import type { GitHubService } from './github.service';
import type { VaultService } from './vault.service';
import simpleGit from 'simple-git';
import fs from 'fs';
import path from 'path';

const logger = createLogger('HistoryService');

export class HistoryService {
  constructor(
    private readonly vaultService: VaultService,
    private readonly githubService: GitHubService,
  ) {}

  async getCommits(vaultId: string, limit = 30): Promise<CommitEntry[]> {
    const vault = this.vaultService.getById(vaultId);
    if (!vault) return [];

    const gitDir = path.join(vault.localPath, '.git');
    if (!fs.existsSync(gitDir)) return [];

    try {
      const git = simpleGit({ baseDir: vault.localPath, binary: 'git' });
      const log = await git.log([
        `--max-count=${limit}`,
        '--stat',
        '--format=%H|%h|%s|%an|%aI',
      ]);

      return log.all.map(entry => {
        // simple-git parses diff stat into entry.diff
        const diff = (entry as unknown as { diff?: { changed?: number; insertions?: number; deletions?: number } }).diff;
        return {
          hash: entry.hash,
          shortHash: entry.hash.slice(0, 7),
          message: entry.message,
          author: entry.author_name,
          date: entry.date,
          filesChanged: diff?.changed ?? 0,
          insertions: diff?.insertions ?? 0,
          deletions: diff?.deletions ?? 0,
        };
      });
    } catch (err) {
      logger.error('Failed to get commit log', err);
      return [];
    }
  }

  async getFileDiff(vaultId: string, filePath: string): Promise<FileDiff | null> {
    const vault = this.vaultService.getById(vaultId);
    if (!vault) return null;

    const absPath = path.join(vault.localPath, filePath);

    try {
      const git = simpleGit({ baseDir: vault.localPath, binary: 'git' });

      // Get local content
      let localContent = '';
      if (fs.existsSync(absPath)) {
        localContent = fs.readFileSync(absPath, 'utf-8');
      }

      // Get remote (HEAD) content
      let remoteContent = '';
      try {
        remoteContent = await git.show([`HEAD:${filePath}`]);
      } catch {
        remoteContent = '';
      }

      // Detect conflict markers in local file
      const hasConflict = localContent.includes('<<<<<<<') && localContent.includes('>>>>>>>');

      const hunks = this.computeDiff(remoteContent, localContent);

      return {
        filePath,
        status: hasConflict ? 'conflict' : this.detectStatus(localContent, remoteContent),
        localContent,
        remoteContent,
        hunks,
      };
    } catch (err) {
      logger.error('Failed to get file diff', err);
      return null;
    }
  }

  private detectStatus(local: string, remote: string): FileDiff['status'] {
    if (!remote && local) return 'added';
    if (remote && !local) return 'deleted';
    return 'modified';
  }

  /** Minimal line-level diff — produces hunks for the diff viewer */
  private computeDiff(oldText: string, newText: string): DiffHunk[] {
    const oldLines = oldText.split('\n');
    const newLines = newText.split('\n');
    const hunks: DiffHunk[] = [];

    // Simple LCS-based diff
    const lcs = this.lcs(oldLines, newLines);
    let oi = 0, ni = 0, li = 0;
    let currentHunk: DiffHunk | null = null;
    const CONTEXT = 3;

    const flushHunk = () => {
      if (currentHunk && currentHunk.lines.length > 0) {
        hunks.push(currentHunk);
        currentHunk = null;
      }
    };

    const ensureHunk = (header: string) => {
      if (!currentHunk) currentHunk = { header, lines: [] };
    };

    while (oi < oldLines.length || ni < newLines.length) {
      if (li < lcs.length && oi === lcs[li]![0] && ni === lcs[li]![1]) {
        // Context line
        ensureHunk(`@@ context @@`);
        currentHunk!.lines.push({ type: 'context', content: oldLines[oi]!, lineNo: ni + 1 });
        oi++; ni++; li++;
      } else if (ni < newLines.length && (li >= lcs.length || ni < lcs[li]![1])) {
        ensureHunk(`@@ +${ni + 1} @@`);
        currentHunk!.lines.push({ type: 'added', content: newLines[ni]!, lineNo: ni + 1 });
        ni++;
      } else {
        ensureHunk(`@@ -${oi + 1} @@`);
        currentHunk!.lines.push({ type: 'removed', content: oldLines[oi]!, lineNo: oi + 1 });
        oi++;
      }
    }

    flushHunk();
    return hunks;
  }

  /** Patience-like LCS returning pairs of matching line indices */
  private lcs(a: string[], b: string[]): [number, number][] {
    const m = a.length, n = b.length;
    // For large files, limit to avoid O(mn) memory
    if (m * n > 200000) return [];

    const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        dp[i]![j] = a[i - 1] === b[j - 1]
          ? dp[i - 1]![j - 1]! + 1
          : Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!);
      }
    }

    const result: [number, number][] = [];
    let i = m, j = n;
    while (i > 0 && j > 0) {
      if (a[i - 1] === b[j - 1]) {
        result.unshift([i - 1, j - 1]);
        i--; j--;
      } else if (dp[i - 1]![j]! > dp[i]![j - 1]!) {
        i--;
      } else {
        j--;
      }
    }
    return result;
  }
}
