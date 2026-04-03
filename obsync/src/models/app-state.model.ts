import type { Vault, VaultSyncStatus } from './vault.model';
import type { GitHubConfig } from './github.model';

export interface AppConfig {
  vaults: Vault[];
  githubConfigs: Record<string, GitHubConfig>; // keyed by vaultId
  theme: 'dark' | 'light';
  version: string;
}

export interface IpcResponse<T = void> {
  success: boolean;
  data?: T;
  error?: string;
}

export type SyncStatusMap = Record<string, VaultSyncStatus>;
