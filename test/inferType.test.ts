import { describe, it, expect } from 'vitest';
import { inferColumnType, inferTemplate } from '../src/lib/inferType';

describe('inferColumnType', () => {
  it('空文字は text', () => {
    expect(inferColumnType('')).toBe('text');
    expect(inferColumnType('   ')).toBe('text');
  });

  it('真偽', () => {
    for (const v of ['true', 'false', 'TRUE', 'Yes', 'no']) {
      expect(inferColumnType(v)).toBe('boolean');
    }
  });

  it('数値 (整数 / 小数 / 符号 / 桁区切り)', () => {
    expect(inferColumnType('0')).toBe('number');
    expect(inferColumnType('42')).toBe('number');
    expect(inferColumnType('-7')).toBe('number');
    expect(inferColumnType('9.8')).toBe('number');     // CVSS スコア等
    expect(inferColumnType('1,234')).toBe('number');
    expect(inferColumnType('12,345.67')).toBe('number');
  });

  it('日付', () => {
    expect(inferColumnType('2026-06-03')).toBe('date');
    expect(inferColumnType('2026/6/3')).toBe('date');
    expect(inferColumnType('06/03/2026')).toBe('date');
  });

  it('日時', () => {
    expect(inferColumnType('2026-06-03T10:30:00')).toBe('datetime');
    expect(inferColumnType('2026-06-03 10:30')).toBe('datetime');
    expect(inferColumnType('2026/6/3 9:05:12')).toBe('datetime');
  });

  it('長文 (255 超)', () => {
    expect(inferColumnType('a'.repeat(256))).toBe('longtext');
    expect(inferColumnType('a'.repeat(255))).toBe('text');
  });

  it('テキスト (ID / 製品名 / 深刻度ラベル)', () => {
    expect(inferColumnType('ABC-123')).toBe('text');
    expect(inferColumnType('Critical')).toBe('text');
    expect(inferColumnType('CVE-2011-3389')).toBe('text');
    expect(inferColumnType('admin.example.com')).toBe('text');
  });
});

describe('inferTemplate', () => {
  it('ヘッダ + サンプル行から列定義を作る', () => {
    const headers = ['Issue Instance ID', 'Severity', 'CVSS', 'First Seen', 'Active'];
    const row = {
      'Issue Instance ID': 'ABC-1',
      'Severity': 'Critical',
      'CVSS': '9.8',
      'First Seen': '2026-06-03',
      'Active': 'true',
    };
    const cols = inferTemplate(headers, row);
    expect(cols).toEqual([
      { name: 'Issue Instance ID', sample: 'ABC-1', type: 'text' },
      { name: 'Severity', sample: 'Critical', type: 'text' },
      { name: 'CVSS', sample: '9.8', type: 'number' },
      { name: 'First Seen', sample: '2026-06-03', type: 'date' },
      { name: 'Active', sample: 'true', type: 'boolean' },
    ]);
  });

  it('サンプル行なし (ヘッダのみ) は全て text', () => {
    const cols = inferTemplate(['A', 'B'], undefined);
    expect(cols.map((c) => c.type)).toEqual(['text', 'text']);
    expect(cols.map((c) => c.sample)).toEqual(['', '']);
  });

  it('空ヘッダは除外', () => {
    const cols = inferTemplate(['A', '', '  '], { A: '1' });
    expect(cols.map((c) => c.name)).toEqual(['A']);
  });
});
