// 初期セットアップ: SP サイト選択モーダル。初回はサイト選択 → リスト自動作成。
// 2 回目以降は localStorage の選択済みサイトを継続。
import { el } from '../utils/dom';
import { openModal } from '../components/modal';
import { searchAccessibleSites, setSelectedSiteUrl, type SpSite } from '../utils/spSites';

/** サイトを選択させ、選んだ URL を返す (キャンセルで null)。 */
export function openSiteSelectionModal(root: HTMLElement): Promise<string | null> {
  return new Promise((resolve) => {
    let selected: string | null = null;
    const listBox = el('div', { style: 'margin-top:var(--s-4);max-height:300px;overflow:auto' }, ['検索中…']);

    const searchInput = el('input', {
      class: 'mikke-input', type: 'text', placeholder: 'サイト名で検索',
      style: 'width:100%;border:1px solid var(--line-strong)',
      oninput: (e: Event) => void runSearch((e.target as HTMLInputElement).value),
    }) as HTMLInputElement;

    async function runSearch(q: string): Promise<void> {
      listBox.textContent = '検索中…';
      const sites = await searchAccessibleSites(q);
      renderList(sites);
    }

    function renderList(sites: SpSite[]): void {
      listBox.innerHTML = '';
      if (!sites.length) { listBox.textContent = 'サイトが見つかりません'; return; }
      for (const site of sites) {
        const item = el('div', {
          class: 'mikke-nav-item', style: 'margin:2px 0',
          onclick: () => {
            selected = site.url;
            for (const c of Array.from(listBox.children)) c.classList.remove('is-active');
            item.classList.add('is-active');
          },
        }, [
          el('div', {}, [site.title]),
          el('div', { style: 'font-size:var(--fs-xs);color:var(--ink-4)' }, [site.url]),
        ]);
        listBox.appendChild(item);
      }
    }

    const body = el('div', {}, [
      el('p', { style: 'color:var(--ink-2)' }, ['管理 DB を置く SharePoint サイトを選択してください。']),
      searchInput, listBox,
    ]);

    openModal(root, {
      title: 'SharePoint サイトの選択',
      body,
      primaryLabel: '選択',
      hideCancel: false,
      onPrimary: async () => {
        if (!selected) throw new Error('not selected');
        setSelectedSiteUrl(selected);
        resolve(selected);
      },
      onClose: () => { if (!selected) resolve(null); },
    });

    void runSearch('');
  });
}
