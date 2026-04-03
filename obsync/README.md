# Obsync

Sync your Obsidian vaults with a private GitHub repository. Built with Electron, TypeScript, and plain HTML/CSS.

---

## Setup

### Prerequisites

- Node.js 18+
- Git installed and on PATH
- A GitHub Personal Access Token (PAT) with `repo` scope

### Install & Run

```bash
cd obsync
npm install
npm start
```

For development with watch mode:

```bash
npm run dev
```

---

## How Sync Works

1. **Add a vault** — point Obsync at your local Obsidian vault folder.
2. **Configure GitHub** — provide your repo URL and PAT. The token is encrypted with AES-256-CBC before being stored locally. It is never sent to the renderer process.
3. **Initialize** — Obsync runs `git init` (if needed) and sets the remote origin.
4. **Push** — stages all changes, commits with a timestamp message, and pushes to your branch.
5. **Pull** — fetches and merges remote changes. If git detects conflicts, Obsync surfaces them in a modal and does NOT auto-resolve.

### Conflict Handling

Obsync detects merge conflicts and notifies you clearly. It will never silently overwrite your local or remote changes. You resolve conflicts manually in your editor, then push again.

---

## Architecture

```
obsync/
├── src/
│   ├── main/           # Electron main process + IPC handler registration
│   ├── preload/        # contextBridge — secure renderer↔main bridge
│   ├── renderer/       # HTML, CSS, TypeScript UI (no frameworks)
│   ├── services/       # StorageService, VaultService, GitHubService, SyncService
│   ├── models/         # TypeScript interfaces (Vault, GitHubConfig, SyncResult…)
│   ├── config/         # App constants, IPC channel names
│   └── utils/          # Logger, crypto (AES-256), ID generation
├── assets/             # Icons, fonts
├── dist/               # Compiled output (gitignored)
└── tsconfig.*.json     # Separate configs for main and renderer
```

### Key Design Decisions

- **Strict TypeScript** throughout — no `any`, no implicit types.
- **Dependency injection** — services receive their dependencies via constructor, making them independently testable.
- **IPC channel registry** (`config/ipc-channels.ts`) — all channel names in one place, no magic strings.
- **Token never touches the renderer** — the preload bridge only exposes `saveConfig` (write-only) and `getConfig` (returns config without the token). Decryption happens exclusively in the main process.
- **Extensible provider model** — `GitHubService` is isolated behind a clear interface. Adding Google Drive or Dropbox means adding a new service and wiring it into `SyncService`.

---

## Security

| Concern | Mitigation |
|---|---|
| Token exposure | Encrypted at rest (AES-256-CBC), never sent to renderer |
| XSS | `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, manual HTML escaping in renderer |
| CSP | Strict Content-Security-Policy header in HTML |
| Unsafe eval | Not used anywhere |

---

## Extending

- **New sync provider**: implement a service with `push/pull/initRepo` methods, inject into `SyncService`.
- **Background sync**: add a `setInterval` or `chokidar` watcher in `main.ts`, call `syncService.push()`.
- **Encryption of vault files**: add an encryption layer in `SyncService` before committing.
- **Multiple accounts**: extend `AppConfig.githubConfigs` to support arrays per vault.
