import { describe, it, expect } from 'vitest';
import { normalizeWebUrl } from '../src/utils/spSites';

// 実機で「一覧の取得に失敗しました（応答が JSON ではありません）」を起こした形を含む。
// ライブラリのページ URL をそのまま REST のベースにすると
// `…/AllItems.aspx/_api/web/lists/…` を叩いてしまい、SharePoint が HTML を返す。
describe('normalizeWebUrl: サイト URL をサイトのルートに正規化する', () => {
  const SITE = 'https://contoso.sharepoint.com/sites/TeamA';

  it('ライブラリのフォームページはサイトのルートに切り詰める', () => {
    expect(normalizeWebUrl(`${SITE}/Shared%20Documents/Forms/AllItems.aspx`)).toBe(SITE);
  });

  it('リストのページもサイトのルートに切り詰める', () => {
    expect(normalizeWebUrl(`${SITE}/Lists/MikkeManagedIssues/AllItems.aspx`)).toBe(SITE);
    expect(normalizeWebUrl(`${SITE}/SitePages/Home.aspx`)).toBe(SITE);
  });

  it('クエリや末尾スラッシュを落とす', () => {
    expect(normalizeWebUrl(`${SITE}/Lists/X/DispForm.aspx?ID=2`)).toBe(SITE);
    expect(normalizeWebUrl(`${SITE}/`)).toBe(SITE);
  });

  it('teams サイトも同じく扱う', () => {
    const t = 'https://contoso.sharepoint.com/teams/Grp';
    expect(normalizeWebUrl(`${t}/Shared%20Documents/Forms/AllItems.aspx`)).toBe(t);
  });

  it('既にサイトのルートならそのまま', () => {
    expect(normalizeWebUrl(SITE)).toBe(SITE);
  });

  it('サイト名に記号やドットが入っていても切り詰められる', () => {
    const s = 'https://contoso.sharepoint.com/sites/TM.PISC.NW534';
    expect(normalizeWebUrl(`${s}/Shared%20Documents/Forms/AllItems.aspx`)).toBe(s);
  });

  it('/sites/ を含まない場合もページ・システムパスを落とす', () => {
    expect(normalizeWebUrl('https://contoso.sharepoint.com/SitePages/Home.aspx'))
      .toBe('https://contoso.sharepoint.com');
    expect(normalizeWebUrl('https://contoso.sharepoint.com/_layouts/15/viewlsts.aspx'))
      .toBe('https://contoso.sharepoint.com');
  });

  it('空文字や壊れた入力は空を返す (呼び出し側でフォールバックさせる)', () => {
    expect(normalizeWebUrl('')).toBe('');
    expect(normalizeWebUrl('   ')).toBe('');
  });
});
