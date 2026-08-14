// 項目名の一本化。
//
// ★ 同じ値を画面ごとに別の名前で呼ばないための単一の出どころ。
//   管理対象一覧の列名・明細の項目名・連携用リストの列表示名は、すべてここを見る。
//   直書きすると片方だけ直して食い違う (実際に「Last Seen / 最終検出 / 最終検知日」
//   「WebMAPS管理ID / Web資産管理ID」など 8 箇所ずれていた)。
//
// ここに無いもの = その画面にしか無い項目。増やすときは、両方に出るなら必ずここへ。

export const LABEL = {
  // ── 脆弱性の識別 ──
  issueInstanceId: 'Issue Instance ID',
  title: '脆弱性タイトル',
  legacyMgmtNumber: '旧管理番号',

  // ── 検知 ──
  detectionStatus: '検知状況',
  firstSeen: '初回検知日',
  lastSeen: '最終検知日',

  // ── 組織・資産 ──
  businessCompany: '事業会社',
  affiliateCompany: '管理会社',
  assetMgmtId: 'WebMAPS管理ID',
  identifyEvidence: '事業会社特定の根拠',
  report: 'レポート',

  // ── 資産管理者が記入する欄 (連携用リストの記入欄と 1:1) ──
  responseStatus: '対応状況',
  responder: '対応者',
  responseDueDate: '対応期日',
  extConnAppId: '外部接続申請ID',
  responsePlan: '対応計画',
  completionReason: '完了理由',
  noAppReason: '申請不要理由',
  responseNote: '対応経緯',
  responseRemarks: '備考',

  // ── Mikke だけの項目 (連携用リストには出ない) ──
  /** ★「備考」(資産管理者が書く欄) と紛らわしいので、Mikke 側は「内部メモ」と呼ぶ。 */
  mgmtNote: '内部メモ',
} as const;

export type LabelKey = keyof typeof LABEL;

/** 事業会社が記入する欄。明細のタブ・編集モーダル・連携用リストで **この順** に並べる。 */
export const RESPONSE_SECTION = '事業会社記入欄';

/** 事業会社記入欄の並び (画面をまたいで同じ順にするための単一の出どころ)。 */
export const RESPONSE_FIELD_ORDER = [
  'responseStatus', 'responder', 'extConnAppId', 'noAppReason', 'responseDueDate',
  'responsePlan', 'responseNote', 'completionReason', 'responseRemarks',
] as const satisfies readonly LabelKey[];
