/**
 * oauthHandlers — IPC handlers for OAuth flows.
 *
 * New channels:
 *   oauth:start   → begins OAuth flow for a cloud provider
 *   oauth:status  → polls whether OAuth completed (token stored)
 *
 * The existing cloud:sign-in channel in ipc-handlers.ts is preserved for
 * backward compatibility with the legacy renderer.
 */

import { ipcMain } from 'electron';
import { OAuthManager } from '../auth/OAuthManager';
import { TokenStore } from '../auth/TokenStore';
import { createLogger } from '../utils/logger.util';

const logger = createLogger('OAuthHandlers');

export function registerOAuthHandlers(
  oauthManager: OAuthManager,
  tokenStore: TokenStore,
): void {

  /**
   * Begin an OAuth flow for a cloud provider.
   * Opens the browser and waits for the callback.
   * Returns the raw token JSON string on success.
   */
  ipcMain.handle('oauth:start', async (_event, providerId: string, vaultId: string) => {
    try {
      const tokenJson = await oauthManager.signIn(providerId, vaultId);
      return { success: true, data: tokenJson };
    } catch (err) {
      logger.error(`OAuth failed for ${providerId}:`, err);
      return { success: false, error: err instanceof Error ? err.message : 'OAuth failed' };
    }
  });

  /**
   * Check whether a token is stored for a vault+provider.
   * Used by the renderer to poll after opening the browser.
   */
  ipcMain.handle('oauth:status', async (_event, vaultId: string, providerId: string) => {
    const creds = tokenStore.load(vaultId, providerId);
    return { success: true, data: { connected: creds !== null } };
  });
}
