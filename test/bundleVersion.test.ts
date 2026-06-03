import { describe, it, expect } from 'vitest';
import { stableBuildId } from '../src/utils/bundleVersion';

describe('stableBuildId', () => {
  it('buildTime と dirty マーカーを除いた version-sha を返す', () => {
    expect(stableBuildId('0.0.1-5847d15+ (2026-06-03T04:57:23Z)')).toBe('0.0.1-5847d15');
    expect(stableBuildId('0.0.1-5847d15 (2026-06-03T04:57:23Z)')).toBe('0.0.1-5847d15');
    expect(stableBuildId('0.0.1-5847d15')).toBe('0.0.1-5847d15');
    expect(stableBuildId('0.0.1-nogit (2026-06-03T00:00:00Z)')).toBe('0.0.1-nogit');
  });

  it('同一コミットの再ビルド (buildTime 違い) は同じ安定 id', () => {
    const a = stableBuildId('0.0.1-abc1234+ (2026-06-03T01:00:00Z)');
    const b = stableBuildId('0.0.1-abc1234+ (2026-06-03T09:30:00Z)');
    expect(a).toBe(b); // → 更新と誤検知しない
  });

  it('別コミットは別の安定 id', () => {
    const a = stableBuildId('0.0.1-abc1234 (2026-06-03T01:00:00Z)');
    const b = stableBuildId('0.0.1-def5678 (2026-06-03T01:00:00Z)');
    expect(a).not.toBe(b); // → 更新を検知する
  });

  it('空文字は空文字', () => {
    expect(stableBuildId('')).toBe('');
  });
});
