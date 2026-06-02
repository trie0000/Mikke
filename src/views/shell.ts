// シェル: topbar + sidebar + main。Spira のレイアウトを踏襲。
import { el, clear } from '../utils/dom';
import { icon, brandMark } from '../icons';
import { getState, setState, subscribe } from '../state';
import { getRepoMode } from '../api/repo';
import { renderIssueList } from './issueList';
import { renderIssueDetail } from './issueDetail';
import { renderImportView } from './importView';
import { openSettingsModal } from './settingsModal';
import { openSiteSelectionModal } from './siteSelectionModal';
import { toast } from '../components/toast';
import { checkBundleUpdate } from '../utils/bundleVersion';

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

  // バンドル更新の定期ポーリング (dist / SP の version.txt を監視)。
  startBundleUpdatePolling(root);

  return root;
}

let bundlePollTimer: number | null = null;

/** 起動後に version.txt を定期チェックし、更新があれば右上アイコン強調＋トースト。 */
function startBundleUpdatePolling(root: HTMLElement): void {
  if (bundlePollTimer != null) { window.clearInterval(bundlePollTimer); bundlePollTimer = null; }
  let notified = false;
  const check = async (): Promise<void> => {
    if (!root.isConnected) {
      if (bundlePollTimer != null) { window.clearInterval(bundlePollTimer); bundlePollTimer = null; }
      return;
    }
    const latest = await checkBundleUpdate();
    if (latest && !notified) {
      notified = true;
      setState({ bundleUpdateAvailable: latest }); // 右上アイコンが強調される
      toast(root, '新しいバージョンがあります。右上の更新アイコンをクリックすると最新版に更新されます。', 'warn', 0);
    }
  };
  // 起動 5 秒後に初回、以降 60 秒ごと (キャッシュ温存と検知性のバランス)。
  window.setTimeout(() => { void check(); }, 5000);
  bundlePollTimer = window.setInterval(() => { void check(); }, 60_000);
}

/** 更新アイコンクリック時: 更新があればリロード、無ければ手動チェック。 */
async function onSync(root: HTMLElement): Promise<void> {
  if (getState().bundleUpdateAvailable) {
    toast(root, '最新版に更新しています…', 'ok');
    setTimeout(() => location.reload(), 400); // ローダが最新 bundle を再取得
    return;
  }
  toast(root, '更新を確認中…', 'default');
  const latest = await checkBundleUpdate();
  if (latest) {
    setState({ bundleUpdateAvailable: latest });
    toast(root, '新しいバージョンが見つかりました。もう一度クリックで更新します。', 'warn', 0);
  } else {
    toast(root, '最新版です。', 'ok');
  }
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

  // 更新 (同期) アイコン。更新がある時はアクセント色で強調し、クリックでリロード
  //  (= ローダが最新 bundle を再取得)。更新が無い時は手動チェックを行う。
  const hasUpdate = !!getState().bundleUpdateAvailable;
  const syncBtn = el('button', {
    class: 'mikke-iconbtn', 'aria-label': hasUpdate ? '新しいバージョンに更新' : '更新を確認',
    title: hasUpdate ? '新しいバージョンがあります。クリックで更新 (リロード)' : '更新を確認',
    style: hasUpdate ? 'color:var(--accent);background:var(--accent-soft)' : '',
    onclick: () => { void onSync(root); },
    html: icon('sync'),
  });

  const siteBtn = el('button', {
    class: 'mikke-iconbtn', 'aria-label': 'SP サイトを切替', title: 'SP サイトを切替',
    onclick: () => { void openSiteSelectionModal(root); },
    html: icon('building'),
  });

  const settingsBtn = el('button', {
    class: 'mikke-iconbtn', 'aria-label': '設定', title: '設定',
    onclick: () => openSettingsModal(root),
    html: icon('gear'),
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
    el('div', { class: 'mikke-topbar-actions' }, [syncBtn, siteBtn, themeBtn, settingsBtn, closeBtn]),
  ]);
}

function renderSidebar(): HTMLElement {
  const s = getState();
  const item = (view: string, ic: string, label: string) =>
    el('div', {
      class: `mikke-nav-item${s.view === view ? ' is-active' : ''}`,
      onclick: () => setState({ view: view as 'issues' | 'import', selectedIssueId: null }),
    }, [el('span', { html: icon(ic) }), el('span', {}, [label])]);

  let buildId = '';
  try { buildId = __MIKKE_BUILD_ID__; } catch { /* noop */ }

  return el('aside', { class: 'mikke-side' }, [
    item('issues', 'list', '管理対象一覧'),
    item('import', 'upload', 'CSV 取込'),
    el('div', { class: 'mikke-side-foot' }, [
      el('div', {}, [`mode: ${getRepoMode()}`]),
      el('div', { style: 'margin-top:2px;word-break:break-all' }, [buildId]),
    ]),
  ]);
}
