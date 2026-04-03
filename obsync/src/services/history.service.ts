import { createLogger } from '../utils/logger.util';
import type { CommitEntry, FileDiff, DiffHunk } from '../models/history.model';
import type { CloudProviderService } from './cloud-provider.service';
import type { VaultService } from './vault.service';
import simpleGit from 'simple-git';
import fs from 'fs';
import path from 'path';

const logger = createLogger('HistoryService');

export class HistoryService {
  constructor(
    private readonly vaultService: VaultService,
    private readonly cloudProvider: CloudProviderService,
  ) {}

  async getCommits(vaultId: string, limit = 30): Promise<CommitEntry[]> {
    const vault = this.vaultService.getById(vaultId);
    if (!vault || !fs.existsSync(path.join(vault.localPath, '.git'))) return [];

    const gitDir = path.join(vault.localPath, '.git');
    if (!fs.existsSync(gitDir)) return [];

    try {
      const git = simpleGit({ baseDir: vault.localPath, binary: 'git' });
      const log = await git.log({ maxCount: limit });

      if (!log.all.length) return [];

      const statOutput = await git.raw([
        'log',
        `--max-count=${limit}`,
        '--shortstat',
        '--pretty=format:COMMIT:%H',
      ]);

      const statMap = this.parseShortStat(statOutput);

      return log.all.map(entry => {
        const stat = statMap.get(entry.hash) ?? { changed: 0, insertions: 0, deletions: 0 };
        return {
          hash: entry.hash,
          shortHash: entry.hash.slice(0, 7),
          message: entry.message,
          author: entry.author_name,
          date: entry.date,
          filesChanged: stat.changed,
          insertions: stat.insertions,
          deletions: stat.deletions,
        };
      });
    } catch (err) {
      logger.error('Failed to get commit log', err);
      return [];
    }
  }

  private parseShortStat(raw: string): Map<string, { changed: number; insertions: number; deletions: number }> {
    const map = new Map<string, { changed: number; insertions: number; deletions: number }>();
    let currentHash = '';

    raw.split('\n').forEach(line => {
      const hashMatch = line.match(/^COMMIT:([a-f0-9]{40})/);
      if (hashMatch) {
        currentHash = hashMatch[1]!;
      } else if (currentHash) {
        const statMatch = line.match(/(\d+) file.*?(?:,\s*(\d+) insertion.*?)?(?:,\s*(\d+) deletion.*?)?$/);
        if (statMatch) {
          map.set(currentHash, {
            changed:    parseInt(statMatch[1] ?? '0', 10),
            insertions: parseInt(statMatch[2] ?? '0', 10),
            deletions:  parseInt(statMatch[3] ?? '0', 10),
          });
        }
      }
    });
    return map;
  }

  async getFileDiff(vaultId: string, filePath: string): Promise<FileDiff | null> {
    const vault = this.vaultService.getById(vaultId);
    if (!vault) return null;

    const absPath = path.join(vault.localPath, filePath);

    try {
      const git = simpleGit({ baseDir: vault.localPath, binary: 'git' });
      let localContent = '';
      if (fs.existsSync(absPath)) {
        localContent = fs.readFileSync(absPath, 'utf-8');
      }

      let remoteContent = '';
      try {
        remoteContent = await git.show([`HEAD:${filePath}`]);
      } catch {
        remoteContent = '';
      }

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

  private computeDiff(oldText: string, newText: string): DiffHunk[] {
    const oldLines = oldText.split('\n');
    const newLines = newText.split('\n');
    const hunks: DiffHunk[] = [];
    const lcs = this.lcs(oldLines, newLines);
    let oi = 0, ni = 0, li = 0;
    let currentHunk: DiffHunk | null = null;

    const ensureHunk = (header: string) => {
      if (!currentHunk) currentHunk = { header, lines: [] };
    };

    while (oi < oldLines.length || ni < newLines.length) {
      if (li < lcs.length && oi === lcs[li]![0] && ni === lcs[li]![1]) {
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

    if (currentHunk) hunks.push(currentHunk);
    return hunks;
  }

  private lcs(a: string[], b: string[]): [number, number][] {
    const m = a.length, n = b.length;
    if (m * n > 200000) return [];
    const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        dp[i]![j] = a[i - 1] === b[j - 1] ? dp[i - 1]![j - 1]! + 1 : Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!);
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
