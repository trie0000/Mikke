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
    // 候補列: 直近取込 CSV のヘッダ。無ければ既存チェック済み列を表示。
    const headers = s.lastCsvHeaders ?? [];
    const checked = new Set(s.managedColumns.map((c) => c.replace(/^Scan_/, '')));
    const candidates = headers.length
      ? headers
      : Array.from(checked).length ? Array.from(checked) : [];

    if (!candidates.length) {
      detail.append(el('p', { class: 'mikke-empty', style: 'text-align:left;padding:var(--s-5) 0' }, [
        'まだ CSV を取り込んでいないため列候補がありません。先に「CSV 取込」を一度実行すると、ここに列が一覧表示されます。',
      ]));
      detail.append(saveBtn());
      return;
    }

    const list = el('div', { style: 'margin-top:var(--s-5);columns:2;max-width:600px' });
    for (const col of candidates) {
      list.appendChild(el('label', {
        style: 'display:flex;align-items:center;gap:8px;margin-bottom:6px;break-inside:avoid',
      }, [
        el('input', { type: 'checkbox', ...(checked.has(col) ? { checked: 'checked' } : {}),
          onchange: (e: Event) => {
            const on = (e.target as HTMLInputElement).checked;
            const scanName = `Scan_${col}`;
            s.managedColumns = on
              ? Array.from(new Set([...s.managedColumns, scanName]))
              : s.managedColumns.filter((c) => c !== scanName && c !== col);
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

    // CSV ヘッダ候補 (datalist でサジェスト)
    const headers = s.lastCsvHeaders ?? [];
    const dlId = 'mikke-csv-headers';
    const datalist = el('datalist', { id: dlId }, headers.map((h) => el('option', { value: h })));
    detail.appendChild(datalist);

    const rulesBox = el('div');
    detail.appendChild(rulesBox);

    // マッチ件数プレビュー (直近 CSV を取り込んでいれば概算を出す)。
    const previewLine = el('div', { style: 'margin-top:var(--s-4);font-size:var(--fs-sm);color:var(--ink-3)' });
    function updatePreview(): void {
      // 行データが手元にないため、件数の実測は取込時に行う。ここではルールの妥当性のみ表示。
      const valid = group.rules.filter((r) => !(r as ConditionGroup).combinator)
        .every((r) => (r as ConditionRule).field.trim() && (r as ConditionRule).value.trim());
      const n = group.rules.length;
      previewLine.textContent = n === 0
        ? '条件が未設定です（このままだと条件一致での自動追加は行われません）。'
        : `${n} 条件 / ${group.combinator}${valid ? '' : ' — ⚠ 未入力の条件があります'}`;
    }

    function paintRules(): void {
      clear(rulesBox);
      group.rules.forEach((r, idx) => {
        if ((r as ConditionGroup).combinator) return; // ネストグループは MVP では非対応
        const rule = r as ConditionRule;
        const row = el('div', { class: 'mikke-cond-row' }, [
          el('input', { class: 'mikke-input', list: dlId, style: 'border:1px solid var(--line)', placeholder: '列名 (CSV ヘッダ)',
            value: rule.field, oninput: (e: Event) => { rule.field = (e.target as HTMLInputElement).value; updatePreview(); } }),
          el('select', { class: 'mikke-select', style: 'border:1px solid var(--line)',
            onchange: (e: Event) => { rule.op = (e.target as HTMLSelectElement).value as ConditionRule['op']; } },
            CONDITION_OPS.map((o) => el('option', { value: o.value, ...(o.value === rule.op ? { selected: 'selected' } : {}) }, [o.label]))),
          el('input', { class: 'mikke-input', style: 'border:1px solid var(--line)', placeholder: '値',
            value: rule.value, oninput: (e: Event) => { rule.value = (e.target as HTMLInputElement).value; updatePreview(); } }),
          el('button', { class: 'mikke-iconbtn', 'aria-label': '削除',
            onclick: () => { group.rules.splice(idx, 1); paintRules(); updatePreview(); }, html: '✕' }),
        ]);
        rulesBox.appendChild(row);
      });
    }
    paintRules();
    updatePreview();

    detail.append(
      el('button', { class: 'mikke-btn mikke-btn--secondary', style: 'margin-top:var(--s-3)',
        onclick: () => { group.rules.push({ field: '', op: 'equals', value: '' }); paintRules(); updatePreview(); } }, ['+ 条件を追加']),
      previewLine,
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
