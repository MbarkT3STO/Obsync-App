/**
 * Renderer process entry point.
 * Pure TypeScript — no frameworks. Communicates with main via window.obsync (contextBridge).
 */

import type { Vault, VaultSyncStatus } from '../models/vault.model';
import type { IpcResponse, AppSettings } from '../models/app-state.model';
import type { CommitEntry, FileDiff, AutoSyncConfig } from '../models/history.model';
import type { CloudCredentials, SyncProviderType } from '../models/cloud-sync.model';

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
    clone(targetPath: string, credentials: CloudCredentials): Promise<IpcResponse<Vault>>;
  };
  cloud: {
    saveConfig(vaultId: string, creds: CloudCredentials): Promise<IpcResponse<void>>;
    getConfig(vaultId: string): Promise<IpcResponse<{ provider: SyncProviderType; meta: Record<string, any> }>>;
    validate(creds: CloudCredentials): Promise<IpcResponse<boolean>>;
    signIn(provider: SyncProviderType): Promise<IpcResponse<string>>;
  };
  sync: {
    init(vaultId: string): Promise<IpcResponse<void>>;
    push(vaultId: string): Promise<IpcResponse<{ message: string; filesChanged?: number }>>;
    pull(vaultId: string): Promise<IpcResponse<{ message: string }>>;
    pullAll(): Promise<IpcResponse<Array<{ vaultId: string; name: string; success: boolean; message: string }>>>;
    getStatus(vaultId: string): Promise<IpcResponse<VaultSyncStatus>>;
  };
  history: {
    getCommits(vaultId: string, limit?: number): Promise<IpcResponse<CommitEntry[]>>;
    getFileDiff(vaultId: string, filePath: string): Promise<IpcResponse<FileDiff>>;
  };
  autoSync: {
    set(vaultId: string, config: AutoSyncConfig): Promise<IpcResponse<void>>;
    get(vaultId: string): Promise<IpcResponse<AutoSyncConfig>>;
  };
  settings: {
    get(): Promise<IpcResponse<AppSettings>>;
    set(s: Partial<AppSettings>): Promise<IpcResponse<void>>;
  };
  theme: {
    get(): Promise<IpcResponse<'dark' | 'light'>>;
    set(theme: 'dark' | 'light'): Promise<IpcResponse<void>>;
  };
  on: {
    syncProgress(cb: (status: VaultSyncStatus) => void): void;
    syncComplete(cb: (data: { vaultId: string; result: { success: boolean; message: string } }) => void): void;
    conflictDetected(cb: (data: { vaultId: string; conflicts: Array<{ filePath: string }> }) => void): void;
    autoSyncTriggered(cb: (data: { vaultId: string }) => void): void;
    startupPullDone(cb: (results: Array<{ name: string; success: boolean; message: string }>) => void): void;
  };
  off: {
    syncProgress(): void;
    syncComplete(): void;
    conflictDetected(): void;
    autoSyncTriggered(): void;
    startupPullDone(): void;
  };
}

// ── State ──────────────────────────────────────────────────────────────────
let vaults: Vault[] = [];
let selectedVaultId: string | null = null;
let currentProvider: SyncProviderType = 'github';
let currentImportProvider: SyncProviderType = 'github';

// ── DOM refs ───────────────────────────────────────────────────────────────
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const sidebar         = $('sidebar');
const btnCollapse     = $<HTMLButtonElement>('btn-collapse');
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
const cloudForm       = $<HTMLFormElement>('cloud-form');
const inputRepoUrl    = $<HTMLInputElement>('input-repo-url');
const inputBranch     = $<HTMLInputElement>('input-branch');
const inputToken      = $<HTMLInputElement>('input-token');
const btnValidate     = $<HTMLButtonElement>('btn-validate');
const btnSaveConfig   = $<HTMLButtonElement>('btn-save-config');
const btnToggleToken  = $<HTMLButtonElement>('btn-toggle-token');
const btnAddVault     = $<HTMLButtonElement>('btn-add-vault');
const btnWelcomeAdd   = $<HTMLButtonElement>('btn-welcome-add');
const btnSettings     = $<HTMLButtonElement>('btn-settings');
const btnDashboardNav = $<HTMLButtonElement>('btn-dashboard-nav');
const btnGoDashboard  = $('btn-go-dashboard');
const conflictModal   = $('conflict-modal');
const conflictList    = $<HTMLUListElement>('conflict-list');
const btnConflictOk   = $<HTMLButtonElement>('btn-conflict-ok');
const themeDarkBtn    = $<HTMLButtonElement>('theme-dark');
const themeLightBtn   = $<HTMLButtonElement>('theme-light');

// Auto-sync
const autoSyncToggle   = $<HTMLInputElement>('autosync-toggle');
const autoSyncOptions  = $('autosync-options');
const autoSyncDebounce = $<HTMLInputElement>('autosync-debounce');

// Config labels
const labelRepoUrl  = $('label-repo-url');
const labelBranch   = $('label-branch');
const labelToken    = $('label-token');
const importLabelUrl = $('import-label-url');
const importLabelBranch = $('import-label-branch');
const importLabelToken = $('import-label-token');
const btnOAuthSignIn  = $<HTMLButtonElement>('btn-oauth-signin');
const btnImportOAuth  = $<HTMLButtonElement>('btn-import-oauth');

// History modal
const historyModal    = $('history-modal');
const historyList     = $('history-list');
const btnHistoryClose = $<HTMLButtonElement>('btn-history-close');
const btnShowHistory  = $<HTMLButtonElement>('btn-show-history');

// Diff modal
const diffModal       = $('diff-modal');
const diffViewer      = $('diff-viewer');
const diffFilePath    = $('diff-file-path');
const btnDiffClose    = $<HTMLButtonElement>('btn-diff-close');

// Dashboard
const panelDashboard  = $('panel-dashboard');
const vaultCards      = $('vault-cards');
const btnSyncAll      = $<HTMLButtonElement>('btn-sync-all');
const btnDashboardAdd = $<HTMLButtonElement>('btn-dashboard-add');
const dashboardSearch = $<HTMLInputElement>('dashboard-search');
const btnMenuTrigger  = $<HTMLButtonElement>('btn-menu-trigger');
const layout          = document.querySelector('.layout') as HTMLElement;

// Import modal
const btnImportCloud   = $<HTMLButtonElement>('btn-import-cloud');
const importModal      = $('import-modal');
const inputImportRepo  = $<HTMLInputElement>('import-repo-url');
const inputImportBranch = $<HTMLInputElement>('import-branch');
const inputImportToken = $<HTMLInputElement>('import-token');
const inputImportPath  = $<HTMLInputElement>('import-local-path');
const btnImportBrowse  = $<HTMLButtonElement>('btn-import-browse');
const btnImportCancel  = $<HTMLButtonElement>('btn-import-cancel');
const btnImportStart   = $<HTMLButtonElement>('btn-import-start');

// Settings
const settingLaunchStartup  = $<HTMLInputElement>('setting-launch-startup');
const settingSyncStartup    = $<HTMLInputElement>('setting-sync-startup');
const settingMinimizeTray   = $<HTMLInputElement>('setting-minimize-tray');
const settingStartMinimized = $<HTMLInputElement>('setting-start-minimized');
const loadingOverlay       = $('loading-overlay');
const loadingText          = $('loading-text');

// ── Custom Select Controls ────────────────────────────────────────────────
class CustomSelect {
  private element: HTMLElement;
  private trigger: HTMLElement;
  private displayText: HTMLElement;
  private displayIcon: HTMLElement;
  private options: HTMLElement;
  private currentValue: string = 'github';
  private onChange?: (value: string) => void;

  constructor(id: string, onChange?: (val: string) => void) {
    this.element = $(id);
    this.trigger = this.element.querySelector('.custom-select-trigger') as HTMLElement;
    this.displayText = this.element.querySelector('.provider-display-text') as HTMLElement;
    this.displayIcon = this.element.querySelector('.provider-display-icon') as HTMLElement;
    this.options = this.element.querySelector('.custom-select-options') as HTMLElement;
    this.onChange = onChange;

    this.trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggle();
    });

    this.element.querySelectorAll('.custom-option').forEach(opt => {
      opt.addEventListener('click', (e) => {
        e.stopPropagation();
        const val = (opt as HTMLElement).dataset['value'] || 'github';
        this.setValue(val);
        this.close();
      });
    });

    document.addEventListener('click', () => this.close());
  }

  toggle() {
    this.element.classList.toggle('open');
  }

  close() {
    this.element.classList.remove('open');
  }

  setValue(val: string) {
    this.currentValue = val;
    const opt = this.element.querySelector(`.custom-option[data-value="${val}"]`) as HTMLElement;
    if (opt) {
      this.displayText.textContent = opt.querySelector('span')?.textContent || '';
      this.displayIcon.innerHTML = opt.querySelector('.custom-option-icon')?.innerHTML || '';

      this.element.querySelectorAll('.custom-option').forEach(o => o.classList.remove('selected'));
      opt.classList.add('selected');
    }
    if (this.onChange) this.onChange(val);
  }

  getValue(): string {
    return this.currentValue;
  }
}

let providerSelect: CustomSelect;
let importProviderSelect: CustomSelect;

// ── Init ───────────────────────────────────────────────────────────────────
async function init(): Promise<void> {
  restoreSidebarState();
  await loadTheme();
  initCustomSelects();
  await loadVaults();
  await loadSettings();
  registerEventListeners();
  registerIpcListeners();
  hideLoading();
}

function initCustomSelects() {
  providerSelect = new CustomSelect('provider-dropdown', (val) => {
    currentProvider = val as SyncProviderType;
    updateLabel(val as SyncProviderType, labelRepoUrl, labelBranch, inputRepoUrl, inputBranch, labelToken, inputToken, btnOAuthSignIn);
  });
  importProviderSelect = new CustomSelect('import-dropdown', (val) => {
    currentImportProvider = val as SyncProviderType;
    updateLabel(val as SyncProviderType, importLabelUrl, importLabelBranch, inputImportRepo, inputImportBranch, importLabelToken, inputImportToken, btnImportOAuth);
  });

  providerSelect.setValue('github');
  importProviderSelect.setValue('github');
}

function getProviderMeta(provider: SyncProviderType) {
  switch (provider) {
    case 'github':
    case 'gitlab':
    case 'bitbucket':
    case 'git-custom':
      return { 
        urlLabel: 'Repository URL', 
        urlPlaceholder: 'https://github.com/user/repo.git',
        branchLabel: 'Branch',
        branchPlaceholder: 'main',
        hideBranch: false,
        tokenLabel: 'Access Token / Password',
        tokenPlaceholder: 'Enter token or password',
        useOAuth: false,
        isGit: true,
        hideUrl: false
      };
    case 'dropbox':
    case 'googledrive':
    case 'onedrive':
      return {
        urlLabel: 'Cloud Folder Path',
        urlPlaceholder: '/My Vault (optional)',
        branchLabel: '',
        branchPlaceholder: '',
        hideBranch: true,
        tokenLabel: 'Access Token / App Key',
        tokenPlaceholder: 'Enter your access token',
        useOAuth: true,
        isGit: false,
        hideUrl: true
      };
    case 'webdav':
      return {
        urlLabel: 'WebDAV Server URL',
        urlPlaceholder: 'https://nextcloud.com/remote.php/dav/files/user/',
        branchLabel: '',
        branchPlaceholder: '',
        hideBranch: true,
        tokenLabel: 'Password / App Token',
        tokenPlaceholder: 'Your WebDAV password',
        useOAuth: false,
        isGit: false
      };
    case 's3':
      return {
        urlLabel: 'S3 Bucket Name',
        urlPlaceholder: 'my-obsidian-vault',
        branchLabel: 'AWS Region',
        branchPlaceholder: 'us-east-1',
        hideBranch: false,
        tokenLabel: 'Access Key:Secret Key',
        tokenPlaceholder: 'AKIA...:SECRET...',
        useOAuth: false,
        isGit: false
      };
    default:
      return { 
        urlLabel: 'Server URL', 
        urlPlaceholder: '', 
        branchLabel: 'Branch', 
        branchPlaceholder: '', 
        hideBranch: false,
        tokenLabel: 'Access Token / Password',
        tokenPlaceholder: 'Enter token or password',
        useOAuth: false,
        isGit: false
      };
  }
}

function updateLabel(
  provider: SyncProviderType,
  labelUrl: HTMLElement | null,
  labelBranch: HTMLElement | null,
  inputUrl: HTMLInputElement | null,
  inputBranch: HTMLInputElement | null,
  labelToken?: HTMLElement | null,
  inputToken?: HTMLInputElement | null,
  btnOAuth?: HTMLButtonElement | null
) {
  if (!labelUrl || !labelBranch || !inputUrl || !inputBranch) return;
  const meta = getProviderMeta(provider);
  labelUrl.textContent = meta.urlLabel;
  inputUrl.placeholder = meta.urlPlaceholder;

  if (meta.hideUrl) {
    labelUrl.parentElement?.classList.add('hidden');
  } else {
    labelUrl.parentElement?.classList.remove('hidden');
  }
  
  if (meta.hideBranch) {
    labelBranch.parentElement?.classList.add('hidden');
  } else {
    labelBranch.parentElement?.classList.remove('hidden');
    labelBranch.textContent = meta.branchLabel;
    inputBranch.placeholder = meta.branchPlaceholder;
  }

  if (labelToken && meta.tokenLabel) {
    labelToken.textContent = meta.tokenLabel;
  }
  if (inputToken && meta.tokenPlaceholder) {
    inputToken.placeholder = meta.tokenPlaceholder;
  }

  if (btnOAuth) {
    if (meta.useOAuth) {
      btnOAuth.classList.remove('hidden');
      const span = btnOAuth.querySelector('span');
      if (span) span.textContent = `Sign in with ${provider.charAt(0).toUpperCase() + provider.slice(1)}`;
    } else {
      btnOAuth.classList.add('hidden');
    }
  }
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

  if (!selectedVaultId) {
    showPanel('dashboard');
    renderDashboard();
    setNavActive('dashboard');
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
        <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
        <polyline points="9 22 9 12 15 12 15 22"/>
      </svg>
      <span class="item-name">${escapeHtml(vault.name)}</span>
      <span class="item-status" data-vault-status="${vault.id}"></span>
    `;

    li.addEventListener('click', () => {
      selectVault(vault.id);
      closeMobileSidebar();
    });
    vaultList.appendChild(li);
  }
}

async function selectVault(vaultId: string): Promise<void> {
  selectedVaultId = vaultId;
  const vault = vaults.find(v => v.id === vaultId);
  if (!vault) return;

  renderVaultList();
  showPanel('vault');
  setNavActive('vault');

  vaultNameEl.textContent = vault.name;
  vaultPathEl.textContent = vault.localPath;
  lastSyncedEl.textContent = vault.lastSyncedAt
    ? new Date(vault.lastSyncedAt).toLocaleString()
    : 'Never';

  setStatus('idle');

  // Load Cloud config
  const configRes = await window.obsync.cloud.getConfig(vaultId);
  if (configRes.success && configRes.data) {
    providerSelect.setValue(configRes.data.provider);
    inputRepoUrl.value = configRes.data.meta?.repoUrl || '';
    inputBranch.value = configRes.data.meta?.branch || 'main';
  } else {
    providerSelect.setValue('github');
    inputRepoUrl.value = '';
    inputBranch.value = 'main';
  }
  inputToken.value = '';

  await loadAutoSyncConfig(vaultId);
}

// ── Panel Management ───────────────────────────────────────────────────────
function showPanel(panel: 'welcome' | 'dashboard' | 'vault' | 'settings'): void {
  panelWelcome.classList.toggle('hidden', panel !== 'welcome');
  panelDashboard.classList.toggle('hidden', panel !== 'dashboard');
  panelVault.classList.toggle('hidden', panel !== 'vault');
  panelSettings.classList.toggle('hidden', panel !== 'settings');
}

function setNavActive(active: 'dashboard' | 'vault' | 'settings' | 'none'): void {
  btnDashboardNav.classList.toggle('active', active === 'dashboard');
  btnSettings.classList.toggle('active', active === 'settings');
}

// ── Status ─────────────────────────────────────────────────────────────────
function setStatus(status: VaultSyncStatus['status'], message?: string): void {
  const labels: Record<VaultSyncStatus['status'], string> = {
    idle: 'Idle', syncing: 'Syncing...', synced: 'Synced', error: 'Error', conflict: 'Conflict',
  };
  statusDot.className = `status-dot`;
  statusLabel.textContent = message ?? labels[status];
  statusBadge.className = `vault-status-badge ${status === 'idle' ? '' : status}`;

  if (selectedVaultId) {
    const dot = document.querySelector(`[data-vault-status="${selectedVaultId}"]`);
    if (dot) dot.className = `item-status ${status}`;
  }

  // Update card status if on dashboard
  const cardStatus = document.querySelector(`[data-card-status="${selectedVaultId}"]`);
  if (cardStatus) {
    cardStatus.className = `vault-card-status ${status}`;
    cardStatus.innerHTML = `<span class="vault-card-status-dot"></span> ${labels[status]}`;
  }
}

function showLoading(text: string = 'Synchronizing...') {
  loadingText.textContent = text;
  loadingOverlay.classList.remove('hidden');
}

function hideLoading() {
  loadingOverlay.classList.add('hidden');
}

// ── Event Listeners ────────────────────────────────────────────────────────
function registerEventListeners(): void {
  btnAddVault.addEventListener('click', handleAddVault);
  btnWelcomeAdd.addEventListener('click', handleAddVault);
  btnSettings.addEventListener('click', () => {
    showPanel('settings');
    loadSettings();
    setNavActive('settings');
  });
  btnDashboardNav.addEventListener('click', () => {
    selectedVaultId = null;
    renderVaultList();
    setNavActive('dashboard');
    closeMobileSidebar();
  });
  btnGoDashboard.addEventListener('click', () => {
    selectedVaultId = null;
    renderVaultList();
    setNavActive('dashboard');
  });
  btnGoDashboard.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      selectedVaultId = null;
      renderVaultList();
      setNavActive('dashboard');
    }
  });
  btnCollapse.addEventListener('click', toggleSidebar);
  btnToggleToken.addEventListener('click', toggleTokenVisibility);
  btnRemove.addEventListener('click', handleRemoveVault);
  btnPush.addEventListener('click', handlePush);
  btnPull.addEventListener('click', handlePull);
  btnValidate.addEventListener('click', handleValidate);
  cloudForm.addEventListener('submit', handleSaveConfig);
  btnConflictOk.addEventListener('click', () => conflictModal.classList.add('hidden'));
  themeDarkBtn.addEventListener('click', () => setTheme('dark'));
  themeLightBtn.addEventListener('click', () => setTheme('light'));

  autoSyncToggle.addEventListener('change', handleAutoSyncToggle);
  autoSyncDebounce.addEventListener('change', handleAutoSyncDebounceChange);

  btnShowHistory.addEventListener('click', handleShowHistory);
  btnHistoryClose.addEventListener('click', () => historyModal.classList.add('hidden'));
  btnDiffClose.addEventListener('click', () => diffModal.classList.add('hidden'));

  historyModal.addEventListener('click', (e) => { if (e.target === historyModal) historyModal.classList.add('hidden'); });
  diffModal.addEventListener('click', (e) => { if (e.target === diffModal) diffModal.classList.add('hidden'); });

  btnSyncAll.addEventListener('click', handleSyncAll);
  btnDashboardAdd.addEventListener('click', handleAddVault);
  dashboardSearch.addEventListener('input', () => renderDashboard(dashboardSearch.value));

  settingLaunchStartup.addEventListener('change', () =>
    window.obsync.settings.set({ launchOnStartup: settingLaunchStartup.checked }));
  settingSyncStartup.addEventListener('change', () =>
    window.obsync.settings.set({ syncOnStartup: settingSyncStartup.checked }));
  settingMinimizeTray.addEventListener('change', () =>
    window.obsync.settings.set({ minimizeToTray: settingMinimizeTray.checked }));
  settingStartMinimized.addEventListener('change', () =>
    window.obsync.settings.set({ startMinimized: settingStartMinimized.checked }));

  btnMenuTrigger.addEventListener('click', toggleMobileSidebar);

  btnImportCloud.addEventListener('click', () => {
    importModal.classList.remove('hidden');
    importProviderSelect.setValue('github');
    inputImportRepo.value = '';
    inputImportBranch.value = 'main';
    inputImportToken.value = '';
    inputImportPath.value = '';
  });

  btnImportBrowse.addEventListener('click', async () => {
    const res = await window.obsync.vault.selectFolder();
    if (res.success && res.data) {
      inputImportPath.value = res.data;
    }
  });

  btnImportCancel.addEventListener('click', () => importModal.classList.add('hidden'));

  btnImportStart.addEventListener('click', async () => {
    const provider = importProviderSelect.getValue() as SyncProviderType;
    const repoUrl = inputImportRepo.value.trim();
    const branch = inputImportBranch.value.trim() || 'main';
    const token = inputImportToken.value.trim();
    const localPath = inputImportPath.value.trim();

    const meta = getProviderMeta(provider);
    if (!token || !localPath || (meta.isGit && !repoUrl)) {
      showToast(meta.isGit ? 'Please fill all fields' : 'Token and Local Path are required', 'error');
      return;
    }

    btnImportStart.disabled = true;
    (btnImportStart.querySelector('span') || btnImportStart).textContent = 'Cloning...';
    
    try {
      const res = await window.obsync.vault.clone(localPath, { 
        provider, 
        token, 
        meta: { repoUrl, branch } 
      });
      if (res.success && res.data) {
        showToast('Vault imported successfully', 'success');
        importModal.classList.add('hidden');
        await loadVaults();
        selectVault(res.data.id);
      } else {
        showToast(res.error || 'Failed to import vault', 'error');
      }
    } catch (err) {
      showToast('An unexpected error occurred during import', 'error');
    } finally {
      btnImportStart.disabled = false;
      btnImportStart.innerHTML = `
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="1 4 1 10 7 10"/><polyline points="23 20 23 14 17 14"/>
          <path d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 0 1 3.51 15"/>
        </svg>
        Start Import
      `;
    }
  });

  layout.addEventListener('click', (e) => {
    if (layout.classList.contains('sidebar-open') && e.target === layout) {
      closeMobileSidebar();
    }
  });

  const handleOAuth = async (isImport: boolean) => {
    const provider = isImport ? importProviderSelect.getValue() : providerSelect.getValue();
    const tokenInput = isImport ? inputImportToken : inputToken;
    const btn = isImport ? btnImportOAuth : btnOAuthSignIn;

    setButtonLoading(btn, true);
    try {
      const res = await window.obsync.cloud.signIn(provider as SyncProviderType);
      if (res.success && res.data) {
        tokenInput.value = res.data;
        showToast(`Successfully signed in with ${provider.charAt(0).toUpperCase() + provider.slice(1)}`, 'success');
      } else {
        showToast(res.error || 'Sign in failed', 'error');
      }
    } catch (err) {
      showToast('An error occurred during sign in', 'error');
    } finally {
      setButtonLoading(btn, false);
    }
  };

  btnOAuthSignIn.addEventListener('click', () => handleOAuth(false));
  btnImportOAuth.addEventListener('click', () => handleOAuth(true));
}

function toggleMobileSidebar(): void {
  sidebar.classList.toggle('active-mobile');
  layout.classList.toggle('sidebar-open');
}

function closeMobileSidebar(): void {
  sidebar.classList.remove('active-mobile');
  layout.classList.remove('sidebar-open');
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

  window.obsync.on.autoSyncTriggered((data) => {
    if (data.vaultId === selectedVaultId) {
      showToast('Auto-sync triggered — pushing changes...', 'info');
    }
  });

  window.obsync.on.startupPullDone((results) => {
    const banner = document.getElementById('startup-banner');
    if (banner) {
      const allOk = results.every(r => r.success);
      banner.className = `startup-banner done`;
      banner.innerHTML = `
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="20 6 9 17 4 12"/>
        </svg>
        Startup sync complete — ${results.length} vault(s) pulled
      `;
      setTimeout(() => banner.remove(), 4000);
    }
    loadVaults();
  });
}

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
    if (vaults.length > 0) {
      showPanel('dashboard');
      renderDashboard();
    } else {
      showPanel('welcome');
    }
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
  const provider = providerSelect.getValue() as SyncProviderType;
  const token = inputToken.value.trim();
  const repoUrl = inputRepoUrl.value.trim();
  const branch = inputBranch.value.trim() || 'main';

  const meta = getProviderMeta(provider);

  if (!token) {
    showToast('Token / Password is required', 'warning');
    return;
  }

  if (meta.isGit) {
    if (!repoUrl) {
      showToast('Error: Repository URL is mandatory for Git providers.', 'warning');
      return;
    }
  }

  setButtonLoading(btnValidate, true);
  const res = await window.obsync.cloud.validate({ 
    provider, 
    token, 
    meta: { repoUrl, branch } 
  });
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

  const provider = providerSelect.getValue() as SyncProviderType;
  const token = inputToken.value.trim();
  const repoUrl = inputRepoUrl.value.trim();
  const branch = inputBranch.value.trim() || 'main';

  const meta = getProviderMeta(provider);

  if (meta.isGit && !repoUrl) {
    showToast('Error: Repository URL is mandatory for Git providers.', 'warning');
    return;
  }

  if (!token) {
    showToast('Access token / password is required', 'warning');
    return;
  }

  setButtonLoading(btnSaveConfig, true);

  const saveRes = await window.obsync.cloud.saveConfig(selectedVaultId, { 
    provider, 
    token, 
    meta: { repoUrl, branch } 
  });
  if (!saveRes.success) {
    showToast(saveRes.error ?? 'Failed to save config', 'error');
    setButtonLoading(btnSaveConfig, false);
    return;
  }

  const initRes = await window.obsync.sync.init(selectedVaultId);
  setButtonLoading(btnSaveConfig, false);

  if (initRes.success) {
    showToast('Configuration saved and repository initialized', 'success');
    inputToken.value = '';
  } else {
    showToast(initRes.error ?? 'Saved config but init failed', 'warning');
  }
}

async function loadAutoSyncConfig(vaultId: string): Promise<void> {
  const res = await window.obsync.autoSync.get(vaultId);
  if (res.success && res.data) {
    autoSyncToggle.checked = res.data.enabled;
    autoSyncDebounce.value = String(res.data.debounceSeconds ?? 30);
    autoSyncOptions.classList.toggle('hidden', !res.data.enabled);
  }
}

async function handleAutoSyncToggle(): Promise<void> {
  if (!selectedVaultId) return;
  const enabled = autoSyncToggle.checked;
  const debounceSeconds = parseInt(autoSyncDebounce.value, 10) || 30;
  autoSyncOptions.classList.toggle('hidden', !enabled);
  await window.obsync.autoSync.set(selectedVaultId, { enabled, debounceSeconds });
  showToast(enabled ? `Auto-sync enabled (${debounceSeconds}s debounce)` : 'Auto-sync disabled', 'info');
}

async function handleAutoSyncDebounceChange(): Promise<void> {
  if (!selectedVaultId || !autoSyncToggle.checked) return;
  const debounceSeconds = parseInt(autoSyncDebounce.value, 10) || 30;
  await window.obsync.autoSync.set(selectedVaultId, { enabled: true, debounceSeconds });
}

async function handleShowHistory(): Promise<void> {
  if (!selectedVaultId) return;
  historyModal.classList.remove('hidden');
  historyList.innerHTML = '<div class="history-loading">Loading commits...</div>';

  const res = await window.obsync.history.getCommits(selectedVaultId, 50);
  if (!res.success || !res.data || res.data.length === 0) {
    historyList.innerHTML = '<div class="history-empty">No commits yet. Push your vault to see history.</div>';
    return;
  }

  historyList.innerHTML = '';
  for (const commit of res.data) {
    const item = document.createElement('div');
    item.className = 'commit-item';
    item.setAttribute('role', 'button');
    item.setAttribute('tabindex', '0');

    const date = new Date(commit.date).toLocaleString();
    const addSign = commit.insertions > 0 ? `<span class="stat-added">+${commit.insertions}</span>` : '';
    const delSign = commit.deletions > 0 ? `<span class="stat-removed">-${commit.deletions}</span>` : '';

    item.innerHTML = `
      <span class="commit-hash">${escapeHtml(commit.shortHash)}</span>
      <div class="commit-body">
        <div class="commit-message">${escapeHtml(commit.message)}</div>
        <div class="commit-meta">
          <span>${escapeHtml(commit.author)}</span>
          <span>${escapeHtml(date)}</span>
        </div>
      </div>
      <div class="commit-stats">
        ${addSign}${delSign}
        <span class="stat-files">${commit.filesChanged} file${commit.filesChanged !== 1 ? 's' : ''}</span>
      </div>
    `;

    historyList.appendChild(item);
  }
}

async function handleShowDiff(vaultId: string, filePath: string): Promise<void> {
  diffFilePath.textContent = filePath;
  diffViewer.innerHTML = '<div class="diff-empty">Loading diff...</div>';
  diffModal.classList.remove('hidden');

  const res = await window.obsync.history.getFileDiff(vaultId, filePath);
  if (!res.success || !res.data) {
    diffViewer.innerHTML = '<div class="diff-empty">Could not load diff for this file.</div>';
    return;
  }

  renderDiff(res.data);
}

function renderDiff(diff: FileDiff): void {
  if (diff.hunks.length === 0) {
    diffViewer.innerHTML = '<div class="diff-empty">No differences found.</div>';
    return;
  }

  diffViewer.innerHTML = '';

  for (const hunk of diff.hunks) {
    const hunkHeader = document.createElement('div');
    hunkHeader.className = 'diff-hunk-header';
    hunkHeader.textContent = hunk.header;
    diffViewer.appendChild(hunkHeader);

    for (const line of hunk.lines) {
      const lineEl = document.createElement('div');
      const isConflict = line.content.startsWith('<<<<<<<') ||
                         line.content.startsWith('=======') ||
                         line.content.startsWith('>>>>>>>');
      lineEl.className = `diff-line ${line.type}${isConflict ? ' conflict-marker' : ''}`;

      const prefix = line.type === 'added' ? '+' : line.type === 'removed' ? '-' : ' ';
      lineEl.innerHTML = `
        <span class="diff-line-no">${line.lineNo ?? ''}</span>
        <span class="diff-line-content">${prefix} ${escapeHtml(line.content)}</span>
      `;
      diffViewer.appendChild(lineEl);
    }
  }
}

async function loadSettings(): Promise<void> {
  const res = await window.obsync.settings.get();
  if (!res.success || !res.data) return;
  const s = res.data;
  settingLaunchStartup.checked  = s.launchOnStartup ?? true;
  settingSyncStartup.checked    = s.syncOnStartup;
  settingMinimizeTray.checked   = s.minimizeToTray;
  settingStartMinimized.checked = s.startMinimized;

  if (s.syncOnStartup) {
    showStartupBanner();
  }
}

function showStartupBanner(): void {
  const existing = document.getElementById('startup-banner');
  if (existing) return;
  const banner = document.createElement('div');
  banner.id = 'startup-banner';
  banner.className = 'startup-banner';
  banner.innerHTML = `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <polyline points="1 4 1 10 7 10"/>
      <polyline points="23 20 23 14 17 14"/>
      <path d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 0 1 3.51 15"/>
    </svg>
    Pulling latest changes from all vaults...
  `;
  const mainPanel = document.getElementById('main-panel');
  mainPanel?.prepend(banner);
}

function renderDashboard(query: string = ''): void {
  vaultCards.innerHTML = '';
  const filteredVaults = vaults.filter(v => 
    v.name.toLowerCase().includes(query.toLowerCase()) ||
    v.localPath.toLowerCase().includes(query.toLowerCase())
  );

  if (filteredVaults.length === 0 && query) {
    vaultCards.innerHTML = `
      <div class="empty-state" style="grid-column: 1 / -1; min-height: 30vh">
        <p>No vaults found matching "${escapeHtml(query)}"</p>
      </div>
    `;
    return;
  }

  for (const vault of filteredVaults) {
    const card = document.createElement('div');
    card.className = 'vault-card';
    card.setAttribute('role', 'button');
    card.setAttribute('tabindex', '0');

    const lastSync = vault.lastSyncedAt
      ? new Date(vault.lastSyncedAt).toLocaleString()
      : 'Never synced';

    card.innerHTML = `
      <div class="vault-card-header">
        <div class="vault-card-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
            <polyline points="9 22 9 12 15 12 15 22"/>
          </svg>
        </div>
        <div style="min-width:0; flex:1">
          <div class="vault-card-name">${escapeHtml(vault.name)}</div>
          <div class="vault-card-path">${escapeHtml(vault.localPath)}</div>
        </div>
        <button class="btn-icon btn-card-delete" data-vault-id="${vault.id}" title="Remove Vault" aria-label="Remove Vault">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="3 6 5 6 21 6"></polyline>
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
          </svg>
        </button>
      </div>
      <div class="vault-card-footer">
        <div class="vault-card-meta">
          <span>Last sync: ${escapeHtml(lastSync)}</span>
        </div>
        <span class="vault-card-status" data-card-status="${vault.id}">
          <span class="vault-card-status-dot"></span>
          Idle
        </span>
      </div>
    `;

    card.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('.btn-card-delete')) return;
      selectVault(vault.id);
    });
    card.addEventListener('keydown', (e) => { if (e.key === 'Enter') selectVault(vault.id); });
    
    const btnDelete = card.querySelector('.btn-card-delete');
    btnDelete?.addEventListener('click', (e) => {
      e.stopPropagation();
      handleRemoveVaultById(vault.id);
    });

    vaultCards.appendChild(card);
  }
}

async function handleRemoveVaultById(vaultId: string): Promise<void> {
  const vault = vaults.find(v => v.id === vaultId);
  if (!vault) return;

  const confirmed = confirm(`Remove vault "${vault.name}"? This won't delete your local files.`);
  if (!confirmed) return;

  showLoading('Removing vault...');
  const res = await window.obsync.vault.remove(vaultId);
  hideLoading();

  if (res.success) {
    vaults = vaults.filter(v => v.id !== vaultId);
    if (selectedVaultId === vaultId) selectedVaultId = null;
    renderVaultList();
    if (vaults.length > 0) {
      showPanel('dashboard');
      renderDashboard();
    } else {
      showPanel('welcome');
    }
    showToast('Vault removed', 'info');
  } else {
    showToast(res.error ?? 'Failed to remove vault', 'error');
  }
}

async function handleSyncAll(): Promise<void> {
  setButtonLoading(btnSyncAll, true);
  showLoading('Pulling all vaults...');
  try {
    const res = await window.obsync.sync.pullAll();
    if (res.success && res.data) {
      const ok = res.data.filter(r => r.success).length;
      const fail = res.data.length - ok;
      if (fail === 0) {
        showToast(`All ${ok} vault(s) pulled successfully`, 'success');
      } else {
        showToast(`${ok} pulled, ${fail} failed`, 'warning');
      }
      await loadVaults();
      renderDashboard();
    }
  } catch (err) {
    showToast('Failed to pull vaults', 'error');
  } finally {
    setButtonLoading(btnSyncAll, false);
    hideLoading();
  }
}

function toggleSidebar(): void {
  sidebar.classList.toggle('collapsed');
  localStorage.setItem('sidebar-collapsed', sidebar.classList.contains('collapsed') ? '1' : '0');
}

function restoreSidebarState(): void {
  if (localStorage.getItem('sidebar-collapsed') === '1') {
    sidebar.classList.add('collapsed');
  }
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

function showConflictModal(conflicts: Array<{ filePath: string }>): void {
  conflictList.innerHTML = '';
  for (const c of conflicts) {
    const li = document.createElement('li');
    li.textContent = c.filePath;
    conflictList.appendChild(li);
  }
  conflictModal.classList.remove('hidden');
}

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

document.addEventListener('DOMContentLoaded', () => { init(); });
