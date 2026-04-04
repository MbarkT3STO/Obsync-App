import * as path from 'path';
import type { CloudCredentials } from '../models/cloud-sync.model';

/**
 * Returns the cloud folder name for a vault.
 * Priority: credentials.meta.cloudVaultName > path.basename(vaultPath)
 * The cloud folder is stored as Obsync_<cloudVaultName>.
 */
export function getCloudVaultName(vaultPath: string, credentials: CloudCredentials): string {
  return (credentials.meta['cloudVaultName'] as string | undefined)?.trim()
    || path.basename(vaultPath);
}

export function getCloudRootFolder(vaultPath: string, credentials: CloudCredentials): string {
  return `Obsync_${getCloudVaultName(vaultPath, credentials)}`;
}
