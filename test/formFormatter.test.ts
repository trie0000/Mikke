import { describe, it, expect } from 'vitest';
import { buildVulnResponseHeader, buildVulnResponseFormFormatter } from '../src/api/sp/formFormatter';
import { vulnResponseFieldSpecs, HIDDEN_UNLESS_NEW, CONDITIONAL_FORMULA_PROPERTY, VULNRESPONSE_OBSOLETE_FIELDS, orderFieldLinks } from '../src/api/sp/schema';
import { LABEL, RESPONSE_FIELD_ORDER } from '../src/lib/fieldLabels';

/** ツリーを走査して txtContent / style の値 (文字列) を全部集める。 */
function collectExpressions(node: unknown, out: string[] = []): string[] {
  if (node && typeof node === 'object') {
    const n = node as Record<string, unknown>;
    if (typeof n.txtContent === 'string') out.push(n.txtContent);
    if (n.style && typeof n.style === 'object') {
      for (const v of Object.values(n.style as Record<string, unknown>)) {
        if (typeof v === 'string') out.push(v);
      }
    }
    for (const v of Object.values(n)) collectExpressions(v, out);
  }
  return out;
}

describe('formFormatter: フォームヘッダーの書式設定', () => {
  it('キーは headerJSONFormatter だけ (header ではフォームが読まない)', () => {
    const parsed = JSON.parse(buildVulnResponseFormFormatter());
    expect(Object.keys(parsed)).toEqual(['headerJSONFormatter']);
  });

  it('body (セクション) は書かない — 書くと複数段組になり入力欄が 1 セル幅に固定される', () => {
    expect(buildVulnResponseFormFormatter()).not.toContain('bodyJSONFormatter');
  });

  it('ルートは縦積み・左寄せ (指定しないとタイトルと段組が横に並ぶ)', () => {
    const h = buildVulnResponseHeader() as { style: Record<string, string> };
    expect(h.style.display).toBe('flex');
    expect(h.style['flex-direction']).toBe('column');
    expect(h.style['text-align']).toBe('left');
  });

  it('数式に二重の = が無い (=if(=if(...)) は壊れる)', () => {
    const exprs = collectExpressions(buildVulnResponseHeader());
    const broken = exprs.filter((e) => /=\s*if\(\s*=/.test(e));
    expect(broken).toEqual([]);
  });

  it('= で始まる式は先頭のみが = (途中に = if( が現れない)', () => {
    for (const e of collectExpressions(buildVulnResponseHeader())) {
      if (!e.startsWith('=')) continue;
      expect(e.slice(1).includes('=if(')).toBe(false);
    }
  });

  it('読み取り専用カードを選択可にするクラスの組を付けている', () => {
    // 詳細パネルは本文全体に user-select:none を掛けており、style に user-select を
    // 書いても SharePoint に除去される。SharePoint 自身の
    // 「.ReactFieldEditor .ReactFieldEditor-core--display は選択可」ルールを借りる。
    const h = buildVulnResponseHeader() as any;
    expect(h.attributes.class).toBe('ReactFieldEditor');
    expect(h.children[0].attributes.class).toBe('ReactFieldEditor-core--display');
  });

  it('借りたクラスが持ち込む余白/枠は style で打ち消す (見た目を変えない)', () => {
    const h = buildVulnResponseHeader() as any;
    expect(h.style.padding).toBe('0px');                 // 祖先側: padding 4px 3px
    expect(h.children[0].style.padding).toBe('0px');     // 子側: padding 6px 0 7px
    expect(h.children[0].style.margin).toBe('0px');      // 子側: margin-left -2px
    expect(h.children[0].style.border).toBe('none');     // 子側: border 2px
  });

  it('件名・カードは選択可にする要素の内側に入っている', () => {
    const h = buildVulnResponseHeader() as any;
    expect(h.children).toHaveLength(1);
    const texts = collectExpressions(h.children[0]);
    expect(texts.some((t) => t.includes('[$Title]'))).toBe(true);
    expect(texts).toContain('脆弱性情報');
    expect(texts).toContain('資産情報');
  });

  it('参照する列はすべて連携用リストに定義されている', () => {
    const defined = new Set(vulnResponseFieldSpecs().map((f) => f.name));
    defined.add('ID'); // 組み込み列
    const refs = new Set<string>();
    for (const e of collectExpressions(buildVulnResponseHeader())) {
      for (const m of e.matchAll(/\[\$([A-Za-z0-9_]+)(?:\.[a-z]+)?\]/g)) refs.add(m[1]!);
    }
    expect([...refs].filter((r) => !defined.has(r))).toEqual([]);
  });
});

describe('schema: 連携用リストの列定義', () => {
  const specs = vulnResponseFieldSpecs();

  it('条件付き数式のプロパティ名は ClientValidationFormula (実測で特定)', () => {
    expect(CONDITIONAL_FORMULA_PROPERTY).toBe('ClientValidationFormula');
  });

  it('突合キーは組込みの Title 列で、index 付き', () => {
    // ★ Title はビューの既定リンク列。ここに Issue Instance ID を入れることで
    //   一覧でそのままアイテムを識別できる。$filter=Title eq で引くので index 必須。
    const key = specs.find((f) => f.name === 'Title');
    expect(key?.displayName).toBe('Issue Instance ID');
    expect(key?.indexed).toBe(true);
    // 同じ値の列を 2 本持たない (旧 IssueInstanceId 列は廃止)。
    expect(specs.find((f) => f.name === 'IssueInstanceId')).toBeUndefined();
  });

  it('Mikke が書き込む脆弱性情報の列は「新規時だけ入力可」', () => {
    for (const name of ['Title', 'VulnTitle', 'LegacyMgmtNumber', 'DetectionStatus', 'FirstSeen', 'LastSeen']) {
      expect(specs.find((f) => f.name === name)?.conditionalFormula).toBe(HIDDEN_UNLESS_NEW);
    }
  });

  it('事業会社の入力欄には表示条件を付けない (常に出す)', () => {
    for (const name of ['ResponseStatus', 'Responder', 'DueDate', 'ExtConnAppId',
                        'ResponsePlan', 'NoAppReason', 'Remarks']) {
      expect(specs.find((f) => f.name === name)?.conditionalFormula).toBeUndefined();
    }
  });

  it('資産情報はヘッダーカードで見せるので本体では隠す', () => {
    for (const name of ['AssetIp', 'AssetFqdn', 'AssetType', 'BusinessCompany', 'AffiliateCompany',
                        'AssetMgmtId', 'RelatedAssets', 'IdentifyEvidence']) {
      expect(specs.find((f) => f.name === name)?.conditionalFormula).toBe(HIDDEN_UNLESS_NEW);
    }
  });

  it('★ 本体に出る入力欄は事業会社が記入する 7 項目だけ、定義順に並ぶ', () => {
    // 外部接続申請ID・対応計画・完了理由・申請不要理由も資産管理者が書く欄。
    // 読み取り専用にしていると運用が回らない。
    const visible = specs.filter((f) => !f.conditionalFormula).map((f) => f.name);
    expect(visible).toEqual(['ResponseStatus', 'Responder', 'ExtConnAppId', 'NoAppReason',
      'DueDate', 'ResponsePlan', 'Remarks']);
  });

  it('旧レイアウトの列は定義に残っていない (削除対象)', () => {
    for (const n of VULNRESPONSE_OBSOLETE_FIELDS) {
      expect(specs.find((f) => f.name === n), n).toBeUndefined();
    }
  });

  it.skip('リッチテキストは RichTextMode=FullHtml を SchemaXml で入れる', () => {
    // 対応経緯 (ResponseNote) は「対応状況」に 1 本化したため、この列は無くなった。
    expect(specs.find((f) => f.name === 'ResponseNote')?.schemaXmlAttributes)
      .toEqual({ RichTextMode: 'FullHtml' });
  });

  it('内部名は ASCII (日本語だと内部名がエンコードされる)', () => {
    for (const f of specs) expect(f.name).toMatch(/^[A-Za-z][A-Za-z0-9_]*$/);
  });

  it('表示名は全列に付いている', () => {
    expect(specs.filter((f) => !f.displayName)).toEqual([]);
  });
});

describe('orderFieldLinks: フォームの項目順', () => {
  const specNames = vulnResponseFieldSpecs().map((f) => f.name);

  it('定義に無い列 (ContentType 等) は先頭に残す', () => {
    const out = orderFieldLinks(['ContentType', 'DueDate', 'ResponseStatus'], specNames);
    expect(out[0]).toBe('ContentType');
  });

  it('後から足して末尾に積まれた列も定義順に戻る', () => {
    const out = orderFieldLinks(['ContentType', 'DueDate', 'ResponseStatus', 'Responder', 'Remarks'], specNames);
    expect(out).toEqual(['ContentType', 'ResponseStatus', 'Responder', 'DueDate', 'Remarks']);
  });

  it('リストに無い列は増やさない (存在する列だけ並べ替える)', () => {
    const out = orderFieldLinks(['Title', 'Remarks'], specNames);
    expect(out).toEqual(['Title', 'Remarks']);
  });

  it('既に定義順なら結果は変わらない (整形が毎回 skipped になる)', () => {
    const current = ['ContentType', ...specNames];
    expect(orderFieldLinks(current, specNames)).toEqual(current);
  });
});

describe('フォームの並びと画面の並び', () => {
  it('★ 連携用リストのフォーム順が RESPONSE_FIELD_ORDER と一致する', () => {
    // 事業会社が見る順と、Mikke の明細・編集モーダルの順を揃える。
    const specs = vulnResponseFieldSpecs();
    const visible = specs.filter((f) => !f.conditionalFormula).map((f) => f.displayName);
    expect(visible).toEqual(RESPONSE_FIELD_ORDER.map((k) => LABEL[k]));
  });
});

describe('読み取り専用カードと入力欄の重複', () => {
  const json = JSON.stringify(buildVulnResponseHeader());

  it('★ 外部接続申請ID はカードに出さない (入力欄と二重になる)', () => {
    // 記入欄へ移した項目をカードにも残すと、同じものが 2 か所に出る。
    expect(json).not.toContain('ExtConnAppId');
  });

  it('★ カードに出すのは、資産管理者が編集しない項目だけ', () => {
    const editable = ['ResponseStatus', 'Responder', 'DueDate', 'ExtConnAppId',
      'ResponsePlan', 'NoAppReason', 'Remarks'];
    for (const n of editable) expect(json, n).not.toContain(`[$${n}]`);
  });

  it('★ カードの見出しも LABEL と同じ言葉にする', () => {
    for (const k of ['legacyMgmtNumber', 'detectionStatus', 'firstSeen', 'lastSeen',
      'businessCompany', 'affiliateCompany', 'assetMgmtId', 'identifyEvidence', 'report'] as const) {
      expect(json, LABEL[k]).toContain(LABEL[k]);
    }
  });

  it('過去の呼び名がカードに残っていない', () => {
    for (const bad of ['Web資産管理ID', '管理事業会社特定の根拠', '脆弱性レポート']) {
      expect(json, bad).not.toContain(bad);
    }
  });
});
