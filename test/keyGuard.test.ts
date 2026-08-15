import { describe, it, expect } from 'vitest';
import { computeDelete } from '../src/utils/keyGuard';

// ページ側に Backspace を潰す仕掛けがあると、Mikke の入力欄で文字を消せなくなる。
// その復旧で使う計算部分 (DOM に触らない) を検査する。

describe('computeDelete: Backspace', () => {
  it('カーソルの手前を 1 文字消す', () => {
    expect(computeDelete('ENGX', 4, 4, 'Backspace')).toEqual({ value: 'ENG', caret: 3 });
  });

  it('文中でも手前だけ消す', () => {
    expect(computeDelete('abcd', 2, 2, 'Backspace')).toEqual({ value: 'acd', caret: 1 });
  });

  it('先頭では何もしない', () => {
    expect(computeDelete('abc', 0, 0, 'Backspace')).toBeNull();
  });

  it('選択範囲があればその範囲を消す', () => {
    expect(computeDelete('ABCDEF', 1, 4, 'Backspace')).toEqual({ value: 'AEF', caret: 1 });
  });

  it('★ 絵文字は 1 文字として消す (サロゲートペアを割らない)', () => {
    // 'a🌐' は 3 コード単位。1 単位だけ消すと壊れた文字が残る。
    expect(computeDelete('a🌐', 3, 3, 'Backspace')).toEqual({ value: 'a', caret: 1 });
  });
});

describe('computeDelete: Delete', () => {
  it('カーソルの先を 1 文字消す', () => {
    expect(computeDelete('ABC', 0, 0, 'Delete')).toEqual({ value: 'BC', caret: 0 });
  });

  it('末尾では何もしない', () => {
    expect(computeDelete('AB', 2, 2, 'Delete')).toBeNull();
  });

  it('選択範囲があればその範囲を消す', () => {
    expect(computeDelete('ABCDEF', 2, 5, 'Delete')).toEqual({ value: 'ABF', caret: 2 });
  });

  it('★ 絵文字は 1 文字として消す', () => {
    expect(computeDelete('🌐b', 0, 0, 'Delete')).toEqual({ value: 'b', caret: 0 });
  });
});

describe('境界の入力に耐える', () => {
  it('空文字では何もしない', () => {
    expect(computeDelete('', 0, 0, 'Backspace')).toBeNull();
    expect(computeDelete('', 0, 0, 'Delete')).toBeNull();
  });

  it('範囲が文字数を超えていても壊れない', () => {
    expect(computeDelete('abc', 99, 99, 'Backspace')).toEqual({ value: 'ab', caret: 2 });
    expect(computeDelete('abc', -5, 99, 'Backspace')).toEqual({ value: '', caret: 0 });
  });
});
