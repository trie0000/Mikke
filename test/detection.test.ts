import { describe, it, expect } from 'vitest';
import { nextDetectionWhenPresent, nextDetectionWhenAbsent, isUndetected } from '../src/lib/detection';

describe('detection: CSV に存在する場合の遷移', () => {
  it('新規 → 継続', () => {
    expect(nextDetectionWhenPresent('新規')).toBe('継続');
  });
  it('継続 → 継続', () => {
    expect(nextDetectionWhenPresent('継続')).toBe('継続');
  });
  it('未検出(New) → 再検知', () => {
    expect(nextDetectionWhenPresent('未検出(New)')).toBe('再検知');
  });
  it('未検出 → 再検知', () => {
    expect(nextDetectionWhenPresent('未検出')).toBe('再検知');
  });
  it('再検知 → 継続 (検知が続けば継続へ)', () => {
    expect(nextDetectionWhenPresent('再検知')).toBe('継続');
  });
});

describe('detection: CSV から消えた場合の遷移', () => {
  it('新規 → 未検出(New)', () => {
    expect(nextDetectionWhenAbsent('新規')).toBe('未検出(New)');
  });
  it('継続 → 未検出(New)', () => {
    expect(nextDetectionWhenAbsent('継続')).toBe('未検出(New)');
  });
  it('再検知 → 未検出(New)', () => {
    expect(nextDetectionWhenAbsent('再検知')).toBe('未検出(New)');
  });
  it('未検出(New) → 未検出', () => {
    expect(nextDetectionWhenAbsent('未検出(New)')).toBe('未検出');
  });
  it('未検出 → 未検出 (変化なし)', () => {
    expect(nextDetectionWhenAbsent('未検出')).toBe('未検出');
  });
});

describe('detection: isUndetected', () => {
  it('未検出系は true', () => {
    expect(isUndetected('未検出(New)')).toBe(true);
    expect(isUndetected('未検出')).toBe(true);
  });
  it('検知系は false', () => {
    expect(isUndetected('新規')).toBe(false);
    expect(isUndetected('継続')).toBe(false);
    expect(isUndetected('再検知')).toBe(false);
  });
});
