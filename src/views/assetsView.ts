// 資産管理ビュー: 脆弱性に該当した資産 (FQDN/IP 単位) の管理部門リスト。
//   - 「脆弱性から資産を抽出」で ManagedIssues の資産列からユニーク資産を登録
//   - 「管理部門CSVを取込」で社内の資産管理部門リスト (基本情報 + サイトURL情報)
//     を突合し、事業会社 / 関連会社 / Web資産管理番号 / 特定理由 / 特定根拠 を更新
//   - 行クリックで編集モーダル (手動記入も可能)
import { el, clear, fmtDate } from '../utils/dom';
import { icon } from '../icons';
import { getRepo } from '../api/repo';
import { openModal } from '../components/modal';
import { toast } from '../components/toast';
import {
  DEFAULT_ASSET_COLUMN, extractAssets, countIssuesByAsset, assetTypeOf, splitAssetCell,
  buildAssetDirectory, matchAssets,
} from '../lib/assets';
import { toCsv, buildXlsxBlob, parseSpreadsheetFile, downloadFile, type Sheet } from '../lib/xlsx';
import { DataTable, type DataColumn } from './dataTable';
import type { ManagedAsset, ManagedIssue, MikkeSettings } from '../types';

/** エクスポート/インポートの列 (ヘッダ = 表示名)。 */
const EXPORT_HEADERS = ['資産', '種別', '事業会社', '関連会社', '管理番号', '特定理由', '特定根拠', '脆弱性件数', '更新日時'];
/** ヘッダ名 → ManagedAsset の編集可能フィールド。インポート時の取込対象。 */
const IMPORT_FIELDS: { header: string; field: 'businessCompany' | 'affiliateCompany' | 'mgmtNumber' | 'identifyReason' | 'identifyEvidence' }[] = [
  { header: '事業会社', field: 'businessCompany' },
  { header: '関連会社', field: 'affiliateCompany' },
  { header: '管理番号', field: 'mgmtNumber' },
  { header: '特定理由', field: 'identifyReason' },
  { header: '特定根拠', field: 'identifyEvidence' },
];
const normHeader = (h: string): string => (h ?? '').replace(/[\s　]+/g, '');

/** 設定から資産列 (複数) を解決。旧 assetColumn からのフォールバックあり。 */
function resolveAssetColumns(s: MikkeSettings): string[] {
  if (s.assetColumns && s.assetColumns.length) return s.assetColumns;
  if (s.assetColumn) return [s.assetColumn];
  return [DEFAULT_ASSET_COLUMN];
}

export function renderAssetsView(rootEl: HTMLElement): HTMLElement {
  const root = el('div', { class: 'mikke-main', style: 'display:flex;flex-direction:column' });
  const subbar = el('div', { class: 'mikke-subbar' });
  const toolbar = el('div', { class: 'mikke-toolbar' });
  const tableWrap = el('div', { class: 'mikke-table-wrap' });
  root.append(subbar, toolbar, tableWrap);

  let assets: ManagedAsset[] = [];
  let issues: ManagedIssue[] = [];
  let issueCounts: Record<string, number> = {};
  let query = '';
  let busy = false;
  let visibleCount = 0;
  const selected = new Set<number>();

  const table = new DataTable<ManagedAsset>(tableWrap, {
    storeKey: 'mikke.assets',
    columns: assetColumns(),
    rowId: (a) => a.id,
    virtualMin: 40,
    onRowClick: (a) => openAssetEditModal(a),
    onVisibleChange: (v) => { visibleCount = v.length; updateSubbar(); },
    selection: {
      checked: (a) => selected.has(a.id),
      onToggle: (a, on) => { on ? selected.add(a.id) : selected.delete(a.id); updateSubbar(); },
      onToggleAll: (on, visible) => { for (const a of visible) { on ? selected.add(a.id) : selected.delete(a.id); } updateSubbar(); table.render(); },
    },
    emptyText: '該当する資産がありません。',
  });

  function assetColumns(): DataColumn<ManagedAsset>[] {
    return [
      { id: 'assetKey', label: '資産 (FQDN / IP)', width: 220, text: (a) => a.assetKey,
        cellStyle: 'font-family:var(--font-mono);font-size:var(--fs-sm)' },
      { id: 'assetType', label: '種別', width: 72, text: (a) => a.assetType,
        render: (a) => el('span', { class: `mikke-badge${a.assetType === 'IP' ? ' mikke-badge--muted' : ' mikke-badge--accent'}` }, [a.assetType]) },
      { id: 'businessCompany', label: '事業会社', width: 140, text: (a) => a.businessCompany ?? '' },
      { id: 'affiliateCompany', label: '関連会社', width: 140, text: (a) => a.affiliateCompany ?? '' },
      { id: 'mgmtNumber', label: '管理番号', width: 120, text: (a) => a.mgmtNumber ?? '' },
      { id: 'identifyReason', label: '特定理由', width: 180, text: (a) => a.identifyReason ?? '', cellStyle: 'color:var(--ink-3);font-size:var(--fs-sm)' },
      { id: 'vulns', label: '脆弱性', width: 72, text: (a) => String(issueCounts[a.assetKey] ?? 0), sortValue: (a) => issueCounts[a.assetKey] ?? 0 },
      { id: 'updatedAt', label: '更新', width: 150, text: (a) => fmtDate(a.updatedAt) || '', sortValue: (a) => a.updatedAt ?? '', cellStyle: 'color:var(--ink-3);font-size:var(--fs-sm)' },
    ];
  }

  void load();

  async function load(): Promise<void> {
    clear(tableWrap);
    tableWrap.appendChild(el('div', { class: 'mikke-empty' }, ['読み込み中…']));
    try {
      const settings = await getRepo().getSettings();
      const cols = resolveAssetColumns(settings);
      [assets, issues] = await Promise.all([getRepo().listAssets(), getRepo().listIssues()]);
      // 既存の資産キーに区切り文字 (| , ; 空白) が混入している行を分割して掃除する。
      if (await cleanupDelimitedAssets()) assets = await getRepo().listAssets();
      const ids = new Set(assets.map((a) => a.id));
      for (const id of [...selected]) if (!ids.has(id)) selected.delete(id);
      issueCounts = countIssuesByAsset(issues, cols);
      paint();
    } catch (e) {
      clear(tableWrap);
      tableWrap.appendChild(el('div', { class: 'mikke-error' }, [
        `資産一覧の取得に失敗しました: ${(e as Error).message}`,
      ]));
    }
  }

  /** 資産キーの整理: ①区切り文字(| , ; 空白)入りを個別資産に分割 ②同一キーの重複を
   *  1 件に統合。分割・統合を行った場合 true (呼び出し側で再取得)。 */
  async function cleanupDelimitedAssets(): Promise<boolean> {
    const isDirty = (k: string): boolean => /[|,;\s　]/.test(k);
    let changed = false;

    // ① 区切り文字入りキーを分割
    const dirty = assets.filter((a) => isDirty(a.assetKey));
    if (dirty.length) {
      const existing = new Set(assets.filter((a) => !isDirty(a.assetKey)).map((a) => a.assetKey));
      let added = 0, removed = 0;
      for (const a of dirty) {
        for (const key of splitAssetCell(a.assetKey)) {
          if (existing.has(key)) continue;
          existing.add(key);
          try {
            await getRepo().createAsset({
              assetKey: key, assetType: assetTypeOf(key),
              businessCompany: a.businessCompany, affiliateCompany: a.affiliateCompany,
              mgmtNumber: a.mgmtNumber, identifyReason: a.identifyReason, identifyEvidence: a.identifyEvidence,
              updatedAt: new Date().toISOString(),
            });
            added++;
          } catch { /* 個別失敗はスキップ */ }
        }
        try { await getRepo().deleteAsset(a.id); removed++; } catch { /* noop */ }
      }
      toast(rootEl, `区切り文字入りの資産キーを整理しました: ${removed} 件を分割し ${added} 件に展開。`, 'ok', 6000);
      changed = true;
      assets = await getRepo().listAssets();   // 分割結果で最新化してから重複統合
    }

    // ② 同一 assetKey の重複を統合 (管理情報が最も充実した 1 件を残し他を削除)
    const byKey = new Map<string, ManagedAsset[]>();
    for (const a of assets) { const g = byKey.get(a.assetKey) ?? []; g.push(a); byKey.set(a.assetKey, g); }
    const infoScore = (a: ManagedAsset): number =>
      [a.businessCompany, a.affiliateCompany, a.mgmtNumber, a.identifyReason, a.identifyEvidence].filter((v) => (v ?? '').trim()).length;
    let dupRemoved = 0;
    for (const group of byKey.values()) {
      if (group.length < 2) continue;
      // 情報量が多い→更新が新しい→id 小 の順で残す
      group.sort((x, y) => infoScore(y) - infoScore(x) || (y.updatedAt ?? '').localeCompare(x.updatedAt ?? '') || x.id - y.id);
      for (const dup of group.slice(1)) {
        try { await getRepo().deleteAsset(dup.id); dupRemoved++; } catch { /* noop */ }
      }
    }
    if (dupRemoved) {
      toast(rootEl, `重複していた資産を統合しました: ${dupRemoved} 件を削除。`, 'ok', 6000);
      changed = true;
    }
    return changed;
  }

  function searchFiltered(): ManagedAsset[] {
    const q = query.trim().toLowerCase();
    return q
      ? assets.filter((a) => `${a.assetKey} ${a.businessCompany ?? ''} ${a.affiliateCompany ?? ''} ${a.mgmtNumber ?? ''}`.toLowerCase().includes(q))
      : assets;
  }

  function updateSubbar(): void {
    clear(subbar);
    subbar.appendChild(el('span', { class: 'mikke-subbar-title' }, ['資産管理']));
    const sel = selected.size;
    if (sel === 0) {
      subbar.appendChild(el('span', { class: 'mikke-subbar-count' }, [`${visibleCount} / ${assets.length} 件`]));
      return;
    }
    subbar.append(
      el('span', { class: 'mikke-subbar-count', style: 'color:var(--accent-strong);font-weight:600' }, [`${sel} 件選択`]),
      el('button', {
        class: 'mikke-btn mikke-btn--danger', style: 'height:28px;padding:0 var(--s-5);font-size:var(--fs-sm)',
        ...(busy ? { disabled: 'disabled' } : {}),
        onclick: () => bulkDeleteAssets(),
      }, ['削除']),
      el('button', {
        class: 'mikke-btn mikke-btn--ghost', style: 'height:28px;padding:0 var(--s-4);font-size:var(--fs-sm)',
        ...(busy ? { disabled: 'disabled' } : {}),
        onclick: () => { selected.clear(); table.render(); updateSubbar(); },
      }, ['選択解除']),
    );
  }

  // ── 一括削除 (選択した資産・管理情報を完全削除) ──────────────────────────────
  function bulkDeleteAssets(): void {
    const ids = [...selected];
    if (!ids.length) return;
    const body = el('div', { style: 'line-height:1.7' }, [
      `選択中の ${ids.length} 件の資産を削除します（事業会社・関連会社・管理番号などの管理情報も削除）。`,
      el('br'),
      el('span', { style: 'color:var(--danger)' }, ['元に戻せません。']),
    ]);
    openModal(rootEl, {
      title: '資産を削除', body, primaryLabel: `削除する (${ids.length} 件)`, primaryVariant: 'danger',
      onPrimary: async () => {
        busy = true;
        let ok = 0, fail = 0;
        for (const id of ids) { try { await getRepo().deleteAsset(id); ok++; } catch { fail++; } }
        busy = false;
        toast(rootEl, `削除: ${ok} 件${fail ? ` / 失敗 ${fail} 件` : ''}`, fail ? 'warn' : 'ok');
        selected.clear();
        await load();
      },
    });
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
      el('span', { html: icon('building'), style: 'color:var(--ink-3);display:inline-flex' }),
      el('input', {
        class: 'mikke-input', type: 'text', placeholder: '資産 / 会社 / 管理番号で検索',
        value: query, style: 'min-width:200px;border:1px solid var(--line)',
        oninput: (e: Event) => { query = (e.target as HTMLInputElement).value; refresh(); },
      }),
      wrapBtn,
      ...(clearBtn ? [clearBtn] : []),
      el('span', { style: 'display:inline-flex;gap:var(--s-3)' }, [
        el('button', {
          class: 'mikke-btn mikke-btn--secondary', style: 'height:30px;font-size:var(--fs-sm)',
          ...(busy ? { disabled: 'disabled' } : {}),
          onclick: () => openImportModal(),
          html: icon('upload') + '<span>インポート</span>',
        }),
        exportMenu(),
      ]),
      el('span', { style: 'margin-left:auto;display:inline-flex;gap:var(--s-3)' }, [
        el('button', {
          class: 'mikke-btn mikke-btn--secondary', style: 'height:30px;font-size:var(--fs-sm)',
          ...(busy ? { disabled: 'disabled' } : {}),
          onclick: () => openExtractModal(),
        }, ['脆弱性から資産を抽出']),
        el('button', {
          class: 'mikke-btn mikke-btn--primary', style: 'height:30px;font-size:var(--fs-sm)',
          ...(busy ? { disabled: 'disabled' } : {}),
          onclick: () => openDeptCsvModal(),
        }, ['管理部門CSVを取込']),
      ]),
    );

    if (assets.length === 0) {
      clear(tableWrap);
      tableWrap.appendChild(el('div', { class: 'mikke-empty' }, [
        el('div', { class: 'mikke-empty-title' }, ['資産がありません']),
        el('div', {}, ['「脆弱性から資産を抽出」を実行すると、管理対象の脆弱性から FQDN / IP 単位の資産一覧を作成します。']),
      ]));
      return;
    }
    refresh();
  }

  /** 検索を反映して表を再描画。 */
  function refresh(): void {
    if (assets.length === 0) return;
    table.setColumns(assetColumns());
    table.setRows(searchFiltered());
    table.render();
  }

  // ── エクスポート (CSV / Excel) ───────────────────────────────────────────────
  function assetToRecord(a: ManagedAsset): Record<string, string> {
    return {
      '資産': a.assetKey,
      '種別': a.assetType,
      '事業会社': a.businessCompany ?? '',
      '関連会社': a.affiliateCompany ?? '',
      '管理番号': a.mgmtNumber ?? '',
      '特定理由': a.identifyReason ?? '',
      '特定根拠': a.identifyEvidence ?? '',
      '脆弱性件数': String(issueCounts[a.assetKey] ?? 0),
      '更新日時': a.updatedAt ?? '',
    };
  }

  function doExport(fmt: 'csv' | 'xlsx'): void {
    if (!assets.length) { toast(rootEl, 'エクスポートする資産がありません。', 'warn'); return; }
    const recs = assets.map(assetToRecord);
    const stamp = new Date().toISOString().slice(0, 10);
    if (fmt === 'csv') {
      downloadFile(`資産管理_${stamp}.csv`, new Blob([toCsv(EXPORT_HEADERS, recs)], { type: 'text/csv;charset=utf-8' }));
    } else {
      downloadFile(`資産管理_${stamp}.xlsx`, buildXlsxBlob(EXPORT_HEADERS, recs, '資産管理'));
    }
    toast(rootEl, `${assets.length} 件を ${fmt === 'csv' ? 'CSV' : 'Excel'} でエクスポートしました。`, 'ok');
  }

  /** エクスポート形式を選ぶドロップダウン。 */
  function exportMenu(): HTMLElement {
    const btn = el('button', {
      class: 'mikke-btn mikke-btn--secondary', style: 'height:30px;font-size:var(--fs-sm)',
    }, [el('span', { html: icon('external') }), el('span', {}, ['エクスポート']),
      el('span', { html: icon('chevronDown'), style: 'display:inline-flex;width:14px' })]);
    const item = (label: string, fmt: 'csv' | 'xlsx'): HTMLElement => el('button', {
      class: 'mikke-menu-item', onclick: () => { menu.style.display = 'none'; doExport(fmt); },
    }, [label]);
    const menu = el('div', {
      style: 'position:absolute;right:0;z-index:20;margin-top:2px;background:var(--paper);border:1px solid var(--line);'
        + 'border-radius:var(--r-2);box-shadow:var(--shadow-flyout);padding:var(--s-2);display:none;min-width:150px',
    }, [item('CSV (.csv)', 'csv'), item('Excel (.xlsx)', 'xlsx')]);
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
    });
    document.addEventListener('click', () => { menu.style.display = 'none'; }, { once: true });
    return el('div', { style: 'position:relative;display:inline-block' }, [btn, menu]);
  }

  // ── インポート (CSV / Excel) ─────────────────────────────────────────────────
  // ファイルダイアログを直接開き、選択後に取込内容の確認モーダルを出す。
  function openImportModal(): void {
    const input = el('input', { type: 'file', accept: '.csv,.xlsx,text/csv', style: 'display:none' }) as HTMLInputElement;
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      input.remove();
      if (file) void handleImportFile(file);
    });
    document.body.appendChild(input);
    input.click();
  }

  async function handleImportFile(file: File): Promise<void> {
    let sheet;
    try {
      sheet = await parseSpreadsheetFile(file);
    } catch (e) {
      toast(rootEl, `ファイルを読み込めませんでした: ${(e as Error).message}`, 'error');
      return;
    }
    if (!sheet.headers.length) { toast(rootEl, 'ヘッダを読み取れませんでした。', 'error'); return; }
    const has = (name: string): boolean => sheet.headers.some((h) => normHeader(h) === name);
    const pick = (row: Record<string, string>, name: string): string => {
      for (const [k, v] of Object.entries(row)) if (normHeader(k) === name) return (v ?? '').trim();
      return '';
    };
    if (!has('資産')) { toast(rootEl, '「資産」列が見つかりません。', 'error'); return; }
    const presentFields = IMPORT_FIELDS.filter((f) => has(f.header));

    const byKey = new Map(assets.map((a) => [a.assetKey, a]));
    const creates: Omit<ManagedAsset, 'id'>[] = [];
    type FieldChange = { label: string; from: string; to: string };
    const updates: { id: number; assetKey: string; patch: Partial<ManagedAsset>; changes: FieldChange[] }[] = [];
    const createdKeys = new Set<string>();   // 同一取込内の重複 create を防ぐ
    let skipped = 0, unchanged = 0;
    for (const row of sheet.rows) {
      // 1 セルに | 等で複数の FQDN/IP が入っていても個別資産として取り込む。
      const keys = splitAssetCell(pick(row, '資産'));
      if (!keys.length) { skipped++; continue; }
      const fields: Partial<ManagedAsset> = {};
      for (const f of presentFields) fields[f.field] = pick(row, f.header);
      const typeRaw = pick(row, '種別').toUpperCase();
      for (const key of keys) {
        const cur = byKey.get(key);
        if (cur) {
          if (!presentFields.length) { skipped++; continue; }
          // 実際に値が変わる列だけを差分として抽出 (from → to)。
          const patch: Partial<ManagedAsset> = {};
          const changes: FieldChange[] = [];
          for (const f of presentFields) {
            const to = (fields[f.field] as string) ?? '';
            const from = (cur[f.field] as string | undefined) ?? '';
            if (from !== to) { changes.push({ label: f.header, from, to }); (patch as Record<string, string>)[f.field] = to; }
          }
          if (!changes.length) { unchanged++; continue; }   // 変更なしはスキップ
          patch.updatedAt = new Date().toISOString();
          updates.push({ id: cur.id, assetKey: key, patch, changes });
        } else if (!createdKeys.has(key)) {
          createdKeys.add(key);
          creates.push({
            assetKey: key,
            // 複数値セルの「種別」は資産キーから自動判定 (混在するため列値は使わない)
            assetType: keys.length > 1 ? assetTypeOf(key) : (typeRaw === 'IP' ? 'IP' : typeRaw === 'FQDN' ? 'FQDN' : assetTypeOf(key)),
            ...fields,
            updatedAt: new Date().toISOString(),
          });
        }
      }
    }
    if (!creates.length && !updates.length) {
      toast(rootEl, `更新対象の変更がありませんでした（変更なし ${unchanged} / スキップ ${skipped}）。`, 'warn', 6000);
      return;
    }

    const CAP = 200;
    const disp = (s: string): string => s || '（空）';
    const sectionTitle = (t: string): HTMLElement => el('div', { style: 'font-weight:600;margin:var(--s-4) 0 var(--s-2)' }, [t]);
    const parts: HTMLElement[] = [
      el('p', { style: 'margin:0;line-height:1.8' }, [
        `ファイル「${file.name}」から取り込みます。`, el('br'),
        `新規追加 ${creates.length} 件 / 更新 ${updates.length} 件`,
        ...(unchanged ? [`（変更なし ${unchanged}）`] : []),
        ...(skipped ? [`／スキップ ${skipped}` ] : []),
      ]),
    ];
    if (updates.length) {
      parts.push(sectionTitle(`更新される資産 (${updates.length} 件) — どの項目を書き換えるか`));
      const thead = el('thead', {}, [el('tr', {}, [el('th', {}, ['資産']), el('th', {}, ['変更内容 (現在 → 取込)'])])]);
      const tbody = el('tbody', {}, updates.slice(0, CAP).map((u) => el('tr', {}, [
        el('td', { style: 'font-family:var(--font-mono);font-size:var(--fs-sm);white-space:nowrap' }, [u.assetKey]),
        el('td', { style: 'font-size:var(--fs-sm)' }, u.changes.map((c) =>
          el('div', {}, [
            el('span', { style: 'color:var(--ink-3)' }, [`${c.label}: `]),
            el('span', { style: 'text-decoration:line-through;color:var(--ink-4)' }, [disp(c.from)]),
            ' → ',
            el('span', { style: 'color:var(--accent-strong);font-weight:600' }, [disp(c.to)]),
          ]))),
      ])));
      parts.push(el('div', { class: 'mikke-table-wrap', style: 'padding:0;max-height:280px' }, [el('table', { class: 'mikke-table' }, [thead, tbody])]));
      if (updates.length > CAP) parts.push(el('p', { style: 'color:var(--ink-4);font-size:var(--fs-sm)' }, [`(先頭 ${CAP} 件を表示。残り ${updates.length - CAP} 件も更新されます)`]));
    }
    if (creates.length) {
      parts.push(sectionTitle(`新規追加される資産 (${creates.length} 件)`));
      const thead = el('thead', {}, [el('tr', {}, [el('th', {}, ['資産']), el('th', {}, ['種別']), el('th', {}, ['事業会社']), el('th', {}, ['関連会社']), el('th', {}, ['管理番号'])])]);
      const tbody = el('tbody', {}, creates.slice(0, CAP).map((c) => el('tr', {}, [
        el('td', { style: 'font-family:var(--font-mono);font-size:var(--fs-sm)' }, [c.assetKey]),
        el('td', {}, [c.assetType]),
        el('td', {}, [disp(c.businessCompany ?? '')]),
        el('td', {}, [disp(c.affiliateCompany ?? '')]),
        el('td', {}, [disp(c.mgmtNumber ?? '')]),
      ])));
      parts.push(el('div', { class: 'mikke-table-wrap', style: 'padding:0;max-height:220px' }, [el('table', { class: 'mikke-table' }, [thead, tbody])]));
      if (creates.length > CAP) parts.push(el('p', { style: 'color:var(--ink-4);font-size:var(--fs-sm)' }, [`(先頭 ${CAP} 件を表示。残り ${creates.length - CAP} 件も追加されます)`]));
    }

    openModal(rootEl, {
      title: 'インポート内容の確認',
      body: el('div', {}, parts),
      size: 'xl',
      primaryLabel: `取り込む (${creates.length + updates.length} 件)`,
      onPrimary: async () => {
        busy = true;
        let ok = 0, fail = 0;
        for (const c of creates) { try { await getRepo().createAsset(c); ok++; } catch { fail++; } }
        for (const u of updates) { try { await getRepo().updateAsset(u.id, u.patch); ok++; } catch { fail++; } }
        busy = false;
        toast(rootEl, `インポート完了: ${ok} 件${fail ? ` / 失敗 ${fail} 件` : ''}`, fail ? 'warn' : 'ok', 5000);
        await load();
      },
    });
  }

  // ── 脆弱性から資産を抽出 ────────────────────────────────────────────────────
  function openExtractModal(): void {
    void (async () => {
      const settings = await getRepo().getSettings();
      const selected = new Set(resolveAssetColumns(settings));
      // 候補列: 実 CSV ヘッダ (無ければ現在の選択)。IP/FQDN 列を複数選べる。
      const candidates = (settings.lastCsvHeaders ?? []).slice();
      for (const c of selected) if (!candidates.includes(c)) candidates.push(c);

      const listWrap = el('div', {
        style: 'max-height:260px;overflow:auto;border:1px solid var(--line);border-radius:var(--r-2);padding:var(--s-3)',
      });
      const rowOf = (h: string): HTMLElement => {
        const cb = el('input', { type: 'checkbox', ...(selected.has(h) ? { checked: 'checked' } : {}),
          onchange: (e: Event) => { (e.target as HTMLInputElement).checked ? selected.add(h) : selected.delete(h); },
        }) as HTMLInputElement;
        return el('label', {
          class: 'mikke-check-row',
          style: 'display:flex;gap:var(--s-3);align-items:center;padding:var(--s-2) var(--s-3);cursor:pointer',
        }, [cb, el('span', {}, [h])]);
      };
      const renderList = (filter: string): void => {
        clear(listWrap);
        const f = filter.trim().toLowerCase();
        const shown = f ? candidates.filter((h) => h.toLowerCase().includes(f)) : candidates;
        if (!shown.length) { listWrap.appendChild(el('div', { class: 'mikke-empty' }, ['該当する列がありません'])); return; }
        for (const h of shown) listWrap.appendChild(rowOf(h));
      };
      const filterInput = el('input', {
        class: 'mikke-input', type: 'text', placeholder: '列名で絞り込み (例: IP / FQDN / Asset)',
        style: 'width:100%;border:1px solid var(--line);margin-bottom:var(--s-3)',
        oninput: (e: Event) => renderList((e.target as HTMLInputElement).value),
      });
      renderList('');

      const body = el('div', {}, [
        el('p', { style: 'margin:0 0 var(--s-4);line-height:1.7;color:var(--ink-2)' }, [
          '管理対象の脆弱性から、資産 (FQDN / IP) をユニークに抽出して資産一覧へ追加します。',
          el('b', {}, ['資産が入っている列を複数選択']),
          'できます (例: FQDN 列と IP 列)。1 セルに ',
          el('code', {}, ['|']),
          ' 等で複数値がある場合はそれぞれ個別の資産として登録します。既存の資産はそのまま残ります。',
        ]),
        el('div', { class: 'mikke-field' }, [
          el('label', { class: 'mikke-field-label' }, ['資産が入っている列 (複数選択可)']),
          filterInput,
          listWrap,
        ]),
      ]);
      openModal(rootEl, {
        title: '脆弱性から資産を抽出',
        body,
        size: 'lg',
        primaryLabel: '抽出する',
        onPrimary: async () => {
          const cols = [...selected];
          if (!cols.length) { toast(rootEl, '資産が入っている列を 1 つ以上選択してください。', 'warn'); throw new Error('no column'); }
          await getRepo().saveSettings({ ...settings, assetColumns: cols }).catch(() => { /* noop */ });
          const { keys } = extractAssets(issues, cols);
          const existing = new Set(assets.map((a) => a.assetKey));
          const fresh = keys.filter((k) => !existing.has(k));
          let added = 0;
          for (const k of fresh) {
            try {
              await getRepo().createAsset({ assetKey: k, assetType: assetTypeOf(k), updatedAt: new Date().toISOString() });
              added++;
            } catch { /* 個別失敗はスキップ */ }
          }
          toast(rootEl, `資産を抽出しました: ${added} 件追加 (全 ${keys.length} 資産 / 既存 ${keys.length - fresh.length} 件)`, 'ok', 5000);
          await load();
        },
      });
    })();
  }

  // ── 管理部門 CSV (基本情報 + サイトURL情報) の取込 ─────────────────────────────
  // ヘッダから2種類の管理部門ファイルを自動判別する。
  //  基本情報: 一行目(ヘッダ) の B 列 が「並び順」/ サイトURL情報: ヘッダに「サイト名称」。
  function detectDeptKind(sheet: Sheet): 'base' | 'site' | null {
    const norm = (h: string): string => (h ?? '').replace(/[\s　]+/g, '');
    const headers = sheet.headers.map(norm);
    if (headers.includes('サイト名称')) return 'site';
    if (norm(sheet.headers[1] ?? '') === '並び順' || headers.includes('並び順')) return 'base';
    return null;
  }

  function openDeptCsvModal(): void {
    let baseSheet: Sheet | null = null, siteSheet: Sheet | null = null;
    let baseName = '', siteName = '';

    const statRow = (label: string): HTMLElement => el('div', {
      class: 'mikke-deptfile-stat', style: 'display:flex;align-items:center;gap:var(--s-3);padding:var(--s-2) 0',
    }, [el('span', { style: 'min-width:120px;color:var(--ink-2)' }, [label]), el('span', { class: 'mikke-deptfile-val', style: 'color:var(--ink-4)' }, ['未取込'])]);
    const baseStat = statRow('基本情報');
    const siteStat = statRow('サイトURL情報');
    const setVal = (row: HTMLElement, name: string): void => {
      const v = row.querySelector('.mikke-deptfile-val') as HTMLElement;
      v.textContent = name ? `${name} ✓` : '未取込';
      v.style.color = name ? 'var(--accent-strong)' : 'var(--ink-4)';
      v.style.fontWeight = name ? '600' : '400';
    };

    const drop = el('div', { class: 'mikke-hist-drop', style: 'margin:var(--s-4) 0' }, [
      el('div', {}, [
        el('span', { html: icon('upload'), style: 'display:inline-flex;vertical-align:-2px;margin-right:6px' }),
        'ここに管理部門リスト (CSV / Excel) をドラッグ',
      ]),
      el('div', { style: 'color:var(--ink-4);font-size:var(--fs-xs);margin-top:4px' }, ['2 ファイル同時OK・種類は自動判別（基本情報=B列「並び順」／URL=ヘッダ「サイト名称」）。クリックで選択も可']),
    ]);
    const fileInput = el('input', { type: 'file', accept: '.csv,.xlsx,text/csv', multiple: 'multiple', style: 'display:none' }) as HTMLInputElement;

    const ingest = async (files: File[]): Promise<void> => {
      for (const f of files) {
        let sheet: Sheet;
        try { sheet = await parseSpreadsheetFile(f); } catch { toast(rootEl, `「${f.name}」を読み込めませんでした。`, 'error'); continue; }
        if (!sheet.headers.length) { toast(rootEl, `「${f.name}」のヘッダを読み取れませんでした。`, 'warn'); continue; }
        const kind = detectDeptKind(sheet);
        if (kind === 'base') { baseSheet = sheet; baseName = f.name; setVal(baseStat, baseName); }
        else if (kind === 'site') { siteSheet = sheet; siteName = f.name; setVal(siteStat, siteName); }
        else { toast(rootEl, `「${f.name}」は種類を判別できませんでした（基本情報=B列「並び順」／URL=ヘッダ「サイト名称」）。`, 'warn', 7000); }
      }
    };

    drop.addEventListener('dragover', (e) => { e.preventDefault(); if ((e as DragEvent).dataTransfer) (e as DragEvent).dataTransfer!.dropEffect = 'copy'; drop.classList.add('is-over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('is-over'));
    drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('is-over'); void ingest([...((e as DragEvent).dataTransfer?.files ?? [])]); });
    drop.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => { void ingest([...(fileInput.files ?? [])]); fileInput.value = ''; });

    const body = el('div', {}, [
      el('p', { style: 'margin:0 0 var(--s-4);line-height:1.7;color:var(--ink-2)' }, [
        '社内の資産管理部門リスト (2種) を読み込み、FQDN が一致した資産の',
        el('b', {}, ['事業会社・関連会社・Web資産管理番号']),
        ' を更新します。1 行目 = 列名、2 行目 = 列の説明 (読み飛ばし)、3 行目以降 = 値。',
      ]),
      drop, fileInput,
      el('div', { style: 'margin:var(--s-3) 0' }, [baseStat, siteStat]),
      el('p', { style: 'margin:var(--s-3) 0 0;color:var(--ink-4);font-size:var(--fs-xs);line-height:1.6' }, [
        '同一脆弱性に紐づく資産 (例: FQDN と IP) のうち 1 つでも FQDN 一致で特定できた場合、',
        '残りの資産にも同じ事業会社・関連会社・管理番号を引き継ぎます (根拠に明記)。',
      ]),
    ]);
    openModal(rootEl, {
      title: '管理部門CSVを取込',
      body,
      primaryLabel: '突合する',
      onPrimary: async () => {
        if (!baseSheet || !siteSheet) {
          toast(rootEl, `基本情報とサイトURL情報の両方が必要です（現在: 基本情報=${baseSheet ? '取込済' : '未'} / URL=${siteSheet ? '取込済' : '未'}）。`, 'warn', 6000);
          throw new Error('files required');
        }
        const settings = await getRepo().getSettings();
        const { groups } = extractAssets(issues, resolveAssetColumns(settings));
        const dir = buildAssetDirectory(baseSheet, siteSheet);
        const plan = matchAssets(assets, dir, new Date().toISOString(), groups);
        if (plan.length === 0) {
          toast(rootEl, `FQDN が一致する資産はありませんでした (部門リスト側 ${dir.size} FQDN)。`, 'warn', 6000);
          return;
        }
        openMatchPreview(plan, dir.size);
      },
    });
  }

  /** 突合プレビュー → 確定で更新。 */
  function openMatchPreview(plan: ReturnType<typeof matchAssets>, dirSize: number): void {
    const propagatedCount = plan.filter((p) => p.patch.identifyReason === '同一脆弱性の関連資産から特定').length;
    const thead = el('thead', {}, [el('tr', {}, [
      el('th', {}, ['資産']), el('th', {}, ['種別']), el('th', {}, ['管理番号']), el('th', {}, ['事業会社']), el('th', {}, ['関連会社']), el('th', {}, ['特定理由']),
    ])]);
    const tbody = el('tbody', {}, plan.slice(0, 100).map(({ asset, patch }) => el('tr', {}, [
      el('td', { style: 'font-family:var(--font-mono);font-size:var(--fs-sm)' }, [asset.assetKey]),
      el('td', {}, [asset.assetType]),
      el('td', {}, [patch.mgmtNumber ?? '—']),
      el('td', {}, [patch.businessCompany || '—']),
      el('td', {}, [patch.affiliateCompany || '—']),
      el('td', { style: 'font-size:var(--fs-sm);color:var(--ink-3)' }, [
        patch.identifyReason === '同一脆弱性の関連資産から特定' ? '関連資産から伝播' : '直接一致',
      ]),
    ])));
    const body = el('div', {}, [
      el('p', { style: 'margin:0 0 var(--s-4);line-height:1.7' }, [
        `部門リスト側 ${dirSize} FQDN と突合し、${plan.length} 件の資産を更新します`,
        propagatedCount ? `（うち ${propagatedCount} 件は同一脆弱性の関連資産からの伝播）` : '',
        '。特定理由・根拠 (一致した FQDN / 管理番号、または伝播元の脆弱性と資産) を記録します。',
      ]),
      el('div', { class: 'mikke-table-wrap', style: 'padding:0;max-height:320px' }, [
        el('table', { class: 'mikke-table' }, [thead, tbody]),
      ]),
      ...(plan.length > 100 ? [el('p', { style: 'color:var(--ink-3);font-size:var(--fs-sm)' }, [`(先頭 100 件を表示。残り ${plan.length - 100} 件も更新されます)`])] : []),
    ]);
    openModal(rootEl, {
      title: '突合結果の確認',
      body,
      size: 'lg',
      primaryLabel: `更新する (${plan.length} 件)`,
      onPrimary: async () => {
        busy = true;
        let ok = 0, fail = 0;
        for (const { asset, patch } of plan) {
          try { await getRepo().updateAsset(asset.id, patch); ok++; } catch { fail++; }
        }
        busy = false;
        toast(rootEl, `資産管理情報を更新: ${ok} 件${fail ? ` / 失敗 ${fail} 件` : ''}`, fail ? 'warn' : 'ok', 5000);
        await load();
      },
    });
  }

  // ── 資産の編集モーダル (手動記入) ────────────────────────────────────────────
  function openAssetEditModal(a: ManagedAsset): void {
    const biz = el('input', { type: 'text', value: a.businessCompany ?? '' }) as HTMLInputElement;
    const aff = el('input', { type: 'text', value: a.affiliateCompany ?? '' }) as HTMLInputElement;
    const num = el('input', { type: 'text', value: a.mgmtNumber ?? '' }) as HTMLInputElement;
    const reason = el('textarea', { style: 'min-height:60px' }, [a.identifyReason ?? '']) as HTMLTextAreaElement;
    const evidence = el('textarea', { style: 'min-height:80px' }, [a.identifyEvidence ?? '']) as HTMLTextAreaElement;
    const field = (label: string, control: HTMLElement) =>
      el('div', { class: 'mikke-field' }, [el('label', { class: 'mikke-field-label' }, [label]), control]);
    const body = el('div', {}, [
      el('div', { class: 'mikke-field' }, [
        el('label', { class: 'mikke-field-label' }, ['資産 (変更不可)']),
        el('div', { style: 'font-family:var(--font-mono)' }, [`${a.assetKey} (${a.assetType})`]),
      ]),
      field('事業会社', biz),
      field('関連会社', aff),
      field('Web資産管理番号', num),
      field('特定理由', reason),
      field('特定根拠', evidence),
    ]);
    const handle = openModal(rootEl, {
      title: `資産の管理情報 — ${a.assetKey}`,
      body,
      size: 'lg',
      primaryLabel: '保存',
      footerLeft: [
        el('button', {
          class: 'mikke-btn mikke-btn--danger', type: 'button',
          onclick: () => {
            openModal(rootEl, {
              title: '資産を削除',
              body: el('div', { style: 'line-height:1.7' }, [
                `資産「${a.assetKey}」を管理情報ごと削除します。`, el('br'),
                el('span', { style: 'color:var(--danger)' }, ['元に戻せません。']),
              ]),
              primaryLabel: '削除する', primaryVariant: 'danger',
              onPrimary: async () => {
                try { await getRepo().deleteAsset(a.id); } catch (e) { toast(rootEl, `削除に失敗: ${(e as Error).message}`, 'error'); throw e; }
                toast(rootEl, '削除しました', 'ok');
                handle.close();
                await load();
              },
            });
          },
        }, ['削除']),
      ],
      onPrimary: async () => {
        try {
          await getRepo().updateAsset(a.id, {
            businessCompany: biz.value.trim(),
            affiliateCompany: aff.value.trim(),
            mgmtNumber: num.value.trim(),
            identifyReason: reason.value.trim(),
            identifyEvidence: evidence.value.trim(),
            updatedAt: new Date().toISOString(),
          });
        } catch (e) {
          toast(rootEl, `保存に失敗しました: ${(e as Error).message}`, 'error');
          throw e;
        }
        toast(rootEl, '保存しました', 'ok');
        await load();
      },
    });
  }

  return root;
}
