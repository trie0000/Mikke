// F4: 管理対象脆弱性の一覧画面。subbar → toolbar → table の順 (UI ルール §1.2)。
import { el, clear, fmtDate } from '../utils/dom';
import { icon } from '../icons';
import { getState, setState, setFilter } from '../state';
import { getRepo } from '../api/repo';
import { isUndetected } from '../lib/detection';
import { detectionBadge, mgmtBadge, severityBadge } from './badges';
import type { ManagedIssue } from '../types';

export function renderIssueList(): HTMLElement {
  const root = el('div', { class: 'mikke-main', style: 'display:flex;flex-direction:column' });

  // subbar (バルクバーは常設してレイアウトシフトを防ぐ)
  const subbar = el('div', { class: 'mikke-subbar' });
  const toolbar = el('div', { class: 'mikke-toolbar' });
  const tableWrap = el('div', { class: 'mikke-table-wrap' });

  root.append(subbar, toolbar, tableWrap);

  void load();

  let scanCols: string[] = []; // F6 でチェックした動的列 (Scan_*)

  async function load(): Promise<void> {
    clear(tableWrap);
    tableWrap.appendChild(el('div', { class: 'mikke-empty' }, ['読み込み中…']));
    try {
      const [all, settings] = await Promise.all([getRepo().listIssues(), getRepo().getSettings()]);
      scanCols = settings.managedColumns.map((c) => (c.startsWith('Scan_') ? c : `Scan_${c}`));
      setState({ issueCount: all.length }, { silent: true });
      paint(all);
    } catch (e) {
      clear(tableWrap);
      tableWrap.appendChild(el('div', { class: 'mikke-error' }, [
        `一覧の取得に失敗しました: ${(e as Error).message}`,
      ]));
    }
  }

  function paint(all: ManagedIssue[]): void {
    const f = getState().filter;
    const filtered = all.filter((i) => {
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
      value: f.query, style: 'min-width:220px',
      oninput: (e: Event) => { setFilter({ query: (e.target as HTMLInputElement).value }, { silent: true }); paint(all); },
    });
    const hiddenToggle = el('label', {
      style: 'display:inline-flex;align-items:center;gap:6px;font-size:var(--fs-sm);color:var(--ink-3);cursor:pointer',
    }, [
      el('input', {
        type: 'checkbox', ...(f.showHidden ? { checked: 'checked' } : {}),
        onchange: (e: Event) => { setFilter({ showHidden: (e.target as HTMLInputElement).checked }); },
      }),
      '対象外・過検出・未検出も表示',
    ]);
    toolbar.append(el('span', { html: icon('filter'), style: 'color:var(--ink-3);display:inline-flex' }), search, hiddenToggle);

    // table
    clear(tableWrap);
    if (filtered.length === 0) {
      tableWrap.appendChild(emptyState());
      return;
    }
    const headCells = [
      el('th', { class: 'mikke-check-col' }, ['']),
      el('th', {}, ['Issue']),
      el('th', {}, ['検知']),
      el('th', {}, ['対応']),
      el('th', {}, ['深刻度']),
      el('th', {}, ['担当']),
      el('th', {}, ['期限']),
      ...scanCols.map((c) => el('th', {}, [c.replace(/^Scan_/, '')])),
      el('th', {}, ['最終同期']),
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
        ...scanCols.map((c) => el('td', {}, [i.scanFields?.[c] || '—'])),
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
