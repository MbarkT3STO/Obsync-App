import { safeStorage } from 'electron';
import crypto from 'crypto';

/**
 * Token encryption using Electron's safeStorage API.
 *
 * safeStorage delegates to the OS credential store:
 *   - Windows  → DPAPI (tied to the current Windows user session)
 *   - macOS    → Keychain
 *   - Linux    → libsecret / kwallet (falls back to a plain key if unavailable)
 *
 * This means:
 *   - Tokens encrypted on machine A cannot be decrypted on machine B — by design.
 *   - Each machine re-authenticates once and stores its own encrypted token locally.
 *   - The config file (obsync-config.json) can safely sync between machines because
 *     the encrypted blobs are machine-specific and harmless without the OS key.
 *
 * Multi-machine workflow:
 *   1. User sets up provider on machine A → token encrypted + stored locally.
 *   2. Config syncs to machine B (via vault sync or cloud backup).
 *   3. Obsync on machine B detects it can't decrypt → prompts re-authentication.
 *   4. User signs in once on machine B → new token encrypted + stored locally.
 *
 * Format stored in config: base64 string of the encrypted Buffer returned by safeStorage.
 *
 * OBSYNC_SECRET env var:
 *   For headless / CI environments where safeStorage is unavailable, set this env var
 *   to use AES-256-CBC encryption instead. Never use this on a desktop install.
 */

const ALGORITHM = 'aes-256-cbc';
const IV_LENGTH = 16;

// ── safeStorage path ───────────────────────────────────────────────────────

export function encrypt(text: string): string {
  if (safeStorage.isEncryptionAvailable()) {
    // Prefix 'ss:' so decrypt knows which path to take
    const encrypted = safeStorage.encryptString(text);
    return `ss:${encrypted.toString('base64')}`;
  }
  return aesEncrypt(text);
}

export function decrypt(encryptedText: string): string {
  if (encryptedText.startsWith('ss:')) {
    const buf = Buffer.from(encryptedText.slice(3), 'base64');
    return safeStorage.decryptString(buf);
  }
  // Legacy AES-encrypted value (or OBSYNC_SECRET path)
  return aesDecrypt(encryptedText);
}

// ── AES-256-CBC fallback (headless / CI) ──────────────────────────────────

function getAesKey(): Buffer {
  const secret = process.env['OBSYNC_SECRET'];
  if (!secret) {
    throw new Error(
      'safeStorage is unavailable and OBSYNC_SECRET is not set. ' +
      'Set the OBSYNC_SECRET environment variable to enable token encryption in headless mode.'
    );
  }
  return crypto.createHash('sha256').update(secret).digest();
}

function aesEncrypt(text: string): string {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, getAesKey(), iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return `${iv.toString('hex')}:${encrypted.toString('hex')}`;
}

function aesDecrypt(encryptedText: string): string {
  const [ivHex, encryptedHex] = encryptedText.split(':');
  if (!ivHex || !encryptedHex) throw new Error('Invalid encrypted format');
  const iv = Buffer.from(ivHex, 'hex');
  const encrypted = Buffer.from(encryptedHex, 'hex');
  const decipher = crypto.createDecipheriv(ALGORITHM, getAesKey(), iv);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}
