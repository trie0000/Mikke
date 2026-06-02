// シェル: topbar + sidebar + main。Spira のレイアウトを踏襲。
import { el, clear } from '../utils/dom';
import { icon, brandMark } from '../icons';
import { getState, setState, subscribe } from '../state';
import { getRepoMode } from '../api/repo';
import { renderIssueList } from './issueList';
import { renderIssueDetail } from './issueDetail';
import { renderImportView } from './importView';
import { renderSettingsView } from './settingsView';
import { openSiteSelectionModal } from './siteSelectionModal';

export function renderShell(): HTMLElement {
  const root = el('div', { id: 'mikke-root', class: 'mikke-root', 'data-theme': 'light' });
  try {
    const t = localStorage.getItem('mikke.theme');
    if (t === 'dark') root.setAttribute('data-theme', 'dark');
  } catch { /* noop */ }

  const main = el('div', { class: 'mikke-main' });
  const sideSlot = el('div', { style: 'display:contents' });
  const topSlot = el('div', { style: 'display:contents' });

  const shell = el('div', { class: 'mikke-shell' }, [
    topSlot,
    el('div', { class: 'mikke-body' }, [sideSlot, main]),
  ]);
  root.appendChild(shell);

  function repaint(): void {
    clear(topSlot); topSlot.appendChild(renderTopbar(root));
    clear(sideSlot); sideSlot.appendChild(renderSidebar());
    paintMain(main, root);
  }
  repaint();
  subscribe(repaint);

  return root;
}

function paintMain(main: HTMLElement, root: HTMLElement): void {
  clear(main);
  const s = getState();
  if (s.view === 'issues' && s.selectedIssueId != null) {
    main.appendChild(renderIssueDetail(root));
  } else if (s.view === 'issues') {
    main.appendChild(renderIssueList());
  } else if (s.view === 'import') {
    main.appendChild(renderImportView(root));
  } else if (s.view === 'settings') {
    main.appendChild(renderSettingsView(root));
  }
}

function renderTopbar(root: HTMLElement): HTMLElement {
  const themeBtn = el('button', {
    class: 'mikke-iconbtn', 'aria-label': 'テーマ切替', title: 'テーマ切替',
    onclick: () => {
      const cur = root.getAttribute('data-theme') ?? 'light';
      const next = cur === 'light' ? 'dark' : 'light';
      root.setAttribute('data-theme', next);
      try { localStorage.setItem('mikke.theme', next); } catch { /* noop */ }
      themeBtn.innerHTML = icon(next === 'dark' ? 'sun' : 'moon');
    },
    html: icon(root.getAttribute('data-theme') === 'dark' ? 'sun' : 'moon'),
  });

  const siteBtn = el('button', {
    class: 'mikke-iconbtn', 'aria-label': 'SP サイトを切替', title: 'SP サイトを切替',
    onclick: () => { void openSiteSelectionModal(root); },
    html: icon('building'),
  });

  const closeBtn = el('button', {
    class: 'mikke-iconbtn', 'aria-label': 'アプリを閉じる', title: 'アプリを閉じる',
    onclick: () => root.remove(), html: icon('door'),
  });

  const s = getState();
  const siteChip = s.siteTitle
    ? el('a', {
        class: 'mikke-topbar-site', href: s.siteUrl ?? '#', target: '_blank', rel: 'noopener noreferrer',
        title: s.siteTitle,
      }, [el('span', {}, ['📁']), el('span', {}, [s.siteTitle])])
    : null;

  return el('header', { class: 'mikke-topbar', role: 'banner' }, [
    el('div', { class: 'mikke-topbar-brand' }, [
      el('span', { class: 'mikke-brand-mark', html: brandMark() }),
      el('span', {}, ['Mikke']),
    ]),
    ...(siteChip ? [siteChip] : []),
    el('div', { class: 'mikke-topbar-spacer' }),
    el('div', { class: 'mikke-topbar-actions' }, [siteBtn, themeBtn, closeBtn]),
  ]);
}

function renderSidebar(): HTMLElement {
  const s = getState();
  const item = (view: string, ic: string, label: string) =>
    el('div', {
      class: `mikke-nav-item${s.view === view ? ' is-active' : ''}`,
      onclick: () => setState({ view: view as 'issues' | 'import' | 'settings', selectedIssueId: null }),
    }, [el('span', { html: icon(ic) }), el('span', {}, [label])]);

  let buildId = '';
  try { buildId = __MIKKE_BUILD_ID__; } catch { /* noop */ }

  return el('aside', { class: 'mikke-side' }, [
    item('issues', 'list', '管理対象一覧'),
    item('import', 'upload', 'CSV 取込'),
    item('settings', 'gear', '設定'),
    el('div', { class: 'mikke-side-foot' }, [
      el('div', {}, [`mode: ${getRepoMode()}`]),
      el('div', { style: 'margin-top:2px;word-break:break-all' }, [buildId]),
    ]),
  ]);
}
