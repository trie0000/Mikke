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
