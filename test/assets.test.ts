import { describe, it, expect } from 'vitest';
import {
  normalizeAsset, isIp, assetTypeOf, splitAssetCell, extractAssets, countIssuesByAsset,
  joinFqdn, dataRowsOfDeptCsv, buildAssetDirectory, matchAssets, assetSourceColumns,
} from '../src/lib/assets';
import { parseCsv } from '../src/lib/csv';
import type { ManagedIssue, ManagedAsset } from '../src/types';

describe('normalizeAsset / isIp', () => {
  it('小文字化・trim・末尾ドット除去', () => {
    expect(normalizeAsset(' WWW.Example.COM. ')).toBe('www.example.com');
  });
  it('スキーム・パス・ポートを除去', () => {
    expect(normalizeAsset('https://www.example.com/path?q=1')).toBe('www.example.com');
    expect(normalizeAsset('example.com:8443')).toBe('example.com');
  });
  it('IPv4 判定', () => {
    expect(isIp('192.168.1.1')).toBe(true);
    expect(isIp('256.1.1.1')).toBe(false);
    expect(isIp('example.com')).toBe(false);
    expect(assetTypeOf('10.0.0.1')).toBe('IP');
    expect(assetTypeOf('www.example.com')).toBe('FQDN');
  });
});

describe('splitAssetCell', () => {
  it('カンマ / セミコロン / 空白 / パイプ区切り', () => {
    expect(splitAssetCell('a.example.com, 10.0.0.1; b.example.com')).toEqual([
      'a.example.com', '10.0.0.1', 'b.example.com',
    ]);
    expect(splitAssetCell('10.0.0.1 | 10.0.0.2 | web.example.com')).toEqual([
      '10.0.0.1', '10.0.0.2', 'web.example.com',
    ]);
  });
  it('空セルは空配列', () => {
    expect(splitAssetCell('')).toEqual([]);
  });
});

describe('extractAssets (複数列・グループ)', () => {
  const mk = (id: number, scanFields: Record<string, string>): ManagedIssue => ({
    id, title: 't', issueInstanceId: `i-${id}`, detectionStatus: '新規',
    mgmtStatus: '未通知', isOutOfScope: false, scanFields,
  });
  it('複数列から抽出しユニーク化 + パイプ複数値を個別展開', () => {
    const issues = [
      mk(1, { 'Scan_FQDN': 'Web01.example.com', 'Scan_IP': '10.0.0.1 | 10.0.0.2' }),
      mk(2, { 'Scan_FQDN': 'web01.example.com', 'Scan_IP': '10.0.0.3' }),   // FQDN 重複
    ];
    const { keys } = extractAssets(issues, ['FQDN', 'IP']);
    expect(keys.sort()).toEqual(['10.0.0.1', '10.0.0.2', '10.0.0.3', 'web01.example.com']);
  });
  it('脆弱性ごとのグループ (同一 issue の資産を束ねる)', () => {
    const issues = [mk(1, { 'Scan_FQDN': 'a.example.com', 'Scan_IP': '10.0.0.1 | 10.0.0.2' })];
    const { groups } = extractAssets(issues, ['FQDN', 'IP']);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.iid).toBe('i-1');
    expect(groups[0]!.keys.sort()).toEqual(['10.0.0.1', '10.0.0.2', 'a.example.com']);
  });
  it('countIssuesByAsset は同一脆弱性内の重複を 1 件で数える', () => {
    const issues = [
      mk(1, { 'Scan_FQDN': 'a.example.com', 'Scan_IP': '10.0.0.1' }),
      mk(2, { 'Scan_FQDN': 'a.example.com', 'Scan_IP': '10.0.0.2' }),
    ];
    const counts = countIssuesByAsset(issues, ['FQDN', 'IP']);
    expect(counts['a.example.com']).toBe(2);
    expect(counts['10.0.0.1']).toBe(1);
  });
});

describe('joinFqdn', () => {
  it('サブドメイン + ドメインネーム を結合', () => {
    expect(joinFqdn('www', 'example.com')).toBe('www.example.com');
  });
  it('サブドメイン空 → ドメインのみ', () => {
    expect(joinFqdn('', 'example.com')).toBe('example.com');
  });
  it('サブドメインが既に FQDN 全体なら二重結合しない', () => {
    expect(joinFqdn('www.example.com', 'example.com')).toBe('www.example.com');
    expect(joinFqdn('example.com', 'example.com')).toBe('example.com');
  });
});

// 仕様: 1行目=ヘッダ、2行目=コメント (読み飛ばし)、3行目〜=実データ。
const BASE_CSV = [
  '管理番号,組織区分　第１階層名,関係会社/事業場略称,備考',
  'Web資産の管理番号,事業会社の名称,関係会社の略称,自由記述',
  'W-0001,エナジー事業,ABC株式会社,テスト',
  'W-0002,デバイス事業,,',
].join('\n');

const SITE_CSV = [
  '管理番号,サブドメイン,ドメインネーム,URL',
  '同上,ホスト名部分,ドメイン部分,参考',
  'W-0001,www,example.com,https://www.example.com',
  'W-0001,api,example.com,',       // 同一管理番号で複数 FQDN
  'W-0002,,example.org,',           // サブドメイン空
  'W-9999,x,unknown.example,',      // 基本情報に無い管理番号
].join('\n');

describe('buildAssetDirectory', () => {
  it('コメント行を読み飛ばし、FQDN → 管理番号/会社 を構築する', () => {
    const dir = buildAssetDirectory(parseCsv(BASE_CSV), parseCsv(SITE_CSV));
    expect(dir.size).toBe(4);
    expect(dir.get('www.example.com')).toMatchObject({
      mgmtNumber: 'W-0001', businessCompany: 'エナジー事業', affiliateCompany: 'ABC株式会社',
    });
    expect(dir.get('api.example.com')?.mgmtNumber).toBe('W-0001');   // 複数行 FQDN
    expect(dir.get('example.org')).toMatchObject({
      mgmtNumber: 'W-0002', businessCompany: 'デバイス事業', affiliateCompany: '',
    });
    // 基本情報に無い管理番号 → 会社は空 + 根拠に注記
    const unknown = dir.get('x.unknown.example');
    expect(unknown?.mgmtNumber).toBe('W-9999');
    expect(unknown?.evidence).toContain('基本情報に該当する管理番号なし');
  });
  it('全角スペース入りヘッダ (組織区分　第１階層名) を空白無視で照合する', () => {
    const dir = buildAssetDirectory(parseCsv(BASE_CSV), parseCsv(SITE_CSV));
    expect(dir.get('www.example.com')?.businessCompany).toBe('エナジー事業');
  });
  it('dataRowsOfDeptCsv はコメント行 (2行目) を除く', () => {
    const rows = dataRowsOfDeptCsv(parseCsv(BASE_CSV));
    expect(rows.length).toBe(2);
    expect(rows[0]!['管理番号']).toBe('W-0001');
  });
});

describe('matchAssets', () => {
  const asset = (id: number, key: string, extra: Partial<ManagedAsset> = {}): ManagedAsset => ({
    id, assetKey: key, assetType: assetTypeOf(key), ...extra,
  });
  const now = '2026-06-11T00:00:00Z';

  it('FQDN 一致した資産の更新プランを作る (IP や不一致は対象外)', () => {
    const dir = buildAssetDirectory(parseCsv(BASE_CSV), parseCsv(SITE_CSV));
    const plan = matchAssets([
      asset(1, 'www.example.com'),
      asset(2, '10.0.0.1'),            // IP → サイトURL情報に無い
      asset(3, 'nomatch.example.jp'),  // 不一致
    ], dir, now);
    expect(plan.length).toBe(1);
    expect(plan[0]!.asset.id).toBe(1);
    expect(plan[0]!.patch).toMatchObject({
      mgmtNumber: 'W-0001', businessCompany: 'エナジー事業',
      affiliateCompany: 'ABC株式会社',
      updatedAt: now,
    });
    expect(plan[0]!.via).toBe('direct');
    // 特定理由は特定根拠に統合され、先頭に併記される
    expect(plan[0]!.patch.identifyEvidence).toContain('資産管理部門リスト CSV 突合');
    expect(plan[0]!.patch.identifyEvidence).toContain('www.example.com');
    expect(plan[0]!.patch.identifyEvidence).toContain('W-0001');
  });

  it('既に同じ値なら更新プランに含めない', () => {
    const dir = buildAssetDirectory(parseCsv(BASE_CSV), parseCsv(SITE_CSV));
    const plan = matchAssets([
      asset(1, 'www.example.com', {
        mgmtNumber: 'W-0001', businessCompany: 'エナジー事業', affiliateCompany: 'ABC株式会社',
      }),
    ], dir, now);
    expect(plan.length).toBe(0);
  });

  it('同一脆弱性の関連資産へ伝播 (FQDN 一致 → 同居 IP に会社/管理番号を引継ぎ)', () => {
    const dir = buildAssetDirectory(parseCsv(BASE_CSV), parseCsv(SITE_CSV));
    const assets = [asset(1, 'www.example.com'), asset(2, '10.0.0.1'), asset(3, '10.0.0.9')];
    // 脆弱性 i-1: www.example.com と 10.0.0.1 が同居 (10.0.0.9 は無関係)
    const groups = [{ iid: 'i-1', keys: ['www.example.com', '10.0.0.1'] }];
    const plan = matchAssets(assets, dir, now, groups);
    const byId = Object.fromEntries(plan.map((p) => [p.asset.id, p]));
    // 直接一致
    expect(byId[1]!.via).toBe('direct');
    // 伝播: 10.0.0.1 は www.example.com の会社/番号を引き継ぐ
    expect(byId[2]!.patch).toMatchObject({
      mgmtNumber: 'W-0001', businessCompany: 'エナジー事業', affiliateCompany: 'ABC株式会社',
    });
    expect(byId[2]!.via).toBe('propagated');
    expect(byId[2]!.patch.identifyEvidence).toContain('同一脆弱性の関連資産から特定');
    expect(byId[2]!.patch.identifyEvidence).toContain('i-1');
    expect(byId[2]!.patch.identifyEvidence).toContain('www.example.com');
    // 無関係の 10.0.0.9 は対象外
    expect(byId[3]).toBeUndefined();
  });

  it('伝播は直接一致を上書きしない (自分の直接一致を優先)', () => {
    const dir = buildAssetDirectory(parseCsv(BASE_CSV), parseCsv(SITE_CSV));
    // www.example.com(W-0001) と example.org(W-0002) が同一脆弱性で同居
    const assets = [asset(1, 'www.example.com'), asset(2, 'example.org')];
    const groups = [{ iid: 'i-9', keys: ['www.example.com', 'example.org'] }];
    const plan = matchAssets(assets, dir, now, groups);
    const byId = Object.fromEntries(plan.map((p) => [p.asset.id, p]));
    // 両者とも自分自身の直接一致が優先される
    expect(byId[1]!.patch.mgmtNumber).toBe('W-0001');
    expect(byId[2]!.patch.mgmtNumber).toBe('W-0002');
    expect(byId[2]!.via).toBe('direct');
  });
});

describe('移行データの資産列', () => {
  it('★ 設定の資産列に無くても、移行が書く列は必ず見る', () => {
    // 移行しかしていない環境では設定の列 (検査ツール CSV の列名) が 1 つも
    // 一致せず、連携用リストの IP / FQDN が空のままになっていた。
    expect(assetSourceColumns(['Asset'])).toEqual(['Asset', 'Asset IP', 'Asset Domain']);
  });

  it('重複は増やさない', () => {
    expect(assetSourceColumns(['Asset Domain', 'Asset IP']))
      .toEqual(['Asset Domain', 'Asset IP']);
  });
});
