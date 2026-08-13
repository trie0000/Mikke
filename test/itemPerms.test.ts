import { describe, it, expect } from 'vitest';
import {
  normalizePerms, hasAnyPerms, groupIdsFor, pickRoles, buildItemPermPlan,
  companyChoices, companiesWithoutGroups, EMPTY_PERMS,
} from '../src/lib/itemPerms';

const PERMS = normalizePerms({
  adminGroupIds: [11],
  byBusinessCompany: { 'エナジー事業': [12], 'モビリティ事業': [13, 14] },
});

describe('normalizePerms: 壊れた保存値でも落ちない', () => {
  it('数値以外・0 以下・重複を落とす', () => {
    const p = normalizePerms({ adminGroupIds: [11, 11, 0, -3, 'x', null] });
    expect(p.adminGroupIds).toEqual([11]);
  });

  it('割当が空の事業会社は持たない (残すと「設定済み」に見える)', () => {
    const p = normalizePerms({ byBusinessCompany: { A: [], B: [5], '  ': [7] } });
    expect(p.byBusinessCompany).toEqual({ B: [5] });
  });

  it('未設定・null・壊れた形でも空の設定になる', () => {
    expect(normalizePerms(undefined)).toEqual(EMPTY_PERMS);
    expect(normalizePerms(null)).toEqual(EMPTY_PERMS);
    expect(normalizePerms({ byBusinessCompany: 'not-an-object' })).toEqual(EMPTY_PERMS);
  });

  it('事業会社名の前後の空白は落とす (SP の値と突合するため)', () => {
    expect(normalizePerms({ byBusinessCompany: { '  エナジー事業  ': [12] } }).byBusinessCompany)
      .toEqual({ 'エナジー事業': [12] });
  });
});

describe('hasAnyPerms: 未設定なら権限適用そのものを行わない', () => {
  it('管理者だけでも設定済み', () => {
    expect(hasAnyPerms(normalizePerms({ adminGroupIds: [1] }))).toBe(true);
  });
  it('割当だけでも設定済み', () => {
    expect(hasAnyPerms(normalizePerms({ byBusinessCompany: { A: [2] } }))).toBe(true);
  });
  it('空なら未設定', () => {
    expect(hasAnyPerms(EMPTY_PERMS)).toBe(false);
  });
});

describe('pickRoles: 使うロール定義を選ぶ', () => {
  it('読み取り(2) / 投稿(3) / フルコントロール(5)', () => {
    expect(pickRoles([
      { Id: 1073741826, RoleTypeKind: 2 }, { Id: 1073741827, RoleTypeKind: 3 },
      { Id: 1073741829, RoleTypeKind: 5 },
    ])).toEqual({ read: 1073741826, edit: 1073741827, full: 1073741829 });
  });

  it('投稿が無いサイトでは編集(6)で代替する', () => {
    const r = pickRoles([
      { Id: 2, RoleTypeKind: 2 }, { Id: 6, RoleTypeKind: 6 }, { Id: 5, RoleTypeKind: 5 },
    ]);
    expect(r.edit).toBe(6);
  });

  it('足りなければ落とす (黙って権限を付け損ねない)', () => {
    expect(() => pickRoles([{ Id: 2, RoleTypeKind: 2 }])).toThrow(/ロール定義/);
  });
});

describe('buildItemPermPlan: アイテムごとの付与内容', () => {
  const items = [
    { id: 1, businessCompany: 'エナジー事業' },
    { id: 2, businessCompany: 'モビリティ事業' },
    { id: 3, businessCompany: '未登録の会社' },
    { id: 4, businessCompany: '' },
  ];

  it('管理者は全アイテムにフルコントロール', () => {
    for (const p of buildItemPermPlan(items, PERMS)) expect(p.full).toEqual([11]);
  });

  it('事業会社の割当はそのアイテムだけに付く', () => {
    const plan = buildItemPermPlan(items, PERMS);
    expect(plan[0]!.edit).toEqual([12]);
    expect(plan[1]!.edit).toEqual([13, 14]);
  });

  it('割当が無い事業会社は管理者のみ (edit は空)', () => {
    const plan = buildItemPermPlan(items, PERMS);
    expect(plan[2]!.edit).toEqual([]);
    expect(plan[3]!.edit).toEqual([]);
  });

  it('★ 管理者と同じグループには投稿を重ねない', () => {
    // フルコントロールを付けた直後に投稿を付けると権限が下がる。
    const p = normalizePerms({ adminGroupIds: [11], byBusinessCompany: { A: [11, 12] } });
    const plan = buildItemPermPlan([{ id: 1, businessCompany: 'A' }], p);
    expect(plan[0]!.full).toEqual([11]);
    expect(plan[0]!.edit).toEqual([12]);
  });
});

describe('画面に出す事業会社の候補', () => {
  const inUse = ['モビリティ事業', 'エナジー事業', '', 'エナジー事業'];

  it('実データの値と割当済みの値を重複なく並べる', () => {
    expect(companyChoices(inUse, PERMS)).toEqual(['エナジー事業', 'モビリティ事業']);
  });

  it('リストから消えた事業会社の割当も残す (消えると設定が見えなくなる)', () => {
    const p = normalizePerms({ byBusinessCompany: { '解散した事業': [9] } });
    expect(companyChoices(['エナジー事業'], p)).toContain('解散した事業');
  });

  it('割当が無い事業会社を名指しできる (管理者しか見られないので注意を出す)', () => {
    expect(companiesWithoutGroups(['エナジー事業', '未登録の会社'], PERMS)).toEqual(['未登録の会社']);
  });
});

describe('groupIdsFor', () => {
  it('前後に空白があっても引ける', () => {
    expect(groupIdsFor('  エナジー事業 ', PERMS)).toEqual([12]);
  });
  it('未登録なら空', () => {
    expect(groupIdsFor('知らない会社', PERMS)).toEqual([]);
  });
});
