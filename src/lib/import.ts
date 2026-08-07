// CSV 取込エンジン (差分判定)。クライアント / 中継サーバ両用の純粋関数。
// 機能設計書 §2 (F1) / §9 (差分マトリクス) に準拠。
import type { ManagedIssue, MikkeSettings, AddedReason } from '../types';
import { DEFAULT_MGMT_STATUS } from '../types';
import { evalConditions } from './conditions';
import { nextDetectionWhenPresent, nextDetectionWhenAbsent, fixedNextDetectionWhenAbsent } from './detection';

/** 取込モード。
 *  - 'add'   : 標準。新規の条件一致を追加し、既存のステータスも標準ルールで遷移。
 *  - 'fixed' : 固定。新規は追加しない。present 側はステータス据え置き (項目値のみ更新)、
 *              検知系が今回消滅した時だけ「未検出(New)」に落とす。未検出系は据え置き。 */
export type ImportMode = 'add' | 'fixed';

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

/** 動的列 (Scan_*) を CSV 行から抽出。
 *  ★ CSV の「全列」を保存する (F6 のチェックは一覧に表示する列の選択であり、
 *    保存対象の絞り込みではない)。検査ツール詳細タブで全項目を参照できる。 */
function extractScanFields(row: Record<string, string>, headers: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const h of headers) {
    const name = h.trim();
    if (!name) continue;
    out[`Scan_${name}`] = row[name] ?? '';
  }
  return out;
}

/** CSV 行 → 検査ツール由来フィールド (更新/新規共通)。 */
function scannerFieldsFromRow(row: Record<string, string>, headers: string[]): Partial<ManagedIssue> {
  return {
    title: row[COL_TITLE] ?? '',
    severity: row[COL_SEVERITY] || undefined,
    scannerStatus: row[COL_SCANNER_STATUS] || undefined,
    lastSeen: row[COL_LAST_SEEN] || undefined,
    scanFields: extractScanFields(row, headers),
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
  mode: ImportMode = 'add',
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
    const sf = scannerFieldsFromRow(row, headers);

    if (cur) {
      // 既存管理対象に一致 → 更新。
      // add   : 検知ステータスを継続/再検知へ遷移。
      // fixed : ステータスは据え置き (detectionStatus をパッチに含めない)。項目値のみ更新。
      const patch: Partial<ManagedIssue> = { ...sf, lastSyncedAt: nowIso };
      if (mode !== 'fixed') patch.detectionStatus = nextDetectionWhenPresent(cur.detectionStatus);
      ops.push({ kind: 'update', issueInstanceId: iid, title: sf.title ?? cur.title, id: cur.id, patch });
      updated++;
      continue;
    }

    // 未管理: 固定モードは新規を追加しない。
    if (mode === 'fixed') {
      skipped++;
      ops.push({ kind: 'skip', issueInstanceId: iid, title: sf.title ?? '', note: '固定モード: 新規は追加しない' });
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
        mgmtStatus: DEFAULT_MGMT_STATUS,
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
    // add: 標準ルール / fixed: 検知系のみ 未検出(New) へ、未検出系は据え置き。
    const nextDet = mode === 'fixed'
      ? fixedNextDetectionWhenAbsent(e.detectionStatus)
      : nextDetectionWhenAbsent(e.detectionStatus);
    if (nextDet === e.detectionStatus) continue; // 変化なし → skip
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
