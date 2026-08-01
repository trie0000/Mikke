/**
 * 連携用リスト (MikkeVulnResponse) のフォームヘッダー書式設定。
 *
 * 資産管理者が SharePoint の素のフォームを開いたときに、脆弱性情報を
 * 読み取り専用の 2 段組カードで見せ、本体には対応状況の入力欄だけを残す。
 *
 * ★ 色・寸法の直書きについて
 *   Mikke 本体の UI は `#mikke-root` 配下でデザイントークン (var(--...)) 経由のみだが、
 *   ここで生成する JSON は **SharePoint 自身のフォーム** (overlay の外) で描画されるため
 *   Mikke の CSS 変数は存在しない。SharePoint 標準色に合わせた実値を指定する。
 *   この 1 ファイルだけが例外で、Mikke の画面には一切影響しない。
 *
 * ★ 実機で確認済みの要点
 *   - 書き込み先はコンテンツタイプの ClientFormCustomFormatter。
 *     キーは `headerJSONFormatter`。ドキュメントにある `header` ではフォームが読まない。
 *   - ルート要素に display:flex + flex-direction:column + text-align:left を明示する。
 *     ヘッダー領域は外側で横並び・中央寄せが効いており、指定しないと
 *     タイトルと段組が横に並ぶ。
 *   - 値の参照は [$内部名]。表示名を日本語に変えても内部名は英語のままなので変更不要。
 */

import { VULNRESPONSE_SECTIONS } from './schema';

const COLUMN_FORMAT_SCHEMA =
  'https://developer.microsoft.com/json-schemas/sp/v2/column-formatting.schema.json';

const LABEL_STYLE = {
  'font-size': '11px',
  'font-weight': '400',
  color: '#605e5c',
  'padding-bottom': '2px',
};

const VALUE_STYLE = {
  'font-size': '14px',
  'font-weight': '400',
  color: '#323130',
  'word-break': 'break-word',
};

/** ラベル (小さめ・グレー) と値を縦に並べた 1 項目。 */
function item(label: string, valueElement: Record<string, unknown>): Record<string, unknown> {
  return {
    elmType: 'div',
    style: { 'padding-bottom': '12px' },
    children: [
      { elmType: 'div', txtContent: label, style: LABEL_STYLE },
      valueElement,
    ],
  };
}

/** 空なら "—" を出す単純なテキスト値。
 *  expression は先頭に `=` を付けない「式そのもの」を渡す (例: `[$Foo]`)。
 *  `=` 付きを渡すと `=if(=if(...))` になって数式が壊れる。 */
function textValue(expression: string): Record<string, unknown> {
  return {
    elmType: 'div',
    txtContent: `=if(${expression} == '', '—', ${expression})`,
    style: VALUE_STYLE,
  };
}

/** 日付。ISO のままだと読めないのでロケール表記にする。 */
function dateValue(field: string): Record<string, unknown> {
  return {
    elmType: 'div',
    txtContent: `=if([$${field}] == '', '—', toLocaleDateString([$${field}]))`,
    style: VALUE_STYLE,
  };
}

/** 2 段組の 1 列分。flex:1 で等幅にする。 */
function column(children: Record<string, unknown>[]): Record<string, unknown> {
  return {
    elmType: 'div',
    style: { flex: '1', 'min-width': '0', padding: '0px' },
    children,
  };
}

export function buildVulnResponseHeader(): Record<string, unknown> {
  return {
    $schema: COLUMN_FORMAT_SCHEMA,
    elmType: 'div',
    style: {
      // ヘッダー領域は外側で flex 行・中央寄せが効いているため、
      // 縦積みと左寄せをここで明示しないとタイトルと段組が横に並ぶ。
      display: 'flex',
      'flex-direction': 'column',
      'align-items': 'stretch',
      'text-align': 'left',
      width: '100%',
      'box-sizing': 'border-box',
      padding: '16px 20px',
      'border-radius': '8px',
      border: '1px solid #edebe9',
      'background-color': '#faf9f8',
    },
    children: [
      // 件名
      {
        elmType: 'div',
        txtContent: "=if([$Title] == '', '（件名未入力）', [$Title])",
        style: {
          'font-size': '18px',
          'font-weight': '600',
          color: '#201f1e',
          'padding-bottom': '2px',
          'word-break': 'break-word',
        },
      },
      // 脆弱性 ID (突合キー) を小さく添える
      {
        elmType: 'div',
        txtContent: "=if([$IssueInstanceId] == '', '', 'ID: ' + [$IssueInstanceId])",
        style: { 'font-size': '11px', color: '#797775', 'padding-bottom': '2px' },
      },
      {
        elmType: 'div',
        txtContent: '脆弱性情報（読み取り専用）',
        style: { 'font-size': '11px', color: '#797775', 'padding-bottom': '12px' },
      },
      // 2 段組
      {
        elmType: 'div',
        style: { display: 'flex', 'flex-direction': 'row', 'column-gap': '24px', width: '100%' },
        children: [
          column([
            item('管理番号', textValue('[$MgmtNumber]')),
            item('検知状況', textValue('[$DetectionStatus]')),
          ]),
          column([
            item('初回検知日', dateValue('FirstSeen')),
            item('最終検知日', dateValue('LastSeen')),
          ]),
        ],
      },
    ],
  };
}

/** フォーム本体のセクション構成。列は内部名で指定する。
 *  ※ 条件付き数式で隠した列はここに入れても表示されない (実機で確認済み) ため、
 *    脆弱性情報はヘッダーカード側で見せている。 */
export function buildVulnResponseBody(): Record<string, unknown> {
  return { sections: VULNRESPONSE_SECTIONS };
}

/**
 * ClientFormCustomFormatter に入れる値 (文字列)。
 * キーは `headerJSONFormatter`。`header` ではフォームが読まない
 * (リストフォームの「レイアウトの構成」が書き込む形と揃えてある)。
 */
export function buildVulnResponseFormFormatter(): string {
  return JSON.stringify({
    headerJSONFormatter: buildVulnResponseHeader(),
    bodyJSONFormatter: buildVulnResponseBody(),
  });
}
