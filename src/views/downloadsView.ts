// ダウンロードデータビュー: 検査ツールから取得した脆弱性/資産データ (種別ごとの zip) の一覧。
//   - 「取得」ボタン → 対象種別を選ぶモーダル → relay 経由でアダプタから取得
//     → 種別ごとに zip 化 → SP ドキュメントライブラリの日時フォルダに保存 → 記録
//   - 一覧は資産管理と同じ表 (列フィルタ / 全文表示 / 仮想スクロール / 行選択)
//   - 各行から zip をダウンロード。単体 / 一括削除に対応
import { el, clear } from '../utils/dom';
import { icon } from '../icons';
import { getRepo, getRepoMode } from '../api/repo';
import { openModal } from '../components/modal';
import { toast } from '../components/toast';
import { DataTable, type DataColumn } from './dataTable';
import { relayDownloadFromScanner, type RelayDownloadItem } from '../api/relay';
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

const DEFAULT_FOLDER = 'Shared Documents/MikkeDownloads';

/** 日時 (省略時は現在) を JST の 'YYYYMMDD-HHMMSS' にする (フォルダ名/ファイル名用)。 */
function jstStamp(iso?: string): string {
  const d = iso ? new Date(iso) : new Date();
  if (Number.isNaN(d.getTime())) return '';
  // sv-SE は 'YYYY-MM-DD HH:MM:SS' 形式で返る。JST 固定。
  const s = d.toLocaleString('sv-SE', { timeZone: 'Asia/Tokyo' });
  return s.replace(/[-:]/g, '').replace(' ', '-');
}

/** ISO/日時文字列を JST 表示に。パースできなければ原文のまま。 */
function fmtJst(v?: string): string {
  if (!v) return '';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return v;
  return d.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', hour12: false });
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}

/** 最大 limit 並列で items を処理する (順不同)。各 fn は自身で例外を処理する前提。 */
async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let idx = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (idx < items.length) {
      const cur = items[idx++]!;
      await fn(cur);
    }
  });
  await Promise.all(runners);
}

/** mock (dev) 用のサンプルデータ。relay が無い環境で UI を検証するため。 */
function sampleItems(types: DownloadType[]): RelayDownloadItem[] {
  const enc = new TextEncoder();
  const nowIso = new Date().toISOString();
  return types.map((t) => {
    const csv = `type,sample\n${t},row-1\n${t},row-2\n`;
    // 実際の検査ツールは日付入りのファイル名 (zip) を返す想定。そのまま保存する。
    return {
      type: t,
      fileName: `${t}_export_2026_Jul_05.zip`,
      contentBase64: btoa(String.fromCharCode(...enc.encode(csv))),
      scannerDownloadTime: nowIso,
      itemCount: 2,
    };
  });
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
    const settings = await getRepo().getSettings();
    const baseFolder = (settings.downloadFolder ?? '').trim() || DEFAULT_FOLDER;

    // 1) relay 経由で取得 (mock は sample)。
    let items: RelayDownloadItem[];
    try {
      items = getRepoMode() === 'mock'
        ? sampleItems(types)
        : (await relayDownloadFromScanner(types)).items;
    } catch (e) {
      toast(rootEl, `取得に失敗しました: ${(e as Error).message}`, 'error', 8000);
      return;
    }
    if (!items || items.length === 0) { toast(rootEl, '取得データがありませんでした。', 'warn'); return; }

    // 2) 取得したファイルをそのまま SP に保存 → 記録。
    //    アダプタが返すのは検査ツールの元ファイル (通常 zip)。再 zip 化・リネームは
    //    しない (元ファイル名に日付が含まれるため)。1 ファイル = 1 レコード。
    const nowIso = new Date().toISOString();
    const runFolder = `${baseFolder}/${jstStamp(nowIso)}`; // 保管は日時フォルダ

    busy = true;
    // SP への保存を並列化 (最大 4 並列)。relay 側は取得を種別ごとに並列化済み。
    let ok = 0, fail = 0;
    const errs: string[] = [];
    await mapLimit(items, 4, async (it) => {
      try {
        const blob = new Blob([base64ToBytes(it.contentBase64) as BlobPart], { type: 'application/octet-stream' });
        const fileName = it.fileName; // 元ファイル名のまま (リネームしない)
        const { url } = await getRepo().uploadDownloadFile(runFolder, fileName, blob);
        await getRepo().createDownload({
          type: it.type as DownloadType,
          downloadedAt: nowIso,
          scannerDownloadTime: it.scannerDownloadTime,
          fileName, folder: runFolder, fileUrl: url,
          itemCount: it.itemCount,
        });
        ok++;
      } catch (e) {
        fail++;
        const msg = (e as Error).message;
        errs.push(`${LABEL_OF[it.type] ?? it.type}: ${msg}`);
        console.warn(`[mikke/downloads] ${it.type} (${it.fileName}) の保存に失敗:`, msg);
      }
    });
    busy = false;
    if (fail) {
      // 失敗理由 (SP フォルダ作成 / アップロード / 一覧書込の HTTP ステータス等) を明示。
      toast(rootEl, `保存に失敗しました (成功 ${ok} / 失敗 ${fail} 件) — ${errs.slice(0, 2).join(' / ')}`, ok ? 'warn' : 'error', 12000);
    } else {
      toast(rootEl, `取得・保存: ${ok} 件`, 'ok', 6000);
    }
    await load();
  }

  return root;
}
