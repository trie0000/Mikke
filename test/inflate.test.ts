import { describe, it, expect } from 'vitest';
import zlib from 'node:zlib';
import { inflateRaw, parseXlsxSheet } from '../src/lib/xlsx';

/** シート XML だけを持つ最小の xlsx を組み立てて読ませる。 */
function rowsOf(sheetXml: string): Record<string, string>[] {
  const files: [string, string][] = [
    ['[Content_Types].xml', '<Types/>'],
    ['_rels/.rels', '<Relationships/>'],
    ['xl/workbook.xml',
      '<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
      + '<sheets><sheet name="list" sheetId="1" r:id="rId1"/></sheets></workbook>'],
    ['xl/_rels/workbook.xml.rels',
      '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>'],
    ['xl/worksheets/sheet1.xml', sheetXml],
  ];
  return parseXlsxSheet(buildZip(files), 'list')!.rows;
}

/** 無圧縮 (STORED) の ZIP を組み立てる。 */
function buildZip(files: [string, string][]): ArrayBuffer {
  const enc = new TextEncoder();
  const locals: Uint8Array[] = []; const central: Uint8Array[] = [];
  let offset = 0;
  const crcTable = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
    return t;
  })();
  const crc32 = (b: Uint8Array): number => {
    let c = 0xffffffff;
    for (let i = 0; i < b.length; i++) c = crcTable[(c ^ b[i]!) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const w = (n: number, bytes: number): number[] => {
    const out: number[] = [];
    for (let i = 0; i < bytes; i++) out.push((n >>> (i * 8)) & 0xff);
    return out;
  };
  for (const [name, content] of files) {
    const nameB = enc.encode(name); const data = enc.encode(content);
    const c = crc32(data);
    const local = new Uint8Array([...w(0x04034b50, 4), ...w(20, 2), ...w(0, 2), ...w(0, 2), ...w(0, 2), ...w(0, 2),
      ...w(c, 4), ...w(data.length, 4), ...w(data.length, 4), ...w(nameB.length, 2), ...w(0, 2), ...nameB, ...data]);
    locals.push(local);
    central.push(new Uint8Array([...w(0x02014b50, 4), ...w(20, 2), ...w(20, 2), ...w(0, 2), ...w(0, 2), ...w(0, 2), ...w(0, 2),
      ...w(c, 4), ...w(data.length, 4), ...w(data.length, 4), ...w(nameB.length, 2), ...w(0, 2), ...w(0, 2),
      ...w(0, 2), ...w(0, 2), ...w(0, 4), ...w(offset, 4), ...nameB]));
    offset += local.length;
  }
  const cdSize = central.reduce((s, x) => s + x.length, 0);
  const eocd = new Uint8Array([...w(0x06054b50, 4), ...w(0, 2), ...w(0, 2),
    ...w(files.length, 2), ...w(files.length, 2), ...w(cdSize, 4), ...w(offset, 4), ...w(0, 2)]);
  const total = offset + cdSize + eocd.length;
  const out = new Uint8Array(total);
  let p = 0;
  for (const b of [...locals, ...central, eocd]) { out.set(b, p); p += b.length; }
  return out.buffer;
}

// xlsx は ZIP なので、読み込みは自前の inflate を通る。
// ★ 実際に踏んだ事故: Excel から出したブックで
//     「読み込みに失敗しました。inflate: bad stored block」
//   になった。stored (無圧縮) ブロックの手前でバイト境界に戻すとき、
//   溜めていたビットのうち最後の 1 バイトを戻し損ねていた。
//   readBits / decodeSymbol は 24 ビット以上まとめて先読みするため、
//   この関数に来るときの bitcount は 22〜29。8 の倍数になるのは 24 だけなので、
//   **bitcount が 24 のときだけ** LEN/NLEN を 1 バイト後ろから読んでいた。

const deflate = (buf: Buffer, opts: zlib.ZlibOptions = {}): Uint8Array =>
  new Uint8Array(zlib.deflateRawSync(buf, opts));

/** 決定的な擬似乱数 (テストを再現可能にする)。 */
function prng(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 0x100000000; };
}

function sample(len: number, compressibleUpTo: number, rnd: () => number, variety: number): Buffer {
  const b = Buffer.alloc(len);
  for (let i = 0; i < len; i++) {
    b[i] = i < compressibleUpTo ? 65 + (i % variety) : Math.floor(rnd() * 256);
  }
  return b;
}

describe('inflate: zlib と同じ結果になる', () => {
  it('★ stored ブロックがバイト境界の切り上がりに当たっても壊れない', () => {
    // 圧縮できる部分と圧縮できない部分を混ぜると stored ブロックが出る。
    // 修正前はこの組み合わせのどこかで 'bad stored block' になっていた。
    const rnd = prng(20260813);
    const strategies = [
      zlib.constants.Z_DEFAULT_STRATEGY, zlib.constants.Z_FIXED,
      zlib.constants.Z_HUFFMAN_ONLY, zlib.constants.Z_RLE,
    ];
    let checked = 0;
    for (let n = 0; n < 600; n++) {
      const len = 20 + Math.floor(rnd() * 900);
      const buf = sample(len, Math.floor(rnd() * len), rnd, 1 + (n % 5));
      const comp = deflate(buf, {
        level: 1 + (n % 9), strategy: strategies[n % strategies.length], memLevel: 1 + (n % 9),
      });
      expect(Buffer.from(inflateRaw(comp, buf.length))).toEqual(buf);
      checked++;
    }
    expect(checked).toBe(600);
  });

  it('無圧縮 (level 0) は全部 stored ブロックになる', () => {
    const rnd = prng(7);
    const buf = sample(50_000, 0, rnd, 1);
    expect(Buffer.from(inflateRaw(deflate(buf, { level: 0 }), buf.length))).toEqual(buf);
  });

  it('固定ハフマン / 動的ハフマンのどちらも展開できる', () => {
    const text = Buffer.from('<row><c t="inlineStr"><is><t>値</t></is></c></row>'.repeat(300));
    for (const strategy of [zlib.constants.Z_FIXED, zlib.constants.Z_DEFAULT_STRATEGY]) {
      expect(Buffer.from(inflateRaw(deflate(text, { strategy, level: 9 }), text.length))).toEqual(text);
    }
  });

  it('大きめのデータでも一致する', () => {
    const rnd = prng(99);
    const buf = sample(300_000, 150_000, rnd, 3);
    expect(Buffer.from(inflateRaw(deflate(buf, { level: 6 }), buf.length))).toEqual(buf);
  });

  it('空データ', () => {
    const buf = Buffer.alloc(0);
    expect(Buffer.from(inflateRaw(deflate(buf), 0))).toEqual(buf);
  });
});

describe('数式セルは値 (キャッシュ結果) で読む', () => {
  // 別シート参照の XLOOKUP でも、Excel が保存時に書いた結果が <v> に入っている。
  const cell = (r: string, t: string, inner: string): string =>
    `<c r="${r}"${t ? ` t="${t}"` : ''}>${inner}</c>`;
  const sheet = (rows: string): string =>
    `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">`
    + `<sheetData>${rows}</sheetData></worksheet>`;

  it('t="str" (数式の文字列結果) は <v> を読む', () => {
    const xml = sheet(
      `<row r="1">${cell('A1', 'inlineStr', '<is><t>会社</t></is>')}</row>`
      + `<row r="2">${cell('A2', 'str', '<f>_xlfn.XLOOKUP(B2,master!A:A,master!B:B)</f><v>エナジー</v>')}</row>`);
    expect(rowsOf(xml)).toEqual([{ 会社: 'エナジー' }]);
  });

  it('共有数式 (<f t="shared" .../>) でも値を読む', () => {
    const xml = sheet(
      `<row r="1">${cell('A1', 'inlineStr', '<is><t>会社</t></is>')}</row>`
      + `<row r="2">${cell('A2', 'str', '<f t="shared" si="0"/><v>モビリティ</v>')}</row>`);
    expect(rowsOf(xml)).toEqual([{ 会社: 'モビリティ' }]);
  });

  it('真偽値は Excel の見た目に合わせる', () => {
    const xml = sheet(
      `<row r="1">${cell('A1', 'inlineStr', '<is><t>動的</t></is>')}</row>`
      + `<row r="2">${cell('A2', 'b', '<f>ISNUMBER(B2)</f><v>1</v>')}</row>`
      + `<row r="3">${cell('A3', 'b', '<v>0</v>')}</row>`);
    expect(rowsOf(xml)).toEqual([{ 動的: 'TRUE' }, { 動的: 'FALSE' }]);
  });

  it('数値の数式結果', () => {
    const xml = sheet(
      `<row r="1">${cell('A1', 'inlineStr', '<is><t>件数</t></is>')}</row>`
      + `<row r="2">${cell('A2', '', '<f>SUM(master!C:C)</f><v>42</v>')}</row>`);
    expect(rowsOf(xml)).toEqual([{ 件数: '42' }]);
  });
});

describe('テーブルオブジェクトの見出し行を見る', () => {
  // ★ 実際に踏んだ事故: 「全ての列で見つからない列がありますと出る」。
  //   Excel のテーブルは 1 行目から始まるとは限らず、上に表題行があることが多い。
  //   1 行目を見出しと決め打ちしていたため、表題行を見出しとして読んでいた。
  const withTable = (ref: string, headerRowCount = 1): Record<string, string>[] => {
    const sheetXml =
      '<?xml version="1.0"?><worksheet xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheetData>'
      + '<row r="1"><c r="A1" t="inlineStr"><is><t>脆弱性管理台帳</t></is></c></row>'
      + '<row r="2"><c r="A2" t="inlineStr"><is><t>最終更新 2026-08-01</t></is></c></row>'
      + '<row r="3"><c r="B3" t="inlineStr"><is><t>Issue ID</t></is></c>'
      + '<c r="C3" t="inlineStr"><is><t>事業会社</t></is></c></row>'
      + '<row r="4"><c r="B4" t="inlineStr"><is><t>IID-1</t></is></c>'
      + '<c r="C4" t="inlineStr"><is><t>ENG</t></is></c></row>'
      + '</sheetData><tableParts count="1"><tablePart r:id="rId1"/></tableParts></worksheet>';
    const tableXml = `<table ref="${ref}" headerRowCount="${headerRowCount}">`
      + '<tableColumns><tableColumn name="Issue ID"/><tableColumn name="事業会社"/></tableColumns></table>';
    return parseXlsxSheet(buildZip([
      ['[Content_Types].xml', '<Types/>'],
      ['_rels/.rels', '<Relationships/>'],
      ['xl/workbook.xml',
        '<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
        + '<sheets><sheet name="list" sheetId="1" r:id="rId1"/></sheets></workbook>'],
      ['xl/_rels/workbook.xml.rels',
        '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>'],
      ['xl/worksheets/sheet1.xml', sheetXml],
      ['xl/worksheets/_rels/sheet1.xml.rels',
        '<Relationships><Relationship Id="rId1" Target="../tables/table1.xml"/></Relationships>'],
      ['xl/tables/table1.xml', tableXml],
    ]), 'list')!.rows;
  };

  it('★ 表題行を飛ばし、テーブルの見出し行から読む', () => {
    expect(withTable('B3:C4')).toEqual([{ 'Issue ID': 'IID-1', 事業会社: 'ENG' }]);
  });

  it('テーブルの範囲外 (表題行) はデータに入れない', () => {
    expect(withTable('B3:C4')).toHaveLength(1);
  });

  it('テーブル定義が無いブックは、最初の中身のある行を見出しにする', () => {
    // 1 セルだけの表題行は見出しにしない (2 セル以上ある行を探す)。
    const sheetXml =
      '<?xml version="1.0"?><worksheet><sheetData>'
      + '<row r="1"><c r="A1" t="inlineStr"><is><t>表題だけの行</t></is></c></row>'
      + '<row r="3"><c r="A3" t="inlineStr"><is><t>Issue ID</t></is></c>'
      + '<c r="B3" t="inlineStr"><is><t>事業会社</t></is></c></row>'
      + '<row r="4"><c r="A4" t="inlineStr"><is><t>IID-9</t></is></c>'
      + '<c r="B4" t="inlineStr"><is><t>MOB</t></is></c></row>'
      + '</sheetData></worksheet>';
    const rows = parseXlsxSheet(buildZip([
      ['[Content_Types].xml', '<Types/>'],
      ['_rels/.rels', '<Relationships/>'],
      ['xl/workbook.xml',
        '<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
        + '<sheets><sheet name="list" sheetId="1" r:id="rId1"/></sheets></workbook>'],
      ['xl/_rels/workbook.xml.rels',
        '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>'],
      ['xl/worksheets/sheet1.xml', sheetXml],
    ]), 'list')!.rows;
    expect(rows).toEqual([{ 'Issue ID': 'IID-9', 事業会社: 'MOB' }]);
  });
});
