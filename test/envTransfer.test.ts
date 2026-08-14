import { describe, it, expect } from 'vitest';
import {
  toBundle, applyBundle, normalizeBundle, unresolvedGroupIds, sameOrigin,
  bundleFileName, EXTRACTION_KEYS,
} from '../src/lib/envTransfer';
import type { MikkeSettings } from '../src/types';

const DEV_GROUPS = [
  { id: 11, title: 'Mikke 管理者' },
  { id: 12, title: 'エナジー事業 資産管理者' },
  { id: 13, title: 'モビリティ事業 資産管理者' },
];
// ★ 本番は同じ名前でも **ID が違う**。ここがこの機能の肝。
const PROD_GROUPS = [
  { id: 47, title: 'Mikke 管理者' },
  { id: 52, title: 'エナジー事業 資産管理者' },
  { id: 61, title: 'モビリティ事業 資産管理者' },
];

const DEV_SETTINGS: MikkeSettings = {
  managedColumns: ['Scan_Asset', 'Scan_Severity'],
  matchConditions: { combinator: 'AND', rules: [{ field: 'Severity', op: 'equals', value: 'High' }] },
  individualIds: ['IID-1', 'IID-2'],
  assetColumns: ['FQDN', 'IP'],
  vulnTypeRules: { port: ['open port'], admin: ['admin panel'] },
  vulnResponsePerms: {
    adminGroupIds: [11],
    byBusinessCompany: { 'エナジー事業': [12], 'モビリティ事業': [13] },
    aliasesByCompany: { 'エナジー事業': ['ENG'], 'モビリティ事業': ['MOB'] },
  },
  migrationAliasRemap: [{ to: 'ENG', from: ['ENERGY'] }],
  downloadFolder: 'Shared Documents/DevOnly',   // 環境ごとの値。運ばない
};

const EMPTY: MikkeSettings = { managedColumns: [], matchConditions: null, individualIds: [] };
const NOW = '2026-08-14T00:00:00.000Z';

describe('持ち出し: グループ ID を名前に置き換える', () => {
  it('★ アクセス権はグループ名で持ち出す (ID はサイトごとに違うため)', () => {
    const b = toBundle(DEV_SETTINGS, DEV_GROUPS, ['perms'], 'https://t.sharepoint.com/sites/dev', NOW);
    expect(b.perms).toEqual({
      adminGroups: ['Mikke 管理者'],
      byBusinessCompany: {
        'エナジー事業': ['エナジー事業 資産管理者'],
        'モビリティ事業': ['モビリティ事業 資産管理者'],
      },
      aliasesByCompany: { 'エナジー事業': ['ENG'], 'モビリティ事業': ['MOB'] },
      aliasRemap: [{ to: 'ENG', from: ['ENERGY'] }],
    });
  });

  it('抽出条件はそのまま持ち出す', () => {
    const b = toBundle(DEV_SETTINGS, DEV_GROUPS, ['extraction'], 'x', NOW);
    expect(b.extraction?.managedColumns).toEqual(['Scan_Asset', 'Scan_Severity']);
    expect(b.extraction?.individualIds).toEqual(['IID-1', 'IID-2']);
    expect(b.extraction?.vulnTypeRules).toEqual({ port: ['open port'], admin: ['admin panel'] });
  });

  it('★ 環境ごとの値 (保存先フォルダ) は運ばない', () => {
    const b = toBundle(DEV_SETTINGS, DEV_GROUPS, ['extraction', 'perms'], 'x', NOW);
    expect(JSON.stringify(b)).not.toContain('DevOnly');
    expect(EXTRACTION_KEYS as readonly string[]).not.toContain('downloadFolder');
  });

  it('選ばなかったものは入れない', () => {
    const b = toBundle(DEV_SETTINGS, DEV_GROUPS, ['extraction'], 'x', NOW);
    expect(b.perms).toBeUndefined();
    expect(toBundle(DEV_SETTINGS, DEV_GROUPS, ['perms'], 'x', NOW).extraction).toBeUndefined();
  });

  it('削除済みグループ (名前を引けない ID) は名指しできる', () => {
    const s = { ...DEV_SETTINGS, vulnResponsePerms: {
      adminGroupIds: [11, 99], byBusinessCompany: { A: [98] } } } as MikkeSettings;
    expect(unresolvedGroupIds(s, DEV_GROUPS)).toEqual([98, 99]);
  });
});

describe('持ち込み: 移送先のグループ ID に引き直す', () => {
  it('★ 同じ名前のグループを、本番の ID で割り当て直す', () => {
    const b = toBundle(DEV_SETTINGS, DEV_GROUPS, ['perms'], 'dev', NOW);
    const r = applyBundle(EMPTY, b, PROD_GROUPS, ['perms']);
    expect(r.settings.vulnResponsePerms).toEqual({
      adminGroupIds: [47],                                   // 11 ではない
      byBusinessCompany: { 'エナジー事業': [52], 'モビリティ事業': [61] },
      aliasesByCompany: { 'エナジー事業': ['ENG'], 'モビリティ事業': ['MOB'] },
    });
    expect(r.missingGroups).toEqual([]);
  });

  it('★ 開発の ID がそのまま本番に入ることはない (別グループに権限が付く事故)', () => {
    const b = toBundle(DEV_SETTINGS, DEV_GROUPS, ['perms'], 'dev', NOW);
    const ids = JSON.stringify(applyBundle(EMPTY, b, PROD_GROUPS, ['perms']).settings.vulnResponsePerms);
    for (const devId of [11, 12, 13]) expect(ids).not.toContain(String(devId));
  });

  it('★ 移送先に無いグループ名は名指しし、その割当は空にする', () => {
    const b = toBundle(DEV_SETTINGS, DEV_GROUPS, ['perms'], 'dev', NOW);
    const r = applyBundle(EMPTY, b, [{ id: 47, title: 'Mikke 管理者' }], ['perms']);
    expect(r.missingGroups).toEqual(['エナジー事業 資産管理者', 'モビリティ事業 資産管理者']);
    expect(r.settings.vulnResponsePerms!.byBusinessCompany).toEqual({
      'エナジー事業': [], 'モビリティ事業': [],
    });
    expect(r.settings.vulnResponsePerms!.adminGroupIds).toEqual([47]);
  });

  it('グループ名の大文字小文字・前後空白の違いは吸収する', () => {
    const b = toBundle(DEV_SETTINGS, DEV_GROUPS, ['perms'], 'dev', NOW);
    const r = applyBundle(EMPTY, b, [{ id: 47, title: '  mikke 管理者 ' }], ['perms']);
    expect(r.settings.vulnResponsePerms!.adminGroupIds).toEqual([47]);
  });

  it('抽出条件は移送先の設定を置き換える', () => {
    const b = toBundle(DEV_SETTINGS, DEV_GROUPS, ['extraction'], 'dev', NOW);
    const r = applyBundle({ ...EMPTY, individualIds: ['OLD'] }, b, PROD_GROUPS, ['extraction']);
    expect(r.settings.individualIds).toEqual(['IID-1', 'IID-2']);
  });

  it('★ 選んでいないものは移送先の値を残す', () => {
    const b = toBundle(DEV_SETTINGS, DEV_GROUPS, ['extraction', 'perms'], 'dev', NOW);
    const cur = { ...EMPTY, individualIds: ['KEEP'] } as MikkeSettings;
    const r = applyBundle(cur, b, PROD_GROUPS, ['perms']);   // アクセス権だけ
    expect(r.settings.individualIds).toEqual(['KEEP']);
    expect(r.settings.vulnResponsePerms).toBeTruthy();
  });

  it('★ 変わらないものは差分に出さない (何が変わるか分かるようにする)', () => {
    const b = toBundle(DEV_SETTINGS, DEV_GROUPS, ['extraction'], 'dev', NOW);
    const already = applyBundle(EMPTY, b, PROD_GROUPS, ['extraction']).settings;
    expect(applyBundle(already, b, PROD_GROUPS, ['extraction']).changes).toEqual([]);
  });

  it('差分には項目名と前後が入る', () => {
    const b = toBundle(DEV_SETTINGS, DEV_GROUPS, ['extraction'], 'dev', NOW);
    const r = applyBundle(EMPTY, b, PROD_GROUPS, ['extraction']);
    expect(r.changes.find((c) => c.field === 'individualIds'))
      .toEqual({ field: 'individualIds', before: '(なし)', after: '2 件' });
  });
});

describe('ファイル経由の受け渡し', () => {
  it('壊れた JSON / 別形式は取り込まない', () => {
    expect(normalizeBundle(null)).toBeNull();
    expect(normalizeBundle({})).toBeNull();
    expect(normalizeBundle({ version: 2 })).toBeNull();
    expect(normalizeBundle('nope')).toBeNull();
  });

  it('★ 書き出したものをそのまま読み戻せる', () => {
    const b = toBundle(DEV_SETTINGS, DEV_GROUPS, ['extraction', 'perms'], 'dev', NOW);
    const back = normalizeBundle(JSON.parse(JSON.stringify(b)));
    expect(back).toEqual(b);
  });

  it('perms が壊れていても落ちない', () => {
    const back = normalizeBundle({ version: 1, perms: { adminGroups: 'x', byBusinessCompany: 5 } });
    expect(back!.perms).toEqual({
      adminGroups: [], byBusinessCompany: {}, aliasesByCompany: {}, aliasRemap: [],
    });
  });

  it('ファイル名に日時と中身が入る', () => {
    expect(bundleFileName(['extraction', 'perms'], NOW))
      .toBe('mikke-settings-extraction+perms-20260814-000000.json');
  });
});

describe('直接コピーできるかの判定', () => {
  it('★ 同じテナントなら直接コピーできる', () => {
    expect(sameOrigin('https://t.sharepoint.com/sites/dev', 'https://t.sharepoint.com/sites/prod')).toBe(true);
  });

  it('★ 別テナントは直接コピーできない (ブラウザが遮る)', () => {
    expect(sameOrigin('https://dev.sharepoint.com/sites/a', 'https://prod.sharepoint.com/sites/a')).toBe(false);
  });

  it('URL が壊れていれば false', () => {
    expect(sameOrigin('', 'https://t.sharepoint.com/sites/a')).toBe(false);
    expect(sameOrigin('not a url', 'not a url')).toBe(false);
  });
});
