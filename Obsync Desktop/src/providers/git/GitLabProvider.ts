/**
 * GitLabProvider — syncs vaults to GitLab repositories.
 *
 * Auth: Personal Access Token with read_repository + write_repository scope.
 * Remote URL format: https://oauth2:{token}@gitlab.com/{owner}/{repo}.git
 */

import { BaseGitProvider } from './BaseGitProvider';
import type { ProviderCredentials } from '../SyncProvider';

export class GitLabProvider extends BaseGitProvider {
  readonly id = 'gitlab';
  readonly name = 'GitLab';
  readonly icon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor">
    <path d="M23.955 13.587l-1.342-4.135-2.664-8.189a.455.455 0 0 0-.867 0L16.418 9.45H7.582
    L4.918 1.263a.455.455 0 0 0-.867 0L1.386 9.45.044 13.587a.924.924 0 0 0 .331 1.023L12
    23.054l11.625-8.443a.924.924 0 0 0 .33-1.024z"/>
  </svg>`;

  protected getRemoteUrl(credentials: ProviderCredentials): string {
    const repoUrl = credentials.extra?.['repoUrl'] ?? '';
    const token = credentials.token;
    // GitLab uses oauth2 as the username for token auth
    return repoUrl.replace(/^https?:\/\/([^@]+@)?/, `https://oauth2:${token}@`);
  }
}
