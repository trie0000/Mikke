import { describe, it, expect } from 'vitest';
import { hasResponseUpdate } from '../src/lib/responseAlert';

const SEEN = '2026-08-15T00:00:00Z';
const AFTER = '2026-08-15T01:00:00Z';
const BEFORE = '2026-08-14T23:00:00Z';

describe('連携リスト更新の表示判定', () => {
  it('★ 見た時点より後に書き換えられていれば出す', () => {
    expect(hasResponseUpdate({ linkedAt: AFTER, seenAt: SEEN })).toBe(true);
  });

  it('見た時点と同じなら出さない', () => {
    expect(hasResponseUpdate({ linkedAt: SEEN, seenAt: SEEN })).toBe(false);
  });

  it('見た時点より古ければ出さない', () => {
    expect(hasResponseUpdate({ linkedAt: BEFORE, seenAt: SEEN })).toBe(false);
  });

  it('★ 確認したあとに更にまた書き換えられたら、また出す', () => {
    expect(hasResponseUpdate({ linkedAt: '2026-08-15T02:00:00Z', seenAt: AFTER })).toBe(true);
  });

  it('連携リストにアイテムが無ければ出さない', () => {
    expect(hasResponseUpdate({ seenAt: SEEN })).toBe(false);
  });

  it('★ 基準がまだ無ければ出さない (更新直後に全件へ出さない)', () => {
    expect(hasResponseUpdate({ linkedAt: AFTER })).toBe(false);
  });

  it('時刻が読めない値では出さない', () => {
    expect(hasResponseUpdate({ linkedAt: 'こわれた', seenAt: SEEN })).toBe(false);
    expect(hasResponseUpdate({ linkedAt: AFTER, seenAt: 'こわれた' })).toBe(false);
  });

  it('★ サーバ側の他の時刻には依存しない (取り込みで基準が動かない)', () => {
    // 取り込みは管理対象の更新時刻を進めるが、判定には使わない。
    expect(hasResponseUpdate({ linkedAt: AFTER, seenAt: SEEN })).toBe(true);
  });
});
