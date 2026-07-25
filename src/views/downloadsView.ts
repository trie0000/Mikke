// ダウンロードデータビュー: 検査ツールから取得した脆弱性/資産データ (種別ごとの zip) の一覧。
//   - 「取得」ボタン → 対象種別を選ぶモーダル → relay 経由でアダプタから取得
//     → 種別ごとに zip 化 → SP ドキュメントライブラリの日時フォルダに保存 → 記録
//   - 一覧は資産管理と同じ表 (列フィルタ / 全文表示 / 仮想スクロール / 行選択)
//   - 各行から zip をダウンロード。単体 / 一括削除に対応
import { el, clear } from '../utils/dom';
import { icon } from '../icons';
import { getRepo } from '../api/repo';
import { openModal } from '../components/modal';
import { toast } from '../components/toast';
import { DataTable, type DataColumn } from './dataTable';
import { acquireAndStore } from '../lib/downloadFlow';
import type { DownloadRecord, DownloadType } from '../types';

/** 種別のメタ (表示名・並び順)。 */
const TYPE_META: { type: DownloadType; label: string }[] = [
  { type: 'vuln', label: '脆弱性' },
  { type: 'ip', label: 'IP' },
  { type: 'iprange', label: 'IP Range' },
  { type: 'domain', label: 'Domain' },
  { type: 'cert', label: 'Cert' },
  { type: 'webapps', label: 'WebAPPS' },
];
const LABEL_OF: Record<string, string> = Object.fromEntries(TYPE_META.map((m) => [m.type, m.label]));

/** ISO/日時文字列を JST 表示に。パースできなければ原文のまま。 */
function fmtJst(v?: string): string {
  if (!v) return '';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return v;
  return d.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', hour12: false });
}

export function renderDownloadsView(rootEl: HTMLElement): HTMLElement {
  const root = el('div', { class: 'mikke-main', style: 'display:flex;flex-direction:column' });
  const subbar = el('div', { class: 'mikke-subbar' });
  const toolbar = el('div', { class: 'mikke-toolbar' });
  const tableWrap = el('div', { class: 'mikke-table-wrap' });
  root.append(subbar, toolbar, tableWrap);

  let records: DownloadRecord[] = [];
  let query = '';
  let busy = false;
  let visibleCount = 0;
  const selected = new Set<number>();

  const table = new DataTable<DownloadRecord>(tableWrap, {
    storeKey: 'mikke.downloads',
    columns: columns(),
    rowId: (d) => d.id,
    virtualMin: 40,
    onRowClick: (d) => void downloadRecord(d),
    onVisibleChange: (v) => { visibleCount = v.length; updateSubbar(); },
    selection: {
      checked: (d) => selected.has(d.id),
      onToggle: (d, on) => { on ? selected.add(d.id) : selected.delete(d.id); updateSubbar(); },
      onToggleAll: (on, visible) => { for (const d of visible) { on ? selected.add(d.id) : selected.delete(d.id); } updateSubbar(); table.render(); },
    },
    emptyText: '取得したデータがありません。',
  });

  function columns(): DataColumn<DownloadRecord>[] {
    return [
      { id: 'downloadedAt', label: 'ダウンロード日時 (JST)', width: 200,
        text: (d) => fmtJst(d.downloadedAt), sortValue: (d) => d.downloadedAt ?? '',
        cellStyle: 'font-size:var(--fs-sm)' },
      { id: 'type', label: 'タイプ', width: 110,
        text: (d) => LABEL_OF[d.type] ?? d.type,
        render: (d) => el('span', { class: 'mikke-badge mikke-badge--accent' }, [LABEL_OF[d.type] ?? d.type]) },
      { id: 'scannerDownloadTime', label: '検査ツールDL時間', width: 200,
        text: (d) => fmtJst(d.scannerDownloadTime), sortValue: (d) => d.scannerDownloadTime ?? '',
        cellStyle: 'font-size:var(--fs-sm);color:var(--ink-3)' },
      { id: 'itemCount', label: '件数', width: 80,
        text: (d) => (d.itemCount != null ? String(d.itemCount) : ''), sortValue: (d) => d.itemCount ?? -1 },
      { id: 'fileName', label: 'ファイル', width: 260,
        text: (d) => d.fileName,
        render: (d) => {
          const wrap = el('span', { style: 'display:inline-flex;align-items:center;gap:var(--s-3)' });
          wrap.append(
            el('span', { style: 'font-family:var(--font-mono);font-size:var(--fs-sm)' }, [d.fileName]),
            el('button', {
              class: 'mikke-btn mikke-btn--ghost', style: 'height:24px;padding:0 var(--s-3);font-size:var(--fs-sm)',
              title: 'zip をダウンロード',
              onclick: (e: Event) => { e.stopPropagation(); void downloadRecord(d); },
              html: icon('download') + '<span>DL</span>',
            }),
          );
          return wrap;
        } },
    ];
  }

  void load();

  async function load(): Promise<void> {
    clear(tableWrap);
    tableWrap.appendChild(el('div', { class: 'mikke-empty' }, ['読み込み中…']));
    try {
      records = await getRepo().listDownloads();
      const ids = new Set(records.map((d) => d.id));
      for (const id of [...selected]) if (!ids.has(id)) selected.delete(id);
      paint();
    } catch (e) {
      clear(tableWrap);
      tableWrap.appendChild(el('div', { class: 'mikke-error' }, [`読み込みに失敗しました: ${(e as Error).message}`]));
    }
  }

  function searchFiltered(): DownloadRecord[] {
    const q = query.trim().toLowerCase();
    return q
      ? records.filter((d) => `${LABEL_OF[d.type] ?? d.type} ${d.fileName} ${fmtJst(d.downloadedAt)}`.toLowerCase().includes(q))
      : records;
  }

  function updateSubbar(): void {
    clear(subbar);
    subbar.appendChild(el('span', { class: 'mikke-subbar-title' }, ['ダウンロードデータ']));
    const sel = selected.size;
    if (sel === 0) {
      subbar.appendChild(el('span', { class: 'mikke-subbar-count' }, [`${visibleCount} / ${records.length} 件`]));
      return;
    }
    subbar.append(
      el('span', { class: 'mikke-subbar-count', style: 'color:var(--accent-strong);font-weight:600' }, [`${sel} 件選択`]),
      el('button', {
        class: 'mikke-btn mikke-btn--danger', style: 'height:28px;padding:0 var(--s-5);font-size:var(--fs-sm)',
        ...(busy ? { disabled: 'disabled' } : {}),
        onclick: () => bulkDelete(),
      }, ['削除']),
      el('button', {
        class: 'mikke-btn mikke-btn--ghost', style: 'height:28px;padding:0 var(--s-4);font-size:var(--fs-sm)',
        ...(busy ? { disabled: 'disabled' } : {}),
        onclick: () => { selected.clear(); table.render(); updateSubbar(); },
      }, ['選択解除']),
    );
  }

  function paint(): void {
    updateSubbar();
    clear(toolbar);
    const wrapBtn = el('button', {
      class: table.isWrap() ? 'mikke-btn mikke-btn--primary' : 'mikke-btn mikke-btn--secondary',
      style: 'height:30px;font-size:var(--fs-sm)', title: '列幅で折り返して全文表示',
      onclick: () => { table.toggleWrap(); paint(); },
    }, ['全文表示']);
    const clearBtn = table.hasActiveFilters() || query
      ? el('button', { class: 'mikke-btn mikke-btn--ghost', style: 'height:30px;font-size:var(--fs-sm)',
          onclick: () => { table.clearFilters(); query = ''; paint(); } }, ['フィルタ解除'])
      : null;
    toolbar.append(
      el('span', { html: icon('download'), style: 'color:var(--ink-3);display:inline-flex' }),
      el('input', {
        class: 'mikke-input', type: 'text', placeholder: 'タイプ / ファイル / 日時で検索',
        value: query, style: 'min-width:200px;border:1px solid var(--line)',
        oninput: (e: Event) => { query = (e.target as HTMLInputElement).value; refresh(); },
      }),
      wrapBtn,
      ...(clearBtn ? [clearBtn] : []),
      el('span', { style: 'margin-left:auto;display:inline-flex;gap:var(--s-3)' }, [
        el('button', {
          class: 'mikke-btn mikke-btn--primary', style: 'height:30px;font-size:var(--fs-sm)',
          ...(busy ? { disabled: 'disabled' } : {}),
          onclick: () => openAcquireModal(),
          html: icon('download') + '<span>取得</span>',
        }),
      ]),
    );

    if (records.length === 0) {
      clear(tableWrap);
      tableWrap.appendChild(el('div', { class: 'mikke-empty' }, [
        el('div', { class: 'mikke-empty-title' }, ['ダウンロードデータがありません']),
        el('div', {}, ['「取得」を押すと、検査ツールから脆弱性・資産データを一括取得し、ここに一覧表示します。']),
      ]));
      return;
    }
    refresh();
  }

  function refresh(): void {
    if (records.length === 0) return;
    table.setColumns(columns());
    table.setRows(searchFiltered());
    table.render();
  }

  // ── zip ダウンロード (保存済みファイルをブラウザで保存) ──────────────────────
  async function downloadRecord(d: DownloadRecord): Promise<void> {
    try {
      const href = await getRepo().docFileHref(d.fileUrl);
      if (!href) { toast(rootEl, 'ファイルが見つかりません（削除済みの可能性）。', 'warn'); return; }
      // 元ファイル名のまま保存 (検査ツール由来の名前に日付が含まれる)。
      const a = el('a', { href, download: d.fileName, style: 'display:none' });
      rootEl.appendChild(a);
      a.click();
      a.remove();
    } catch (e) {
      toast(rootEl, `ダウンロードに失敗しました: ${(e as Error).message}`, 'error');
    }
  }

  // ── 削除 (記録 + SP 実体) ────────────────────────────────────────────────────
  async function deleteOne(d: DownloadRecord): Promise<void> {
    try { await getRepo().deleteDocFile(d.fileUrl); } catch { /* 実体が既に無くても記録は消す */ }
    await getRepo().deleteDownload(d.id);
  }

  function bulkDelete(): void {
    const ids = [...selected];
    if (!ids.length) return;
    openModal(rootEl, {
      title: 'ダウンロードデータを削除',
      body: el('div', { style: 'line-height:1.7' }, [
        `選択中の ${ids.length} 件を削除します（SP 上の zip ファイルも削除）。`, el('br'),
        el('span', { style: 'color:var(--danger)' }, ['元に戻せません。']),
      ]),
      primaryLabel: `削除する (${ids.length} 件)`, primaryVariant: 'danger',
      onPrimary: async () => {
        busy = true;
        let ok = 0, fail = 0;
        for (const id of ids) {
          const rec = records.find((r) => r.id === id);
          if (!rec) continue;
          try { await deleteOne(rec); ok++; } catch { fail++; }
        }
        busy = false;
        toast(rootEl, `削除: ${ok} 件${fail ? ` / 失敗 ${fail} 件` : ''}`, fail ? 'warn' : 'ok');
        selected.clear();
        await load();
      },
    });
  }

  // ── 取得 (対象選択モーダル → relay → zip → SP 保存) ──────────────────────────
  function openAcquireModal(): void {
    const checks = new Map<DownloadType, HTMLInputElement>();
    const rowFor = (m: { type: DownloadType; label: string }) => {
      const cb = el('input', { type: 'checkbox' }) as HTMLInputElement;
      checks.set(m.type, cb);
      return el('label', { class: 'mikke-dl-pick' }, [cb, el('span', {}, [m.label])]);
    };
    const allCb = el('input', { type: 'checkbox' }) as HTMLInputElement;
    allCb.onchange = () => { for (const cb of checks.values()) cb.checked = allCb.checked; };
    const body = el('div', {}, [
      el('p', { style: 'margin:0 0 var(--s-4);line-height:1.7;color:var(--ink-2)' }, [
        '検査ツールから取得する対象を選択します。選んだ種別ごとに zip 化し、',
        'SP ドキュメントライブラリの日時フォルダに保存します。',
      ]),
      el('label', { class: 'mikke-dl-pick', style: 'font-weight:600;border-bottom:1px solid var(--line);padding-bottom:var(--s-3);margin-bottom:var(--s-2)' },
        [allCb, el('span', {}, ['一括選択（すべて）'])]),
      el('div', { class: 'mikke-dl-picks' }, TYPE_META.map(rowFor)),
    ]);
    openModal(rootEl, {
      title: 'データを取得', body, primaryLabel: '取得する',
      onPrimary: async () => {
        const types = TYPE_META.map((m) => m.type).filter((t) => checks.get(t)!.checked);
        if (!types.length) { toast(rootEl, '対象を 1 つ以上選択してください。', 'warn'); throw new Error('no type'); }
        await acquire(types);
      },
    });
  }

  async function acquire(types: DownloadType[]): Promise<void> {
    busy = true;
    let res;
    try {
      res = await acquireAndStore(types); // 取得 → SP 原本保存 → 記録 (共通フロー)
    } catch (e) {
      busy = false;
      toast(rootEl, `取得に失敗しました: ${(e as Error).message}`, 'error', 8000);
      return;
    }
    busy = false;
    const { saved, errors } = res;
    if (errors.length) {
      toast(rootEl, `保存に失敗しました (成功 ${saved} / 失敗 ${errors.length} 件) — ${errors.slice(0, 2).join(' / ')}`, saved ? 'warn' : 'error', 12000);
    } else if (saved === 0) {
      toast(rootEl, '取得データがありませんでした。', 'warn');
    } else {
      toast(rootEl, `取得・保存: ${saved} 件`, 'ok', 6000);
    }
    await load();
  }

  return root;
}
