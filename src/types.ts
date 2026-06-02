// Mikke — core data model
// 脆弱性検査ツールの全件CSVから「社内管理対象」を選別し継続トラッキングする。

/** 検知ステータス (取込が自動設定 / メインステータス)。 */
export type DetectionStatus =
  | '新規'        // CSV に初めて追加された
  | '継続'        // 前月も CSV に含まれていた
  | '再検知'      // 一度未検出になったが再び CSV に検出
  | '未検出(New)' // 前月検出・今月未検出 (消えた初月)
  | '未検出';     // 前月も今月も未検出

export const DETECTION_STATUSES: DetectionStatus[] = [
  '新規', '継続', '再検知', '未検出(New)', '未検出',
];

/** 対応ステータス (人が手動設定 / 対応進捗軸)。 */
export type MgmtStatus =
  | '未通知'      // 管理対象化したが未通知 (初期値)
  | '通知'        // 関係者に通知済み
  | '対応中'      // 修正・対処を進めている
  | '対応済み'    // 対処完了
  | 'リスク受容'  // 対処せずリスクを受容
  | '過検出'      // 検査ツールの誤検出
  | '対象外';     // 管理対象から外す

export const MGMT_STATUSES: MgmtStatus[] = [
  '未通知', '通知', '対応中', '対応済み', 'リスク受容', '過検出', '対象外',
];

/** 取込経緯。 */
export type AddedReason = '条件一致' | '個別指定';

/** 管理対象脆弱性 (SP リスト MikkeManagedIssues の 1 行)。 */
export interface ManagedIssue {
  /** SP リスト内部 ID (自動採番)。 */
  id: number;
  /** 表示名 (CSV の脆弱性名等)。 */
  title: string;
  /** 突合キー (CSV 列「Issue Instance ID」)。 */
  issueInstanceId: string;
  /** 検知ステータス (取込が自動設定)。 */
  detectionStatus: DetectionStatus;
  /** 対応ステータス (人が手動設定)。 */
  mgmtStatus: MgmtStatus;
  /** 対象外フラグ (mgmtStatus='対象外' と連動)。 */
  isOutOfScope: boolean;
  /** 対象外の理由。 */
  outOfScopeReason?: string;
  /** 担当者。 */
  assignee?: string;
  /** 対応期限 (ISO)。 */
  dueDate?: string;
  /** 対応メモ。 */
  mgmtNote?: string;
  /** 検査ツール側ステータス (CSV/API 由来、読取専用)。 */
  scannerStatus?: string;
  /** 深刻度 (CSV/API 由来)。 */
  severity?: string;
  /** 初回検出日時 (ISO)。 */
  firstSeen?: string;
  /** 最終検出日時 (ISO)。 */
  lastSeen?: string;
  /** 検知が外れた初回日時 (ISO)。未検出(New) になった日。 */
  firstUndetectedAt?: string;
  /** 取込経緯。 */
  addedReason?: AddedReason;
  /** 最終同期日時 (ISO)。 */
  lastSyncedAt?: string;
  /** 動的列 (F6 でチェックした検査ツール CSV 列。キー = Scan_<列名>)。 */
  scanFields: Record<string, string>;
}

/** F7 条件エンジン: 1 ルール。 */
export interface ConditionRule {
  field: string;   // CSV ヘッダ名
  op: ConditionOp;
  value: string;
}

export type ConditionOp =
  | 'equals' | 'not_equals'
  | 'contains' | 'not_contains'
  | 'starts_with' | 'in';

/** F7 条件グループ (ネスト可)。 */
export interface ConditionGroup {
  combinator: 'AND' | 'OR';
  rules: (ConditionRule | ConditionGroup)[];
}

/** ツール設定 (SP リスト MikkeSettings に JSON で保存)。 */
export interface MikkeSettings {
  /** F6: 取り込む CSV 列 (チェック状態)。 */
  managedColumns: string[];
  /** F7: 管理対象条件。 */
  matchConditions: ConditionGroup | null;
  /** F7: 個別管理対象の Issue Instance ID リスト。 */
  individualIds: string[];
  /** 直近取込 CSV のヘッダ一覧 (F6/F7 の列候補サジェストに使う)。 */
  lastCsvHeaders?: string[];
  /** UI アクセント色 (将来の上書き用)。 */
  accentColor?: string;
}

/** CSV 取込の差分サマリ。 */
export interface ImportSummary {
  added: number;
  updated: number;
  undetected: number;
  skipped: number;
  rowCount: number;
}

/** ログインユーザー (SP /_api/web/currentuser)。 */
export interface SiteUser {
  displayName: string;
  email: string;
}

/** メイン画面のビュー。 */
export type ViewName = 'issues' | 'import';
