/**
 * FileHasher — pure SHA-256 utility with no external dependencies.
 *
 * Used by ManifestManager to fingerprint vault files for change detection.
 */

import crypto from 'crypto';
import fs from 'fs';

export class FileHasher {
  /**
   * Compute the SHA-256 hex digest of a file on disk.
   * Streams the file to avoid loading large attachments into memory.
   */
  static hashFile(absolutePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash('sha256');
      const stream = fs.createReadStream(absolutePath);
      stream.on('data', (chunk) => hash.update(chunk));
      stream.on('end', () => resolve(hash.digest('hex')));
      stream.on('error', reject);
    });
  }

  /**
   * Compute the SHA-256 hex digest of an in-memory Buffer.
   */
  static hashBuffer(buf: Buffer): string {
    return crypto.createHash('sha256').update(buf).digest('hex');
  }

  /**
   * Compute the SHA-256 hex digest of a UTF-8 string.
   */
  static hashString(text: string): string {
    return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
  }
}
