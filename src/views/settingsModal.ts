// 設定ハブ (Spira 準拠の master-detail モーダル)。右上の歯車から開く。
// 大分類: 個人設定 / 共通設定 / その他。左ナビ + 右詳細 + 右下に単一保存ボタン。
import { el, clear } from '../utils/dom';
import { openModal } from '../components/modal';
import { toast } from '../components/toast';
import { getRepo } from '../api/repo';
import { CONDITION_OPS } from '../lib/conditions';
import { parseCsv } from '../lib/csv';
import { COLUMN_TYPES, inferTemplate } from '../lib/inferType';
import {
  getBundleSource, setBundleSource, getLocalBase, setLocalBase,
  currentBuildId, DEFAULT_LOCAL_BASE, type BundleSource,
} from '../utils/bundleVersion';
import { relayGetBundleDir, relaySetBundleDir } from '../api/relay';
import { performRelayUpdate } from '../utils/relayUpdate';
import { getState, setState } from '../state';
import type { ConditionRule, ConditionGroup, ColumnType, MikkeSettings } from '../types';

interface SettingPanel { body: HTMLElement; save?: () => Promise<void> | void; }
interface SettingItem { key: string; label: string; danger?: boolean; render: (root: HTMLElement) => Promise<SettingPanel> | SettingPanel; }
interface SubGroup { title: string; items: SettingItem[]; }
interface MajorGroup { key: string; title: string; subtitle: string; groups: SubGroup[]; }

const MAJOR_COLOR: Record<string, string> = {
  personal: '#5a76a3',  // 淡いブルー(accent-strong)
  shared:   '#2f6f5e',  // ok 系グリーン
  other:    '#a08c70',  // ベージュブラウン
};

export function openSettingsModal(root: HTMLElement): void {
  const majors = buildMajorGroups(root);

  const sideNav = el('div', {
    style: 'width:240px;flex-shrink:0;border-right:1px solid var(--line);' +
      'background:var(--paper-2);overflow-y:auto;padding:var(--s-2) 0',
  });
  const detailPane = el('div', {
    style: 'flex:1;padding:var(--s-5) var(--s-6);overflow:auto;background:var(--paper);min-width:0',
  });

  let activeKey = majors[0]!.groups[0]!.items[0]!.key;
  let currentSave: (() => Promise<void> | void) | null = null;
  const cache = new Map<string, SettingPanel>();
  let token = 0;

  const findItem = (key: string): SettingItem | null => {
    for (const M of majors) for (const g of M.groups) for (const it of g.items) {
      if (it.key === key) return it;
    }
    return null;
  };

  async function renderDetail(): Promise<void> {
    const item = findItem(activeKey);
    if (!item) return;
    const myToken = ++token;
    const myKey = activeKey;
    const cached = cache.get(activeKey);
    if (cached) {
      currentSave = cached.save ?? null;
      detailPane.replaceChildren(cached.body);
      detailPane.scrollTop = 0;
      return;
    }
    detailPane.replaceChildren(el('div', { style: 'color:var(--ink-3);font-size:var(--fs-sm)' }, ['読み込み中…']));
    const panel = await item.render(root);
    if (myToken !== token || myKey !== activeKey) return;
    cache.set(myKey, panel);
    currentSave = panel.save ?? null;
    detailPane.replaceChildren(panel.body);
    detailPane.scrollTop = 0;
  }

  function renderNav(): void {
    const children: HTMLElement[] = [];
    for (const M of majors) {
      const accent = MAJOR_COLOR[M.key] ?? 'var(--accent)';
      const sec: HTMLElement[] = [];
      sec.push(el('div', {
        style: `padding:var(--s-2) var(--s-3) 2px var(--s-3);font-size:var(--fs-sm);` +
          `font-weight:700;color:${accent};letter-spacing:0.03em`,
      }, [M.title]));
      sec.push(el('div', {
        style: 'padding:0 var(--s-3) var(--s-3) var(--s-3);font-size:11px;color:var(--ink-3);line-height:1.5',
      }, [M.subtitle]));
      for (const g of M.groups) {
        sec.push(el('div', {
          style: 'padding:var(--s-2) var(--s-3) 2px var(--s-3);font-size:var(--fs-xs);' +
            'color:var(--ink-3);text-transform:uppercase;letter-spacing:0.05em;font-weight:600',
        }, [g.title]));
        for (const it of g.items) {
          const active = it.key === activeKey;
          sec.push(el('div', {
            style: `display:block;padding:6px 12px 6px 16px;cursor:pointer;font-size:var(--fs-sm);` +
              `color:${active ? 'var(--ink)' : 'var(--ink-2)'};` +
              `background:${active ? 'var(--accent-soft)' : 'transparent'};` +
              `border-left:3px solid ${active ? 'var(--accent)' : 'transparent'};` +
              (it.danger ? 'color:var(--danger);' : ''),
            onclick: () => { activeKey = it.key; renderNav(); void renderDetail(); },
          }, [it.label]));
        }
      }
      children.push(el('div', {
        style: `border-left:4px solid ${accent};margin:var(--s-2) var(--s-3) var(--s-4) var(--s-3)`,
      }, sec));
    }
    clear(sideNav);
    sideNav.append(...children);
  }

  renderNav();
  void renderDetail();

  const body = el('div', {
    style: 'display:flex;height:100%;width:100%;margin:0;overflow:hidden;border-radius:var(--r-2)',
  }, [sideNav, detailPane]);

  openModal(root, {
    title: '⚙ 設定',
    body,
    size: 'xl',
    primaryLabel: '保存',
    hideCancel: true,
    onPrimary: async () => {
      if (currentSave) {
        try { await currentSave(); }
        catch { throw new Error('validation-failed'); }
      }
    },
  });
}

// ── 大分類定義 ──
function buildMajorGroups(root: HTMLElement): MajorGroup[] {
  return [
    {
      key: 'personal', title: '個人設定', subtitle: '端末ローカルに保存。自分にだけ反映。',
      groups: [
        { title: '表示', items: [{ key: 'theme', label: 'テーマ・外観', render: () => renderThemePanel(root) }] },
      ],
    },
    {
      key: 'shared', title: '共通設定', subtitle: 'SharePoint に保存。チーム全員に反映。',
      groups: [
        { title: '取込', items: [
          { key: 'columns', label: '管理項目の選択 (F6)', render: () => renderColumnsPanel(root) },
          { key: 'conditions', label: '管理対象条件 (F7)', render: () => renderConditionsPanel(root) },
          { key: 'individual', label: '個別追加 (Issue ID)', render: () => renderIndividualPanel(root) },
        ] },
      ],
    },
    {
      key: 'other', title: 'その他', subtitle: '接続先・運用情報・開発者向け。',
      groups: [
        { title: '接続', items: [{ key: 'connection', label: 'SP サイト / 中継サーバ', render: () => renderConnectionPanel(root) }] },
        { title: '開発', items: [{ key: 'developer', label: 'バンドル読込元 (開発者)', render: () => renderDeveloperPanel(root) }] },

      ],
    },
  ];
}

// 共通: 見出し + 説明
function panelHead(title: string, desc: string): HTMLElement {
  return el('div', { style: 'margin-bottom:var(--s-5)' }, [
    el('h3', { style: 'margin:0 0 var(--s-2);font-size:var(--fs-lg)' }, [title]),
    el('p', { style: 'margin:0;color:var(--ink-3);font-size:var(--fs-sm);line-height:1.6' }, [desc]),
  ]);
}

// ── 個人設定: テーマ ──
function renderThemePanel(root: HTMLElement): SettingPanel {
  const cur = root.getAttribute('data-theme') ?? 'light';
  const sel = el('select', { class: 'mikke-select', style: 'border:1px solid var(--line-strong)' }, [
    el('option', { value: 'light', ...(cur === 'light' ? { selected: 'selected' } : {}) }, ['ライト']),
    el('option', { value: 'dark', ...(cur === 'dark' ? { selected: 'selected' } : {}) }, ['ダーク']),
  ]) as HTMLSelectElement;
  const body = el('div', {}, [
    panelHead('テーマ・外観', 'この端末での表示テーマを切り替えます。'),
    el('div', { class: 'mikke-field' }, [el('label', { class: 'mikke-field-label' }, ['テーマ']), sel]),
  ]);
  return {
    body,
    save: () => {
      root.setAttribute('data-theme', sel.value);
      try { localStorage.setItem('mikke.theme', sel.value); } catch { /* noop */ }
      toast(root, 'テーマを保存しました', 'ok');
    },
  };
}

// ── 共通設定: F6 管理項目の選択 (＋テンプレ読込で型推定) ──
interface ColCand { name: string; sample: string; type: ColumnType; checked: boolean; }

async function renderColumnsPanel(root: HTMLElement): Promise<SettingPanel> {
  const s = await getRepo().getSettings();
  const checkedSet = new Set(s.managedColumns.map((c) => c.replace(/^Scan_/, '')));
  const typeMap = s.columnTypes ?? {};
  const headers = (s.lastCsvHeaders && s.lastCsvHeaders.length) ? s.lastCsvHeaders : Array.from(checkedSet);
  let cands: ColCand[] = headers.map((h) => ({
    name: h, sample: '', type: typeMap[h] ?? 'text', checked: checkedSet.has(h),
  }));

  const body = el('div', {}, [
    panelHead('管理項目の選択',
      '一覧・詳細に表示する検査ツール列をチェックします。テンプレート CSV（ヘッダ＋サンプル1行）を読み込むと、列とデータ型を自動推定して項目を設定できます。外した列のデータは保持され、再チェックで復活します。'),
  ]);

  // テンプレート読込
  const fileInput = el('input', {
    type: 'file', accept: '.csv,text/csv', class: 'mikke-dropzone-input',
    onchange: (e: Event) => { const f = (e.target as HTMLInputElement).files?.[0]; if (f) void loadTemplate(f); },
  }) as HTMLInputElement;
  body.append(el('div', { style: 'margin-bottom:var(--s-4)' }, [
    el('button', { class: 'mikke-btn mikke-btn--secondary', type: 'button', onclick: () => fileInput.click() },
      ['テンプレートCSVを読み込む（ヘッダ＋サンプル1行）']),
    fileInput,
    el('div', { style: 'font-size:var(--fs-xs);color:var(--ink-3);margin-top:var(--s-2);line-height:1.6' }, [
      '1 行目=列名、2 行目=各列のサンプル値。サンプル値から型（テキスト/数値/日付/日時/真偽/長文）を推定します。型は推定結果を編集できます。',
    ]),
  ]));

  const tableWrap = el('div');
  body.append(tableWrap);
  paintTable();

  async function loadTemplate(file: File): Promise<void> {
    try {
      const parsed = parseCsv(await file.text());
      if (!parsed.headers.length) { toast(root, 'テンプレートにヘッダ（1行目）がありません。', 'warn'); return; }
      cands = inferTemplate(parsed.headers, parsed.rows[0]).map((c) => ({
        name: c.name, sample: c.sample, type: c.type, checked: true,
      }));
      paintTable();
      toast(root, `テンプレートから ${cands.length} 列を読み込みました（全て管理対象に設定）。型を確認して保存してください。`, 'ok', 5000);
    } catch (e) {
      toast(root, `テンプレートの読込に失敗: ${(e as Error).message}`, 'error');
    }
  }

  function paintTable(): void {
    clear(tableWrap);
    if (!cands.length) {
      tableWrap.appendChild(el('p', { style: 'color:var(--ink-3);font-size:var(--fs-sm)' }, [
        'まだ列候補がありません。テンプレート CSV を読み込むか、先に実データ CSV を一度取り込んでください。',
      ]));
      return;
    }
    const thead = el('thead', {}, [el('tr', {}, [
      el('th', { style: 'width:48px' }, ['管理']),
      el('th', {}, ['列名']),
      el('th', {}, ['サンプル']),
      el('th', { style: 'width:128px' }, ['データ型']),
    ])]);
    const tbody = el('tbody', {}, cands.map((c) => el('tr', {}, [
      el('td', { style: 'text-align:center' }, [
        el('input', { type: 'checkbox', ...(c.checked ? { checked: 'checked' } : {}),
          onchange: (e: Event) => { c.checked = (e.target as HTMLInputElement).checked; } }),
      ]),
      el('td', {}, [c.name]),
      el('td', { style: 'color:var(--ink-3);font-family:var(--font-mono);font-size:var(--fs-sm);max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap' }, [c.sample || '—']),
      el('td', {}, [
        el('select', { class: 'mikke-select', style: 'border:1px solid var(--line)',
          onchange: (e: Event) => { c.type = (e.target as HTMLSelectElement).value as ColumnType; } },
          COLUMN_TYPES.map((t) => el('option', { value: t.value, ...(t.value === c.type ? { selected: 'selected' } : {}) }, [t.label]))),
      ]),
    ])));
    tableWrap.appendChild(el('div', { class: 'mikke-table-wrap', style: 'padding:0;max-height:420px;max-width:640px' }, [
      el('table', { class: 'mikke-table' }, [thead, tbody]),
    ]));
  }

  return {
    body,
    save: async () => {
      const managed = cands.filter((c) => c.checked).map((c) => `Scan_${c.name}`);
      const columnTypes: Record<string, ColumnType> = { ...(s.columnTypes ?? {}) };
      for (const c of cands) columnTypes[c.name] = c.type;
      const next: MikkeSettings = {
        ...s, managedColumns: managed, columnTypes,
        lastCsvHeaders: cands.length ? cands.map((c) => c.name) : s.lastCsvHeaders,
      };
      await getRepo().saveSettings(next);
      toast(root, `管理項目 ${managed.length} 件を保存しました`, 'ok');
    },
  };
}

// ── 共通設定: F7 管理対象条件 ──
async function renderConditionsPanel(root: HTMLElement): Promise<SettingPanel> {
  const s = await getRepo().getSettings();
  const group: ConditionGroup = s.matchConditions ?? { combinator: 'OR', rules: [] };
  const headers = s.lastCsvHeaders ?? [];
  const dlId = 'mikke-csv-headers-modal';
  const body = el('div', {}, [
    panelHead('管理対象条件', 'CSV 列に対する AND/OR 条件で管理対象を定義します。条件変更は次回取込から適用されます。'),
  ]);
  body.appendChild(el('datalist', { id: dlId }, headers.map((h) => el('option', { value: h }))));

  const combSel = el('select', { class: 'mikke-select', style: 'border:1px solid var(--line-strong)',
    onchange: (e: Event) => { group.combinator = (e.target as HTMLSelectElement).value as 'AND' | 'OR'; } }, [
    el('option', { value: 'AND', ...(group.combinator === 'AND' ? { selected: 'selected' } : {}) }, ['すべて満たす (AND)']),
    el('option', { value: 'OR', ...(group.combinator === 'OR' ? { selected: 'selected' } : {}) }, ['いずれか満たす (OR)']),
  ]);
  body.appendChild(el('div', { class: 'mikke-field' }, [el('label', { class: 'mikke-field-label' }, ['結合']), combSel]));

  const rulesBox = el('div');
  body.appendChild(rulesBox);
  const preview = el('div', { style: 'margin-top:var(--s-4);font-size:var(--fs-sm);color:var(--ink-3)' });
  function updatePreview(): void {
    const flat = group.rules.filter((r) => !(r as ConditionGroup).combinator) as ConditionRule[];
    const valid = flat.every((r) => r.field.trim() && r.value.trim());
    preview.textContent = group.rules.length === 0
      ? '条件が未設定です。'
      : `${group.rules.length} 条件 / ${group.combinator}${valid ? '' : ' — ⚠ 未入力の条件があります'}`;
  }
  function paintRules(): void {
    clear(rulesBox);
    group.rules.forEach((r, idx) => {
      if ((r as ConditionGroup).combinator) return;
      const rule = r as ConditionRule;
      rulesBox.appendChild(el('div', { class: 'mikke-cond-row' }, [
        el('input', { class: 'mikke-input', list: dlId, style: 'border:1px solid var(--line)', placeholder: '列名',
          value: rule.field, oninput: (e: Event) => { rule.field = (e.target as HTMLInputElement).value; updatePreview(); } }),
        el('select', { class: 'mikke-select', style: 'border:1px solid var(--line)',
          onchange: (e: Event) => { rule.op = (e.target as HTMLSelectElement).value as ConditionRule['op']; } },
          CONDITION_OPS.map((o) => el('option', { value: o.value, ...(o.value === rule.op ? { selected: 'selected' } : {}) }, [o.label]))),
        el('input', { class: 'mikke-input', style: 'border:1px solid var(--line)', placeholder: '値',
          value: rule.value, oninput: (e: Event) => { rule.value = (e.target as HTMLInputElement).value; updatePreview(); } }),
        el('button', { class: 'mikke-iconbtn', 'aria-label': '削除',
          onclick: () => { group.rules.splice(idx, 1); paintRules(); updatePreview(); }, html: '✕' }),
      ]));
    });
  }
  paintRules(); updatePreview();
  body.append(
    el('button', { class: 'mikke-btn mikke-btn--secondary', style: 'margin-top:var(--s-3)',
      onclick: () => { group.rules.push({ field: '', op: 'equals', value: '' }); paintRules(); updatePreview(); } }, ['+ 条件を追加']),
    preview,
  );
  return {
    body,
    save: async () => {
      await getRepo().saveSettings({ ...s, matchConditions: group });
      toast(root, '条件を保存しました', 'ok');
    },
  };
}

// ── 共通設定: 個別追加 ──
async function renderIndividualPanel(root: HTMLElement): Promise<SettingPanel> {
  const s = await getRepo().getSettings();
  const ta = el('textarea', {
    style: 'width:100%;min-height:200px;padding:var(--s-3);border:1px solid var(--line-strong);border-radius:var(--r-2);font-family:var(--font-mono)',
  }, [s.individualIds.join('\n')]) as HTMLTextAreaElement;
  const body = el('div', {}, [
    panelHead('個別追加 (Issue Instance ID)', '条件に関係なく管理対象に加える Issue Instance ID を 1 行 1 件で入力します。'),
    ta,
  ]);
  return {
    body,
    save: async () => {
      const ids = ta.value.split('\n').map((x) => x.trim()).filter(Boolean);
      await getRepo().saveSettings({ ...s, individualIds: ids });
      toast(root, `個別追加 ${ids.length} 件を保存しました`, 'ok');
    },
  };
}

// ── その他: 接続 ──
function renderConnectionPanel(root: HTMLElement): SettingPanel {
  let siteUrl = '';
  let relayBase = '';
  try { siteUrl = localStorage.getItem('mikke.selectedSiteUrl') || ''; } catch { /* noop */ }
  try { relayBase = localStorage.getItem('mikke.relay.base') || 'http://127.0.0.1:18080/mikke'; } catch { /* noop */ }
  const siteInput = el('input', { type: 'text', value: siteUrl, placeholder: 'https://<tenant>.sharepoint.com/sites/<site>' }) as HTMLInputElement;
  const relayInput = el('input', { type: 'text', value: relayBase }) as HTMLInputElement;
  const body = el('div', {}, [
    panelHead('SP サイト / 中継サーバ', '管理 DB を置く SharePoint サイトと、CSV 解析・API 中継に使うローカル中継サーバの接続先。'),
    el('div', { class: 'mikke-field' }, [el('label', { class: 'mikke-field-label' }, ['SP サイト URL']), siteInput]),
    el('div', { class: 'mikke-field' }, [el('label', { class: 'mikke-field-label' }, ['中継サーバ ベース URL']), relayInput]),
  ]);

  // relay スクリプト更新がある場合の適用ボタン (起動時チェックで検知済み)。
  const ru = getState().relayUpdateAvailable;
  if (ru) {
    const btn = el('button', { class: 'mikke-btn mikke-btn--primary', type: 'button' },
      ['中継サーバを今すぐ更新']) as HTMLButtonElement;
    btn.addEventListener('click', () => void (async () => {
      btn.setAttribute('disabled', '');
      toast(root, '中継サーバを更新しています…', 'default');
      try {
        await performRelayUpdate(ru.files);
        setState({ relayUpdateAvailable: null });
        toast(root, '更新を送信しました。中継サーバが再起動します（数秒）。再起動後に有効になります。', 'ok', 6000);
        box.remove();
      } catch (e) {
        btn.removeAttribute('disabled');
        toast(root, `中継サーバの更新に失敗: ${(e as Error).message}`, 'error', 6000);
      }
    })());
    const box = el('div', { style: 'margin-top:var(--s-5);padding:var(--s-4);background:var(--accent-soft);border-radius:var(--r-2)' }, [
      el('div', { style: 'font-size:var(--fs-sm);color:var(--ink);margin-bottom:var(--s-3)' }, [
        `中継サーバの更新があります: v${ru.localVersion} → v${ru.remoteVersion}`,
      ]),
      el('div', { style: 'font-size:var(--fs-xs);color:var(--ink-3);margin-bottom:var(--s-3);line-height:1.6' }, [
        'SharePoint 上の最新 relay スクリプトを取得して中継サーバに送信し、自動で入れ替え＆再起動します。',
      ]),
      btn,
    ]);
    body.appendChild(box);
  }
  return {
    body,
    save: () => {
      try {
        if (siteInput.value.trim()) localStorage.setItem('mikke.selectedSiteUrl', siteInput.value.trim().replace(/\/$/, ''));
        localStorage.setItem('mikke.relay.base', relayInput.value.trim().replace(/\/+$/, ''));
      } catch { /* noop */ }
      toast(root, '接続設定を保存しました', 'ok');
    },
  };
}

// ── その他: 開発 (バンドル読込元の切替) ──
//  ローダは起動時に localStorage(mikke.dev.*) を見て本体取得先を決める。ここを
//  変えると「次回リロード」で SharePoint / ローカル relay の dist が切り替わる。
//  開発中は local にすれば SP へ毎回アップロードせずに反映できる。
async function renderDeveloperPanel(root: HTMLElement): Promise<SettingPanel> {
  const cur = getBundleSource();
  const name = 'mikke-bundle-source';
  const radioSP = el('input', { type: 'radio', name, value: 'sharepoint', style: 'cursor:pointer',
    ...(cur === 'sharepoint' ? { checked: 'checked' } : {}) }) as HTMLInputElement;
  const radioLocal = el('input', { type: 'radio', name, value: 'local', style: 'cursor:pointer',
    ...(cur === 'local' ? { checked: 'checked' } : {}) }) as HTMLInputElement;
  const baseInput = el('input', { type: 'text', value: getLocalBase(), placeholder: DEFAULT_LOCAL_BASE,
    style: 'width:100%;font-family:var(--font-mono);font-size:var(--fs-sm)' }) as HTMLInputElement;

  // relay の配信ディレクトリ (mikke.bundle.js / version.txt の読込元) を照会。
  // relay 未起動なら空のまま (保存時に POST して反映)。
  let originalDir = '';
  let relayReachable = false;
  try {
    const bd = await relayGetBundleDir();
    originalDir = bd.dir || '';
    relayReachable = true;
  } catch { /* relay 未起動 / 未到達 */ }
  const dirInput = el('input', { type: 'text', value: originalDir,
    placeholder: relayReachable ? '' : '(relay 未起動 — 起動後に再度開くと現在値を取得)',
    style: 'width:100%;font-family:var(--font-mono);font-size:var(--fs-sm)' }) as HTMLInputElement;
  const dirStatus = el('div', { style: 'font-size:var(--fs-xs);color:var(--ink-3);margin-top:var(--s-2)' }, [
    relayReachable ? `現在の relay 配信元: ${originalDir || '(未設定)'}` : '※ relay に接続できません（中継サーバを起動してください）。',
  ]);

  const radioRow = (input: HTMLInputElement, label: string, hint: string) =>
    el('label', { style: 'display:flex;align-items:flex-start;gap:var(--s-3);cursor:pointer;padding:var(--s-3);background:var(--paper-2);border-radius:var(--r-2);margin-bottom:var(--s-2)' }, [
      el('span', { style: 'padding-top:2px' }, [input]),
      el('span', { style: 'font-size:var(--fs-sm);color:var(--ink)' }, [
        el('strong', {}, [label]), el('br'),
        el('span', { style: 'color:var(--ink-3);font-size:var(--fs-xs)' }, [hint]),
      ]),
    ]);

  const body = el('div', {}, [
    panelHead('バンドル読込元 (開発者)',
      'Mikke 本体 (mikke.bundle.js) をどこから読むかを切り替えます。開発中はローカル relay の dist を読ませると、SharePoint へ毎回アップロードせずに変更を反映できます。'),
    el('div', { style: 'font-size:var(--fs-xs);color:var(--ink-3);margin-bottom:var(--s-4)' }, [
      `現在の起動 build: ${currentBuildId() || '(不明)'}`,
    ]),
    radioRow(radioSP, 'SharePoint (本番)', '実行中サイトの ドキュメント/Mikke から読む'),
    radioRow(radioLocal, 'ローカル relay (開発)', '下記 base から読む。mikke-relay が GET /mikke/mikke.bundle.js で配信'),
    el('div', { class: 'mikke-field', style: 'margin-top:var(--s-3)' }, [
      el('label', { class: 'mikke-field-label' }, ['ローカル base URL']),
      baseInput,
    ]),
    el('div', { class: 'mikke-field', style: 'margin-top:var(--s-4)' }, [
      el('label', { class: 'mikke-field-label' }, ['relay の配信ディレクトリ (新しいコードの読込元)']),
      dirInput,
      dirStatus,
      el('div', { style: 'font-size:var(--fs-xs);color:var(--ink-3);margin-top:var(--s-2);line-height:1.6' }, [
        'ローカル relay が mikke.bundle.js / version.txt を読むフォルダの絶対パス。',
        '開発時はビルド先 dist（例: C:\\Users\\…\\Mikke\\dist）を指定すると、ビルドし直すだけで反映されます。',
        '保存時に relay へ送信し、relay 側でフォルダの存在を確認します。',
      ]),
    ]),
    el('div', { style: 'margin-top:var(--s-4);padding:var(--s-3);background:var(--accent-soft);border-radius:var(--r-2);font-size:var(--fs-sm);color:var(--ink-2)' }, [
      '※ 読込元(SharePoint/ローカル)の切替は「次回リロード」で反映されます（ローダは起動時に 1 度だけ参照先を決めるため）。保存後、右上の更新アイコンまたはブックマーク再クリックでリロードしてください。配信ディレクトリの変更は relay に即時反映されます。',
    ]),
  ]);
  return {
    body,
    save: async () => {
      const src: BundleSource = radioLocal.checked ? 'local' : 'sharepoint';
      setBundleSource(src);
      setLocalBase(baseInput.value);

      // relay 配信ディレクトリの変更があれば POST。relay 未到達/失敗は警告に留め、
      // ローカル設定の保存自体は止めない。
      const dir = dirInput.value.trim();
      if (dir && dir !== originalDir) {
        try {
          const res = await relaySetBundleDir(dir);
          toast(root, `relay 配信ディレクトリを設定しました: ${res.dir}${res.bundleExists ? '' : '（⚠ そのフォルダに mikke.bundle.js が見つかりません）'}`, res.bundleExists ? 'ok' : 'warn', 6000);
        } catch (e) {
          toast(root, `relay 配信ディレクトリの設定に失敗: ${(e as Error).message}`, 'error', 6000);
        }
      }

      toast(root, `読込元を「${src === 'local' ? 'ローカル relay' : 'SharePoint'}」に保存しました。リロードで反映されます。`, 'ok', 6000);
    },
  };
}
