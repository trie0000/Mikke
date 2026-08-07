import { describe, it, expect } from 'vitest';
import { MGMT_STATUSES, DEFAULT_MGMT_STATUS, normalizeMgmtStatus } from '../src/types';
import { RESPONSE_STATUS_CHOICES, managedIssueFieldSpecs } from '../src/api/sp/schema';
import { toMgmtStatus } from '../src/lib/responseSync';

describe('対応ステータスの選択肢', () => {
  it('6 値ちょうど。通知の有無は含めない (「通知」列が担当)', () => {
    expect(MGMT_STATUSES).toEqual(['未着手', '対応中', '対応済み', 'リスク受容', '過検出', '対象外']);
  });

  it('連携用リストの「対応状況」と同じ値・同じ順序', () => {
    // 別々に並べると片方だけ直して取り込みが黙って落ちる。
    expect([...RESPONSE_STATUS_CHOICES]).toEqual([...MGMT_STATUSES]);
  });

  it('SP の MgmtStatus 列の選択肢もこの一覧から作られる', () => {
    const spec = managedIssueFieldSpecs().find((f) => f.name === 'MgmtStatus');
    expect(spec?.choices).toEqual([...MGMT_STATUSES]);
  });

  it('連携用リストの値はそのまま対応ステータスになる', () => {
    for (const s of MGMT_STATUSES) expect(toMgmtStatus(s)).toBe(s);
    expect(toMgmtStatus('知らない値')).toBeNull();
    expect(toMgmtStatus('')).toBeNull();
  });
});

describe('normalizeMgmtStatus: 旧値が残った既存データを読む', () => {
  it('旧値 未通知 / 通知 は 未着手 に畳む', () => {
    // 選択肢から外しても SP のアイテムには旧値が残っている。
    expect(normalizeMgmtStatus('未通知')).toBe('未着手');
    expect(normalizeMgmtStatus('通知')).toBe('未着手');
  });

  it('現行の値はそのまま', () => {
    for (const s of MGMT_STATUSES) expect(normalizeMgmtStatus(s)).toBe(s);
  });

  it('空・null・未知の値は既定値', () => {
    expect(normalizeMgmtStatus(undefined)).toBe(DEFAULT_MGMT_STATUS);
    expect(normalizeMgmtStatus(null)).toBe(DEFAULT_MGMT_STATUS);
    expect(normalizeMgmtStatus('')).toBe(DEFAULT_MGMT_STATUS);
    expect(normalizeMgmtStatus('なにか')).toBe(DEFAULT_MGMT_STATUS);
  });
});
