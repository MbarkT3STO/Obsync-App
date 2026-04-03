import fs from 'fs';
import path from 'path';
import { createLogger } from '../../utils/logger.util';
import type { 
  ICloudProvider, 
  CloudCredentials, 
  SyncResult 
} from '../../models/cloud-sync.model';

const logger = createLogger('WebDAVCloudProvider');

/** 
 * Simplified WebDAV Implementation using native HTTPS.
 * For Obsidian users (Nextcloud, etc.)
 */
export class WebDAVCloudProvider implements ICloudProvider {
  
  async validate(creds: CloudCredentials): Promise<SyncResult> {
    try {
      const resp = await this.davRequest('PROPFIND', creds);
      if (resp.status >= 200 && resp.status < 300) {
        return { success: true, message: 'Connected' };
      }
      return { success: false, message: `Failed: ${resp.status}` };
    } catch (err) {
      return { success: false, message: err instanceof Error ? err.message : 'WebDAV connection error' };
    }
  }

  async push(vaultPath: string, creds: CloudCredentials): Promise<SyncResult> {
    try {
      // In a real implementation: Compare local vs remote modified times
      // For this preliminary version, we'll iterate through all local files and upload
      const files = this.getAllFiles(vaultPath);
      let count = 0;

      for (const filePath of files) {
        const relativePath = path.relative(vaultPath, filePath).replace(/\\/g, '/');
        if (relativePath.includes('.git/') || relativePath.includes('.obsidian/workspace')) continue;

        const content = fs.readFileSync(filePath);
        await this.davRequest('PUT', creds, relativePath, content);
        count++;
      }

      return { success: true, message: `Pushed ${count} file(s) to WebDAV`, filesChanged: count };
    } catch (err) {
      return { success: false, message: `WebDAV Push Failed: ${err}` };
    }
  }

  async pull(vaultPath: string, creds: CloudCredentials): Promise<SyncResult> {
    // Preliminary pull: For now, we'll just log that it's requested. 
    // Real implementation would use PROPFIND to list and GET to download.
    return { success: true, message: 'WebDAV Pull: Sync logic pending implementation' };
  }

  private getAllFiles(dirPath: string, arrayOfFiles: string[] = []): string[] {
    const files = fs.readdirSync(dirPath);
    files.forEach((file) => {
      const fullPath = path.join(dirPath, file);
      if (fs.statSync(fullPath).isDirectory()) {
        arrayOfFiles = this.getAllFiles(fullPath, arrayOfFiles);
      } else {
        arrayOfFiles.push(fullPath);
      }
    });
    return arrayOfFiles;
  }

  private davRequest(method: string, creds: CloudCredentials, remotePath = '', body?: Buffer): Promise<{ status: number }> {
    return new Promise((resolve, reject) => {
      const https = require('https') as typeof import('https');
      const http = require('http') as typeof import('http');
      
      const baseUrl = creds.meta['repoUrl'] || ''; // WebDAV Server URL
      if (!baseUrl) {
        resolve({ status: 400 }); // Bad request
        return;
      }
      const fullUrl = new URL(path.join(baseUrl, remotePath).replace(/\\/g, '/'));
      
      const client = fullUrl.protocol === 'https:' ? https : http;
      const auth = Buffer.from(creds.token).toString('base64'); // For WebDAV: 'user:pass' encoded

      const req = client.request({
        hostname: fullUrl.hostname,
        port: fullUrl.port || (fullUrl.protocol === 'https:' ? 443 : 80),
        path: fullUrl.pathname + fullUrl.search,
        method: method,
        headers: {
          'Authorization': `Basic ${auth}`,
          'User-Agent': 'Obsync/1.0.0',
          'Content-Length': body ? body.length : 0,
          'Depth': method === 'PROPFIND' ? '1' : undefined,
        },
      }, (res) => {
        res.resume();
        resolve({ status: res.statusCode ?? 0 });
      });

      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    });
  }
}
