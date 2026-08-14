// 連携用リスト (資産管理者が記入) → Mikke の管理対象一覧 への取り込み。
//
// 事業会社が書き換えられるのは ステータス / 対応者 / 対応期日 / 外部接続申請ID /
// 外部接続申請不要の理由 / 対応状況 / 備考 の 7 つ。
// これらを管理対象へ反映する計画をここで組み立てる (UI 非依存の純関数)。
//
// ★ 方針
//   - 実際に値が変わるものだけを patch にする (毎回全件書き込まない)。
//   - 対応状況・備考は Mikke 側の「内部メモ」とは別のフィールドに入れる。
//     管理者が書いた内部メモを事業会社の入力で消さないため。
//   - 対応状況は Mikke の対応ステータスへそのまま入れる (値が 1:1 で対応する)。
//     対応表に無い値は無視する (SharePoint 側で選択肢が増えても壊れないように)。
import type { ManagedIssue, MgmtStatus, FieldChange } from '../types';
import { MGMT_STATUSES } from '../types';
import { LABEL } from './fieldLabels';

/** 連携用リストの 1 アイテム (資産管理者の記入内容)。 */
export interface VulnResponseItem {
  issueInstanceId: string;
  /** 対応状況 (未着手 / 対応中 / 対応済み / リスク受容 / 過検出 / 対象外)。 */
  responseStatus?: string;
  /** 対応者 (SharePoint のユーザー。表示名)。 */
  responderName?: string;
  /** 対応期日 (ISO)。 */
  dueDate?: string;
  /** 備考。 */
  remarks?: string;
  /** 外部接続申請ID。 */
  extConnAppId?: string;
  /** 対応計画。 */
  responsePlan?: string;
  /** 申請不要理由。 */
  noAppReason?: string;
}

export interface ResponseSyncPatch {
  /** 管理対象の SP アイテム ID。 */
  id: number;
  issueInstanceId: string;
  patch: Partial<ManagedIssue>;
  /** 更新履歴に残す変更内容。 */
  changes: FieldChange[];
}

export interface ResponseSyncPlan {
  patches: ResponseSyncPatch[];
  /** 連携用リストに該当があり、内容も一致していた件数。 */
  unchanged: number;
  /** 連携用リストに該当アイテムが無かった件数。 */
  notLinked: number;
}

const text = (v: unknown): string => (v === undefined || v === null ? '' : String(v)).trim();

/** 日付は「日」まででの比較にする (時刻やタイムゾーンの差で毎回差分になるのを防ぐ)。 */
function dayOf(iso?: string): string {
  const s = text(iso);
  if (!s) return '';
  const t = new Date(s);
  if (Number.isNaN(t.getTime())) return '';
  // ローカル日付ではなく ISO の日付部分で揃える (SP も ISO で返す)。
  return t.toISOString().slice(0, 10);
}

/** 対応状況 → Mikke の対応ステータス。対応表に無ければ null (無視する)。 */
export function toMgmtStatus(responseStatus?: string): MgmtStatus | null {
  const s = text(responseStatus);
  return (MGMT_STATUSES as string[]).includes(s) ? (s as MgmtStatus) : null;
}

/**
 * 管理対象と連携用リストを突合し、取り込む差分だけを組み立てる。
 * @param nowIso 取り込み日時 (呼び出し側が渡す = テストしやすくするため)
 */
export function buildResponseSyncPlan(
  issues: ManagedIssue[],
  responses: VulnResponseItem[],
  nowIso: string,
): ResponseSyncPlan {
  const byId = new Map(responses.filter((r) => r.issueInstanceId).map((r) => [r.issueInstanceId, r]));
  const patches: ResponseSyncPatch[] = [];
  let unchanged = 0;
  let notLinked = 0;

  for (const issue of issues) {
    const r = byId.get(issue.issueInstanceId);
    if (!r) { notLinked++; continue; }

    const patch: Partial<ManagedIssue> = {};
    const changes: FieldChange[] = [];
    const put = (label: string, before: string, after: string, apply: () => void): void => {
      if (before === after) return;
      apply();
      changes.push({ field: label, before, after });
    };

    const st = toMgmtStatus(r.responseStatus);
    if (st) put(LABEL.mgmtStatus, issue.mgmtStatus, st, () => { patch.mgmtStatus = st; });

    put(LABEL.responder, text(issue.assignee), text(r.responderName),
      () => { patch.assignee = text(r.responderName); });

    put(LABEL.responseDueDate, dayOf(issue.dueDate), dayOf(r.dueDate),
      () => { patch.dueDate = text(r.dueDate); });

    put(LABEL.responseRemarks, text(issue.responseRemarks), text(r.remarks),
      () => { patch.responseRemarks = text(r.remarks); });

    // ★ ここも資産管理者が書く欄。書いてもらった内容が Mikke に返ってこないと
    //   一覧で状況が追えない。
    put(LABEL.extConnAppId, text(issue.extConnAppId), text(r.extConnAppId),
      () => { patch.extConnAppId = text(r.extConnAppId); });

    put(LABEL.responsePlan, text(issue.responsePlan), text(r.responsePlan),
      () => { patch.responsePlan = text(r.responsePlan); });

    put(LABEL.noAppReason, text(issue.noAppReason), text(r.noAppReason),
      () => { patch.noAppReason = text(r.noAppReason); });

    if (!changes.length) { unchanged++; continue; }
    patch.responseSyncedAt = nowIso;
    patches.push({ id: issue.id, issueInstanceId: issue.issueInstanceId, patch, changes });
  }
  return { patches, unchanged, notLinked };
}
