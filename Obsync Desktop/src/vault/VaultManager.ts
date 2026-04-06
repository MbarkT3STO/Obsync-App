/**
 * VaultManager — CRUD for VaultConfig objects.
 *
 * Stores vault configs in userData/vaults.json.
 * Credentials are NOT stored here — they live in TokenStore.
 *
 * This coexists with the legacy VaultService (which stores vaults in the main
 * obsync-config.json). New vaults created via the multi-provider UI use this
 * manager; legacy vaults continue to work via VaultService.
 */

import fs from 'fs';
import path from 'path';
import { app } from 'electron';
import crypto from 'crypto';
import type { VaultConfig } from './VaultConfig';
import { DEFAULT_VAULT_CONFIG } from './VaultConfig';
import { createLogger } from '../utils/logger.util';

const logger = createLogger('VaultManager');

export class VaultManager {
  private readonly filePath: string;
  private cache: VaultConfig[] | null = null;

  constructor() {
    this.filePath = path.join(app.getPath('userData'), 'vaults.json');
  }

  // ── CRUD ──────────────────────────────────────────────────────────────────

  list(): VaultConfig[] {
    return this.load();
  }

  getById(id: string): VaultConfig | undefined {
    return this.load().find((v) => v.id === id);
  }

  getByPath(localPath: string): VaultConfig | undefined {
    return this.load().find((v) => v.localPath === localPath);
  }

  /**
   * Add a new vault. Throws if the path doesn't exist or is already registered.
   */
  add(
    localPath: string,
    providerId: string,
    providerConfig: VaultConfig['providerConfig'] = {},
    syncOptions: Partial<VaultConfig['syncOptions']> = {},
  ): VaultConfig {
    if (!fs.existsSync(localPath)) {
      throw new Error(`Path does not exist: ${localPath}`);
    }
    const existing = this.getByPath(localPath);
    if (existing) throw new Error('Vault already registered');

    const vault: VaultConfig = {
      ...DEFAULT_VAULT_CONFIG,
      id: crypto.randomUUID(),
      name: path.basename(localPath),
      localPath,
      providerId,
      providerConfig,
      syncOptions: { ...DEFAULT_VAULT_CONFIG.syncOptions, ...syncOptions },
      createdAt: new Date().toISOString(),
    };

    const vaults = this.load();
    vaults.push(vault);
    this.persist(vaults);
    logger.info(`Vault added: ${vault.name} (${vault.id})`);
    return vault;
  }

  update(id: string, partial: Partial<VaultConfig>): VaultConfig {
    const vaults = this.load();
    const idx = vaults.findIndex((v) => v.id === id);
    if (idx === -1) throw new Error(`Vault not found: ${id}`);
    vaults[idx] = { ...vaults[idx]!, ...partial };
    this.persist(vaults);
    return vaults[idx]!;
  }

  remove(id: string): void {
    const vaults = this.load().filter((v) => v.id !== id);
    this.persist(vaults);
    logger.info(`Vault removed: ${id}`);
  }

  updateLastSync(id: string): void {
    this.update(id, { lastSync: new Date().toISOString() });
  }

  // ── Persistence ───────────────────────────────────────────────────────────

  private load(): VaultConfig[] {
    if (this.cache) return this.cache;
    if (!fs.existsSync(this.filePath)) {
      this.cache = [];
      return [];
    }
    try {
      this.cache = JSON.parse(fs.readFileSync(this.filePath, 'utf-8')) as VaultConfig[];
      return this.cache;
    } catch (e) {
      logger.error('Failed to load vaults.json:', e);
      this.cache = [];
      return [];
    }
  }

  private persist(vaults: VaultConfig[]): void {
    this.cache = vaults;
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(vaults, null, 2), 'utf-8');
    fs.renameSync(tmp, this.filePath);
  }
}
