import { describe, it, expect } from 'vitest';
import { parseCsv } from '../src/lib/csv';

describe('csv: 基本パース', () => {
  it('ヘッダと行を連想配列で返す', () => {
    const { headers, rows } = parseCsv('a,b,c\n1,2,3\n4,5,6');
    expect(headers).toEqual(['a', 'b', 'c']);
    expect(rows).toEqual([
      { a: '1', b: '2', c: '3' },
      { a: '4', b: '5', c: '6' },
    ]);
  });

  it('BOM を除去する', () => {
    const { headers } = parseCsv('﻿a,b\n1,2');
    expect(headers).toEqual(['a', 'b']);
  });

  it('CRLF を扱える', () => {
    const { rows } = parseCsv('a,b\r\n1,2\r\n3,4');
    expect(rows).toEqual([{ a: '1', b: '2' }, { a: '3', b: '4' }]);
  });

  it('ダブルクォート内のカンマを保持', () => {
    const { rows } = parseCsv('a,b\n"x,y",z');
    expect(rows[0]).toEqual({ a: 'x,y', b: 'z' });
  });

  it('エスケープされたダブルクォート', () => {
    const { rows } = parseCsv('a\n"he said ""hi"""');
    expect(rows[0]!.a).toBe('he said "hi"');
  });

  it('クォート内の改行を保持', () => {
    const { rows } = parseCsv('a,b\n"line1\nline2",z');
    expect(rows[0]).toEqual({ a: 'line1\nline2', b: 'z' });
  });

  it('空 CSV は空配列', () => {
    expect(parseCsv('')).toEqual({ headers: [], rows: [] });
  });

  it('ヘッダのみは行0件', () => {
    const { headers, rows } = parseCsv('a,b,c');
    expect(headers).toEqual(['a', 'b', 'c']);
    expect(rows).toEqual([]);
  });

  it('末尾改行で空行を作らない', () => {
    const { rows } = parseCsv('a\n1\n2\n');
    expect(rows).toEqual([{ a: '1' }, { a: '2' }]);
  });
});
