/**
 * SyncProvider — the universal interface every sync backend must implement.
 *
 * The SyncEngine ONLY speaks this interface. It never imports a concrete
 * provider. All provider-specific logic lives behind this contract.
 */

// ── Shared data types ──────────────────────────────────────────────────────

export interface FileManifest {
  version: number;
  lastSync: string;           // ISO timestamp
  deviceId: string;
  files: Record<string, {
    hash: string;             // SHA-256 hex
    size: number;
    lastModified: number;     // Unix ms
  }>;
}

export interface SyncResult {
  uploaded: string[];
  downloaded: string[];
  conflicts: ConflictFile[];
  errors: SyncError[];
}

export interface ConflictFile {
  path: string;
  localVersion: Buffer;
  remoteVersion: Buffer;
  localModified: number;
  remoteModified: number;
}

export interface SyncError {
  file: string;
  error: string;
  recoverable: boolean;
}

export interface ProviderCredentials {
  type: 'pat' | 'oauth';
  token: string;
  refreshToken?: string;
  expiresAt?: number;
  /** Provider-specific extras: repoUrl, branch, remoteFolderName, etc. */
  extra?: Record<string, string>;
}

export type ConflictStrategy = 'ask' | 'keep-local' | 'keep-remote' | 'keep-both';

export interface SyncOptions {
  dryRun?: boolean;
  conflictStrategy?: ConflictStrategy;
  ignorePatterns?: string[];
}

export interface CommitEntry {
  hash: string;
  shortHash: string;
  message: string;
  author: string;
  date: string;
  filesChanged: number;
  insertions: number;
  deletions: number;
}

// ── The provider contract ──────────────────────────────────────────────────

export interface SyncProvider {
  readonly id: string;
  readonly name: string;
  readonly type: 'git' | 'cloud';
  /** SVG string or asset path shown in the UI */
  readonly icon: string;

  // ── Lifecycle ────────────────────────────────────────────────────────────

  /** Authenticate and establish a connection to the remote. */
  connect(credentials: ProviderCredentials): Promise<void>;

  /** Tear down the connection and release any held resources. */
  disconnect(): Promise<void>;

  /** Ping the remote — resolves true if reachable and authenticated. */
  testConnection(): Promise<boolean>;

  // ── Core sync operations ─────────────────────────────────────────────────

  /**
   * Fetch the remote manifest.
   * Git providers return null — git log IS the manifest.
   * Cloud providers return the stored obsync-manifest.json.
   */
  getRemoteManifest(): Promise<FileManifest | null>;

  /** Upload a single file by vault-relative path. */
  uploadFile(relativePath: string, content: Buffer): Promise<void>;

  /** Download a single file by vault-relative path. */
  downloadFile(relativePath: string): Promise<Buffer>;

  /** Delete a file from the remote. */
  deleteRemoteFile(relativePath: string): Promise<void>;

  /** Write the manifest to the remote (cloud providers only). */
  uploadManifest(manifest: FileManifest): Promise<void>;

  // ── Git-specific (optional) ───────────────────────────────────────────────

  /** Returns commit history. Only implemented by git providers. */
  getCommitHistory?(): Promise<CommitEntry[]>;

  /** Returns a unified diff for a file at a given commit. */
  getFileDiff?(commitHash: string, filePath: string): Promise<string>;

  /**
   * Called by the SyncEngine after token refresh so the provider can
   * persist the new token via TokenStore.
   */
  onTokenRefreshed?: (newTokenJson: string) => void;
}
