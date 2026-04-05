/**
 * Centralised Obsidian-aware file filter for Obsync.
 *
 * Strategy: ALLOWLIST directories to skip, DENYLIST files to skip.
 * Everything not explicitly excluded is synced — this is the only safe
 * default for a vault sync tool where users can attach any file type.
 */

import * as fs from 'fs';
import * as path from 'path';

// ── Directories to skip entirely (matched against each path segment) ────────
const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  '.obsync',
  '.trash',
]);

// ── .obsidian sub-paths to skip (relative to .obsidian/) ────────────────────
const SKIP_OBSIDIAN_NAMES = new Set([
  'workspace',
  'workspace.json',
  'workspace-mobile',
  'workspace-mobile.json',
  'cache',
  '.trash',
]);

// ── File names that are always skipped regardless of extension ───────────────
const SKIP_FILENAMES = new Set([
  '.DS_Store',
  'Thumbs.db',
  'desktop.ini',
  '.gitignore',
  '.gitattributes',
  '.gitmodules',
]);

// ── Exact suffixes that mark temp / editor lock files ───────────────────────
const SKIP_SUFFIXES = ['.tmp', '.bak', '.swp', '~', '.lock'];

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Returns true if a directory segment should be skipped entirely.
 *
 * @param dirName       The bare directory name (not a full path)
 * @param parentRelPath Vault-relative path of the parent directory
 */
export function shouldSkipDir(dirName: string, parentRelPath: string = ''): boolean {
  if (SKIP_DIRS.has(dirName)) return true;

  // Inside .obsidian, skip specific transient sub-directories
  if (parentRelPath === '.obsidian' || parentRelPath.startsWith('.obsidian/')) {
    if (SKIP_OBSIDIAN_NAMES.has(dirName)) return true;
  }

  return false;
}

/**
 * Returns true if a file should be synced.
 * Default is ALLOW — only explicitly excluded files are skipped.
 *
 * @param relPath Vault-relative path using forward slashes, e.g. "Notes/foo.md"
 */
export function shouldSyncFile(relPath: string): boolean {
  const normalized = relPath.replace(/\\/g, '/');
  const fileName = path.basename(normalized);

  // Always skip certain filenames
  if (SKIP_FILENAMES.has(fileName)) return false;

  // Skip temp/backup suffixes
  for (const suffix of SKIP_SUFFIXES) {
    if (fileName.endsWith(suffix)) return false;
  }

  // Skip .obsidian transient files
  if (normalized.startsWith('.obsidian/')) {
    const obsidianRel = normalized.slice('.obsidian/'.length);
    const topLevel = obsidianRel.split('/')[0] ?? '';
    if (SKIP_OBSIDIAN_NAMES.has(topLevel)) return false;
    // Everything else inside .obsidian (plugins, themes, snippets, config json) is synced
    return true;
  }

  // Skip our own internal directory
  if (normalized.startsWith('.obsync/')) return false;

  // Skip .git internals
  if (normalized.startsWith('.git/') || normalized === '.git') return false;

  // Allow everything else — notes, attachments, canvas, excalidraw,
  // PDFs, images, audio, video, office docs, code files, fonts, etc.
  return true;
}

/**
 * Iteratively collects all syncable files under vaultRoot.
 * Uses an explicit stack instead of recursion to avoid stack overflow
 * on deeply nested vaults and reduce per-call overhead.
 *
 * @param vaultRoot  Absolute path to the vault root
 */
export function collectVaultFiles(
  vaultRoot: string,
  _dirPath?: string,   // kept for API compatibility — ignored
  _result?: string[],  // kept for API compatibility — ignored
): string[] {
  if (!fs.existsSync(vaultRoot)) return [];

  const result: string[] = [];
  // Stack entries: [absolutePath, vaultRelativeParentPath]
  const stack: Array<[string, string]> = [[vaultRoot, '']];

  while (stack.length > 0) {
    const [dirPath, parentRel] = stack.pop()!;

    let items: string[];
    try {
      items = fs.readdirSync(dirPath);
    } catch {
      continue; // unreadable — skip
    }

    for (const item of items) {
      const fullPath = path.join(dirPath, item);
      const relFromVault = parentRel ? `${parentRel}/${item}` : item;

      let stat: fs.Stats;
      try {
        stat = fs.statSync(fullPath);
      } catch {
        continue; // locked / broken symlink — skip
      }

      if (stat.isDirectory()) {
        if (!shouldSkipDir(item, parentRel)) {
          stack.push([fullPath, relFromVault]);
        }
      } else {
        if (shouldSyncFile(relFromVault)) result.push(fullPath);
      }
    }
  }

  return result;
}

/**
 * Chokidar-compatible ignored patterns for the file watcher.
 */
export function getChokidarIgnorePatterns(): RegExp[] {
  return [
    /[/\\]\.git[/\\]/,
    /[/\\]node_modules[/\\]/,
    /[/\\]\.obsync[/\\]/,
    /[/\\]\.trash[/\\]/,
    // .obsidian transient files
    /[/\\]\.obsidian[/\\]workspace(\.json)?$/,
    /[/\\]\.obsidian[/\\]workspace-mobile(\.json)?$/,
    /[/\\]\.obsidian[/\\]cache([/\\]|$)/,
    /[/\\]\.obsidian[/\\]\.trash[/\\]/,
    // Temp / OS files
    /\.tmp$/,
    /\.bak$/,
    /\.swp$/,
    /~$/,
    /\.lock$/,
    /\.DS_Store$/,
    /Thumbs\.db$/,
    /desktop\.ini$/,
  ];
}
