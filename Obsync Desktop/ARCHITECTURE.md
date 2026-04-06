# Obsync Architecture

## Sync Flow (end-to-end)

```
User clicks "Sync"
       │
       ▼
IPC Handler (syncHandlers.ts)
  • Loads VaultConfig from VaultManager
  • Loads ProviderCredentials from TokenStore
  • Creates a SyncProvider via ProviderRegistry.createProvider()
  • Calls provider.connect(credentials)
  • Calls SyncEngine.sync(vaultId, vaultPath, provider, deviceId, options)
       │
       ▼
SyncEngine.sync()
  1. ManifestManager.buildFromDisk()     → scan local vault, SHA-256 each file
  2. provider.getRemoteManifest()        → fetch remote manifest (null for git)
  3. ManifestManager.diff()             → 3-way diff: localLast vs localCurrent vs remote
  4. For each file in toUpload:
       fs.readFileSync() → provider.uploadFile()
  5. For each file in toDownload:
       provider.downloadFile() → fs.writeFileSync() (atomic via .tmp rename)
  6. For each conflict:
       ConflictResolver.resolve() → applies ConflictStrategy
  7. For each file in toDeleteRemote:
       provider.deleteRemoteFile()
  8. For each file in toDeleteLocal:
       fs.unlinkSync()
  9. ManifestManager.buildFromDisk()    → rebuild manifest after changes
 10. ManifestManager.saveLocal()        → persist manifest to userData/manifests/
 11. provider.uploadManifest()          → write manifest to remote (cloud only)
       │
       ▼
IPC Handler
  • Calls provider.disconnect()
  • Calls VaultManager.updateLastSync()
  • Sends EVENT_SYNC_COMPLETE to renderer
```

## Key Design Decisions

### SyncProvider Interface
The `SyncProvider` interface is the only contract the `SyncEngine` knows about.
It never imports `GitHubProvider`, `DropboxProvider`, or any concrete class.
This makes adding new providers trivial — implement the interface, register in `ProviderRegistry`.

### Manifest-based sync (cloud providers)
Cloud providers store an `obsync-manifest.json` alongside vault files.
This manifest records the SHA-256 hash, size, and last-modified time of every synced file.
The 3-way diff compares: local-last-known vs local-current vs remote-manifest.

### Git-as-manifest (git providers)
Git providers return `null` from `getRemoteManifest()`.
The `ManifestManager.diff()` treats a null remote as "no prior sync" and uploads everything.
Git history serves as the audit trail; the manifest is only used for the initial push.

### Token security
All credentials are encrypted via Electron's `safeStorage` API (OS keychain).
Tokens are stored in `userData/tokens/{vaultId}_{providerId}.enc`.
They are never written to plain files, localStorage, or the main config JSON.

### Backward compatibility
The legacy `GitSyncService` and all existing IPC channels are fully preserved.
New channels (`sync:run`, `vault:list-v2`, `oauth:start`, etc.) are additive.
The renderer can use either the old or new API — both work simultaneously.

## Directory Structure

```
src/
├── core/
│   ├── SyncEngine.ts          ← orchestrates sync, emits progress events
│   ├── ManifestManager.ts     ← builds manifests, 3-way diff
│   ├── ConflictResolver.ts    ← applies conflict strategies
│   ├── FileHasher.ts          ← SHA-256 utilities
│   └── ObsidianIgnorePatterns.ts ← default ignore list
├── providers/
│   ├── SyncProvider.ts        ← interface (no concrete imports)
│   ├── ProviderRegistry.ts    ← factory + metadata
│   ├── git/
│   │   ├── BaseGitProvider.ts ← common git logic
│   │   ├── GitHubProvider.ts
│   │   ├── GitLabProvider.ts
│   │   ├── BitbucketProvider.ts
│   │   └── GiteaProvider.ts
│   └── cloud/
│       ├── GoogleDriveProvider.ts
│       ├── OneDriveProvider.ts
│       └── DropboxProvider.ts
├── auth/
│   ├── TokenStore.ts          ← safeStorage-backed credential store
│   └── OAuthManager.ts        ← OAuth 2.0 flows via local HTTP server
├── vault/
│   ├── VaultConfig.ts         ← per-vault config schema
│   └── VaultManager.ts        ← CRUD for vault configs
├── ipc/
│   ├── syncHandlers.ts        ← new multi-provider sync IPC
│   ├── vaultHandlers.ts       ← new vault management IPC
│   └── oauthHandlers.ts       ← OAuth flow IPC
├── main/
│   ├── main.ts                ← composition root (wires everything)
│   ├── ipc-handlers.ts        ← legacy IPC (preserved)
│   └── tray.ts
└── services/                  ← legacy services (preserved)
```
