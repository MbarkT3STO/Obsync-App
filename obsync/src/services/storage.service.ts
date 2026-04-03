import fs from 'fs';
import path from 'path';
import { APP_CONFIG } from '../config/app.config';
import type { AppConfig } from '../models/app-state.model';
import { createLogger } from '../utils/logger.util';

const logger = createLogger('StorageService');

const DEFAULT_CONFIG: AppConfig = {
  vaults: [],
  githubConfigs: {},
  autoSyncConfigs: {},
  settings: {
    syncOnStartup: false,
    minimizeToTray: true,
    startMinimized: false,
  },
  theme: 'dark',
  version: APP_CONFIG.version,
};

export class StorageService {
  private configPath: string;
  private cache: AppConfig | null = null;

  constructor() {
    this.configPath = APP_CONFIG.configFilePath;
    this.ensureConfigDir();
  }

  private ensureConfigDir(): void {
    const dir = path.dirname(this.configPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  load(): AppConfig {
    if (this.cache) return this.cache;
    try {
      if (!fs.existsSync(this.configPath)) {
        this.cache = { ...DEFAULT_CONFIG };
        this.save(this.cache);
        return this.cache;
      }
      const raw = fs.readFileSync(this.configPath, 'utf-8');
      this.cache = { ...DEFAULT_CONFIG, ...JSON.parse(raw) } as AppConfig;
      return this.cache;
    } catch (err) {
      logger.error('Failed to load config, using defaults', err);
      this.cache = { ...DEFAULT_CONFIG };
      return this.cache;
    }
  }

  save(config: AppConfig): void {
    try {
      this.cache = config;
      fs.writeFileSync(this.configPath, JSON.stringify(config, null, 2), 'utf-8');
    } catch (err) {
      logger.error('Failed to save config', err);
      throw new Error('Could not persist configuration');
    }
  }

  update(partial: Partial<AppConfig>): AppConfig {
    const current = this.load();
    const updated = { ...current, ...partial };
    this.save(updated);
    return updated;
  }
}
