import { describe, it, expect } from 'vitest';
import { buildVulnResponseHeader, buildVulnResponseFormFormatter } from '../src/api/sp/formFormatter';
import { vulnResponseFieldSpecs, HIDDEN_UNLESS_NEW, CONDITIONAL_FORMULA_PROPERTY, VULNRESPONSE_SECTIONS, VULNRESPONSE_OBSOLETE_FIELDS } from '../src/api/sp/schema';

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
  it('キーは headerJSONFormatter / bodyJSONFormatter (header ではフォームが読まない)', () => {
    const parsed = JSON.parse(buildVulnResponseFormFormatter());
    expect(Object.keys(parsed).sort()).toEqual(['bodyJSONFormatter', 'headerJSONFormatter']);
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

  it('突合キー IssueInstanceId は index 付きで存在する', () => {
    const key = specs.find((f) => f.name === 'IssueInstanceId');
    expect(key?.indexed).toBe(true);
  });

  it('Mikke が書き込む脆弱性情報の列は「新規時だけ入力可」', () => {
    for (const name of ['Title', 'IssueInstanceId', 'MgmtNumber', 'DetectionStatus', 'FirstSeen', 'LastSeen']) {
      expect(specs.find((f) => f.name === name)?.conditionalFormula).toBe(HIDDEN_UNLESS_NEW);
    }
  });

  it('資産管理者の入力欄には表示条件を付けない (常に出す)', () => {
    for (const name of ['ResponseStatus', 'Responder', 'DueDate', 'ResponseNote', 'Remarks',
                        'AssetIp', 'AssetFqdn', 'AssetType', 'BusinessCompany', 'AffiliateCompany',
                        'AssetMgmtId', 'ExtConnAppId', 'RelatedAssets', 'IdentifyEvidence']) {
      expect(specs.find((f) => f.name === name)?.conditionalFormula).toBeUndefined();
    }
  });

  it('セクションは 資産情報 / 対応 / その他 の 3 つ', () => {
    expect(VULNRESPONSE_SECTIONS.map((x) => x.displayname)).toEqual(['資産情報', '対応', 'その他']);
  });

  it('セクションの列はすべて定義済みで、隠し列を含まない', () => {
    const byName = new Map(specs.map((f) => [f.name, f]));
    for (const sec of VULNRESPONSE_SECTIONS) {
      for (const n of sec.fields) {
        const f = byName.get(n);
        expect(f, `${sec.displayname} の ${n}`).toBeDefined();
        // 隠した列はセクションに入れても表示されない (実機で確認済み)
        expect(f!.conditionalFormula, `${sec.displayname} の ${n}`).toBeUndefined();
      }
    }
  });

  it('旧レイアウトの列は定義に残っていない (削除対象)', () => {
    for (const n of VULNRESPONSE_OBSOLETE_FIELDS) {
      expect(specs.find((f) => f.name === n), n).toBeUndefined();
    }
  });

  it('書式設定に header と body の両方が入る', () => {
    expect(Object.keys(JSON.parse(buildVulnResponseFormFormatter())).sort()).toEqual(['bodyJSONFormatter', 'headerJSONFormatter']);
  });

  it('リッチテキストは RichTextMode=FullHtml を SchemaXml で入れる', () => {
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
