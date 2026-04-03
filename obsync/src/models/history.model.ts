export interface CommitEntry {
  hash: string;
  shortHash: string;
  message: string;
  author: string;
  date: string;       // ISO string
  filesChanged: number;
  insertions: number;
  deletions: number;
}

export interface FileDiff {
  filePath: string;
  status: 'added' | 'modified' | 'deleted' | 'conflict';
  localContent: string;
  remoteContent: string;
  hunks: DiffHunk[];
}

export interface DiffHunk {
  header: string;
  lines: DiffLine[];
}

export interface DiffLine {
  type: 'context' | 'added' | 'removed';
  content: string;
  lineNo?: number;
}

export interface AutoSyncConfig {
  enabled: boolean;
  debounceSeconds: number;  // default 30
}
