import { describe, it, expect } from 'vitest';
import {
  buildVulnResponsePlan, toVulnResponseFields, isExcluded,
  type VulnResponseRow,
} from '../src/lib/vulnResponseSync';
import type { ManagedIssue, ManagedAsset } from '../src/types';

function issue(over: Partial<ManagedIssue> = {}): ManagedIssue {
  return {
    id: 1, title: 'TLS 1.0 が有効', issueInstanceId: 'IID-1',
    detectionStatus: '継続', mgmtStatus: '未着手', isOutOfScope: false,
    firstSeen: '2026-05-01T00:00:00Z', lastSeen: '2026-07-30T00:00:00Z',
    scanFields: {}, ...over,
  } as ManagedIssue;
}

const ASSETS = new Map<string, ManagedAsset>([
  ['web01.example.com', { id: 1, assetKey: 'web01.example.com', assetType: 'FQDN',
    businessCompany: 'エナジー事業', affiliateCompany: 'ABC株式会社',
    mgmtNumber: 'W-0001', identifyEvidence: 'FQDN一致' }],
  ['10.1.2.3', { id: 2, assetKey: '10.1.2.3', assetType: 'IP', mgmtNumber: 'W-0002' }],
]);

/** その脆弱性の資産キー (テストでは固定で渡す)。 */
const keysOf = (keys: string[]) => () => keys;

function row(over: Partial<VulnResponseRow> = {}): VulnResponseRow {
  const f = toVulnResponseFields(issue(), ['web01.example.com'], ASSETS);
  return { id: 100, ...f, ...over };
}

describe('toVulnResponseFields: 連携用リストへ書く内容', () => {
  it('資産キーを IP と FQDN に振り分ける', () => {
    const f = toVulnResponseFields(issue(), ['web01.example.com', '10.1.2.3'], ASSETS);
    expect(f.assetFqdn).toBe('web01.example.com');
    expect(f.assetIp).toBe('10.1.2.3');
    expect(f.assetType).toBe('FQDN');   // FQDN があれば FQDN 扱い
  });

  it('代表以外の資産キーを関連資産に並べる', () => {
    const f = toVulnResponseFields(issue(), ['web01.example.com', '10.1.2.3'], ASSETS);
    expect(f.relatedAssets).toBe('10.1.2.3');
  });

  it('事業会社・管理会社・Web資産管理ID・特定根拠は資産リストから引く', () => {
    const f = toVulnResponseFields(issue(), ['web01.example.com'], ASSETS);
    expect(f.businessCompany).toBe('エナジー事業');
    expect(f.affiliateCompany).toBe('ABC株式会社');
    expect(f.assetMgmtId).toBe('W-0001');
    expect(f.identifyEvidence).toBe('FQDN一致');
  });

  it('資産リストに無い資産でも落ちない (空になるだけ)', () => {
    const f = toVulnResponseFields(issue(), ['unknown.example.com'], ASSETS);
    expect(f.businessCompany).toBe('');
    expect(f.assetFqdn).toBe('unknown.example.com');
  });

  it('外部接続申請ID・旧管理番号は管理対象から渡す', () => {
    const f = toVulnResponseFields(
      issue({ extConnAppId: 'EXT-1', legacyMgmtNumber: 'AAA-2606-01' }), [], ASSETS);
    expect(f.extConnAppId).toBe('EXT-1');
    expect(f.legacyMgmtNumber).toBe('AAA-2606-01');
  });
});

describe('isExcluded: 連携用リストから消す対象', () => {
  it('対象外フラグ / 対応ステータス対象外 のどちらでも対象', () => {
    expect(isExcluded(issue({ isOutOfScope: true }))).toBe(true);
    expect(isExcluded(issue({ mgmtStatus: '対象外' }))).toBe(true);
    expect(isExcluded(issue())).toBe(false);
  });
});

describe('buildVulnResponsePlan: 追加 / 更新 / 削除の計画', () => {
  it('連携用リストに無いものは追加する', () => {
    const plan = buildVulnResponsePlan([issue()], ASSETS, keysOf(['web01.example.com']), []);
    expect(plan.creates).toHaveLength(1);
    expect(plan.creates[0]!.issueInstanceId).toBe('IID-1');
  });

  it('内容が同じなら何もしない (毎回書き込まない)', () => {
    const plan = buildVulnResponsePlan([issue()], ASSETS, keysOf(['web01.example.com']), [row()]);
    expect(plan.creates).toEqual([]);
    expect(plan.updates).toEqual([]);
    expect(plan.unchanged).toBe(1);
  });

  it('変わった項目だけ更新する', () => {
    const plan = buildVulnResponsePlan(
      [issue({ detectionStatus: '再検知' })], ASSETS, keysOf(['web01.example.com']), [row()]);
    expect(plan.updates).toHaveLength(1);
    expect(plan.updates[0]!.fields).toEqual({ detectionStatus: '再検知' });
  });

  it('検知日は日単位で比べる (時刻差で毎回更新しない)', () => {
    const plan = buildVulnResponsePlan(
      [issue({ lastSeen: '2026-07-30T15:00:00Z' })], ASSETS, keysOf(['web01.example.com']), [row()]);
    expect(plan.updates).toEqual([]);
    expect(plan.unchanged).toBe(1);
  });

  it('管理対象外にしたものは削除する', () => {
    const plan = buildVulnResponsePlan(
      [issue({ mgmtStatus: '対象外' })], ASSETS, keysOf(['web01.example.com']), [row()]);
    expect(plan.deletes).toEqual([{ id: 100, issueInstanceId: 'IID-1', reason: '対象外' }]);
    expect(plan.updates).toEqual([]);
  });

  it('対象外を解除すると、連携用リストに無いので再び追加される', () => {
    const plan = buildVulnResponsePlan([issue()], ASSETS, keysOf(['web01.example.com']), []);
    expect(plan.creates).toHaveLength(1);
    expect(plan.deletes).toEqual([]);
  });

  it('対象外のものが連携用リストにも無ければ何もしない', () => {
    const plan = buildVulnResponsePlan(
      [issue({ isOutOfScope: true })], ASSETS, keysOf([]), []);
    expect(plan.creates).toEqual([]);
    expect(plan.deletes).toEqual([]);
  });

  it('管理対象から消えたものも連携用リストから削除する', () => {
    const plan = buildVulnResponsePlan([], ASSETS, keysOf([]), [row({ issueInstanceId: 'IID-9' })]);
    expect(plan.deletes).toEqual([{ id: 100, issueInstanceId: 'IID-9', reason: '管理対象に無い' }]);
  });

  it('突合キーが無い脆弱性は扱わない', () => {
    const plan = buildVulnResponsePlan([issue({ issueInstanceId: '' })], ASSETS, keysOf([]), []);
    expect(plan.creates).toEqual([]);
  });

  it('資産管理者の記入欄は計画に含めない (触らない)', () => {
    const plan = buildVulnResponsePlan([issue()], ASSETS, keysOf(['web01.example.com']), []);
    const keys = Object.keys(plan.creates[0]!);
    for (const forbidden of ['responseStatus', 'responder', 'dueDate', 'responseNote', 'remarks']) {
      expect(keys).not.toContain(forbidden);
    }
  });
});
