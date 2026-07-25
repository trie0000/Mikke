// 依存ゼロの表データ I/O (CSV / .xlsx)。ブックマークレット配布のため外部
// ライブラリを使わず自己完結で実装する。
//   - CSV: toCsv (BOM 付きで Excel が文字化けせず開ける)。読込は csv.ts の parseCsv。
//   - xlsx 書出: 無圧縮(STORED) ZIP + inline strings で最小構成の有効な .xlsx を生成。
//   - xlsx 読込: ZIP 中央ディレクトリ解析 + 自前 inflate(raw DEFLATE) + シート XML 解析。
// UI 非依存。テストは test/xlsx.test.ts。
import { parseCsv, type ParsedCsv } from './csv';

export type Sheet = ParsedCsv; // { headers: string[]; rows: Record<string,string>[] }

// ── CSV 書出 ────────────────────────────────────────────────────────────────
function csvCell(v: string): string {
  const s = v ?? '';
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** 表を CSV 文字列にする。先頭に UTF-8 BOM を付け Excel で文字化けしないようにする。 */
export function toCsv(headers: string[], rows: Record<string, string>[]): string {
  const lines = [headers.map(csvCell).join(',')];
  for (const r of rows) lines.push(headers.map((h) => csvCell(r[h] ?? '')).join(','));
  return '﻿' + lines.join('\r\n');
}

// ── XML ヘルパ ────────────────────────────────────────────────────────────────
const XML_ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };
function xmlEscape(s: string): string {
  return (s ?? '').replace(/[&<>"']/g, (c) => XML_ESC[c]!);
}
const XML_UNESC: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function xmlUnescape(s: string): string {
  return (s ?? '').replace(/&(#x?[0-9a-fA-F]+|amp|lt|gt|quot|apos);/g, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return XML_UNESC[e] ?? m;
  });
}

/** 列インデックス(0基点) → 列名 (0→A, 25→Z, 26→AA)。 */
export function colLetter(n: number): string {
  let s = '';
  n += 1;
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
}
/** 列名 (A, AA) → 列インデックス(0基点)。 */
export function letterCol(s: string): number {
  let n = 0;
  for (const ch of s.toUpperCase()) { if (ch < 'A' || ch > 'Z') break; n = n * 26 + (ch.charCodeAt(0) - 64); }
  return n - 1;
}

// ── ZIP (STORED) 書出 ────────────────────────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

interface ZipEntry { name: string; data: Uint8Array }

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const len = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
const u16 = (n: number): Uint8Array => new Uint8Array([n & 0xff, (n >>> 8) & 0xff]);
const u32 = (n: number): Uint8Array => new Uint8Array([n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]);

/** 無圧縮(STORED) の ZIP を生成する (xlsx は ZIP コンテナ)。 */
function buildZip(entries: ZipEntry[]): Uint8Array {
  const enc = new TextEncoder();
  const locals: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const e of entries) {
    const nameBytes = enc.encode(e.name);
    const crc = crc32(e.data);
    const local = concatBytes([
      u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0),
      u32(crc), u32(e.data.length), u32(e.data.length),
      u16(nameBytes.length), u16(0), nameBytes, e.data,
    ]);
    locals.push(local);
    central.push(concatBytes([
      u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0),
      u32(crc), u32(e.data.length), u32(e.data.length),
      u16(nameBytes.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset),
      nameBytes,
    ]));
    offset += local.length;
  }
  const centralBlob = concatBytes(central);
  const eocd = concatBytes([
    u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length),
    u32(centralBlob.length), u32(offset), u16(0),
  ]);
  return concatBytes([...locals, centralBlob, eocd]);
}

// ── xlsx 書出 ────────────────────────────────────────────────────────────────
/** 表を最小構成の .xlsx (Blob) にする。全セル inline string で出力。 */
export function buildXlsxBlob(headers: string[], rows: Record<string, string>[], sheetName = 'Sheet1'): Blob {
  const enc = new TextEncoder();
  const rowXml = (cells: string[], r: number): string =>
    `<row r="${r}">` + cells.map((v, c) =>
      `<c r="${colLetter(c)}${r}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(v)}</t></is></c>`,
    ).join('') + '</row>';

  const sheetRows = [rowXml(headers, 1)];
  rows.forEach((rw, i) => sheetRows.push(rowXml(headers.map((h) => rw[h] ?? ''), i + 2)));
  const sheetXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
    + `<sheetData>${sheetRows.join('')}</sheetData></worksheet>`;

  const contentTypes = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
    + '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
    + '</Types>';
  const rels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
    + '</Relationships>';
  const workbook = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
    + `<sheets><sheet name="${xmlEscape(sheetName)}" sheetId="1" r:id="rId1"/></sheets></workbook>`;
  const workbookRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
    + '</Relationships>';

  const zip = buildZip([
    { name: '[Content_Types].xml', data: enc.encode(contentTypes) },
    { name: '_rels/.rels', data: enc.encode(rels) },
    { name: 'xl/workbook.xml', data: enc.encode(workbook) },
    { name: 'xl/_rels/workbook.xml.rels', data: enc.encode(workbookRels) },
    { name: 'xl/worksheets/sheet1.xml', data: enc.encode(sheetXml) },
  ]);
  return new Blob([zip as unknown as BlobPart], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}

// ── inflate (raw DEFLATE) ────────────────────────────────────────────────────
// tiny-inflate (Devon Govett, MIT) を TypeScript 化。Excel の .xlsx は DEFLATE
// 圧縮なので読込にはこれが必要。
class Tree { table = new Uint16Array(16); trans = new Uint16Array(288); }
const LBASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LBITS = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DBASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DBITS = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CLCIDX = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

const sltree = new Tree();
const sdtree = new Tree();
const codeTree = new Tree();
(function buildFixedTrees(): void {
  let i: number;
  for (i = 0; i < 7; ++i) sltree.table[i] = 0;
  sltree.table[7] = 24; sltree.table[8] = 152; sltree.table[9] = 112;
  for (i = 0; i < 24; ++i) sltree.trans[i] = 256 + i;
  for (i = 0; i < 144; ++i) sltree.trans[24 + i] = i;
  for (i = 0; i < 8; ++i) sltree.trans[24 + 144 + i] = 280 + i;
  for (i = 0; i < 112; ++i) sltree.trans[24 + 144 + 8 + i] = 144 + i;
  for (i = 0; i < 5; ++i) sdtree.table[i] = 0;
  sdtree.table[5] = 32;
  for (i = 0; i < 32; ++i) sdtree.trans[i] = i;
})();

function buildTree(t: Tree, lengths: Uint8Array, off: number, num: number): void {
  const offs = new Uint16Array(16);
  let i: number;
  for (i = 0; i < 16; ++i) t.table[i] = 0;
  for (i = 0; i < num; ++i) t.table[lengths[off + i]!]++;
  t.table[0] = 0;
  let sum = 0;
  for (i = 0; i < 16; ++i) { offs[i] = sum; sum += t.table[i]!; }
  for (i = 0; i < num; ++i) if (lengths[off + i]) t.trans[offs[lengths[off + i]!]!++] = i;
}

class InflateData {
  s: Uint8Array; i = 0; t = 0; bitcount = 0;
  dest: Uint8Array; destLen = 0;
  ltree = new Tree(); dtree = new Tree();
  constructor(source: Uint8Array, dest: Uint8Array) { this.s = source; this.dest = dest; }
}
function getBit(d: InflateData): number {
  if (!d.bitcount--) { d.t = d.s[d.i++] ?? 0; d.bitcount = 7; }
  const bit = d.t & 1; d.t >>>= 1; return bit;
}
function readBits(d: InflateData, num: number, base: number): number {
  if (!num) return base;
  while (d.bitcount < 24) { d.t |= (d.s[d.i++] ?? 0) << d.bitcount; d.bitcount += 8; }
  const val = d.t & (0xffff >>> (16 - num));
  d.t >>>= num; d.bitcount -= num;
  return val + base;
}
function decodeSymbol(d: InflateData, t: Tree): number {
  while (d.bitcount < 24) { d.t |= (d.s[d.i++] ?? 0) << d.bitcount; d.bitcount += 8; }
  let sum = 0, cur = 0, len = 0;
  let tag = d.t;
  do { cur = 2 * cur + (tag & 1); tag >>>= 1; ++len; sum += t.table[len]!; cur -= t.table[len]!; } while (cur >= 0);
  d.t = tag; d.bitcount -= len;
  return t.trans[sum + cur]!;
}
function decodeTrees(d: InflateData, lt: Tree, dt: Tree): void {
  const lengths = new Uint8Array(288 + 32);
  const hlit = readBits(d, 5, 257);
  const hdist = readBits(d, 5, 1);
  const hclen = readBits(d, 4, 4);
  let i: number;
  for (i = 0; i < 19; ++i) lengths[CLCIDX[i]!] = 0;
  for (i = 0; i < hclen; ++i) lengths[CLCIDX[i]!] = readBits(d, 3, 0);
  buildTree(codeTree, lengths, 0, 19);
  for (let num = 0; num < hlit + hdist;) {
    const sym = decodeSymbol(d, codeTree);
    if (sym === 16) { const prev = lengths[num - 1]!; for (let l = readBits(d, 2, 3); l; --l) lengths[num++] = prev; }
    else if (sym === 17) { for (let l = readBits(d, 3, 3); l; --l) lengths[num++] = 0; }
    else if (sym === 18) { for (let l = readBits(d, 7, 11); l; --l) lengths[num++] = 0; }
    else lengths[num++] = sym;
  }
  buildTree(lt, lengths, 0, hlit);
  buildTree(dt, lengths, hlit, hdist);
}
function inflateBlockData(d: InflateData, lt: Tree, dt: Tree): void {
  for (;;) {
    let sym = decodeSymbol(d, lt);
    if (sym === 256) return;
    if (sym < 256) { d.dest[d.destLen++] = sym; continue; }
    sym -= 257;
    const length = readBits(d, LBITS[sym]!, LBASE[sym]!);
    const dsym = decodeSymbol(d, dt);
    const dist = readBits(d, DBITS[dsym]!, DBASE[dsym]!);
    const offs = d.destLen - dist;
    for (let i = 0; i < length; ++i) d.dest[d.destLen++] = d.dest[offs + i]!;
  }
}
function inflateUncompressed(d: InflateData): void {
  while (d.bitcount > 8) { d.i--; d.bitcount -= 8; }
  const length = d.s[d.i + 1]! * 256 + d.s[d.i]!;
  const invlength = d.s[d.i + 3]! * 256 + d.s[d.i + 2]!;
  if (length !== (~invlength & 0xffff)) throw new Error('inflate: bad stored block');
  d.i += 4;
  for (let i = length; i; --i) d.dest[d.destLen++] = d.s[d.i++]!;
  d.bitcount = 0;
}

/** raw DEFLATE を展開する (展開後サイズ既知)。 */
export function inflateRaw(source: Uint8Array, expectedLen: number): Uint8Array {
  const d = new InflateData(source, new Uint8Array(expectedLen));
  let bfinal: number;
  do {
    bfinal = getBit(d);
    const btype = readBits(d, 2, 0);
    if (btype === 0) inflateUncompressed(d);
    else if (btype === 1) inflateBlockData(d, sltree, sdtree);
    else if (btype === 2) { decodeTrees(d, d.ltree, d.dtree); inflateBlockData(d, d.ltree, d.dtree); }
    else throw new Error('inflate: bad block type');
  } while (!bfinal);
  return d.dest.subarray(0, d.destLen);
}

// ── ZIP 読込 ────────────────────────────────────────────────────────────────
function rd16(b: Uint8Array, o: number): number { return b[o]! | (b[o + 1]! << 8); }
function rd32(b: Uint8Array, o: number): number {
  return (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0;
}

/** ZIP を展開して { ファイル名 → バイト列 } を返す (STORED / DEFLATE 対応)。 */
function unzip(buf: ArrayBuffer): Map<string, Uint8Array> {
  const b = new Uint8Array(buf);
  let eocd = -1;
  for (let i = b.length - 22; i >= 0; i--) { if (rd32(b, i) === 0x06054b50) { eocd = i; break; } }
  if (eocd < 0) throw new Error('xlsx: ZIP ではありません');
  const count = rd16(b, eocd + 10);
  let p = rd32(b, eocd + 16);
  const out = new Map<string, Uint8Array>();
  const dec = new TextDecoder();
  for (let n = 0; n < count; n++) {
    if (rd32(b, p) !== 0x02014b50) break;
    const method = rd16(b, p + 10);
    const compSize = rd32(b, p + 20);
    const uncompSize = rd32(b, p + 24);
    const nameLen = rd16(b, p + 28);
    const extraLen = rd16(b, p + 30);
    const commentLen = rd16(b, p + 32);
    const localOff = rd32(b, p + 42);
    const name = dec.decode(b.subarray(p + 46, p + 46 + nameLen));
    const lNameLen = rd16(b, localOff + 26);
    const lExtraLen = rd16(b, localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const comp = b.subarray(dataStart, dataStart + compSize);
    if (method === 0) out.set(name, comp);
    else if (method === 8) out.set(name, inflateRaw(comp, uncompSize));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** zip のバイト列から最初の .csv エントリのテキストを取り出す (UTF-8)。無ければ null。 */
export function extractCsvTextFromZip(buf: ArrayBuffer): string | null {
  let files: Map<string, Uint8Array>;
  try { files = unzip(buf); } catch { return null; }
  for (const [name, data] of files) {
    if (/\.csv$/i.test(name)) return new TextDecoder('utf-8').decode(data);
  }
  return null;
}

// ── xlsx 読込 ────────────────────────────────────────────────────────────────
function collectText(inner: string): string {
  let s = '';
  for (const tm of inner.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)) s += tm[1];
  return xmlUnescape(s);
}

/** .xlsx (最初のワークシート) を { headers, rows } に読み込む。 */
export function parseXlsx(buf: ArrayBuffer): Sheet {
  const files = unzip(buf);
  const dec = new TextDecoder();

  // sharedStrings
  const shared: string[] = [];
  const ssBytes = files.get('xl/sharedStrings.xml');
  if (ssBytes) {
    const xml = dec.decode(ssBytes);
    for (const m of xml.matchAll(/<si>([\s\S]*?)<\/si>/g)) shared.push(collectText(m[1]!));
  }

  // 最初のワークシート
  let sheetKey: string | null = null;
  for (const k of files.keys()) if (/^xl\/worksheets\/sheet\d+\.xml$/i.test(k)) { sheetKey = k; break; }
  if (!sheetKey) return { headers: [], rows: [] };
  const xml = dec.decode(files.get(sheetKey)!);

  const grid: string[][] = [];
  for (const rm of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells: string[] = [];
    let auto = 0;
    for (const cm of rm[1]!.matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
      const attrs = cm[1]!;
      const inner = cm[2]!;
      const ref = /r="([A-Z]+)\d+"/.exec(attrs);
      const col = ref ? letterCol(ref[1]!) : auto;
      const t = /t="([^"]+)"/.exec(attrs)?.[1];
      let val = '';
      if (t === 'inlineStr') val = collectText(inner);
      else {
        const vm = /<v[^>]*>([\s\S]*?)<\/v>/.exec(inner);
        const raw = vm ? vm[1]! : '';
        val = t === 's' ? (shared[parseInt(raw, 10)] ?? '') : xmlUnescape(raw);
      }
      cells[col] = val;
      auto = col + 1;
    }
    grid.push(cells);
  }
  if (!grid.length) return { headers: [], rows: [] };

  const width = grid.reduce((m, r) => Math.max(m, r.length), 0);
  const headers: string[] = [];
  for (let c = 0; c < width; c++) headers.push((grid[0]![c] ?? '').trim() || `列${c + 1}`);
  const rows: Record<string, string>[] = [];
  for (let r = 1; r < grid.length; r++) {
    const obj: Record<string, string> = {};
    for (let c = 0; c < width; c++) obj[headers[c]!] = grid[r]![c] ?? '';
    rows.push(obj);
  }
  return { headers, rows };
}

/** ファイル拡張子で CSV / xlsx を判定して読み込む。 */
export async function parseSpreadsheetFile(file: File): Promise<Sheet> {
  if (/\.xlsx$/i.test(file.name)) return parseXlsx(await file.arrayBuffer());
  return parseCsv(await file.text());
}

/** Blob をファイルとしてダウンロードさせる。 */
export function downloadFile(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
