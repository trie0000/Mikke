// バンドル本体 (mikke.bundle.js) のライブ更新検知。
// 起動中の build id (__MIKKE_BUILD_ID__) と、配信元の version.txt を比較する。
//   - 開発時: ローカル relay 経由の dist (localStorage mikke.dev.* で local 指定時)
//   - 本番:   SharePoint の Mikke フォルダ
// ローダ (build.js 生成) と同じ base 解決ロジックに合わせる。

const DEV_SOURCE_KEY = 'mikke.dev.bundle-source';   // 'local' | (未設定=sharepoint)
const DEV_LOCAL_BASE_KEY = 'mikke.dev.local-base';  // 例: http://127.0.0.1:18080/mikke
const DEFAULT_LOCAL_BASE = 'http://127.0.0.1:18080/mikke';
const LIB_PATH = '/Shared%20Documents/Mikke';

/** ローダと同じく、本体取得元の base を解決する。解決不可なら空文字。 */
export function resolveBundleBase(): string {
  try {
    if (localStorage.getItem(DEV_SOURCE_KEY) === 'local') {
      return (localStorage.getItem(DEV_LOCAL_BASE_KEY) || DEFAULT_LOCAL_BASE).replace(/\/+$/, '');
    }
  } catch { /* noop */ }
  try {
    const ctx = (window as unknown as { _spPageContextInfo?: { webServerRelativeUrl?: string } })._spPageContextInfo;
    if (ctx?.webServerRelativeUrl) {
      return ctx.webServerRelativeUrl.replace(/\/$/, '') + LIB_PATH;
    }
  } catch { /* noop */ }
  return '';
}

/** 配信元の version.txt を取得 (= 最新 build id)。失敗時 null。
 *  ※ SP は `.js?query` を 404 にすることがあるが .txt は OK。キャッシュ無効化は付ける。 */
export async function fetchLatestBuildId(): Promise<string | null> {
  const base = resolveBundleBase();
  if (!base) return null;
  try {
    const res = await fetch(`${base}/version.txt?t=${Date.now()}`, { credentials: 'same-origin' });
    if (!res.ok) return null;
    const txt = (await res.text()).trim();
    return txt || null;
  } catch {
    return null;
  }
}

/** 現在実行中の build id。 */
export function currentBuildId(): string {
  try { return __MIKKE_BUILD_ID__; } catch { return ''; }
}

/** 最新版が出ているか確認。出ていれば最新 build id を、無ければ null。 */
export async function checkBundleUpdate(): Promise<string | null> {
  const latest = await fetchLatestBuildId();
  const cur = currentBuildId();
  if (latest && cur && latest !== cur) return latest;
  return null;
}
