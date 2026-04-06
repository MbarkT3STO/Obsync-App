# Migration Guide — Obsync Refactor

## What Changed

### New: Multi-Provider Architecture
The sync engine has been rebuilt around a `SyncProvider` interface.
All providers (GitHub, GitLab, Google Drive, OneDrive, Dropbox, etc.) implement this interface.
The `SyncEngine` only speaks the interface — it has zero imports from any specific provider.

### New: Manifest-based sync for cloud providers
Cloud providers now use a `obsync-manifest.json` file stored alongside vault files.
This enables proper 3-way diffing: local-last vs local-current vs remote.
Previously, cloud providers used timestamp comparison which was unreliable.

### New: TokenStore
Credentials are now stored in `userData/tokens/` as OS-encrypted blobs via `safeStorage`.
The encryption mechanism is unchanged (still `safeStorage`) but the storage location is now
a dedicated directory rather than embedded in the main config JSON.

### New: VaultManager + VaultConfig
New vaults created via the multi-provider UI use `userData/vaults.json`.
The schema includes `providerId`, `providerConfig`, and `syncOptions` per vault.

### New: OAuthManager
OAuth flows now use a random available port (not hardcoded 51730).
The `OAuthManager` stores tokens via `TokenStore` automatically after sign-in.

### New IPC Channels (additive)
| Channel | Description |
|---------|-------------|
| `sync:get-providers` | List all available provider metadata |
| `sync:connect-provider` | Store credentials for a vault+provider |
| `sync:disconnect-provider` | Remove credentials |
| `sync:test-connection` | Ping the remote |
| `sync:get-vault-provider` | Get which provider a vault uses |
| `sync:run` | Full bidirectional sync via new SyncEngine |
| `oauth:start` | Begin OAuth flow |
| `oauth:status` | Poll OAuth completion |
| `vault:list-v2` | List vaults from new VaultManager |
| `vault:add-v2` | Add vault with provider config |
| `vault:update` | Update vault config |
| `vault:remove-v2` | Remove vault + clean up credentials |
| `vault:get` | Get single vault by ID |

## What Was Preserved

### All existing IPC channels
Every channel in the original `ipc-channels.ts` still works:
`sync:push`, `sync:pull`, `sync:status`, `sync:init`, `vault:add`, `vault:remove`,
`cloud:save-config`, `cloud:sign-in`, `history:get`, `autosync:set`, etc.

### All existing services
`StorageService`, `VaultService`, `CloudProviderService`, `GitSyncService`,
`HistoryService`, `OAuthService` — all preserved and unchanged.

### All existing cloud providers
`GoogleDriveCloudProvider`, `DropboxCloudProvider`, `OneDriveCloudProvider`,
`WebDavCloudProvider`, `GitCloudProvider` — all preserved in `src/services/providers/`.

### The renderer (UI)
All HTML, CSS, and JavaScript in `src/renderer/` is completely untouched.
The Glassmorphism design system is preserved.

### Encryption
`crypto.util.ts` using `safeStorage` is preserved. The new `TokenStore` uses the
same `safeStorage` API directly.

## Migration Path for Existing Users

Existing vaults configured via the legacy UI continue to work via the legacy IPC channels.
No data migration is required — `obsync-config.json` is read as before.

To use the new multi-provider features:
1. Add a vault via the new `vault:add-v2` IPC channel
2. Connect a provider via `sync:connect-provider` or `oauth:start`
3. Sync via `sync:run`

Legacy vaults and new vaults coexist without conflict.
