import { describe, it, expect } from 'vitest';
import { buildResponseSyncPlan, toMgmtStatus, type VulnResponseItem } from '../src/lib/responseSync';
import type { ManagedIssue } from '../src/types';

const NOW = '2026-08-07T03:00:00.000Z';

function issue(over: Partial<ManagedIssue> = {}): ManagedIssue {
  return {
    id: 1, title: 'TLS 1.0 が有効', issueInstanceId: 'IID-1',
    detectionStatus: '継続', mgmtStatus: '未着手', isOutOfScope: false,
    scanFields: {}, ...over,
  } as ManagedIssue;
}

function res(over: Partial<VulnResponseItem> = {}): VulnResponseItem {
  return { issueInstanceId: 'IID-1', ...over };
}

describe('toMgmtStatus: 対応状況 → 対応ステータス', () => {
  it('同じ名前の値はそのまま使う', () => {
    for (const s of ['未着手', '対応中', '対応済み', 'リスク受容', '過検出', '対象外']) {
      expect(toMgmtStatus(s)).toBe(s);
    }
  });

  it('対応表に無い値は無視する (SharePoint 側で選択肢が増えても壊れない)', () => {
    expect(toMgmtStatus('なにかの新しい値')).toBeNull();
    expect(toMgmtStatus('')).toBeNull();
    expect(toMgmtStatus(undefined)).toBeNull();
  });
});

describe('buildResponseSyncPlan: 連携用リスト → 管理対象への取り込み', () => {
  it('変更があった項目だけ patch にする', () => {
    const plan = buildResponseSyncPlan([issue()], [res({ responseStatus: '対応中' })], NOW);
    expect(plan.patches).toHaveLength(1);
    expect(plan.patches[0]!.patch.mgmtStatus).toBe('対応中');
    // 触っていない項目は patch に入れない
    expect(plan.patches[0]!.patch.assignee).toBeUndefined();
    expect(plan.patches[0]!.patch.responseSyncedAt).toBe(NOW);
  });

  it('内容が同じなら書き込まない (毎回全件更新しない)', () => {
    const plan = buildResponseSyncPlan(
      [issue({ mgmtStatus: '対応中', assignee: '山田' })],
      [res({ responseStatus: '対応中', responderName: '山田' })], NOW);
    expect(plan.patches).toEqual([]);
    expect(plan.unchanged).toBe(1);
  });

  it('連携用リストに無い脆弱性は数えるだけで触らない', () => {
    const plan = buildResponseSyncPlan([issue({ issueInstanceId: 'IID-9' })], [res()], NOW);
    expect(plan.patches).toEqual([]);
    expect(plan.notLinked).toBe(1);
  });

  it('対応者・対応期日・対応経緯・備考を取り込む', () => {
    const plan = buildResponseSyncPlan([issue()], [res({
      responderName: '佐藤', dueDate: '2026-09-30T00:00:00Z',
      responseNote: '<p>ベンダーに問い合わせ中</p>', remarks: '再検査は10月',
    })], NOW);
    const p = plan.patches[0]!.patch;
    expect(p.assignee).toBe('佐藤');
    expect(p.dueDate).toBe('2026-09-30T00:00:00Z');
    expect(p.responseNote).toBe('<p>ベンダーに問い合わせ中</p>');
    expect(p.responseRemarks).toBe('再検査は10月');
  });

  it('対応経緯・備考は Mikke 側のメモを上書きしない (別フィールドに入れる)', () => {
    const plan = buildResponseSyncPlan(
      [issue({ mgmtNote: '管理者のメモ' })],
      [res({ responseNote: '資産管理者の記入' })], NOW);
    const p = plan.patches[0]!.patch;
    expect(p.responseNote).toBe('資産管理者の記入');
    expect(p.mgmtNote).toBeUndefined();
  });

  it('対応期日は日付単位で比べる (時刻差で毎回差分にしない)', () => {
    const plan = buildResponseSyncPlan(
      [issue({ dueDate: '2026-09-30T15:00:00Z' })],
      [res({ dueDate: '2026-09-30T00:00:00Z' })], NOW);
    expect(plan.patches).toEqual([]);
    expect(plan.unchanged).toBe(1);
  });

  it('対応表に無い対応状況は取り込まない (他の項目は取り込む)', () => {
    const plan = buildResponseSyncPlan([issue()], [res({
      responseStatus: '知らない値', responderName: '鈴木',
    })], NOW);
    const p = plan.patches[0]!.patch;
    expect(p.mgmtStatus).toBeUndefined();
    expect(p.assignee).toBe('鈴木');
  });

  it('更新履歴用の変更内容を項目名つきで返す', () => {
    const plan = buildResponseSyncPlan(
      [issue({ mgmtStatus: '未着手' })], [res({ responseStatus: '対応済み' })], NOW);
    expect(plan.patches[0]!.changes).toEqual([
      { field: '対応ステータス', before: '未着手', after: '対応済み' },
    ]);
  });

  it('複数件をまとめて計画できる', () => {
    const issues = [issue({ id: 1, issueInstanceId: 'A' }), issue({ id: 2, issueInstanceId: 'B' })];
    const plan = buildResponseSyncPlan(issues, [
      { issueInstanceId: 'A', responseStatus: '対応中' },
      { issueInstanceId: 'B', responseStatus: '対応中' },
    ], NOW);
    expect(plan.patches.map((p) => p.id)).toEqual([1, 2]);
  });
});
