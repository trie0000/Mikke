// F6/F7: 設定画面 (master-detail)。管理項目選択 / 管理対象条件 / 個別追加。
import { el, clear } from '../utils/dom';
import { toast } from '../components/toast';
import { getRepo } from '../api/repo';
import { CONDITION_OPS } from '../lib/conditions';
import type { MikkeSettings, ConditionRule, ConditionGroup } from '../types';

type Pane = 'columns' | 'conditions' | 'individual' | 'general';

export function renderSettingsView(rootEl: HTMLElement): HTMLElement {
  const wrap = el('div', { class: 'mikke-main' });
  wrap.appendChild(el('div', { class: 'mikke-subbar' }, [
    el('span', { class: 'mikke-subbar-title' }, ['設定']),
  ]));

  const layout = el('div', { class: 'mikke-settings', style: 'flex:1' });
  const nav = el('div', { class: 'mikke-settings-nav' });
  const detail = el('div', { class: 'mikke-settings-detail' });
  layout.append(nav, detail);
  wrap.appendChild(layout);

  let pane: Pane = 'columns';
  let settings: MikkeSettings | null = null;

  void load();

  async function load(): Promise<void> {
    settings = await getRepo().getSettings();
    paintNav();
    paintDetail();
  }

  function paintNav(): void {
    clear(nav);
    const items: { key: Pane; label: string }[] = [
      { key: 'columns', label: '管理項目の選択 (F6)' },
      { key: 'conditions', label: '管理対象条件 (F7)' },
      { key: 'individual', label: '個別追加 (Issue ID)' },
      { key: 'general', label: '一般 (サイト/中継/外観)' },
    ];
    for (const it of items) {
      nav.appendChild(el('div', {
        class: `mikke-nav-item${pane === it.key ? ' is-active' : ''}`,
        onclick: () => { pane = it.key; paintNav(); paintDetail(); },
      }, [it.label]));
    }
  }

  function paintDetail(): void {
    clear(detail);
    if (!settings) { detail.appendChild(el('div', {}, ['読み込み中…'])); return; }
    if (pane === 'columns') paintColumns();
    else if (pane === 'conditions') paintConditions();
    else if (pane === 'individual') paintIndividual();
    else paintGeneral();
  }

  // F6: 管理項目 (取込列) の選択
  function paintColumns(): void {
    const s = settings!;
    detail.append(
      el('h3', {}, ['管理項目の選択']),
      el('p', { style: 'color:var(--ink-3);font-size:var(--fs-sm)' }, [
        '一覧・詳細に表示する検査ツール CSV 列をチェックします。チェックを外した列のデータは保持され、再チェックで復活します（削除されません）。',
      ]),
    );
    // 既知列が無い場合の案内 (実際の列は取込時に検出)
    const known = s.managedColumns.length ? s.managedColumns : ['Scan_Asset', 'Scan_CVE'];
    const list = el('div', { style: 'margin-top:var(--s-5)' });
    for (const col of known) {
      list.appendChild(el('label', {
        style: 'display:flex;align-items:center;gap:8px;margin-bottom:6px',
      }, [
        el('input', { type: 'checkbox', ...(s.managedColumns.includes(col) ? { checked: 'checked' } : {}),
          onchange: (e: Event) => {
            const on = (e.target as HTMLInputElement).checked;
            s.managedColumns = on
              ? Array.from(new Set([...s.managedColumns, col]))
              : s.managedColumns.filter((c) => c !== col);
          },
        }),
        col,
      ]));
    }
    detail.append(list, saveBtn());
  }

  // F7: 管理対象条件 (AND/OR)
  function paintConditions(): void {
    const s = settings!;
    if (!s.matchConditions) s.matchConditions = { combinator: 'OR', rules: [] };
    const group = s.matchConditions;

    detail.append(
      el('h3', {}, ['管理対象条件']),
      el('p', { style: 'color:var(--ink-3);font-size:var(--fs-sm)' }, [
        'CSV 列に対する AND/OR 条件で管理対象を定義します。条件変更は次回取込から適用されます。',
      ]),
    );

    const combSel = el('select', {
      class: 'mikke-select',
      onchange: (e: Event) => { group.combinator = (e.target as HTMLSelectElement).value as 'AND' | 'OR'; },
    }, [
      el('option', { value: 'AND', ...(group.combinator === 'AND' ? { selected: 'selected' } : {}) }, ['すべて満たす (AND)']),
      el('option', { value: 'OR', ...(group.combinator === 'OR' ? { selected: 'selected' } : {}) }, ['いずれか満たす (OR)']),
    ]);
    detail.append(el('div', { style: 'margin:var(--s-5) 0' }, [combSel]));

    const rulesBox = el('div');
    detail.appendChild(rulesBox);

    function paintRules(): void {
      clear(rulesBox);
      group.rules.forEach((r, idx) => {
        if ((r as ConditionGroup).combinator) return; // ネストグループは骨組みでは省略
        const rule = r as ConditionRule;
        const row = el('div', { class: 'mikke-cond-row' }, [
          el('input', { class: 'mikke-input', style: 'border:1px solid var(--line)', placeholder: '列名 (CSV ヘッダ)',
            value: rule.field, oninput: (e: Event) => { rule.field = (e.target as HTMLInputElement).value; } }),
          el('select', { class: 'mikke-select', style: 'border:1px solid var(--line)',
            onchange: (e: Event) => { rule.op = (e.target as HTMLSelectElement).value as ConditionRule['op']; } },
            CONDITION_OPS.map((o) => el('option', { value: o.value, ...(o.value === rule.op ? { selected: 'selected' } : {}) }, [o.label]))),
          el('input', { class: 'mikke-input', style: 'border:1px solid var(--line)', placeholder: '値',
            value: rule.value, oninput: (e: Event) => { rule.value = (e.target as HTMLInputElement).value; } }),
          el('button', { class: 'mikke-iconbtn', 'aria-label': '削除',
            onclick: () => { group.rules.splice(idx, 1); paintRules(); }, html: '✕' }),
        ]);
        rulesBox.appendChild(row);
      });
    }
    paintRules();

    detail.append(
      el('button', { class: 'mikke-btn mikke-btn--secondary', style: 'margin-top:var(--s-3)',
        onclick: () => { group.rules.push({ field: '', op: 'equals', value: '' }); paintRules(); } }, ['+ 条件を追加']),
      saveBtn(),
    );
  }

  // 個別追加
  function paintIndividual(): void {
    const s = settings!;
    detail.append(
      el('h3', {}, ['個別追加 (Issue Instance ID)']),
      el('p', { style: 'color:var(--ink-3);font-size:var(--fs-sm)' }, [
        '条件に関係なく管理対象に加える Issue Instance ID を 1 行 1 件で入力します。',
      ]),
    );
    const ta = el('textarea', {
      style: 'width:100%;min-height:160px;margin-top:var(--s-4);padding:var(--s-3);border:1px solid var(--line-strong);border-radius:var(--r-2)',
      oninput: (e: Event) => {
        s.individualIds = (e.target as HTMLTextAreaElement).value.split('\n').map((x) => x.trim()).filter(Boolean);
      },
    }, [s.individualIds.join('\n')]);
    detail.append(ta, saveBtn());
  }

  function paintGeneral(): void {
    detail.append(
      el('h3', {}, ['一般設定']),
      el('p', { style: 'color:var(--ink-3);font-size:var(--fs-sm)' }, [
        'SP サイト切替・中継サーバ接続先・テーマは topbar から操作します。詳細設定は実装フェーズで追加します。',
      ]),
    );
  }

  function saveBtn(): HTMLElement {
    return el('div', { style: 'margin-top:var(--s-8);text-align:right' }, [
      el('button', {
        class: 'mikke-btn mikke-btn--primary',
        onclick: async () => {
          try { await getRepo().saveSettings(settings!); toast(rootEl, '設定を保存しました', 'ok'); }
          catch (e) { toast(rootEl, `保存に失敗しました: ${(e as Error).message}`, 'error'); }
        },
      }, ['保存']),
    ]);
  }

  return wrap;
}
