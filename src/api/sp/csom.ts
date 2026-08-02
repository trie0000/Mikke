/**
 * CSOM (ProcessQuery) のリクエスト生成。REST に無い操作だけをここで扱う。
 *
 * ★ 列の並べ替えは REST に存在しない ($metadata に Reorder が無いことを実機で確認)。
 *   CSOM の FieldLinkCollection.Reorder を呼ぶしかないため、この 1 機能のためだけに
 *   ProcessQuery を使う。エンドポイントは /_vti_bin/client.svc/ProcessQuery。
 */

/** SP.ClientContext の TypeId。ObjectPaths の起点 (Current) に使う。 */
const CLIENT_CONTEXT_TYPE_ID = '{3747adcd-a3c3-41b9-bfab-4a64dd2f1e0a}';

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * コンテンツタイプの列並べ替え (FieldLinkCollection.Reorder) を呼ぶリクエスト XML。
 *
 * ★ ObjectPaths は SP.ClientContext.Current → Web → Lists.GetByTitle →
 *   ContentTypes.GetById → FieldLinks と辿る。こうするとコンテンツタイプの
 *   Identity 文字列を自前で組み立てずに済む。
 * ★ Reorder のあとに ContentType.Update(false) を呼ばないと保存されない。
 *   実機で ErrorInfo:null / 並び順の変更を確認済み。
 */
export function buildReorderFieldsXml(
  listTitle: string,
  contentTypeId: string,
  orderedNames: string[],
): string {
  const names = orderedNames.map((n) => `<Object Type="String">${xmlEscape(n)}</Object>`).join('');
  return (
    '<Request AddExpandoFieldTypeSuffix="true" SchemaVersion="15.0.0.0" LibraryVersion="16.0.0.0"' +
    ' ApplicationName="Mikke" xmlns="http://schemas.microsoft.com/sharepoint/clientquery/2009">' +
    '<Actions>' +
    '<Method Name="Reorder" Id="100" ObjectPathId="10">' +
    `<Parameters><Parameter Type="Array">${names}</Parameter></Parameters></Method>` +
    '<Method Name="Update" Id="101" ObjectPathId="9">' +
    '<Parameters><Parameter Type="Boolean">false</Parameter></Parameters></Method>' +
    '</Actions>' +
    '<ObjectPaths>' +
    `<StaticProperty Id="4" TypeId="${CLIENT_CONTEXT_TYPE_ID}" Name="Current" />` +
    '<Property Id="5" ParentId="4" Name="Web" />' +
    '<Property Id="6" ParentId="5" Name="Lists" />' +
    '<Method Id="7" ParentId="6" Name="GetByTitle">' +
    `<Parameters><Parameter Type="String">${xmlEscape(listTitle)}</Parameter></Parameters></Method>` +
    '<Property Id="8" ParentId="7" Name="ContentTypes" />' +
    '<Method Id="9" ParentId="8" Name="GetById">' +
    `<Parameters><Parameter Type="String">${xmlEscape(contentTypeId)}</Parameter></Parameters></Method>` +
    '<Property Id="10" ParentId="9" Name="FieldLinks" />' +
    '</ObjectPaths></Request>'
  );
}

/** ProcessQuery の応答 (JSON 配列) からエラーを取り出す。無ければ null。 */
export function processQueryError(responseText: string): string | null {
  let parsed: unknown;
  try { parsed = JSON.parse(responseText); } catch { return '応答を解釈できません'; }
  if (!Array.isArray(parsed)) return '応答の形式が想定と違います';
  for (const entry of parsed) {
    const info = (entry as { ErrorInfo?: { ErrorMessage?: string } } | null)?.ErrorInfo;
    if (info) return String(info.ErrorMessage ?? 'ProcessQuery が失敗しました');
  }
  return null;
}
