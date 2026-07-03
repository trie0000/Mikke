import { describe, it, expect } from 'vitest';
import { diffManagedIssue } from '../src/lib/issueChangeLog';
import type { ManagedIssue } from '../src/types';

const base: ManagedIssue = {
  id: 1, title: 't', issueInstanceId: 'i-1',
  detectionStatus: '継続', mgmtStatus: '未通知', isOutOfScope: false,
  assignee: '田中', dueDate: '2026-05-01T00:00:00.000Z', mgmtNote: 'メモ旧',
};

describe('diffManagedIssue', () => {
  it('変わった管理項目だけ 項目名/更新前/更新後 を返す', () => {
    const changes = diffManagedIssue(base, { mgmtStatus: '対応中', assignee: '佐藤' });
    expect(changes).toEqual([
      { field: '対応ステータス', before: '未通知', after: '対応中' },
      { field: '担当者', before: '田中', after: '佐藤' },
    ]);
  });
  it('値が同じ項目は含めない', () => {
    expect(diffManagedIssue(base, { mgmtStatus: '未通知', assignee: '田中' })).toEqual([]);
  });
  it('patch に無い項目は対象外', () => {
    expect(diffManagedIssue(base, { mgmtNote: 'メモ新' })).toEqual([
      { field: 'メモ', before: 'メモ旧', after: 'メモ新' },
    ]);
  });
  it('対象外(真偽)は はい/いいえ で記録', () => {
    expect(diffManagedIssue(base, { isOutOfScope: true, outOfScopeReason: '過検出' })).toEqual([
      { field: '管理対象外', before: 'いいえ', after: 'はい' },
      { field: '対象外の理由', before: '', after: '過検出' },
    ]);
  });
  it('期限は日付表示で比較 (同日なら時刻差は無視)', () => {
    // 同じ 2026-05-01 (時刻だけ違う) → 変更なし
    expect(diffManagedIssue(base, { dueDate: '2026-05-01T09:30:00.000Z' })).toEqual([]);
    // 別日なら記録
    const c = diffManagedIssue(base, { dueDate: '2026-06-15T00:00:00.000Z' });
    expect(c).toHaveLength(1);
    expect(c[0]!.field).toBe('対応期限');
    expect(c[0]!.after).toContain('2026');
  });
});
