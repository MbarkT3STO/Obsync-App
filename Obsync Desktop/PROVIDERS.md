# Obsync Provider Setup Guide

This document explains how to set up each sync provider's free developer app.
All OAuth credentials go in your `.env` file (never committed to source control).

---

## Git Providers

Git providers use Personal Access Tokens (PATs). No OAuth app registration needed.

### GitHub
1. Go to https://github.com/settings/tokens → Generate new token (classic)
2. Select scope: `repo` (full control of private repositories)
3. Copy the token — paste it into Obsync when prompted
4. Repo URL format: `https://github.com/username/repo-name.git`

### GitLab
1. Go to https://gitlab.com/-/profile/personal_access_tokens
2. Create token with scopes: `read_repository`, `write_repository`
3. Repo URL format: `https://gitlab.com/username/repo-name.git`

### Bitbucket
1. Go to https://bitbucket.org/account/settings/app-passwords/
2. Create App Password with: Repositories → Read, Write
3. Token format: `username:appPassword` (enter both in the token field)
4. Repo URL format: `https://bitbucket.org/username/repo-name.git`

### Gitea / Codeberg
1. Go to your Gitea instance → Settings → Applications → Generate Token
2. For Codeberg: https://codeberg.org/user/settings/applications
3. Repo URL format: `https://codeberg.org/username/repo-name.git`

---

## Cloud Providers

### Google Drive (15 GB free)

**One-time setup:**
1. Go to https://console.cloud.google.com/
2. Create a new project (or select existing)
3. Enable the **Google Drive API**: APIs & Services → Library → search "Google Drive API" → Enable
4. Configure OAuth consent screen:
   - User Type: External
   - Add your Google account email as a Test User
   - Scopes: `https://www.googleapis.com/auth/drive.file`
5. Create credentials: APIs & Services → Credentials → Create Credentials → OAuth 2.0 Client ID
   - Application type: **Desktop app**
   - Download the JSON — copy `client_id` and `client_secret`
6. Add to `.env`:
   ```
   GOOGLE_CLIENT_ID=your_client_id_here
   GOOGLE_CLIENT_SECRET=your_client_secret_here
   ```

**Notes:**
- The `drive.file` scope only allows access to files Obsync creates — it cannot read your entire Drive.
- Tokens are refreshed automatically before each sync.
- Files are stored under `Obsync/{vaultName}/` in your Drive root.

---

### Microsoft OneDrive (5 GB free)

**One-time setup:**
1. Go to https://portal.azure.com/ → Azure Active Directory → App registrations
2. Click **New registration**:
   - Name: `Obsync`
   - Supported account types: **Accounts in any organizational directory and personal Microsoft accounts (e.g. Skype, Xbox)**
   - Redirect URI: Platform = **Public client/native**, URI = `http://localhost`
3. After creation, go to **API permissions** → Add a permission → Microsoft Graph → Delegated:
   - `Files.ReadWrite`
   - `offline_access`
   - Click **Grant admin consent** (or ask your admin)
4. Go to **Certificates & secrets** → New client secret → copy the value
5. Copy the **Application (client) ID** from the Overview page
6. Add to `.env`:
   ```
   ONEDRIVE_CLIENT_ID=your_application_id_here
   ONEDRIVE_CLIENT_SECRET=your_client_secret_here
   ```

**Notes:**
- Personal Microsoft accounts (Outlook, Hotmail, Xbox) work with this setup.
- Files are stored under `Obsync/{vaultName}/` in your OneDrive root.
- Refresh tokens are long-lived; re-authentication is rarely needed.

---

### Dropbox (2 GB free)

**One-time setup:**
1. Go to https://www.dropbox.com/developers/apps
2. Click **Create app**:
   - API: **Scoped access**
   - Access type: **Full Dropbox**
   - Name: `Obsync`
3. In the app settings, go to **Permissions** tab and enable:
   - `files.content.write`
   - `files.content.read`
   - `files.metadata.write`
   - `files.metadata.read`
   - `account_info.read`
4. In the **Settings** tab, copy **App key** and **App secret**
5. Add to `.env`:
   ```
   DROPBOX_CLIENT_ID=your_app_key_here
   DROPBOX_CLIENT_SECRET=your_app_secret_here
   ```

**Notes:**
- Dropbox uses long-lived refresh tokens — you sign in once.
- Files are stored under `/Obsync/{vaultName}/` in your Dropbox root.
- Chunked upload is used automatically for files over 5 MB.

---

## Security Notes

- All OAuth tokens are encrypted using Electron's `safeStorage` API (OS keychain on macOS/Windows, libsecret on Linux).
- Tokens are never written to plain text files or synced between machines.
- Each machine authenticates independently — this is by design.
- The `.env` file contains only OAuth app credentials (client IDs/secrets), not user tokens.
