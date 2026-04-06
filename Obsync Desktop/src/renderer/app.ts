/**
 * Renderer process entry point.
 * Pure TypeScript — no frameworks. Communicates with main via window.obsync (contextBridge).
 */

import type { Vault, VaultSyncStatus } from '../models/vault.model';
import type { IpcResponse, AppSettings } from '../models/app-state.model';
import type { CommitEntry, FileDiff, AutoSyncConfig, HealthCheckResult, SyncLockInfo } from '../models/history.model';
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
    healthCheck(vaultId: string): Promise<IpcResponse<HealthCheckResult>>;
    repair(vaultId: string): Promise<IpcResponse<{ message: string }>>;
  };
  cloud: {
    saveConfig(vaultId: string, creds: CloudCredentials): Promise<IpcResponse<void>>;
    getConfig(vaultId: string): Promise<IpcResponse<{ provider: SyncProviderType; meta: Record<string, any>; token?: string }>>;
    validate(creds: CloudCredentials): Promise<IpcResponse<boolean>>;
    signIn(provider: SyncProviderType): Promise<IpcResponse<string>>;
    listVaults(creds: CloudCredentials): Promise<IpcResponse<string[]>>;
  };
  sync: {
    init(vaultId: string): Promise<IpcResponse<void>>;
    push(vaultId: string): Promise<IpcResponse<{ message: string; filesChanged?: number }>>;
    pull(vaultId: string): Promise<IpcResponse<{ message: string }>>;
    pullAll(): Promise<IpcResponse<Array<{ vaultId: string; name: string; success: boolean; message: string }>>>;
    getStatus(vaultId: string): Promise<IpcResponse<VaultSyncStatus>>;
    resolveConflict(vaultId: string, filePath: string, strategy: 'local' | 'cloud' | 'both'): Promise<IpcResponse<void>>;
    acquireLock(vaultId: string): Promise<IpcResponse<{ acquired: boolean; lockInfo?: SyncLockInfo }>>;
    releaseLock(vaultId: string): Promise<IpcResponse<void>>;
    checkLock(vaultId: string): Promise<IpcResponse<SyncLockInfo | null>>;
  };
  history: {
    getCommits(vaultId: string, limit?: number): Promise<IpcResponse<CommitEntry[]>>;
    getFileDiff(vaultId: string, filePath: string): Promise<IpcResponse<FileDiff>>;
    listVersions(vaultId: string, filePath: string): Promise<IpcResponse<Array<{ version: string; timestamp: number; size: number }>>>;
    restoreVersion(vaultId: string, filePath: string, version: string): Promise<IpcResponse<void>>;
    listArchivedFiles(vaultId: string): Promise<IpcResponse<Array<{ relativePath: string; latestTimestamp: number; versionCount: number }>>>;
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
  gitignore: {
    read(vaultId: string): Promise<IpcResponse<string | null>>;
    reset(vaultId: string): Promise<IpcResponse<void>>;
    ensure(vaultId: string): Promise<IpcResponse<{ created: boolean; updated: boolean; addedRules: string[] }>>;
  };
  updater: {
    check(): Promise<IpcResponse<{ upToDate: boolean; version?: string; error?: string; currentVersion: string; lastChecked: string | null }>>;
    install(): Promise<IpcResponse<void>>;
    dismiss(): Promise<IpcResponse<void>>;
    onProgress(cb: (data: { percent: number }) => void): void;
    onReady(cb: (data: { version: string; publishedAt: string }) => void): void;
    offProgress(): void;
    offReady(): void;
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
let currentConflicts: { vaultId: string, files: string[] } | null = null;
// Cache provider per vault so icons can be shown without extra IPC calls
const vaultProviderCache = new Map<string, SyncProviderType>();

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
const inputCloudVaultName = $<HTMLInputElement>('input-cloud-vault-name');
const cloudVaultNameGroup = $('cloud-vault-name-group');
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
const btnConflictLocal = $<HTMLButtonElement>('btn-conflict-local');
const btnConflictCloud = $<HTMLButtonElement>('btn-conflict-cloud');
const btnConflictBoth  = $<HTMLButtonElement>('btn-conflict-both');

const btnHealthCheck  = $<HTMLButtonElement>('btn-health-check');
const healthModal     = $('health-modal');
const healthResults   = $('health-results');
const btnHealthClose  = $<HTMLButtonElement>('btn-health-close');
const btnHealthRecheck = $<HTMLButtonElement>('btn-health-recheck');
const btnHealthRepair = $<HTMLButtonElement>('btn-health-repair');

// About modal
const aboutModal      = $('about-modal');
const btnOpenAbout    = $<HTMLButtonElement>('btn-open-about');
const btnAboutClose   = $<HTMLButtonElement>('btn-about-close');

// ── Confirm Dialog (replaces native confirm()) ────────────────────────────
function showConfirm(message: string, onConfirm: () => void, confirmLabel = 'Confirm', danger = false): void {
  const existing = document.getElementById('confirm-overlay');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'confirm-overlay';
  overlay.className = 'modal-overlay';
  overlay.style.zIndex = '600';
  overlay.innerHTML = `
    <div class="modal" style="max-width:400px">
      <p style="color:var(--text-primary);font-size:14px;line-height:1.6;margin-bottom:20px">${escapeHtml(message)}</p>
      <div class="modal-actions" style="gap:10px;justify-content:flex-end">
        <button class="btn-secondary" id="confirm-cancel">Cancel</button>
        <button class="${danger ? 'btn-danger-outline' : 'btn-primary'}" id="confirm-ok">${escapeHtml(confirmLabel)}</button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  const close = () => overlay.remove();
  overlay.querySelector('#confirm-cancel')!.addEventListener('click', close);
  overlay.querySelector('#confirm-ok')!.addEventListener('click', () => { close(); onConfirm(); });
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

  // Focus the confirm button
  setTimeout(() => (overlay.querySelector('#confirm-ok') as HTMLButtonElement)?.focus(), 50);
}
async function handleConflictResolution(strategy: 'local' | 'cloud' | 'both'): Promise<void> {
  if (!currentConflicts) return;
  const { vaultId, files } = currentConflicts;
  
  showLoading(`Resolving ${files.length} conflict(s)...`);
  for (const filePath of files) {
    await window.obsync.sync.resolveConflict(vaultId, filePath, strategy);
  }
  
  currentConflicts = null;
  conflictModal.classList.add('hidden');
  hideLoading();
  
  // Re-pull to verify sync
  await window.obsync.sync.pull(vaultId);
  showToast('Conflicts resolved and vault pulled', 'success');
}

btnConflictLocal.addEventListener('click', () => handleConflictResolution('local'));
btnConflictCloud.addEventListener('click', () => handleConflictResolution('cloud'));
btnConflictBoth.addEventListener('click', () => handleConflictResolution('both'));

function showConflictModal(vaultId: string, conflicts: Array<{ filePath: string }>): void {
  currentConflicts = { vaultId, files: conflicts.map(c => c.filePath) };
  conflictList.innerHTML = '';

  const diffPreview = document.getElementById('conflict-diff-preview')!;
  const diffViewer  = document.getElementById('conflict-diff-viewer')!;
  const diffPath    = document.getElementById('conflict-diff-path')!;
  diffPreview.classList.add('hidden');

  document.getElementById('btn-conflict-diff-close')?.addEventListener('click', () => {
    diffPreview.classList.add('hidden');
    diffPreview.style.display = '';
  }, { once: false });

  for (const c of conflicts) {
    const li = document.createElement('li');
    li.style.cursor = 'pointer';
    li.style.display = 'flex';
    li.style.alignItems = 'center';
    li.style.justifyContent = 'space-between';
    li.style.gap = '8px';

    const nameSpan = document.createElement('span');
    nameSpan.textContent = c.filePath;
    nameSpan.style.flex = '1';
    nameSpan.style.overflow = 'hidden';
    nameSpan.style.textOverflow = 'ellipsis';
    nameSpan.style.whiteSpace = 'nowrap';

    const previewBtn = document.createElement('button');
    previewBtn.className = 'btn-secondary';
    previewBtn.style.fontSize = '11px';
    previewBtn.style.padding = '3px 8px';
    previewBtn.style.flexShrink = '0';
    previewBtn.textContent = 'View diff';

    previewBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      previewBtn.textContent = 'Loading...';
      previewBtn.disabled = true;

      const res = await window.obsync.history.getFileDiff(vaultId, c.filePath);
      previewBtn.textContent = 'View diff';
      previewBtn.disabled = false;

      if (res.success && res.data) {
        diffPath.textContent = c.filePath;
        diffViewer.innerHTML = '';
        // Reuse the existing renderDiff logic inline
        if (res.data.hunks.length === 0) {
          diffViewer.innerHTML = '<div class="diff-empty">No differences found.</div>';
        } else {
          for (const hunk of res.data.hunks) {
            const hunkHeader = document.createElement('div');
            hunkHeader.className = hunk.header.startsWith('──') ? 'diff-file-header' : 'diff-hunk-header';
            hunkHeader.textContent = hunk.header;
            diffViewer.appendChild(hunkHeader);
            for (const line of hunk.lines) {
              const lineEl = document.createElement('div');
              const isConflict = line.content.startsWith('<<<<<<<') || line.content.startsWith('=======') || line.content.startsWith('>>>>>>>');
              lineEl.className = `diff-line ${line.type}${isConflict ? ' conflict-marker' : ''}`;
              const prefix = line.type === 'added' ? '+' : line.type === 'removed' ? '-' : ' ';
              lineEl.innerHTML = `<span class="diff-line-no">${line.lineNo ?? ''}</span><span class="diff-line-content">${prefix} ${escapeHtml(line.content)}</span>`;
              diffViewer.appendChild(lineEl);
            }
          }
        }
        diffPreview.classList.remove('hidden');
        diffPreview.style.display = 'flex';
      } else {
        showToast('Could not load diff for this file', 'warning');
      }
    });

    li.appendChild(nameSpan);
    li.appendChild(previewBtn);
    conflictList.appendChild(li);
  }
  conflictModal.classList.remove('hidden');
}
const themeDarkBtn    = $<HTMLButtonElement>('theme-dark');
const themeLightBtn   = $<HTMLButtonElement>('theme-light');

// Auto-sync
const autoSyncToggle   = $<HTMLInputElement>('autosync-toggle');
const autoSyncOptions  = $('autosync-options');
const autoSyncDebounce = $<HTMLInputElement>('autosync-debounce');
const autoSyncPoll     = $<HTMLInputElement>('autosync-poll');

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

// Versions modal
const versionsModal     = $('versions-modal');
const versionsList      = $('versions-list');
const versionsFilePath  = $('versions-file-path');
const versionsFileInput = $<HTMLInputElement>('versions-file-input');
const btnVersionsClose  = $<HTMLButtonElement>('btn-versions-close');
const btnShowVersions   = $<HTMLButtonElement>('btn-show-versions');
const btnVersionsLoad   = $<HTMLButtonElement>('btn-versions-load');

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
const inputImportCloudName = $<HTMLInputElement>('import-cloud-name');
const importCloudNameGroup = $('import-cloud-name-group');
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

// Update UI
const updateProgressBar   = $('update-progress-bar');
const updateProgressFill  = $('update-progress-fill');
const updateBanner        = $('update-banner');
const updateBannerSub     = $('update-banner-sub');
const btnUpdateRestart    = $<HTMLButtonElement>('btn-update-restart');
const btnUpdateLater      = $<HTMLButtonElement>('btn-update-later');
const btnCheckUpdates     = $<HTMLButtonElement>('btn-check-updates');
const settingsVersionInfo = $('settings-version-info');
const updateCheckResult   = $('update-check-result');
const updateCheckMsg      = $('update-check-msg');

// Gitignore
const btnGitignoreView    = $<HTMLButtonElement>('btn-gitignore-view');
const btnGitignoreReset   = $<HTMLButtonElement>('btn-gitignore-reset');
const gitignoreModal      = $('gitignore-modal');
const gitignoreContent    = $('gitignore-content');
const gitignoreModalPath  = $('gitignore-modal-path');
const btnGitignoreClose   = $<HTMLButtonElement>('btn-gitignore-close');

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
    inputToken.value = '';
    resetOAuthButton(btnOAuthSignIn);
    updateLabel(val as SyncProviderType, labelRepoUrl, labelBranch, inputRepoUrl, inputBranch, labelToken, inputToken, btnOAuthSignIn);
  });
  importProviderSelect = new CustomSelect('import-dropdown', (val) => {
    currentImportProvider = val as SyncProviderType;
    inputImportToken.value = '';
    resetOAuthButton(btnImportOAuth);
    updateLabel(val as SyncProviderType, importLabelUrl, importLabelBranch, inputImportRepo, inputImportBranch, importLabelToken, inputImportToken, btnImportOAuth);
    // Show cloud vault name field only for non-Git providers
    const m = getProviderMeta(val as SyncProviderType);
    importCloudNameGroup.style.display = m.isGit ? 'none' : '';
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
        branchLabel: 'Username',
        branchPlaceholder: 'Your username',
        hideBranch: false,
        tokenLabel: 'Password / App Token',
        tokenPlaceholder: 'Your WebDAV password',
        useOAuth: false,
        isGit: false,
        hideUrl: false
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

  if (labelToken) {
    if (meta.useOAuth) {
      labelToken.textContent = 'Authentication';
    } else if (meta.tokenLabel) {
      labelToken.textContent = meta.tokenLabel;
    }
  }
  if (inputToken && meta.tokenPlaceholder) {
    inputToken.placeholder = meta.tokenPlaceholder;
  }

  // For OAuth providers, hide the manual token input — user signs in via the button.
  // Hide the .input-with-toggle wrapper if present (main form), otherwise just the input itself.
  if (inputToken) {
    const wrapper = inputToken.closest('.input-with-toggle') as HTMLElement | null;
    const target = wrapper ?? inputToken;
    if (meta.useOAuth) {
      target.style.display = 'none';
    } else {
      target.style.display = '';
    }
  }

  // Show cloud vault name field only for non-Git providers (main config form only)
  if (cloudVaultNameGroup && !meta.isGit) {
    cloudVaultNameGroup.style.display = '';
  } else if (cloudVaultNameGroup) {
    cloudVaultNameGroup.style.display = 'none';
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

  // Show Validate only for git providers — visibility also depends on token value (handled by input event)
  updateValidateVisibility();
}

function updateValidateVisibility(): void {
  const meta = getProviderMeta(currentProvider);
  const hasToken = inputToken.value.trim().length > 0;
  btnValidate.classList.toggle('hidden', !(meta.isGit && hasToken));
}

async function loadTheme(): Promise<void> {
  const res = await window.obsync.theme.get();
  if (res.success && res.data) applyTheme(res.data);
}

async function loadVaults(): Promise<void> {
  const res = await window.obsync.vault.list();
  if (res.success && res.data) {
    vaults = res.data;
    // Populate provider cache for all vaults
    await Promise.all(vaults.map(async (v) => {
      const cfg = await window.obsync.cloud.getConfig(v.id);
      if (cfg.success && cfg.data) vaultProviderCache.set(v.id, cfg.data.provider);
    }));
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
      ${getProviderIcon(vaultProviderCache.get(vault.id), 18).replace('stroke="currentColor"', 'stroke="currentColor" class="item-icon"')}
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
    const { provider, meta, token } = configRes.data;
    providerSelect.setValue(provider);

    if (provider === 'webdav' && token) {
      try {
        const data = JSON.parse(token);
        inputRepoUrl.value = data.url || '';
        inputBranch.value = data.username || '';
      } catch {
        inputRepoUrl.value = meta?.repoUrl || '';
        inputBranch.value = meta?.branch || '';
      }
    } else {
      inputRepoUrl.value = meta?.repoUrl || '';
      inputBranch.value = meta?.branch || 'main';
    }

    // Load cloud vault name for non-Git providers
    inputCloudVaultName.value = meta?.cloudVaultName || '';
    const m = getProviderMeta(provider);
    cloudVaultNameGroup.style.display = m.isGit ? 'none' : '';

    // Update vault icon and provider badge
    vaultProviderCache.set(vaultId, provider);
    updateVaultDetailIcon(provider);
    updateProviderBadge(provider);
  } else {
    providerSelect.setValue('github');
    inputRepoUrl.value = '';
    inputBranch.value = 'main';
    inputCloudVaultName.value = '';
    cloudVaultNameGroup.style.display = 'none';
    updateVaultDetailIcon(null);
    updateProviderBadge(null);
  }
  inputToken.value = '';
  updateValidateVisibility();

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
  inputToken.addEventListener('input', updateValidateVisibility);
  btnRemove.addEventListener('click', handleRemoveVault);
  btnPush.addEventListener('click', handlePush);
  btnPull.addEventListener('click', handlePull);
  btnValidate.addEventListener('click', handleValidate);
  cloudForm.addEventListener('submit', handleSaveConfig);
  themeDarkBtn.addEventListener('click', () => setTheme('dark'));
  themeLightBtn.addEventListener('click', () => setTheme('light'));

  autoSyncToggle.addEventListener('change', handleAutoSyncToggle);
  autoSyncDebounce.addEventListener('change', handleAutoSyncDebounceChange);
  autoSyncPoll.addEventListener('change', handleAutoSyncDebounceChange);

  btnShowHistory.addEventListener('click', handleShowHistory);
  btnHistoryClose.addEventListener('click', () => historyModal.classList.add('hidden'));
  btnDiffClose.addEventListener('click', () => diffModal.classList.add('hidden'));

  btnHealthCheck.addEventListener('click', () => handleHealthCheck());
  btnHealthClose.addEventListener('click', () => healthModal.classList.add('hidden'));
  btnHealthRecheck.addEventListener('click', () => handleHealthCheck());
  btnHealthRepair.addEventListener('click', handleRepairVault);
  healthModal.addEventListener('click', (e) => { if (e.target === healthModal) healthModal.classList.add('hidden'); });

  // About modal
  btnOpenAbout.addEventListener('click', () => aboutModal.classList.remove('hidden'));
  btnAboutClose.addEventListener('click', () => aboutModal.classList.add('hidden'));
  aboutModal.addEventListener('click', (e) => { if (e.target === aboutModal) aboutModal.classList.add('hidden'); });
  document.getElementById('about-link-github')?.addEventListener('click', (e) => {
    e.preventDefault();
    window.open('https://github.com/MbarkT3STO/Obsync-App', '_blank');
  });
  document.getElementById('about-link-website')?.addEventListener('click', (e) => {
    e.preventDefault();
    window.open('https://mbarkt3sto.github.io/obsync', '_blank');
  });

  historyModal.addEventListener('click', (e) => { if (e.target === historyModal) historyModal.classList.add('hidden'); });
  diffModal.addEventListener('click', (e) => { if (e.target === diffModal) diffModal.classList.add('hidden'); });

  btnShowVersions.addEventListener('click', () => {
    versionsModal.classList.remove('hidden');
    versionsFileInput.value = '';
    versionsFilePath.textContent = '';
    handleLoadArchivedFiles();
  });
  btnVersionsClose.addEventListener('click', () => versionsModal.classList.add('hidden'));
  versionsModal.addEventListener('click', (e) => { if (e.target === versionsModal) versionsModal.classList.add('hidden'); });
  btnVersionsLoad.addEventListener('click', () => handleLoadVersions());

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

  // ── Update UI ────────────────────────────────────────────────────────────
  btnUpdateRestart.addEventListener('click', () => window.obsync.updater.install());
  btnUpdateLater.addEventListener('click', () => {
    window.obsync.updater.dismiss();
    updateBanner.classList.add('hidden');
  });
  btnCheckUpdates.addEventListener('click', handleCheckUpdates);

  // ── Gitignore ────────────────────────────────────────────────────────────
  btnGitignoreView.addEventListener('click', handleGitignoreView);
  btnGitignoreReset.addEventListener('click', handleGitignoreReset);
  btnGitignoreClose.addEventListener('click', () => gitignoreModal.classList.add('hidden'));
  gitignoreModal.addEventListener('click', (e) => {
    if (e.target === gitignoreModal) gitignoreModal.classList.add('hidden');
  });

  btnMenuTrigger.addEventListener('click', toggleMobileSidebar);

  btnImportCloud.addEventListener('click', () => {
    importModal.classList.remove('hidden');
    importProviderSelect.setValue('github');
    inputImportRepo.value = '';
    inputImportBranch.value = 'main';
    inputImportToken.value = '';
    inputImportPath.value = '';
    inputImportCloudName.value = '';
    importCloudNameGroup.style.display = 'none';
    resetOAuthButton(btnImportOAuth);
    updateLabel('github', importLabelUrl, importLabelBranch, inputImportRepo, inputImportBranch, importLabelToken, inputImportToken, btnImportOAuth);
  });

  btnImportBrowse.addEventListener('click', async () => {
    const res = await window.obsync.vault.selectFolder();
    if (res.success && res.data) {
      inputImportPath.value = res.data;
    }
  });

  btnImportCancel.addEventListener('click', () => importModal.classList.add('hidden'));
  document.getElementById('btn-import-close-x')?.addEventListener('click', () => importModal.classList.add('hidden'));

  btnImportStart.addEventListener('click', async () => {
    const provider = importProviderSelect.getValue() as SyncProviderType;
    const repoUrl = inputImportRepo.value.trim();
    const branch = inputImportBranch.value.trim() || 'main';
    const token = inputImportToken.value.trim();
    const localPath = inputImportPath.value.trim();
    const cloudVaultName = inputImportCloudName.value.trim();

    const meta = getProviderMeta(provider);

    if (!localPath) {
      showToast('Please choose a local folder', 'error');
      return;
    }
    if (meta.isGit && !repoUrl) {
      showToast('Repository URL is required for Git providers', 'error');
      return;
    }
    if (!token) {
      if (meta.useOAuth) {
        showToast(`Please sign in with ${provider.charAt(0).toUpperCase() + provider.slice(1)} first`, 'warning');
      } else {
        showToast('Access token / password is required', 'error');
      }
      return;
    }

    // Build final token — WebDAV needs JSON-encoded credentials
    let finalToken = token;
    if (provider === 'webdav') {
      finalToken = JSON.stringify({ url: repoUrl, username: branch, password: token });
    }

    setButtonLoading(btnImportStart, true);
    showLoading('Importing vault from cloud...');

    try {
      const res = await window.obsync.vault.clone(localPath, {
        provider,
        token: finalToken,
        meta: { repoUrl, branch, cloudVaultName: cloudVaultName || undefined },
      });
      if (res.success && res.data) {
        showToast('Vault imported successfully', 'success');
        importModal.classList.add('hidden');
        await loadVaults();
        selectVault(res.data.id);
      } else {
        showToast(res.error || 'Failed to import vault', 'error');
      }
    } catch (e) {
      showToast('An unexpected error occurred during import', 'error');
    } finally {
      setButtonLoading(btnImportStart, false);
      hideLoading();
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
    const providerName = provider.charAt(0).toUpperCase() + provider.slice(1);

    setButtonLoading(btn, true);
    try {
      const res = await window.obsync.cloud.signIn(provider as SyncProviderType);
      if (res.success && res.data) {
        tokenInput.value = res.data;
        // Update button to show signed-in state
        const span = btn.querySelector('span');
        if (span) span.textContent = `Signed in to ${providerName} ✓`;
        btn.style.borderColor = 'var(--success)';
        btn.style.color = 'var(--success)';
        showToast(`Signed in to ${providerName} — ready to import`, 'success');
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

  // ── Keyboard shortcuts ─────────────────────────────────────────────────
  document.addEventListener('keydown', (e) => {
    // Escape — close any open modal
    if (e.key === 'Escape') {
      for (const modal of [conflictModal, historyModal, diffModal, versionsModal, importModal, healthModal, aboutModal, gitignoreModal]) {
        if (!modal.classList.contains('hidden')) {
          modal.classList.add('hidden');
          return;
        }
      }
      const confirmOverlay = document.getElementById('confirm-overlay');
      if (confirmOverlay) { confirmOverlay.remove(); return; }
    }

    // Ctrl/Cmd + S — save cloud config when vault panel is visible
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      if (!panelVault.classList.contains('hidden') && selectedVaultId) {
        e.preventDefault();
        cloudForm.dispatchEvent(new Event('submit'));
      }
    }

    // Ctrl/Cmd + P — push current vault
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'P') {
      if (selectedVaultId) { e.preventDefault(); handlePush(); }
    }
  });
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
      let msg = data.result.message;
      if (msg.length > 80) msg = msg.slice(0, 77) + '...';
      showToast(msg, type);
      // Reload vaults then immediately refresh the last-synced display
      loadVaults().then(() => {
        const vault = vaults.find(v => v.id === data.vaultId);
        if (vault) {
          lastSyncedEl.textContent = vault.lastSyncedAt
            ? new Date(vault.lastSyncedAt).toLocaleString()
            : 'Never';
          // Also refresh the dashboard card if visible
          const cardMeta = document.querySelector(`[data-card-status="${data.vaultId}"]`)?.closest('.vault-card')?.querySelector('.vault-card-meta span');
          if (cardMeta && vault.lastSyncedAt) {
            cardMeta.textContent = `Last sync: ${new Date(vault.lastSyncedAt).toLocaleString()}`;
          }
        }
      });
    } else {
      // Background vault — only show toast on error
      if (!data.result.success) {
        const vault = vaults.find(v => v.id === data.vaultId);
        showToast(`${vault?.name ?? 'Vault'}: ${data.result.message}`, 'error');
      }
      // Still refresh vault list so dashboard cards stay current
      loadVaults();
    }
  });

  window.obsync.on.conflictDetected(({ vaultId, conflicts }) => {
    showConflictModal(vaultId, conflicts);
    // Navigate to the vault if not already there
    if (vaultId !== selectedVaultId) selectVault(vaultId);
  });

  // Auto-sync: only show toast if there were actual changes, not on every poll
  window.obsync.on.autoSyncTriggered((data) => {
    if (data.vaultId === selectedVaultId) {
      loadVaults().then(() => {
        const vault = vaults.find(v => v.id === data.vaultId);
        if (vault?.lastSyncedAt) {
          lastSyncedEl.textContent = new Date(vault.lastSyncedAt).toLocaleString();
          const cardMeta = document.querySelector(`[data-card-status="${data.vaultId}"]`)?.closest('.vault-card')?.querySelector('.vault-card-meta span');
          if (cardMeta) cardMeta.textContent = `Last sync: ${new Date(vault.lastSyncedAt).toLocaleString()}`;
        }
      });
    } else {
      // Background vault — refresh dashboard cards silently
      loadVaults();
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

  // ── Update events ────────────────────────────────────────────────────────
  window.obsync.updater.onProgress(({ percent }) => {
    updateProgressBar.classList.remove('hidden');
    updateProgressFill.style.width = `${percent}%`;
    if (percent >= 100) {
      updateProgressFill.classList.remove('shimmer');
    } else {
      updateProgressFill.classList.add('shimmer');
    }
  });

  window.obsync.updater.onReady(({ version }) => {
    updateProgressBar.classList.add('hidden');
    updateProgressFill.style.width = '0%';
    updateBannerSub.textContent = `Obsync v${version} will install on next restart`;
    updateBanner.classList.remove('hidden');
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

  showConfirm(
    `Remove "${vault.name}" from Obsync? Your local files won't be deleted.`,
    async () => {
      const res = await window.obsync.vault.remove(selectedVaultId!);
      if (res.success) {
        vaults = vaults.filter(v => v.id !== selectedVaultId);
        selectedVaultId = null;
        renderVaultList();
        if (vaults.length > 0) { showPanel('dashboard'); renderDashboard(); }
        else showPanel('welcome');
        showToast('Vault removed', 'info');
      } else {
        showToast(res.error ?? 'Failed to remove vault', 'error');
      }
    },
    'Remove',
    true,
  );
}

async function handlePush(): Promise<void> {
  if (!selectedVaultId) return;
  btnPush.classList.add('syncing');
  btnPush.disabled = true;
  const res = await window.obsync.sync.push(selectedVaultId);
  btnPush.classList.remove('syncing');
  btnPush.disabled = false;
  if (res.success) refreshLastSynced(selectedVaultId);
  else showToast(res.error ?? 'Push failed', 'error');
}

async function handlePull(): Promise<void> {
  if (!selectedVaultId) return;
  btnPull.classList.add('syncing');
  btnPull.disabled = true;
  const res = await window.obsync.sync.pull(selectedVaultId);
  btnPull.classList.remove('syncing');
  btnPull.disabled = false;
  if (res.success) refreshLastSynced(selectedVaultId);
  else if (!res.data) showToast(res.error ?? 'Pull failed', 'error');
}

/** Re-fetches the vault list and updates the last-synced label for a specific vault. */
async function refreshLastSynced(vaultId: string): Promise<void> {
  await loadVaults();
  const vault = vaults.find(v => v.id === vaultId);
  if (!vault) return;
  if (vaultId === selectedVaultId) {
    lastSyncedEl.textContent = vault.lastSyncedAt
      ? new Date(vault.lastSyncedAt).toLocaleString()
      : 'Never';
  }
  const cardMeta = document.querySelector(`[data-card-status="${vaultId}"]`)?.closest('.vault-card')?.querySelector('.vault-card-meta span');
  if (cardMeta && vault.lastSyncedAt) {
    cardMeta.textContent = `Last sync: ${new Date(vault.lastSyncedAt).toLocaleString()}`;
  }
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

  let finalToken = token;
  if (provider === 'webdav') {
    finalToken = JSON.stringify({ url: repoUrl, username: branch, password: token });
  }

  setButtonLoading(btnValidate, true);
  const res = await window.obsync.cloud.validate({ 
    provider, 
    token: finalToken, 
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
  const cloudVaultName = inputCloudVaultName.value.trim();

  const meta = getProviderMeta(provider);

  if (meta.isGit && !repoUrl) {
    showToast('Error: Repository URL is mandatory for Git providers.', 'warning');
    return;
  }

  if (!token && !meta.useOAuth) {
    showToast('Access token / password is required', 'warning');
    return;
  }

  // For OAuth providers, token may already be stored — only require it if not yet saved
  if (meta.useOAuth && !token) {
    // Check if there's already a saved token
    const existing = await window.obsync.cloud.getConfig(selectedVaultId);
    if (!existing.success) {
      showToast(`Please sign in with ${provider} first`, 'warning');
      return;
    }
    // Use existing token — don't overwrite with empty
  }

  setButtonLoading(btnSaveConfig, true);

  let finalToken = token;
  if (provider === 'webdav') {
    finalToken = JSON.stringify({ url: repoUrl, username: branch, password: token });
  }

  // Build meta — include cloudVaultName for non-Git providers
  const saveMeta: Record<string, any> = { repoUrl, branch };
  if (!meta.isGit && cloudVaultName) {
    saveMeta['cloudVaultName'] = cloudVaultName;
  }

  // Only save if we have a token (don't overwrite existing token with empty)
  if (finalToken) {
    const saveRes = await window.obsync.cloud.saveConfig(selectedVaultId, {
      provider,
      token: finalToken,
      meta: saveMeta,
    });
    if (!saveRes.success) {
      showToast(saveRes.error ?? 'Failed to save config', 'error');
      setButtonLoading(btnSaveConfig, false);
      return;
    }
  } else {
    // Update meta only (token unchanged) — re-save with existing token
    const existing = await window.obsync.cloud.getConfig(selectedVaultId);
    if (existing.success) {
      await window.obsync.cloud.saveConfig(selectedVaultId, {
        provider,
        token: '__keep_existing__', // signal to backend to keep existing token
        meta: saveMeta,
      });
    }
  }

  const initRes = await window.obsync.sync.init(selectedVaultId);
  setButtonLoading(btnSaveConfig, false);

  if (initRes.success) {
    showToast('Configuration saved', 'success');
    inputToken.value = '';
    updateValidateVisibility();
    // Update provider cache and icon immediately
    vaultProviderCache.set(selectedVaultId, provider);
    updateVaultDetailIcon(provider);
    updateProviderBadge(provider);
    renderVaultList(); // refresh sidebar icons
  } else {
    showToast(initRes.error ?? 'Saved config but init failed', 'warning');
  }
}

async function loadAutoSyncConfig(vaultId: string): Promise<void> {
  const res = await window.obsync.autoSync.get(vaultId);
  if (res.success && res.data) {
    autoSyncToggle.checked = res.data.enabled;
    autoSyncDebounce.value = String(res.data.debounceSeconds ?? 5);
    autoSyncPoll.value = String(res.data.pollSeconds ?? 120);
    autoSyncOptions.classList.toggle('hidden', !res.data.enabled);
  }
}

async function handleAutoSyncToggle(): Promise<void> {
  if (!selectedVaultId) return;
  const enabled = autoSyncToggle.checked;
  const debounceSeconds = parseInt(autoSyncDebounce.value, 10) || 5;
  const pollSeconds = parseInt(autoSyncPoll.value, 10) || 120;
  autoSyncOptions.classList.toggle('hidden', !enabled);
  await window.obsync.autoSync.set(selectedVaultId, { enabled, debounceSeconds, pollSeconds });
  showToast(enabled ? `Auto-sync enabled` : 'Auto-sync disabled', 'info');
}

async function handleAutoSyncDebounceChange(): Promise<void> {
  if (!selectedVaultId || !autoSyncToggle.checked) return;
  const debounceSeconds = parseInt(autoSyncDebounce.value, 10) || 5;
  const pollSeconds = parseInt(autoSyncPoll.value, 10) || 120;
  await window.obsync.autoSync.set(selectedVaultId, { enabled: true, debounceSeconds, pollSeconds });
}

async function handleShowHistory(): Promise<void> {
  if (!selectedVaultId) return;
  const vault = vaults.find(v => v.id === selectedVaultId);
  const titleEl = document.getElementById('history-title');
  if (titleEl) titleEl.textContent = vault ? `History — ${vault.name}` : 'Sync History';
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

    // Click to show diff for this commit
    item.addEventListener('click', () => {
      if (selectedVaultId) {
        historyModal.classList.add('hidden');
        handleShowDiff(selectedVaultId, commit.hash);
      }
    });
    item.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && selectedVaultId) {
        historyModal.classList.add('hidden');
        handleShowDiff(selectedVaultId, commit.hash);
      }
    });

    historyList.appendChild(item);
  }
}

async function handleShowDiff(vaultId: string, filePathOrHash: string): Promise<void> {
  // Show short hash while loading
  const isHash = /^[a-f0-9]{7,40}$/.test(filePathOrHash.trim());
  diffFilePath.textContent = isHash ? filePathOrHash.slice(0, 7) : filePathOrHash;
  diffViewer.innerHTML = '<div class="diff-empty">Loading diff...</div>';
  diffModal.classList.remove('hidden');

  const res = await window.obsync.history.getFileDiff(vaultId, filePathOrHash);
  if (!res.success || !res.data) {
    diffViewer.innerHTML = '<div class="diff-empty">Could not load diff for this file.</div>';
    return;
  }

  // Use the commit message (returned as filePath for commit diffs) as the title
  diffFilePath.textContent = res.data.filePath || filePathOrHash;
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
    // File section headers (── filename ──) get a distinct style
    const isFileHeader = hunk.header.startsWith('──');
    hunkHeader.className = isFileHeader ? 'diff-file-header' : 'diff-hunk-header';
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

  // Populate version info
  const verRes = await window.obsync.updater.check().catch(() => null);
  if (verRes?.success && verRes.data) {
    const { currentVersion, lastChecked } = verRes.data;
    const checkedStr = lastChecked
      ? ` · Last checked: ${new Date(lastChecked).toLocaleString()}`
      : '';
    settingsVersionInfo.textContent = `v${currentVersion}${checkedStr}`;
  }

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
          ${getProviderIcon(vaultProviderCache.get(vault.id), 20)}
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

  showConfirm(
    `Remove "${vault.name}" from Obsync? Your local files won't be deleted.`,
    async () => {
      showLoading('Removing vault...');
      const res = await window.obsync.vault.remove(vaultId);
      hideLoading();
      if (res.success) {
        vaults = vaults.filter(v => v.id !== vaultId);
        if (selectedVaultId === vaultId) selectedVaultId = null;
        renderVaultList();
        if (vaults.length > 0) { showPanel('dashboard'); renderDashboard(); }
        else showPanel('welcome');
        showToast('Vault removed', 'info');
      } else {
        showToast(res.error ?? 'Failed to remove vault', 'error');
      }
    },
    'Remove',
    true,
  );
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

async function handleHealthCheck(): Promise<void> {
  if (!selectedVaultId) return;
  healthModal.classList.remove('hidden');
  healthResults.innerHTML = '<div class="history-loading">Running checks...</div>';
  btnHealthRepair.classList.add('hidden');

  const res = await window.obsync.vault.healthCheck(selectedVaultId);
  if (!res.success || !res.data) {
    healthResults.innerHTML = '<div class="history-empty">Could not run health check.</div>';
    return;
  }

  const { healthy, issues, repairable } = res.data;
  healthResults.innerHTML = '';

  if (healthy && issues.length === 0) {
    healthResults.innerHTML = `
      <div style="display:flex;align-items:center;gap:10px;padding:16px;color:var(--success)">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="20" height="20">
          <polyline points="20 6 9 17 4 12"/>
        </svg>
        <span>All checks passed — vault is healthy.</span>
      </div>`;
    return;
  }

  for (const issue of issues) {
    const row = document.createElement('div');
    const isError = issue.severity === 'error';
    row.style.cssText = `display:flex;align-items:flex-start;gap:10px;padding:10px 12px;border-radius:8px;margin-bottom:8px;background:${isError ? 'rgba(239,68,68,0.08)' : 'rgba(234,179,8,0.08)'};border:1px solid ${isError ? 'rgba(239,68,68,0.25)' : 'rgba(234,179,8,0.25)'}`;
    row.innerHTML = `
      <svg viewBox="0 0 24 24" fill="none" stroke="${isError ? '#ef4444' : '#eab308'}" stroke-width="2" width="16" height="16" style="flex-shrink:0;margin-top:2px">
        ${isError
          ? '<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>'
          : '<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>'}
      </svg>
      <div>
        <div style="font-size:13px;font-weight:500;color:var(--text-primary)">${escapeHtml(issue.message)}</div>
        <div style="font-size:11px;color:var(--text-secondary);margin-top:2px">Code: ${escapeHtml(issue.code)}</div>
      </div>`;
    healthResults.appendChild(row);
  }

  if (repairable) {
    btnHealthRepair.classList.remove('hidden');
  }
}

async function handleRepairVault(): Promise<void> {
  if (!selectedVaultId) return;
  setButtonLoading(btnHealthRepair, true);
  const res = await window.obsync.vault.repair(selectedVaultId);
  setButtonLoading(btnHealthRepair, false);
  if (res.success) {
    showToast('Vault repaired successfully', 'success');
    await handleHealthCheck(); // re-run checks
  } else {
    showToast(res.error ?? 'Repair failed', 'error');
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
  document.body.classList.toggle('theme-light', theme === 'light');
  themeDarkBtn.classList.toggle('active', theme === 'dark');
  themeLightBtn.classList.toggle('active', theme === 'light');
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

  const dismiss = () => {
    toast.classList.add('toast-fade-out');
    toast.addEventListener('animationend', () => toast.remove(), { once: true });
  };
  toast.addEventListener('click', dismiss);

  const duration = type === 'error' ? 5000 : type === 'success' ? 2500 : 3500;
  setTimeout(dismiss, duration);
}

function toggleTokenVisibility(): void {
  inputToken.type = inputToken.type === 'password' ? 'text' : 'password';
}

function resetOAuthButton(btn: HTMLButtonElement): void {
  const span = btn.querySelector('span');
  if (span) span.textContent = 'Sign in with Provider';
  btn.style.borderColor = '';
  btn.style.color = '';
}

const PROVIDER_LABELS: Record<string, string> = {
  github: 'GitHub', gitlab: 'GitLab', bitbucket: 'Bitbucket', 'git-custom': 'Git',
  dropbox: 'Dropbox', googledrive: 'Google Drive', onedrive: 'OneDrive',
  webdav: 'WebDAV',
};

// Provider SVG icons — inline so no external deps needed
function getProviderIcon(provider: SyncProviderType | null | undefined, size = 20): string {
  const s = `width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"`;
  switch (provider) {
    case 'github':
      return `<svg ${s}><path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22"/></svg>`;
    case 'gitlab':
      return `<svg ${s}><path d="M22.65 14.39L12 22.13 1.35 14.39a.84.84 0 0 1-.3-.94l1.22-3.72 3.11-9.48a.84.84 0 0 1 1.59 0l3.03 9.24h4l3.03-9.24a.84.84 0 0 1 1.59 0l3.11 9.48 1.22 3.72a.84.84 0 0 1-.3.94z"/></svg>`;
    case 'bitbucket':
      return `<svg ${s}><path d="M4 3h16l2 11-10 7-10-7 2-11z"/><path d="M12 3v18"/></svg>`;
    case 'git-custom':
      return `<svg ${s}><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>`;
    case 'dropbox':
      return `<svg ${s}><path d="M21 8l-9-6-9 6 9 6 9-6zM3 8v8l9 6 9-6V8L12 14 3 8z"/></svg>`;
    case 'googledrive':
      return `<svg ${s}><path d="M12 2L2 19h20L12 2z"/></svg>`;
    case 'onedrive':
      return `<svg ${s}><path d="M17.5 19a5.5 5.5 0 0 0 0-11c-.13 0-.25.01-.38.02A7 7 0 1 0 5 13.5c0 .12.01.24.02.36A4.5 4.5 0 0 0 6.5 23h11a5.5 5.5 0 0 0 0-11"/></svg>`;
    case 'webdav':
      return `<svg ${s}><rect x="2" y="2" width="20" height="8" rx="2"/><rect x="2" y="14" width="20" height="8" rx="2"/><line x1="6" y1="6" x2="6.01" y2="6"/><line x1="6" y1="18" x2="6.01" y2="18"/></svg>`;
    default:
      return `<svg ${s}><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>`;
  }
}

function updateProviderBadge(provider: SyncProviderType | null): void {
  let badge = document.getElementById('provider-badge');
  if (!badge) {
    badge = document.createElement('span');
    badge.id = 'provider-badge';
    badge.className = 'provider-badge';
    const meta = document.querySelector('.vault-meta');
    if (meta) meta.appendChild(badge);
  }
  if (provider) {
    badge.textContent = PROVIDER_LABELS[provider] ?? provider;
    badge.style.display = '';
  } else {
    badge.style.display = 'none';
  }
}

function updateVaultDetailIcon(provider: SyncProviderType | null | undefined): void {
  const iconContainer = document.querySelector('.vault-icon') as HTMLElement | null;
  if (!iconContainer) return;
  iconContainer.innerHTML = getProviderIcon(provider, 22);
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

// ── Update handlers ────────────────────────────────────────────────────────

async function handleCheckUpdates(): Promise<void> {
  setButtonLoading(btnCheckUpdates, true);
  updateCheckResult.classList.add('hidden');

  const res = await window.obsync.updater.check();
  setButtonLoading(btnCheckUpdates, false);
  updateCheckResult.classList.remove('hidden');

  if (!res.success) {
    updateCheckMsg.textContent = `Check failed — ${res.error ?? 'unknown error'}`;
    updateCheckMsg.style.color = 'var(--danger)';
    return;
  }

  const d = res.data!;
  const checkedAt = d.lastChecked ? new Date(d.lastChecked).toLocaleTimeString() : '';

  if (d.upToDate) {
    updateCheckMsg.textContent = `Up to date ✓  (v${d.currentVersion}${checkedAt ? ` · checked ${checkedAt}` : ''})`;
    updateCheckMsg.style.color = 'var(--success)';
  } else if (d.error) {
    updateCheckMsg.textContent = `Check failed — ${d.error}`;
    updateCheckMsg.style.color = 'var(--danger)';
  } else {
    updateCheckMsg.textContent = `v${d.version} available — downloading in background…`;
    updateCheckMsg.style.color = 'var(--accent-light)';
  }
}

// ── Gitignore handlers ─────────────────────────────────────────────────────

async function handleGitignoreView(): Promise<void> {
  if (!selectedVaultId) return;
  const vault = vaults.find(v => v.id === selectedVaultId);
  gitignoreModalPath.textContent = vault ? `${vault.localPath}/.gitignore` : '';
  gitignoreContent.textContent = 'Loading…';
  gitignoreModal.classList.remove('hidden');

  const res = await window.obsync.gitignore.read(selectedVaultId);
  if (res.success && res.data) {
    gitignoreContent.textContent = res.data;
  } else if (res.success && res.data === null) {
    gitignoreContent.textContent = '(no .gitignore found — click Reset to create one)';
  } else {
    gitignoreContent.textContent = `Error: ${res.error ?? 'could not read file'}`;
  }
}

async function handleGitignoreReset(): Promise<void> {
  if (!selectedVaultId) return;
  showConfirm(
    'Reset .gitignore to Obsync defaults? Your custom rules below the auto-generated section will be lost.',
    async () => {
      const res = await window.obsync.gitignore.reset(selectedVaultId!);
      if (res.success) {
        showToast('.gitignore reset to defaults', 'success');
      } else {
        showToast(res.error ?? 'Reset failed', 'error');
      }
    },
    'Reset',
    true,
  );
}

// ── Archived files / versions ──────────────────────────────────────────────

async function handleLoadArchivedFiles(): Promise<void> {
  if (!selectedVaultId) return;
  versionsList.innerHTML = '<div class="history-loading">Loading archived files...</div>';
  versionsFilePath.textContent = '';

  const res = await window.obsync.history.listArchivedFiles(selectedVaultId);
  if (!res.success || !res.data || res.data.length === 0) {
    versionsList.innerHTML = '<div class="history-empty">No archived versions found. Files deleted during sync are saved here automatically.</div>';
    return;
  }

  versionsList.innerHTML = '';
  for (const file of res.data) {
    const item = document.createElement('div');
    item.className = 'commit-item';
    item.style.cursor = 'pointer';
    const date = new Date(file.latestTimestamp).toLocaleString();
    item.innerHTML = `
      <div class="commit-body" style="flex:1">
        <div class="commit-message">${escapeHtml(file.relativePath)}</div>
        <div class="commit-meta">
          <span>${file.versionCount} version${file.versionCount !== 1 ? 's' : ''}</span>
          <span>Latest: ${escapeHtml(date)}</span>
        </div>
      </div>
      <button class="btn-secondary" style="font-size:12px;padding:6px 12px">View versions</button>
    `;
    item.querySelector('button')!.addEventListener('click', () => {
      versionsFileInput.value = file.relativePath;
      handleLoadVersions();
    });
    versionsList.appendChild(item);
  }
}

async function handleLoadVersions(): Promise<void> {
  if (!selectedVaultId) return;
  const filePath = versionsFileInput.value.trim();
  if (!filePath) {
    showToast('Enter a file path', 'warning');
    return;
  }

  versionsFilePath.textContent = filePath;
  versionsList.innerHTML = '<div class="history-loading">Loading versions...</div>';

  const res = await window.obsync.history.listVersions(selectedVaultId, filePath);
  if (!res.success || !res.data || res.data.length === 0) {
    versionsList.innerHTML = `
      <div style="display:flex;flex-direction:column;gap:12px">
        <div class="history-empty">No archived versions found for this file.</div>
        <button class="btn-secondary" id="btn-versions-back" style="align-self:flex-start">← Back to all files</button>
      </div>`;
    document.getElementById('btn-versions-back')?.addEventListener('click', handleLoadArchivedFiles);
    return;
  }

  versionsList.innerHTML = `<button class="btn-secondary" id="btn-versions-back" style="margin-bottom:12px;align-self:flex-start">← Back to all files</button>`;
  document.getElementById('btn-versions-back')?.addEventListener('click', handleLoadArchivedFiles);

  for (const v of res.data) {
    const item = document.createElement('div');
    item.className = 'commit-item';
    const date = new Date(v.timestamp).toLocaleString();
    const sizeKb = (v.size / 1024).toFixed(1);
    item.innerHTML = `
      <span class="commit-hash">${escapeHtml(date)}</span>
      <div class="commit-body">
        <div class="commit-message">${escapeHtml(v.version)}</div>
        <div class="commit-meta"><span>${sizeKb} KB</span></div>
      </div>
      <button class="btn-secondary" style="font-size:12px;padding:6px 12px" data-version="${escapeHtml(v.version)}">Restore</button>
    `;
    const restoreBtn = item.querySelector('button[data-version]') as HTMLButtonElement;
    restoreBtn.addEventListener('click', async () => {
      showConfirm(
        `Restore "${filePath}" to version from ${date}? The current version will be archived.`,
        async () => {
          restoreBtn.disabled = true;
          restoreBtn.textContent = 'Restoring...';
          const r = await window.obsync.history.restoreVersion(selectedVaultId!, filePath, v.version);
          if (r.success) {
            showToast(`Restored to ${date}`, 'success');
            versionsModal.classList.add('hidden');
          } else {
            showToast(r.error ?? 'Restore failed', 'error');
            restoreBtn.disabled = false;
            restoreBtn.textContent = 'Restore';
          }
        },
        'Restore',
      );
    });
    versionsList.appendChild(item);
  }
}

document.addEventListener('DOMContentLoaded', () => { init(); });
