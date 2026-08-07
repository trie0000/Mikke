// Repository 抽象。sp (本番) / mock (非SPホスト or ?mock=1) を切り替える。
import type { ManagedIssue, ManagedAsset, ResponseHistory, ChangeLogEntry, MikkeSettings, SiteUser, DownloadRecord, SetupResult } from '../types';
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
  /** 完全削除 (リストから行を消す。元に戻せない)。 */
  deleteIssue(id: number): Promise<void>;
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
  /** 資産 (FQDN/IP) の管理部門リスト。 */
  listAssets(): Promise<ManagedAsset[]>;
  /** 脆弱性の対応履歴 (Issue Instance ID で絞り込み)。 */
  listHistory(issueInstanceId: string): Promise<ResponseHistory[]>;
  createHistory(entry: Omit<ResponseHistory, 'id'>): Promise<number>;
  deleteHistory(id: number): Promise<void>;
  /** 管理対象チケットの更新履歴 (Issue Instance ID で絞り込み)。 */
  listChangeLog(issueInstanceId: string): Promise<ChangeLogEntry[]>;
  createChangeLog(entry: Omit<ChangeLogEntry, 'id'>): Promise<number>;
  deleteChangeLog(id: number): Promise<void>;
  /** ある issue の更新履歴を全削除 (一括リセット)。 */
  clearChangeLog(issueInstanceId: string): Promise<void>;
  createAsset(asset: Omit<ManagedAsset, 'id'>): Promise<number>;
  updateAsset(id: number, patch: Partial<ManagedAsset>): Promise<void>;
  deleteAsset(id: number): Promise<void>;
  /** 資産の 特定根拠 / 備考 に貼り付けた画像を添付ファイル化し、絶対 URL を返す。 */
  uploadAssetImage(assetId: number, file: File): Promise<{ url: string }>;
  /** 検査ツールからのダウンロードデータ (種別ごとの zip 記録)。 */
  listDownloads(): Promise<DownloadRecord[]>;
  createDownload(rec: Omit<DownloadRecord, 'id'>): Promise<number>;
  deleteDownload(id: number): Promise<void>;
  /** SP ドキュメントライブラリの <folder>/<fileName> に zip を保存し、サーバ相対 URL を返す。
   *  folder はサイト相対 (例: 'Shared Documents/MikkeDownloads/20260704-120000')。無ければ作成。 */
  uploadDownloadFile(folder: string, fileName: string, data: Blob): Promise<{ url: string }>;
  /** SP のファイルをサーバ相対 URL で削除 (ダウンロードデータの実体削除)。 */
  deleteDocFile(serverRelativeUrl: string): Promise<void>;
  /** 保存済みファイルをブラウザで開く/保存するための href を返す (SP=絶対URL / mock=data URL)。 */
  docFileHref(serverRelativeUrl: string): Promise<string>;
  /** 連携用リストの「Issue Instance ID → 最終更新日時(ISO)」。
   *  一覧の通知ステータス (未通知 / 差分あり / 同期済み) の判定に使う。
   *  リストが未作成なら空の Map。 */
  vulnResponseUpdatedAt(): Promise<Map<string, string>>;
  /** 連携用リストを開く URL (既定ビュー)。まだ無ければ null。
   *  ★ リストの URL は Title から機械的に組めない (作成時の名前が残る / 改名しても
   *    URL は変わらない) ので、必ず SharePoint から実際の URL を取得する。 */
  vulnResponseListUrl(): Promise<string | null>;
  /** 資産管理者への連携用リストを構築する (冪等)。設定画面から明示的に実行する。 */
  ensureVulnResponseList(): Promise<SetupResult>;
  /** 連携用リストの該当アイテム (IssueInstanceId 一致) に個別レポートを添付する。
   *  常に最新 1 つになるよう、同名と previousFileName の添付を消してから追加する。
   *  該当アイテムが無ければ 'no-item'。 */
  attachVulnResponseFile(
    issueInstanceId: string, fileName: string, data: Blob, previousFileName?: string,
  ): Promise<'attached' | 'no-item'>;
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
