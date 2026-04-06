/**
 * ProviderRegistry — the single source of truth for all available SyncProviders.
 *
 * Used by IPC handlers and the renderer to discover, instantiate, and look up providers.
 * The SyncEngine never imports this — it only receives a connected SyncProvider instance.
 */

import type { SyncProvider } from './SyncProvider';
import { GitHubProvider } from './git/GitHubProvider';
import { GitLabProvider } from './git/GitLabProvider';
import { BitbucketProvider } from './git/BitbucketProvider';
import { GiteaProvider } from './git/GiteaProvider';
import { GoogleDriveProvider } from './cloud/GoogleDriveProvider';
import { OneDriveProvider } from './cloud/OneDriveProvider';
import { DropboxProvider } from './cloud/DropboxProvider';

export interface ProviderMeta {
  id: string;
  name: string;
  type: 'git' | 'cloud';
  icon: string;
  authType: 'pat' | 'oauth';
  /** True if the user must supply a custom URL (e.g. Gitea self-hosted) */
  requiresUrl: boolean;
  /** Human-readable description shown in the UI */
  description: string;
}

/** All registered provider metadata (safe to send to renderer). */
export const PROVIDER_METADATA: ProviderMeta[] = [
  {
    id: 'github',
    name: 'GitHub',
    type: 'git',
    icon: new GitHubProvider().icon,
    authType: 'pat',
    requiresUrl: true,
    description: 'Sync via a GitHub repository using a Personal Access Token.',
  },
  {
    id: 'gitlab',
    name: 'GitLab',
    type: 'git',
    icon: new GitLabProvider().icon,
    authType: 'pat',
    requiresUrl: true,
    description: 'Sync via a GitLab repository using a Personal Access Token.',
  },
  {
    id: 'bitbucket',
    name: 'Bitbucket',
    type: 'git',
    icon: new BitbucketProvider().icon,
    authType: 'pat',
    requiresUrl: true,
    description: 'Sync via a Bitbucket repository using an App Password.',
  },
  {
    id: 'gitea',
    name: 'Gitea / Codeberg',
    type: 'git',
    icon: new GiteaProvider().icon,
    authType: 'pat',
    requiresUrl: true,
    description: 'Sync via a self-hosted Gitea or Codeberg repository.',
  },
  {
    id: 'googledrive',
    name: 'Google Drive',
    type: 'cloud',
    icon: new GoogleDriveProvider().icon,
    authType: 'oauth',
    requiresUrl: false,
    description: 'Sync vault files to Google Drive (15 GB free).',
  },
  {
    id: 'onedrive',
    name: 'Microsoft OneDrive',
    type: 'cloud',
    icon: new OneDriveProvider().icon,
    authType: 'oauth',
    requiresUrl: false,
    description: 'Sync vault files to Microsoft OneDrive (5 GB free).',
  },
  {
    id: 'dropbox',
    name: 'Dropbox',
    type: 'cloud',
    icon: new DropboxProvider().icon,
    authType: 'oauth',
    requiresUrl: false,
    description: 'Sync vault files to Dropbox (2 GB free).',
  },
];

/** Factory: create a fresh provider instance by ID. */
export function createProvider(providerId: string): SyncProvider {
  switch (providerId) {
    case 'github':     return new GitHubProvider();
    case 'gitlab':     return new GitLabProvider();
    case 'bitbucket':  return new BitbucketProvider();
    case 'gitea':      return new GiteaProvider();
    case 'googledrive': return new GoogleDriveProvider();
    case 'onedrive':   return new OneDriveProvider();
    case 'dropbox':    return new DropboxProvider();
    default:
      throw new Error(`Unknown provider: ${providerId}`);
  }
}

/** Look up metadata for a provider by ID. */
export function getProviderMeta(providerId: string): ProviderMeta | undefined {
  return PROVIDER_METADATA.find((p) => p.id === providerId);
}
