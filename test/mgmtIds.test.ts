import { describe, it, expect } from 'vitest';
import { managedIssueFieldSpecs, assetFieldSpecs, vulnResponseFieldSpecs,
  VULNRESPONSE_OBSOLETE_FIELDS, VULNRESPONSE_VIEW_FIELDS } from '../src/api/sp/schema';
import { diffManagedIssue } from '../src/lib/issueChangeLog';
import type { ManagedIssue } from '../src/types';

// 管理系 ID は 3 種類 + 移行期間中だけの暫定 ID。
//   1. Issue Instance ID … 検査ツールが付ける
//   2. 資産管理ID        … 利用者側の Web 資産管理ツールの ID (資産リストの MgmtNumber)
//   3. 外部接続申請ID    … 利用者側の申請番号 (管理対象が持つ)
//   +  旧管理番号        … Excel 運用時代の「事業会社名-YYMM-XX」。将来廃止。
describe('管理系 ID の持ち場所', () => {
  const managed = managedIssueFieldSpecs().map((f) => f.name);
  const assets = assetFieldSpecs().map((f) => f.name);
  const vuln = vulnResponseFieldSpecs();
  const vulnNames = vuln.map((f) => f.name);

  it('検査ツールの ID は管理対象と連携用リストの両方にある', () => {
    expect(managed).toContain('IssueInstanceId');
    expect(vulnNames).toContain('IssueInstanceId');
  });

  it('資産管理ID の実体は資産リストが持つ (管理対象には持たせない)', () => {
    expect(assets).toContain('MgmtNumber');
    expect(managed).not.toContain('AssetMgmtId');
    // 連携用リストへは資産から引いて渡すので、受け皿だけある
    expect(vulnNames).toContain('AssetMgmtId');
  });

  it('外部接続申請ID は管理対象が持ち、連携用リストにも渡す', () => {
    expect(managed).toContain('ExtConnAppId');
    expect(vulnNames).toContain('ExtConnAppId');
  });

  it('旧管理番号は管理対象・連携用リストの両方で見られる (移行期間中の参考情報)', () => {
    expect(managed).toContain('LegacyMgmtNumber');
    expect(vulnNames).toContain('LegacyMgmtNumber');
  });

  it('連携用リストの「管理番号」は旧管理番号に一本化した (同じ値の列を並べない)', () => {
    expect(vulnNames).not.toContain('MgmtNumber');
    expect(VULNRESPONSE_OBSOLETE_FIELDS).toContain('MgmtNumber');
    // 表示名も揃える
    expect(vuln.find((f) => f.name === 'LegacyMgmtNumber')?.displayName).toBe('旧管理番号');
  });

  it('既定ビューにも旧管理番号を出す', () => {
    expect(VULNRESPONSE_VIEW_FIELDS).toContain('LegacyMgmtNumber');
    expect(VULNRESPONSE_VIEW_FIELDS).not.toContain('MgmtNumber');
  });

  it('連携用リストの ID 系はカードで見せるので本体では隠す', () => {
    for (const n of ['AssetMgmtId', 'ExtConnAppId', 'LegacyMgmtNumber']) {
      expect(vuln.find((f) => f.name === n)?.conditionalFormula).toBeTruthy();
    }
  });

  it('索引付きにして絞り込みに耐えるようにしている', () => {
    for (const n of ['IssueInstanceId', 'ExtConnAppId', 'LegacyMgmtNumber']) {
      expect(managedIssueFieldSpecs().find((f) => f.name === n)?.indexed).toBe(true);
    }
  });
});

describe('更新履歴: 新しい ID の変更も残る', () => {
  const base = { id: 1, title: 't', issueInstanceId: 'IID-1', detectionStatus: '新規',
    mgmtStatus: '未通知', isOutOfScope: false, scanFields: {} } as unknown as ManagedIssue;

  it('外部接続申請ID と 旧管理番号 の変更が記録される', () => {
    const changes = diffManagedIssue(base, { extConnAppId: 'EXT-1', legacyMgmtNumber: 'AAA-2606-01' });
    expect(changes.map((c) => c.field)).toEqual(['外部接続申請ID', '旧管理番号']);
    expect(changes[0]!.after).toBe('EXT-1');
  });

  it('値が変わっていなければ記録しない', () => {
    const cur = { ...base, extConnAppId: 'EXT-1' };
    expect(diffManagedIssue(cur, { extConnAppId: 'EXT-1' })).toEqual([]);
  });
});
