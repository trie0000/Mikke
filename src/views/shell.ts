// シェル: topbar + sidebar + main。既存の内製ツールのレイアウトを踏襲。
import { el, clear } from '../utils/dom';
import { icon, brandMark } from '../icons';
import { getState, setState, subscribe } from '../state';
import { getRepo, getRepoMode } from '../api/repo';
import { renderIssueList } from './issueList';
import { renderIssueDetail } from './issueDetail';
import { renderImportView } from './importView';
import { renderAssetsView } from './assetsView';
import { renderDownloadsView } from './downloadsView';
import { openSettingsModal } from './settingsModal';
import { openSiteSelectionModal } from './siteSelectionModal';
import { resolveSiteUrl } from '../utils/spSites';
import { LIST_VULNRESPONSE } from '../api/sp/schema';
import { toast } from '../components/toast';
import { checkBundleUpdate, stableBuildId } from '../utils/bundleVersion';
import { checkRelayUpdate } from '../utils/relayUpdate';
import { currentBuildId } from '../utils/bundleVersion';
import { LATEST_RELEASE } from '../lib/releaseNotes';

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
    clear(sideSlot); sideSlot.appendChild(renderSidebar(root));
    paintMain(main, root);
  }
  repaint();
  subscribe(repaint);

  // バンドル更新の定期ポーリング (dist / SP の version.txt を監視)。
  startBundleUpdatePolling(root);
  // relay スクリプト更新の検知 (起動時 1 回)。
  checkRelayUpdateOnStartup(root);
  // 更新後の「変更点」通知 (build id が前回起動から変わっていたら)。
  notifyIfUpdated(root);

  return root;
}

let bundlePollTimer: number | null = null;

// 更新を試みた版 (安定 id) を記録するキー。再読込しても build id が変わらない
// = 自己更新できない配布形態 (install.html 埋込版 / 単体 HTML) で、同じ版を
// 延々と「更新あり」と通知し続けるループを防ぐ。
const BUNDLE_ACK_KEY = 'mikke.bundle.ackVersion';
function getAckVersion(): string {
  try { return localStorage.getItem(BUNDLE_ACK_KEY) || ''; } catch { return ''; }
}
function setAckVersion(stable: string): void {
  try { localStorage.setItem(BUNDLE_ACK_KEY, stable); } catch { /* noop */ }
}

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
    if (!latest || notified) return;
    // 既に更新を試みた版なら再通知しない (リロードで変わらない = 埋込版等)。
    // より新しい版が出れば ack と異なるので改めて通知される。
    if (stableBuildId(latest) === getAckVersion()) return;
    notified = true;
    setState({ bundleUpdateAvailable: latest }); // 右上アイコンが強調される
    toast(root, '新しいバージョンがあります。右上の更新アイコンで最新版に更新できます。更新後、設定 → 更新履歴 で変更内容を確認できます。', 'warn', 0);
  };
  // 起動 5 秒後に初回、以降 60 秒ごと (キャッシュ温存と検知性のバランス)。
  window.setTimeout(() => { void check(); }, 5000);
  bundlePollTimer = window.setInterval(() => { void check(); }, 60_000);
}

// 前回起動時の build id を覚えておき、更新後の初回起動で「変更点」を案内する。
const LAST_SEEN_BUILD_KEY = 'mikke.bundle.lastSeenBuild';

/** build id が前回起動から変わっていたら「更新されました」を通知 (更新内容は
 *  設定→更新履歴 で確認できる)。初回起動 (記録なし) では出さない。 */
function notifyIfUpdated(root: HTMLElement): void {
  let prev = '';
  try { prev = localStorage.getItem(LAST_SEEN_BUILD_KEY) || ''; } catch { /* noop */ }
  const cur = currentBuildId();
  try { if (cur) localStorage.setItem(LAST_SEEN_BUILD_KEY, cur); } catch { /* noop */ }
  if (!prev || !cur || prev === cur) return;   // 初回 / 変化なし → 通知しない
  const title = LATEST_RELEASE?.title ? `（${LATEST_RELEASE.title}）` : '';
  window.setTimeout(() => {
    if (!root.isConnected) return;
    toast(root, `Mikke を更新しました${title}。変更内容は 設定 → 更新履歴 で確認できます。`, 'ok', 8000);
  }, 1500);
}

/** 起動後 1 回、relay スクリプトの更新を確認し、あれば通知。
 *  適用は 設定→接続「中継サーバを今すぐ更新」ボタンから (relay 再起動を伴うため手動)。 */
function checkRelayUpdateOnStartup(root: HTMLElement): void {
  window.setTimeout(async () => {
    if (!root.isConnected) return;
    try {
      const info = await checkRelayUpdate();
      if (!info) return;
      setState({ relayUpdateAvailable: info });
      toast(root, `中継サーバの更新があります (v${info.localVersion} → v${info.remoteVersion})。設定 → 接続 から更新できます。`, 'warn', 0);
    } catch { /* noop */ }
  }, 6500);
}

/** 更新アイコンクリック時: 更新があれば再読込、無ければ手動チェック。
 *  ※ ブックマークレットは再読込でホストページが消える (オーバーレイも消える)。
 *    ローダ版は再読込後にブックマークを再クリックすると最新 bundle を取得する。 */
async function onSync(root: HTMLElement): Promise<void> {
  const latest = getState().bundleUpdateAvailable;
  if (latest) {
    // この版は「更新を試みた」と記録 → 再読込後も同じ版なら再通知しない。
    setAckVersion(stableBuildId(latest));
    toast(root, 'ページを再読込します。Mikke が消えたらブックマークの「Mikke」を再クリックして最新版を読み込んでください。', 'ok', 5000);
    setTimeout(() => location.reload(), 1200);
    return;
  }
  toast(root, '更新を確認中…', 'default');
  const found = await checkBundleUpdate();
  if (found) {
    setState({ bundleUpdateAvailable: found });
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
    main.appendChild(renderIssueList(root));
  } else if (s.view === 'import') {
    main.appendChild(renderImportView(root));
  } else if (s.view === 'assets') {
    main.appendChild(renderAssetsView(root));
  } else if (s.view === 'downloads') {
    main.appendChild(renderDownloadsView(root));
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

function renderSidebar(root: HTMLElement): HTMLElement {
  const s = getState();
  const item = (view: string, ic: string, label: string) =>
    el('div', {
      class: `mikke-nav-item${s.view === view ? ' is-active' : ''}`,
      onclick: () => setState({ view: view as 'issues' | 'import' | 'assets' | 'downloads', selectedIssueId: null }),
    }, [el('span', { html: icon(ic) }), el('span', {}, [label])]);

  // 資産管理者への連携用リスト (SharePoint リスト) を別タブで開く外部リンク。
  // Mikke の画面ではなく SP のリストを開くので、他の項目とは別扱い (is-active にしない)。
  const listLink = (): HTMLElement | null => {
    // 選択済みサイト、無ければ現在のページのサイト (リポジトリと同じ解決順)。
    // mock / SP 以外では空になるのでリンクを出さない。
    const site = resolveSiteUrl();
    if (!site) return null;
    // ★ href は「組み立てた推測 URL」なので中クリック等の保険にとどめ、
    //   通常のクリックでは SharePoint から実際の URL を引いてから開く。
    //   リストの URL は作成時の名前で決まるため、組み立てると 404 になり得る。
    const href = `${site.replace(/\/$/, '')}/Lists/${LIST_VULNRESPONSE}/AllItems.aspx`;
    return el('a', {
      class: 'mikke-nav-item mikke-nav-item--external',
      href, target: '_blank', rel: 'noopener noreferrer',
      title: '資産管理者に対応状況を記入してもらうリストを別タブで開きます',
      onclick: (e: Event) => {
        e.preventDefault();
        void (async () => {
          let url: string | null = null;
          try { url = await getRepo().vulnResponseListUrl(); } catch { /* 下で案内する */ }
          if (url) { window.open(url, '_blank', 'noopener,noreferrer'); return; }
          toast(root,
            '連携用リストがまだありません。設定 → 共通設定 → 資産管理者向けリスト から作成してください。',
            'warn', 8000);
        })();
      },
    }, [
      el('span', { html: icon('building') }),
      el('span', {}, ['連携用リスト']),
      el('span', { class: 'mikke-nav-ext', html: icon('external') }),
    ]);
  };
  const extLink = listLink();

  let buildId = '';
  try { buildId = __MIKKE_BUILD_ID__; } catch { /* noop */ }

  return el('aside', { class: 'mikke-side' }, [
    item('issues', 'list', '管理対象一覧'),
    item('import', 'upload', 'CSV 取込'),
    item('assets', 'building', '資産管理'),
    item('downloads', 'download', 'ダウンロードデータ'),
    ...(extLink ? [extLink] : []),
    el('div', { class: 'mikke-side-foot' }, [
      el('div', {}, [`mode: ${getRepoMode()}`]),
      el('div', { style: 'margin-top:2px;word-break:break-all' }, [buildId]),
    ]),
  ]);
}
