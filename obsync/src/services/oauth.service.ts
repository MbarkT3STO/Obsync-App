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
}

export class OAuthService {
  private readonly configs: Partial<Record<SyncProviderType, OAuthConfig>> = {
    'googledrive': {
      clientId: process.env.GOOGLE_CLIENT_ID || '',
      clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
      authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenUrl: 'https://oauth2.googleapis.com/token',
      scopes: ['https://www.googleapis.com/auth/drive.file']
    },
    'dropbox': {
      clientId: process.env.DROPBOX_CLIENT_ID || '',
      clientSecret: process.env.DROPBOX_CLIENT_SECRET || '',
      authUrl: 'https://www.dropbox.com/oauth2/authorize',
      tokenUrl: 'https://api.dropboxapi.com/oauth2/token',
      scopes: []
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
          const port = (server.address() as any).port;
          const redirectUri = `http://127.0.0.1:${port}`;
          
          try {
            const token = await this.exchangeCodeForToken(config, code, redirectUri);
            res.end('<h1>Authentication Successful!</h1><p>Return to Obsync.</p>');
            server.close();
            resolve(token);
          } catch (err) {
            res.end('<h1>Token Exchange Failed</h1>');
            server.close();
            reject(err);
          }
        } else {
          res.end('<h1>Authentication Failed</h1>');
          server.close();
          reject(new Error('No code received'));
        }
      });

      server.listen(0, '127.0.0.1', () => {
        const port = (server.address() as any).port;
        const redirectUri = `http://127.0.0.1:${port}`;
        
        const params = new URLSearchParams({
          client_id: config.clientId,
          redirect_uri: redirectUri,
          response_type: 'code',
          scope: config.scopes.join(' '),
          access_type: 'offline',
          prompt: 'consent'
        });

        shell.openExternal(`${config.authUrl}?${params.toString()}`);
      });
    });
  }

  private async exchangeCodeForToken(config: OAuthConfig, code: string, redirectUri: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const https = require('https') as typeof import('https');
      const params = new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        code,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code'
      });

      const options = {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': params.toString().length
        }
      };

      const req = https.request(config.tokenUrl, options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            if (json.access_token) resolve(json.access_token);
            else reject(new Error(json.error_description || 'No access token received'));
          } catch (e) {
            reject(new Error('Failed to parse token response'));
          }
        });
      });
      req.on('error', reject);
      req.write(params.toString());
      req.end();
    });
  }
}
