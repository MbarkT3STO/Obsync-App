export interface Vault {
  id: string;
  name: string;
  localPath: string;
  createdAt: string;
  lastSyncedAt: string | null;
}

export interface VaultSyncStatus {
  vaultId: string;
  status: 'idle' | 'syncing' | 'synced' | 'error' | 'conflict';
  message?: string;
  lastChecked: string;
}
