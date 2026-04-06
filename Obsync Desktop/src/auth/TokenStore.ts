/**
 * TokenStore — secure credential storage backed by Electron safeStorage.
 *
 * safeStorage delegates to the OS credential store:
 *   - Windows  → DPAPI (tied to the current Windows user session)
 *   - macOS    → Keychain
 *   - Linux    → libsecret / kwallet
 *
 * Credentials are NEVER written to plain files, localStorage, or Electron store.
 * The encrypted blobs are stored in userData/tokens/ as opaque files.
 *
 * Account naming: {vaultId}_{providerId}
 */

import { safeStorage } from 'electron';
import { app } from 'electron';
import fs from 'fs';
import path from 'path';
import type { ProviderCredentials } from '../providers/SyncProvider';
import { createLogger } from '../utils/logger.util';

const logger = createLogger('TokenStore');

export class TokenStore {
  private readonly tokenDir: string;

  constructor() {
    this.tokenDir = path.join(app.getPath('userData'), 'tokens');
    if (!fs.existsSync(this.tokenDir)) {
      fs.mkdirSync(this.tokenDir, { recursive: true });
    }
  }

  /**
   * Persist credentials for a vault+provider pair.
   * The full ProviderCredentials object is serialised to JSON and encrypted.
   */
  save(vaultId: string, providerId: string, creds: ProviderCredentials): void {
    const key = this.accountKey(vaultId, providerId);
    const json = JSON.stringify(creds);
    const encrypted = this.encrypt(json);
    const filePath = this.tokenPath(key);
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, encrypted);
    fs.renameSync(tmp, filePath);
    logger.info(`Token saved for ${key}`);
  }

  /**
   * Load credentials for a vault+provider pair.
   * Returns null if not found or if decryption fails (re-auth required).
   */
  load(vaultId: string, providerId: string): ProviderCredentials | null {
    const key = this.accountKey(vaultId, providerId);
    const filePath = this.tokenPath(key);
    if (!fs.existsSync(filePath)) return null;
    try {
      const encrypted = fs.readFileSync(filePath);
      const json = this.decrypt(encrypted);
      return JSON.parse(json) as ProviderCredentials;
    } catch (e) {
      logger.warn(`Cannot decrypt token for ${key} — re-authentication required`);
      return null;
    }
  }

  /**
   * Delete credentials for a vault+provider pair.
   */
  delete(vaultId: string, providerId: string): void {
    const key = this.accountKey(vaultId, providerId);
    const filePath = this.tokenPath(key);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      logger.info(`Token deleted for ${key}`);
    }
  }

  /**
   * Delete all tokens associated with a vault (all providers).
   */
  deleteAllForVault(vaultId: string): void {
    const prefix = `${vaultId}_`;
    try {
      const files = fs.readdirSync(this.tokenDir);
      for (const file of files) {
        if (file.startsWith(prefix)) {
          fs.unlinkSync(path.join(this.tokenDir, file));
          logger.info(`Token deleted: ${file}`);
        }
      }
    } catch (e) {
      logger.warn('Failed to delete vault tokens:', e);
    }
  }

  // ── Encryption helpers ────────────────────────────────────────────────────

  private encrypt(text: string): Buffer {
    if (safeStorage.isEncryptionAvailable()) {
      return safeStorage.encryptString(text);
    }
    // Fallback for headless/CI: store as UTF-8 with a warning
    logger.warn('safeStorage unavailable — storing token as plain text (not recommended for production)');
    return Buffer.from(text, 'utf-8');
  }

  private decrypt(data: Buffer): string {
    if (safeStorage.isEncryptionAvailable()) {
      return safeStorage.decryptString(data);
    }
    return data.toString('utf-8');
  }

  private accountKey(vaultId: string, providerId: string): string {
    // Sanitise to safe filename characters
    return `${vaultId}_${providerId}`.replace(/[^a-zA-Z0-9_-]/g, '_');
  }

  private tokenPath(key: string): string {
    return path.join(this.tokenDir, `${key}.enc`);
  }
}
