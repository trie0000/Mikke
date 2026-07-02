import { describe, it, expect } from 'vitest';
import { scanFieldName, scanDisplayMap, fnv1aHex, decodeSpInternalName, resolveScanValue } from '../src/lib/scanName';

describe('scanFieldName', () => {
  it('決定的 (同じ入力は常に同じ出力)', () => {
    expect(scanFieldName('First Seen')).toBe(scanFieldName('First Seen'));
  });

  it('Scan_ 接頭辞の有無で同じ名前になる', () => {
    expect(scanFieldName('First Seen')).toBe(scanFieldName('Scan_First Seen'));
  });

  it('SP で安全な ASCII 名 (英数字と _ のみ)', () => {
    for (const col of ['First Seen', '深刻度', 'CVSS', 'Issue Instance ID', 'a/b\\c:d']) {
      expect(scanFieldName(col)).toMatch(/^Scan_[A-Za-z0-9]*_[0-9a-f]{4}$/);
    }
  });

  it('スペース・日本語は除去されハッシュで区別される', () => {
    expect(scanFieldName('First Seen')).toMatch(/^Scan_FirstSeen_[0-9a-f]{4}$/);
    expect(scanFieldName('深刻度')).toMatch(/^Scan__[0-9a-f]{4}$/);
    // ascii 部分が同じでも元名が違えばハッシュで衝突しない
    expect(scanFieldName('深刻度')).not.toBe(scanFieldName('重要度'));
  });

  it('長い列名は ascii 部分が 18 文字に切り詰められる', () => {
    const n = scanFieldName('AVeryLongColumnNameThatExceedsTheLimit');
    expect(n.length).toBeLessThanOrEqual('Scan_'.length + 18 + 1 + 4);
  });

  it('冪等 (安全名を再変換しても変わらない = 二重変換バグ防止)', () => {
    for (const col of ['First Seen', 'CVSS', '深刻度']) {
      const safe = scanFieldName(col);
      expect(scanFieldName(safe)).toBe(safe);
    }
  });
});

describe('resolveScanValue', () => {
  const headers = ['Issue Instance ID', 'First Seen', 'CVE'];
  it('SP 安全名キーで引ける', () => {
    const sf = { [scanFieldName('First Seen')]: '2026-05-01' };
    expect(resolveScanValue(sf, 'Scan_First Seen', headers)).toBe('2026-05-01');
  });
  it('mock の Scan_元名キーで引ける', () => {
    const sf = { 'Scan_First Seen': '2026-05-01' };
    expect(resolveScanValue(sf, 'Scan_First Seen', headers)).toBe('2026-05-01');
  });
  it('raw キーに対し列名の表記揺れ (大文字小文字/空白) を正規化総当たりで吸収する', () => {
    // 実データは raw キー (Scan_<元名>) で保存される → 正規化総当たりで吸収
    const sf = { 'Scan_First Seen': '2026-05-01' };
    expect(resolveScanValue(sf, 'Scan_first  seen', headers)).toBe('2026-05-01');
    expect(resolveScanValue(sf, 'FIRST SEEN', headers)).toBe('2026-05-01');
  });
  it('SP エンコード済みキー (Scan_First_x0020_Seen) でも引ける', () => {
    const sf = { 'Scan_First_x0020_Seen': '2026-05-01' };
    expect(resolveScanValue(sf, 'Scan_First Seen', headers)).toBe('2026-05-01');
  });
  it('raw キー (Scan_Asset Dynamically resolved 等・スペース入り) を引ける', () => {
    const sf = { 'Scan_Asset Dynamically resolved': 'yes', 'Scan_Asset Mapped IP Addresses': '' };
    expect(resolveScanValue(sf, 'Scan_Asset Dynamically resolved', headers)).toBe('yes');
    // 値が空のキーは存在しても undefined 相当 (表示は「—」になる)
    expect(resolveScanValue(sf, 'Scan_Asset Mapped IP Addresses', headers) || '—').toBe('—');
  });
  it('どこにも無ければ undefined', () => {
    expect(resolveScanValue({ 'Scan_X_0000': 'v' }, 'Scan_Nope', headers)).toBeUndefined();
    expect(resolveScanValue(undefined, 'Scan_First Seen', headers)).toBeUndefined();
  });
});

describe('scanDisplayMap', () => {
  it('SP 列名 → 元の列名 の逆引きを作る', () => {
    const map = scanDisplayMap(['Scan_First Seen', 'Scan_CVSS']);
    expect(map[scanFieldName('First Seen')]).toBe('First Seen');
    expect(map[scanFieldName('CVSS')]).toBe('CVSS');
  });
});

describe('decodeSpInternalName', () => {
  it('SP の _xXXXX_ エンコードを文字に戻す', () => {
    expect(decodeSpInternalName('First_x0020_Seen')).toBe('First Seen');
    expect(decodeSpInternalName('x005F_First_x0020_Seen')).toBe('_First Seen');
    expect(decodeSpInternalName('_x65e5__x4ed8_')).toBe('日付');
  });
  it('エンコードが無ければそのまま', () => {
    expect(decodeSpInternalName('CVSS')).toBe('CVSS');
  });
});

describe('fnv1aHex', () => {
  it('決定的な 8 桁 hex', () => {
    expect(fnv1aHex('abc')).toMatch(/^[0-9a-f]{8}$/);
    expect(fnv1aHex('abc')).toBe(fnv1aHex('abc'));
    expect(fnv1aHex('abc')).not.toBe(fnv1aHex('abd'));
  });
});
