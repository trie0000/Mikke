// 軽量 CSV パーサ。RFC4180 準拠 (ダブルクォート / 改行埋込 / エスケープ対応)。
// ※ 本番の大容量 CSV (約2万件/100MB) は中継サーバ側で解析する (技術設計書 §11)。
//    これはクライアント側のフォールバック / 小規模検証用。

export interface ParsedCsv {
  headers: string[];
  /** 各行を { 列名: 値 } の連想配列で返す。 */
  rows: Record<string, string>[];
}

/** CSV テキストをパース。BOM 除去・CRLF/CR/LF 対応。 */
export function parseCsv(text: string): ParsedCsv {
  // BOM 除去
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  const records: string[][] = [];
  let field = '';
  let record: string[] = [];
  let inQuotes = false;
  let i = 0;
  const n = text.length;

  while (i < n) {
    const c = text[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') { inQuotes = true; i++; continue; }
    if (c === ',') { record.push(field); field = ''; i++; continue; }
    if (c === '\r') {
      if (text[i + 1] === '\n') i++;
      record.push(field); field = ''; records.push(record); record = []; i++;
      continue;
    }
    if (c === '\n') {
      record.push(field); field = ''; records.push(record); record = []; i++;
      continue;
    }
    field += c; i++;
  }
  // 最終フィールド / レコード
  if (field.length > 0 || record.length > 0) {
    record.push(field);
    records.push(record);
  }

  // 空レコード (末尾改行由来) を除去
  const nonEmpty = records.filter((r) => !(r.length === 1 && r[0] === ''));
  if (nonEmpty.length === 0) return { headers: [], rows: [] };

  const headers = (nonEmpty[0] ?? []).map((h) => h.trim());
  const rows: Record<string, string>[] = [];
  for (let r = 1; r < nonEmpty.length; r++) {
    const cols = nonEmpty[r]!;
    const obj: Record<string, string> = {};
    headers.forEach((h, idx) => { obj[h] = (cols[idx] ?? '').trim(); });
    rows.push(obj);
  }
  return { headers, rows };
}
