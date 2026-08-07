import { describe, it, expect } from 'vitest';
import { notifyStatusOf, NOTIFY_ORDER } from '../src/lib/notifyStatus';

const T1 = '2026-08-01T10:00:00Z';
const T2 = '2026-08-02T10:00:00Z';

describe('notifyStatusOf: 連携用リストと比べた通知ステータス', () => {
  it('連携用リストに該当アイテムが無ければ 未通知', () => {
    expect(notifyStatusOf(T1, undefined)).toBe('未通知');
    expect(notifyStatusOf(undefined, undefined)).toBe('未通知');
  });

  it('Mikke 側が後から更新されていれば 差分あり', () => {
    expect(notifyStatusOf(T2, T1)).toBe('差分あり');
  });

  it('連携用リストの方が新しい / 同時刻なら 同期済み', () => {
    expect(notifyStatusOf(T1, T2)).toBe('同期済み');
    expect(notifyStatusOf(T1, T1)).toBe('同期済み');
  });

  it('連携用リスト側の時刻が読めないときは 同期済みと言い切らない', () => {
    expect(notifyStatusOf(T1, 'broken')).toBe('差分あり');
  });

  it('Mikke 側の時刻が読めないときは 同期済み (古いデータで全件差分ありにしない)', () => {
    expect(notifyStatusOf(undefined, T1)).toBe('同期済み');
    expect(notifyStatusOf('broken', T1)).toBe('同期済み');
  });

  it('並べ替えは 手当てが要るものが上 (未通知 > 差分あり > 同期済み)', () => {
    expect(NOTIFY_ORDER['未通知']).toBeGreaterThan(NOTIFY_ORDER['差分あり']);
    expect(NOTIFY_ORDER['差分あり']).toBeGreaterThan(NOTIFY_ORDER['同期済み']);
  });
});
