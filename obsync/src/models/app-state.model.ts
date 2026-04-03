import type { Vault, VaultSyncStatus } from './vault.model';
import type { GitHubConfig } from './github.model';
import type { AutoSyncConfig } from './history.model';

export interface AppSettings {
  syncOnStartup: boolean;
  minimizeToTray: boolean;
  startMinimized: boolean;
}

export interface AppConfig {
  vaults: Vault[];
  githubConfigs: Record<string, GitHubConfig>;
  autoSyncConfigs: Record<string, AutoSyncConfig>;
  settings: AppSettings;
  theme: 'dark' | 'light';
  version: string;
}

export interface IpcResponse<T = void> {
  success: boolean;
  data?: T;
  error?: string;
}

export type SyncStatusMap = Record<string, VaultSyncStatus>;
