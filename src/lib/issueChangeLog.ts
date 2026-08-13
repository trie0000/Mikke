// 管理対象チケットの「更新履歴」用の差分計算。編集で変わった管理項目を
// 項目名・更新前・更新後 (表示文字列) で列挙する。UI 非依存・テスト可能。
import { fmtDate } from '../utils/dom';
import type { ManagedIssue, FieldChange } from '../types';

interface FieldSpec {
  field: keyof ManagedIssue;
  label: string;
  /** 表示・比較用の文字列化。 */
  fmt: (v: unknown) => string;
}

const asText = (v: unknown): string => (v === undefined || v === null ? '' : String(v)).trim();

/** 更新履歴で追跡する管理項目 (編集モーダルで編集できるもの)。 */
const TRACKED: FieldSpec[] = [
  { field: 'mgmtStatus', label: '対応ステータス', fmt: asText },
  { field: 'isOutOfScope', label: '管理対象外', fmt: (v) => (v ? 'はい' : 'いいえ') },
  { field: 'outOfScopeReason', label: '対象外の理由', fmt: asText },
  { field: 'extConnAppId', label: '外部接続申請ID', fmt: asText },
  { field: 'legacyMgmtNumber', label: '旧管理番号', fmt: asText },
  { field: 'businessCompany', label: '事業会社', fmt: asText },
  { field: 'affiliateCompany', label: '管理会社', fmt: asText },
  { field: 'assignee', label: '担当者', fmt: asText },
  { field: 'dueDate', label: '対応期限', fmt: (v) => (v ? fmtDate(v as string, false) : '') },
  { field: 'mgmtNote', label: 'メモ', fmt: asText },
];

/**
 * 編集前の issue と更新パッチを比較し、実際に変わった管理項目の変更一覧を返す。
 * 日付や真偽は表示文字列で比較し、見た目が同じ変更 (時刻差など) は除外する。
 */
export function diffManagedIssue(before: ManagedIssue, patch: Partial<ManagedIssue>): FieldChange[] {
  const out: FieldChange[] = [];
  for (const { field, label, fmt } of TRACKED) {
    if (!(field in patch)) continue;
    const bDisp = fmt(before[field]);
    const aDisp = fmt(patch[field]);
    if (bDisp === aDisp) continue;
    out.push({ field: label, before: bDisp, after: aDisp });
  }
  return out;
}
