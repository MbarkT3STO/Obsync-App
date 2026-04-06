/**
 * OAuthManager — handles OAuth 2.0 flows for cloud providers in Electron.
 *
 * Flow:
 *  1. Start a temporary local HTTP server on a random available port.
 *  2. Open the provider's authorization URL in the user's default browser
 *     via shell.openExternal() — never a BrowserWindow (security risk).
 *  3. Receive the auth code at http://localhost:{port}/callback.
 *  4. Exchange the code for access + refresh tokens.
 *  5. Store tokens via TokenStore.
 *  6. Before each sync, check expiry and refresh proactively.
 *
 * Provider setup instructions are in PROVIDERS.md.
 */

import { shell } from 'electron';
import http from 'http';
import https from 'https';
import crypto from 'crypto';
import net from 'net';
import type { TokenStore } from './TokenStore';
import type { ProviderCredentials } from '../providers/SyncProvider';
import { createLogger } from '../utils/logger.util';

const logger = createLogger('OAuthManager');
const OAUTH_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

interface OAuthConfig {
  clientId: string;
  clientSecret: string;
  authUrl: string;
  tokenUrl: string;
  scopes: string[];
  extraParams?: Record<string, string>;
}

export class OAuthManager {
  constructor(private readonly tokenStore: TokenStore) {}

  private readonly configs: Record<string, OAuthConfig> = {
    googledrive: {
      clientId: process.env['GOOGLE_CLIENT_ID'] ?? '',
      clientSecret: process.env['GOOGLE_CLIENT_SECRET'] ?? '',
      authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenUrl: 'https://oauth2.googleapis.com/token',
      scopes: ['https://www.googleapis.com/auth/drive.file'],
      extraParams: { access_type: 'offline', prompt: 'consent' },
    },
    onedrive: {
      clientId: process.env['ONEDRIVE_CLIENT_ID'] ?? '',
      clientSecret: process.env['ONEDRIVE_CLIENT_SECRET'] ?? '',
      authUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
      tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
      scopes: ['files.readwrite', 'offline_access'],
    },
    dropbox: {
      clientId: process.env['DROPBOX_CLIENT_ID'] ?? '',
      clientSecret: process.env['DROPBOX_CLIENT_SECRET'] ?? '',
      authUrl: 'https://www.dropbox.com/oauth2/authorize',
      tokenUrl: 'https://api.dropboxapi.com/oauth2/token',
      scopes: ['files.content.write', 'files.content.read', 'files.metadata.write', 'files.metadata.read', 'account_info.read'],
      extraParams: { token_access_type: 'offline' },
    },
  };

  /**
   * Start an OAuth flow for the given provider.
   * Returns the serialised ProviderCredentials JSON string on success.
   */
  async signIn(providerId: string, vaultId: string): Promise<string> {
    const config = this.configs[providerId];
    if (!config) throw new Error(`OAuth not supported for provider: ${providerId}`);

    const port = await this.findFreePort();
    const redirectUri = `http://localhost:${port}/callback`;
    const state = crypto.randomBytes(16).toString('hex');

    return new Promise((resolve, reject) => {
      let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

      const cleanup = (server: http.Server) => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        server.close();
      };

      const server = http.createServer(async (req, res) => {
        const url = new URL(req.url!, `http://localhost:${port}`);
        const code = url.searchParams.get('code');
        const returnedState = url.searchParams.get('state');
        const error = url.searchParams.get('error');

        if (error) {
          res.end(`<h1>Authentication Failed</h1><p>${error}</p><p>You can close this window.</p>`);
          cleanup(server);
          reject(new Error(`OAuth error: ${error}`));
          return;
        }

        if (!returnedState || returnedState !== state) {
          res.end('<h1>Authentication Failed</h1><p>Invalid state — possible CSRF. Please try again.</p>');
          cleanup(server);
          reject(new Error('OAuth state mismatch'));
          return;
        }

        if (!code) {
          res.end('<h1>Authentication Failed</h1><p>No authorization code received.</p>');
          cleanup(server);
          reject(new Error('No authorization code'));
          return;
        }

        try {
          const tokenData = await this.exchangeCode(config, code, redirectUri);
          res.end('<h1>Authentication Successful!</h1><p>You can close this window and return to Obsync.</p>');
          cleanup(server);

          const creds: ProviderCredentials = {
            type: 'oauth',
            token: JSON.stringify(tokenData),
            refreshToken: tokenData.refresh_token,
            expiresAt: tokenData.expires_at,
          };

          this.tokenStore.save(vaultId, providerId, creds);
          resolve(JSON.stringify(tokenData));
        } catch (err) {
          res.end(`<h1>Token Exchange Failed</h1><p>${err instanceof Error ? err.message : 'Unknown error'}</p>`);
          cleanup(server);
          reject(err);
        }
      });

      server.listen(port, 'localhost', () => {
        const params = new URLSearchParams({
          client_id: config.clientId,
          redirect_uri: redirectUri,
          response_type: 'code',
          scope: config.scopes.join(' '),
          state,
          ...(config.extraParams ?? {}),
        });
        const authUrl = `${config.authUrl}?${params.toString()}`;
        logger.info(`Opening OAuth URL for ${providerId}`);
        shell.openExternal(authUrl);
      });

      timeoutHandle = setTimeout(() => {
        server.close();
        reject(new Error('Sign-in timed out after 5 minutes. Please try again.'));
      }, OAUTH_TIMEOUT_MS);

      server.on('error', (err) => {
        cleanup(server);
        reject(new Error(`OAuth server error: ${err.message}`));
      });
    });
  }

  /**
   * Exchange an authorization code for tokens.
   */
  private exchangeCode(config: OAuthConfig, code: string, redirectUri: string): Promise<any> {
    return new Promise((resolve, reject) => {
      const params = new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        code,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      });
      // Microsoft requires scope in the body
      if (config.tokenUrl.includes('microsoft')) {
        params.append('scope', config.scopes.join(' '));
      }
      const body = params.toString();
      const req = https.request(
        config.tokenUrl,
        { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': body.length } },
        (res) => {
          let d = '';
          res.on('data', (c) => (d += c));
          res.on('end', () => {
            try {
              const j = JSON.parse(d);
              if (j.access_token) {
                resolve({
                  access_token: j.access_token,
                  refresh_token: j.refresh_token,
                  expires_in: j.expires_in,
                  expires_at: Date.now() + (j.expires_in ?? 3600) * 1000,
                });
              } else {
                reject(new Error(j.error_description ?? j.error ?? 'No access token'));
              }
            } catch { reject(new Error('Failed to parse token response')); }
          });
        },
      );
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  /** Find a free TCP port by binding to port 0 and reading the assigned port. */
  private findFreePort(): Promise<number> {
    return new Promise((resolve, reject) => {
      const srv = net.createServer();
      srv.listen(0, 'localhost', () => {
        const addr = srv.address();
        const port = typeof addr === 'object' && addr ? addr.port : 0;
        srv.close(() => resolve(port));
      });
      srv.on('error', reject);
    });
  }
}
