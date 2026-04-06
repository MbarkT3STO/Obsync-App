import { contextBridge, ipcRenderer } from 'electron';
import { IPC } from '../config/ipc-channels';
import type { CloudCredentials } from '../models/cloud-sync.model';
import type { AutoSyncConfig } from '../models/history.model';
import type { AppSettings } from '../models/app-state.model';

contextBridge.exposeInMainWorld('obsync', {
  vault: {
    selectFolder: () => ipcRenderer.invoke(IPC.VAULT_SELECT_FOLDER),
    add: (localPath: string) => ipcRenderer.invoke(IPC.VAULT_ADD, localPath),
    remove: (vaultId: string) => ipcRenderer.invoke(IPC.VAULT_REMOVE, vaultId),
    list: () => ipcRenderer.invoke(IPC.VAULT_LIST),
    clone: (targetPath: string, credentials: CloudCredentials) =>
      ipcRenderer.invoke(IPC.VAULT_CLONE, targetPath, credentials),
    healthCheck: (vaultId: string) => ipcRenderer.invoke(IPC.VAULT_HEALTH_CHECK, vaultId),
    repair: (vaultId: string) => ipcRenderer.invoke(IPC.VAULT_REPAIR, vaultId),
  },
  cloud: {
    saveConfig: (vaultId: string, credentials: CloudCredentials) =>
      ipcRenderer.invoke(IPC.CLOUD_SAVE_CONFIG, vaultId, credentials),
    getConfig: (vaultId: string) => ipcRenderer.invoke(IPC.CLOUD_GET_CONFIG, vaultId),
    validate: (credentials: CloudCredentials) => ipcRenderer.invoke(IPC.CLOUD_VALIDATE, credentials),
    signIn: (provider: string) => ipcRenderer.invoke(IPC.CLOUD_SIGN_IN, provider),
    listVaults: (credentials: CloudCredentials) => ipcRenderer.invoke(IPC.CLOUD_LIST_VAULTS, credentials),
  },
  sync: {
    init: (vaultId: string) => ipcRenderer.invoke(IPC.SYNC_INIT, vaultId),
    push: (vaultId: string) => ipcRenderer.invoke(IPC.SYNC_PUSH, vaultId),
    pull: (vaultId: string) => ipcRenderer.invoke(IPC.SYNC_PULL, vaultId),
    pullAll: () => ipcRenderer.invoke(IPC.SYNC_ALL_PULL),
    getStatus: (vaultId: string) => ipcRenderer.invoke(IPC.SYNC_STATUS, vaultId),
    resolveConflict: (vaultId: string, filePath: string, strategy: 'local' | 'cloud' | 'both') =>
      ipcRenderer.invoke(IPC.SYNC_RESOLVE, vaultId, filePath, strategy),
    acquireLock: (vaultId: string) => ipcRenderer.invoke(IPC.SYNC_ACQUIRE_LOCK, vaultId),
    releaseLock: (vaultId: string) => ipcRenderer.invoke(IPC.SYNC_RELEASE_LOCK, vaultId),
    checkLock: (vaultId: string) => ipcRenderer.invoke(IPC.SYNC_CHECK_LOCK, vaultId),
  },
  history: {
    getCommits: (vaultId: string, limit?: number) => ipcRenderer.invoke(IPC.HISTORY_GET, vaultId, limit),
    getFileDiff: (vaultId: string, filePath: string) => ipcRenderer.invoke(IPC.HISTORY_GET_DIFF, vaultId, filePath),
    listVersions: (vaultId: string, filePath: string) => ipcRenderer.invoke(IPC.HISTORY_LIST_VERSIONS, vaultId, filePath),
    restoreVersion: (vaultId: string, filePath: string, version: string) => ipcRenderer.invoke(IPC.HISTORY_RESTORE_VERSION, vaultId, filePath, version),
    listArchivedFiles: (vaultId: string) => ipcRenderer.invoke(IPC.HISTORY_LIST_ARCHIVED_FILES, vaultId),
  },
  autoSync: {
    set: (vaultId: string, config: AutoSyncConfig) => ipcRenderer.invoke(IPC.AUTOSYNC_SET, vaultId, config),
    get: (vaultId: string) => ipcRenderer.invoke(IPC.AUTOSYNC_GET, vaultId),
  },
  settings: {
    get: () => ipcRenderer.invoke(IPC.SETTINGS_GET),
    set: (s: Partial<AppSettings>) => ipcRenderer.invoke(IPC.SETTINGS_SET, s),
  },
  theme: {
    get: () => ipcRenderer.invoke(IPC.THEME_GET),
    set: (theme: 'dark' | 'light') => ipcRenderer.invoke(IPC.THEME_SET, theme),
  },
  on: {
    syncProgress: (cb: (status: unknown) => void) => {
      ipcRenderer.on(IPC.EVENT_SYNC_PROGRESS, (_e, data) => cb(data));
    },
    syncComplete: (cb: (data: unknown) => void) => {
      ipcRenderer.on(IPC.EVENT_SYNC_COMPLETE, (_e, data) => cb(data));
    },
    conflictDetected: (cb: (data: unknown) => void) => {
      ipcRenderer.on(IPC.EVENT_CONFLICT_DETECTED, (_e, data) => cb(data));
    },
    autoSyncTriggered: (cb: (data: unknown) => void) => {
      ipcRenderer.on(IPC.EVENT_AUTOSYNC_TRIGGERED, (_e, data) => cb(data));
    },
    startupPullDone: (cb: (results: unknown) => void) => {
      ipcRenderer.on(IPC.EVENT_STARTUP_PULL_DONE, (_e, data) => cb(data));
    },
  },
  off: {
    syncProgress: () => ipcRenderer.removeAllListeners(IPC.EVENT_SYNC_PROGRESS),
    syncComplete: () => ipcRenderer.removeAllListeners(IPC.EVENT_SYNC_COMPLETE),
    conflictDetected: () => ipcRenderer.removeAllListeners(IPC.EVENT_CONFLICT_DETECTED),
    autoSyncTriggered: () => ipcRenderer.removeAllListeners(IPC.EVENT_AUTOSYNC_TRIGGERED),
    startupPullDone: () => ipcRenderer.removeAllListeners(IPC.EVENT_STARTUP_PULL_DONE),
  },
  // ── Multi-provider API (new) ─────────────────────────────────────────────
  providers: {
    list: () => ipcRenderer.invoke(IPC.SYNC_GET_PROVIDERS),
    connect: (vaultId: string, providerId: string, credentials: unknown) =>
      ipcRenderer.invoke(IPC.SYNC_CONNECT_PROVIDER, vaultId, providerId, credentials),
    disconnect: (vaultId: string, providerId: string) =>
      ipcRenderer.invoke(IPC.SYNC_DISCONNECT_PROVIDER, vaultId, providerId),
    testConnection: (vaultId: string) => ipcRenderer.invoke(IPC.SYNC_TEST_CONNECTION, vaultId),
    getVaultProvider: (vaultId: string) => ipcRenderer.invoke(IPC.SYNC_GET_VAULT_PROVIDER, vaultId),
  },
  syncV2: {
    run: (vaultId: string) => ipcRenderer.invoke(IPC.SYNC_RUN, vaultId),
  },
  oauth: {
    start: (providerId: string, vaultId: string) => ipcRenderer.invoke(IPC.OAUTH_START, providerId, vaultId),
    status: (vaultId: string, providerId: string) => ipcRenderer.invoke(IPC.OAUTH_STATUS, vaultId, providerId),
  },
  vaultV2: {
    list: () => ipcRenderer.invoke(IPC.VAULT_LIST_V2),
    add: (localPath: string, providerId: string, providerConfig: unknown, syncOptions: unknown) =>
      ipcRenderer.invoke(IPC.VAULT_ADD_V2, localPath, providerId, providerConfig, syncOptions),
    update: (vaultId: string, partial: unknown) => ipcRenderer.invoke(IPC.VAULT_UPDATE, vaultId, partial),
    remove: (vaultId: string) => ipcRenderer.invoke(IPC.VAULT_REMOVE_V2, vaultId),
    get: (vaultId: string) => ipcRenderer.invoke(IPC.VAULT_GET, vaultId),
  },
});


