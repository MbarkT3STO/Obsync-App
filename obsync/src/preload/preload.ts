import { contextBridge, ipcRenderer } from 'electron';
import { IPC } from '../config/ipc-channels';
import type { GitHubCredentials } from '../models/github.model';
import type { AutoSyncConfig } from '../models/history.model';
import type { AppSettings } from '../models/app-state.model';

contextBridge.exposeInMainWorld('obsync', {
  vault: {
    selectFolder: () => ipcRenderer.invoke(IPC.VAULT_SELECT_FOLDER),
    add: (localPath: string) => ipcRenderer.invoke(IPC.VAULT_ADD, localPath),
    remove: (vaultId: string) => ipcRenderer.invoke(IPC.VAULT_REMOVE, vaultId),
    list: () => ipcRenderer.invoke(IPC.VAULT_LIST),
  },
  github: {
    saveConfig: (vaultId: string, credentials: GitHubCredentials) =>
      ipcRenderer.invoke(IPC.GITHUB_SAVE_CONFIG, vaultId, credentials),
    getConfig: (vaultId: string) => ipcRenderer.invoke(IPC.GITHUB_GET_CONFIG, vaultId),
    validate: (credentials: GitHubCredentials) => ipcRenderer.invoke(IPC.GITHUB_VALIDATE, credentials),
  },
  sync: {
    init: (vaultId: string) => ipcRenderer.invoke(IPC.SYNC_INIT, vaultId),
    push: (vaultId: string) => ipcRenderer.invoke(IPC.SYNC_PUSH, vaultId),
    pull: (vaultId: string) => ipcRenderer.invoke(IPC.SYNC_PULL, vaultId),
    pullAll: () => ipcRenderer.invoke(IPC.SYNC_ALL_PULL),
    getStatus: (vaultId: string) => ipcRenderer.invoke(IPC.SYNC_STATUS, vaultId),
  },
  history: {
    getCommits: (vaultId: string, limit?: number) => ipcRenderer.invoke(IPC.HISTORY_GET, vaultId, limit),
    getFileDiff: (vaultId: string, filePath: string) => ipcRenderer.invoke(IPC.HISTORY_GET_DIFF, vaultId, filePath),
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
});
