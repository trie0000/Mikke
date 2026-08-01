// SharePoint REST: スキーマ宣言 / FieldSpec → SP REST 型変換。
// SpRepository.ensureLists から呼ばれる。

export type FieldType = 'Text' | 'Note' | 'NoteRich' | 'Number' | 'DateTime' | 'Boolean' | 'Choice' | 'User';

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
  }
}

/** MikkeManagedIssues の固定列定義 (動的 Scan_* は取込時に追加)。 */
export function managedIssueFieldSpecs(): FieldSpec[] {
  return [
    { name: 'IssueInstanceId', type: 'Text', indexed: true },
    { name: 'DetectionStatus', type: 'Choice', indexed: true,
      choices: ['新規', '継続', '再検知', '未検出(New)', '未検出'] },
    { name: 'MgmtStatus', type: 'Choice', indexed: true,
      choices: ['未通知', '通知', '対応中', '対応済み', 'リスク受容', '過検出', '対象外'] },
    { name: 'IsOutOfScope', type: 'Boolean', indexed: true },
    { name: 'OutOfScopeReason', type: 'Note' },
    { name: 'Assignee', type: 'Text' },
    { name: 'DueDate', type: 'DateTime' },
    { name: 'MgmtNote', type: 'NoteRich' },
    { name: 'ScannerStatus', type: 'Text' },
    { name: 'Severity', type: 'Text', indexed: true },
    { name: 'FirstSeen', type: 'DateTime' },
    { name: 'LastSeen', type: 'DateTime' },
    { name: 'FirstUndetectedAt', type: 'DateTime' },
    { name: 'AddedReason', type: 'Choice', choices: ['条件一致', '個別指定'] },
    { name: 'LastSyncedAt', type: 'DateTime' },
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
 * アイテムを追加/更新し、記入結果は後日 Mikke に取り込む (突合キー = IssueInstanceId)。
 *
 * フォームの見せ方:
 *   - 脆弱性情報 (Mikke が書き込む列) は本体から隠し、ヘッダーのカードで読み取り専用表示。
 *     ただし手動で 1 件足せるよう「新規フォームでだけ入力可」にする (HIDDEN_UNLESS_NEW)。
 *   - 本体には対応状況の入力欄だけを残す。
 *   - 例外・対象外の理由は、対応状況が「リスク受容 / 対象外 / 過検出」のときだけ出す。
 */
export const RESPONSE_STATUS_CHOICES = ['未着手', '対応中', '対応済み', 'リスク受容', '過検出', '対象外'] as const;

/** 例外理由を表示する対応状況。 */
export const EXCEPTION_STATUSES: readonly string[] = ['リスク受容', '過検出', '対象外'];

/** 対応状況が例外系のときだけ「例外・対象外の理由」を出す数式。 */
export const EXCEPTION_REASON_FORMULA =
  '=if(' + EXCEPTION_STATUSES.map((s) => `[$ResponseStatus] == '${s}'`).join(' || ') + ", 'true', 'false')";

export function vulnResponseFieldSpecs(): FieldSpec[] {
  // 脆弱性情報 (Mikke が書き込む / ヘッダーのカードで見せる)。本体では新規時のみ入力可。
  const pushed = (name: string, displayName: string, extra: Partial<FieldSpec> = {}): FieldSpec => ({
    name, type: 'Text', displayName, conditionalFormula: HIDDEN_UNLESS_NEW, ...extra,
  });
  return [
    // Title はリスト作成時から存在する (型一致でスキップされ、表示名だけ変わる)。
    { name: 'Title', type: 'Text', displayName: '件名' },
    // 突合キー。Mikke 側の Issue Instance ID と 1:1。
    pushed('IssueInstanceId', '脆弱性ID', { indexed: true }),
    pushed('Severity', '深刻度'),
    pushed('DetectionStatus', '検知状況'),
    pushed('TargetAsset', '対象資産'),
    pushed('BusinessCompany', '事業会社'),
    pushed('AffiliateCompany', '関連会社'),
    pushed('MgmtNumber', '管理番号'),
    pushed('FirstSeen', '初回検出日', { type: 'DateTime', dateOnly: true }),
    pushed('LastSeen', '最終検出日', { type: 'DateTime', dateOnly: true }),
    pushed('DueDate', '対応期限', { type: 'DateTime', dateOnly: true }),

    // ここから下が資産管理者に記入してもらう入力欄 (フォーム本体に残す)。
    { name: 'ResponseStatus', type: 'Choice', displayName: '対応状況',
      choices: [...RESPONSE_STATUS_CHOICES], indexed: true },
    { name: 'ResponseDate', type: 'DateTime', dateOnly: true, displayName: '対応日' },
    { name: 'Responder', type: 'User', displayName: '対応担当者' },
    { name: 'ResponseNote', type: 'NoteRich', displayName: '対応内容',
      schemaXmlAttributes: { RichTextMode: 'FullHtml' } },
    { name: 'ExceptionReason', type: 'Note', displayName: '例外・対象外の理由',
      conditionalFormula: EXCEPTION_REASON_FORMULA },
  ];
}

/** MikkeVulnResponse の既定ビューに出す列 (内部名)。
 *  件名は LinkTitle として既定ビューに最初から入っているので Title は入れない
 *  (入れると件名が 2 列並ぶ)。 */
export const VULNRESPONSE_VIEW_FIELDS = [
  'IssueInstanceId', 'Severity', 'TargetAsset', 'BusinessCompany',
  'DueDate', 'ResponseStatus', 'ResponseDate', 'Responder',
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
