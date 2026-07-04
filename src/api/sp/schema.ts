// SharePoint REST: スキーマ宣言 / FieldSpec → SP REST 型変換。
// SpRepository.ensureLists から呼ばれる。

export type FieldType = 'Text' | 'Note' | 'NoteRich' | 'Number' | 'DateTime' | 'Boolean' | 'Choice';

export interface FieldSpec {
  name: string;
  type: FieldType;
  choices?: string[];
  /** List View Threshold (5000) 対策。$filter/$orderby に使う列は早期に index。 */
  indexed?: boolean;
}

/** リスト名 (定数)。 */
export const LIST_MANAGED = 'MikkeManagedIssues';
export const LIST_SETTINGS = 'MikkeSettings';
export const LIST_IMPORTLOG = 'MikkeImportLog';
export const LIST_ASSETS = 'MikkeAssets';
export const LIST_HISTORY = 'MikkeHistory';
export const LIST_CHANGELOG = 'MikkeChangeLog';

export function spFieldTypeString(t: FieldType): string {
  switch (t) {
    case 'Text': return 'Text';
    case 'Note': return 'Note';
    case 'NoteRich': return 'Note';
    case 'Number': return 'Number';
    case 'DateTime': return 'DateTime';
    case 'Boolean': return 'Boolean';
    case 'Choice': return 'Choice';
  }
}

export function toFieldSchema(f: FieldSpec): unknown {
  switch (f.type) {
    case 'Text':
      return { __metadata: { type: 'SP.FieldText' }, FieldTypeKind: 2, Title: f.name };
    case 'Note':
      return { __metadata: { type: 'SP.FieldMultiLineText' }, FieldTypeKind: 3, Title: f.name, RichText: false, NumberOfLines: 6 };
    case 'NoteRich':
      return { __metadata: { type: 'SP.FieldMultiLineText' }, FieldTypeKind: 3, Title: f.name, RichText: true, NumberOfLines: 6 };
    case 'Number':
      return { __metadata: { type: 'SP.FieldNumber' }, FieldTypeKind: 9, Title: f.name };
    case 'DateTime':
      return { __metadata: { type: 'SP.FieldDateTime' }, FieldTypeKind: 4, Title: f.name, DisplayFormat: 1 };
    case 'Boolean':
      return { __metadata: { type: 'SP.Field' }, FieldTypeKind: 8, Title: f.name };
    case 'Choice':
      return { __metadata: { type: 'SP.FieldChoice' }, FieldTypeKind: 6, Title: f.name, Choices: { results: f.choices ?? [] } };
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
    //   約8KB のサイズ上限に抵触し、CyCognito 等の 259 列 CSV で列作成が HTTP 500 /
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
