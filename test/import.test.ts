import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildImportPlan } from '../src/lib/import';
import { parseCsv } from '../src/lib/csv';
import type { ManagedIssue, MikkeSettings } from '../src/types';
import type { ImportOp, ImportPlan } from '../src/lib/import';

const __dir = dirname(fileURLToPath(import.meta.url));
const sample = (name: string) =>
  parseCsv(readFileSync(join(__dir, '..', 'samples', name), 'utf8'));

const settings: MikkeSettings = {
  managedColumns: ['Scan_Asset', 'Scan_CVE'],
  matchConditions: { combinator: 'OR', rules: [{ field: 'Severity', op: 'equals', value: 'Critical' }] },
  individualIds: ['IID-1001'], // High だが個別指定で管理対象に
};

/** add op を id 付与で確定し、update/undetect を適用して store を進める。 */
function apply(store: ManagedIssue[], plan: { ops: ImportOp[] }, startId: number): number {
  const byId = new Map(store.map((s) => [s.id, s]));
  let id = startId;
  for (const op of plan.ops) {
    if (op.kind === 'add' && op.create) store.push({ id: id++, ...op.create });
    else if ((op.kind === 'update' || op.kind === 'undetect') && op.id != null && op.patch) {
      Object.assign(byId.get(op.id)!, op.patch);
    }
  }
  return id;
}

const NOW = (m: string) => `2026-${m}-01T00:00:00Z`;

describe('import: 初回取込 (空 → 5月)', () => {
  const may = sample('scanner-export-2026-05.csv');
  const plan = buildImportPlan(may.rows, may.headers, [], settings, NOW('05'));

  it('Critical 3件 + 個別1件 = 4件追加', () => {
    expect(plan.summary.added).toBe(4);
  });
  it('条件外はスキップ', () => {
    expect(plan.summary.skipped).toBe(may.rows.length - 4);
  });
  it('追加分は検知=新規 / 対応=未通知', () => {
    const add = plan.ops.filter((o) => o.kind === 'add');
    expect(add.every((o) => o.create!.detectionStatus === '新規')).toBe(true);
    expect(add.every((o) => o.create!.mgmtStatus === '未通知')).toBe(true);
  });
  it('個別指定は AddedReason=個別指定', () => {
    const indiv = plan.ops.find((o) => o.issueInstanceId === 'IID-1001');
    expect(indiv?.create?.addedReason).toBe('個別指定');
  });
  it('条件一致は AddedReason=条件一致', () => {
    const cond = plan.ops.find((o) => o.issueInstanceId === 'IID-1002');
    expect(cond?.create?.addedReason).toBe('条件一致');
  });
});

describe('import: 2回目 (5月結果 → 6月)', () => {
  const may = sample('scanner-export-2026-05.csv');
  const jun = sample('scanner-export-2026-06.csv');
  const store: ManagedIssue[] = [];
  let nextId = apply(store, buildImportPlan(may.rows, may.headers, [], settings, NOW('05')), 1);
  const plan2 = buildImportPlan(jun.rows, jun.headers, store, settings, NOW('06'));
  apply(store, plan2, nextId);

  const find = (iid: string) => store.find((s) => s.issueInstanceId === iid);

  it('既存4件すべて更新', () => {
    expect(plan2.summary.updated).toBe(4);
  });
  it('IID-1001 (個別/High) は継続', () => {
    expect(find('IID-1001')?.detectionStatus).toBe('継続');
  });
  it('IID-1002 (Critical) は継続', () => {
    expect(find('IID-1002')?.detectionStatus).toBe('継続');
  });
  it('Low/Medium は管理対象外のまま', () => {
    expect(find('IID-1003')).toBeUndefined(); // Low
    expect(find('IID-1005')).toBeUndefined(); // 6月 Medium
  });
});

describe('import: 未検出化と再検知の完全ライフサイクル', () => {
  const may = sample('scanner-export-2026-05.csv');
  const jun = sample('scanner-export-2026-06.csv');
  // IID-1011 (Critical) を管理対象にし、6月以降の CSV から外して追跡
  const junNo1011 = { ...jun, rows: jun.rows.filter((r) => r['Issue Instance ID'] !== 'IID-1011') };

  const store: ManagedIssue[] = [];
  let id = apply(store, buildImportPlan(may.rows, may.headers, [], settings, NOW('05')), 1);
  const find = (iid: string) => store.find((s) => s.issueInstanceId === iid);

  it('5月: IID-1011 は新規', () => {
    expect(find('IID-1011')?.detectionStatus).toBe('新規');
  });

  it('6月 (欠落): 未検出(New) + FirstUndetectedAt 記録', () => {
    const p = buildImportPlan(junNo1011.rows, jun.headers, store, settings, NOW('06'));
    id = apply(store, p, id);
    expect(find('IID-1011')?.detectionStatus).toBe('未検出(New)');
    expect(find('IID-1011')?.firstUndetectedAt).toBe(NOW('06'));
    expect(p.summary.undetected).toBeGreaterThanOrEqual(1);
  });

  it('7月 (欠落継続): 未検出', () => {
    id = apply(store, buildImportPlan(junNo1011.rows, jun.headers, store, settings, NOW('07')), id);
    expect(find('IID-1011')?.detectionStatus).toBe('未検出');
  });

  it('8月 (復活): 再検知 (新規ではない)', () => {
    id = apply(store, buildImportPlan(jun.rows, jun.headers, store, settings, NOW('08')), id);
    expect(find('IID-1011')?.detectionStatus).toBe('再検知');
  });

  it('9月 (継続検知): 継続', () => {
    id = apply(store, buildImportPlan(jun.rows, jun.headers, store, settings, NOW('09')), id);
    expect(find('IID-1011')?.detectionStatus).toBe('継続');
  });
});

describe('import: 社内管理項目を上書きしない', () => {
  it('更新時に MgmtStatus / Assignee / DueDate は patch に含まれない', () => {
    const existing: ManagedIssue[] = [{
      id: 1, title: 'x', issueInstanceId: 'IID-1002',
      detectionStatus: '新規', mgmtStatus: '対応中', isOutOfScope: false,
      assignee: 'me', dueDate: '2026-12-31', mgmtNote: 'メモ', scanFields: {},
    }];
    const jun = sample('scanner-export-2026-06.csv');
    const plan = buildImportPlan(jun.rows, jun.headers, existing, settings, NOW('06'));
    const op = plan.ops.find((o) => o.issueInstanceId === 'IID-1002' && o.kind === 'update');
    expect(op?.patch).toBeDefined();
    expect(op?.patch).not.toHaveProperty('mgmtStatus');
    expect(op?.patch).not.toHaveProperty('assignee');
    expect(op?.patch).not.toHaveProperty('dueDate');
    expect(op?.patch).not.toHaveProperty('mgmtNote');
  });
});

describe('import: 対象外/過検出は未検出化しない', () => {
  it('対象外の既存は CSV から消えても変化なし', () => {
    const existing: ManagedIssue[] = [{
      id: 1, title: 'x', issueInstanceId: 'NOT-IN-CSV',
      detectionStatus: '継続', mgmtStatus: '対象外', isOutOfScope: true, scanFields: {},
    }];
    const jun = sample('scanner-export-2026-06.csv');
    const plan = buildImportPlan(jun.rows, jun.headers, existing, settings, NOW('06'));
    expect(plan.ops.find((o) => o.issueInstanceId === 'NOT-IN-CSV')).toBeUndefined();
    expect(plan.summary.undetected).toBe(0);
  });
});

describe('import: Issue Instance ID 空行はスキップ', () => {
  it('ID 空はスキップ', () => {
    const rows = [{ 'Issue Instance ID': '', Title: 'no id', Severity: 'Critical' }];
    const plan: ImportPlan = buildImportPlan(rows, ['Issue Instance ID', 'Title', 'Severity'], [], settings, NOW('06')) as ImportPlan;
    expect(plan.summary.skipped).toBe(1);
    expect(plan.summary.added).toBe(0);
  });
});
