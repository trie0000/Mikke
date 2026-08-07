import { describe, it, expect } from 'vitest';
import {
  buildVulnResponsePlan, toVulnResponseFields, isExcluded, VULNRESPONSE_COLUMN,
  VULNRESPONSE_KIND, overlongTextFields,
  type VulnResponseRow,
} from '../src/lib/vulnResponseSync';
import { vulnResponseFieldSpecs } from '../src/api/sp/schema';
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

describe('buildVulnResponsePlan: 選択分だけの反映 (scope)', () => {
  const A = issue({ id: 1, issueInstanceId: 'IID-1' });
  const B = issue({ id: 2, issueInstanceId: 'IID-2', title: '別の脆弱性' });
  const rowA = row({ id: 100, issueInstanceId: 'IID-1' });
  const rowB = row({ id: 200, issueInstanceId: 'IID-2' });

  it('範囲内だけを追加・更新する', () => {
    const plan = buildVulnResponsePlan(
      [A, B], ASSETS, keysOf(['web01.example.com']), [], new Set(['IID-1']));
    expect(plan.creates.map((c) => c.issueInstanceId)).toEqual(['IID-1']);
  });

  it('★ 範囲外の既存アイテムは削除しない (絞ったまま全件突合するとリストが消える)', () => {
    const plan = buildVulnResponsePlan(
      [A], ASSETS, keysOf(['web01.example.com']), [rowA, rowB], new Set(['IID-1']));
    expect(plan.deletes).toEqual([]);
    expect(plan.unchanged).toBe(1);
  });

  it('範囲内が対象外なら、その 1 件だけ削除する', () => {
    const plan = buildVulnResponsePlan(
      [issue({ issueInstanceId: 'IID-1', mgmtStatus: '対象外' }), B],
      ASSETS, keysOf(['web01.example.com']), [rowA, rowB], new Set(['IID-1']));
    expect(plan.deletes).toEqual([{ id: 100, issueInstanceId: 'IID-1', reason: '対象外' }]);
  });

  it('scope 未指定なら従来どおり全件対象 (範囲外は削除される)', () => {
    const plan = buildVulnResponsePlan([A], ASSETS, keysOf(['web01.example.com']), [rowA, rowB]);
    expect(plan.deletes).toEqual([{ id: 200, issueInstanceId: 'IID-2', reason: '管理対象に無い' }]);
  });
});

describe('★ Mikke が書く列は、連携用リストの構築で必ず作られること', () => {
  // ズレていると SP は書込を 1 件ごと 400 で返し、反映が全件失敗する
  // (「連携リストへの更新でエラー」の正体)。しかも構築し直しても直らない。
  const declared = new Set(vulnResponseFieldSpecs().map((f) => f.name));

  it('書き込み対象の列がすべてスキーマ宣言にある', () => {
    const missing = Object.values(VULNRESPONSE_COLUMN).filter((c) => !declared.has(c));
    expect(missing).toEqual([]);
  });

  it('VulnResponseFields の全キーに列名が割り当たっている', () => {
    const fields = toVulnResponseFields(issue(), [], ASSETS);
    const noColumn = Object.keys(fields).filter(
      (k) => !(k in VULNRESPONSE_COLUMN) || !VULNRESPONSE_COLUMN[k as keyof typeof VULNRESPONSE_COLUMN]);
    expect(noColumn).toEqual([]);
  });
});

describe('単一行テキスト列に収める (SP は 255 文字超 / 改行を 500 で拒否)', () => {
  const many = Array.from({ length: 40 }, (_, i) => `host${i}.example.com`);

  it('255 文字を超える資産一覧は切り詰める', () => {
    const f = toVulnResponseFields(issue(), many, ASSETS);
    expect(f.assetFqdn.length).toBeLessThanOrEqual(255);
    expect(f.assetFqdn.endsWith('…')).toBe(true);
  });

  it('改行・制御文字は空白に潰す (単一行テキストに入れられない)', () => {
    const f = toVulnResponseFields(issue({ title: 'TLS 1.0\r\nが有効\tです' }), [], ASSETS);
    expect(f.title).toBe('TLS 1.0 が有効 です');
  });

  it('複数行テキストの列は切り詰めない (関連資産・特定根拠)', () => {
    const f = toVulnResponseFields(issue(), many, ASSETS);
    expect(f.relatedAssets.length).toBeGreaterThan(255);
  });

  it('★ 切り詰めた値で比較するので、毎回「差分あり」にならない', () => {
    // 書込直前で切ると SP 側の値と食い違い、延々と更新し続けることになる。
    const first = toVulnResponseFields(issue(), many, ASSETS);
    const stored: VulnResponseRow = { id: 1, ...first };
    const plan = buildVulnResponsePlan([issue()], ASSETS, () => many, [stored]);
    expect(plan.updates).toEqual([]);
    expect(plan.unchanged).toBe(1);
  });

  it('overlongTextFields は収まらない項目を名指しできる', () => {
    const f = { ...toVulnResponseFields(issue(), [], ASSETS), assetFqdn: 'x'.repeat(300) };
    expect(overlongTextFields(f)).toEqual([{ field: 'assetFqdn', length: 300 }]);
  });
});

describe('★ 列の種類の宣言がスキーマと一致していること', () => {
  it('text / note / date の割り当てが vulnResponseFieldSpecs と同じ', () => {
    // ズレると「Note のつもりで切り詰めない → 500」または
    // 「Text なのに切り詰めない → 500」になる。
    const specKind: Record<string, string> = {};
    for (const f of vulnResponseFieldSpecs()) {
      specKind[f.name] = f.type === 'Note' || f.type === 'NoteRich' ? 'note'
        : f.type === 'DateTime' ? 'date' : 'text';
    }
    const mismatch = (Object.keys(VULNRESPONSE_KIND) as (keyof typeof VULNRESPONSE_KIND)[])
      .map((k) => ({ field: k, ours: VULNRESPONSE_KIND[k], spec: specKind[VULNRESPONSE_COLUMN[k]] }))
      .filter((x) => x.ours !== x.spec);
    expect(mismatch).toEqual([]);
  });
});
