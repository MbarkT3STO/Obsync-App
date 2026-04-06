/**
 * ObsidianIgnorePatterns — canonical list of paths to exclude/include from sync.
 *
 * These defaults can be overridden per-vault via VaultConfig.syncOptions.ignorePatterns
 * and the "Sync Obsidian configuration" toggle.
 */

/** Vault-relative glob patterns that are EXCLUDED from sync by default. */
export const DEFAULT_IGNORE_PATTERNS: readonly string[] = [
  '.obsidian/workspace.json',
  '.obsidian/workspace-mobile.json',
  '.obsidian/cache',
  '.trash/',
  '.DS_Store',
  'Thumbs.db',
  'desktop.ini',
  '*.tmp',
  '*.bak',
  '*.swp',
  '*~',
  '*.lock',
  '.git/',
  '.obsync/',
  'node_modules/',
];

/**
 * Additional patterns excluded when the user turns OFF "Sync Obsidian config".
 * When the toggle is ON these are synced (they are NOT in DEFAULT_IGNORE_PATTERNS).
 */
export const OBSIDIAN_CONFIG_PATTERNS: readonly string[] = [
  '.obsidian/app.json',
  '.obsidian/hotkeys.json',
  '.obsidian/plugins/',
  '.obsidian/themes/',
  '.obsidian/snippets/',
];

/**
 * Returns the effective ignore pattern list for a vault.
 *
 * @param userPatterns       Custom patterns from VaultConfig (may be empty).
 * @param syncObsidianConfig Whether to sync .obsidian config files.
 */
export function buildIgnorePatterns(
  userPatterns: string[] = [],
  syncObsidianConfig = true,
): string[] {
  const base = [...DEFAULT_IGNORE_PATTERNS];
  if (!syncObsidianConfig) {
    base.push(...OBSIDIAN_CONFIG_PATTERNS);
  }
  // Merge user overrides — user can remove a default by prefixing with '!'
  for (const p of userPatterns) {
    if (p.startsWith('!')) {
      const remove = p.slice(1);
      const idx = base.indexOf(remove);
      if (idx !== -1) base.splice(idx, 1);
    } else {
      if (!base.includes(p)) base.push(p);
    }
  }
  return base;
}

/**
 * Returns true if a vault-relative path matches any of the given patterns.
 * Supports simple glob wildcards (* matches within a segment, ** matches across).
 */
export function matchesIgnorePattern(relPath: string, patterns: string[]): boolean {
  const normalized = relPath.replace(/\\/g, '/');
  for (const pattern of patterns) {
    if (matchGlob(normalized, pattern)) return true;
  }
  return false;
}

function matchGlob(str: string, pattern: string): boolean {
  // Convert glob to regex
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&') // escape regex specials except * ?
    .replace(/\*\*/g, '\u0000')            // placeholder for **
    .replace(/\*/g, '[^/]*')               // * → match within segment
    .replace(/\u0000/g, '.*')              // ** → match across segments
    .replace(/\?/g, '[^/]');               // ? → single char

  // Trailing slash means directory prefix match
  const regexStr = pattern.endsWith('/')
    ? `^${escaped}` // matches anything under that directory
    : `^${escaped}$`;

  try {
    return new RegExp(regexStr).test(str);
  } catch {
    return false;
  }
}
