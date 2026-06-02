// CSV 取込エンジン (差分判定)。クライアント / 中継サーバ両用の純粋関数。
// 機能設計書 §2 (F1) / §9 (差分マトリクス) に準拠。
import type { ManagedIssue, MikkeSettings, AddedReason } from '../types';
import { evalConditions } from './conditions';
import { nextDetectionWhenPresent, nextDetectionWhenAbsent } from './detection';

/** CSV 内で Issue Instance ID を保持する列名 (正式名が判明したら差し替え)。 */
export const ISSUE_ID_COLUMN = 'Issue Instance ID';

/** CSV 行から ManagedIssue のフィールドにマッピングする際の既定対応。 */
const COL_TITLE = 'Title';
const COL_SEVERITY = 'Severity';
const COL_SCANNER_STATUS = 'Status';
const COL_FIRST_SEEN = 'First Seen';
const COL_LAST_SEEN = 'Last Seen';

export type ImportOpKind = 'add' | 'update' | 'undetect' | 'skip';

export interface ImportOp {
  kind: ImportOpKind;
  issueInstanceId: string;
  title: string;
  /** add: 新規作成する ManagedIssue (id なし)。 */
  create?: Omit<ManagedIssue, 'id'>;
  /** update / undetect: 既存 id とパッチ。 */
  id?: number;
  patch?: Partial<ManagedIssue>;
  /** skip 理由など補足。 */
  note?: string;
}

export interface ImportPlan {
  ops: ImportOp[];
  summary: { added: number; updated: number; undetected: number; skipped: number; rowCount: number };
  /** CSV のヘッダ (F6 の列選択候補)。 */
  headers: string[];
}

/** 動的列 (Scan_*) を CSV 行から抽出。managedColumns に挙がった元列名 (Scan_ を除いた名) を拾う。 */
function extractScanFields(row: Record<string, string>, managedColumns: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const col of managedColumns) {
    const srcName = col.replace(/^Scan_/, '');
    if (row[srcName] !== undefined) out[col] = row[srcName];
    else if (row[col] !== undefined) out[col] = row[col]; // 既に Scan_ 付きで来た場合
  }
  return out;
}

/** CSV 行 → 検査ツール由来フィールド (更新/新規共通)。 */
function scannerFieldsFromRow(row: Record<string, string>, managedColumns: string[]): Partial<ManagedIssue> {
  return {
    title: row[COL_TITLE] ?? '',
    severity: row[COL_SEVERITY] || undefined,
    scannerStatus: row[COL_SCANNER_STATUS] || undefined,
    lastSeen: row[COL_LAST_SEEN] || undefined,
    scanFields: extractScanFields(row, managedColumns),
  };
}

/**
 * 取込計画を算出する。
 * @param rows    CSV 行 (連想配列)。
 * @param headers CSV ヘッダ。
 * @param existing 既存の管理対象。
 * @param settings 条件 / 個別 ID / 管理列。
 * @param nowIso   取込日時 (テスト再現性のため引数で受ける)。
 */
export function buildImportPlan(
  rows: Record<string, string>[],
  headers: string[],
  existing: ManagedIssue[],
  settings: MikkeSettings,
  nowIso: string,
): ImportPlan {
  const byId = new Map<string, ManagedIssue>();
  for (const e of existing) byId.set(e.issueInstanceId, e);

  const individual = new Set(settings.individualIds);
  const seenInCsv = new Set<string>();
  const ops: ImportOp[] = [];
  let added = 0, updated = 0, undetected = 0, skipped = 0;

  for (const row of rows) {
    const iid = (row[ISSUE_ID_COLUMN] ?? '').trim();
    if (!iid) { skipped++; ops.push({ kind: 'skip', issueInstanceId: '', title: row[COL_TITLE] ?? '', note: 'Issue Instance ID 空' }); continue; }
    seenInCsv.add(iid);

    const cur = byId.get(iid);
    const sf = scannerFieldsFromRow(row, settings.managedColumns);

    if (cur) {
      // 既存管理対象に一致 → 更新 (検知ステータスは継続/再検知へ)
      const patch: Partial<ManagedIssue> = {
        ...sf,
        detectionStatus: nextDetectionWhenPresent(cur.detectionStatus),
        lastSyncedAt: nowIso,
      };
      ops.push({ kind: 'update', issueInstanceId: iid, title: sf.title ?? cur.title, id: cur.id, patch });
      updated++;
      continue;
    }

    // 未管理 → 条件一致 or 個別指定なら新規追加、それ以外スキップ
    const matched = evalConditions(settings.matchConditions, row);
    const isIndividual = individual.has(iid);
    if (matched || isIndividual) {
      const reason: AddedReason = isIndividual && !matched ? '個別指定' : '条件一致';
      const create: Omit<ManagedIssue, 'id'> = {
        title: sf.title ?? '',
        issueInstanceId: iid,
        detectionStatus: '新規',
        mgmtStatus: '未通知',
        isOutOfScope: false,
        severity: sf.severity,
        scannerStatus: sf.scannerStatus,
        firstSeen: row[COL_FIRST_SEEN] || nowIso,
        lastSeen: sf.lastSeen || nowIso,
        addedReason: reason,
        lastSyncedAt: nowIso,
        scanFields: sf.scanFields ?? {},
      };
      ops.push({ kind: 'add', issueInstanceId: iid, title: create.title, create });
      added++;
    } else {
      skipped++;
      ops.push({ kind: 'skip', issueInstanceId: iid, title: sf.title ?? '', note: '条件不一致' });
    }
  }

  // CSV に無い既存管理対象 → 未検出化 (対象外/過検出は除外)
  for (const e of existing) {
    if (seenInCsv.has(e.issueInstanceId)) continue;
    if (e.isOutOfScope || e.mgmtStatus === '対象外' || e.mgmtStatus === '過検出') continue;
    const nextDet = nextDetectionWhenAbsent(e.detectionStatus);
    if (nextDet === e.detectionStatus) continue; // 既に「未検出」で変化なし → skip
    const patch: Partial<ManagedIssue> = {
      detectionStatus: nextDet,
      lastSyncedAt: nowIso,
    };
    // 未検出(New) になった初回のみ FirstUndetectedAt を記録
    if (nextDet === '未検出(New)' && !e.firstUndetectedAt) patch.firstUndetectedAt = nowIso;
    ops.push({ kind: 'undetect', issueInstanceId: e.issueInstanceId, title: e.title, id: e.id, patch });
    undetected++;
  }

  return {
    ops,
    summary: { added, updated, undetected, skipped, rowCount: rows.length },
    headers,
  };
}
