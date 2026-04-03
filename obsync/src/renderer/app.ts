/**
 * Renderer process entry point.
 * Pure TypeScript — no frameworks. Communicates with main via window.obsync (contextBridge).
 */

import type { Vault, VaultSyncStatus } from '../models/vault.model';
import type { IpcResponse } from '../models/app-state.model';

// ── Type augmentation for the contextBridge API ────────────────────────────
declare global {
  interface Window {
    obsync: ObsyncAPI;
  }
}

interface ObsyncAPI {
  vault: {
    selectFolder(): Promise<IpcResponse<string>>;
    add(path: string): Promise<IpcResponse<Vault>>;
    remove(id: string): Promise<IpcResponse<void>>;
    list(): Promise<IpcResponse<Vault[]>>;
  };
  github: {
    saveConfig(vaultId: string, creds: { token: string; repoUrl: string; branch: string }): Promise<IpcResponse<void>>;
    getConfig(vaultId: string): Promise<IpcResponse<{ repoUrl: string; branch: string }>>;
    validate(creds: { token: string; repoUrl: string; branch: string }): Promise<IpcResponse<boolean>>;
  };
  sync: {
    init(vaultId: string): Promise<IpcResponse<void>>;
    push(vaultId: string): Promise<IpcResponse<{ message: string; filesChanged?: number }>>;
    pull(vaultId: string): Promise<IpcResponse<{ message: string }>>;
    getStatus(vaultId: string): Promise<IpcResponse<VaultSyncStatus>>;
  };
  theme: {
    get(): Promise<IpcResponse<'dark' | 'light'>>;
    set(theme: 'dark' | 'light'): Promise<IpcResponse<void>>;
  };
  on: {
    syncProgress(cb: (status: VaultSyncStatus) => void): void;
    syncComplete(cb: (data: { vaultId: string; result: { success: boolean; message: string } }) => void): void;
    conflictDetected(cb: (data: { vaultId: string; conflicts: Array<{ filePath: string }> }) => void): void;
  };
  off: {
    syncProgress(): void;
    syncComplete(): void;
    conflictDetected(): void;
  };
}

// ── State ──────────────────────────────────────────────────────────────────
let vaults: Vault[] = [];
let selectedVaultId: string | null = null;

// ── DOM refs ───────────────────────────────────────────────────────────────
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const vaultList       = $<HTMLUListElement>('vault-list');
const panelWelcome    = $('panel-welcome');
const panelVault      = $('panel-vault');
const panelSettings   = $('panel-settings');
const vaultNameEl     = $('vault-name');
const vaultPathEl     = $('vault-path');
const lastSyncedEl    = $('last-synced');
const statusDot       = $('status-dot');
const statusLabel     = $('status-label');
const statusBadge     = $('vault-status-badge');
const btnPush         = $<HTMLButtonElement>('btn-push');
const btnPull         = $<HTMLButtonElement>('btn-pull');
const btnRemove       = $<HTMLButtonElement>('btn-remove-vault');
const githubForm      = $<HTMLFormElement>('github-form');
const inputRepoUrl    = $<HTMLInputElement>('input-repo-url');
const inputBranch     = $<HTMLInputElement>('input-branch');
const inputToken      = $<HTMLInputElement>('input-token');
const btnValidate     = $<HTMLButtonElement>('btn-validate');
const btnSaveConfig   = $<HTMLButtonElement>('btn-save-config');
const btnToggleToken  = $<HTMLButtonElement>('btn-toggle-token');
const btnAddVault     = $<HTMLButtonElement>('btn-add-vault');
const btnWelcomeAdd   = $<HTMLButtonElement>('btn-welcome-add');
const btnSettings     = $<HTMLButtonElement>('btn-settings');
const btnThemeToggle  = $<HTMLButtonElement>('btn-theme-toggle');
const conflictModal   = $('conflict-modal');
const conflictList    = $<HTMLUListElement>('conflict-list');
const btnConflictOk   = $<HTMLButtonElement>('btn-conflict-ok');
const themeDarkBtn    = $<HTMLButtonElement>('theme-dark');
const themeLightBtn   = $<HTMLButtonElement>('theme-light');

// ── Init ───────────────────────────────────────────────────────────────────
async function init(): Promise<void> {
  await loadTheme();
  await loadVaults();
  registerEventListeners();
  registerIpcListeners();
}

async function loadTheme(): Promise<void> {
  const res = await window.obsync.theme.get();
  if (res.success && res.data) applyTheme(res.data);
}

async function loadVaults(): Promise<void> {
  const res = await window.obsync.vault.list();
  if (res.success && res.data) {
    vaults = res.data;
    renderVaultList();
  }
}

// ── Vault List Rendering ───────────────────────────────────────────────────
function renderVaultList(): void {
  vaultList.innerHTML = '';
  if (vaults.length === 0) {
    showPanel('welcome');
    return;
  }

  for (const vault of vaults) {
    const li = document.createElement('li');
    li.className = 'vault-list-item';
    li.setAttribute('role', 'option');
    li.setAttribute('aria-selected', vault.id === selectedVaultId ? 'true' : 'false');
    li.dataset['vaultId'] = vault.id;
    if (vault.id === selectedVaultId) li.classList.add('active');

    li.innerHTML = `
      <svg class="item-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>
        <polyline points="9 22 9 12 15 12 15 22"/>
      </svg>
      <span class="item-name">${escapeHtml(vault.name)}</span>
      <span class="item-status" data-vault-status="${vault.id}"></span>
    `;

    li.addEventListener('click', () => selectVault(vault.id));
    vaultList.appendChild(li);
  }
}

async function selectVault(vaultId: string): Promise<void> {
  selectedVaultId = vaultId;
  const vault = vaults.find(v => v.id === vaultId);
  if (!vault) return;

  renderVaultList();
  showPanel('vault');

  vaultNameEl.textContent = vault.name;
  vaultPathEl.textContent = vault.localPath;
  lastSyncedEl.textContent = vault.lastSyncedAt
    ? new Date(vault.lastSyncedAt).toLocaleString()
    : 'Never';

  setStatus('idle');

  // Load GitHub config (without token)
  const configRes = await window.obsync.github.getConfig(vaultId);
  if (configRes.success && configRes.data) {
    inputRepoUrl.value = configRes.data.repoUrl;
    inputBranch.value = configRes.data.branch;
    inputToken.value = '';
  } else {
    inputRepoUrl.value = '';
    inputBranch.value = 'main';
    inputToken.value = '';
  }
}

// ── Panel Management ───────────────────────────────────────────────────────
function showPanel(panel: 'welcome' | 'vault' | 'settings'): void {
  panelWelcome.classList.toggle('hidden', panel !== 'welcome');
  panelVault.classList.toggle('hidden', panel !== 'vault');
  panelSettings.classList.toggle('hidden', panel !== 'settings');
}

// ── Status ─────────────────────────────────────────────────────────────────
function setStatus(status: VaultSyncStatus['status'], message?: string): void {
  const labels: Record<VaultSyncStatus['status'], string> = {
    idle: 'Idle',
    syncing: 'Syncing...',
    synced: 'Synced',
    error: 'Error',
    conflict: 'Conflict',
  };

  statusDot.className = `status-dot ${status}`;
  statusLabel.textContent = message ?? labels[status];

  // Update sidebar dot
  if (selectedVaultId) {
    const dot = document.querySelector(`[data-vault-status="${selectedVaultId}"]`);
    if (dot) {
      dot.className = `item-status ${status}`;
    }
  }
}

// ── Event Listeners ────────────────────────────────────────────────────────
function registerEventListeners(): void {
  btnAddVault.addEventListener('click', handleAddVault);
  btnWelcomeAdd.addEventListener('click', handleAddVault);
  btnSettings.addEventListener('click', () => showPanel('settings'));
  btnThemeToggle.addEventListener('click', handleThemeToggle);
  btnToggleToken.addEventListener('click', toggleTokenVisibility);
  btnRemove.addEventListener('click', handleRemoveVault);
  btnPush.addEventListener('click', handlePush);
  btnPull.addEventListener('click', handlePull);
  btnValidate.addEventListener('click', handleValidate);
  githubForm.addEventListener('submit', handleSaveConfig);
  btnConflictOk.addEventListener('click', () => conflictModal.classList.add('hidden'));
  themeDarkBtn.addEventListener('click', () => setTheme('dark'));
  themeLightBtn.addEventListener('click', () => setTheme('light'));
}

function registerIpcListeners(): void {
  window.obsync.on.syncProgress((status) => {
    if (status.vaultId === selectedVaultId) {
      setStatus(status.status, status.message);
    }
  });

  window.obsync.on.syncComplete((data) => {
    if (data.vaultId === selectedVaultId) {
      const type = data.result.success ? 'success' : 'error';
      showToast(data.result.message, type);
      // Refresh vault list to update lastSyncedAt
      loadVaults().then(() => {
        const vault = vaults.find(v => v.id === data.vaultId);
        if (vault) {
          lastSyncedEl.textContent = vault.lastSyncedAt
            ? new Date(vault.lastSyncedAt).toLocaleString()
            : 'Never';
        }
      });
    }
  });

  window.obsync.on.conflictDetected((data) => {
    if (data.vaultId === selectedVaultId) {
      showConflictModal(data.conflicts);
    }
  });
}

// ── Handlers ───────────────────────────────────────────────────────────────
async function handleAddVault(): Promise<void> {
  const folderRes = await window.obsync.vault.selectFolder();
  if (!folderRes.success || !folderRes.data) return;

  const addRes = await window.obsync.vault.add(folderRes.data);
  if (addRes.success && addRes.data) {
    vaults.push(addRes.data);
    renderVaultList();
    await selectVault(addRes.data.id);
    showToast(`Vault "${addRes.data.name}" added`, 'success');
  } else {
    showToast(addRes.error ?? 'Failed to add vault', 'error');
  }
}

async function handleRemoveVault(): Promise<void> {
  if (!selectedVaultId) return;
  const vault = vaults.find(v => v.id === selectedVaultId);
  if (!vault) return;

  const confirmed = confirm(`Remove vault "${vault.name}"? This won't delete your local files.`);
  if (!confirmed) return;

  const res = await window.obsync.vault.remove(selectedVaultId);
  if (res.success) {
    vaults = vaults.filter(v => v.id !== selectedVaultId);
    selectedVaultId = null;
    renderVaultList();
    showPanel('welcome');
    showToast('Vault removed', 'info');
  } else {
    showToast(res.error ?? 'Failed to remove vault', 'error');
  }
}

async function handlePush(): Promise<void> {
  if (!selectedVaultId) return;
  setButtonLoading(btnPush, true);
  const res = await window.obsync.sync.push(selectedVaultId);
  setButtonLoading(btnPush, false);
  if (!res.success) showToast(res.error ?? 'Push failed', 'error');
}

async function handlePull(): Promise<void> {
  if (!selectedVaultId) return;
  setButtonLoading(btnPull, true);
  const res = await window.obsync.sync.pull(selectedVaultId);
  setButtonLoading(btnPull, false);
  if (!res.success && !res.data) showToast(res.error ?? 'Pull failed', 'error');
}

async function handleValidate(): Promise<void> {
  const token = inputToken.value.trim();
  const repoUrl = inputRepoUrl.value.trim();
  const branch = inputBranch.value.trim() || 'main';

  if (!token || !repoUrl) {
    showToast('Please fill in the repository URL and token', 'warning');
    return;
  }

  setButtonLoading(btnValidate, true);
  const res = await window.obsync.github.validate({ token, repoUrl, branch });
  setButtonLoading(btnValidate, false);

  if (res.success) {
    showToast('Credentials are valid', 'success');
  } else {
    showToast(res.error ?? 'Invalid credentials', 'error');
  }
}

async function handleSaveConfig(e: Event): Promise<void> {
  e.preventDefault();
  if (!selectedVaultId) return;

  const token = inputToken.value.trim();
  const repoUrl = inputRepoUrl.value.trim();
  const branch = inputBranch.value.trim() || 'main';

  if (!repoUrl) {
    showToast('Repository URL is required', 'warning');
    return;
  }

  if (!token) {
    showToast('Personal Access Token is required', 'warning');
    return;
  }

  setButtonLoading(btnSaveConfig, true);

  const saveRes = await window.obsync.github.saveConfig(selectedVaultId, { token, repoUrl, branch });
  if (!saveRes.success) {
    showToast(saveRes.error ?? 'Failed to save config', 'error');
    setButtonLoading(btnSaveConfig, false);
    return;
  }

  const initRes = await window.obsync.sync.init(selectedVaultId);
  setButtonLoading(btnSaveConfig, false);

  if (initRes.success) {
    showToast('Configuration saved and repository initialized', 'success');
    inputToken.value = ''; // Clear token from UI after saving
  } else {
    showToast(initRes.error ?? 'Saved config but init failed', 'warning');
  }
}

// ── Theme ──────────────────────────────────────────────────────────────────
async function handleThemeToggle(): Promise<void> {
  const current = document.documentElement.getAttribute('data-theme') as 'dark' | 'light';
  await setTheme(current === 'dark' ? 'light' : 'dark');
}

async function setTheme(theme: 'dark' | 'light'): Promise<void> {
  applyTheme(theme);
  await window.obsync.theme.set(theme);
}

function applyTheme(theme: 'dark' | 'light'): void {
  document.documentElement.setAttribute('data-theme', theme);
  themeDarkBtn.classList.toggle('active', theme === 'dark');
  themeLightBtn.classList.toggle('active', theme === 'light');
}

// ── Conflict Modal ─────────────────────────────────────────────────────────
function showConflictModal(conflicts: Array<{ filePath: string }>): void {
  conflictList.innerHTML = '';
  for (const c of conflicts) {
    const li = document.createElement('li');
    li.textContent = c.filePath;
    conflictList.appendChild(li);
  }
  conflictModal.classList.remove('hidden');
}

// ── Toast ──────────────────────────────────────────────────────────────────
const TOAST_ICONS: Record<string, string> = {
  success: `<svg class="toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>`,
  error:   `<svg class="toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>`,
  warning: `<svg class="toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`,
  info:    `<svg class="toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`,
};

function showToast(message: string, type: 'success' | 'error' | 'warning' | 'info' = 'info'): void {
  const container = $('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `${TOAST_ICONS[type] ?? ''}<span>${escapeHtml(message)}</span>`;
  container.appendChild(toast);

  setTimeout(() => {
    toast.classList.add('toast-fade-out');
    toast.addEventListener('animationend', () => toast.remove());
  }, 3500);
}

// ── Helpers ────────────────────────────────────────────────────────────────
function toggleTokenVisibility(): void {
  inputToken.type = inputToken.type === 'password' ? 'text' : 'password';
}

function setButtonLoading(btn: HTMLButtonElement, loading: boolean): void {
  btn.classList.toggle('loading', loading);
  btn.disabled = loading;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// ── Bootstrap ──────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => { init(); });
