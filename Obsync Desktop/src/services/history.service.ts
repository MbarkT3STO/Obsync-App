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

  async archiveFile(vaultPath: string, relativePath: string): Promise<void> {
    try {
      const sourcePath = path.join(vaultPath, relativePath);
      if (!fs.existsSync(sourcePath) || fs.statSync(sourcePath).isDirectory()) return;

      const archiveBase = path.join(vaultPath, '.obsync', 'archive');
      const fileArchiveDir = path.join(archiveBase, relativePath);
      if (!fs.existsSync(fileArchiveDir)) fs.mkdirSync(fileArchiveDir, { recursive: true });

      const timestamp = new Date().getTime();
      const ext = path.extname(relativePath);
      const fileName = path.basename(relativePath, ext);
      const archivePath = path.join(fileArchiveDir, `${fileName}.${timestamp}${ext}`);

      fs.copyFileSync(sourcePath, archivePath);

      // Prune: Keep only last 10 versions
      const versions = fs.readdirSync(fileArchiveDir).sort((a, b) => {
        const at = parseInt(a.split('.').slice(-2, -1)[0] || '0');
        const bt = parseInt(b.split('.').slice(-2, -1)[0] || '0');
        return at - bt;
      });

      if (versions.length > 10) {
        for (let i = 0; i < versions.length - 10; i++) {
          fs.unlinkSync(path.join(fileArchiveDir, versions[i]!));
        }
      }
    } catch (err) {
      logger.error(`Failed to archive ${relativePath}:`, err);
    }
  }

  /** Lists all archived versions of a file */
  listVersions(vaultPath: string, relativePath: string): Array<{ version: string; timestamp: number; size: number }> {
    try {
      const fileArchiveDir = path.join(vaultPath, '.obsync', 'archive', relativePath);
      if (!fs.existsSync(fileArchiveDir)) return [];

      const ext = path.extname(relativePath);
      const baseName = path.basename(relativePath, ext);

      return fs.readdirSync(fileArchiveDir)
        .filter(f => f.startsWith(baseName + '.'))
        .map(f => {
          const fullPath = path.join(fileArchiveDir, f);
          const stat = fs.statSync(fullPath);
          // Extract timestamp from filename: baseName.TIMESTAMP.ext
          const parts = f.replace(ext, '').split('.');
          const ts = parseInt(parts[parts.length - 1] || '0', 10);
          return { version: f, timestamp: ts, size: stat.size };
        })
        .sort((a, b) => b.timestamp - a.timestamp); // newest first
    } catch {
      return [];
    }
  }

  /** Restores a specific archived version of a file */
  restoreVersion(vaultPath: string, relativePath: string, version: string): boolean {
    try {
      const fileArchiveDir = path.join(vaultPath, '.obsync', 'archive', relativePath);
      const archivePath = path.join(fileArchiveDir, version);
      const targetPath = path.join(vaultPath, relativePath);

      if (!fs.existsSync(archivePath)) return false;

      // Archive current version before restoring
      this.archiveFile(vaultPath, relativePath);

      // Restore
      const targetDir = path.dirname(targetPath);
      if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
      fs.copyFileSync(archivePath, targetPath);
      logger.info(`Restored ${relativePath} to version ${version}`);
      return true;
    } catch (err) {
      logger.error(`Failed to restore version ${version} of ${relativePath}:`, err);
      return false;
    }
  }

  /**
   * Returns all files that have at least one archived version, with their
   * most recent version's timestamp and total version count.
   */
  listArchivedFiles(vaultPath: string): Array<{ relativePath: string; latestTimestamp: number; versionCount: number }> {
    try {
      const archiveBase = path.join(vaultPath, '.obsync', 'archive');
      if (!fs.existsSync(archiveBase)) return [];

      const results: Array<{ relativePath: string; latestTimestamp: number; versionCount: number }> = [];

      const walk = (dir: string, relBase: string) => {
        for (const entry of fs.readdirSync(dir)) {
          const full = path.join(dir, entry);
          const rel = relBase ? `${relBase}/${entry}` : entry;
          const stat = fs.statSync(full);
          if (stat.isDirectory()) {
            // Check if this directory contains version files (not subdirs)
            const children = fs.readdirSync(full);
            const hasVersionFiles = children.some(c => fs.statSync(path.join(full, c)).isFile());
            if (hasVersionFiles) {
              const versions = this.listVersions(vaultPath, rel);
              if (versions.length > 0) {
                results.push({
                  relativePath: rel,
                  latestTimestamp: versions[0]!.timestamp,
                  versionCount: versions.length,
                });
              }
            } else {
              walk(full, rel);
            }
          }
        }
      };

      walk(archiveBase, '');
      return results.sort((a, b) => b.latestTimestamp - a.latestTimestamp);
    } catch {
      return [];
    }
  }

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

    try {
      const git = simpleGit({ baseDir: vault.localPath, binary: 'git' });

      // If filePath looks like a commit hash, show the full commit diff
      const isHash = /^[a-f0-9]{7,40}$/.test(filePath.trim());
      if (isHash) {
        return this.getCommitDiff(git, filePath.trim());
      }

      // Otherwise show working-tree diff of the file vs HEAD
      const absPath = path.join(vault.localPath, filePath);
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

  /**
   * Returns a FileDiff for an entire commit using `git show`.
   * Parses the unified diff output into hunks the renderer already knows how to display.
   */
  private async getCommitDiff(git: ReturnType<typeof simpleGit>, hash: string): Promise<FileDiff> {
    // --unified=3 gives 3 lines of context, same as standard diff
    const raw = await git.raw(['show', hash, '--unified=3', '--no-color', '--diff-filter=ACDMRT']);

    const hunks: DiffHunk[] = [];
    let currentHunk: DiffHunk | null = null;
    let lineNo = 0;
    let commitMessage = '';
    let inHeader = true;

    for (const line of raw.split('\n')) {
      // Capture commit message from the show header (before the first diff --git line)
      if (inHeader) {
        if (line.startsWith('diff --git')) {
          inHeader = false;
        } else if (line.startsWith('    ') && !commitMessage) {
          commitMessage = line.trim();
        }
        continue;
      }

      if (line.startsWith('diff --git')) {
        // New file section — push previous hunk and start fresh
        if (currentHunk) hunks.push(currentHunk);
        currentHunk = null;
        // Use the file path as a section header
        const match = line.match(/diff --git a\/.+ b\/(.+)/);
        const fileName = match ? match[1] : line;
        currentHunk = { header: `── ${fileName} ──`, lines: [] };
        continue;
      }

      // Skip git metadata lines
      if (line.startsWith('index ') || line.startsWith('--- ') ||
          line.startsWith('+++ ') || line.startsWith('new file') ||
          line.startsWith('deleted file') || line.startsWith('old mode') ||
          line.startsWith('new mode') || line.startsWith('Binary files') ||
          line.startsWith('similarity') || line.startsWith('rename')) {
        continue;
      }

      if (line.startsWith('@@')) {
        // Hunk header — extract starting line number
        const m = line.match(/@@ -\d+(?:,\d+)? \+(\d+)/);
        lineNo = m ? parseInt(m[1]!, 10) - 1 : 0;
        if (currentHunk) {
          currentHunk.lines.push({ type: 'context', content: line, lineNo: undefined });
        }
        continue;
      }

      if (!currentHunk) continue;

      if (line.startsWith('+')) {
        lineNo++;
        currentHunk.lines.push({ type: 'added', content: line.slice(1), lineNo });
      } else if (line.startsWith('-')) {
        currentHunk.lines.push({ type: 'removed', content: line.slice(1), lineNo: undefined });
      } else if (line.startsWith(' ') || line === '') {
        lineNo++;
        currentHunk.lines.push({ type: 'context', content: line.slice(1), lineNo });
      }
    }

    if (currentHunk) hunks.push(currentHunk);

    return {
      filePath: commitMessage || hash,
      status: 'modified',
      localContent: '',
      remoteContent: '',
      hunks,
    };
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
    // Hard cap: skip LCS for very large files to avoid blocking the main thread
    if (m * n > 200_000) return [];

    // Memory-efficient two-row DP instead of full m×n matrix
    let prev = new Int32Array(n + 1);
    let curr = new Int32Array(n + 1);

    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        curr[j] = a[i - 1] === b[j - 1]
          ? prev[j - 1]! + 1
          : Math.max(prev[j]!, curr[j - 1]!);
      }
      [prev, curr] = [curr, prev];
      curr.fill(0);
    }

    // Backtrack using the final prev row — rebuild full table lazily
    // For backtracking we need the full table; only build it if result is non-trivial
    const lcsLen = prev[n]!;
    if (lcsLen === 0) return [];

    // Full table backtrack (only reached when lcsLen > 0 and m*n <= 200k)
    const dp: Int32Array[] = Array.from({ length: m + 1 }, () => new Int32Array(n + 1));
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
