// F4: 管理対象脆弱性の一覧画面。subbar → toolbar → table の順 (UI ルール §1.2)。
// 表本体 (列フィルタ/全文表示/仮想スクロール/列リサイズ/列ドラッグ) は DataTable に委譲。
import { el, clear, fmtDate } from '../utils/dom';
import { icon } from '../icons';
import { getState, setState, setFilter } from '../state';
import { getRepo, getRepoMode } from '../api/repo';
import { isUndetected, nextDetectionWhenPresent, nextDetectionWhenAbsent } from '../lib/detection';
import { detectionBadge, mgmtBadge, severityBadge } from './badges';
import { resolveScanValue } from '../lib/scanName';
import { relayHealth, relayGetIssues, getRelayBase, type RelayIssueBatchItem } from '../api/relay';
import { openModal } from '../components/modal';
import { toast } from '../components/toast';
import { DataTable, type DataColumn } from './dataTable';
import { acquireAndStore, mergeAndStore, ALL_DOWNLOAD_TYPES, mapLimit, base64ToBytes } from '../lib/downloadFlow';
import { buildImportPlan, type ImportMode } from '../lib/import';
import { storeIssueReport, sampleIssueReport, issueReportFolder, isAdapterMissing } from '../lib/issueReport';
import type { ManagedIssue } from '../types';

/** 情報更新の並列数。relay 側 (/mikke/issues の runspace プール) と同じ値にする。
 *  ここを増やすなら relay の $MIKKE_ISSUES_MAX_PARALLEL も合わせること。 */
const REFRESH_PARALLEL = 5;

const SEVERITY_ORDER: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1, info: 0 };
const DETECTION_ORDER: Record<string, number> = { '新規': 5, '再検知': 4, '継続': 3, '未検出(New)': 2, '未検出': 1 };
const MGMT_ORDER: Record<string, number> = {
  '未通知': 7, '通知': 6, '対応中': 5, '対応済み': 4, 'リスク受容': 3, '過検出': 2, '対象外': 1,
};

export function renderIssueList(rootEl: HTMLElement): HTMLElement {
  const root = el('div', { class: 'mikke-main', style: 'display:flex;flex-direction:column' });
  const subbar = el('div', { class: 'mikke-subbar' });
  const toolbar = el('div', { class: 'mikke-toolbar' });
  const tableWrap = el('div', { class: 'mikke-table-wrap' });
  root.append(subbar, toolbar, tableWrap);

  let scanCols: string[] = [];
  let csvHeaders: string[] = [];
  let cache: ManagedIssue[] = [];
  let lastFiltered: ManagedIssue[] = [];
  const selected = new Set<number>();
  let bulkBusy = false;

  const table = new DataTable<ManagedIssue>(tableWrap, {
    storeKey: 'mikke.issues',
    columns: [],
    rowId: (i) => i.id,
    virtualMin: 40,
    onRowClick: (i) => openDetail(i.id),
    rowSelected: (i) => getState().selectedIssueId === i.id,
    selection: {
      checked: (i) => selected.has(i.id),
      onToggle: (i, on) => { on ? selected.add(i.id) : selected.delete(i.id); updateSubbar(); },
      onToggleAll: (on, visible) => { for (const i of visible) { on ? selected.add(i.id) : selected.delete(i.id); } updateSubbar(); table.render(); },
    },
    onVisibleChange: (v) => { lastFiltered = v as ManagedIssue[]; updateSubbar(); },
    emptyText: '該当する管理対象がありません。',
  });

  void load();

  async function load(): Promise<void> {
    clear(tableWrap);
    tableWrap.appendChild(el('div', { class: 'mikke-empty' }, ['読み込み中…']));
    try {
      const [all, settings] = await Promise.all([getRepo().listIssues(), getRepo().getSettings()]);
      scanCols = settings.managedColumns.map((c) => (c.startsWith('Scan_') ? c : `Scan_${c}`));
      csvHeaders = settings.lastCsvHeaders ?? [];
      cache = all;
      const ids = new Set(all.map((i) => i.id));
      for (const id of [...selected]) if (!ids.has(id)) selected.delete(id);
      setState({ issueCount: all.length }, { silent: true });
      table.setColumns(buildColumns());
      paint();
    } catch (e) {
      clear(tableWrap);
      tableWrap.appendChild(el('div', { class: 'mikke-error' }, [
        `一覧の取得に失敗しました: ${(e as Error).message}`,
      ]));
    }
  }

  // ── 一括更新: 検査ツールから全レポートを取得し、脆弱性レポートで反映 ──────────
  function bulkUpdate(mode: ImportMode): void {
    if (bulkBusy) return;
    const label = mode === 'fixed' ? '固定モード' : '追加モード';
    const desc = mode === 'fixed'
      ? '新規の脆弱性は追加しません。既存の検知中のステータスは据え置き、今回のデータで消えた検知系のみ「未検出(New)」に変更します。ステータス以外の項目は取得データで更新します。'
      : '新たに条件一致した脆弱性を追加し、既存のステータスも標準ルール（継続/再検知/未検出化）で更新します。';
    openModal(rootEl, {
      title: `一括更新（${label}）`,
      body: el('div', { style: 'line-height:1.8' }, [
        el('p', { style: 'margin:0 0 var(--s-3)' }, [
          '検査ツールから ', el('b', {}, ['全資産および脆弱性のレポート']), ' を取得して「ダウンロードデータ」に保存し、',
          'それらを突合した ', el('b', {}, ['マージ CSV']), ' を生成して取り込みます。',
        ]),
        el('p', { style: 'margin:0;color:var(--ink-2)' }, [desc]),
      ]),
      primaryLabel: '取得して更新',
      onPrimary: async () => { await runBulkUpdate(mode); },
    });
  }

  async function runBulkUpdate(mode: ImportMode): Promise<void> {
    bulkBusy = true;
    try {
      // 1) 全レポート (脆弱性 + 資産各種) を取得 → SP 原本保存 → ダウンロード一覧に記録
      const res = await acquireAndStore(ALL_DOWNLOAD_TYPES);
      if (res.errors.length) {
        toast(rootEl, `一部レポートの保存に失敗 (成功 ${res.saved} / 失敗 ${res.errors.length}) — ${res.errors[0]}`, 'warn', 10000);
      }
      // 2) DL 済みファイルから「脆弱性＋資産」マージ CSV を生成 (relay /mikke/merge)。
      //    生成 CSV は通常の CSV 取込と同じ列構成。SP にも保存し一覧に記録される。
      const merged = await mergeAndStore(res.items, res.runFolder);
      const parsed = merged.parsed;
      if (!parsed.headers.length || !parsed.rows.length) {
        toast(rootEl, 'マージ CSV が空でした。レポートの保存のみ完了しました。', 'warn', 10000);
        return;
      }
      // 3) 取込計画 (モード反映) → 適用
      const [existing, settings] = await Promise.all([getRepo().listIssues(), getRepo().getSettings()]);
      const nowIso = new Date().toISOString();
      const plan = buildImportPlan(parsed.rows, parsed.headers, existing, settings, nowIso, mode);
      const { fail } = await getRepo().applyImportOps(plan.ops);
      await getRepo().saveSettings({ ...settings, lastCsvHeaders: parsed.headers }).catch(() => { /* noop */ });
      const s = plan.summary;
      toast(rootEl,
        `一括更新（${mode === 'fixed' ? '固定' : '追加'}）完了: 追加 ${s.added} / 更新 ${s.updated} / 未検出 ${s.undetected} / スキップ ${s.skipped}${fail ? ` / 失敗 ${fail}` : ''}`,
        fail ? 'warn' : 'ok', 12000);
    } catch (e) {
      toast(rootEl, `一括更新に失敗しました: ${(e as Error).message}`, 'error', 10000);
    } finally {
      bulkBusy = false;
      await load();
    }
  }

  function buildColumns(): DataColumn<ManagedIssue>[] {
    const cols: DataColumn<ManagedIssue>[] = [
      { id: 'title', label: 'Issue', width: 260, text: (i) => i.title ?? '', render: (i) => i.title || '(無題)' },
      { id: 'detection', label: '検知', width: 96, text: (i) => i.detectionStatus,
        sortValue: (i) => DETECTION_ORDER[i.detectionStatus] ?? 0, render: (i) => detectionBadge(i.detectionStatus) },
      { id: 'mgmt', label: '対応', width: 96, text: (i) => i.mgmtStatus,
        sortValue: (i) => MGMT_ORDER[i.mgmtStatus] ?? 0, render: (i) => mgmtBadge(i.mgmtStatus) },
      { id: 'severity', label: '深刻度', width: 92, text: (i) => i.severity ?? '',
        sortValue: (i) => SEVERITY_ORDER[(i.severity ?? '').toLowerCase()] ?? -1, render: (i) => severityBadge(i.severity) },
      { id: 'assignee', label: '担当', width: 120, text: (i) => i.assignee ?? '' },
      { id: 'due', label: '期限', width: 108, text: (i) => fmtDate(i.dueDate, false) || '' },
      // 「情報更新」で取得した個別レポート (zip)。行クリック (詳細を開く) と競合しないよう
      // リンク側で stopPropagation する。
      { id: 'report', label: 'レポート', width: 104,
        text: (i) => i.reportName ?? '',
        sortValue: (i) => i.reportAt ?? '',
        render: (i) => (i.reportUrl
          ? el('a', {
              href: '#', class: 'mikke-link',
              title: `${i.reportName ?? ''}${i.reportAt ? ` (${fmtDate(i.reportAt)})` : ''}`,
              onclick: (e: Event) => { e.preventDefault(); e.stopPropagation(); void openReport(i); },
            }, ['zip'])
          : '') },
    ];
    for (const c of scanCols) {
      cols.push({ id: `scan:${c}`, label: c.replace(/^Scan_/, ''), width: 160,
        text: (i) => resolveScanValue(i.scanFields, c, csvHeaders) || '', cellStyle: 'color:var(--ink-2)' });
    }
    cols.push({ id: 'synced', label: '最終同期', width: 150, text: (i) => fmtDate(i.lastSyncedAt) || '',
      sortValue: (i) => i.lastSyncedAt ?? '', cellStyle: 'color:var(--ink-3)' });
    return cols;
  }

  /** 既定の非表示 (対象外/過検出/未検出) + 検索。列フィルタは DataTable が担当。 */
  function baseFilter(all: ManagedIssue[]): ManagedIssue[] {
    const f = getState().filter;
    const q = f.query ? f.query.toLowerCase() : '';
    return all.filter((i) => {
      if (!f.showHidden) {
        if (i.isOutOfScope) return false;
        if (i.mgmtStatus === '過検出' || i.mgmtStatus === '対象外') return false;
        if (isUndetected(i.detectionStatus)) return false;
      }
      if (q) {
        const hay = `${i.title} ${i.issueInstanceId} ${i.assignee ?? ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }

  // ── subbar ────────────────────────────────────────────────────────────────
  function updateSubbar(): void {
    clear(subbar);
    const sel = selected.size;
    subbar.appendChild(el('span', { class: 'mikke-subbar-title' }, ['管理対象一覧']));
    if (sel === 0) {
      subbar.appendChild(el('span', { class: 'mikke-subbar-count' }, [`${lastFiltered.length} / ${cache.length} 件`]));
      return;
    }
    const refreshBtn = el('button', {
      class: 'mikke-btn mikke-btn--primary',
      style: 'height:28px;padding:0 var(--s-5);font-size:var(--fs-sm)',
      ...(bulkBusy ? { disabled: 'disabled' } : {}),
      onclick: () => void bulkRefresh(refreshBtn),
      html: icon('sync') + '<span>情報更新</span>',
    });
    subbar.append(
      el('span', { class: 'mikke-subbar-count', style: 'color:var(--accent-strong);font-weight:600' }, [`${sel} 件選択`]),
      refreshBtn,
      el('button', {
        class: 'mikke-btn mikke-btn--danger', style: 'height:28px;padding:0 var(--s-5);font-size:var(--fs-sm)',
        ...(bulkBusy ? { disabled: 'disabled' } : {}), onclick: () => bulkExclude(),
      }, ['管理対象から除外']),
      el('button', {
        class: 'mikke-btn mikke-btn--danger', style: 'height:28px;padding:0 var(--s-5);font-size:var(--fs-sm)',
        ...(bulkBusy ? { disabled: 'disabled' } : {}), onclick: () => bulkDelete(),
      }, ['削除']),
      el('button', {
        class: 'mikke-btn mikke-btn--ghost', style: 'height:28px;padding:0 var(--s-4);font-size:var(--fs-sm)',
        ...(bulkBusy ? { disabled: 'disabled' } : {}), onclick: () => { selected.clear(); table.render(); updateSubbar(); },
      }, ['選択解除']),
    );
  }

  // ── 一括アクション ────────────────────────────────────────────────────────
  function bulkExclude(): void {
    const ids = [...selected];
    if (!ids.length) return;
    const reasonTa = el('textarea', {
      placeholder: '除外の理由 (任意)',
      style: 'width:100%;min-height:80px;padding:var(--s-3);border:1px solid var(--line-strong);border-radius:var(--r-2)',
    }) as HTMLTextAreaElement;
    const body = el('div', {}, [
      el('p', { style: 'margin:0 0 var(--s-4);line-height:1.7' }, [
        `選択中の ${ids.length} 件を管理対象から除外します（対応ステータス=対象外）。`, el('br'),
        '一覧のデフォルト表示から隠れます（「対象外・過検出・未検出も表示」で再表示できます）。',
      ]),
      reasonTa,
    ]);
    openModal(rootEl, {
      title: '管理対象から除外', body, primaryLabel: `除外する (${ids.length} 件)`, primaryVariant: 'danger',
      onPrimary: async () => {
        const reason = reasonTa.value.trim() || '一括除外';
        let ok = 0, fail = 0;
        for (const id of ids) {
          try { await getRepo().updateIssue(id, { mgmtStatus: '対象外', isOutOfScope: true, outOfScopeReason: reason }); ok++; } catch { fail++; }
        }
        toast(rootEl, `除外: ${ok} 件${fail ? ` / 失敗 ${fail} 件` : ''}`, fail ? 'warn' : 'ok');
        selected.clear();
        await load();
      },
    });
  }

  function bulkDelete(): void {
    const ids = [...selected];
    if (!ids.length) return;
    const body = el('div', { style: 'line-height:1.7' }, [
      `選択中の ${ids.length} 件をリストから完全に削除します。`, el('br'),
      el('span', { style: 'color:var(--danger)' }, ['検知履歴・管理情報も含めて元に戻せません。']), el('br'),
      'データを残したまま一覧から隠す場合は「管理対象から除外」を使ってください。',
    ]);
    openModal(rootEl, {
      title: '完全に削除', body, primaryLabel: `削除する (${ids.length} 件)`, primaryVariant: 'danger',
      onPrimary: async () => {
        let ok = 0, fail = 0;
        for (const id of ids) { try { await getRepo().deleteIssue(id); ok++; } catch { fail++; } }
        toast(rootEl, `削除: ${ok} 件${fail ? ` / 失敗 ${fail} 件` : ''}`, fail ? 'warn' : 'ok');
        selected.clear();
        await load();
      },
    });
  }

  async function bulkRefresh(btn: HTMLElement): Promise<void> {
    const ids = [...selected];
    if (!ids.length || bulkBusy) return;
    // dev (mock) は relay を持たないので、ダウンロード取得と同じくサンプル応答で動かす。
    const devMock = getRepoMode() === 'mock';
    if (!devMock) {
      const h = await relayHealth();
      if (!h.ok) {
        // ★ どこへ繋ぎに行ったかを出す。既定は 18080 なので、別ポートで起動していると
        //   「起動しているのに繋がらない」状態になり、URL が無いと切り分けられない。
        toast(rootEl,
          `中継サーバに接続できません (${getRelayBase()})。mikke-launch.bat を実行するか、`
          + '設定 → 接続 の「中継サーバ ベース URL」を確認してください。', 'warn', 10000);
        return;
      }
    }
    bulkBusy = true;
    updateSubbar();
    // 検査ツールへの問い合わせは 1 件あたり数秒かかることがあるので、開始したことを
    // 明示する (ボタンの「更新中 n/N」だけだと押せたのか分かりにくい)。
    toast(rootEl,
      `検査ツールへ問い合わせています… ${ids.length} 件`
      + (ids.length > REFRESH_PARALLEL ? ` (${REFRESH_PARALLEL} 件ずつ並列)` : ''),
      'default', 4000);
    let ok = 0, fail = 0, firstErr = '';
    // レポートの内訳。アダプタ未実装なら以降は試さない (情報更新だけ続ける)。
    let report = 0, noItem = 0, reportFail = 0, reportSkipped = false;
    let firstReportErr = '';
    let done = 0;
    const runFolder = await issueReportFolder(new Date().toISOString());
    const progress = (): void => {
      const liveBtn = subbar.querySelector('.mikke-btn--primary');
      if (liveBtn) liveBtn.innerHTML = `${icon('sync')}<span>更新中 ${done}/${ids.length}…</span>`;
    };
    progress();

    /** 1 件ぶんの後処理 (SP 保存 + 添付 + 行の更新)。SP 側は同時実行して問題ない。 */
    const applyOne = async (issue: ManagedIssue, res: RelayIssueBatchItem): Promise<void> => {
      try {
        if (!res.ok) throw new Error(res.error || '取得に失敗しました');
        const patch: Partial<ManagedIssue> = {
          scannerStatus: res.scannerStatus, severity: res.severity, lastSeen: res.lastSeen,
          lastSyncedAt: new Date().toISOString(), scanFields: { ...issue.scanFields, ...(res.scanFields ?? {}) },
        };
        if (res.detected === true) {
          patch.detectionStatus = nextDetectionWhenPresent(issue.detectionStatus);
        } else if (res.detected === false) {
          const nd = nextDetectionWhenAbsent(issue.detectionStatus);
          patch.detectionStatus = nd;
          if (nd === '未検出(New)' && !issue.firstUndetectedAt) patch.firstUndetectedAt = new Date().toISOString();
        }
        if (res.reportSkipped) reportSkipped = true;
        if (res.reportError) { reportFail++; if (!firstReportErr) firstReportErr = res.reportError; }
        // レポートの保存・添付で失敗しても情報更新そのものは成功扱い (レポートは付随物)。
        const rep = devMock ? await sampleIssueReport(issue)
          : (res.report ? { fileName: res.report.fileName, bytes: base64ToBytes(res.report.contentBase64) } : null);
        if (rep) {
          try {
            const r = await storeIssueReport(issue, rep, runFolder);
            patch.reportUrl = r.url;
            patch.reportName = r.fileName;
            patch.reportAt = r.fetchedAt;
            report++;
            if (r.attach === 'no-item') noItem++;
            else if (r.attach === 'failed') { reportFail++; if (!firstReportErr) firstReportErr = r.attachError ?? ''; }
          } catch (e) {
            reportFail++;
            if (!firstReportErr) firstReportErr = (e as Error).message;
          }
        }
        await getRepo().updateIssue(issue.id, patch);
        ok++;
      } catch (e) {
        fail++;
        if (!firstErr) firstErr = (e as Error).message;
      } finally {
        done++;
        progress();
      }
    };

    try {
      // relay 内で REFRESH_PARALLEL 件ずつ並列取得されるので、同じ粒度で送る。
      for (let i = 0; i < ids.length; i += REFRESH_PARALLEL) {
        const chunk = ids.slice(i, i + REFRESH_PARALLEL)
          .map((id) => cache.find((x) => x.id === id))
          .filter((x): x is ManagedIssue => !!x);
        if (!chunk.length) continue;
        let results: RelayIssueBatchItem[];
        try {
          results = devMock
            ? chunk.map((issue) => ({
                issueInstanceId: issue.issueInstanceId, ok: true, scannerStatus: 'open',
                severity: issue.severity, lastSeen: new Date().toISOString(), detected: true,
              }))
            : await relayGetIssues(chunk.map((x) => x.issueInstanceId), !reportSkipped);
        } catch (e) {
          // チャンクごと失敗 (relay 停止・アダプタ未配置など)。未配置なら以降も同じなので中断。
          fail += chunk.length;
          done += chunk.length;
          if (!firstErr) firstErr = (e as Error).message;
          progress();
          if (isAdapterMissing(e)) break;
          continue;
        }
        const byId = new Map(results.map((r) => [r.issueInstanceId, r]));
        await mapLimit(chunk, REFRESH_PARALLEL, async (issue) => {
          const res = byId.get(issue.issueInstanceId);
          await applyOne(issue, res ?? { issueInstanceId: issue.issueInstanceId, ok: false, error: '応答に該当 ID がありません' });
        });
      }
    } finally { bulkBusy = false; }
    const parts = [`情報更新が完了しました: ${ok} 件成功`];
    if (fail) parts.push(`${fail} 件失敗`);
    if (report) parts.push(`レポート ${report} 件取得`);
    if (noItem) parts.push(`うち ${noItem} 件は連携用リストに該当アイテムなし`);
    if (reportFail) parts.push(`レポート ${reportFail} 件失敗`);
    if (reportSkipped) parts.push('レポート取得はアダプタ未配置のためスキップ');
    const detail = firstErr || firstReportErr;
    toast(rootEl, parts.join(' / ') + (detail ? ` — ${detail}` : ''),
      fail ? 'error' : (reportFail || reportSkipped ? 'warn' : 'ok'), fail || reportFail ? 12000 : 6000);
    await load();
    void btn;
  }

  // ── 描画 (toolbar + table) ────────────────────────────────────────────────
  function paint(): void {
    const f = getState().filter;
    updateSubbar();

    clear(toolbar);
    const search = el('input', {
      class: 'mikke-input', type: 'text', placeholder: 'タイトル / ID / 担当で検索',
      value: f.query, style: 'min-width:200px;border:1px solid var(--line)',
      oninput: (e: Event) => { setFilter({ query: (e.target as HTMLInputElement).value }, { silent: true }); refresh(); },
    });
    const wrapBtn = el('button', {
      class: table.isWrap() ? 'mikke-btn mikke-btn--primary' : 'mikke-btn mikke-btn--secondary',
      style: 'height:30px;font-size:var(--fs-sm)', title: '列幅で折り返して全文表示',
      onclick: () => { table.toggleWrap(); paint(); },
    }, ['全文表示']);
    const clearBtn = (table.hasActiveFilters() || f.query)
      ? el('button', {
          class: 'mikke-btn mikke-btn--ghost', style: 'height:30px;font-size:var(--fs-sm)',
          onclick: () => { table.clearFilters(); setFilter({ query: '' }, { silent: true }); paint(); },
        }, ['フィルタ解除'])
      : null;
    const hiddenToggle = el('label', {
      style: 'display:inline-flex;align-items:center;gap:6px;font-size:var(--fs-sm);color:var(--ink-3);cursor:pointer;margin-left:auto',
    }, [
      el('input', { type: 'checkbox', ...(f.showHidden ? { checked: 'checked' } : {}),
        onchange: (e: Event) => { setFilter({ showHidden: (e.target as HTMLInputElement).checked }, { silent: true }); refresh(); paint(); } }),
      '対象外・過検出・未検出も表示',
    ]);
    const bulkFixedBtn = el('button', {
      class: 'mikke-btn mikke-btn--secondary', style: 'height:30px;font-size:var(--fs-sm)',
      title: '検査ツールから全レポートを取得し、固定モードで反映（新規は追加せず・検知中は据え置き）',
      ...(bulkBusy ? { disabled: 'disabled' } : {}),
      onclick: () => bulkUpdate('fixed'),
      html: icon('download') + '<span>一括更新(固定)</span>',
    });
    const bulkAddBtn = el('button', {
      class: 'mikke-btn mikke-btn--primary', style: 'height:30px;font-size:var(--fs-sm)',
      title: '検査ツールから全レポートを取得し、追加モードで反映（新規追加＋全ステータス更新）',
      ...(bulkBusy ? { disabled: 'disabled' } : {}),
      onclick: () => bulkUpdate('add'),
      html: icon('download') + '<span>一括更新(追加)</span>',
    });
    toolbar.append(
      el('span', { html: icon('filter'), style: 'color:var(--ink-3);display:inline-flex' }),
      search, wrapBtn, ...(clearBtn ? [clearBtn] : []),
      el('span', { style: 'display:inline-flex;gap:var(--s-3)' }, [bulkFixedBtn, bulkAddBtn]),
      hiddenToggle,
    );

    if (cache.length === 0) { clear(tableWrap); tableWrap.appendChild(emptyState()); return; }
    refresh();
  }

  /** 検索/表示条件を反映して表を再描画 (toolbar は保持)。 */
  function refresh(): void {
    if (cache.length === 0) return;
    table.setRows(baseFilter(cache));
    table.render();
  }

  function emptyState(): HTMLElement {
    return el('div', { class: 'mikke-empty' }, [
      el('div', { class: 'mikke-empty-title' }, ['管理対象がありません']),
      el('div', {}, ['CSV を取り込むか、設定で管理対象条件を定義してください。']),
      el('div', { style: 'margin-top:var(--s-5)' }, [
        el('button', { class: 'mikke-btn mikke-btn--primary', onclick: () => setState({ view: 'import' }),
          html: icon('upload') + '<span>CSV を取込</span>' }),
      ]),
    ]);
  }

  /** 個別レポート (zip) を保存する。SP=絶対URL / mock=data URL。 */
  async function openReport(issue: ManagedIssue): Promise<void> {
    if (!issue.reportUrl) return;
    try {
      const href = await getRepo().docFileHref(issue.reportUrl);
      if (!href) { toast(rootEl, 'レポートが見つかりません（削除済みの可能性）。', 'warn'); return; }
      const a = el('a', { href, download: issue.reportName ?? 'report.zip', style: 'display:none' });
      rootEl.appendChild(a);
      a.click();
      a.remove();
    } catch (e) {
      toast(rootEl, `レポートの取得に失敗しました: ${(e as Error).message}`, 'error');
    }
  }

  function openDetail(id: number): void {
    const open = getState().openIssueIds;
    const next = open.includes(id) ? open : [...open, id];
    setState({ view: 'issues', selectedIssueId: id, openIssueIds: next });
  }

  return root;
}
