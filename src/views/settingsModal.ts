// 設定ハブ (既存の内製ツール準拠の master-detail モーダル)。右上の歯車から開く。
// 大分類: 個人設定 / 共通設定 / その他。左ナビ + 右詳細 + 右下に単一保存ボタン。
import { el, clear } from '../utils/dom';
import { openModal } from '../components/modal';
import { toast } from '../components/toast';
import { getRepo } from '../api/repo';
import { renderMigrationPanel } from './migrationPanel';
import { renderOverseasMigrationPanel } from './overseasMigrationPanel';
import { renderEnvTransferPanel } from './envTransferPanel';
import { renderResetPanel } from './resetPanel';
import { normalizeVulnTypeRules } from '../lib/migration';
import { opsForType, opLabel, opNeedsValue2 } from '../lib/conditions';
import { parseCsv } from '../lib/csv';
import { COLUMN_TYPES, inferTemplate } from '../lib/inferType';
import {
  getBundleSource, setBundleSource, getLocalBase, setLocalBase,
  currentBuildId, DEFAULT_LOCAL_BASE, type BundleSource,
} from '../utils/bundleVersion';
import { relayGetBundleDir, relaySetBundleDir } from '../api/relay';
import { performRelayUpdate } from '../utils/relayUpdate';
import { RELEASE_NOTES, type ReleaseNote } from '../lib/releaseNotes';
import { getState, setState } from '../state';
import type { ConditionRule, ConditionGroup, ColumnType, MikkeSettings, SetupResult } from '../types';

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
          { key: 'vulnType', label: '脆弱性タイプの判定', render: () => renderVulnTypePanel() },
          { key: 'migration', label: 'データ移行 (Excel)', render: () => renderMigrationPanel(root) },
          { key: 'overseasMigration', label: '海外データ移行 (Excel)', render: () => renderOverseasMigrationPanel(root) },
          { key: 'envTransfer', label: '環境間コピー (開発 ↔ 本番)', render: () => renderEnvTransferPanel(root) },
        ] },
        { title: 'ダウンロード', items: [
          { key: 'downloadFolder', label: '保存先フォルダ', render: () => renderDownloadPanel(root) },
        ] },
        { title: '連携', items: [
          { key: 'vulnResponseList', label: '資産管理者向けリスト', render: () => renderVulnResponsePanel(root) },
          { key: 'overseasResponseList', label: '海外拠点向けリスト', render: () => renderOverseasResponsePanel(root) },
        ] },
      ],
    },
    {
      key: 'other', title: 'その他', subtitle: '接続先・運用情報・開発者向け。',
      groups: [
        { title: '接続', items: [{ key: 'connection', label: 'SP サイト / 中継サーバ', render: () => renderConnectionPanel(root) }] },
        { title: '情報', items: [{ key: 'releaseNotes', label: '更新履歴', render: () => renderReleaseNotesPanel() }] },
        { title: '開発', items: [{ key: 'developer', label: 'バンドル読込元 (開発者)', render: () => renderDeveloperPanel(root) }] },
        { title: '危険', items: [
          { key: 'reset', label: '管理対象一覧のリセット', danger: true, render: () => renderResetPanel(root) },
        ] },
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
      'CSV の全列は常に取り込まれ、詳細画面（検査ツール詳細）で参照できます。ここでチェックした列は「一覧の列」として表示されます。テンプレート CSV（ヘッダ＋サンプル1行）を読み込むと、列とデータ型を自動推定して設定できます。'),
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

// ── 共通設定: F7 管理対象条件 (型対応の演算子 + AND/OR ネスト) ──
async function renderConditionsPanel(root: HTMLElement): Promise<SettingPanel> {
  const s = await getRepo().getSettings();
  const rootGroup: ConditionGroup = s.matchConditions ?? { combinator: 'OR', rules: [] };
  const headers = s.lastCsvHeaders ?? [];
  const types = s.columnTypes ?? {};
  const dlId = 'mikke-csv-headers-modal';

  const body = el('div', {}, [
    panelHead('管理対象条件',
      'CSV 列に対する条件で管理対象を定義します。AND/OR はグループでネストでき、数値は以上/以下、日付は期間で指定できます（F6 でテンプレ読込すると型が反映されます）。左の ⠿ をドラッグすると条件・グループを並べ替え／別グループやグループ外へ移動できます。条件変更は次回取込から適用されます。'),
  ]);
  body.appendChild(el('datalist', { id: dlId }, headers.map((h) => el('option', { value: h }))));

  const tree = el('div', { class: 'mikke-cond-tree' });
  body.appendChild(tree);
  const preview = el('div', { style: 'margin-top:var(--s-4);font-size:var(--fs-sm);color:var(--ink-3)' });
  body.appendChild(preview);

  const isGroupNode = (r: ConditionRule | ConditionGroup): r is ConditionGroup =>
    (r as ConditionGroup).combinator !== undefined;
  const fieldType = (field: string): ColumnType | undefined => types[field.trim()];

  function countRules(g: ConditionGroup): { count: number; invalid: number } {
    let count = 0; let invalid = 0;
    for (const r of g.rules) {
      if (isGroupNode(r)) { const c = countRules(r); count += c.count; invalid += c.invalid; }
      else {
        count++;
        const needV2 = opNeedsValue2(r.op);
        if (!r.field.trim() || !r.value.trim() || (needV2 && !(r.value2 ?? '').trim())) invalid++;
      }
    }
    return { count, invalid };
  }
  function updatePreview(): void {
    const { count, invalid } = countRules(rootGroup);
    preview.textContent = count === 0 ? '条件が未設定です。'
      : `${count} 条件${invalid ? ` — ⚠ ${invalid} 件未入力` : ''}`;
  }

  type CondNode = ConditionRule | ConditionGroup;

  // group が node 自身またはその子孫を含むか (グループを自分の中へ落とす循環を防ぐ)。
  function containsNode(group: ConditionGroup, node: CondNode): boolean {
    if (group === node) return true;
    for (const r of group.rules) {
      if (r === node) return true;
      if (isGroupNode(r) && containsNode(r, node)) return true;
    }
    return false;
  }
  function moveNode(node: CondNode, srcGroup: ConditionGroup, dstGroup: ConditionGroup, dstIndex: number): void {
    const si = srcGroup.rules.indexOf(node);
    if (si < 0) return;
    srcGroup.rules.splice(si, 1);
    let di = dstIndex;
    if (srcGroup === dstGroup && si < dstIndex) di -= 1;   // 自分を抜いた分の補正
    if (di < 0) di = 0;
    if (di > dstGroup.rules.length) di = dstGroup.rules.length;
    dstGroup.rules.splice(di, 0, node);
  }

  // target を子に持つグループを探す。
  function findParent(group: ConditionGroup, target: CondNode): ConditionGroup | null {
    for (const r of group.rules) {
      if (r === target) return group;
      if (isGroupNode(r)) { const f = findParent(r, target); if (f) return f; }
    }
    return null;
  }
  // 中身が空になったグループを親から削除 (root は残す)。親も空になれば連鎖削除。
  // ※ 操作 (移動 / 削除) で空になったグループだけを対象にする。新規追加直後の
  //   空グループは別経路 (paint) なので消えない。
  function removeIfEmpty(g: ConditionGroup): void {
    if (g === rootGroup || g.rules.length > 0) return;
    const parent = findParent(rootGroup, g);
    if (!parent) return;
    const i = parent.rules.indexOf(g);
    if (i >= 0) parent.rules.splice(i, 1);
    removeIfEmpty(parent);
  }

  function paint(): void { clear(tree); tree.appendChild(renderGroup(rootGroup, null, -1)); updatePreview(); }

  function smallBtn(label: string, onclick: () => void): HTMLElement {
    return el('button', { class: 'mikke-btn mikke-btn--secondary', type: 'button',
      style: 'height:28px;padding:0 var(--s-4);font-size:var(--fs-sm)', onclick }, [label]);
  }

  // 挿入位置のドロップゾーン。pointer ドラッグ中に elementFromPoint で判定するため、
  // 位置情報 (どのグループの何番目か) を WeakMap に持たせる。
  const dropMeta = new WeakMap<HTMLElement, { g: ConditionGroup; i: number }>();
  function dropZone(group: ConditionGroup, index: number): HTMLElement {
    const dz = el('div', { class: 'mikke-cond-drop' });
    dropMeta.set(dz, { g: group, i: index });
    return dz;
  }

  // ⠿ は「掴める位置」の目印 (実際の開始は行/ヘッダ全体の pointerdown)。
  function gripIcon(): HTMLElement {
    return el('span', { class: 'mikke-cond-grip', 'aria-hidden': 'true', title: 'ドラッグで移動' }, ['⠿']);
  }

  function clearDragState(): void {
    tree.classList.remove('is-dragging');
    tree.querySelectorAll('.mikke-cond-drop.is-over').forEach((d) => d.classList.remove('is-over'));
    tree.querySelectorAll('.mikke-cond-group.is-drag-src').forEach((d) => d.classList.remove('is-drag-src'));
    tree.querySelectorAll('.mikke-cond-row.is-drag-active').forEach((d) => d.classList.remove('is-drag-active'));
  }

  // ★ ネイティブ HTML5 drag は overlay (#mikke-root の all:initial シールド) 環境で
  //   実ブラウザだと安定して開始しないため使わない。pointer イベントで自前ドラッグ
  //   する。行 / グループヘッダのどこでも (入力欄の上を除き) 掴んで移動できる。
  function attachPointerDrag(elm: HTMLElement, group: ConditionGroup, node: CondNode): void {
    elm.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;                                  // 左ボタンのみ
      const t = e.target as HTMLElement;
      if (t.closest('input, select, textarea, button, a, [contenteditable]')) return; // 編集を優先
      e.preventDefault();
      const startX = e.clientX; const startY = e.clientY; const pid = e.pointerId;
      let active = false;
      let over: HTMLElement | null = null;
      const setOver = (dz: HTMLElement | null): void => {
        if (dz === over) return;
        if (over) over.classList.remove('is-over');
        over = dz;
        if (over) over.classList.add('is-over');
      };
      const onMove = (ev: PointerEvent): void => {
        if (!active) {
          if (Math.abs(ev.clientX - startX) + Math.abs(ev.clientY - startY) < 4) return;
          active = true;
          tree.classList.add('is-dragging');
          if (isGroupNode(node)) {
            const gx = elm.closest('.mikke-cond-group');
            if (gx) gx.classList.add('is-drag-src');
          } else {
            elm.classList.add('is-drag-active');
          }
        }
        const hit = document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null;
        const dz = hit ? (hit.closest('.mikke-cond-drop') as HTMLElement | null) : null;
        setOver(dz && tree.contains(dz) ? dz : null);
      };
      const onUp = (): void => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onUp);
        try { elm.releasePointerCapture(pid); } catch { /* noop */ }
        const meta = over ? dropMeta.get(over) : undefined;
        clearDragState();
        if (active && meta) {
          if (isGroupNode(node) && containsNode(node, meta.g)) { paint(); return; }
          moveNode(node, group, meta.g, meta.i);
          removeIfEmpty(group);   // 移動元グループが空になったら削除
          paint();
        }
      };
      try { elm.setPointerCapture(pid); } catch { /* noop */ }
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
    });
  }

  function renderRule(parent: ConditionGroup, rule: ConditionRule): HTMLElement {
    const t = fieldType(rule.field);
    const ops = opsForType(t);
    if (!ops.includes(rule.op)) rule.op = 'equals';   // 型に合わない演算子はリセット
    const inputType = t === 'number' ? 'number' : (t === 'date' || t === 'datetime') ? 'date' : 'text';

    const fieldInput = el('input', { class: 'mikke-input', list: dlId, style: 'border:1px solid var(--line);min-width:140px',
      placeholder: '列名', value: rule.field,
      onchange: (e: Event) => { rule.field = (e.target as HTMLInputElement).value; paint(); } });

    const opSel = el('select', { class: 'mikke-select', style: 'border:1px solid var(--line)',
      onchange: (e: Event) => { rule.op = (e.target as HTMLSelectElement).value as ConditionRule['op']; paint(); } },
      ops.map((op) => el('option', { value: op, ...(op === rule.op ? { selected: 'selected' } : {}) }, [opLabel(op, t)])));

    const valInput = el('input', { class: 'mikke-input', type: inputType, style: 'border:1px solid var(--line);min-width:110px',
      placeholder: '値', value: rule.value,
      oninput: (e: Event) => { rule.value = (e.target as HTMLInputElement).value; updatePreview(); } });

    const cells: (Node | string)[] = [gripIcon(), fieldInput, opSel, valInput];
    if (opNeedsValue2(rule.op)) {
      cells.push(el('span', { style: 'color:var(--ink-3)' }, ['〜']));
      cells.push(el('input', { class: 'mikke-input', type: inputType, style: 'border:1px solid var(--line);min-width:110px',
        placeholder: '上限', value: rule.value2 ?? '',
        oninput: (e: Event) => { rule.value2 = (e.target as HTMLInputElement).value; updatePreview(); } }));
    }
    cells.push(el('button', { class: 'mikke-iconbtn', 'aria-label': '削除', html: '✕',
      onclick: () => { const i = parent.rules.indexOf(rule); if (i >= 0) parent.rules.splice(i, 1); removeIfEmpty(parent); paint(); } }));
    const row = el('div', { class: 'mikke-cond-row' }, cells as (Node | string)[]);
    attachPointerDrag(row, parent, rule);   // 行全体をドラッグ可能 (入力欄の上では抑止)
    return row;
  }

  function renderGroup(group: ConditionGroup, parent: ConditionGroup | null, _idx: number): HTMLElement {
    const combSel = el('select', { class: 'mikke-select', style: 'border:1px solid var(--line-strong)',
      onchange: (e: Event) => { group.combinator = (e.target as HTMLSelectElement).value as 'AND' | 'OR'; updatePreview(); } }, [
      el('option', { value: 'AND', ...(group.combinator === 'AND' ? { selected: 'selected' } : {}) }, ['すべて満たす (AND)']),
      el('option', { value: 'OR', ...(group.combinator === 'OR' ? { selected: 'selected' } : {}) }, ['いずれか満たす (OR)']),
    ]);
    const header = el('div', { style: 'display:flex;gap:var(--s-2);align-items:center;flex-wrap:wrap;margin-bottom:var(--s-3)' }, [
      ...(parent ? [gripIcon()] : []),
      combSel,
      smallBtn('＋条件', () => { group.rules.push({ field: '', op: 'equals', value: '' }); paint(); }),
      smallBtn('＋グループ', () => { group.rules.push({ combinator: 'AND', rules: [] }); paint(); }),
      ...(parent ? [el('button', { class: 'mikke-iconbtn', 'aria-label': 'グループ削除', html: '✕',
        onclick: () => { const i = parent.rules.indexOf(group); if (i >= 0) parent.rules.splice(i, 1); removeIfEmpty(parent); paint(); } })] : []),
    ]);
    if (parent) attachPointerDrag(header, parent, group);   // グループはヘッダ全体でドラッグ可能
    // 各条件・子グループは、このグループの AND/OR ヘッダより一段インデントを下げる。
    const childrenBox = el('div', { style: 'padding-left:var(--s-6)' });
    childrenBox.appendChild(dropZone(group, 0));
    group.rules.forEach((r, i) => {
      childrenBox.appendChild(isGroupNode(r) ? renderGroup(r, group, i) : renderRule(group, r));
      childrenBox.appendChild(dropZone(group, i + 1));
    });
    const nestStyle = parent
      ? 'border-left:2px solid var(--accent-soft);padding:var(--s-3) 0 var(--s-3) var(--s-4);margin:var(--s-2) 0'
      : '';
    return el('div', { class: 'mikke-cond-group', style: nestStyle }, [header, childrenBox]);
  }

  paint();
  return {
    body,
    save: async () => {
      await getRepo().saveSettings({ ...s, matchConditions: rootGroup });
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

// ── 共通設定: ダウンロード保存先 ──
async function renderDownloadPanel(root: HTMLElement): Promise<SettingPanel> {
  const s = await getRepo().getSettings();
  const input = el('input', {
    type: 'text', class: 'mikke-input',
    value: s.downloadFolder ?? 'Shared Documents/MikkeDownloads',
    placeholder: 'Shared Documents/MikkeDownloads',
    style: 'width:100%',
  }) as HTMLInputElement;
  const body = el('div', {}, [
    panelHead('ダウンロードデータの保存先',
      '「ダウンロードデータ」で取得した zip を保存する SP ドキュメントライブラリのフォルダ（サイト相対パス）です。取得時にこの配下へ日時フォルダを作成し、種別ごとに zip を置きます。無ければ自動作成します。'),
    el('div', { class: 'mikke-field' }, [
      el('label', { class: 'mikke-field-label' }, ['保存先フォルダ (サイト相対)']), input,
    ]),
  ]);
  return {
    body,
    save: async () => {
      const folder = input.value.trim().replace(/^\/+|\/+$/g, '') || 'Shared Documents/MikkeDownloads';
      await getRepo().saveSettings({ ...s, downloadFolder: folder });
      toast(root, '保存先フォルダを保存しました', 'ok');
    },
  };
}

// ── 共通設定: 連携用リストの構築 ──
//   国内 (資産管理者向け) と海外 (海外拠点向け) で同じ画面を使う。違うのは
//   説明文と、実際に叩く構築 API だけ。
interface ListSetupOpts {
  title: string;
  description: string;
  bullets: string[];
  run: () => Promise<SetupResult>;
}

function renderListSetupPanel(root: HTMLElement, opts: ListSetupOpts): SettingPanel {
  const result = el('div', { style: 'margin-top:var(--s-5)' });
  const runBtn = el('button', { class: 'mikke-btn mikke-btn--primary', type: 'button' }, ['リストを作成 / 整形する']);

  const countLine = (c: SetupResult['counts']): HTMLElement =>
    el('div', { style: 'font-size:var(--fs-md);color:var(--ink);margin-bottom:var(--s-3)' }, [
      `作成 ${c.created} / 更新 ${c.updated} / スキップ ${c.skipped} / 失敗 ${c.failed}`,
    ]);

  const stepRow = (s: SetupResult['steps'][number]): HTMLElement => {
    const mark = { created: '+', updated: '~', skipped: '=', failed: '×' }[s.outcome];
    const color = s.outcome === 'failed' ? 'var(--danger)'
      : s.outcome === 'skipped' ? 'var(--ink-3)' : 'var(--ink-2)';
    return el('div', {
      style: `display:flex;gap:var(--s-3);padding:var(--s-1) 0;font-size:var(--fs-sm);color:${color}`,
    }, [
      el('span', { style: 'width:1.2em;flex-shrink:0;font-family:var(--font-mono)' }, [mark]),
      el('span', { style: 'flex-shrink:0;min-width:8em' }, [s.category]),
      el('span', { style: 'flex:1;min-width:0;word-break:break-all' }, [s.target + (s.detail ? ` — ${s.detail}` : '')]),
    ]);
  };

  runBtn.onclick = async () => {
    runBtn.setAttribute('disabled', '');
    clear(result);
    result.appendChild(el('div', { style: 'color:var(--ink-3);font-size:var(--fs-sm)' }, ['実行中…']));
    try {
      const res = await opts.run();
      clear(result);
      result.append(
        countLine(res.counts),
        ...(res.listUrl ? [el('div', { style: 'margin-bottom:var(--s-3)' }, [
          el('a', { href: res.listUrl, target: '_blank', rel: 'noopener noreferrer',
            style: 'color:var(--accent-strong);font-size:var(--fs-sm)' }, ['リストを開く']),
        ])] : []),
        el('div', {
          style: 'max-height:16em;overflow:auto;border:1px solid var(--line);border-radius:var(--r-2);padding:var(--s-3) var(--s-4);background:var(--paper)',
        }, res.steps.map(stepRow)),
      );
      toast(root, res.counts.failed
        ? `リスト整形: 失敗 ${res.counts.failed} 件（詳細は設定画面）`
        : `リストを整形しました（作成 ${res.counts.created} / 更新 ${res.counts.updated}）`,
        res.counts.failed ? 'warn' : 'ok', 8000);
    } catch (e) {
      clear(result);
      result.appendChild(el('div', { class: 'mikke-error' }, [`実行に失敗しました: ${(e as Error).message}`]));
    } finally {
      runBtn.removeAttribute('disabled');
    }
  };

  const body = el('div', {}, [
    panelHead(opts.title, opts.description),
    el('ul', { style: 'margin:0 0 var(--s-5);padding-left:1.2em;font-size:var(--fs-sm);color:var(--ink-2);line-height:1.8' },
      opts.bullets.map((b) => el('li', {}, [b]))),
    runBtn,
    result,
  ]);
  return { body };
}

function renderVulnResponsePanel(root: HTMLElement): SettingPanel {
  return renderListSetupPanel(root, {
    title: '資産管理者への連携用リスト',
    description:
      'Mikke の管理表とは別に、資産管理者に対応状況を記入してもらう SharePoint リスト (MikkeVulnResponse) を作成・整形します。'
      + '脆弱性情報はフォーム上部にカードで読み取り専用表示し、本体は対応状況の入力欄だけになります。',
    bullets: [
      '何度実行しても同じ状態になります（既にある列や設定はスキップ）。',
      '列の内部名は英語のまま、表示名だけ日本語にします。',
      '脆弱性情報の列は新規フォームでのみ入力でき、登録後は読み取り専用になります。',
      'フォームの書式設定は上書きされます。SharePoint 側で手を入れている場合は注意してください。',
      'Mikke の管理表 (MikkeManagedIssues) には影響しません。',
    ],
    run: () => getRepo().ensureVulnResponseList(),
  });
}

function renderOverseasResponsePanel(root: HTMLElement): SettingPanel {
  return renderListSetupPanel(root, {
    title: '海外拠点への連携用リスト',
    description:
      '海外脆弱性一覧を渡すための SharePoint リスト (MikkeOverseasResponse) を作成・整形します。'
      + '国内の連携用リストとは別のリストで、記入欄はありません（読み取り専用）。'
      + '脆弱性情報と資産情報を 2 段組のカードで表示します。',
    bullets: [
      '何度実行しても同じ状態になります（既にある列や設定はスキップ）。',
      '記入してもらう欄はありません。フォームはカード表示だけになります。',
      'リストからの取り込み（逆方向）はありません。海外脆弱性一覧の内容が一方的に反映されます。',
      'アイテムのアクセス権は国内と同じ設定（アクセス権画面の事業会社の割当・管理者グループ）を使います。',
      '反映は「海外脆弱性一覧」画面の「連携リストへ反映(全件 / 選択)」から行います。',
    ],
    run: () => getRepo().ensureOverseasResponseList(),
  });
}

// ── 共通: 脆弱性タイプの判定条件 ──
//   Title に含まれる文字列で判定する (OR)。どれにも当たらなければ「脆弱性」。
async function renderVulnTypePanel(): Promise<SettingPanel> {
  const settings = await getRepo().getSettings();
  const rules = normalizeVulnTypeRules(settings.vulnTypeRules);
  const ta = (v: string[]): HTMLTextAreaElement => el('textarea', {
    class: 'mikke-input', rows: '6', spellcheck: 'false',
    style: 'width:100%;font-size:var(--fs-sm);line-height:1.7',
  }, [v.join('\n')]) as HTMLTextAreaElement;
  const portTa = ta(rules.port);
  const adminTa = ta(rules.admin);
  const parse = (t: string): string[] =>
    [...new Set(t.split(/\r?\n/).map((x) => x.trim()).filter(Boolean))];

  const body = el('div', {}, [
    panelHead('脆弱性タイプの判定',
      'Title に含まれる文字列で「ポート」「管理画面」を判定します。1 行 1 条件で、いずれかに当てはまれば該当 (OR)。'
      + 'どちらにも当てはまらないものは「脆弱性」になります。'),
    el('ul', { style: 'margin:0 0 var(--s-5);padding-left:1.2em;font-size:var(--fs-sm);color:var(--ink-2);line-height:1.8' }, [
      el('li', {}, ['大文字・小文字は区別しません。']),
      el('li', {}, ['ポートと管理画面の両方に当てはまる場合は「ポート」になります。']),
      el('li', {}, ['判定はデータ移行の取込時に行います。']),
    ]),
    el('div', { class: 'mikke-field' }, [
      el('label', { class: 'mikke-field-label' }, ['「ポート」と判定する文字列 (1 行 1 件)']),
      portTa,
    ]),
    el('div', { class: 'mikke-field' }, [
      el('label', { class: 'mikke-field-label' }, ['「管理画面」と判定する文字列 (1 行 1 件)']),
      adminTa,
    ]),
  ]);
  return {
    body,
    save: async () => {
      await getRepo().saveSettings({
        ...settings,
        vulnTypeRules: { port: parse(portTa.value), admin: parse(adminTa.value) },
      });
    },
  };
}

// ── その他: 接続 ──
function renderConnectionPanel(root: HTMLElement): SettingPanel {
  let siteUrl = '';
  let relayBase = '';
  try { siteUrl = localStorage.getItem('mikke.selectedSiteUrl') || ''; } catch { /* noop */ }
  try { relayBase = localStorage.getItem('mikke.relay.base') || 'http://127.0.0.1:18120/mikke'; } catch { /* noop */ }
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
      toast(root, '中継サーバを更新しています… 再起動を待ちます（最大 1 分）', 'default', 8000);
      try {
        const res = await performRelayUpdate(ru.files, ru.source);
        setState({ relayUpdateAvailable: null });
        box.remove();
        if (res.relayBackUp) {
          toast(root, `中継サーバを更新しました${res.newVersion ? ` (v${res.newVersion})` : ''}。`, 'ok', 6000);
        } else {
          // ファイル置換は別プロセス (updater) が実施済み。応答が戻らないだけ。
          toast(root, '更新を送信しました。中継サーバの再起動に時間がかかっています。少し待ってから中継サーバの状態を確認してください。', 'warn', 10000);
        }
      } catch (e) {
        btn.removeAttribute('disabled');
        toast(root, `中継サーバの更新に失敗: ${(e as Error).message}`, 'error', 8000);
      }
    })());
    const box = el('div', { style: 'margin-top:var(--s-5);padding:var(--s-4);background:var(--accent-soft);border-radius:var(--r-2)' }, [
      el('div', { style: 'font-size:var(--fs-sm);color:var(--ink);margin-bottom:var(--s-3)' }, [
        `中継サーバの更新があります: v${ru.localVersion} → v${ru.remoteVersion}`,
      ]),
      el('div', { style: 'font-size:var(--fs-xs);color:var(--ink-3);margin-bottom:var(--s-3);line-height:1.6' }, [
        ru.source === 'bundle'
          ? 'この Mikke に同梱されている最新スクリプトを送信し、自動で入れ替え＆再起動します。'
          : ru.source === 'relay'
            ? '中継サーバのフォルダにある最新スクリプトを取得して送信し、自動で入れ替え＆再起動します。'
            : 'SharePoint 上の最新スクリプトを取得して送信し、自動で入れ替え＆再起動します。',
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

// ── その他: 更新履歴 (バンドル同梱のリリースノート) ──
function renderReleaseNotesPanel(): SettingPanel {
  const renderNote = (n: ReleaseNote): HTMLElement => {
    const head = el('div', { style: 'display:flex;flex-wrap:wrap;align-items:baseline;gap:var(--s-2);margin-bottom:var(--s-2)' }, [
      el('span', { style: 'font-weight:600;color:var(--ink);font-size:var(--fs-md)' }, [n.version]),
      el('span', { style: 'font-size:var(--fs-xs);color:var(--ink-3)' }, [n.date]),
      ...(n.breaking ? [el('span', { class: 'mikke-badge mikke-badge--danger', style: 'font-size:11px' }, ['破壊的変更'])] : []),
      ...(n.title ? [el('span', { style: 'flex:1;min-width:0;color:var(--ink-2);font-size:var(--fs-sm)' }, [n.title])] : []),
    ]);
    const items = n.changes.map((c) => el('li', { style: 'margin:0 0 var(--s-1);line-height:1.65' }, [c]));
    const meta = n.relayMin
      ? [el('div', { style: 'font-size:var(--fs-xs);color:var(--ink-3);margin-top:var(--s-2)' }, [`（推奨 relay: v${n.relayMin} 以降）`])]
      : [];
    return el('article', {
      style: 'background:var(--paper);border:1px solid var(--line);border-radius:var(--r-2);padding:var(--s-4) var(--s-5);margin-bottom:var(--s-3)',
    }, [head, el('ul', { style: 'margin:0;padding-left:1.2em;font-size:var(--fs-sm);color:var(--ink)' }, items), ...meta]);
  };

  const body = el('div', {}, [
    panelHead('更新履歴', 'リリースごとの更新内容です（最新が一番上）。新しいバージョンに更新すると、ここに変更点が追加されます。'),
    el('div', { style: 'font-size:var(--fs-xs);color:var(--ink-3);margin-bottom:var(--s-4)' }, [
      `現在の起動 build: ${currentBuildId() || '(不明)'}`,
    ]),
    ...RELEASE_NOTES.map(renderNote),
  ]);
  return { body };
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
