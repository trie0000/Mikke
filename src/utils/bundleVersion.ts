// バンドル本体 (mikke.bundle.js) のライブ更新検知。
// 起動中の build id (__MIKKE_BUILD_ID__) と、配信元の version.txt を比較する。
//   - 開発時: ローカル relay 経由の dist (localStorage mikke.dev.* で local 指定時)
//   - 本番:   SharePoint の Mikke フォルダ
// ローダ (build.js 生成) と同じ base 解決ロジックに合わせる。

const DEV_SOURCE_KEY = 'mikke.dev.bundle-source';   // 'local' | (未設定=sharepoint)
const DEV_LOCAL_BASE_KEY = 'mikke.dev.local-base';  // 例: http://127.0.0.1:18080/mikke
export const DEFAULT_LOCAL_BASE = 'http://127.0.0.1:18080/mikke';
const LIB_PATH = '/Shared%20Documents/Mikke';

export type BundleSource = 'sharepoint' | 'local';

/** バンドル読込元 (開発者モードのラジオ)。ローダと同じキーを参照。 */
export function getBundleSource(): BundleSource {
  try { return localStorage.getItem(DEV_SOURCE_KEY) === 'local' ? 'local' : 'sharepoint'; }
  catch { return 'sharepoint'; }
}
export function setBundleSource(v: BundleSource): void {
  try {
    if (v === 'local') localStorage.setItem(DEV_SOURCE_KEY, 'local');
    else localStorage.removeItem(DEV_SOURCE_KEY);
  } catch { /* noop */ }
}
export function getLocalBase(): string {
  try { return localStorage.getItem(DEV_LOCAL_BASE_KEY) || DEFAULT_LOCAL_BASE; }
  catch { return DEFAULT_LOCAL_BASE; }
}
export function setLocalBase(url: string): void {
  try {
    const v = url.trim().replace(/\/+$/, '');
    if (v && v !== DEFAULT_LOCAL_BASE) localStorage.setItem(DEV_LOCAL_BASE_KEY, v);
    else localStorage.removeItem(DEV_LOCAL_BASE_KEY);
  } catch { /* noop */ }
}

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
  // _spPageContextInfo が無いモダン SP ページ向けフォールバック:
  // location.pathname の /sites/<x> or /teams/<x> から web 相対を推定。
  try {
    const m = location.pathname.match(/^(\/(?:sites|teams)\/[^/]+)/i);
    if (m) return m[1] + LIB_PATH;
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

/** build id から安定識別子 (version-sha) を取り出す。末尾の dirty マーカー `+` と
 *  `(buildTime)` は除く。これらは同一コミットでもビルド毎に変わるため、比較に
 *  含めると「同じ版なのに毎回更新あり」と誤検知してループする原因になる。
 *  例: "0.0.1-5847d15+ (2026-06-03T04:57:23Z)" → "0.0.1-5847d15" */
export function stableBuildId(id: string): string {
  if (!id) return '';
  const beforeTime = id.split(' (')[0] ?? id;   // buildTime を落とす
  return beforeTime.replace(/\+$/, '').trim();   // dirty マーカーを落とす
}

/** 最新版が出ているか確認。出ていれば最新 build id を、無ければ null。
 *  比較は安定識別子 (version-sha) で行う (buildTime/dirty の揺れを無視)。 */
export async function checkBundleUpdate(): Promise<string | null> {
  const latest = await fetchLatestBuildId();
  const cur = currentBuildId();
  if (latest && cur && stableBuildId(latest) !== stableBuildId(cur)) return latest;
  return null;
}
