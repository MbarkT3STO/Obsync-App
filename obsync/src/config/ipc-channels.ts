/** All IPC channel names in one place — avoids magic strings */
export const IPC = {
  // Vault
  VAULT_ADD: 'vault:add',
  VAULT_REMOVE: 'vault:remove',
  VAULT_LIST: 'vault:list',
  VAULT_SELECT_FOLDER: 'vault:select-folder',

  // GitHub
  GITHUB_SAVE_CONFIG: 'github:save-config',
  GITHUB_GET_CONFIG: 'github:get-config',
  GITHUB_VALIDATE: 'github:validate',

  // Sync
  SYNC_PUSH: 'sync:push',
  SYNC_PULL: 'sync:pull',
  SYNC_STATUS: 'sync:status',
  SYNC_INIT: 'sync:init',

  // Theme
  THEME_SET: 'theme:set',
  THEME_GET: 'theme:get',

  // Events (main → renderer)
  EVENT_SYNC_PROGRESS: 'event:sync-progress',
  EVENT_SYNC_COMPLETE: 'event:sync-complete',
  EVENT_CONFLICT_DETECTED: 'event:conflict-detected',
} as const;
