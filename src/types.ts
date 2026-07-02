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
  /** between (範囲/期間) の上限値。op='between' のときのみ使用。 */
  value2?: string;
}

export type ConditionOp =
  | 'equals' | 'not_equals'
  | 'contains' | 'not_contains'
  | 'starts_with' | 'in'
  | 'gte' | 'lte' | 'gt' | 'lt'   // 以上 / 以下 / より大 / より小 (数値・日付)
  | 'between';                    // 範囲 / 期間 (value 〜 value2)

/** F7 条件グループ (ネスト可)。 */
export interface ConditionGroup {
  combinator: 'AND' | 'OR';
  rules: (ConditionRule | ConditionGroup)[];
}

/** 管理項目のデータ型 (F6 テンプレ読込で推定)。SP 動的列は Note 保存のまま、
 *  これは表示整形・バリデーション・将来用途のためのメタdata。 */
export type ColumnType = 'text' | 'longtext' | 'number' | 'date' | 'datetime' | 'boolean';

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
  /** F6: 各管理項目の推定データ型 (キー = 列名、Scan_ 接頭辞なし)。 */
  columnTypes?: Record<string, ColumnType>;
  /** 資産管理: 脆弱性 CSV のどの列を資産 (FQDN/IP) とみなすか (既定 'Asset')。
   *  @deprecated assetColumns に移行 (単一→複数)。読み込み時のフォールバックにのみ使う。 */
  assetColumn?: string;
  /** 資産管理: 資産 (FQDN/IP) が入っている列 (複数可。例: FQDN 列 + IP 列)。 */
  assetColumns?: string[];
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

/** 資産 (FQDN / IP 単位) の管理部門情報。SP リスト MikkeAssets の 1 行。 */
export interface ManagedAsset {
  /** SP リスト内部 ID。 */
  id: number;
  /** 正規化済み資産キー (FQDN は小文字、IP はそのまま)。ユニーク。 */
  assetKey: string;
  /** 資産種別。 */
  assetType: 'FQDN' | 'IP';
  /** 事業会社 (基本情報 CSV「組織区分　第１階層名」)。 */
  businessCompany?: string;
  /** 関連会社 (基本情報 CSV「関係会社/事業場略称」)。 */
  affiliateCompany?: string;
  /** Web 資産管理番号 (両 CSV の「管理番号」)。 */
  mgmtNumber?: string;
  /** 特定理由 (CSV 突合 / 手動 等)。 */
  identifyReason?: string;
  /** 特定根拠 (どの情報から特定したか)。 */
  identifyEvidence?: string;
  /** 最終更新日時 (ISO)。 */
  updatedAt?: string;
}

/** 対応履歴のスレッド種別 (外部=顧客/委託先向け, 内部=社内)。 */
export type HistoryThread = 'external' | 'internal';
/** 対応履歴の記録元。 */
export type HistorySource = 'mail' | 'manual' | 'other';

/** 脆弱性の対応履歴 1 件 (カード)。SP リスト MikkeHistory の 1 行。 */
export interface ResponseHistory {
  id: number;
  /** 紐づく脆弱性 (Issue Instance ID)。 */
  issueInstanceId: string;
  /** 外部 / 内部。 */
  thread: HistoryThread;
  /** 記録元 (メール取込 / 手入力ソース / その他)。 */
  source: HistorySource;
  /** 記入者 / 送信者名。 */
  author?: string;
  /** 送信元メールアドレス (メール取込時)。 */
  fromEmail?: string;
  /** 件名 (メール取込時)。 */
  subject?: string;
  /** 本文。 */
  body: string;
  /** 本文が HTML か。 */
  isHtml?: boolean;
  /** 対応日時 (ISO)。メールの送信日時 or 手入力。 */
  occurredAt: string;
  /** SP 登録日時 (ISO)。 */
  createdAt?: string;
  /** SP 登録者。 */
  createdBy?: string;
}

/** メイン画面のビュー。 */
export type ViewName = 'issues' | 'import' | 'assets';
