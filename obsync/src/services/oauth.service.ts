import { shell } from 'electron';
import http from 'http';
import { createLogger } from '../utils/logger.util';
import type { SyncProviderType } from '../models/cloud-sync.model';

const logger = createLogger('OAuthService');

interface OAuthConfig {
  clientId: string;
  clientSecret: string;
  authUrl: string;
  tokenUrl: string;
  scopes: string[];
  extraParams?: Record<string, string>;
}

export class OAuthService {
  private readonly configs: Partial<Record<SyncProviderType, OAuthConfig>> = {
    'googledrive': {
      clientId: process.env.GOOGLE_CLIENT_ID || '',
      clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
      authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenUrl: 'https://oauth2.googleapis.com/token',
      scopes: ['https://www.googleapis.com/auth/drive.file'],
      extraParams: { access_type: 'offline', prompt: 'consent' }
    },
    'dropbox': {
      clientId: process.env.DROPBOX_CLIENT_ID || '',
      clientSecret: process.env.DROPBOX_CLIENT_SECRET || '',
      authUrl: 'https://www.dropbox.com/oauth2/authorize',
      tokenUrl: 'https://api.dropboxapi.com/oauth2/token',
      scopes: [
        'files.content.write', 
        'files.content.read', 
        'files.metadata.write', 
        'files.metadata.read', 
        'account_info.read'
      ],
      extraParams: { token_access_type: 'offline' }
    },
    'onedrive': {
      clientId: process.env.ONEDRIVE_CLIENT_ID || '',
      clientSecret: process.env.ONEDRIVE_CLIENT_SECRET || '',
      authUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
      tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
      scopes: ['files.readwrite', 'offline_access']
    }
  };

  async signIn(provider: SyncProviderType): Promise<string> {
    const config = this.configs[provider];
    if (!config) throw new Error(`OAuth not supported for ${provider}`);

    return new Promise((resolve, reject) => {
      const server = http.createServer(async (req, res) => {
        const url = new URL(req.url!, `http://${req.headers.host}`);
        const code = url.searchParams.get('code');

        if (code) {
          const PORT = 51730;
          const redirectUri = `http://localhost:${PORT}`;
          
          try {
            const tokenData = await this.exchangeCodeForToken(config, code, redirectUri);
            res.end('<h1>Authentication Successful!</h1><p>You can close this window and return to Obsync.</p>');
            server.close();
            resolve(JSON.stringify(tokenData));
          } catch (err) {
            logger.error(`Token Exchange failed for ${provider}:`, err);
            res.end(`<h1>Token Exchange Failed</h1><p>${err instanceof Error ? err.message : 'Unknown error'}</p>`);
            server.close();
            reject(err);
          }
        } else {
          res.end('<h1>Authentication Failed</h1><p>No code received.</p>');
          server.close();
          reject(new Error('No code received'));
        }
      });

      const PORT = 51730;
      server.listen(PORT, 'localhost', () => {
        const redirectUri = `http://localhost:${PORT}`;
        
        const params = new URLSearchParams({
          client_id: config.clientId,
          redirect_uri: redirectUri,
          response_type: 'code',
          scope: config.scopes.join(' '),
          ...(config.extraParams || {})
        });

        const fullAuthUrl = `${config.authUrl}?${params.toString()}`;
        logger.info(`Opening OAuth URL for ${provider}`);
        shell.openExternal(fullAuthUrl);
      });
    });
  }

  private async exchangeCodeForToken(config: OAuthConfig, code: string, redirectUri: string): Promise<any> {
    return new Promise((resolve, reject) => {
      const https = require('https') as typeof import('https');
      const bodyParams = new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        code,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code'
      });

      // Microsoft sometimes requires scope in the body too
      if (config.tokenUrl.includes('microsoft')) {
        bodyParams.append('scope', config.scopes.join(' '));
      }

      const body = bodyParams.toString();
      const options = {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body)
        }
      };

      const req = https.request(config.tokenUrl, options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            if (json.access_token) {
              resolve({
                access_token: json.access_token,
                refresh_token: json.refresh_token,
                expires_in: json.expires_in,
                expires_at: Date.now() + (json.expires_in * 1000)
              });
            } else {
              logger.error('Token endpoint error response:', json);
              reject(new Error(json.error_explanation || json.error_description || json.error || 'No access token received'));
            }
          } catch (e) {
            logger.error('Failed to parse token response:', data);
            reject(new Error('Failed to parse token response'));
          }
        });
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }
}
