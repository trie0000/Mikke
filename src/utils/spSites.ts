// 選択した SP サイト URL の永続化 (既存の内製ツールと同方式)。
// 初回はサイト選択モーダルで決定し、2 回目以降は localStorage から継続。

const KEY = 'mikke.selectedSiteUrl';

export function getSelectedSiteUrl(): string {
  try { return localStorage.getItem(KEY) || ''; } catch { return ''; }
}

export function setSelectedSiteUrl(url: string): void {
  try { localStorage.setItem(KEY, url.replace(/\/$/, '')); } catch { /* noop */ }
}

export function hasSelectedSite(): boolean {
  return !!getSelectedSiteUrl();
}

/** 現在のページから web (サイト) の絶対 URL を推定する。
 *  モダン SP ページでは _spPageContextInfo が無いことがあるため、
 *  その場合は location.pathname の /sites/<x> or /teams/<x> から組み立てる。 */
export function currentWebUrl(): string {
  const ctx = (window as unknown as { _spPageContextInfo?: { webAbsoluteUrl?: string } })._spPageContextInfo;
  if (ctx && ctx.webAbsoluteUrl) return ctx.webAbsoluteUrl.replace(/\/$/, '');
  const m = location.pathname.match(/^(\/(?:sites|teams)\/[^/]+)/i);
  if (m) return (location.origin + m[1]).replace(/\/$/, '');
  return '';
}

/** 実際に読み書きしているサイトの URL。選択済みがあればそれ、無ければ現在のページのサイト。
 *  SpRepository の解決順と揃えてある (画面のリンク等がリポジトリと食い違わないように)。 */
export function resolveSiteUrl(): string {
  return getSelectedSiteUrl() || currentWebUrl();
}

/** SP の検索 API でアクセス可能なサイト一覧を取得する。
 *  ※ 雛形: 実検索は実装フェーズで追加。現状は現在サイトのみ返す。 */
export interface SpSite { title: string; url: string; }

export async function searchAccessibleSites(_query: string): Promise<SpSite[]> {
  const ctx = (window as unknown as {
    _spPageContextInfo?: { webAbsoluteUrl?: string; webTitle?: string };
  })._spPageContextInfo;
  if (ctx?.webAbsoluteUrl) {
    return [{ title: ctx.webTitle ?? '現在のサイト', url: ctx.webAbsoluteUrl }];
  }
  // モダン SP ページでは _spPageContextInfo が無い。URL から推定して候補を出す
  // (ここで空を返すと「サイトが見つかりません」で先に進めなくなる)。
  const url = currentWebUrl();
  if (url) return [{ title: '現在のサイト', url }];
  return [];
}
