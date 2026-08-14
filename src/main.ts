// Mikke — bookmarklet entry. Renders overlay onto <body>.
import css from './styles/app.css';
import { initRepo, getRepo, detectMode } from './api/repo';
import { renderShell } from './views/shell';
import { setState } from './state';
import { hasSelectedSite } from './utils/spSites';
import { openSiteSelectionModal } from './views/siteSelectionModal';

declare global {
  // eslint-disable-next-line no-var
  var __MIKKE_MOUNTED__: boolean | undefined;
}

/** SharePoint 外 (install.html / file:// / 他社サイト) で起動された場合の検知。 */
function isInvalidLaunchContext(): boolean {
  if (/install.*\.html?$/i.test(location.pathname)) return true;
  if (location.protocol === 'file:') return true;
  const params = new URLSearchParams(location.search);
  if (params.has('mock')) return false;
  if (location.hostname.endsWith('.sharepoint.com')) return false;
  if (location.hostname === 'localhost' || /^127\./.test(location.hostname)) return false;
  return true;
}

function showInvalidContextWarning(): void {
  const backdrop = document.createElement('div');
  backdrop.style.cssText =
    'position:fixed;inset:0;background:rgba(0,0,0,0.55);z-index:2147483700;' +
    'display:flex;align-items:center;justify-content:center;' +
    'font-family:system-ui,-apple-system,"Segoe UI",sans-serif';
  const panel = document.createElement('div');
  panel.style.cssText =
    'background:#fff;color:#1f1f1f;border-radius:8px;padding:24px 28px;' +
    'box-shadow:0 12px 40px rgba(0,0,0,0.25);max-width:520px;width:90%';
  panel.innerHTML =
    '<h2 style="margin:0 0 12px;font-size:18px;font-weight:600">⚠ ここでは Mikke を起動できません</h2>' +
    '<p style="margin:0 0 16px;font-size:14px;line-height:1.7">Mikke は <strong>SharePoint サイト上</strong> で動作するブックマークレットです。' +
    '対象の SharePoint サイトを開いた状態でブックマークをクリックしてください。</p>' +
    '<div style="text-align:right"><button id="mikke-warn-close" style="padding:8px 18px;background:#5a76a3;color:#fff;border:0;border-radius:4px;cursor:pointer;font-size:14px">閉じる</button></div>';
  backdrop.appendChild(panel);
  const close = (): void => backdrop.remove();
  panel.querySelector('#mikke-warn-close')?.addEventListener('click', close);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
  document.body.appendChild(backdrop);
}

/** オーバーレイの容れ物 (Shadow DOM のホスト)。 */
const HOST_ID = 'mikke-host';

/**
 * オーバーレイを差し込む場所を用意する。
 *
 * ★ Shadow DOM に入れる。ホストページ (SharePoint) の CSS は shadow 境界を越えない。
 *   クラシックページの corev15.css は `button { background: … !important }` のような
 *   素の要素セレクタを持っており、`#mikke-root` 配下でも **!important には勝てない**
 *   (実測: ボタンの背景・枠・フォント、リンク色、th の余白と揃えが化けた)。
 *   shadow に入れればセレクタ自体が届かないので、この種の崩れが原理的に起きない。
 * ★ ホスト要素には `all: initial !important` を当てる。継承する性質 (font / color /
 *   text-align / user-select 等) だけは shadow の中にも入ってくるため、ここで断つ。
 * ★ attachShadow が使えない環境では今までどおり (機能は動く。見た目だけ host の
 *   影響を受け得る)。
 */
function createMountPoint(): { host: HTMLElement; mount: ParentNode } {
  document.getElementById(HOST_ID)?.remove();
  document.getElementById('mikke-root')?.remove();   // 旧版 (shadow 無し) の残骸
  document.getElementById('mikke-style')?.remove();

  const host = document.createElement('div');
  host.id = HOST_ID;
  host.style.cssText = 'all: initial !important';
  document.body.appendChild(host);

  let mount: ParentNode = host;
  try { mount = host.attachShadow({ mode: 'open' }); }
  catch { /* 使えない環境は host 直下に置く (従来動作) */ }

  const style = document.createElement('style');
  style.id = 'mikke-style';
  style.textContent = css;
  mount.appendChild(style);
  return { host, mount };
}

export async function mount(): Promise<void> {
  const { mount: at } = createMountPoint();
  const root = renderShell();
  at.appendChild(root);

  // bootstrap (非同期)
  try {
    await initRepo();
    const repo = getRepo();
    const user = await repo.getCurrentUser();
    setState({ currentUser: user, ready: true });

    // 初回はサイト選択 → ensureLists。mock では不要。
    if (detectMode() === 'sp' && !hasSelectedSite()) {
      const sel = await openSiteSelectionModal(root);
      if (sel) { await initRepo(); }
    }
    if (detectMode() === 'sp') {
      await getRepo().ensureLists();
    }
    setState({}); // 再描画
  } catch (e) {
    setState({ errorBanner: `初期化に失敗しました: ${(e as Error).message}`, ready: true });
    console.error('[mikke] bootstrap failed:', e);
  }
}

// ── auto-mount ──
if (isInvalidLaunchContext()) {
  showInvalidContextWarning();
} else if (!globalThis.__MIKKE_MOUNTED__ || true) {
  globalThis.__MIKKE_MOUNTED__ = true;
  void mount();
}
