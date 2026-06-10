// F4: 管理対象脆弱性の一覧画面。subbar → toolbar → table の順 (UI ルール §1.2)。
import { el, clear, fmtDate } from '../utils/dom';
import { icon } from '../icons';
import { getState, setState, setFilter } from '../state';
import { getRepo } from '../api/repo';
import { isUndetected } from '../lib/detection';
import { detectionBadge, mgmtBadge, severityBadge } from './badges';
import { scanFieldName } from '../lib/scanName';
import { relayHealth, relayGetIssue } from '../api/relay';
import { openModal } from '../components/modal';
import { toast } from '../components/toast';
import { DETECTION_STATUSES, MGMT_STATUSES } from '../types';
import type { ManagedIssue } from '../types';

type SortKey = 'id' | 'title' | 'detection' | 'mgmt' | 'severity' | 'assignee' | 'due' | 'synced';

const SEVERITY_ORDER: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1, info: 0 };
const DETECTION_ORDER: Record<string, number> = { '新規': 5, '再検知': 4, '継続': 3, '未検出(New)': 2, '未検出': 1 };
const MGMT_ORDER: Record<string, number> = {
  '未通知': 7, '通知': 6, '対応中': 5, '対応済み': 4, 'リスク受容': 3, '過検出': 2, '対象外': 1,
};

// ── 列幅 (ドラッグでリサイズ・端末ローカルに永続化) ──────────────────────────
const COL_WIDTH_KEY = 'mikke.colWidths';
function loadColWidths(): Record<string, number> {
  try {
    const j = JSON.parse(localStorage.getItem(COL_WIDTH_KEY) || '{}') as Record<string, unknown>;
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(j)) if (typeof v === 'number' && v >= 40) out[k] = v;
    return out;
  } catch { return {}; }
}
function saveColWidths(w: Record<string, number>): void {
  try { localStorage.setItem(COL_WIDTH_KEY, JSON.stringify(w)); } catch { /* noop */ }
}

export function renderIssueList(rootEl: HTMLElement): HTMLElement {
  const root = el('div', { class: 'mikke-main', style: 'display:flex;flex-direction:column' });
  const subbar = el('div', { class: 'mikke-subbar' });
  const toolbar = el('div', { class: 'mikke-toolbar' });
  const tableWrap = el('div', { class: 'mikke-table-wrap' });
  root.append(subbar, toolbar, tableWrap);

  let scanCols: string[] = [];
  let cache: ManagedIssue[] = [];
  let lastFiltered: ManagedIssue[] = [];
  const selected = new Set<number>();
  const colWidths = loadColWidths();
  let bulkBusy = false;
  let headCheck: HTMLInputElement | null = null;

  void load();

  async function load(): Promise<void> {
    clear(tableWrap);
    tableWrap.appendChild(el('div', { class: 'mikke-empty' }, ['読み込み中…']));
    try {
      const [all, settings] = await Promise.all([getRepo().listIssues(), getRepo().getSettings()]);
      scanCols = settings.managedColumns.map((c) => (c.startsWith('Scan_') ? c : `Scan_${c}`));
      cache = all;
      // 既に存在しない id は選択から除く
      const ids = new Set(all.map((i) => i.id));
      for (const id of [...selected]) if (!ids.has(id)) selected.delete(id);
      setState({ issueCount: all.length }, { silent: true });
      paint();
    } catch (e) {
      clear(tableWrap);
      tableWrap.appendChild(el('div', { class: 'mikke-error' }, [
        `一覧の取得に失敗しました: ${(e as Error).message}`,
      ]));
    }
  }

  function applyFilter(all: ManagedIssue[]): ManagedIssue[] {
    const f = getState().filter;
    return all.filter((i) => {
      if (!f.showHidden) {
        if (i.isOutOfScope) return false;
        if (i.mgmtStatus === '過検出' || i.mgmtStatus === '対象外') return false;
        if (isUndetected(i.detectionStatus)) return false;
      }
      if (f.detection.length && !f.detection.includes(i.detectionStatus)) return false;
      if (f.mgmt.length && !f.mgmt.includes(i.mgmtStatus)) return false;
      if (f.severity.length && !f.severity.includes(i.severity ?? '')) return false;
      if (f.query) {
        const q = f.query.toLowerCase();
        const hay = `${i.title} ${i.issueInstanceId} ${i.assignee ?? ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }

  function applySort(rows: ManagedIssue[]): ManagedIssue[] {
    const { sortBy, sortDir } = getState();
    const dir = sortDir === 'asc' ? 1 : -1;
    const key = (i: ManagedIssue): number | string => {
      switch (sortBy as SortKey) {
        case 'id': return i.id;
        case 'title': return i.title ?? '';
        case 'detection': return DETECTION_ORDER[i.detectionStatus] ?? 0;
        case 'mgmt': return MGMT_ORDER[i.mgmtStatus] ?? 0;
        case 'severity': return SEVERITY_ORDER[(i.severity ?? '').toLowerCase()] ?? -1;
        case 'assignee': return i.assignee ?? '';
        case 'due': return i.dueDate ?? '';
        case 'synced': return i.lastSyncedAt ?? '';
        default: return i.id;
      }
    };
    return [...rows].sort((a, b) => {
      const ka = key(a), kb = key(b);
      if (ka < kb) return -1 * dir;
      if (ka > kb) return 1 * dir;
      return (a.id - b.id) * dir;
    });
  }

  function toggleSort(k: SortKey): void {
    const s = getState();
    if (s.sortBy === k) {
      setState({ sortDir: s.sortDir === 'asc' ? 'desc' : 'asc' }, { silent: true });
    } else {
      setState({ sortBy: k, sortDir: 'asc' }, { silent: true });
    }
    paint();
  }

  // ── 列幅リサイズ ──────────────────────────────────────────────────────────
  // th 右端のグリップを pointer ドラッグで列幅を変更。初回ドラッグ時に全列の
  // 実測幅を焼き込んで table-layout:fixed に切替え (以降は指定幅が効く)。
  function attachColResize(th: HTMLElement, key: string): void {
    const grip = el('span', { class: 'mikke-col-grip', 'aria-hidden': 'true' });
    grip.addEventListener('click', (e) => e.stopPropagation());   // ソート発火を抑止
    grip.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const table = th.closest('table') as HTMLTableElement | null;
      if (!table) return;
      const ths = [...table.querySelectorAll('th')] as HTMLElement[];
      if (table.style.tableLayout !== 'fixed') {
        // 現在の見た目を維持したまま fixed 化
        for (const t of ths) t.style.width = `${Math.round(t.getBoundingClientRect().width)}px`;
        table.style.tableLayout = 'fixed';
        table.style.width = `${Math.round(table.getBoundingClientRect().width)}px`;
      }
      const startX = e.clientX;
      const startW = th.getBoundingClientRect().width;
      const startTableW = table.getBoundingClientRect().width;
      const move = (ev: PointerEvent): void => {
        const dx = ev.clientX - startX;
        const w = Math.max(48, Math.round(startW + dx));
        th.style.width = `${w}px`;
        table.style.width = `${Math.round(startTableW + (w - startW))}px`;
      };
      const up = (): void => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        colWidths[key] = Math.round(th.getBoundingClientRect().width);
        saveColWidths(colWidths);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });
    th.appendChild(grip);
  }

  /** 保存済みの列幅を適用 (1 つでもあれば fixed レイアウトにする)。 */
  function applySavedWidths(table: HTMLTableElement, ths: { th: HTMLElement; key: string }[]): void {
    const hasSaved = ths.some(({ key }) => colWidths[key]);
    if (!hasSaved) return;
    // 実測してから fixed 化 (未保存列は現状幅を維持)
    requestAnimationFrame(() => {
      if (!table.isConnected) return;
      let total = 0;
      for (const { th, key } of ths) {
        const w = colWidths[key] ?? Math.round(th.getBoundingClientRect().width);
        th.style.width = `${w}px`;
        total += w;
      }
      table.style.tableLayout = 'fixed';
      table.style.width = `${total}px`;
    });
  }

  function sortableTh(label: string, k: SortKey): HTMLElement {
    const s = getState();
    const active = s.sortBy === k;
    const arrow = active ? (s.sortDir === 'asc' ? ' ▲' : ' ▼') : '';
    return el('th', {
      onclick: () => toggleSort(k),
      style: active ? 'color:var(--accent-strong)' : '',
    }, [label + arrow]);
  }

  /** 複数選択フィルタのドロップダウン (チェックボックス群)。 */
  function multiFilter(label: string, options: string[], selectedOpts: string[], onChange: (next: string[]) => void): HTMLElement {
    const count = selectedOpts.length;
    const btn = el('button', {
      class: 'mikke-btn mikke-btn--secondary',
      style: 'height:30px;font-size:var(--fs-sm)',
    }, [count ? `${label} (${count})` : label, el('span', { html: icon('chevronDown'), style: 'display:inline-flex;width:14px;margin-left:4px' })]);
    const menu = el('div', {
      style: 'position:absolute;z-index:10;margin-top:2px;background:var(--paper);border:1px solid var(--line);' +
        'border-radius:var(--r-2);box-shadow:var(--shadow-flyout);padding:var(--s-3);display:none;min-width:160px',
    });
    for (const opt of options) {
      menu.appendChild(el('label', { style: 'display:flex;align-items:center;gap:6px;padding:3px 0;cursor:pointer;font-size:var(--fs-sm)' }, [
        el('input', {
          type: 'checkbox', ...(selectedOpts.includes(opt) ? { checked: 'checked' } : {}),
          onchange: (e: Event) => {
            const on = (e.target as HTMLInputElement).checked;
            const next = on ? [...selectedOpts, opt] : selectedOpts.filter((x) => x !== opt);
            onChange(next);
          },
        }),
        opt || '(空)',
      ]));
    }
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
    });
    document.addEventListener('click', () => { menu.style.display = 'none'; }, { once: true });
    return el('div', { style: 'position:relative;display:inline-block' }, [btn, menu]);
  }

  // ── subbar (選択なし: タイトル+件数 / 選択あり: 件数+一括アクション) ─────────
  // §1.4: バーは常に同じ高さ。中身だけ入れ替える。
  function updateSubbar(): void {
    clear(subbar);
    const sel = selected.size;
    subbar.appendChild(el('span', { class: 'mikke-subbar-title' }, ['管理対象一覧']));
    if (sel === 0) {
      subbar.appendChild(el('span', { class: 'mikke-subbar-count' }, [`${lastFiltered.length} / ${cache.length} 件`]));
      return;
    }
    const refreshBtn = el('button', {
      class: 'mikke-btn mikke-btn--primary',
      style: 'height:28px;padding:0 var(--s-5);font-size:var(--fs-sm)',
      ...(bulkBusy ? { disabled: 'disabled' } : {}),
      onclick: () => void bulkRefresh(refreshBtn),
      html: icon('sync') + '<span>情報更新</span>',
    });
    subbar.append(
      el('span', { class: 'mikke-subbar-count', style: 'color:var(--accent-strong);font-weight:600' }, [`${sel} 件選択`]),
      refreshBtn,
      el('button', {
        class: 'mikke-btn mikke-btn--danger',
        style: 'height:28px;padding:0 var(--s-5);font-size:var(--fs-sm)',
        ...(bulkBusy ? { disabled: 'disabled' } : {}),
        onclick: () => bulkExclude(),
      }, ['管理対象から除外']),
      el('button', {
        class: 'mikke-btn mikke-btn--ghost',
        style: 'height:28px;padding:0 var(--s-4);font-size:var(--fs-sm)',
        ...(bulkBusy ? { disabled: 'disabled' } : {}),
        onclick: () => { selected.clear(); paint(); },
      }, ['選択解除']),
    );
  }

  function updateHeadCheck(): void {
    if (!headCheck) return;
    const total = lastFiltered.length;
    const sel = lastFiltered.filter((i) => selected.has(i.id)).length;
    headCheck.checked = total > 0 && sel === total;
    headCheck.indeterminate = sel > 0 && sel < total;
  }

  // ── 一括: 管理対象から除外 (理由入力付き確認モーダル) ────────────────────────
  function bulkExclude(): void {
    const ids = [...selected];
    if (!ids.length) return;
    const reasonTa = el('textarea', {
      placeholder: '除外の理由 (任意)',
      style: 'width:100%;min-height:80px;padding:var(--s-3);border:1px solid var(--line-strong);border-radius:var(--r-2)',
    }) as HTMLTextAreaElement;
    const body = el('div', {}, [
      el('p', { style: 'margin:0 0 var(--s-4);line-height:1.7' }, [
        `選択中の ${ids.length} 件を管理対象から除外します（対応ステータス=対象外）。`,
        el('br'),
        '一覧のデフォルト表示から隠れます（「対象外・過検出・未検出も表示」で再表示できます）。',
      ]),
      reasonTa,
    ]);
    openModal(rootEl, {
      title: '管理対象から除外',
      body,
      primaryLabel: `除外する (${ids.length} 件)`,
      primaryVariant: 'danger',
      onPrimary: async () => {
        const reason = reasonTa.value.trim() || '一括除外';
        let ok = 0, fail = 0;
        for (const id of ids) {
          try {
            await getRepo().updateIssue(id, { mgmtStatus: '対象外', isOutOfScope: true, outOfScopeReason: reason });
            ok++;
          } catch { fail++; }
        }
        toast(rootEl, `除外: ${ok} 件${fail ? ` / 失敗 ${fail} 件` : ''}`, fail ? 'warn' : 'ok');
        selected.clear();
        await load();
      },
    });
  }

  // ── 一括: 情報更新 (検査ツール API / F3 アダプタ経由) ─────────────────────────
  async function bulkRefresh(btn: HTMLElement): Promise<void> {
    const ids = [...selected];
    if (!ids.length || bulkBusy) return;
    const h = await relayHealth();
    if (!h.ok) {
      toast(rootEl, '中継サーバが起動していません。mikke-launch.bat を実行してください。', 'warn');
      return;
    }
    bulkBusy = true;
    updateSubbar();   // ボタンを disabled に
    let ok = 0, fail = 0;
    let firstErr = '';
    try {
      for (let n = 0; n < ids.length; n++) {
        const issue = cache.find((i) => i.id === ids[n]);
        if (!issue) { fail++; continue; }
        // 進捗をボタンラベルに表示 (再描画で消えないよう都度取得)
        const liveBtn = subbar.querySelector('.mikke-btn--primary');
        if (liveBtn) liveBtn.innerHTML = `${icon('sync')}<span>更新中 ${n + 1}/${ids.length}…</span>`;
        try {
          const res = await relayGetIssue(issue.issueInstanceId);
          await getRepo().updateIssue(issue.id, {
            scannerStatus: res.scannerStatus,
            severity: res.severity,
            lastSeen: res.lastSeen,
            lastSyncedAt: new Date().toISOString(),
            scanFields: { ...issue.scanFields, ...(res.scanFields ?? {}) },
          });
          ok++;
        } catch (e) {
          fail++;
          const msg = (e as Error).message;
          if (!firstErr) firstErr = msg;
          // アダプタ未配置/未実装なら全件失敗確定なので中断する
          if (/未配置|未実装|adapter/i.test(msg)) break;
        }
      }
    } finally {
      bulkBusy = false;
    }
    if (fail) {
      toast(rootEl, `情報更新: ${ok} 件成功 / ${fail} 件失敗 — ${firstErr}`, 'error');
    } else {
      toast(rootEl, `情報更新: ${ok} 件を更新しました`, 'ok');
    }
    await load();   // 選択は維持したまま再読込 (load 内で存在しない id は除去)
    void btn;
  }

  function paint(): void {
    const all = cache;
    const filtered = applySort(applyFilter(all));
    lastFiltered = filtered;
    const f = getState().filter;

    updateSubbar();

    // toolbar
    clear(toolbar);
    const search = el('input', {
      class: 'mikke-input', type: 'text', placeholder: 'タイトル / ID / 担当で検索',
      value: f.query, style: 'min-width:200px;border:1px solid var(--line)',
      oninput: (e: Event) => { setFilter({ query: (e.target as HTMLInputElement).value }, { silent: true }); paint(); },
    });
    // 深刻度の候補 (データに出現する値)
    const sevOptions = Array.from(new Set(all.map((i) => i.severity).filter((x): x is string => !!x)));
    const detectFilter = multiFilter('検知', DETECTION_STATUSES, f.detection, (next) => { setFilter({ detection: next }, { silent: true }); paint(); });
    const mgmtFilter = multiFilter('対応', MGMT_STATUSES, f.mgmt, (next) => { setFilter({ mgmt: next }, { silent: true }); paint(); });
    const sevFilter = multiFilter('深刻度', sevOptions, f.severity, (next) => { setFilter({ severity: next }, { silent: true }); paint(); });
    const hiddenToggle = el('label', {
      style: 'display:inline-flex;align-items:center;gap:6px;font-size:var(--fs-sm);color:var(--ink-3);cursor:pointer;margin-left:auto',
    }, [
      el('input', {
        type: 'checkbox', ...(f.showHidden ? { checked: 'checked' } : {}),
        onchange: (e: Event) => { setFilter({ showHidden: (e.target as HTMLInputElement).checked }); },
      }),
      '対象外・過検出・未検出も表示',
    ]);
    const clearBtn = (f.detection.length || f.mgmt.length || f.severity.length || f.query)
      ? el('button', { class: 'mikke-btn mikke-btn--ghost', style: 'height:30px;font-size:var(--fs-sm)',
          onclick: () => { setFilter({ detection: [], mgmt: [], severity: [], query: '' }); } }, ['クリア'])
      : null;
    toolbar.append(
      el('span', { html: icon('filter'), style: 'color:var(--ink-3);display:inline-flex' }),
      search, detectFilter, mgmtFilter, sevFilter,
      ...(clearBtn ? [clearBtn] : []),
      hiddenToggle,
    );

    // table
    clear(tableWrap);
    if (filtered.length === 0) {
      headCheck = null;
      tableWrap.appendChild(emptyState());
      return;
    }
    // ヘッダ: 全行選択チェックボックス (表示中=フィルタ後の行が対象)
    headCheck = el('input', {
      type: 'checkbox', 'aria-label': '表示中の全行を選択',
      onchange: (e: Event) => {
        const on = (e.target as HTMLInputElement).checked;
        for (const i of lastFiltered) { on ? selected.add(i.id) : selected.delete(i.id); }
        paint();
      },
    }) as HTMLInputElement;

    const thKeys: { th: HTMLElement; key: string }[] = [];
    const reg = (th: HTMLElement, key: string, resizable = true): HTMLElement => {
      if (resizable) attachColResize(th, key);
      thKeys.push({ th, key });
      return th;
    };
    const headCells = [
      reg(el('th', { class: 'mikke-check-col' }, [headCheck]), '_check', false),
      reg(sortableTh('Issue', 'title'), 'title'),
      reg(sortableTh('検知', 'detection'), 'detection'),
      reg(sortableTh('対応', 'mgmt'), 'mgmt'),
      reg(sortableTh('深刻度', 'severity'), 'severity'),
      reg(sortableTh('担当', 'assignee'), 'assignee'),
      reg(sortableTh('期限', 'due'), 'due'),
      ...scanCols.map((c) => reg(el('th', {}, [c.replace(/^Scan_/, '')]), `scan:${c}`)),
      reg(sortableTh('最終同期', 'synced'), 'synced'),
    ];
    const thead = el('thead', {}, [el('tr', {}, headCells)]);
    const tbody = el('tbody');
    for (const i of filtered) {
      const rowCheck = el('input', {
        type: 'checkbox', ...(selected.has(i.id) ? { checked: 'checked' } : {}),
        onchange: (e: Event) => {
          (e.target as HTMLInputElement).checked ? selected.add(i.id) : selected.delete(i.id);
          updateHeadCheck();
          updateSubbar();
        },
      });
      const row = el('tr', {
        ...(getState().selectedIssueId === i.id ? { class: 'is-selected' } : {}),
        onclick: () => openDetail(i.id),
      }, [
        el('td', { class: 'mikke-check-col', onclick: (e: Event) => e.stopPropagation() }, [rowCheck]),
        el('td', {}, [i.title || '(無題)']),
        el('td', {}, [detectionBadge(i.detectionStatus)]),
        el('td', {}, [mgmtBadge(i.mgmtStatus)]),
        el('td', {}, [severityBadge(i.severity)]),
        el('td', {}, [i.assignee || '—']),
        el('td', {}, [fmtDate(i.dueDate, false) || '—']),
        // SP は安全列名 (scanFieldName) キー、mock は元名キーで保持 → 両対応で引く
        ...scanCols.map((c) => el('td', {}, [i.scanFields?.[scanFieldName(c)] ?? i.scanFields?.[c] ?? '—'])),
        el('td', {}, [fmtDate(i.lastSyncedAt) || '—']),
      ]);
      tbody.appendChild(row);
    }
    const table = el('table', { class: 'mikke-table' }, [thead, tbody]) as HTMLTableElement;
    tableWrap.appendChild(table);
    updateHeadCheck();
    applySavedWidths(table, thKeys);
  }

  function emptyState(): HTMLElement {
    return el('div', { class: 'mikke-empty' }, [
      el('div', { class: 'mikke-empty-title' }, ['管理対象がありません']),
      el('div', {}, ['CSV を取り込むか、設定で管理対象条件を定義してください。']),
      el('div', { style: 'margin-top:var(--s-5)' }, [
        el('button', {
          class: 'mikke-btn mikke-btn--primary',
          onclick: () => setState({ view: 'import' }),
          html: icon('upload') + '<span>CSV を取込</span>',
        }),
      ]),
    ]);
  }

  function openDetail(id: number): void {
    const open = getState().openIssueIds;
    const next = open.includes(id) ? open : [...open, id];
    setState({ view: 'issues', selectedIssueId: id, openIssueIds: next });
  }

  return root;
}
