import { contextBridge, ipcRenderer } from 'electron';
import { IPC } from '../config/ipc-channels';
import type { GitHubCredentials } from '../models/github.model';

/**
 * Secure bridge — only explicitly listed channels are exposed.
 * The renderer never has access to Node.js or Electron internals.
 */
contextBridge.exposeInMainWorld('obsync', {
  // Vault
  vault: {
    selectFolder: () => ipcRenderer.invoke(IPC.VAULT_SELECT_FOLDER),
    add: (localPath: string) => ipcRenderer.invoke(IPC.VAULT_ADD, localPath),
    remove: (vaultId: string) => ipcRenderer.invoke(IPC.VAULT_REMOVE, vaultId),
    list: () => ipcRenderer.invoke(IPC.VAULT_LIST),
  },

  // GitHub
  github: {
    saveConfig: (vaultId: string, credentials: GitHubCredentials) =>
      ipcRenderer.invoke(IPC.GITHUB_SAVE_CONFIG, vaultId, credentials),
    getConfig: (vaultId: string) => ipcRenderer.invoke(IPC.GITHUB_GET_CONFIG, vaultId),
    validate: (credentials: GitHubCredentials) => ipcRenderer.invoke(IPC.GITHUB_VALIDATE, credentials),
  },

  // Sync
  sync: {
    init: (vaultId: string) => ipcRenderer.invoke(IPC.SYNC_INIT, vaultId),
    push: (vaultId: string) => ipcRenderer.invoke(IPC.SYNC_PUSH, vaultId),
    pull: (vaultId: string) => ipcRenderer.invoke(IPC.SYNC_PULL, vaultId),
    getStatus: (vaultId: string) => ipcRenderer.invoke(IPC.SYNC_STATUS, vaultId),
  },

  // Theme
  theme: {
    get: () => ipcRenderer.invoke(IPC.THEME_GET),
    set: (theme: 'dark' | 'light') => ipcRenderer.invoke(IPC.THEME_SET, theme),
  },

  // Events from main process
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
  },

  // Cleanup
  off: {
    syncProgress: () => ipcRenderer.removeAllListeners(IPC.EVENT_SYNC_PROGRESS),
    syncComplete: () => ipcRenderer.removeAllListeners(IPC.EVENT_SYNC_COMPLETE),
    conflictDetected: () => ipcRenderer.removeAllListeners(IPC.EVENT_CONFLICT_DETECTED),
  },
});
