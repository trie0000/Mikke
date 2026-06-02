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

export async function mount(): Promise<void> {
  // CSS 注入 (一度だけ)
  if (!document.getElementById('mikke-style')) {
    const style = document.createElement('style');
    style.id = 'mikke-style';
    style.textContent = css;
    document.head.appendChild(style);
  }

  // 既存 overlay を除去 (二重起動防止)
  document.getElementById('mikke-root')?.remove();

  const root = renderShell();
  document.body.appendChild(root);

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
