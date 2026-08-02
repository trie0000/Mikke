// 選択した SP サイト URL の永続化 (既存の内製ツールと同方式)。
// 初回はサイト選択モーダルで決定し、2 回目以降は localStorage から継続。

const KEY = 'mikke.selectedSiteUrl';

/**
 * サイト URL を「サイトのルート」に正規化する。
 *
 * ★ ここを通さないと事故る。ライブラリのページ (例 …/Shared%20Documents/Forms/AllItems.aspx)
 *   をそのまま REST のベースにすると `…/AllItems.aspx/_api/web/lists/…` を叩くことになり、
 *   SharePoint は HTML を返す → 「応答が JSON ではありません」で一覧取得に失敗する。
 *   起動元のページやコピペされた URL がライブラリ配下であることは普通にあるので、
 *   受け取った URL は必ずここで /sites/<x> (or /teams/<x>) までに切り詰める。
 */
export function normalizeWebUrl(raw: string): string {
  const s = (raw ?? '').trim();
  if (!s) return '';
  let u: URL | null = null;
  try { u = new URL(s); } catch { /* 絶対 URL でなければ次でページ基準に解決する */ }
  if (!u) {
    try {
      const base = typeof location !== 'undefined' ? location.origin : '';
      if (!base) return '';
      u = new URL(s, base);
    } catch { return ''; }
  }
  const m = u.pathname.match(/^(\/(?:sites|teams)\/[^/]+)/i);
  if (m) return (u.origin + m[1]).replace(/\/$/, '');
  // /sites/ を含まない (ルートサイト等) 場合は、ページやシステムパス以降を落とす。
  const cut = u.pathname
    .replace(/\/_(?:api|layouts|vti_bin|forms)\b.*$/i, '')
    .replace(/\/[^/]*\.aspx$/i, '')
    .replace(/\/Forms(?:\/.*)?$/i, '')
    .replace(/\/(?:SitePages|Lists|Shared%20Documents|Shared Documents)$/i, '')
    .replace(/\/$/, '');
  return (u.origin + cut).replace(/\/$/, '');
}

export function getSelectedSiteUrl(): string {
  try { return normalizeWebUrl(localStorage.getItem(KEY) || ''); } catch { return ''; }
}

export function setSelectedSiteUrl(url: string): void {
  try { localStorage.setItem(KEY, normalizeWebUrl(url)); } catch { /* noop */ }
}

export function hasSelectedSite(): boolean {
  return !!getSelectedSiteUrl();
}

/** 現在のページから web (サイト) の絶対 URL を推定する。
 *  モダン SP ページでは _spPageContextInfo が無いことがあるため、
 *  その場合は location.pathname の /sites/<x> or /teams/<x> から組み立てる。 */
export function currentWebUrl(): string {
  const ctx = (window as unknown as { _spPageContextInfo?: { webAbsoluteUrl?: string } })._spPageContextInfo;
  // ★ _spPageContextInfo の値もそのまま信用しない。ライブラリのページで起動すると
  //   ページ URL が入っていることがある (実機で確認)。必ず正規化して使う。
  if (ctx && ctx.webAbsoluteUrl) {
    const n = normalizeWebUrl(ctx.webAbsoluteUrl);
    if (n) return n;
  }
  return normalizeWebUrl(location.href);
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
