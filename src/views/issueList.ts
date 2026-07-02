// F4: 管理対象脆弱性の一覧画面。subbar → toolbar → table の順 (UI ルール §1.2)。
// QAM 参考: 列ヘッダクリックの Excel 風フィルタ / 全文表示トグル / 仮想スクロール。
import { el, clear, fmtDate } from '../utils/dom';
import { icon } from '../icons';
import { getState, setState, setFilter } from '../state';
import { getRepo } from '../api/repo';
import { isUndetected, nextDetectionWhenPresent, nextDetectionWhenAbsent } from '../lib/detection';
import { detectionBadge, mgmtBadge, severityBadge } from './badges';
import { resolveScanValue } from '../lib/scanName';
import { relayHealth, relayGetIssue } from '../api/relay';
import { openModal } from '../components/modal';
import { toast } from '../components/toast';
import type { ManagedIssue } from '../types';

type SortKey = 'title' | 'detection' | 'mgmt' | 'severity' | 'assignee' | 'due' | 'synced';

const SEVERITY_ORDER: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1, info: 0 };
const DETECTION_ORDER: Record<string, number> = { '新規': 5, '再検知': 4, '継続': 3, '未検出(New)': 2, '未検出': 1 };
const MGMT_ORDER: Record<string, number> = {
  '未通知': 7, '通知': 6, '対応中': 5, '対応済み': 4, 'リスク受容': 3, '過検出': 2, '対象外': 1,
};

// 仮想スクロール: この行数を超えたら仮想化。VBUF=上下バッファ行数。
const VIRT_MIN = 40;
const VBUF = 12;
const ROW_H_DEFAULT = 40;

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

// ── 列フィルタ (Excel 風・除外セット方式。端末ローカルに永続化) ────────────────
const COL_FILTER_KEY = 'mikke.colFilters';
function loadColFilters(): Record<string, string[]> {
  try {
    const j = JSON.parse(localStorage.getItem(COL_FILTER_KEY) || '{}') as Record<string, unknown>;
    const out: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(j)) if (Array.isArray(v)) out[k] = v.filter((x): x is string => typeof x === 'string');
    return out;
  } catch { return {}; }
}
function saveColFilters(f: Record<string, string[]>): void {
  try { localStorage.setItem(COL_FILTER_KEY, JSON.stringify(f)); } catch { /* noop */ }
}

// ── 全文表示 (折り返し) トグル ────────────────────────────────────────────────
const WRAP_KEY = 'mikke.wrap';
function loadWrap(): boolean { try { return localStorage.getItem(WRAP_KEY) === '1'; } catch { return false; } }
function saveWrap(on: boolean): void { try { localStorage.setItem(WRAP_KEY, on ? '1' : '0'); } catch { /* noop */ } }

interface Col {
  id: string;
  label: string;
  sortKey?: SortKey;
  width: number;
  text: (i: ManagedIssue) => string;
  render: (i: ManagedIssue) => HTMLElement | string;
  cellStyle?: string;
}

export function renderIssueList(rootEl: HTMLElement): HTMLElement {
  const root = el('div', { class: 'mikke-main', style: 'display:flex;flex-direction:column' });
  const subbar = el('div', { class: 'mikke-subbar' });
  const toolbar = el('div', { class: 'mikke-toolbar' });
  const tableWrap = el('div', { class: 'mikke-table-wrap' });
  root.append(subbar, toolbar, tableWrap);

  let scanCols: string[] = [];
  let csvHeaders: string[] = [];
  let cache: ManagedIssue[] = [];
  let lastFiltered: ManagedIssue[] = [];
  let menuBaseRows: ManagedIssue[] = [];
  const selected = new Set<number>();
  const colWidths = loadColWidths();
  const colExcluded = loadColFilters();
  let wrapOn = loadWrap();
  let bulkBusy = false;
  let headCheck: HTMLInputElement | null = null;

  // ── 仮想スクロール状態 ──────────────────────────────────────────────────────
  let vWin: ManagedIssue[] = [];
  let vCols: Col[] = [];
  let vRowH = ROW_H_DEFAULT;
  let vVirtual = false;
  let vTop: HTMLElement | null = null;
  let vBot: HTMLElement | null = null;
  let vTbody: HTMLElement | null = null;
  let vLastStart = -1;
  let rafPending = false;
  tableWrap.addEventListener('scroll', () => {
    if (!vVirtual) return;
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      const start = Math.max(0, Math.floor(tableWrap.scrollTop / vRowH) - VBUF);
      if (start !== vLastStart) paintWindow();
    });
  });

  void load();

  async function load(): Promise<void> {
    clear(tableWrap);
    tableWrap.appendChild(el('div', { class: 'mikke-empty' }, ['読み込み中…']));
    try {
      const [all, settings] = await Promise.all([getRepo().listIssues(), getRepo().getSettings()]);
      scanCols = settings.managedColumns.map((c) => (c.startsWith('Scan_') ? c : `Scan_${c}`));
      csvHeaders = settings.lastCsvHeaders ?? [];
      cache = all;
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

  // ── 列定義 ──────────────────────────────────────────────────────────────────
  function buildColumns(): Col[] {
    const cols: Col[] = [
      { id: 'title', label: 'Issue', sortKey: 'title', width: 260,
        text: (i) => i.title ?? '', render: (i) => i.title || '(無題)' },
      { id: 'detection', label: '検知', sortKey: 'detection', width: 96,
        text: (i) => i.detectionStatus, render: (i) => detectionBadge(i.detectionStatus) },
      { id: 'mgmt', label: '対応', sortKey: 'mgmt', width: 96,
        text: (i) => i.mgmtStatus, render: (i) => mgmtBadge(i.mgmtStatus) },
      { id: 'severity', label: '深刻度', sortKey: 'severity', width: 92,
        text: (i) => i.severity ?? '', render: (i) => severityBadge(i.severity) },
      { id: 'assignee', label: '担当', sortKey: 'assignee', width: 120,
        text: (i) => i.assignee ?? '', render: (i) => i.assignee || '—' },
      { id: 'due', label: '期限', sortKey: 'due', width: 108,
        text: (i) => fmtDate(i.dueDate, false) || '', render: (i) => fmtDate(i.dueDate, false) || '—' },
    ];
    for (const c of scanCols) {
      cols.push({
        id: `scan:${c}`, label: c.replace(/^Scan_/, ''), width: 160,
        text: (i) => resolveScanValue(i.scanFields, c, csvHeaders) || '',
        render: (i) => resolveScanValue(i.scanFields, c, csvHeaders) || '—',
        cellStyle: 'color:var(--ink-2)',
      });
    }
    cols.push({ id: 'synced', label: '最終同期', sortKey: 'synced', width: 150,
      text: (i) => fmtDate(i.lastSyncedAt) || '', render: (i) => fmtDate(i.lastSyncedAt) || '—',
      cellStyle: 'color:var(--ink-3)' });
    return cols;
  }

  // ── フィルタ・ソート ──────────────────────────────────────────────────────────
  /** 既定の非表示 (対象外/過検出/未検出) + 検索。列フィルタとは独立。 */
  function baseFilter(all: ManagedIssue[]): ManagedIssue[] {
    const f = getState().filter;
    const q = f.query ? f.query.toLowerCase() : '';
    return all.filter((i) => {
      if (!f.showHidden) {
        if (i.isOutOfScope) return false;
        if (i.mgmtStatus === '過検出' || i.mgmtStatus === '対象外') return false;
        if (isUndetected(i.detectionStatus)) return false;
      }
      if (q) {
        const hay = `${i.title} ${i.issueInstanceId} ${i.assignee ?? ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }

  /** 列フィルタ (除外セット): 各列の除外値に一致する行を隠す (列間 AND)。 */
  function colFilter(rows: ManagedIssue[], columns: Col[]): ManagedIssue[] {
    const active = columns.filter((c) => (colExcluded[c.id]?.length ?? 0) > 0);
    if (!active.length) return rows;
    return rows.filter((i) => !active.some((c) => colExcluded[c.id]!.includes(c.text(i))));
  }

  function applySort(rows: ManagedIssue[]): ManagedIssue[] {
    const { sortBy, sortDir } = getState();
    if (!sortBy) return rows;
    const dir = sortDir === 'asc' ? 1 : -1;
    const key = (i: ManagedIssue): number | string => {
      switch (sortBy as SortKey) {
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

  function setSort(k: SortKey, dir: 'asc' | 'desc'): void {
    setState({ sortBy: k, sortDir: dir }, { silent: true });
    paint();
  }

  // ── 列幅リサイズ ──────────────────────────────────────────────────────────
  function attachColResize(th: HTMLElement, key: string, table: HTMLTableElement): void {
    const grip = el('span', { class: 'mikke-col-grip', 'aria-hidden': 'true' });
    grip.addEventListener('click', (e) => e.stopPropagation());
    grip.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const startX = e.clientX;
      const startW = th.getBoundingClientRect().width;
      const startTableW = table.getBoundingClientRect().width;
      const move = (ev: PointerEvent): void => {
        const w = Math.max(48, Math.round(startW + (ev.clientX - startX)));
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

  /** 常に table-layout:fixed + 明示幅にする (仮想スクロールで列幅を安定させる)。 */
  function applyWidths(table: HTMLTableElement, ths: { th: HTMLElement; key: string; width: number }[]): void {
    let total = 0;
    for (const { th, key, width } of ths) {
      const w = colWidths[key] ?? width;
      th.style.width = `${w}px`;
      total += w;
    }
    table.style.tableLayout = 'fixed';
    table.style.width = `${total}px`;
  }

  // ── 列メニュー (並べ替え + Excel 風の値フィルタ) ──────────────────────────────
  let openMenu: HTMLElement | null = null;
  let openMenuCol: string | null = null;
  let menuDocHandler: ((e: MouseEvent) => void) | null = null;
  function closeMenu(): void {
    if (menuDocHandler) { document.removeEventListener('mousedown', menuDocHandler); menuDocHandler = null; }
    if (openMenu) { openMenu.remove(); openMenu = null; }
    openMenuCol = null;
  }

  function openColMenu(th: HTMLElement, col: Col): void {
    if (openMenuCol === col.id) { closeMenu(); return; }
    closeMenu();
    openMenuCol = col.id;
    const rect = th.getBoundingClientRect();
    const ex = new Set(colExcluded[col.id] ?? []);
    const values = [...new Set(menuBaseRows.map((r) => col.text(r)))].sort((a, b) => a.localeCompare(b));
    const capped = values.slice(0, 2000);

    const menu = el('div', { class: 'mikke-colmenu' });
    // 並べ替え
    if (col.sortKey) {
      const sk = col.sortKey;
      menu.append(
        el('button', { class: 'mikke-colmenu-act', onclick: () => { closeMenu(); setSort(sk, 'asc'); } },
          [el('span', { html: icon('chevronDown'), style: 'display:inline-flex;transform:rotate(180deg)' }), el('span', {}, ['昇順で並べ替え'])]),
        el('button', { class: 'mikke-colmenu-act', onclick: () => { closeMenu(); setSort(sk, 'desc'); } },
          [el('span', { html: icon('chevronDown'), style: 'display:inline-flex' }), el('span', {}, ['降順で並べ替え'])]),
        el('div', { class: 'mikke-colmenu-sep' }),
      );
    }
    const search = el('input', { class: 'mikke-colmenu-search', type: 'text', placeholder: '値を検索' }) as HTMLInputElement;
    const allCb = el('input', { type: 'checkbox' }) as HTMLInputElement;
    const listWrap = el('div', { class: 'mikke-colmenu-vlist' });
    if (values.length > 2000) menu.appendChild(el('div', { class: 'mikke-colmenu-note' }, [`値が多いため先頭 2000 件のみ表示 (全 ${values.length} 件)`]));

    const apply = (): void => {
      const arr = [...ex];
      if (arr.length) colExcluded[col.id] = arr; else delete colExcluded[col.id];
      saveColFilters(colExcluded);
      paint();
    };
    const label = (v: string): string => (v === '' ? '(空白)' : v);
    const renderList = (q: string): void => {
      const scroll = listWrap.scrollTop;
      clear(listWrap);
      const ql = q.trim().toLowerCase();
      const shown = capped.filter((v) => !ql || label(v).toLowerCase().includes(ql));
      allCb.checked = shown.length > 0 && shown.every((v) => !ex.has(v));
      allCb.indeterminate = shown.some((v) => !ex.has(v)) && shown.some((v) => ex.has(v));
      for (const v of shown) {
        const cb = el('input', { type: 'checkbox' }) as HTMLInputElement;
        cb.checked = !ex.has(v);
        cb.addEventListener('change', () => { if (cb.checked) ex.delete(v); else ex.add(v); apply(); renderList(search.value); });
        listWrap.appendChild(el('label', { class: 'mikke-colmenu-item' }, [cb, el('span', {}, [label(v)])]));
      }
      listWrap.scrollTop = scroll;
    };
    allCb.addEventListener('change', () => {
      const ql = search.value.trim().toLowerCase();
      const shown = capped.filter((v) => !ql || label(v).toLowerCase().includes(ql));
      if (allCb.checked) shown.forEach((v) => ex.delete(v)); else shown.forEach((v) => ex.add(v));
      apply(); renderList(search.value);
    });
    search.addEventListener('input', () => renderList(search.value));
    search.addEventListener('keydown', (e) => { if ((e as KeyboardEvent).key === 'Enter') closeMenu(); });

    menu.append(
      search,
      el('div', { class: 'mikke-colmenu-vlist', style: 'flex:0 0 auto;overflow:visible;padding-bottom:0' }, [
        el('label', { class: 'mikke-colmenu-item mikke-colmenu-all' }, [allCb, el('span', {}, ['(すべて選択)'])]),
      ]),
      listWrap,
    );
    renderList('');

    // 位置決め (画面内にクランプ)
    const width = 260;
    const left = Math.max(6, Math.min(rect.left, window.innerWidth - width - 6));
    const top = Math.min(rect.bottom + 2, window.innerHeight - 120);
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    menu.addEventListener('mousedown', (e) => e.stopPropagation());
    rootEl.appendChild(menu);
    openMenu = menu;
    menuDocHandler = (): void => closeMenu();
    setTimeout(() => document.addEventListener('mousedown', menuDocHandler!), 0);
  }

  // ── subbar ────────────────────────────────────────────────────────────────
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
        class: 'mikke-btn mikke-btn--danger',
        style: 'height:28px;padding:0 var(--s-5);font-size:var(--fs-sm)',
        ...(bulkBusy ? { disabled: 'disabled' } : {}),
        onclick: () => bulkDelete(),
      }, ['削除']),
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

  // ── 一括アクション ────────────────────────────────────────────────────────
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

  function bulkDelete(): void {
    const ids = [...selected];
    if (!ids.length) return;
    const body = el('div', { style: 'line-height:1.7' }, [
      `選択中の ${ids.length} 件をリストから完全に削除します。`,
      el('br'),
      el('span', { style: 'color:var(--danger)' }, ['検知履歴・管理情報も含めて元に戻せません。']),
      el('br'),
      'データを残したまま一覧から隠す場合は「管理対象から除外」を使ってください。',
    ]);
    openModal(rootEl, {
      title: '完全に削除',
      body,
      primaryLabel: `削除する (${ids.length} 件)`,
      primaryVariant: 'danger',
      onPrimary: async () => {
        let ok = 0, fail = 0;
        for (const id of ids) {
          try { await getRepo().deleteIssue(id); ok++; } catch { fail++; }
        }
        toast(rootEl, `削除: ${ok} 件${fail ? ` / 失敗 ${fail} 件` : ''}`, fail ? 'warn' : 'ok');
        selected.clear();
        await load();
      },
    });
  }

  async function bulkRefresh(btn: HTMLElement): Promise<void> {
    const ids = [...selected];
    if (!ids.length || bulkBusy) return;
    const h = await relayHealth();
    if (!h.ok) {
      toast(rootEl, '中継サーバが起動していません。mikke-launch.bat を実行してください。', 'warn');
      return;
    }
    bulkBusy = true;
    updateSubbar();
    let ok = 0, fail = 0;
    let firstErr = '';
    try {
      for (let n = 0; n < ids.length; n++) {
        const issue = cache.find((i) => i.id === ids[n]);
        if (!issue) { fail++; continue; }
        const liveBtn = subbar.querySelector('.mikke-btn--primary');
        if (liveBtn) liveBtn.innerHTML = `${icon('sync')}<span>更新中 ${n + 1}/${ids.length}…</span>`;
        try {
          const res = await relayGetIssue(issue.issueInstanceId);
          const patch: Partial<ManagedIssue> = {
            scannerStatus: res.scannerStatus,
            severity: res.severity,
            lastSeen: res.lastSeen,
            lastSyncedAt: new Date().toISOString(),
            scanFields: { ...issue.scanFields, ...(res.scanFields ?? {}) },
          };
          if (res.detected === true) {
            patch.detectionStatus = nextDetectionWhenPresent(issue.detectionStatus);
          } else if (res.detected === false) {
            const nd = nextDetectionWhenAbsent(issue.detectionStatus);
            patch.detectionStatus = nd;
            if (nd === '未検出(New)' && !issue.firstUndetectedAt) {
              patch.firstUndetectedAt = new Date().toISOString();
            }
          }
          await getRepo().updateIssue(issue.id, patch);
          ok++;
        } catch (e) {
          fail++;
          const msg = (e as Error).message;
          if (!firstErr) firstErr = msg;
          if (/未配置|未実装|adapter/i.test(msg)) break;
        }
      }
    } finally {
      bulkBusy = false;
    }
    if (fail) toast(rootEl, `情報更新: ${ok} 件成功 / ${fail} 件失敗 — ${firstErr}`, 'error');
    else toast(rootEl, `情報更新: ${ok} 件を更新しました`, 'ok');
    await load();
    void btn;
  }

  // ── 行 DOM ────────────────────────────────────────────────────────────────
  function buildRow(i: ManagedIssue, columns: Col[]): HTMLElement {
    const rowCheck = el('input', { type: 'checkbox' }) as HTMLInputElement;
    rowCheck.checked = selected.has(i.id);
    rowCheck.addEventListener('change', () => {
      rowCheck.checked ? selected.add(i.id) : selected.delete(i.id);
      updateHeadCheck();
      updateSubbar();
    });
    const cells: HTMLElement[] = [
      el('td', { class: 'mikke-check-col', onclick: (e: Event) => e.stopPropagation() }, [rowCheck]),
    ];
    for (const col of columns) {
      cells.push(el('td', col.cellStyle ? { style: col.cellStyle } : {}, [col.render(i)]));
    }
    return el('tr', {
      class: 'mikke-drow' + (getState().selectedIssueId === i.id ? ' is-selected' : ''),
      onclick: () => {
        const sel = window.getSelection();
        if (sel && sel.toString()) return;
        openDetail(i.id);
      },
    }, cells);
  }

  // ── 仮想スクロール描画 ──────────────────────────────────────────────────────
  function windowRange(): [number, number] {
    const n = vWin.length;
    const vh = tableWrap.clientHeight || window.innerHeight || 800;
    let start = Math.floor(tableWrap.scrollTop / vRowH) - VBUF;
    if (start < 0) start = 0;
    let end = start + Math.ceil(vh / vRowH) + VBUF * 2;
    if (end > n) end = n;
    return [start, end];
  }
  function paintWindow(): void {
    if (!vTbody || !vTop || !vBot) return;
    const [start, end] = windowRange();
    vLastStart = start;
    (vTop.firstElementChild as HTMLElement).style.height = `${start * vRowH}px`;
    (vBot.firstElementChild as HTMLElement).style.height = `${(vWin.length - end) * vRowH}px`;
    let node = vTop.nextSibling;
    while (node && node !== vBot) { const next = node.nextSibling; vTbody.removeChild(node); node = next; }
    const frag = document.createDocumentFragment();
    for (let i = start; i < end; i++) frag.append(buildRow(vWin[i]!, vCols));
    vTbody.insertBefore(frag, vBot);
  }

  // ── 描画 ────────────────────────────────────────────────────────────────────
  function paint(): void {
    const columns = buildColumns();
    menuBaseRows = baseFilter(cache);
    const filtered = applySort(colFilter(menuBaseRows, columns));
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
    const wrapBtn = el('button', {
      class: wrapOn ? 'mikke-btn mikke-btn--primary' : 'mikke-btn mikke-btn--secondary',
      style: 'height:30px;font-size:var(--fs-sm)', title: '列幅で折り返して全文表示',
      onclick: () => { wrapOn = !wrapOn; saveWrap(wrapOn); paint(); },
    }, ['全文表示']);
    const hasColFilter = Object.values(colExcluded).some((a) => a.length);
    const clearBtn = (hasColFilter || f.query)
      ? el('button', {
          class: 'mikke-btn mikke-btn--ghost', style: 'height:30px;font-size:var(--fs-sm)',
          onclick: () => {
            for (const k of Object.keys(colExcluded)) delete colExcluded[k];
            saveColFilters(colExcluded);
            setFilter({ query: '' }, { silent: true });
            paint();
          },
        }, ['フィルタ解除'])
      : null;
    const hiddenToggle = el('label', {
      style: 'display:inline-flex;align-items:center;gap:6px;font-size:var(--fs-sm);color:var(--ink-3);cursor:pointer;margin-left:auto',
    }, [
      el('input', {
        type: 'checkbox', ...(f.showHidden ? { checked: 'checked' } : {}),
        onchange: (e: Event) => { setFilter({ showHidden: (e.target as HTMLInputElement).checked }); },
      }),
      '対象外・過検出・未検出も表示',
    ]);
    toolbar.append(
      el('span', { html: icon('filter'), style: 'color:var(--ink-3);display:inline-flex' }),
      search, wrapBtn,
      ...(clearBtn ? [clearBtn] : []),
      hiddenToggle,
    );

    // table
    clear(tableWrap);
    closeMenu();
    vVirtual = false; vTop = vBot = vTbody = null;
    if (filtered.length === 0 && cache.length === 0) { headCheck = null; tableWrap.appendChild(emptyState()); return; }

    headCheck = el('input', {
      type: 'checkbox', 'aria-label': '表示中の全行を選択',
      onchange: (e: Event) => {
        const on = (e.target as HTMLInputElement).checked;
        for (const i of lastFiltered) { on ? selected.add(i.id) : selected.delete(i.id); }
        paint();
      },
    }) as HTMLInputElement;

    const table = el('table', { class: 'mikke-table' + (wrapOn ? ' mikke-wrap' : '') }) as HTMLTableElement;
    const widthList: { th: HTMLElement; key: string; width: number }[] = [];
    const checkTh = el('th', { class: 'mikke-check-col' }, [headCheck]);
    widthList.push({ th: checkTh, key: '_check', width: 40 });
    const headCells: HTMLElement[] = [checkTh];
    const s = getState();
    for (const col of columns) {
      const activeSort = s.sortBy === col.sortKey;
      const arrow = activeSort ? (s.sortDir === 'asc' ? ' ▲' : ' ▼') : '';
      const hasFilter = (colExcluded[col.id]?.length ?? 0) > 0;
      const th = el('th', {
        title: 'クリックで並べ替え / 値で絞り込み',
        onclick: () => openColMenu(th, col),
      }, [
        col.label + arrow,
        el('span', { class: 'mikke-th-caret' + (hasFilter ? ' mikke-th-active' : ''), html: hasFilter ? icon('filter') : icon('chevronDown') }),
      ]);
      attachColResize(th, col.id, table);
      widthList.push({ th, key: col.id, width: col.width });
      headCells.push(th);
    }
    table.appendChild(el('thead', {}, [el('tr', {}, headCells)]));
    const tbody = el('tbody');

    vCols = columns; vWin = filtered; vTbody = tbody;
    vVirtual = filtered.length > VIRT_MIN && !wrapOn;
    if (!vVirtual) {
      for (const i of filtered) tbody.appendChild(buildRow(i, columns));
    } else {
      const colspan = String(columns.length + 1);
      vTop = el('tr', { class: 'mikke-vspacer' }, [el('td', { colspan }, [el('div', {})])]);
      vBot = el('tr', { class: 'mikke-vspacer' }, [el('td', { colspan }, [el('div', {})])]);
      tbody.append(vTop, vBot);
      vLastStart = -1; vRowH = ROW_H_DEFAULT;
      paintWindow();
    }
    table.appendChild(tbody);
    tableWrap.appendChild(table);
    applyWidths(table, widthList);
    updateHeadCheck();

    if (filtered.length === 0) {
      tableWrap.appendChild(el('div', { class: 'mikke-empty', style: 'padding-top:var(--s-8)' }, [
        el('div', {}, ['条件に一致する行がありません（フィルタ解除で全件表示）。']),
      ]));
    }

    // 実行後に実行高を測って補正 (行の実測高で仮想スクロールを正確化)
    if (vVirtual) {
      requestAnimationFrame(() => {
        if (!vVirtual || !table.isConnected) return;
        const probe = tbody.querySelector('tr.mikke-drow') as HTMLElement | null;
        const h = probe?.offsetHeight ?? 0;
        if (h > 0 && Math.abs(h - vRowH) > 1) { vRowH = h; vLastStart = -1; paintWindow(); }
      });
    }
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
