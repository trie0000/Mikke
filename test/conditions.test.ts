import { describe, it, expect } from 'vitest';
import { evalConditions } from '../src/lib/conditions';
import type { ConditionGroup } from '../src/types';

const row = { Severity: 'Critical', Asset: 'admin.example.com', Status: 'open' };

describe('conditions: 単一ルール', () => {
  it('equals 一致', () => {
    const g: ConditionGroup = { combinator: 'OR', rules: [{ field: 'Severity', op: 'equals', value: 'Critical' }] };
    expect(evalConditions(g, row)).toBe(true);
  });
  it('equals 不一致', () => {
    const g: ConditionGroup = { combinator: 'OR', rules: [{ field: 'Severity', op: 'equals', value: 'Low' }] };
    expect(evalConditions(g, row)).toBe(false);
  });
  it('contains', () => {
    const g: ConditionGroup = { combinator: 'OR', rules: [{ field: 'Asset', op: 'contains', value: 'example.com' }] };
    expect(evalConditions(g, row)).toBe(true);
  });
  it('not_contains', () => {
    const g: ConditionGroup = { combinator: 'OR', rules: [{ field: 'Asset', op: 'not_contains', value: 'foo' }] };
    expect(evalConditions(g, row)).toBe(true);
  });
  it('starts_with', () => {
    const g: ConditionGroup = { combinator: 'OR', rules: [{ field: 'Asset', op: 'starts_with', value: 'admin' }] };
    expect(evalConditions(g, row)).toBe(true);
  });
  it('in (カンマ区切り)', () => {
    const g: ConditionGroup = { combinator: 'OR', rules: [{ field: 'Severity', op: 'in', value: 'Critical, High' }] };
    expect(evalConditions(g, row)).toBe(true);
  });
});

describe('conditions: AND / OR', () => {
  it('AND は全一致で true', () => {
    const g: ConditionGroup = { combinator: 'AND', rules: [
      { field: 'Severity', op: 'equals', value: 'Critical' },
      { field: 'Status', op: 'equals', value: 'open' },
    ] };
    expect(evalConditions(g, row)).toBe(true);
  });
  it('AND は1つ外れると false', () => {
    const g: ConditionGroup = { combinator: 'AND', rules: [
      { field: 'Severity', op: 'equals', value: 'Critical' },
      { field: 'Status', op: 'equals', value: 'closed' },
    ] };
    expect(evalConditions(g, row)).toBe(false);
  });
  it('OR は1つ当たれば true', () => {
    const g: ConditionGroup = { combinator: 'OR', rules: [
      { field: 'Severity', op: 'equals', value: 'Low' },
      { field: 'Status', op: 'equals', value: 'open' },
    ] };
    expect(evalConditions(g, row)).toBe(true);
  });
  it('ネストグループ (OR内にAND)', () => {
    const g: ConditionGroup = { combinator: 'OR', rules: [
      { field: 'Severity', op: 'equals', value: 'Low' },
      { combinator: 'AND', rules: [
        { field: 'Asset', op: 'contains', value: 'admin' },
        { field: 'Status', op: 'equals', value: 'open' },
      ] },
    ] };
    expect(evalConditions(g, row)).toBe(true);
  });
});

describe('conditions: 数値比較 (以上/以下/範囲)', () => {
  const r = { CVSS: '7.4', Port: '443' };
  it('gte (以上)', () => {
    expect(evalConditions({ combinator: 'OR', rules: [{ field: 'CVSS', op: 'gte', value: '7' }] }, r)).toBe(true);
    expect(evalConditions({ combinator: 'OR', rules: [{ field: 'CVSS', op: 'gte', value: '7.4' }] }, r)).toBe(true);
    expect(evalConditions({ combinator: 'OR', rules: [{ field: 'CVSS', op: 'gte', value: '8' }] }, r)).toBe(false);
  });
  it('lte (以下)', () => {
    expect(evalConditions({ combinator: 'OR', rules: [{ field: 'CVSS', op: 'lte', value: '8' }] }, r)).toBe(true);
    expect(evalConditions({ combinator: 'OR', rules: [{ field: 'CVSS', op: 'lte', value: '7' }] }, r)).toBe(false);
  });
  it('gt / lt', () => {
    expect(evalConditions({ combinator: 'OR', rules: [{ field: 'Port', op: 'gt', value: '442' }] }, r)).toBe(true);
    expect(evalConditions({ combinator: 'OR', rules: [{ field: 'Port', op: 'lt', value: '443' }] }, r)).toBe(false);
  });
  it('between (範囲)', () => {
    expect(evalConditions({ combinator: 'OR', rules: [{ field: 'CVSS', op: 'between', value: '7', value2: '8' }] }, r)).toBe(true);
    expect(evalConditions({ combinator: 'OR', rules: [{ field: 'CVSS', op: 'between', value: '8', value2: '9' }] }, r)).toBe(false);
  });
  it('数値は桁区切りカンマを無視', () => {
    expect(evalConditions({ combinator: 'OR', rules: [{ field: 'n', op: 'gte', value: '1,000' }] }, { n: '2,500' })).toBe(true);
  });
});

describe('conditions: 日付比較 (以降/以前/期間)', () => {
  const r = { FirstSeen: '2026-03-12', LastSeen: '2026-05-01 09:30' };
  it('gte (以降)', () => {
    expect(evalConditions({ combinator: 'OR', rules: [{ field: 'FirstSeen', op: 'gte', value: '2026-03-01' }] }, r)).toBe(true);
    expect(evalConditions({ combinator: 'OR', rules: [{ field: 'FirstSeen', op: 'gte', value: '2026-04-01' }] }, r)).toBe(false);
  });
  it('lte (以前)', () => {
    expect(evalConditions({ combinator: 'OR', rules: [{ field: 'FirstSeen', op: 'lte', value: '2026-03-31' }] }, r)).toBe(true);
  });
  it('between (期間)', () => {
    expect(evalConditions({ combinator: 'OR', rules: [{ field: 'FirstSeen', op: 'between', value: '2026-01-01', value2: '2026-06-30' }] }, r)).toBe(true);
    expect(evalConditions({ combinator: 'OR', rules: [{ field: 'FirstSeen', op: 'between', value: '2026-04-01', value2: '2026-06-30' }] }, r)).toBe(false);
  });
  it('日時を含むセルも日付として比較できる', () => {
    expect(evalConditions({ combinator: 'OR', rules: [{ field: 'LastSeen', op: 'gte', value: '2026-05-01' }] }, r)).toBe(true);
  });
});

describe('conditions: 比較の空値ガード', () => {
  it('セルが空なら比較系は false', () => {
    expect(evalConditions({ combinator: 'OR', rules: [{ field: 'X', op: 'gte', value: '5' }] }, { X: '' })).toBe(false);
  });
});

describe('conditions: 空 / null', () => {
  it('null は false (何も管理対象化しない)', () => {
    expect(evalConditions(null, row)).toBe(false);
  });
  it('ルール0件は false', () => {
    expect(evalConditions({ combinator: 'AND', rules: [] }, row)).toBe(false);
  });
});
