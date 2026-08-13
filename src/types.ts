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

/** 対応ステータス (対応の進捗軸)。連携用リストの「対応状況」と同じ 6 値。
 *  ★ 「通知したかどうか」はこの軸では持たない。連携用リストとの比較で出す
 *    「通知」列 (未通知 / 差分あり / 同期済み) が担当する (lib/notifyStatus.ts)。 */
export type MgmtStatus =
  | '未着手'      // 着手前 (初期値)
  | '対応中'      // 修正・対処を進めている
  | '対応済み'    // 対処完了
  | 'リスク受容'  // 対処せずリスクを受容
  | '過検出'      // 検査ツールの誤検出
  | '対象外';     // 管理対象から外す

export const MGMT_STATUSES: MgmtStatus[] = [
  '未着手', '対応中', '対応済み', 'リスク受容', '過検出', '対象外',
];

/** 対応ステータスの既定値 (取込時・値が読めないとき)。 */
export const DEFAULT_MGMT_STATUS: MgmtStatus = '未着手';

/** 旧値 ('未通知' / '通知') を現行の選択肢に寄せる。
 *  ★ 通知の有無は「通知」列に移したので、旧値はどちらも「未着手」に畳む。
 *    SP に残っている既存データを読んだときに落ちないようにするための互換処理。 */
export function normalizeMgmtStatus(v: unknown): MgmtStatus {
  const s = String(v ?? '').trim();
  if ((MGMT_STATUSES as string[]).includes(s)) return s as MgmtStatus;
  return DEFAULT_MGMT_STATUS;   // '未通知' / '通知' / 空 / 未知の値
}

/** 取込経緯。 */
export type AddedReason = '条件一致' | '個別指定';

/** 脆弱性タイプ。Title から自動判定する (設定の判定条件)。 */
export type VulnType = '脆弱性' | 'ポート' | '管理画面';
export const VULN_TYPES: VulnType[] = ['脆弱性', 'ポート', '管理画面'];

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
  /** 外部接続申請ID (利用者側の申請番号。人が入力)。
   *  管理系 ID の 1 つ。Issue Instance ID / Web資産管理ID と並ぶ。 */
  extConnAppId?: string;
  /** 旧管理番号 (Excel 運用時代の「事業会社名-YYMM-XX」)。
   *  ★ 将来廃止する暫定 ID。移行期間中だけ参考情報として持つ。 */
  legacyMgmtNumber?: string;
  /** 事業会社。アクセス権画面で登録した一覧から選ぶ。
   *  ★ 未設定なら資産リスト側の値を使う (連携用リストへ渡すときのフォールバック)。 */
  businessCompany?: string;
  /** 管理会社。 */
  affiliateCompany?: string;
  /** WebMAPS 管理ID (A/B + 数字6桁)。移行データから抽出して入れる。
   *  未設定なら資産リストの管理番号を使う。 */
  webMapsId?: string;
  /** 事業会社特定の根拠。 */
  identifyEvidence?: string;
  /** 対応計画。 */
  responsePlan?: string;
  /** 申請不要理由。 */
  noAppReason?: string;
  /** 脆弱性タイプ。Title から自動判定する (設定の判定条件)。 */
  vulnType?: VulnType;
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
  /** 個別レポートの SP 上の URL。「情報更新」で 1 件ずつ取得したもの。
   *  形式は検査ツールが返したまま (現状 PDF)。Mikke は再圧縮もリネームもしない。 */
  reportUrl?: string;
  /** 個別レポートのファイル名 (検査ツールが付けた名前のまま)。 */
  reportName?: string;
  /** 個別レポートの取得日時 (ISO)。 */
  reportAt?: string;
  /** SharePoint 上の最終更新日時 (ISO)。連携用リストとの差分判定に使う。 */
  updatedAt?: string;
  /** 連携用リストで資産管理者が書いた対応経緯 (HTML)。Mikke 側のメモとは別に保持する。 */
  responseNote?: string;
  /** 連携用リストで資産管理者が書いた備考。 */
  responseRemarks?: string;
  /** 連携用リストの内容を取り込んだ日時 (ISO)。 */
  responseSyncedAt?: string;
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
  /** ダウンロードデータ: SP ドキュメントライブラリ上の保存先フォルダ (サイト相対パス。
   *  例: 'Shared Documents/MikkeDownloads')。取得時に日時サブフォルダを掘って zip を置く。 */
  downloadFolder?: string;
  /** UI アクセント色 (将来の上書き用)。 */
  accentColor?: string;
  /** 連携用リストのアイテム単位アクセス権 (管理者グループ / 事業会社ごとの割当)。
   *  実体は lib/itemPerms.ts の VulnResponsePerms。JSON でそのまま保持する。 */
  vulnResponsePerms?: {
    adminGroupIds: number[];
    byBusinessCompany: Record<string, number[]>;
    /** 事業会社名 → 略称 (移行データはこの略称で書かれている)。複数可。 */
    aliasesByCompany?: Record<string, string[]>;
  };
  /** 脆弱性タイプの判定条件。Title に含まれる文字列で判定する (OR)。
   *  どれにも当たらなければ「脆弱性」。 */
  vulnTypeRules?: { port: string[]; admin: string[] };
}

/** 検査ツールから一括ダウンロードする対象の種別。
 *  'merged' は取得後に relay 側で生成する「脆弱性＋資産のマージ CSV」(取込に使う)。 */
export type DownloadType = 'vuln' | 'ip' | 'iprange' | 'domain' | 'cert' | 'webapps' | 'merged';

/** ダウンロードデータ 1 件 (種別ごと)。SP リスト MikkeDownloads の 1 行。 */
export interface DownloadRecord {
  id: number;
  /** 種別 (脆弱性 / IP / IP Range / Domain / Cert / WebAPPS)。 */
  type: DownloadType;
  /** Mikke が SP に保存した日時 (ISO。表では JST 表示)。 */
  downloadedAt: string;
  /** 検査ツール側でエクスポートされた日時 (アダプタが返す。ISO 文字列)。 */
  scannerDownloadTime?: string;
  /** 保存した zip のファイル名 (例: vuln.zip)。 */
  fileName: string;
  /** 保存先フォルダ (サイト相対。日時サブフォルダ込み)。 */
  folder: string;
  /** zip のサーバ相対 URL (ダウンロード/削除に使う)。 */
  fileUrl: string;
  /** 元データの件数 (任意・参考表示)。 */
  itemCount?: number;
}

/** CSV 取込の差分サマリ。 */
export interface ImportSummary {
  added: number;
  updated: number;
  undetected: number;
  skipped: number;
  rowCount: number;
}

/** リスト構築の 1 工程の結果。 */
export interface SetupStep {
  /** 工程の種別 (例: 'リスト' / '列' / '表示名' / 'フォーム書式設定')。 */
  category: string;
  /** 対象 (リスト名 / 内部名 など)。 */
  target: string;
  outcome: 'created' | 'updated' | 'skipped' | 'failed';
  detail?: string;
}

/** リスト構築の実行結果 (工程ごとの 作成/更新/スキップ/失敗 の集計)。 */
export interface SetupResult {
  steps: SetupStep[];
  counts: { created: number; updated: number; skipped: number; failed: number };
  /** 作成したリストを開く URL (mock では空)。 */
  listUrl: string;
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
  /** 特定根拠 (どの情報から特定したか。旧「特定理由」を統合)。画像貼付可の HTML。 */
  identifyEvidence?: string;
  /** 備考 (自由記入)。画像貼付可の HTML。 */
  remarks?: string;
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

/** 更新履歴の 1 項目変更 (項目名・更新前・更新後)。 */
export interface FieldChange {
  field: string;
  before: string;
  after: string;
}

/** 管理対象チケットの更新履歴 1 件 (SP リスト MikkeChangeLog の 1 行)。 */
export interface ChangeLogEntry {
  id: number;
  /** 対象チケット (Issue Instance ID)。 */
  issueInstanceId: string;
  /** 更新日時 (ISO)。 */
  changedAt: string;
  /** 更新者 (SP Author)。 */
  changedBy?: string;
  /** 変更された項目 (項目名 / 更新前 / 更新後)。 */
  changes: FieldChange[];
}

/** メイン画面のビュー。 */
export type ViewName = 'issues' | 'import' | 'assets' | 'downloads' | 'perms';
