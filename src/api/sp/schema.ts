// SharePoint REST: スキーマ宣言 / FieldSpec → SP REST 型変換。
// SpRepository.ensureLists から呼ばれる。
import { MGMT_STATUSES, VULN_TYPES } from '../../types';

export type FieldType = 'Text' | 'Note' | 'NoteRich' | 'Number' | 'DateTime' | 'Boolean' | 'Choice' | 'User' | 'Url';

export interface FieldSpec {
  /** 内部名 (InternalName)。作成時の Title にもこれを使い、内部名を ASCII に固定する。
   *  日本語で列を作ると内部名が _x8106_... にエンコードされるため、
   *  「英語名で作成 → 表示名だけ日本語に変更」の二段構えにする。 */
  name: string;
  type: FieldType;
  choices?: string[];
  /** List View Threshold (5000) 対策。$filter/$orderby に使う列は早期に index。 */
  indexed?: boolean;
  /** 表示名 (日本語)。指定すると作成後に Title だけを変更する。内部名は name のまま。 */
  displayName?: string;
  /** DateTime を「日付のみ」にする (DisplayFormat: 0)。既定は日付+時刻 (1)。 */
  dateOnly?: boolean;
  /** 数値の小数桁など、REST の型に無く SchemaXml 経由でしか設定できない属性。
   *  例: { Decimals: '1' } / { RichTextMode: 'FullHtml' }。作成後に MERGE で差し込む。 */
  schemaXmlAttributes?: Record<string, string>;
  /** フォーム本体の表示条件 (条件付き数式)。'false' を返すと本体から消える。
   *  例: HIDDEN_ALWAYS / HIDDEN_UNLESS_NEW / `=if([$Status] == 'x', 'true', 'false')` */
  conditionalFormula?: string;
  /** 必須にするか。★ 必須列は条件付き数式で隠せない (常にフォームに出る) ため、
   *  カードで見せる列は false にする必要がある。既定 (未指定) は変更しない。 */
  required?: boolean;
}

/**
 * フォームの条件付き数式 (表示/非表示) が入る列プロパティ。
 * 入力規則の ValidationFormula とは別物で、公式ドキュメントに REST 名の記載が無い。
 * 実機 (SharePoint Online) で特定した。仕様変更時はここだけ差し替える。
 */
export const CONDITIONAL_FORMULA_PROPERTY = 'ClientValidationFormula';

/** フォーム本体から常に隠す (ヘッダーのカードで見せる列に使う)。 */
export const HIDDEN_ALWAYS = "=if(true, 'false', 'false')";

/** 新規フォームでだけ入力可 (既存アイテムでは読み取り専用)。
 *  ID は新規フォームでは空、既存アイテムでは値が入ることを利用する。
 *  ※ グリッドビュー (編集モード) は条件付き数式を無視するため、
 *    「読み取り専用」の保証にはならない。 */
export const HIDDEN_UNLESS_NEW = "=if([$ID] == '', 'true', 'false')";

/** リスト名 (定数)。 */
export const LIST_MANAGED = 'MikkeManagedIssues';
export const LIST_SETTINGS = 'MikkeSettings';
export const LIST_IMPORTLOG = 'MikkeImportLog';
export const LIST_ASSETS = 'MikkeAssets';
export const LIST_HISTORY = 'MikkeHistory';
export const LIST_CHANGELOG = 'MikkeChangeLog';
export const LIST_DOWNLOADS = 'MikkeDownloads';
/** 資産管理者への連携用リスト (対応状況を記入してもらう。Mikke の管理表とは別物)。 */
export const LIST_VULNRESPONSE = 'MikkeVulnResponse';

export function spFieldTypeString(t: FieldType): string {
  switch (t) {
    case 'Text': return 'Text';
    case 'Note': return 'Note';
    case 'NoteRich': return 'Note';
    case 'Number': return 'Number';
    case 'DateTime': return 'DateTime';
    case 'Url': return 'URL';
    case 'Boolean': return 'Boolean';
    case 'Choice': return 'Choice';
    case 'User': return 'User';
  }
}

export function toFieldSchema(f: FieldSpec): unknown {
  switch (f.type) {
    case 'Text':
      return { __metadata: { type: 'SP.FieldText' }, FieldTypeKind: 2, Title: f.name };
    case 'Note':
      return { __metadata: { type: 'SP.FieldMultiLineText' }, FieldTypeKind: 3, Title: f.name, RichText: false, NumberOfLines: 6 };
    case 'NoteRich':
      // RichText だけだと RichTextMode が既定の Compatible になり、モダンフォームで
      // リッチテキストエディタにならず HTML が生で見える。FullHtml は REST の型に
      // 無いので schemaXmlAttributes 側 (SchemaXml MERGE) で差し込む。
      return { __metadata: { type: 'SP.FieldMultiLineText' }, FieldTypeKind: 3, Title: f.name, RichText: true, NumberOfLines: 6 };
    case 'Number':
      // Decimals は REST の SP.FieldNumber に無い → schemaXmlAttributes で指定する。
      return { __metadata: { type: 'SP.FieldNumber' }, FieldTypeKind: 9, Title: f.name };
    case 'DateTime':
      return { __metadata: { type: 'SP.FieldDateTime' }, FieldTypeKind: 4, Title: f.name,
        DisplayFormat: f.dateOnly ? 0 : 1 };
    case 'Boolean':
      return { __metadata: { type: 'SP.Field' }, FieldTypeKind: 8, Title: f.name };
    case 'Choice':
      return { __metadata: { type: 'SP.FieldChoice' }, FieldTypeKind: 6, Title: f.name, Choices: { results: f.choices ?? [] } };
    case 'User':
      // SelectionMode 0 = ユーザーのみ (グループを選ばせない)。
      return { __metadata: { type: 'SP.FieldUser' }, FieldTypeKind: 20, Title: f.name, SelectionMode: 0 };
    case 'Url':
      // DisplayFormat 0 = ハイパーリンク (1 = 画像)。値は SP.FieldUrlValue
      // ({Url, Description}) で送る。一覧では Description がリンク文字列になる。
      return { __metadata: { type: 'SP.FieldUrl' }, FieldTypeKind: 11, Title: f.name, DisplayFormat: 0 };
  }
}

/** MikkeManagedIssues の固定列定義 (動的 Scan_* は取込時に追加)。 */
export function managedIssueFieldSpecs(): FieldSpec[] {
  return [
    { name: 'IssueInstanceId', type: 'Text', indexed: true },
    { name: 'DetectionStatus', type: 'Choice', indexed: true,
      choices: ['新規', '継続', '再検知', '未検出(New)', '未検出'] },
    { name: 'MgmtStatus', type: 'Choice', indexed: true,
      choices: [...MGMT_STATUSES] },
    { name: 'IsOutOfScope', type: 'Boolean', indexed: true },
    { name: 'OutOfScopeReason', type: 'Note' },
    { name: 'Assignee', type: 'Text' },
    // 管理系 ID。IssueInstanceId (検査ツール) / Web資産管理ID (資産リスト側の MgmtNumber) と
    // 並ぶ 3 種類目。連携用リストにも同じ値を渡す。
    { name: 'ExtConnAppId', type: 'Text', indexed: true },
    // 管理会社・事業会社。資産リストからも引けるが、脆弱性ごとに上書きしたい
    // ケースがあるので管理対象側にも持つ (未設定なら資産の値を使う)。
    { name: 'BusinessCompany', type: 'Text', indexed: true },
    { name: 'AffiliateCompany', type: 'Text' },
    { name: 'WebMapsId', type: 'Text', indexed: true },
    { name: 'IdentifyEvidence', type: 'Note' },
    { name: 'ResponsePlan', type: 'Note' },
    { name: 'NoAppReason', type: 'Note' },
    // 対応状況を「完了」にした理由 (移行データ由来。連携用リストの対応経緯とは別物)。
    { name: 'CompletionReason', type: 'Note' },
    { name: 'VulnType', type: 'Choice', choices: [...VULN_TYPES] },
    // ★ Excel 運用時代の「事業会社名-YYMM-XX」。将来廃止する暫定 ID だが、
    //   移行期間中は参考情報として管理リスト・連携用リストの双方で見せる。
    { name: 'LegacyMgmtNumber', type: 'Text', indexed: true },
    { name: 'DueDate', type: 'DateTime' },
    { name: 'MgmtNote', type: 'NoteRich' },
    { name: 'ScannerStatus', type: 'Text' },
    { name: 'Severity', type: 'Text', indexed: true },
    { name: 'FirstSeen', type: 'DateTime' },
    { name: 'LastSeen', type: 'DateTime' },
    { name: 'FirstUndetectedAt', type: 'DateTime' },
    { name: 'AddedReason', type: 'Choice', choices: ['条件一致', '個別指定'] },
    { name: 'LastSyncedAt', type: 'DateTime' },
    // 個別レポート (情報更新で 1 件ずつ取得。形式は検査ツール次第で現状 PDF)。
    // URL は 255 文字を超え得るので Note。
    { name: 'ReportUrl', type: 'Note' },
    { name: 'ReportName', type: 'Text' },
    { name: 'ReportAt', type: 'DateTime' },
    // 連携用リストから取り込んだ資産管理者の記入内容 (Mikke 側のメモとは別に保持)。
    { name: 'ResponseNote', type: 'NoteRich', schemaXmlAttributes: { RichTextMode: 'FullHtml' } },
    { name: 'ResponseRemarks', type: 'Note' },
    { name: 'ResponseSyncedAt', type: 'DateTime' },
    // ★ 検査ツール由来の全項目 (Scan_*) は個別列にせず、この 1 列へ JSON で集約する。
    //   個別列にすると SP の列数上限 (複数行テキストは 1 リスト約192列) と 1 行あたり
    //   約8KB のサイズ上限に抵触し、検査ツールの 259 列 CSV で列作成が HTTP 500 /
    //   書込が失敗する。JSON 集約なら 1 列で済み破綻しない (表示・絞込はクライアント側)。
    { name: 'ScanData', type: 'Note' },
  ];
}

/** MikkeSettings: KV を JSON 1 行で保持。 */
export function settingsFieldSpecs(): FieldSpec[] {
  return [
    { name: 'SettingsJson', type: 'Note' },
  ];
}

/** MikkeAssets: 資産 (FQDN/IP) の管理部門情報。 */
export function assetFieldSpecs(): FieldSpec[] {
  return [
    { name: 'AssetKey', type: 'Text', indexed: true },
    { name: 'AssetType', type: 'Choice', choices: ['FQDN', 'IP'] },
    { name: 'BusinessCompany', type: 'Text' },
    { name: 'AffiliateCompany', type: 'Text' },
    { name: 'MgmtNumber', type: 'Text', indexed: true },
    { name: 'IdentifyEvidence', type: 'Note' },
    { name: 'Remarks', type: 'Note' },
    { name: 'UpdatedAt', type: 'DateTime' },
  ];
}

/** MikkeHistory: 脆弱性の対応履歴 (外部/内部カード)。 */
export function historyFieldSpecs(): FieldSpec[] {
  return [
    { name: 'IssueInstanceId', type: 'Text', indexed: true },
    { name: 'Thread', type: 'Choice', choices: ['external', 'internal'] },
    { name: 'Source', type: 'Choice', choices: ['mail', 'manual', 'other'] },
    { name: 'AuthorName', type: 'Text' },
    { name: 'FromEmail', type: 'Text' },
    { name: 'Subject', type: 'Note' },
    { name: 'Body', type: 'Note' },
    { name: 'IsHtml', type: 'Boolean' },
    { name: 'OccurredAt', type: 'DateTime' },
  ];
}

/** MikkeChangeLog: 管理対象チケットの更新履歴 (項目単位の before/after)。 */
export function changeLogFieldSpecs(): FieldSpec[] {
  return [
    { name: 'IssueInstanceId', type: 'Text', indexed: true },
    { name: 'ChangedAt', type: 'DateTime' },
    { name: 'ChangesJson', type: 'Note' },
  ];
}

/** MikkeDownloads: 検査ツールから取得したデータ (種別ごとの zip) の記録。 */
export function downloadFieldSpecs(): FieldSpec[] {
  return [
    { name: 'DlType', type: 'Text', indexed: true },
    { name: 'DownloadedAt', type: 'DateTime', indexed: true },
    { name: 'ScannerDownloadTime', type: 'Text' },
    { name: 'FileName', type: 'Text' },
    // ★ 'Folder' / 'File' は SP リストアイテムのナビゲーションプロパティ名なので
    //   カスタム列名に使うと POST 時に 400 (PrimitiveValue vs navigation property)。
    //   → 'FolderPath' 等の非予約名にする。
    { name: 'FolderPath', type: 'Note' },
    { name: 'FileUrl', type: 'Note' },
    { name: 'ItemCount', type: 'Number' },
  ];
}

/**
 * MikkeVulnResponse: 資産管理者への連携用リスト。
 *
 * 運用: Mikke の管理表 (MikkeManagedIssues) は管理者専用。資産管理者にはこのリストを
 * 見てもらい、対応状況を記入してもらう。Mikke 側から「SPO リストに反映」で
 * アイテムを追加/更新し、記入結果は後日 Mikke に取り込む (突合キー = 組込みの Title)。
 *
 * フォームの見せ方:
 *   - 脆弱性情報 (Mikke が書き込む列) は本体から隠し、ヘッダーのカードで読み取り専用表示。
 *     ただし手動で 1 件足せるよう「新規フォームでだけ入力可」にする (HIDDEN_UNLESS_NEW)。
 *   - 本体には対応状況の入力欄だけを残す。
 *   - 例外・対象外の理由は、対応状況が「リスク受容 / 対象外 / 過検出」のときだけ出す。
 */
/** 連携用リストの「対応状況」の選択肢。
 *  ★ Mikke の対応ステータスと同じ値にする (別々に並べると片方だけ直して
 *    取り込みが黙って落ちる)。値の対応表は lib/responseSync.ts。 */
export const RESPONSE_STATUS_CHOICES: readonly string[] = MGMT_STATUSES;

/** 例外理由を表示する対応状況。 */
export const EXCEPTION_STATUSES: readonly string[] = ['リスク受容', '過検出', '対象外'];

/** 対応状況が例外系のときだけ「例外・対象外の理由」を出す数式。 */
export const EXCEPTION_REASON_FORMULA =
  '=if(' + EXCEPTION_STATUSES.map((s) => `[$ResponseStatus] == '${s}'`).join(' || ') + ", 'true', 'false')";

export function vulnResponseFieldSpecs(): FieldSpec[] {
  // 脆弱性情報: Mikke が書き込む。ヘッダーのカードで読み取り専用表示するため、
  // フォーム本体では隠す (新規フォームでだけ入力可 = 手動で 1 件足せる)。
  const pushed = (name: string, displayName: string, extra: Partial<FieldSpec> = {}): FieldSpec => ({
    name, type: 'Text', displayName, conditionalFormula: HIDDEN_UNLESS_NEW, ...extra,
  });
  return [
    // ── 脆弱性情報 (ヘッダーカード) ──
    // ★ SharePoint 組込みの Title を **突合キー (Issue Instance ID)** にする。
    //   Title はビューの既定リンク列 (LinkTitle) なので、ここが ID になっていると
    //   一覧でそのままアイテムを識別できる。別に IssueInstanceId 列を持つと
    //   同じ値の列が 2 本並ぶので置き換えた (旧列は OBSOLETE で削除される)。
    { name: 'Title', type: 'Text', displayName: 'Issue Instance ID', conditionalFormula: HIDDEN_UNLESS_NEW,
      required: false, indexed: true },
    // 脆弱性の名前。Title を ID にしたので独立した列で持つ。
    pushed('VulnTitle', '脆弱性タイトル'),
    // ★ Excel 運用時代の暫定 ID (事業会社名-YYMM-XX)。将来廃止するが、移行期間中は
    //   資産管理者にも見えるようにする。内部名は管理対象リスト側と揃えてある。
    pushed('LegacyMgmtNumber', '旧管理番号'),
    pushed('DetectionStatus', '検知状況'),
    pushed('FirstSeen', '初回検知日', { type: 'DateTime', dateOnly: true }),
    pushed('LastSeen', '最終検知日', { type: 'DateTime', dateOnly: true }),

    // ── 資産情報 (ヘッダーカードで読み取り専用表示 / 本体では新規時のみ入力可) ──
    //   ※ SharePoint のフォーム本体はセクション見出ししか付けられず、カード化・段組が
    //     できない (公式仕様)。見やすさを優先し、情報系はカードに集約している。
    //   ※ さらに body (セクション) を設定するとフォームが単段組から複数段組に切り替わり、
    //     入力欄が 1 セル幅 (実測 242px / フォーム幅 1208px) に固定される。対応経緯・備考を
    //     全幅にするため body は設定しない (実測: 未設定なら 1200px)。→ formFormatter.ts
    pushed('AssetIp', 'IP'),
    pushed('AssetFqdn', 'FQDN'),
    pushed('AssetType', '資産タイプ'),
    pushed('BusinessCompany', '事業会社'),
    pushed('AffiliateCompany', '管理会社'),
    pushed('AssetMgmtId', 'Web資産管理ID', { indexed: true }),
    pushed('ExtConnAppId', '外部接続申請ID'),
    pushed('RelatedAssets', '関連資産', { type: 'Note' }),
    pushed('IdentifyEvidence', '管理事業会社特定の根拠', { type: 'Note' }),
    // ★ 脆弱性レポート (PDF) へのリンク。資産管理者が一覧から 1 クリックで開ける
    //   ようにするための列。値は Mikke が保存した SP 上のファイルのサーバ相対 URL、
    //   表示テキストはファイル名。同じファイルはアイテムの添付にも付く (権限が
    //   ライブラリまで届かない利用者はそちらから開ける)。
    pushed('ReportUrl', '脆弱性レポート', { type: 'Url' }),

    // ── 対応 (資産管理者が記入) ──
    { name: 'ResponseStatus', type: 'Choice', displayName: '対応状況',
      choices: [...RESPONSE_STATUS_CHOICES], indexed: true },
    { name: 'Responder', type: 'User', displayName: '対応者（AD情報）' },
    { name: 'DueDate', type: 'DateTime', dateOnly: true, displayName: '対応期日' },
    { name: 'ResponseNote', type: 'NoteRich', displayName: '対応経緯',
      schemaXmlAttributes: { RichTextMode: 'FullHtml' } },

    // ── その他 ──
    { name: 'Remarks', type: 'Note', displayName: '備考' },
  ];
}

/** 旧レイアウトの列。フォームから消すため、存在すれば削除する (無ければ何もしない)。
 *  ※ 列ごと消えるのでデータも失われる。運用開始後に足す場合は要注意。 */
export const VULNRESPONSE_OBSOLETE_FIELDS = [
  'Severity',        // 深刻度 (新レイアウトに無い)
  'ResponseDate',    // 対応日 (対応期日に集約)
  'ExceptionReason', // 例外・対象外の理由
  'TargetAsset',     // 対象資産 (IP / FQDN に分割)
  'MgmtNumber',      // 管理番号 → 旧管理番号 (LegacyMgmtNumber) に一本化
  'IssueInstanceId', // 突合キーは組込みの Title に移した (同じ値の列が 2 本になるため)
];

/**
 * フォーム本体の列の並び順を、定義順 (このファイルの vulnResponseFieldSpecs の順) に揃える。
 *
 * ★ フォームの項目順はコンテンツタイプの FieldLink 順で決まる。列を後から足すと
 *   末尾に積まれ、意図と違う順で表示される (実機で「対応期日」が先頭に出た)。
 *
 * current  … 現在の FieldLink 名 (内部名)
 * specNames… 定義順の内部名
 * 戻り値   … 定義に無いもの (ContentType 等) を先頭に残し、続けて定義順に並べたもの。
 */
export function orderFieldLinks(current: string[], specNames: string[]): string[] {
  const want = new Set(specNames);
  return [
    ...current.filter((n) => !want.has(n)),
    ...specNames.filter((n) => current.includes(n)),
  ];
}

/** MikkeVulnResponse の既定ビューに出す列 (内部名)。
 *  件名は LinkTitle として既定ビューに最初から入っているので Title は入れない
 *  (入れると件名が 2 列並ぶ)。 */
export const VULNRESPONSE_VIEW_FIELDS = [
  'LinkTitle', 'VulnTitle', 'LegacyMgmtNumber', 'DetectionStatus', 'LastSeen',
  'AssetFqdn', 'AssetIp', 'BusinessCompany', 'AssetMgmtId', 'ReportUrl',
  'ResponseStatus', 'DueDate', 'Responder',
];

/** MikkeImportLog: 取込履歴。 */
export function importLogFieldSpecs(): FieldSpec[] {
  return [
    { name: 'ImportedAt', type: 'DateTime', indexed: true },
    { name: 'FileName', type: 'Text' },
    { name: 'Operator', type: 'Text' },
    { name: 'AddedCount', type: 'Number' },
    { name: 'UpdatedCount', type: 'Number' },
    { name: 'UndetectedCount', type: 'Number' },
    { name: 'SkippedCount', type: 'Number' },
    { name: 'RowCount', type: 'Number' },
  ];
}
