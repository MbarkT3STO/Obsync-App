import path from 'path';
import { app } from 'electron';

export const APP_CONFIG = {
  appName: 'Obsync',
  version: '1.0.0',
  configFileName: 'obsync-config.json',
  get configDir(): string {
    return app.getPath('userData');
  },
  get configFilePath(): string {
    return path.join(this.configDir, this.configFileName);
  },
  defaultBranch: 'main',
  encryptionAlgorithm: 'aes-256-cbc',
} as const;
