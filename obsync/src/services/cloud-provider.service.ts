import { createLogger } from '../utils/logger.util';
import { encrypt, decrypt } from '../utils/crypto.util';
import type { CloudConfig, CloudCredentials, SyncResult } from '../models/cloud-sync.model';
import type { StorageService } from './storage.service';
import { GitCloudProvider } from './providers/git.provider';
import { WebDavCloudProvider } from './providers/webdav.provider';
import { GoogleDriveCloudProvider } from './providers/googledrive.provider';
import { DropboxCloudProvider } from './providers/dropbox.provider';
import { OneDriveCloudProvider } from './providers/onedrive.provider';
import type { ICloudProvider } from '../models/cloud-sync.model';

const logger = createLogger('CloudProviderService');

/** Gateway service that routes sync requests to the appropriate provider (Git, WebDAV, etc.) */
export class CloudProviderService {
  private readonly providers: Map<string, ICloudProvider>;

  constructor(private readonly storage: StorageService) {
    const git = new GitCloudProvider();
    this.providers = new Map<string, ICloudProvider>([
      ['github',     git],
      ['gitlab',     git],
      ['bitbucket',  git],
      ['git-custom', git],
      ['webdav',     new WebDavCloudProvider()],
      ['googledrive', new GoogleDriveCloudProvider()],
      ['dropbox',    new DropboxCloudProvider()],
      ['onedrive',   new OneDriveCloudProvider()],
    ]);
  }

  /** Returns the provider instance for the given type, or null if unsupported. */
  getProvider(providerType: string): ICloudProvider | null {
    return this.providers.get(providerType) ?? null;
  }

  saveConfig(vaultId: string, credentials: CloudCredentials): void {
    const config = this.storage.load();
    const cloudConfig: CloudConfig = {
      provider: credentials.provider,
      encryptedToken: encrypt(credentials.token),
      meta: credentials.meta
    };
    this.storage.update({
      cloudConfigs: { ...config.cloudConfigs, [vaultId]: cloudConfig },
    });
    logger.info(`${credentials.provider} config saved for vault ${vaultId}`);
  }

  getConfig(vaultId: string): CloudConfig | null {
    return this.storage.load().cloudConfigs[vaultId] ?? null;
  }

  getDecryptedToken(vaultId: string): string | null {
    const config = this.getConfig(vaultId);
    if (!config) return null;
    try {
      return decrypt(config.encryptedToken);
    } catch {
      // This is expected when opening the app on a new machine — the token was
      // encrypted by a different OS session (safeStorage is machine-local).
      // The caller will return null → IPC returns 'Provider not configured' →
      // the UI shows the settings form so the user can re-authenticate.
      logger.warn(`Cannot decrypt token for vault ${vaultId} — re-authentication required on this machine`);
      return null;
    }
  }

  getCredentials(vaultId: string): CloudCredentials | null {
    const config = this.getConfig(vaultId);
    if (!config) return null;
    const token = this.getDecryptedToken(vaultId);
    if (!token) return null;
    return { provider: config.provider, token, meta: config.meta };
  }

  async validate(credentials: CloudCredentials): Promise<SyncResult> {
    const provider = this.providers.get(credentials.provider);
    if (!provider) return { success: false, message: `Unknown provider: ${credentials.provider}` };
    return provider.validate(credentials);
  }

  async push(vaultPath: string, vaultId: string): Promise<SyncResult> {
    const creds = this.getCredentials(vaultId);
    if (!creds) return { success: false, message: 'Provider not configured' };
    const provider = this.providers.get(creds.provider);
    if (!provider) return { success: false, message: 'No sync engine for this provider' };
    this.wireTokenRefresh(provider, vaultId);
    return provider.push(vaultPath, creds);
  }

  async pull(vaultPath: string, vaultId: string): Promise<SyncResult> {
    const creds = this.getCredentials(vaultId);
    if (!creds) return { success: false, message: 'Provider not configured' };
    const provider = this.providers.get(creds.provider);
    if (!provider) return { success: false, message: 'No sync engine for this provider' };
    this.wireTokenRefresh(provider, vaultId);
    return provider.pull(vaultPath, creds);
  }

  async initRepo(vaultPath: string, credentials: CloudCredentials): Promise<SyncResult> {
    const provider = this.providers.get(credentials.provider);
    if (!provider || !provider.init) return { success: false, message: 'Provider does not support initialization' };
    return provider.init(vaultPath, credentials);
  }

  async clone(vaultPath: string, credentials: CloudCredentials): Promise<SyncResult> {
    const provider = this.providers.get(credentials.provider);
    if (!provider || !provider.clone) return { success: false, message: 'Provider does not support import' };
    return provider.clone(vaultPath, credentials);
  }

  async pullFile(vaultPath: string, relativePath: string, credentials: CloudCredentials): Promise<SyncResult> {
    const provider = this.providers.get(credentials.provider);
    if (!provider || !provider.pullFile) return { success: false, message: 'Provider does not support pullFile' };
    return provider.pullFile(vaultPath, relativePath, credentials);
  }

  async move(vaultPath: string, oldRelativePath: string, newRelativePath: string, credentials: CloudCredentials): Promise<SyncResult> {
    const provider = this.providers.get(credentials.provider);
    if (!provider || !provider.move) return { success: false, message: 'Provider does not support atomic move' };
    return provider.move(vaultPath, oldRelativePath, newRelativePath, credentials);
  }

  /**
   * Lists all Obsync vault folders (Obsync_*) visible to the given credentials.
   * Returns an empty array if the provider doesn't support listing.
   */
  async listVaults(credentials: CloudCredentials): Promise<string[]> {
    const provider = this.providers.get(credentials.provider);
    if (!provider) throw new Error(`Unknown provider: ${credentials.provider}`);
    if (!provider.listVaults) return [];
    return provider.listVaults(credentials);
  }

  /** Wire up token refresh persistence for a provider instance */
  private wireTokenRefresh(provider: ICloudProvider, vaultId: string): void {
    provider.onTokenRefreshed = (newTokenJson: string) => {
      this.persistRefreshedToken(vaultId, newTokenJson);
    };
  }

  /**
   * Persists a refreshed OAuth token back to encrypted storage so the next
   * sync doesn't need to re-exchange the refresh token.
   */
  persistRefreshedToken(vaultId: string, newTokenJson: string): void {
    try {
      const config = this.getConfig(vaultId);
      if (!config) return;
      const updated = { ...config, encryptedToken: encrypt(newTokenJson) };
      const appConfig = this.storage.load();
      this.storage.update({
        cloudConfigs: { ...appConfig.cloudConfigs, [vaultId]: updated },
      });
      logger.info(`Persisted refreshed token for vault ${vaultId}`);
    } catch (err) {
      logger.error('Failed to persist refreshed token', err);
    }
  }
}
