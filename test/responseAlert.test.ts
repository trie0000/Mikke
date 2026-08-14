import { describe, it, expect } from 'vitest';
import { hasResponseUpdate } from '../src/lib/responseAlert';

const PUSHED = '2026-08-15T00:00:00Z';
const AFTER = '2026-08-15T01:00:00Z';
const BEFORE = '2026-08-14T23:00:00Z';

describe('連携リスト更新の表示判定', () => {
  it('★ こちらの反映より後に書き換えられていれば出す', () => {
    expect(hasResponseUpdate({ linkedAt: AFTER, pushedAt: PUSHED })).toBe(true);
  });

  it('★ 自分の反映で動いた更新時刻では出さない', () => {
    // 反映すると連携リスト側の更新時刻も動く。これで出すと毎回出てしまう。
    expect(hasResponseUpdate({ linkedAt: BEFORE, pushedAt: PUSHED })).toBe(false);
    expect(hasResponseUpdate({ linkedAt: PUSHED, pushedAt: PUSHED })).toBe(false);
  });

  it('★ 明細を開いて確認済みなら出さない', () => {
    expect(hasResponseUpdate({ linkedAt: AFTER, pushedAt: PUSHED, seenAt: AFTER })).toBe(false);
  });

  it('★ 確認したあとに更にまた書き換えられたら、また出す', () => {
    expect(hasResponseUpdate({
      linkedAt: '2026-08-15T02:00:00Z', pushedAt: PUSHED, seenAt: AFTER,
    })).toBe(true);
  });

  it('連携リストにアイテムが無ければ出さない', () => {
    expect(hasResponseUpdate({ pushedAt: PUSHED })).toBe(false);
  });

  it('★ 反映した記録が無ければ、管理対象の更新時刻を基準にする', () => {
    expect(hasResponseUpdate({ linkedAt: AFTER, issueUpdatedAt: PUSHED })).toBe(true);
    expect(hasResponseUpdate({ linkedAt: BEFORE, issueUpdatedAt: PUSHED })).toBe(false);
  });

  it('★ 比べる基準がまったく無ければ出さない (誤検知を出さない)', () => {
    expect(hasResponseUpdate({ linkedAt: AFTER })).toBe(false);
  });

  it('時刻が読めない値では出さない', () => {
    expect(hasResponseUpdate({ linkedAt: 'こわれた', pushedAt: PUSHED })).toBe(false);
  });
});
