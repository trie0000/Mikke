// F4: 管理対象脆弱性の一覧画面。subbar → toolbar → table の順 (UI ルール §1.2)。
import { el, clear, fmtDate } from '../utils/dom';
import { icon } from '../icons';
import { getState, setState, setFilter } from '../state';
import { getRepo } from '../api/repo';
import { isUndetected } from '../lib/detection';
import { detectionBadge, mgmtBadge, severityBadge } from './badges';
import { scanFieldName } from '../lib/scanName';
import { DETECTION_STATUSES, MGMT_STATUSES } from '../types';
import type { ManagedIssue } from '../types';

type SortKey = 'id' | 'title' | 'detection' | 'mgmt' | 'severity' | 'assignee' | 'due' | 'synced';

const SEVERITY_ORDER: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1, info: 0 };
const DETECTION_ORDER: Record<string, number> = { '新規': 5, '再検知': 4, '継続': 3, '未検出(New)': 2, '未検出': 1 };
const MGMT_ORDER: Record<string, number> = {
  '未通知': 7, '通知': 6, '対応中': 5, '対応済み': 4, 'リスク受容': 3, '過検出': 2, '対象外': 1,
};

export function renderIssueList(): HTMLElement {
  const root = el('div', { class: 'mikke-main', style: 'display:flex;flex-direction:column' });
  const subbar = el('div', { class: 'mikke-subbar' });
  const toolbar = el('div', { class: 'mikke-toolbar' });
  const tableWrap = el('div', { class: 'mikke-table-wrap' });
  root.append(subbar, toolbar, tableWrap);

  let scanCols: string[] = [];
  let cache: ManagedIssue[] = [];

  void load();

  async function load(): Promise<void> {
    clear(tableWrap);
    tableWrap.appendChild(el('div', { class: 'mikke-empty' }, ['読み込み中…']));
    try {
      const [all, settings] = await Promise.all([getRepo().listIssues(), getRepo().getSettings()]);
      scanCols = settings.managedColumns.map((c) => (c.startsWith('Scan_') ? c : `Scan_${c}`));
      cache = all;
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
  function multiFilter(label: string, options: string[], selected: string[], onChange: (next: string[]) => void): HTMLElement {
    const count = selected.length;
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
          type: 'checkbox', ...(selected.includes(opt) ? { checked: 'checked' } : {}),
          onchange: (e: Event) => {
            const on = (e.target as HTMLInputElement).checked;
            const next = on ? [...selected, opt] : selected.filter((x) => x !== opt);
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

  function paint(): void {
    const all = cache;
    const filtered = applySort(applyFilter(all));
    const f = getState().filter;

    // subbar
    clear(subbar);
    subbar.append(
      el('span', { class: 'mikke-subbar-title' }, ['管理対象一覧']),
      el('span', { class: 'mikke-subbar-count' }, [`${filtered.length} / ${all.length} 件`]),
    );

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
      tableWrap.appendChild(emptyState());
      return;
    }
    const headCells = [
      el('th', { class: 'mikke-check-col' }, ['']),
      sortableTh('Issue', 'title'),
      sortableTh('検知', 'detection'),
      sortableTh('対応', 'mgmt'),
      sortableTh('深刻度', 'severity'),
      sortableTh('担当', 'assignee'),
      sortableTh('期限', 'due'),
      ...scanCols.map((c) => el('th', {}, [c.replace(/^Scan_/, '')])),
      sortableTh('最終同期', 'synced'),
    ];
    const thead = el('thead', {}, [el('tr', {}, headCells)]);
    const tbody = el('tbody');
    for (const i of filtered) {
      const row = el('tr', {
        ...(getState().selectedIssueId === i.id ? { class: 'is-selected' } : {}),
        onclick: () => openDetail(i.id),
      }, [
        el('td', { class: 'mikke-check-col', onclick: (e: Event) => e.stopPropagation() }, [
          el('input', { type: 'checkbox' }),
        ]),
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
    tableWrap.appendChild(el('table', { class: 'mikke-table' }, [thead, tbody]));
  }

  function emptyState(): HTMLElement {
    return el('div', { class: 'mikke-empty' }, [
      el('div', { class: 'mikke-empty-title' }, ['管理対象がありません']),
      el('div', {}, ['CSV を取り込むか、設定で管理対象条件を定義してください。']),
      el('div', { style: 'margin-top:var(--s-5)' }, [
        el('button', {
          class: 'mikke-btn mikke-btn--primary',
          onclick: () => setState({ view: 'import' }),
          html: icon('upload') + '<span style="margin-left:6px">CSV を取込</span>',
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
