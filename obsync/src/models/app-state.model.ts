import type { Vault, VaultSyncStatus } from './vault.model';
import type { CloudConfig } from './cloud-sync.model';
import type { AutoSyncConfig } from './history.model';

export interface AppSettings {
  syncOnStartup: boolean;
  minimizeToTray: boolean;
  startMinimized: boolean;
  launchOnStartup: boolean;
}

export interface AppConfig {
  vaults: Vault[];
  cloudConfigs: Record<string, CloudConfig>;
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
