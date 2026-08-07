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

const COLUMN_FORMAT_SCHEMA =
  'https://developer.microsoft.com/json-schemas/sp/v2/column-formatting.schema.json';

/**
 * 読み取り専用カードの文字をマウスで範囲選択できるようにするためのクラス。
 *
 * ★ 一覧からアイテムを開いた「詳細パネル」では SharePoint が本文全体に
 *   user-select: none を掛けており、カードの値をドラッグしてコピーできない
 *   (フルページの表示フォームでは選択できる)。
 * ★ style に user-select を書いても SharePoint に除去される (DOM に残らないことを実測)。
 *   一方 attributes.class は通るので、SharePoint 自身が「表示モードの項目は選択可」に
 *   するために持っているルール `.ReactFieldEditor .ReactFieldEditor-core--display`
 *   (user-select: text) を、祖先クラスと子クラスの組で自前の要素に再現する。
 * ★ 祖先側のクラスは padding: 4px 3px を持ち込むので、ルート要素の style で
 *   padding を 0 に上書きして見た目を変えない (inline が class より優先)。
 */
const SELECTABLE_PARENT_CLASS = 'ReactFieldEditor';
const SELECTABLE_CLASS = 'ReactFieldEditor-core--display';

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

/** カード 1 枚。見出し + 中身を枠付きの箱に入れる。 */
function card(title: string, subtitle: string | null, children: Record<string, unknown>[]): Record<string, unknown> {
  const head: Record<string, unknown>[] = [
    {
      elmType: 'div',
      txtContent: title,
      style: {
        'font-size': '13px', 'font-weight': '600', color: '#201f1e',
        'padding-bottom': '8px', 'margin-bottom': '12px',
        'border-bottom': '1px solid #edebe9',
      },
    },
  ];
  if (subtitle) {
    head.push({ elmType: 'div', txtContent: subtitle,
      style: { 'font-size': '11px', color: '#797775', 'padding-bottom': '10px' } });
  }
  return {
    elmType: 'div',
    style: {
      display: 'flex', 'flex-direction': 'column', 'align-items': 'stretch', 'text-align': 'left',
      width: '100%', 'box-sizing': 'border-box',
      padding: '14px 18px', 'margin-bottom': '10px',
      'border-radius': '8px', border: '1px solid #edebe9', 'background-color': '#faf9f8',
    },
    children: [...head, ...children],
  };
}

/** 2 段組 (左右に均等配置)。 */
function twoColumns(left: Record<string, unknown>[], right: Record<string, unknown>[]): Record<string, unknown> {
  return {
    elmType: 'div',
    style: { display: 'flex', 'flex-direction': 'row', 'column-gap': '24px', width: '100%' },
    children: [column(left), column(right)],
  };
}

export function buildVulnResponseHeader(): Record<string, unknown> {
  return {
    $schema: COLUMN_FORMAT_SCHEMA,
    elmType: 'div',
    // 選択可にするルールの祖先側。padding は class が持ち込む 4px 3px を打ち消す。
    attributes: { class: SELECTABLE_PARENT_CLASS },
    style: {
      // ヘッダー領域は外側で flex 行・中央寄せが効いているため、
      // 縦積みと左寄せをここで明示しないとカードが横に並ぶ。
      display: 'flex', 'flex-direction': 'column', 'align-items': 'stretch',
      'text-align': 'left', width: '100%', 'box-sizing': 'border-box',
      padding: '0px',
    },
    children: [{
      // 選択可にするルールの子側。中身は user-select: text を継承する。
      elmType: 'div',
      attributes: { class: SELECTABLE_CLASS },
      style: {
        display: 'flex', 'flex-direction': 'column', 'align-items': 'stretch',
        width: '100%', 'box-sizing': 'border-box',
        // 子側のクラスも padding 6px/7px・border 2px・margin-left -2px を持ち込むので打ち消す
        padding: '0px', margin: '0px', border: 'none',
      },
      children: [
        // 件名 (カードの外に大きく)
        {
          elmType: 'div',
          txtContent: "=if([$Title] == '', '（脆弱性タイトル未入力）', [$Title])",
          style: {
            'font-size': '18px', 'font-weight': '600', color: '#201f1e',
            'padding-bottom': '2px', 'word-break': 'break-word',
          },
        },
        {
          elmType: 'div',
          txtContent: "=if([$IssueInstanceId] == '', '', 'ID: ' + [$IssueInstanceId])",
          style: { 'font-size': '11px', color: '#797775', 'padding-bottom': '10px' },
        },
        // カード 1: 脆弱性情報
        card('脆弱性情報', '読み取り専用', [
          twoColumns(
            [item('管理番号', textValue('[$MgmtNumber]')), item('初回検知日', dateValue('FirstSeen'))],
            [item('検知状況', textValue('[$DetectionStatus]')), item('最終検知日', dateValue('LastSeen'))],
          ),
        ]),
        // カード 2: 資産情報
        card('資産情報', '読み取り専用', [
          twoColumns(
            [
              item('IP', textValue('[$AssetIp]')),
              item('FQDN', textValue('[$AssetFqdn]')),
              item('資産タイプ', textValue('[$AssetType]')),
              item('事業会社', textValue('[$BusinessCompany]')),
              item('管理会社', textValue('[$AffiliateCompany]')),
            ],
            [
              item('資産管理ID', textValue('[$AssetMgmtId]')),
              item('外部接続申請ID', textValue('[$ExtConnAppId]')),
              item('旧管理番号', textValue('[$LegacyMgmtNumber]')),
              item('関連資産', textValue('[$RelatedAssets]')),
              item('管理事業会社特定の根拠', textValue('[$IdentifyEvidence]')),
            ],
          ),
        ]),
      ],
    }],
  };
}

/**
 * ClientFormCustomFormatter に入れる値 (文字列)。
 * キーは `headerJSONFormatter`。`header` ではフォームが読まない
 * (リストフォームの「レイアウトの構成」が書き込む形と揃えてある)。
 *
 * ★ bodyJSONFormatter (セクション) は **あえて設定しない**。
 *   設定するとフォームが単段組から複数段組に切り替わり、入力欄の幅が 1 セル
 *   (実測 242px / フォーム幅 1208px) に固定される。セクションは見出ししか付けられず
 *   幅も指定できない (公式仕様) ため、見出しを捨てて全幅を取っている。
 *   実測: body 無しなら対応経緯・備考の入力欄は 1200px = ほぼフォーム全幅。
 *   本体に出る列は 対応状況/対応者/対応期日/対応経緯/備考 の 5 つだけで、
 *   順序は列の並び順 (schema.ts の orderFieldLinks) で制御する。
 */
export function buildVulnResponseFormFormatter(): string {
  return JSON.stringify({ headerJSONFormatter: buildVulnResponseHeader() });
}
