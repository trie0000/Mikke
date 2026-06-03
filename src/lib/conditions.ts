// F7: 管理対象条件エンジン。CSV 行 (列名→値) に対して AND/OR 条件を評価する。
import type { ConditionGroup, ConditionRule, ConditionOp, ColumnType } from '../types';

// 汎用 (テキスト系) 演算子。後方互換で残す。
export const CONDITION_OPS: { value: ConditionOp; label: string }[] = [
  { value: 'equals', label: '＝ 一致' },
  { value: 'not_equals', label: '≠ 不一致' },
  { value: 'contains', label: '含む' },
  { value: 'not_contains', label: '含まない' },
  { value: 'starts_with', label: 'で始まる' },
  { value: 'in', label: 'いずれか (カンマ区切り)' },
];

const OPS_TEXT: ConditionOp[] = ['equals', 'not_equals', 'contains', 'not_contains', 'starts_with', 'in'];
const OPS_CMP: ConditionOp[] = ['equals', 'not_equals', 'gte', 'lte', 'gt', 'lt', 'between'];

/** 列の型に応じて選べる演算子の一覧。数値・日付は比較系、それ以外はテキスト系。 */
export function opsForType(t?: ColumnType): ConditionOp[] {
  if (t === 'number' || t === 'date' || t === 'datetime') return OPS_CMP;
  return OPS_TEXT;
}

/** 演算子ラベル。日付列では「以降/以前」等、数値列では「以上/以下」等に出し分け。 */
export function opLabel(op: ConditionOp, t?: ColumnType): string {
  const dateMode = t === 'date' || t === 'datetime';
  switch (op) {
    case 'equals': return '＝ 一致';
    case 'not_equals': return '≠ 不一致';
    case 'contains': return '含む';
    case 'not_contains': return '含まない';
    case 'starts_with': return 'で始まる';
    case 'in': return 'いずれか (カンマ区切り)';
    case 'gte': return dateMode ? '以降 (≧)' : '以上 (≧)';
    case 'lte': return dateMode ? '以前 (≦)' : '以下 (≦)';
    case 'gt': return dateMode ? 'より後 (＞)' : 'より大 (＞)';
    case 'lt': return dateMode ? 'より前 (＜)' : 'より小 (＜)';
    case 'between': return dateMode ? '期間 (範囲)' : '範囲';
    default: return op;
  }
}

/** 上限値 (value2) が要る演算子か。 */
export function opNeedsValue2(op: ConditionOp): boolean {
  return op === 'between';
}

function isGroup(x: ConditionRule | ConditionGroup): x is ConditionGroup {
  return (x as ConditionGroup).combinator !== undefined;
}

function toNum(s: string): number {
  return Number(String(s).replace(/,/g, '').trim());   // 桁区切りカンマを除去
}

/** セルと値を比較。数値同士なら数値、日付同士なら日時、それ以外は文字列で比較。
 *  戻り値: cell<value=-1 / 等しい=0 / cell>value=1。 */
function cmp(cell: string, value: string): number {
  const c = cell.trim(); const v = value.trim();
  const cn = toNum(c); const vn = toNum(v);
  if (c !== '' && v !== '' && !Number.isNaN(cn) && !Number.isNaN(vn)) {
    return cn < vn ? -1 : cn > vn ? 1 : 0;
  }
  const cd = Date.parse(c); const vd = Date.parse(v);
  if (!Number.isNaN(cd) && !Number.isNaN(vd)) {
    return cd < vd ? -1 : cd > vd ? 1 : 0;
  }
  return c < v ? -1 : c > v ? 1 : 0;
}

function evalRule(rule: ConditionRule, row: Record<string, string>): boolean {
  const cell = (row[rule.field] ?? '').trim();
  const v = (rule.value ?? '').trim();
  switch (rule.op) {
    case 'equals': return cell === v;
    case 'not_equals': return cell !== v;
    case 'contains': return cell.includes(v);
    case 'not_contains': return !cell.includes(v);
    case 'starts_with': return cell.startsWith(v);
    case 'in': return v.split(',').map((s) => s.trim()).filter(Boolean).includes(cell);
    case 'gte': return cell !== '' && v !== '' && cmp(cell, v) >= 0;
    case 'lte': return cell !== '' && v !== '' && cmp(cell, v) <= 0;
    case 'gt': return cell !== '' && v !== '' && cmp(cell, v) > 0;
    case 'lt': return cell !== '' && v !== '' && cmp(cell, v) < 0;
    case 'between': {
      const v2 = (rule.value2 ?? '').trim();
      if (cell === '' || v === '' || v2 === '') return false;
      return cmp(cell, v) >= 0 && cmp(cell, v2) <= 0;
    }
    default: return false;
  }
}

/** 条件グループを評価。グループが空 (ルール 0 件) なら false (= 何も管理対象化しない)。 */
export function evalConditions(
  group: ConditionGroup | null,
  row: Record<string, string>,
): boolean {
  if (!group || group.rules.length === 0) return false;
  const results = group.rules.map((r) => isGroup(r) ? evalConditions(r, row) : evalRule(r, row));
  return group.combinator === 'AND' ? results.every(Boolean) : results.some(Boolean);
}
