export type SyncProviderType = 'github' | 'gitlab' | 'bitbucket' | 'git-custom' | 'dropbox' | 'webdav' | 'local' | 's3' | 'googledrive' | 'onedrive';

export interface CloudConfig {
  provider: SyncProviderType;
  /** Stored encrypted, never sent to renderer */
  encryptedToken: string;
  /** Provider-specific metadata (branch, repoUrl, bucket, etc.) */
  meta: Record<string, any>;
}

export interface CloudCredentials {
  provider: SyncProviderType;
  token: string;
  /** Provider-specific metadata (branch, repoUrl, bucket, etc.) */
  meta: Record<string, any>;
}

export interface SyncResult {
  success: boolean;
  message: string;
  conflicts?: ConflictInfo[];
  filesChanged?: number;
  data?: any;
}

export interface ConflictInfo {
  filePath: string;
  localModified: string;
  remoteModified: string;
}

/** Unified interface for all Cloud Providers (Git and non-Git) */
export interface ICloudProvider {
  validate(credentials: CloudCredentials): Promise<SyncResult>;
  push(vaultPath: string, credentials: CloudCredentials): Promise<SyncResult>;
  pushFile?(vaultPath: string, relativePath: string, credentials: CloudCredentials): Promise<SyncResult>;
  pull(vaultPath: string, credentials: CloudCredentials): Promise<SyncResult>;
  pullFile?(vaultPath: string, relativePath: string, credentials: CloudCredentials): Promise<SyncResult>;
  getChanges?(vaultPath: string, credentials: CloudCredentials, cursor?: string): Promise<SyncResult & { cursor?: string; entries?: any[] }>;
  init?(vaultPath: string, credentials: CloudCredentials): Promise<SyncResult>;
  clone?(vaultPath: string, credentials: CloudCredentials): Promise<SyncResult>;
  delete?(vaultPath: string, relativePath: string, credentials: CloudCredentials): Promise<SyncResult>;
}
