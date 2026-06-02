// 選択した SP サイト URL の永続化 (Spira 同方式)。
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
  return [];
}
