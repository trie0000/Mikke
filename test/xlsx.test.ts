import { describe, it, expect } from 'vitest';
import { deflateRawSync, gzipSync } from 'node:zlib';
import {
  toCsv, colLetter, letterCol, inflateRaw, buildXlsxBlob, parseXlsx,
} from '../src/lib/xlsx';

describe('toCsv', () => {
  it('BOM + カンマ/改行/引用符のエスケープ', () => {
    const csv = toCsv(['a', 'b'], [{ a: 'x,y', b: 'q"q' }, { a: '1\n2', b: '' }]);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    const lines = csv.slice(1).split('\r\n');
    expect(lines[0]).toBe('a,b');
    expect(lines[1]).toBe('"x,y","q""q"');
    expect(lines[2]).toBe('"1\n2",');
  });
});

describe('colLetter / letterCol', () => {
  it('相互変換', () => {
    for (const [n, s] of [[0, 'A'], [25, 'Z'], [26, 'AA'], [27, 'AB'], [701, 'ZZ'], [702, 'AAA']] as [number, string][]) {
      expect(colLetter(n)).toBe(s);
      expect(letterCol(s)).toBe(n);
    }
  });
});

describe('inflateRaw (Node の実 DEFLATE と一致)', () => {
  const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
  it('短い文字列', () => {
    const src = enc('hello world');
    const comp = deflateRawSync(Buffer.from(src));
    const out = inflateRaw(new Uint8Array(comp), src.length);
    expect(new TextDecoder().decode(out)).toBe('hello world');
  });
  it('反復の多いデータ (LZ77 バックリファレンス)', () => {
    const text = 'あいうえお,'.repeat(500) + 'x'.repeat(3000);
    const src = enc(text);
    const comp = deflateRawSync(Buffer.from(src), { level: 9 });
    const out = inflateRaw(new Uint8Array(comp), src.length);
    expect(new TextDecoder().decode(out)).toBe(text);
  });
  it('無圧縮(stored)ブロック (level 0)', () => {
    const src = enc('no-compression-block-'.repeat(50));
    const comp = deflateRawSync(Buffer.from(src), { level: 0 });
    const out = inflateRaw(new Uint8Array(comp), src.length);
    expect(new TextDecoder().decode(out)).toBe(new TextDecoder().decode(src));
  });
  it('ランダム風データ (動的ハフマン)', () => {
    let s = '';
    for (let i = 0; i < 2000; i++) s += String.fromCharCode(32 + ((i * 2654435761) % 90));
    const src = enc(s);
    const comp = deflateRawSync(Buffer.from(src), { level: 6 });
    expect(new TextDecoder().decode(inflateRaw(new Uint8Array(comp), src.length))).toBe(s);
    // gzip はヘッダ付きなので raw inflate では扱わない (境界確認のみ)
    expect(gzipSync(Buffer.from(src)).length).toBeGreaterThan(0);
  });
});

describe('buildXlsxBlob → parseXlsx (round-trip)', () => {
  const headers = ['資産', '事業会社', '管理番号', 'メモ'];
  const rows = [
    { 資産: 'www.example.com', 事業会社: 'エナジー', 管理番号: 'W-0001', メモ: 'a,b "c"\n次行' },
    { 資産: '10.0.0.1', 事業会社: '', 管理番号: 'W-0002', メモ: '' },
    { 資産: 'shop.example.com', 事業会社: 'デバイス', 管理番号: 'W-0003', メモ: '< & >' },
  ];

  async function roundTrip(): Promise<ReturnType<typeof parseXlsx>> {
    const blob = buildXlsxBlob(headers, rows, '資産');
    const buf = await blob.arrayBuffer();
    return parseXlsx(buf);
  }

  it('ヘッダと値が保存・復元される (特殊文字含む)', async () => {
    const sheet = await roundTrip();
    expect(sheet.headers).toEqual(headers);
    expect(sheet.rows).toHaveLength(3);
    expect(sheet.rows[0]).toEqual(rows[0]);
    expect(sheet.rows[1]!['事業会社']).toBe('');
    expect(sheet.rows[2]!['メモ']).toBe('< & >');
  });
});
