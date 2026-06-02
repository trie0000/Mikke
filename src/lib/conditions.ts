// F7: 管理対象条件エンジン。CSV 行 (列名→値) に対して AND/OR 条件を評価する。
import type { ConditionGroup, ConditionRule, ConditionOp } from '../types';

export const CONDITION_OPS: { value: ConditionOp; label: string }[] = [
  { value: 'equals', label: '＝ 一致' },
  { value: 'not_equals', label: '≠ 不一致' },
  { value: 'contains', label: '含む' },
  { value: 'not_contains', label: '含まない' },
  { value: 'starts_with', label: 'で始まる' },
  { value: 'in', label: 'いずれか (カンマ区切り)' },
];

function isGroup(x: ConditionRule | ConditionGroup): x is ConditionGroup {
  return (x as ConditionGroup).combinator !== undefined;
}

function evalRule(rule: ConditionRule, row: Record<string, string>): boolean {
  const cell = (row[rule.field] ?? '').trim();
  const v = rule.value.trim();
  switch (rule.op) {
    case 'equals': return cell === v;
    case 'not_equals': return cell !== v;
    case 'contains': return cell.includes(v);
    case 'not_contains': return !cell.includes(v);
    case 'starts_with': return cell.startsWith(v);
    case 'in': return v.split(',').map((s) => s.trim()).filter(Boolean).includes(cell);
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
