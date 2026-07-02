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
import { filePicker } from '../components/filePicker';
import { parseCsv } from '../lib/csv';
import {
  DEFAULT_ASSET_COLUMN, extractAssets, countIssuesByAsset, assetTypeOf,
  buildAssetDirectory, matchAssets,
} from '../lib/assets';
import type { ManagedAsset, ManagedIssue, MikkeSettings } from '../types';

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

  void load();

  async function load(): Promise<void> {
    clear(tableWrap);
    tableWrap.appendChild(el('div', { class: 'mikke-empty' }, ['読み込み中…']));
    try {
      const settings = await getRepo().getSettings();
      const cols = resolveAssetColumns(settings);
      [assets, issues] = await Promise.all([getRepo().listAssets(), getRepo().listIssues()]);
      issueCounts = countIssuesByAsset(issues, cols);
      paint();
    } catch (e) {
      clear(tableWrap);
      tableWrap.appendChild(el('div', { class: 'mikke-error' }, [
        `資産一覧の取得に失敗しました: ${(e as Error).message}`,
      ]));
    }
  }

  function filtered(): ManagedAsset[] {
    const q = query.toLowerCase();
    const rows = q
      ? assets.filter((a) => `${a.assetKey} ${a.businessCompany ?? ''} ${a.affiliateCompany ?? ''} ${a.mgmtNumber ?? ''}`.toLowerCase().includes(q))
      : assets;
    return [...rows].sort((a, b) => a.assetKey < b.assetKey ? -1 : a.assetKey > b.assetKey ? 1 : 0);
  }

  function paint(): void {
    const rows = filtered();

    clear(subbar);
    subbar.append(
      el('span', { class: 'mikke-subbar-title' }, ['資産管理']),
      el('span', { class: 'mikke-subbar-count' }, [`${rows.length} / ${assets.length} 件`]),
    );

    clear(toolbar);
    toolbar.append(
      el('span', { html: icon('building'), style: 'color:var(--ink-3);display:inline-flex' }),
      el('input', {
        class: 'mikke-input', type: 'text', placeholder: '資産 / 会社 / 管理番号で検索',
        value: query, style: 'min-width:220px;border:1px solid var(--line)',
        oninput: (e: Event) => { query = (e.target as HTMLInputElement).value; paint(); },
      }),
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

    clear(tableWrap);
    if (rows.length === 0) {
      tableWrap.appendChild(el('div', { class: 'mikke-empty' }, [
        el('div', { class: 'mikke-empty-title' }, ['資産がありません']),
        el('div', {}, ['「脆弱性から資産を抽出」を実行すると、管理対象の脆弱性から FQDN / IP 単位の資産一覧を作成します。']),
      ]));
      return;
    }
    const thead = el('thead', {}, [el('tr', {}, [
      el('th', {}, ['資産 (FQDN / IP)']),
      el('th', {}, ['種別']),
      el('th', {}, ['事業会社']),
      el('th', {}, ['関連会社']),
      el('th', {}, ['管理番号']),
      el('th', {}, ['特定理由']),
      el('th', {}, ['脆弱性']),
      el('th', {}, ['更新']),
    ])]);
    const tbody = el('tbody', {}, rows.map((a) => el('tr', {
      onclick: () => {
        const sel = window.getSelection();
        if (sel && sel.toString()) return;   // テキスト選択中は編集を開かない
        openAssetEditModal(a);
      },
    }, [
      el('td', { style: 'font-family:var(--font-mono);font-size:var(--fs-sm)' }, [a.assetKey]),
      el('td', {}, [el('span', { class: `mikke-badge${a.assetType === 'IP' ? ' mikke-badge--muted' : ' mikke-badge--accent'}` }, [a.assetType])]),
      el('td', {}, [a.businessCompany || '—']),
      el('td', {}, [a.affiliateCompany || '—']),
      el('td', {}, [a.mgmtNumber || '—']),
      el('td', { style: 'color:var(--ink-3);font-size:var(--fs-sm)' }, [a.identifyReason || '—']),
      el('td', {}, [String(issueCounts[a.assetKey] ?? 0)]),
      el('td', { style: 'color:var(--ink-3);font-size:var(--fs-sm)' }, [fmtDate(a.updatedAt) || '—']),
    ])));
    tableWrap.appendChild(el('table', { class: 'mikke-table' }, [thead, tbody]));
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
  function openDeptCsvModal(): void {
    const basePicker = filePicker({ accept: '.csv,text/csv', placeholder: '基本情報 CSV を選択' });
    const sitePicker = filePicker({ accept: '.csv,text/csv', placeholder: 'サイトURL情報 CSV を選択' });
    const body = el('div', {}, [
      el('p', { style: 'margin:0 0 var(--s-4);line-height:1.7;color:var(--ink-2)' }, [
        '社内の資産管理部門リスト (CSV 2種) を読み込み、FQDN が一致した資産の',
        el('b', {}, ['事業会社・関連会社・Web資産管理番号']),
        ' を更新します。1 行目 = 列名、2 行目 = 列の説明 (読み飛ばし)、3 行目以降 = 値。',
      ]),
      el('div', { class: 'mikke-field' }, [
        el('label', { class: 'mikke-field-label' }, ['基本情報 CSV（管理番号 / 組織区分 第１階層名 / 関係会社/事業場略称）']),
        basePicker.root,
      ]),
      el('div', { class: 'mikke-field' }, [
        el('label', { class: 'mikke-field-label' }, ['サイトURL情報 CSV（管理番号 / サブドメイン / ドメインネーム）']),
        sitePicker.root,
      ]),
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
        const baseFile = basePicker.getFile();
        const siteFile = sitePicker.getFile();
        if (!baseFile || !siteFile) {
          toast(rootEl, '基本情報とサイトURL情報の両方の CSV を選択してください。', 'warn');
          throw new Error('files required');
        }
        const base = parseCsv(await baseFile.text());
        const site = parseCsv(await siteFile.text());
        if (!base.headers.length || !site.headers.length) {
          toast(rootEl, 'CSV のヘッダを読み取れませんでした。', 'error');
          throw new Error('bad csv');
        }
        const settings = await getRepo().getSettings();
        const { groups } = extractAssets(issues, resolveAssetColumns(settings));
        const dir = buildAssetDirectory(base, site);
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
    openModal(rootEl, {
      title: `資産の管理情報 — ${a.assetKey}`,
      body,
      size: 'lg',
      primaryLabel: '保存',
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
