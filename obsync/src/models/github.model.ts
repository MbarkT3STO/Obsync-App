export interface GitHubConfig {
  repoUrl: string;
  branch: string;
  /** Stored encrypted, never sent to renderer */
  encryptedToken: string;
}

export interface GitHubCredentials {
  token: string;
  repoUrl: string;
  branch: string;
}

export interface SyncResult {
  success: boolean;
  message: string;
  conflicts?: ConflictInfo[];
  filesChanged?: number;
}

export interface ConflictInfo {
  filePath: string;
  localModified: string;
  remoteModified: string;
}
