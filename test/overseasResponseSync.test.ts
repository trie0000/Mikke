import { describe, it, expect } from 'vitest';
import {
  buildOverseasResponsePlan, toOverseasResponseFields, overseasKey,
  OVERSEAS_RESPONSE_COLUMN, OVERSEAS_RESPONSE_KIND, OVERSEAS_RESPONSE_DATE_FIELDS,
  type OverseasResponseRow,
} from '../src/lib/overseasResponseSync';
import {
  overseasResponseFieldSpecs, OVERSEAS_RESPONSE_VIEW_FIELDS,
  LIST_OVERSEAS, LIST_OVERSEAS_RESPONSE,
} from '../src/api/sp/schema';
import { buildOverseasResponseHeader } from '../src/api/sp/formFormatter';
import type { OverseasIssue } from '../src/types';

function issue(over: Partial<OverseasIssue> = {}): OverseasIssue {
  return {
    id: 1, issueInstanceId: 'IID-1', detectionStatus: '継続', region: 'APAC',
    contactedAt: '2026-06-01T00:00:00Z', title: 'TLS 1.0 が有効',
    businessCompany: 'エナジー事業', affiliateCompany: 'ABC株式会社',
    webMapsId: 'A1234567', assetFqdn: 'web01.example.com',
    lastSeen: '2026-07-30T20:00:00Z', ...over,
  };
}

function row(over: Partial<OverseasResponseRow> = {}): OverseasResponseRow {
  return { id: 100, ...toOverseasResponseFields(issue()), ...over };
}

describe('toOverseasResponseFields: 海外連携用リストへ書く内容', () => {
  it('検知日は JST の暦日にする (UTC のままだと 1 日ずれる)', () => {
    // 2026-07-30T20:00:00Z = JST では 7/31
    expect(toOverseasResponseFields(issue()).lastSeen).toBe('2026-07-31T00:00:00Z');
  });

  it('単一行テキストは 255 文字に収める (超えると SP が 500 を返す)', () => {
    const f = toOverseasResponseFields(issue({ assetTitle: 'x'.repeat(300) }));
    expect(f.assetTitle.length).toBeLessThanOrEqual(255);
  });

  it('複数行の列 (参考情報) は改行を残す', () => {
    const f = toOverseasResponseFields(issue({ identifyEvidence: 'FQDN一致\n登録情報' }));
    expect(f.identifyEvidence).toBe('FQDN一致\n登録情報');
  });
});

describe('buildOverseasResponsePlan: 追加 / 更新 / 削除', () => {
  it('リストに無いものは追加する', () => {
    const plan = buildOverseasResponsePlan([issue()], []);
    expect(plan.creates).toHaveLength(1);
    expect(plan.creates[0]!.issueInstanceId).toBe('IID-1');
  });

  it('内容が同じなら何もしない', () => {
    const plan = buildOverseasResponsePlan([issue()], [row()]);
    expect(plan.creates).toEqual([]);
    expect(plan.updates).toEqual([]);
    expect(plan.unchanged).toBe(1);
  });

  it('変わった項目だけ更新する', () => {
    const plan = buildOverseasResponsePlan(
      [issue({ businessCompany: 'モビリティ事業' })], [row()]);
    expect(plan.updates).toEqual([
      { id: 100, key: overseasKey('IID-1', 'APAC'), fields: { businessCompany: 'モビリティ事業' } },
    ]);
  });

  it('一覧から消えたものはリストからも消す', () => {
    const plan = buildOverseasResponsePlan([], [row()]);
    expect(plan.deletes).toEqual([{ id: 100, key: overseasKey('IID-1', 'APAC'), reason: '一覧に無い' }]);
  });

  it('★ 管理対象から除外した行はリストから消す (理由も分かるようにする)', () => {
    const plan = buildOverseasResponsePlan([issue({ isOutOfScope: true })], [row()]);
    expect(plan.deletes).toEqual([{ id: 100, key: overseasKey('IID-1', 'APAC'), reason: '対象外' }]);
    expect(plan.updates).toEqual([]);
    expect(plan.creates).toEqual([]);
  });

  it('除外した行がリストに無ければ何もしない (作り直さない)', () => {
    const plan = buildOverseasResponsePlan([issue({ isOutOfScope: true })], []);
    expect(plan.creates).toEqual([]);
    expect(plan.deletes).toEqual([]);
  });

  it('除外を解除すると次の反映で作り直される', () => {
    const plan = buildOverseasResponsePlan([issue({ isOutOfScope: false })], []);
    expect(plan.creates).toHaveLength(1);
  });

  it('★ 一覧が空でも、リストに残っている行は削除の計画に入る', () => {
    // 一覧を全部消した場合。ここで何も返さないと、リスト側の古い行が
    // 二度と消せなくなる (リストは読み取り専用で手では消せない)。
    const plan = buildOverseasResponsePlan([], [row(), row({ id: 101, issueInstanceId: 'IID-9' })]);
    expect(plan.deletes.map((d) => d.id).sort()).toEqual([100, 101]);
    expect(plan.deletes.every((d) => d.reason === '一覧に無い')).toBe(true);
  });

  it('★ 同じ脆弱性でも地域が違えば別アイテム (IID だけをキーにしない)', () => {
    const plan = buildOverseasResponsePlan(
      [issue({ region: 'APAC' }), issue({ id: 2, region: 'EU' })],
      [row({ region: 'APAC' })]);
    expect(plan.creates.map((c) => c.region)).toEqual(['EU']);
    expect(plan.deletes).toEqual([]);       // APAC の既存は消さない
    expect(plan.unchanged).toBe(1);
  });

  it('★ 選択分の反映では範囲外のアイテムを消さない', () => {
    const other = row({ id: 101, issueInstanceId: 'IID-9', region: 'EU' });
    const plan = buildOverseasResponsePlan(
      [issue()], [row(), other], new Set([overseasKey('IID-1', 'APAC')]));
    expect(plan.deletes).toEqual([]);
    expect(plan.unchanged).toBe(1);
  });

  it('Issue Instance ID が空の行は扱わない', () => {
    const plan = buildOverseasResponsePlan([issue({ issueInstanceId: '' })], []);
    expect(plan.creates).toEqual([]);
  });
});

describe('★ 列の宣言がスキーマと一致していること', () => {
  it('SP に無い列を送らない (1 列ズレると書込が全件 400 になる)', () => {
    const specNames = new Set(overseasResponseFieldSpecs().map((f) => f.name));
    const missing = Object.values(OVERSEAS_RESPONSE_COLUMN).filter((c) => !specNames.has(c));
    expect(missing).toEqual([]);
  });

  it('text / note / date の割り当てが overseasResponseFieldSpecs と同じ', () => {
    const specKind: Record<string, string> = {};
    for (const f of overseasResponseFieldSpecs()) {
      specKind[f.name] = f.type === 'Note' || f.type === 'NoteRich' ? 'note'
        : f.type === 'DateTime' ? 'date' : 'text';
    }
    const mismatch = (Object.keys(OVERSEAS_RESPONSE_KIND) as (keyof typeof OVERSEAS_RESPONSE_KIND)[])
      .map((k) => ({ field: k, ours: OVERSEAS_RESPONSE_KIND[k], spec: specKind[OVERSEAS_RESPONSE_COLUMN[k]] }))
      .filter((x) => x.ours !== x.spec);
    expect(mismatch).toEqual([]);
  });

  it('日付列の宣言が種類の宣言と一致する (空文字を送ると 400 になる)', () => {
    const byKind = (Object.keys(OVERSEAS_RESPONSE_KIND) as (keyof typeof OVERSEAS_RESPONSE_KIND)[])
      .filter((k) => OVERSEAS_RESPONSE_KIND[k] === 'date');
    expect([...OVERSEAS_RESPONSE_DATE_FIELDS].sort()).toEqual([...byKind].sort());
  });

  it('突合キーは組込みの Title 列 + 地域', () => {
    expect(OVERSEAS_RESPONSE_COLUMN.issueInstanceId).toBe('Title');
    expect(OVERSEAS_RESPONSE_COLUMN.region).toBe('Region');
  });

  it('既定ビューの列は実在する列だけ (LinkTitle は組込み)', () => {
    const names = new Set([...overseasResponseFieldSpecs().map((f) => f.name), 'LinkTitle']);
    expect(OVERSEAS_RESPONSE_VIEW_FIELDS.filter((f) => !names.has(f))).toEqual([]);
  });

  it('国内・海外一覧とは別のリストに書く', () => {
    expect(LIST_OVERSEAS_RESPONSE).not.toBe(LIST_OVERSEAS);
    expect(LIST_OVERSEAS_RESPONSE).toBe('MikkeOverseasResponse');
  });
});

describe('★ フォームは読み取り専用の 2 段組カード', () => {
  const json = JSON.stringify(buildOverseasResponseHeader());

  it('記入欄を出さない (全列に条件付き数式で非表示を当てる)', () => {
    const shown = overseasResponseFieldSpecs().filter((f) => !f.conditionalFormula);
    expect(shown).toEqual([]);
  });

  it('脆弱性情報と資産情報のカードがある', () => {
    expect(json).toContain('脆弱性情報');
    expect(json).toContain('資産情報');
  });

  it('カードの中身は 2 段組 (flex-direction: row)', () => {
    expect(json).toContain('"flex-direction":"row"');
  });

  it('一覧の項目がすべてカードに出ている', () => {
    for (const col of Object.values(OVERSEAS_RESPONSE_COLUMN)) {
      if (col === 'Title') continue;      // 見出しに Issue Instance ID として出している
      expect(json, `${col} がカードに無い`).toContain(`[$${col}]`);
    }
  });
});
