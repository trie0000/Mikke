// 個別レポート (脆弱性 1 件ごとのレポート) のファイル形式まわり。
//
// ★ 形式は検査ツール (アダプタ) が返したものをそのまま使う。Mikke は再圧縮も
//   リネームもしない。以前は zip 前提で MIME もリンク表記も 'zip' 固定にしていたが、
//   実際には PDF がそのまま上がってくる。また形式が変わっても直さずに済むよう、
//   ここでは拡張子から導出する。
import { jstStamp } from './downloadFlow';

const MIME_BY_EXT: Record<string, string> = {
  pdf:  'application/pdf',
  zip:  'application/zip',
  csv:  'text/csv',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xls:  'application/vnd.ms-excel',
  html: 'text/html',
  htm:  'text/html',
  json: 'application/json',
  xml:  'application/xml',
  txt:  'text/plain',
};

/** ファイル名の拡張子 (小文字・ドット無し)。無ければ空文字。 */
export function reportExt(fileName?: string | null): string {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec((fileName ?? '').trim());
  return m ? m[1]!.toLowerCase() : '';
}

/** SP へ保存・添付するときの Content-Type。未知の拡張子はバイナリ扱い。 */
export function reportMime(fileName?: string | null): string {
  return MIME_BY_EXT[reportExt(fileName)] ?? 'application/octet-stream';
}

/** 一覧の「レポート」列に出す短い表記 (拡張子の大文字。不明なら「開く」)。 */
export function reportLinkLabel(fileName?: string | null): string {
  const ext = reportExt(fileName);
  return ext ? ext.toUpperCase() : '開く';
}

/** Windows のファイル名に使えない文字だけを潰す (ハイフン・空白はそのまま残す)。 */
function safeName(s: string): string {
  return s.replace(/[\\/:*?"<>|]/g, '_').replace(/^\.+/, '').trim();
}

/**
 * 一括ダウンロード zip の中でのファイル名。
 * どの脆弱性のレポートか分かるよう脆弱性 ID を前置し (既に名前に入っていれば付けない)、
 * 同名になったものは連番で避ける (zip 内で名前が衝突すると展開時に片方が消える)。
 */
export function zipEntryName(issueInstanceId: string, fileName: string, used: Set<string>): string {
  const base = safeName(fileName) || 'report';
  const iid = safeName(issueInstanceId ?? '');
  const name = iid && !base.includes(iid) ? `${iid}_${base}` : base;
  if (!used.has(name)) { used.add(name); return name; }
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let n = 2; ; n++) {
    const cand = `${stem}_${n}${ext}`;
    if (!used.has(cand)) { used.add(cand); return cand; }
  }
}

/** 一括ダウンロードで保存する zip のファイル名。 */
export function bulkReportZipName(nowIso?: string): string {
  return `mikke-reports_${jstStamp(nowIso)}.zip`;
}
