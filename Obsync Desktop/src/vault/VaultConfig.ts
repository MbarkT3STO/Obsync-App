/**
 * VaultConfig — the per-vault configuration schema.
 *
 * Stored in: userData/vaults.json (via VaultManager)
 * Credentials are NOT stored here — they live in TokenStore.
 */

import type { ConflictStrategy } from '../providers/SyncProvider';

export interface VaultConfig {
  /** UUID */
  id: string;
  name: string;
  localPath: string;
  /** Provider ID: 'github' | 'gitlab' | 'bitbucket' | 'gitea' | 'googledrive' | 'onedrive' | 'dropbox' */
  providerId: string;
  providerConfig: {
    /** Git providers: full HTTPS repo URL */
    repoUrl?: string;
    /** Cloud providers: folder name under Obsync/ on the remote */
    remoteFolderName?: string;
    /** Git providers: branch name (default: 'main') */
    branch?: string;
  };
  syncOptions: {
    autoSync: boolean;
    /** Milliseconds to wait after last file change before triggering auto-sync */
    autoSyncDebounceMs: number;
    conflictStrategy: ConflictStrategy;
    /** Additional glob patterns to ignore (merged with defaults) */
    ignorePatterns: string[];
    /** Whether to sync .obsidian config files (plugins, themes, hotkeys, etc.) */
    syncObsidianConfig: boolean;
  };
  /** ISO timestamp of last successful sync, or null */
  lastSync: string | null;
  createdAt: string;
}

export const DEFAULT_VAULT_CONFIG: Omit<VaultConfig, 'id' | 'name' | 'localPath' | 'providerId' | 'createdAt'> = {
  providerConfig: {},
  syncOptions: {
    autoSync: false,
    autoSyncDebounceMs: 5000,
    conflictStrategy: 'ask',
    ignorePatterns: [],
    syncObsidianConfig: true,
  },
  lastSync: null,
};
