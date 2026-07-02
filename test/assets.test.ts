import { describe, it, expect } from 'vitest';
import {
  normalizeAsset, isIp, assetTypeOf, splitAssetCell, extractAssetKeys,
  joinFqdn, dataRowsOfDeptCsv, buildAssetDirectory, matchAssets,
} from '../src/lib/assets';
import { parseCsv } from '../src/lib/csv';
import { scanFieldName } from '../src/lib/scanName';
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
  it('カンマ / セミコロン / 空白区切り', () => {
    expect(splitAssetCell('a.example.com, 10.0.0.1; b.example.com')).toEqual([
      'a.example.com', '10.0.0.1', 'b.example.com',
    ]);
  });
  it('空セルは空配列', () => {
    expect(splitAssetCell('')).toEqual([]);
  });
});

describe('extractAssetKeys', () => {
  const mk = (id: number, scanFields: Record<string, string>): ManagedIssue => ({
    id, title: 't', issueInstanceId: `i-${id}`, detectionStatus: '新規',
    mgmtStatus: '未通知', isOutOfScope: false, scanFields,
  });
  it('mock 形式 (Scan_元名) と SP 形式 (安全名) の両方から抽出しユニーク化', () => {
    const issues = [
      mk(1, { 'Scan_Asset': 'Web01.example.com' }),               // mock キー
      mk(2, { [scanFieldName('Asset')]: 'web01.example.com' }),   // SP 安全名キー (重複)
      mk(3, { 'Scan_Asset': '10.0.0.5' }),
    ];
    const keys = extractAssetKeys(issues, 'Asset', scanFieldName);
    expect(keys.sort()).toEqual(['10.0.0.5', 'web01.example.com']);
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
      affiliateCompany: 'ABC株式会社', identifyReason: '資産管理部門リスト CSV 突合',
      updatedAt: now,
    });
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
});
