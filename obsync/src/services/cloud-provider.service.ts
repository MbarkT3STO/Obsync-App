import { createLogger } from '../utils/logger.util';
import { encrypt, decrypt } from '../utils/crypto.util';
import type { CloudConfig, CloudCredentials, SyncResult } from '../models/cloud-sync.model';
import type { StorageService } from './storage.service';
import { GitCloudProvider } from './providers/git.provider';
import { WebDAVCloudProvider } from './providers/webdav.provider';
import { GoogleDriveCloudProvider } from './providers/googledrive.provider';
import { DropboxCloudProvider } from './providers/dropbox.provider';
import { OneDriveCloudProvider } from './providers/onedrive.provider';
import type { ICloudProvider } from '../models/cloud-sync.model';

const logger = createLogger('CloudProviderService');

/** Gateway service that routes sync requests to the appropriate provider (Git, WebDAV, etc.) */
export class CloudProviderService {
  private providers: Record<string, ICloudProvider> = {};

  constructor(private readonly storage: StorageService) {
    const git = new GitCloudProvider();
    this.providers['github'] = git;
    this.providers['gitlab'] = git;
    this.providers['bitbucket'] = git;
    this.providers['git-custom'] = git;
    this.providers['webdav'] = new WebDAVCloudProvider();
    this.providers['googledrive'] = new GoogleDriveCloudProvider();
    this.providers['dropbox'] = new DropboxCloudProvider();
    this.providers['onedrive'] = new OneDriveCloudProvider();
    this.providers['s3'] = this.providers['googledrive']; // S3 placeholder
    // Add more providers here (S3, Dropbox, etc.)
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
      logger.error(`Failed to decrypt token for vault ${vaultId}`);
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
    const provider = this.providers[credentials.provider];
    if (!provider) return { success: false, message: `Unknown provider: ${credentials.provider}` };
    return provider.validate(credentials);
  }

  async push(vaultPath: string, vaultId: string): Promise<SyncResult> {
    const creds = this.getCredentials(vaultId);
    if (!creds) return { success: false, message: 'Provider not configured' };
    const provider = this.providers[creds.provider];
    if (!provider) return { success: false, message: 'No sync engine for this provider' };
    return provider.push(vaultPath, creds);
  }

  async pull(vaultPath: string, vaultId: string): Promise<SyncResult> {
    const creds = this.getCredentials(vaultId);
    if (!creds) return { success: false, message: 'Provider not configured' };
    const provider = this.providers[creds.provider];
    if (!provider) return { success: false, message: 'No sync engine for this provider' };
    return provider.pull(vaultPath, creds);
  }

  async initRepo(vaultPath: string, credentials: CloudCredentials): Promise<SyncResult> {
    const provider = this.providers[credentials.provider];
    if (!provider || !provider.init) return { success: false, message: 'Provider does not support initialization' };
    return provider.init(vaultPath, credentials);
  }

  async clone(vaultPath: string, credentials: CloudCredentials): Promise<SyncResult> {
    const provider = this.providers[credentials.provider];
    if (!provider || !provider.clone) return { success: false, message: 'Provider does not support import' };
    return provider.clone(vaultPath, credentials);
  }
}
