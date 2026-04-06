/**
 * GiteaProvider — syncs vaults to self-hosted Gitea / Codeberg instances.
 *
 * Auth: Personal Access Token.
 * Remote URL format: https://{token}@{host}/{owner}/{repo}.git
 *
 * The user provides the full repo URL (including the host) in extra.repoUrl.
 * This also covers Codeberg (codeberg.org runs Gitea).
 */

import { BaseGitProvider } from './BaseGitProvider';
import type { ProviderCredentials } from '../SyncProvider';

export class GiteaProvider extends BaseGitProvider {
  readonly id = 'gitea';
  readonly name = 'Gitea / Codeberg';
  readonly icon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor">
    <path d="M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zm0
    2.4a9.6 9.6 0 1 1 0 19.2A9.6 9.6 0 0 1 12 2.4zm0 3.6a6 6 0 1 0 0 12A6 6 0 0 0 12 6z"/>
  </svg>`;

  protected getRemoteUrl(credentials: ProviderCredentials): string {
    const repoUrl = credentials.extra?.['repoUrl'] ?? '';
    const token = credentials.token;
    return repoUrl.replace(/^https?:\/\/([^@]+@)?/, `https://${token}@`);
  }
}
