import { describe, it, expect } from 'vitest';
import {
  buildVulnResponsePlan, toVulnResponseFields, isExcluded, VULNRESPONSE_COLUMN,
  VULNRESPONSE_KIND, overlongTextFields, REPORT_LINK_TEXT, jstDateOnly,
  type VulnResponseRow,
} from '../src/lib/vulnResponseSync';
import { vulnResponseFieldSpecs, toFieldSchema, spFieldTypeString, VULNRESPONSE_VIEW_FIELDS, VULNRESPONSE_OBSOLETE_FIELDS } from '../src/api/sp/schema';
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

  it('検知日は日単位で比べる (同じ JST の日なら時刻差で更新しない)', () => {
    // 2026-07-30T05:00:00Z = JST 14:00 同日。
    const plan = buildVulnResponsePlan(
      [issue({ lastSeen: '2026-07-30T05:00:00Z' })], ASSETS, keysOf(['web01.example.com']), [row()]);
    expect(plan.updates).toEqual([]);
    expect(plan.unchanged).toBe(1);
  });

  it('★ JST で日が変わる時刻なら更新対象になる', () => {
    // 2026-07-30T15:00:00Z = JST 2026-07-31 00:00。UTC 基準だと同じ日に見えてしまう。
    const plan = buildVulnResponsePlan(
      [issue({ lastSeen: '2026-07-30T15:00:00Z' })], ASSETS, keysOf(['web01.example.com']), [row()]);
    expect(plan.updates[0]!.fields).toEqual({ lastSeen: '2026-07-31T00:00:00Z' });
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
        : f.type === 'DateTime' ? 'date'
        : f.type === 'Url' ? 'url' : 'text';
    }
    const mismatch = (Object.keys(VULNRESPONSE_KIND) as (keyof typeof VULNRESPONSE_KIND)[])
      .map((k) => ({ field: k, ours: VULNRESPONSE_KIND[k], spec: specKind[VULNRESPONSE_COLUMN[k]] }))
      .filter((x) => x.ours !== x.spec);
    expect(mismatch).toEqual([]);
  });
});

describe('脆弱性レポートへのリンク', () => {
  it('管理対象の reportUrl をそのまま連携用リストへ渡す', () => {
    const url = '/sites/x/Shared Documents/MikkeDownloads/issues/20260808-101500/IID-1_20260808.pdf';
    const f = toVulnResponseFields(issue({ reportUrl: url }), [], ASSETS);
    expect(f.reportUrl).toBe(url);
  });

  it('未取得なら空 (列も空になる)', () => {
    expect(toVulnResponseFields(issue(), [], ASSETS).reportUrl).toBe('');
  });

  it('レポートが差し替わったら更新対象になる', () => {
    const before = toVulnResponseFields(issue({ reportUrl: '/a/old.pdf' }), [], ASSETS);
    const plan = buildVulnResponsePlan(
      [issue({ reportUrl: '/a/new.pdf' })], ASSETS, keysOf([]), [{ id: 1, ...before }]);
    expect(plan.updates[0]!.fields).toEqual({ reportUrl: '/a/new.pdf' });
  });

  it('★ URL は 255 文字制限で切り詰めない (URL 列は単一行テキストではない)', () => {
    const long = '/sites/x/Shared Documents/' + 'a'.repeat(300) + '.pdf';
    expect(toVulnResponseFields(issue({ reportUrl: long }), [], ASSETS).reportUrl).toBe(long);
  });

});

describe('URL 列の作成スキーマ', () => {
  it('SP.FieldUrl / FieldTypeKind 11 / ハイパーリンク表示で作る', () => {
    const spec = vulnResponseFieldSpecs().find((f) => f.name === 'ReportUrl')!;
    expect(spec.type).toBe('Url');
    expect(spec.displayName).toBe('脆弱性レポート');
    expect(toFieldSchema(spec)).toEqual({
      __metadata: { type: 'SP.FieldUrl' }, FieldTypeKind: 11, Title: 'ReportUrl', DisplayFormat: 0,
    });
  });

  it('既存列との型比較に使う TypeAsString は URL', () => {
    // ensureFields は TypeAsString で型一致を見る。ズレると毎回 削除→再作成 になる。
    expect(spFieldTypeString('Url')).toBe('URL');
  });

  it('既定ビューに出す (一覧から 1 クリックで開けるようにするため)', () => {
    expect(VULNRESPONSE_VIEW_FIELDS).toContain('ReportUrl');
  });
});

describe('突合キーは組込みの Title 列', () => {
  it('Title に Issue Instance ID、VulnTitle に脆弱性タイトルを入れる', () => {
    expect(VULNRESPONSE_COLUMN.issueInstanceId).toBe('Title');
    expect(VULNRESPONSE_COLUMN.title).toBe('VulnTitle');
  });

  it('同じ値の列を 2 本持たない (IssueInstanceId 列は使わない)', () => {
    expect(Object.values(VULNRESPONSE_COLUMN)).not.toContain('IssueInstanceId');
  });

  it('旧 IssueInstanceId 列は構築時に削除される', () => {
    expect(VULNRESPONSE_OBSOLETE_FIELDS).toContain('IssueInstanceId');
  });

  it('既定ビューは Title (リンク列) と脆弱性タイトルを出す', () => {
    expect(VULNRESPONSE_VIEW_FIELDS).toContain('LinkTitle');
    expect(VULNRESPONSE_VIEW_FIELDS).toContain('VulnTitle');
  });
});

describe('連携用リストのリンク表記', () => {
  it('固定文言「レポートを開く」', () => {
    // ファイル名は長くて一覧の幅を食い、形式 (PDF) だけだと押せると分かりにくい。
    expect(REPORT_LINK_TEXT).toBe('レポートを開く');
  });
});

describe('事業会社・管理会社の決め方', () => {
  it('管理対象に入れた値があればそれを使う', () => {
    const f = toVulnResponseFields(
      issue({ businessCompany: '住宅事業', affiliateCompany: 'XYZ株式会社' }),
      ['web01.example.com'], ASSETS);
    expect(f.businessCompany).toBe('住宅事業');
    expect(f.affiliateCompany).toBe('XYZ株式会社');
  });

  it('未設定なら資産リストから引く (従来どおり)', () => {
    const f = toVulnResponseFields(issue(), ['web01.example.com'], ASSETS);
    expect(f.businessCompany).toBe('エナジー事業');
    expect(f.affiliateCompany).toBe('ABC株式会社');
  });

  it('片方だけ設定した場合はもう片方だけ資産から引く', () => {
    const f = toVulnResponseFields(
      issue({ businessCompany: '住宅事業' }), ['web01.example.com'], ASSETS);
    expect(f.businessCompany).toBe('住宅事業');
    expect(f.affiliateCompany).toBe('ABC株式会社');
  });

  it('★ 事業会社を変えるとアクセス権の割当先も変わる', () => {
    // 事業会社はアクセス権 (連携用リストの権限) の割当キー。
    const f = toVulnResponseFields(issue({ businessCompany: '住宅事業' }), ['web01.example.com'], ASSETS);
    expect(f.businessCompany).toBe('住宅事業');
  });
});

describe('検知日は JST の暦日で登録する', () => {
  it('★ UTC で日付をまたぐ値は JST 側の日付になる', () => {
    // 2026-07-30T20:00:00Z = JST 2026-07-31 05:00。UTC のまま入れると 7/30 にずれる。
    expect(jstDateOnly('2026-07-30T20:00:00Z')).toBe('2026-07-31T00:00:00Z');
  });

  it('日中の値はそのままの日付', () => {
    expect(jstDateOnly('2026-07-30T00:00:00Z')).toBe('2026-07-30T00:00:00Z');
    expect(jstDateOnly('2026-07-30T14:59:59Z')).toBe('2026-07-30T23:59:59Z'.slice(0, 10) + 'T00:00:00Z');
  });

  it('時刻を 00:00:00Z に固定する (閲覧者の地域設定でずれないように)', () => {
    expect(jstDateOnly('2026-07-30T12:34:56.789Z')).toMatch(/T00:00:00Z$/);
  });

  it('日付だけの入力・空・不正な値でも落ちない', () => {
    expect(jstDateOnly('2026-07-30')).toBe('2026-07-30T00:00:00Z');
    expect(jstDateOnly('')).toBe('');
    expect(jstDateOnly('not-a-date')).toBe('');
  });

  it('連携用リストへ渡す最終検知日が JST になる', () => {
    const f = toVulnResponseFields(issue({ lastSeen: '2026-07-30T20:00:00Z' }), [], ASSETS);
    expect(f.lastSeen).toBe('2026-07-31T00:00:00Z');
  });

  it('★ 変換後の値どうしを比べるので毎回更新にならない', () => {
    const first = toVulnResponseFields(issue({ lastSeen: '2026-07-30T20:00:00Z' }), [], ASSETS);
    const plan = buildVulnResponsePlan(
      [issue({ lastSeen: '2026-07-30T20:00:00Z' })], ASSETS, keysOf([]), [{ id: 1, ...first }]);
    expect(plan.updates).toEqual([]);
    expect(plan.unchanged).toBe(1);
  });

  it('既定ビューに最終検知日を出す', () => {
    expect(VULNRESPONSE_VIEW_FIELDS).toContain('LastSeen');
  });
});
