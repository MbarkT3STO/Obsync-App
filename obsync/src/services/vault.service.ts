import fs from 'fs';
import { generateId } from '../utils/id.util';
import { createLogger } from '../utils/logger.util';
import type { Vault } from '../models/vault.model';
import type { StorageService } from './storage.service';

const logger = createLogger('VaultService');

export class VaultService {
  constructor(private readonly storage: StorageService) {}

  list(): Vault[] {
    return this.storage.load().vaults;
  }

  add(localPath: string): Vault {
    if (!fs.existsSync(localPath)) {
      throw new Error(`Path does not exist: ${localPath}`);
    }

    const config = this.storage.load();
    const existing = config.vaults.find(v => v.localPath === localPath);
    if (existing) throw new Error('Vault already added');

    const vault: Vault = {
      id: generateId(),
      name: localPath.split(/[\\/]/).pop() ?? localPath,
      localPath,
      createdAt: new Date().toISOString(),
      lastSyncedAt: null,
    };

    this.storage.update({ vaults: [...config.vaults, vault] });
    logger.info(`Vault added: ${vault.name} (${vault.id})`);
    return vault;
  }

  remove(vaultId: string): void {
    const config = this.storage.load();
    const vaults = config.vaults.filter(v => v.id !== vaultId);
    const cloudConfigs = { ...config.cloudConfigs };
    delete cloudConfigs[vaultId];
    this.storage.update({ vaults, cloudConfigs });
    logger.info(`Vault removed: ${vaultId}`);
  }

  updateLastSynced(vaultId: string): void {
    const config = this.storage.load();
    const vaults = config.vaults.map(v =>
      v.id === vaultId ? { ...v, lastSyncedAt: new Date().toISOString() } : v
    );
    this.storage.update({ vaults });
  }

  getById(vaultId: string): Vault | undefined {
    return this.storage.load().vaults.find(v => v.id === vaultId);
  }
}
