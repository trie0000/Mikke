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
  // ★ バイト境界まで戻す。
  //   readBits / decodeSymbol は 1 バイトずつではなく **24 ビット以上まとめて**
  //   先読みするので、ここに来た時点で d.t には最大 31 ビット分が溜まっている。
  //   丸ごと残っているバイト数だけ i を巻き戻し、半端なビットは捨てる
  //   (stored ブロックはバイト境界から始まる)。
  //   旧実装は while (bitcount > 8) { i--; bitcount -= 8 } で、bitcount が
  //   8 の倍数のとき最後の 1 バイトを戻し損ねていた。この関数に来るときの
  //   bitcount は必ず 22〜29 なので **24 のときだけ** 1 バイトずれ、
  //   LEN/NLEN を 1 バイト後ろから読んで 'bad stored block' になっていた。
  d.i -= d.bitcount >> 3;
  d.bitcount = 0;
  d.t = 0;               // 溜めていたビットは使わない (残すと次の読み出しが濁る)
  const length = d.s[d.i + 1]! * 256 + d.s[d.i]!;
  const invlength = d.s[d.i + 3]! * 256 + d.s[d.i + 2]!;
  if (length !== (~invlength & 0xffff)) throw new Error('inflate: bad stored block');
  d.i += 4;
  for (let i = length; i; --i) d.dest[d.destLen++] = d.s[d.i++]!;
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
  // ★ 日本語のブックは <si> にふりがな (<rPh><t>…</t></rPh>) が入っている。
  //   これを拾うと「その他」が「その他タ」のように化けるので先に落とす。
  const body = inner.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '');
  let s = '';
  for (const tm of body.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)) s += tm[1];
  return xmlUnescape(s);
}

/** .xlsx (最初のワークシート) を { headers, rows } に読み込む。 */
/** ブック内のシート名一覧 (定義順)。 */
export function xlsxSheetNames(buf: ArrayBuffer): string[] {
  const files = unzip(buf);
  const wb = files.get('xl/workbook.xml');
  if (!wb) return [];
  const xml = new TextDecoder().decode(wb);
  return [...xml.matchAll(/<sheet\b[^>]*\bname="([^"]*)"/g)].map((m) => decodeXmlEntities(m[1]!));
}

/** XML の実体参照を戻す (シート名に & や < が入り得る)。 */
function decodeXmlEntities(s: string): string {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

/**
 * シート名を指定して読む。見つからなければ null。
 * ★ ワークシートの実ファイル名 (sheet1.xml など) は定義順と一致しないことがあるので、
 *   workbook.xml の r:id → workbook.xml.rels の Target で辿る。
 *   辿れないブックでは定義順のインデックスで代替する。
 */
export function parseXlsxSheet(buf: ArrayBuffer, sheetName: string): Sheet | null {
  const files = unzip(buf);
  const dec = new TextDecoder();
  const wb = files.get('xl/workbook.xml');
  if (!wb) return null;
  const wbXml = dec.decode(wb);
  const sheets = [...wbXml.matchAll(/<sheet\b([^>]*)>/g)].map((m) => ({
    name: decodeXmlEntities(/\bname="([^"]*)"/.exec(m[1]!)?.[1] ?? ''),
    rid: /\br:id="([^"]*)"/.exec(m[1]!)?.[1] ?? '',
  }));
  const want = sheets.findIndex((x) => x.name === sheetName);
  if (want < 0) return null;

  let target = '';
  const rels = files.get('xl/_rels/workbook.xml.rels');
  if (rels && sheets[want]!.rid) {
    const rx = new RegExp(`<Relationship\\b[^>]*\\bId="${sheets[want]!.rid}"[^>]*\\bTarget="([^"]*)"`);
    target = rx.exec(dec.decode(rels))?.[1] ?? '';
  }
  let key = target ? `xl/${target.replace(/^\/?(xl\/)?/, '')}` : '';
  if (!key || !files.has(key)) {
    // rels を辿れないブック向けのフォールバック (定義順 = ファイル番号順とみなす)
    const all = [...files.keys()].filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(k))
      .sort((a, b) => Number(/(\d+)/.exec(a)![1]) - Number(/(\d+)/.exec(b)![1]));
    key = all[want] ?? '';
  }
  if (!key || !files.has(key)) return null;
  return sheetFrom(files, dec.decode(files.get(key)!), readTableDef(files, key));
}

/** ワークシート XML → Sheet。sharedStrings はブック共通なので files から引く。 */
/** セル参照 (A1 / AB12) を 0 始まりの列・行に分解する。 */
function refToRC(ref: string): { col: number; row: number } | null {
  const m = /^([A-Z]+)(\d+)$/.exec(ref.trim().toUpperCase());
  if (!m) return null;
  return { col: letterCol(m[1]!), row: parseInt(m[2]!, 10) - 1 };
}

/** テーブルオブジェクトの定義 (見出し行の位置と列名)。 */
interface TableDef { top: number; left: number; right: number; bottom: number; names: string[] }

/**
 * ワークシートに紐づくテーブルオブジェクトを読む。
 * ★ Excel の「テーブル」は 1 行目から始まるとは限らない (上に表題や説明行がある)。
 *   ref="A3:AB500" のような範囲と列名が xl/tables/tableN.xml に入っているので、
 *   そこから見出し行を決める。これを見ないと表題行を見出しとして読んでしまい、
 *   「全ての列が見つからない」ことになる。
 */
function readTableDef(files: Map<string, Uint8Array>, sheetKey: string): TableDef | null {
  const dec = new TextDecoder();
  const sheetXml = dec.decode(files.get(sheetKey)!);
  if (!/<tableParts\b/.test(sheetXml)) return null;
  const relKey = sheetKey.replace(/^(.*\/)([^/]+)$/, '$1_rels/$2.rels');
  const relBytes = files.get(relKey);
  if (!relBytes) return null;
  const relXml = dec.decode(relBytes);
  for (const pm of sheetXml.matchAll(/<tablePart\b[^>]*r:id="([^"]+)"/g)) {
    const rx = new RegExp(`<Relationship\\b[^>]*\\bId="${pm[1]!}"[^>]*\\bTarget="([^"]*)"`);
    const target = rx.exec(relXml)?.[1];
    if (!target) continue;
    // Target は "../tables/table1.xml" のような相対パス
    const key = `xl/${target.replace(/^(\.\.\/)+/, '').replace(/^\/?(xl\/)?/, '')}`;
    const tBytes = files.get(key);
    if (!tBytes) continue;
    const tXml = dec.decode(tBytes);
    const ref = /<table\b[^>]*\bref="([^"]+)"/.exec(tXml)?.[1];
    if (!ref) continue;
    const [a, b] = ref.split(':');
    const tl = refToRC(a ?? ''); const br = refToRC(b ?? a ?? '');
    if (!tl || !br) continue;
    const headerRowCount = Number(/<table\b[^>]*\bheaderRowCount="(\d+)"/.exec(tXml)?.[1] ?? '1');
    if (headerRowCount < 1) continue;   // 見出し無しテーブルは扱わない
    const names = [...tXml.matchAll(/<tableColumn\b[^>]*\bname="([^"]*)"/g)]
      .map((m) => xmlUnescape(m[1]!));
    return { top: tl.row, left: tl.col, right: br.col, bottom: br.row, names };
  }
  return null;
}

/** 行番号つきのセル格子を作る (xlsx は空行を書かないので、絶対行で持つ)。 */
function readGrid(files: Map<string, Uint8Array>, xml: string): Map<number, string[]> {
  const dec = new TextDecoder();
  const shared: string[] = [];
  const ssBytes = files.get('xl/sharedStrings.xml');
  if (ssBytes) {
    const ss = dec.decode(ssBytes);
    // ★ 空文字列は <si/> と書かれることがある。これを飛ばすと以降の番号が 1 つずつ
    //   ずれ、全ての文字列セルが**別の列の値**に化ける。自己終了タグも 1 件として数える。
    for (const m of ss.matchAll(/<si\b[^>]*?(?:\/>|>([\s\S]*?)<\/si>)/g)) {
      shared.push(m[1] === undefined ? '' : collectText(m[1]));
    }
  }

  const grid = new Map<number, string[]>();
  let autoRow = 0;
  for (const rm of xml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const rAttr = /\br="(\d+)"/.exec(rm[1]!)?.[1];
    const rowIdx = rAttr ? parseInt(rAttr, 10) - 1 : autoRow;
    autoRow = rowIdx + 1;
    const cells: string[] = [];
    let auto = 0;
    // ★ 空セルは <c r="G5" s="12"/> と自己終了で書かれる。これを読み飛ばすと、
    //   r 属性を持たないブックで列がずれる (auto が進まない)。両方の形を拾う。
    for (const cm of (rm[2] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cm[1]!;
      const inner = cm[2] ?? '';
      const ref = /r="([A-Z]+)\d+"/.exec(attrs);
      const col = ref ? letterCol(ref[1]!) : auto;
      const t = /t="([^"]+)"/.exec(attrs)?.[1];
      let val = '';
      if (t === 'inlineStr') val = collectText(inner);
      else {
        // ★ 数式セル (<f>XLOOKUP(...)</f><v>結果</v>) は **キャッシュされた値** を読む。
        //   別シート参照でも、Excel が保存時に書いた結果がここに入っている。
        //   t の意味: 's'=共有文字列の番号 / 'str'=数式の文字列結果 /
        //   'b'=真偽 (1/0) / 'e'=エラー (#N/A 等) / 無し=数値。
        const vm = /<v[^>]*>([\s\S]*?)<\/v>/.exec(inner);
        const raw = vm ? vm[1]! : '';
        if (t === 's') val = shared[parseInt(raw, 10)] ?? '';
        else if (t === 'b') val = raw === '1' ? 'TRUE' : 'FALSE';   // Excel の見た目に合わせる
        else val = xmlUnescape(raw);
      }
      cells[col] = val;
      auto = col + 1;
    }
    grid.set(rowIdx, cells);
  }
  return grid;
}

/** 見出しらしい最初の行 (テーブル定義が無いブック向け)。 */
function guessHeaderRow(grid: Map<number, string[]>): number {
  const rows = [...grid.keys()].sort((a, b) => a - b);
  for (const r of rows) {
    const filled = (grid.get(r) ?? []).filter((v) => (v ?? '').trim()).length;
    if (filled >= 2) return r;     // 表題行 (1 セルだけ) は飛ばす
  }
  return rows[0] ?? 0;
}

function sheetFrom(files: Map<string, Uint8Array>, xml: string, table: TableDef | null): Sheet {
  const grid = readGrid(files, xml);
  if (!grid.size) return { headers: [], rows: [] };

  const maxRow = Math.max(...grid.keys());
  const width = Math.max(...[...grid.values()].map((r) => r.length), 0);
  const headerRow = table ? table.top : guessHeaderRow(grid);
  const left = table ? table.left : 0;
  const right = table ? table.right : width - 1;
  const bottom = table ? Math.min(table.bottom, maxRow) : maxRow;

  const headerCells = grid.get(headerRow) ?? [];
  const headers: string[] = [];
  for (let c = left; c <= right; c++) {
    // ★ 列名は **見出しセルの文字** を優先する。ユーザーが Excel で見ている名前が
    //   これであり、列の対応付けもその名前で書いてあるため。
    //   tableColumn の name は他ツールが書き換えると実際のセルとずれることがあり、
    //   ずれたまま優先すると「別の列の値が入る」ことになる。空のときだけ使う。
    const fromCell = (headerCells[c] ?? '').trim();
    const fromTable = (table?.names[c - left] ?? '').trim();
    headers.push(fromCell || fromTable || `列${c + 1}`);
  }

  const rows: Record<string, string>[] = [];
  for (let r = headerRow + 1; r <= bottom; r++) {
    const cells = grid.get(r);
    if (!cells) continue;                       // 空行は飛ばす
    const obj: Record<string, string> = {};
    let any = false;
    for (let c = left; c <= right; c++) {
      const v = cells[c] ?? '';
      obj[headers[c - left]!] = v;
      if (v.trim()) any = true;
    }
    if (any) rows.push(obj);                    // 全部空の行は入れない
  }
  return { headers, rows };
}

/** 最初のワークシートを読む (従来の入口)。 */
export function parseXlsx(buf: ArrayBuffer): Sheet {
  const files = unzip(buf);
  let sheetKey: string | null = null;
  for (const k of files.keys()) if (/^xl\/worksheets\/sheet\d+\.xml$/i.test(k)) { sheetKey = k; break; }
  if (!sheetKey) return { headers: [], rows: [] };
  return sheetFrom(files, new TextDecoder().decode(files.get(sheetKey)!), readTableDef(files, sheetKey));
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
