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

describe('conditions: 空 / null', () => {
  it('null は false (何も管理対象化しない)', () => {
    expect(evalConditions(null, row)).toBe(false);
  });
  it('ルール0件は false', () => {
    expect(evalConditions({ combinator: 'AND', rules: [] }, row)).toBe(false);
  });
});
