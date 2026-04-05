import fs from 'fs';
import path from 'path';
import { APP_CONFIG } from '../config/app.config';
import type { AppConfig } from '../models/app-state.model';
import { createLogger } from '../utils/logger.util';

const logger = createLogger('StorageService');

const DEFAULT_CONFIG: AppConfig = {
  vaults: [],
  cloudConfigs: {},
  autoSyncConfigs: {},
  settings: {
    syncOnStartup: false,
    minimizeToTray: true,
    startMinimized: false,
    launchOnStartup: true,
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
        return structuredClone(this.cache);
      }
      const raw = fs.readFileSync(this.configPath, 'utf-8');
      const data = JSON.parse(raw);

      // ── Migration: githubConfigs → cloudConfigs ───────────────────────────────
      if (data.githubConfigs && !data.cloudConfigs) {
        data.cloudConfigs = {};
        for (const [id, cfg] of Object.entries(data.githubConfigs)) {
          const old = cfg as any;
          (data.cloudConfigs as any)[id] = { 
            provider: 'github',
            encryptedToken: old.encryptedToken,
            meta: {
              repoUrl: old.repoUrl,
              branch: old.branch || 'main'
            }
          };
        }
        delete data.githubConfigs;
        logger.info('Migrated legacy GitHub configs to new Cloud Metadata format');
      }

      // ── Migration: cloudConfigs v1 -> v2 (Moving top-level fields to meta) ─────
      if (data.cloudConfigs) {
        for (const id of Object.keys(data.cloudConfigs)) {
          const cfg = data.cloudConfigs[id];
          if (cfg.repoUrl || cfg.branch) {
             cfg.meta = {
                repoUrl: cfg.repoUrl,
                branch: cfg.branch || 'main',
                ...cfg.meta
             };
             delete cfg.repoUrl;
             delete cfg.branch;
          }
        }
      }

      this.cache = { ...DEFAULT_CONFIG, ...data } as AppConfig;
      return structuredClone(this.cache);
    } catch (err) {
      logger.error('Failed to load config, using defaults', err);
      this.cache = { ...DEFAULT_CONFIG };
      return structuredClone(this.cache);
    }
  }

  save(config: AppConfig): void {
    try {
      this.cache = config;
      const json = JSON.stringify(config, null, 2);
      // Write to a temp file first, then rename — rename is atomic on all major OSes,
      // so a crash mid-write can never leave a truncated/corrupt config file.
      const tmpPath = `${this.configPath}.tmp`;
      fs.writeFileSync(tmpPath, json, 'utf-8');
      fs.renameSync(tmpPath, this.configPath);
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
