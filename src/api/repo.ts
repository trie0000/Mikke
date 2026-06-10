// Repository 抽象。sp (本番) / mock (非SPホスト or ?mock=1) を切り替える。
import type { ManagedIssue, MikkeSettings, SiteUser } from '../types';
import type { ImportOp } from '../lib/import';

export interface Repository {
  /** リスト自動作成 (ensureLists 相当)。 */
  ensureLists(): Promise<void>;
  /** 管理対象を全件取得。 */
  listIssues(): Promise<ManagedIssue[]>;
  /** 1 件取得。 */
  getIssue(id: number): Promise<ManagedIssue | null>;
  /** 社内管理項目を更新 (検査ツール由来項目は送らない)。 */
  updateIssue(id: number, patch: Partial<ManagedIssue>): Promise<void>;
  /** 新規追加。 */
  createIssue(issue: Omit<ManagedIssue, 'id'>): Promise<number>;
  /** 設定の取得 / 保存。 */
  getSettings(): Promise<MikkeSettings>;
  saveSettings(s: MikkeSettings): Promise<void>;
  /** ログインユーザー。 */
  getCurrentUser(): Promise<SiteUser | null>;
  /** 取込計画の ops を一括適用 (SP は $batch、mock は逐次)。 */
  applyImportOps(ops: ImportOp[], onProgress?: (done: number, total: number) => void): Promise<{ ok: number; fail: number }>;
  /** F6: 動的列 (Scan_*) を ManagedIssues に遅延作成する。既存はスキップ。 */
  ensureScanColumns(columns: string[]): Promise<void>;
  /** 取込 ops の書き込みに必要だがリストに存在しない列 (SP 列名)。mock は常に []。 */
  findMissingColumns(ops: ImportOp[]): Promise<string[]>;
  /** 不足列を作成する (固定列は既定スキーマ、それ以外 = Scan_* は Note)。 */
  createMissingColumns(cols: string[]): Promise<void>;
  /** 取込履歴を ImportLog に記録する。 */
  writeImportLog(entry: ImportLogEntry): Promise<void>;
}

/** 取込履歴の 1 レコード。 */
export interface ImportLogEntry {
  fileName: string;
  operator: string;
  added: number;
  updated: number;
  undetected: number;
  skipped: number;
  rowCount: number;
  importedAt: string; // ISO
}

let repo: Repository | null = null;
let mode: 'mock' | 'sp' = 'mock';

export function detectMode(): 'mock' | 'sp' {
  const params = new URLSearchParams(location.search);
  if (params.has('mock')) return 'mock';
  if (location.hostname.endsWith('.sharepoint.com')) return 'sp';
  return 'mock';
}

export function getRepoMode(): 'mock' | 'sp' { return mode; }

export function getRepo(): Repository {
  if (!repo) throw new Error('repo not initialized — call initRepo() first');
  return repo;
}

export async function initRepo(): Promise<Repository> {
  mode = detectMode();
  if (mode === 'sp') {
    const { SpRepository } = await import('./sp');
    repo = new SpRepository();
  } else {
    const { MockRepository } = await import('./mock');
    repo = new MockRepository();
  }
  return repo;
}
