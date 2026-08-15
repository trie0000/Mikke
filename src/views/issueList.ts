// F4: 管理対象脆弱性の一覧画面。subbar → toolbar → table の順 (UI ルール §1.2)。
// 表本体 (列フィルタ/全文表示/仮想スクロール/列リサイズ/列ドラッグ) は DataTable に委譲。
import { LABEL, RESPONSE_FIELD_ORDER } from '../lib/fieldLabels';
import { hasResponseUpdate } from '../lib/responseAlert';
import { el, clear, fmtDate } from '../utils/dom';
import { icon } from '../icons';
import { getState, setState, setFilter } from '../state';
import { getRepo, getRepoMode } from '../api/repo';
import { isUndetected, nextDetectionWhenPresent, nextDetectionWhenAbsent } from '../lib/detection';
import { detectionBadge, mgmtBadge, notifyBadge } from './badges';
import { resolveScanValue } from '../lib/scanName';
import { splitAssetCell, DEFAULT_ASSET_COLUMN, assetSourceColumns } from '../lib/assets';
import { relayHealth, relayGetIssues, getRelayBase, type RelayIssueBatchItem } from '../api/relay';
import { openModal } from '../components/modal';
import { toast } from '../components/toast';
import { DataTable, type DataColumn } from './dataTable';
import { acquireAndStore, mergeAndStore, ALL_DOWNLOAD_TYPES, mapLimit, base64ToBytes } from '../lib/downloadFlow';
import { buildImportPlan, type ImportMode } from '../lib/import';
import { storeIssueReport, sampleIssueReport, issueReportFolder, isAdapterMissing } from '../lib/issueReport';
import { reportLinkLabel, zipEntryName, bulkReportZipName } from '../lib/reportFile';
import { zipFiles, type ZipInput } from '../lib/zip';
import { downloadFile } from '../lib/xlsx';
import { notifyStatusOf, NOTIFY_ORDER, type NotifyStatus } from '../lib/notifyStatus';
import { buildResponseSyncPlan, updatedAtMap, type VulnResponseItem } from '../lib/responseSync';
import { buildVulnResponsePlan } from '../lib/vulnResponseSync';
import type { ManagedIssue } from '../types';

/** 情報更新の並列数。relay 側 (/mikke/issues の runspace プール) と同じ値にする。
 *  ここを増やすなら relay の $MIKKE_ISSUES_MAX_PARALLEL も合わせること。 */
const REFRESH_PARALLEL = 5;

/** 保存済みレポートを SP から読み出すときの並列数 (SP へのファイル GET のみ)。 */
const REPORT_FETCH_PARALLEL = 6;

/** 組み込み列で既に出している CSV 列 (管理列に指定されても重複表示しない)。
 *  import.ts の COL_TITLE='Title' / ISSUE_ID_COLUMN='Issue Instance ID' がそのまま
 *  'Title' 列・'Issue Instance ID' 列に入るので、同じ内容の列が 2 本並んでしまう。
 *  比較は空白・アンダースコアを除いた小文字で行う ('Issue Instance ID' / 'issue_instance_id' 等)。 */
const BUILTIN_SCAN_COLUMNS = new Set(['title', 'issueinstanceid', 'lastseen', 'firstseen']);
const normScanCol = (c: string): string =>
  c.replace(/^Scan_/, '').replace(/[\s\u3000_]+/g, '').toLowerCase();

/** 連携リストの自動取り込みを済ませたか。
 *  ★ 一覧は明細から戻るたびに作り直されるので、関数の外に置く。中に置いていたため
 *    明細を見て戻るたびに全件取り込みが走っていた。 */
let autoSyncDone = false;

/** 明細を開いたときに覚えた「その時点の連携リスト更新時刻」 (Issue Instance ID → ISO)。
 *  ★ これがあると「連携リスト更新」の表示を一度で消せる。端末ごとに持つ
 *    (誰が見たかではなく、自分が見たかどうかの話なので SP には保存しない)。 */
const LS_SEEN = 'mikke.seenResponseAt';
const seenMap = (): Record<string, string> => {
  try { return JSON.parse(localStorage.getItem(LS_SEEN) ?? '{}') as Record<string, string>; }
  catch { return {}; }
};
/** 初回だけ、今の状態を「見た」ことにして基準を作る。
 *  ★ これが無いと、更新した直後に全件へバッジが出てしまう。 */
const seedSeen = (map: Map<string, string>): void => {
  try {
    if (localStorage.getItem(LS_SEEN) !== null) return;
    const m: Record<string, string> = {};
    for (const [iid, at] of map) if (at) m[iid] = at;
    localStorage.setItem(LS_SEEN, JSON.stringify(m));
  } catch { /* noop */ }
};
const markSeen = (iid: string, at?: string): void => {
  if (!iid || !at) return;
  try {
    const m = seenMap();
    m[iid] = at;
    localStorage.setItem(LS_SEEN, JSON.stringify(m));
  } catch { /* noop */ }
};

/** 明細へ移る直前の一覧のスクロール位置 (縦・横)。
 *  ★ 一覧は明細から戻るたびに作り直されるので、関数の外に置いて持ち越す。
 *    戻したら null に戻し、他の画面を経由したときに効かないようにする。 */
let savedScroll: { top: number; left: number } | null = null;

/** メモは HTML (リッチテキスト) で入ることがある。一覧のセルは 1 行なので素の文字にする。 */
const stripHtml = (v: string): string =>
  v.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim();

const DETECTION_ORDER: Record<string, number> = { '新規': 5, '再検知': 4, '継続': 3, '未検出(New)': 2, '未検出': 1 };
const MGMT_ORDER: Record<string, number> = {
  '未着手': 6, '対応中': 5, '対応済み': 4, 'リスク受容': 3, '過検出': 2, '対象外': 1,
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
  /** 連携用リストの記入内容 (1 回の読み取りを使い回す)。 */
  let vulnResponses: VulnResponseItem[] = [];
  /** 連携用リストの Issue Instance ID → 最終更新日時。通知ステータスの判定に使う。 */
  let vulnResponseUpdated = new Map<string, string>();
  /** 明細を開いて確認済みの時刻 (端末ローカル)。読み込みのたびに取り直す。 */
  let seen: Record<string, string> = seenMap();
  /** 資産キー → Web資産管理ID (資産リストの管理番号)。脆弱性から引くための対応表。 */
  let assetMgmtIdByKey = new Map<string, string>();
  /** 資産キー → 事業会社 / 管理会社。管理対象に直接入っていない場合の引き先。 */
  let assetCompanyByKey = new Map<string, { business: string; affiliate: string }>();
  /** 資産を取り出す列 (設定。例: FQDN 列 + IP 列)。 */
  let assetColumns: string[] = [DEFAULT_ASSET_COLUMN];
  let lastFiltered: ManagedIssue[] = [];
  const selected = new Set<number>();
  let bulkBusy = false;
  /** ツールバーの「列」ボタン。非表示件数の表示を追随させるために持っておく。 */
  let colBtn: HTMLButtonElement | null = null;
  /** 連携内容の自動取り込みはこの画面を開いたとき 1 回だけ (毎回の再描画で走らせない)。 */

  const table = new DataTable<ManagedIssue>(tableWrap, {
    storeKey: 'mikke.issues',
    columns: [],
    rowId: (i) => i.id,
    virtualMin: 40,
    onRowClick: (i) => openDetail(i.id),
    columnToggle: true,           // ツールバーの「列」ボタンが戻す入口
    onColumnsChange: () => paintColBtn(),
    rowSelected: (i) => getState().selectedIssueId === i.id,
    selection: {
      checked: (i) => selected.has(i.id),
      onToggle: (i, on) => { on ? selected.add(i.id) : selected.delete(i.id); updateSubbar(); },
      onToggleAll: (on, visible) => { for (const i of visible) { on ? selected.add(i.id) : selected.delete(i.id); } updateSubbar(); table.render(); },
    },
    onVisibleChange: (v) => { lastFiltered = v as ManagedIssue[]; updateSubbar(); },
    emptyText: '該当する管理対象がありません。',
  });

  /** その脆弱性に「連携リスト更新」を出すか。 */
  const responseUpdated = (i: ManagedIssue): boolean => hasResponseUpdate({
    linkedAt: vulnResponseUpdated.get(i.issueInstanceId),
    seenAt: seen[i.issueInstanceId],
  });

  const notifyOf = (i: ManagedIssue): NotifyStatus =>
    notifyStatusOf(i.updatedAt, vulnResponseUpdated.get(i.issueInstanceId));

  /** その脆弱性の「WebMAPS管理ID」。
   *  ★ 移行データで管理対象に直接入った値を優先し、無ければ資産リストから資産キー
   *    経由で引く (複数資産に跨る場合は重複を除いて並べる)。 */
  const assetMgmtIdOf = (i: ManagedIssue): string => {
    if ((i.webMapsId ?? '').trim()) return i.webMapsId!.trim();
    const ids = new Set<string>();
    for (const col of assetColumns) {
      const key = col.startsWith('Scan_') ? col : `Scan_${col}`;
      for (const k of splitAssetCell(resolveScanValue(i.scanFields, key, csvHeaders) ?? '')) {
        const id = assetMgmtIdByKey.get(k);
        if (id) ids.add(id);
      }
    }
    return [...ids].join(' | ');
  };

  /** その脆弱性の事業会社 / 管理会社。
   *  ★ 管理対象に直接入れた値を優先し、無ければ資産リストから引く
   *    (連携用リストへ渡すときと同じ決め方。lib/vulnResponseSync.ts)。 */
  const companyOf = (i: ManagedIssue, kind: 'business' | 'affiliate'): string => {
    const own = (kind === 'business' ? i.businessCompany : i.affiliateCompany) ?? '';
    if (own.trim()) return own.trim();
    const found = new Set<string>();
    for (const col of assetColumns) {
      const key = col.startsWith('Scan_') ? col : `Scan_${col}`;
      for (const k of splitAssetCell(resolveScanValue(i.scanFields, key, csvHeaders) ?? '')) {
        const v = assetCompanyByKey.get(k)?.[kind];
        if (v) found.add(v);
      }
    }
    return [...found].join(' | ');
  };

  void load();

  async function load(): Promise<void> {
    // ★ 読み直しでスクロール位置を失わない。明細から戻ったときは覚えた位置を、
    //   それ以外 (連携内容の取込など、画面にいるままの読み直し) は今の位置を戻す。
    //   ここを入れないと、読み込み後に走る自動取り込みの再読込で先頭に飛ぶ。
    const keep = savedScroll ?? { top: tableWrap.scrollTop, left: tableWrap.scrollLeft };
    savedScroll = null;
    clear(tableWrap);
    tableWrap.appendChild(el('div', { class: 'mikke-empty' }, ['読み込み中…']));
    try {
      const [all, settings, notified, assets] = await Promise.all([
        getRepo().listIssues(),
        getRepo().getSettings(),
        // 連携用リストが未作成でも一覧は出す (その場合は全件「未通知」)。
        // ★ 連携リストは 1 回だけ読む。記入内容と更新時刻を同時に取り、
        //   通知列・「連携リスト更新」・自動取り込みの 3 つで使い回す。
        getRepo().listVulnResponses().catch(() => [] as VulnResponseItem[]),
        // Web資産管理ID を引くため。取れなくても一覧は出す。
        getRepo().listAssets().catch(() => []),
      ]);
      vulnResponses = notified;
      vulnResponseUpdated = updatedAtMap(notified);
      seedSeen(vulnResponseUpdated);
      seen = seenMap();
      assetColumns = (settings.assetColumns && settings.assetColumns.length)
        ? settings.assetColumns
        : (settings.assetColumn ? [settings.assetColumn] : [DEFAULT_ASSET_COLUMN]);
      assetMgmtIdByKey = new Map(
        assets.filter((a) => a.mgmtNumber).map((a) => [a.assetKey, a.mgmtNumber as string]));
      assetCompanyByKey = new Map(assets.map((a) => [a.assetKey, {
        business: a.businessCompany ?? '', affiliate: a.affiliateCompany ?? '',
      }]));
      scanCols = settings.managedColumns.map((c) => (c.startsWith('Scan_') ? c : `Scan_${c}`));
      csvHeaders = settings.lastCsvHeaders ?? [];
      cache = all;
      const ids = new Set(all.map((i) => i.id));
      for (const id of [...selected]) if (!ids.has(id)) selected.delete(id);
      setState({ issueCount: all.length }, { silent: true });
      table.setColumns(buildColumns());
      paint();
      applyScroll(keep);
      // 画面を開いた直後に 1 回だけ、連携用リストの記入内容を取り込む。
      // 取得済みの内容をそのまま渡す (もう一度読みに行かない)。
      if (!autoSyncDone) { autoSyncDone = true; void syncFromVulnResponse(true, false, vulnResponses); }
    } catch (e) {
      clear(tableWrap);
      tableWrap.appendChild(el('div', { class: 'mikke-error' }, [
        `一覧の取得に失敗しました: ${(e as Error).message}`,
      ]));
    }
  }

  // ── 一括更新: 検査ツールから全レポートを取得し、脆弱性レポートで反映 ──────────
  /**
   * 情報更新のモーダル。
   * @param mode fixed=固定 / add=追加
   * @param onlySelected true なら選択中の脆弱性だけを対象にする (検査ツールへの
   *   問い合わせを 1 件ずつ行う。全件はレポート一括ダウンロードから取り込む)。
   */
  function bulkUpdate(mode: ImportMode, onlySelected = false): void {
    if (bulkBusy) return;
    if (onlySelected && !selected.size) { toast(rootEl, '脆弱性が選択されていません。', 'warn'); return; }
    const label = mode === 'fixed' ? '固定モード' : '追加モード';
    const desc = mode === 'fixed'
      ? '新規の脆弱性は追加しません。既存の検知中のステータスは据え置き、今回のデータで消えた検知系のみ「未検出(New)」に変更します。ステータス以外の項目は取得データで更新します。'
      : '新たに条件一致した脆弱性を追加し、既存のステータスも標準ルール（継続/再検知/未検出化）で更新します。';
    // 個別レポートの取得可否 (既定 ON)。件数が多いと時間がかかるので外せるようにする。
    const reportCheck = el('input', { type: 'checkbox', checked: 'checked' }) as HTMLInputElement;
    // ★ レポートの zip 取得はここで選ぶ (専用ボタンは置かない)。
    //   保存済みのレポートをまとめるだけで、検査ツールへは問い合わせない。
    const zipCheck = el('input', { type: 'checkbox' }) as HTMLInputElement;
    const opt = (cb: HTMLInputElement, title: string, desc2: string): HTMLElement =>
      el('label', {
        style: 'display:flex;align-items:flex-start;gap:var(--s-3);cursor:pointer;'
          + 'padding:var(--s-3);background:var(--paper-2);border-radius:var(--r-2);margin-bottom:var(--s-2)',
      }, [
        cb,
        el('span', {}, [
          el('div', {}, [title]),
          el('div', { style: 'font-size:var(--fs-sm);color:var(--ink-3);margin-top:var(--s-1)' }, [desc2]),
        ]),
      ]);
    openModal(rootEl, {
      title: `情報更新（${onlySelected ? `選択 ${selected.size} 件` : '全件'}・${label}）`,
      body: el('div', { style: 'line-height:1.8' }, [
        el('p', { style: 'margin:0 0 var(--s-3)' }, onlySelected
          ? ['選択中の脆弱性を ', el('b', {}, ['1 件ずつ検査ツールに問い合わせて']), ' 最新の内容に更新します。']
          : ['検査ツールから ', el('b', {}, ['全資産および脆弱性のレポート']), ' を取得して「ダウンロードデータ」に保存し、',
            'それらを突合した ', el('b', {}, ['マージ CSV']), ' を生成して取り込みます。']),
        el('p', { style: 'margin:0 0 var(--s-4);color:var(--ink-2)' }, [desc]),
        opt(reportCheck, '個別レポートも新しく取得する',
          `1 件ずつ検査ツールから取得し (${REFRESH_PARALLEL} 件並列)、SharePoint に保存して連携リストへ添付します。件数が多いと時間がかかります。`),
        opt(zipCheck, '保存済みレポートを zip でダウンロードする',
          '検査ツールへは問い合わせません。すでに保存されているレポートを 1 つの zip にまとめて手元に落とします。'),
      ]),
      primaryLabel: '取得して更新',
      onPrimary: async () => {
        if (onlySelected) await bulkRefresh(mode, reportCheck.checked);
        else await runBulkUpdate(mode, reportCheck.checked);
        if (zipCheck.checked) await downloadSelectedReports(onlySelected);
      },
    });
  }

  async function runBulkUpdate(mode: ImportMode, withReports: boolean): Promise<void> {
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
      const parts = [
        `一括更新（${mode === 'fixed' ? '固定' : '追加'}）完了: 追加 ${s.added} / 更新 ${s.updated}`
        + ` / 未検出 ${s.undetected} / スキップ ${s.skipped}${fail ? ` / 失敗 ${fail}` : ''}`,
      ];

      // 個別レポート: 今回の取り込みで追加・更新された脆弱性だけを対象にする
      // (未検出・スキップは新しいレポートが無いので取りに行かない)。
      let repFail = 0;
      if (withReports) {
        const touched = new Set(plan.ops
          .filter((o) => o.kind === 'add' || o.kind === 'update')
          .map((o) => o.issueInstanceId));
        const after = await getRepo().listIssues();
        const targets = after.filter((i) => touched.has(i.issueInstanceId));
        if (targets.length) {
          toast(rootEl, `個別レポートを取得しています… ${targets.length} 件 (${REFRESH_PARALLEL} 件並列)`, 'default', 8000);
          const r = await downloadReportsFor(targets);
          repFail = r.fail;
          if (r.skipped) parts.push('個別レポートはアダプタ未実装のためスキップ');
          else {
            parts.push(`レポート ${r.report} 件取得`);
            if (r.noItem) parts.push(`うち ${r.noItem} 件は連携用リストに該当アイテムなし`);
            if (r.fail) parts.push(`レポート ${r.fail} 件失敗 — ${r.firstErr}`);
          }
        }
      }
      toast(rootEl, parts.join(' / '), (fail || repFail) ? 'warn' : 'ok', 14000);
    } catch (e) {
      toast(rootEl, `一括更新に失敗しました: ${(e as Error).message}`, 'error', 10000);
    } finally {
      bulkBusy = false;
      await load();
    }
  }

  /**
   * 連携用リストの記入内容 (対応状況 / 対応者 / 対応期日 / 対応経緯 / 備考) を取り込む。
   * ★ 差分があるものだけ書き込み、更新履歴にも残す。
   * @param silent 自動実行。取り込む差分が無ければ何も表示しない。
   */
  async function syncFromVulnResponse(
    silent: boolean, onlySelected = false, prefetched?: VulnResponseItem[],
  ): Promise<void> {
    if (bulkBusy) return;
    // 選択分だけを取り込むときは、選択した Issue Instance ID に絞る。
    const scope = onlySelected
      ? new Set(cache.filter((i) => selected.has(i.id))
        .map((i) => (i.issueInstanceId ?? '').trim()).filter(Boolean))
      : null;
    if (scope && !scope.size) { toast(rootEl, '脆弱性が選択されていません。', 'warn'); return; }
    bulkBusy = true;
    try {
      const all = prefetched ?? await getRepo().listVulnResponses();
      const responses = scope ? all.filter((r) => scope.has((r.issueInstanceId ?? '').trim())) : all;
      if (!responses.length) {
        if (!silent) {
          toast(rootEl, '連携用リストにアイテムがありません（まだ渡していない、またはリスト未作成）。', 'warn', 8000);
        }
        return;
      }
      const plan = buildResponseSyncPlan(
        scope ? cache.filter((i) => scope.has((i.issueInstanceId ?? '').trim())) : cache,
        responses, new Date().toISOString());
      if (!plan.patches.length) {
        if (!silent) {
          toast(rootEl, `連携内容の取り込み: 変更はありません（照合 ${plan.unchanged} 件 / 連携用リストに無し ${plan.notLinked} 件）。`, 'ok', 6000);
        }
        return;
      }
      // ★ 管理対象への書き込みは $batch でまとめる (1 件ずつだと件数ぶん往復する)。
      let fail = 0; let firstErr = '';
      try {
        const w = await getRepo().applyIssueWrites([],
          plan.patches.map((p) => ({ id: p.id, patch: p.patch })));
        fail = w.fail;
        if (fail) firstErr = 'くわしくはブラウザのコンソール (F12) を見てください';
      } catch (e) {
        fail = plan.patches.length;
        firstErr = (e as Error).message;
      }
      const ok = plan.patches.length - fail;
      // 誰の変更か分かるよう更新履歴にも残す (残せなくても取り込みは成立させる)。
      const now = new Date().toISOString();
      await mapLimit(plan.patches, REFRESH_PARALLEL, async (p) => {
        await getRepo().createChangeLog({
          issueInstanceId: p.issueInstanceId, changedAt: now,
          changedBy: '連携用リストから取り込み', changes: p.changes,
        }).catch(() => { /* noop */ });
      });
      toast(rootEl,
        `連携内容を取り込みました: ${ok} 件更新${fail ? ` / ${fail} 件失敗 — ${firstErr}` : ''}`,
        fail ? 'error' : 'ok', fail ? 12000 : 6000);
    } catch (e) {
      if (!silent) toast(rootEl, `連携内容の取り込みに失敗しました: ${(e as Error).message}`, 'error', 10000);
    } finally {
      bulkBusy = false;
      await load();
    }
  }

  /**
   * 管理対象一覧 → 連携用リストへ反映する。
   * ★ 資産管理者が記入する欄 (対応状況 / 対応者 / 対応期日 / 対応経緯 / 備考) には触らない。
   *   管理対象外にしたものは連携用リストから削除する (解除すれば次回また追加される)。
   */
  /**
   * 管理対象の内容を連携用リストへ反映する。
   * @param onlySelected true なら選択中の脆弱性だけを対象にする。
   *   ★ 範囲外の既存アイテムには触らない (絞ったまま全件突合すると、選択していない
   *     アイテムが「管理対象に無い」と判定されてリストが消える)。
   */
  /**
   * 反映の前に「資産管理者の記入欄を上書きするか」を訊く。
   * ★ 既定は OFF。通常は相手が書いた内容を消さないのが正しい。
   *   Excel から移行した対応状況をリスト側へ載せるときだけ ON にする。
   */
  function askPushOptions(onlySelected: boolean, count: number): Promise<boolean | null> {
    return new Promise((resolve) => {
      const check = el('input', { type: 'checkbox' }) as HTMLInputElement;
      let done = false;
      openModal(rootEl, {
        title: onlySelected ? `選択 ${count} 件を連携リストへ反映` : '連携リストへ反映（全件）',
        body: el('div', { style: 'line-height:1.8' }, [
          el('p', { style: 'margin:0 0 var(--s-4)' }, [
            '脆弱性・資産の情報を連携用リストへ書き込みます。',
            el('br'),
            '通常は資産管理者が記入する欄には触れません。',
          ]),
          el('label', {
            style: 'display:flex;align-items:flex-start;gap:var(--s-3);cursor:pointer;'
              + 'padding:var(--s-3);background:var(--paper-2);border-radius:var(--r-2)',
          }, [
            check,
            el('span', {}, [
              el('div', {}, ['資産管理者が記入する欄を Mikke の値で上書きする']),
              el('div', { style: 'font-size:var(--fs-sm);color:var(--ink-3);margin-top:var(--s-1)' }, [
                `上書きする項目: ${RESPONSE_FIELD_ORDER.filter((k) => k !== 'responder')
                  .map((k) => LABEL[k]).join(' / ')}`,
                el('br'),
                'Excel から移行した内容をリスト側へ載せるときに使います。',
                el('br'),
                el('b', {}, ['相手が既に記入していた内容は消えます。戻せません。']),
                el('br'),
                `Mikke 側が空の項目は、リスト側も空になります。`,
                el('br'),
                `「${LABEL.responder}」だけは上書きしません（SharePoint のユーザー列で、`
                + '表示名からは確実に引けないため）。',
              ]),
            ]),
          ]),
        ]),
        primaryLabel: '反映する',
        onPrimary: () => { done = true; resolve(check.checked); },
        onClose: () => { if (!done) resolve(null); },
      });
    });
  }

  async function pushToVulnResponse(onlySelected = false): Promise<void> {
    if (bulkBusy) return;
    const targets = onlySelected ? cache.filter((i) => selected.has(i.id)) : cache;
    if (onlySelected && !targets.length) {
      toast(rootEl, '脆弱性が選択されていません。', 'warn');
      return;
    }
    const overwriteResponse = await askPushOptions(onlySelected, targets.length);
    if (overwriteResponse === null) return;   // 閉じた = 何もしない
    const scope = onlySelected
      ? new Set(targets.map((i) => (i.issueInstanceId ?? '').trim()).filter(Boolean))
      : undefined;
    bulkBusy = true;
    updateSubbar();
    try {
      // ★ 列が 1 つでも足りないと SP は書込を 400 で返し、全件失敗する。
      //   何が足りないのか・どう直すのかを先に出す (原因が分からないまま
      //   「エラーになる」だけになっていた)。
      const missing = await getRepo().findMissingVulnResponseColumns().catch(() => [] as string[]);
      if (missing.length) {
        toast(rootEl,
          `連携用リストに列が足りません (${missing.join(', ')})。`
          + '設定 → 連携用リスト の「連携用リストを構築」を実行してから、もう一度反映してください。',
          'error', 0);
        return;
      }
      const [existing, assets] = await Promise.all([
        getRepo().listVulnResponseRows(),
        getRepo().listAssets().catch(() => []),
      ]);
      const assetsByKey = new Map(assets.map((a) => [a.assetKey, a]));
      const keysOf = (i: ManagedIssue): string[] => {
        const set = new Set<string>();
        // ★ 設定の資産列に加えて、移行が書く列 (Asset IP / Asset Domain) も必ず見る。
        for (const col of assetSourceColumns(assetColumns)) {
          const key = col.startsWith('Scan_') ? col : `Scan_${col}`;
          for (const k of splitAssetCell(resolveScanValue(i.scanFields, key, csvHeaders) ?? '')) set.add(k);
        }
        return [...set];
      };
      const plan = buildVulnResponsePlan(cache, assetsByKey, keysOf, existing, scope, overwriteResponse);
      const label = (onlySelected ? `選択 ${targets.length} 件の反映` : '連携リストへの反映')
        + (overwriteResponse ? '（対応状況も上書き）' : '');
      const total = plan.creates.length + plan.updates.length + plan.deletes.length;
      // ★ 内容に変更が無くても止まらない。権限だけ未適用のことがある
      //   (先にリストを作ってから、あとでアクセス権を設定した場合)。ここで
      //   早期 return していたため、管理者グループが一生付かなかった。
      if (total) {
        toast(rootEl, `${label}… 追加 ${plan.creates.length} / 更新 ${plan.updates.length} / 削除 ${plan.deletes.length}`, 'default', 6000);
      }

      // ★ $batch で 100 件ずつまとめて書く。1 件ずつだと件数ぶん往復して遅い。
      //   失敗した件は件数だけ分かる (原因の詳細は F12 のコンソールに出る)。
      let fail = 0;
      let firstErr = '';
      try {
        const w = await getRepo().applyVulnResponseWrites(
          plan.creates, plan.updates, plan.deletes.map((d) => d.id),
          (d, t) => { if (t > 200 && d % 200 === 0) toast(rootEl, `${label}… (${d}/${t})`, 'default', 2000); });
        fail = w.fail;
        if (fail) firstErr = 'くわしくはブラウザのコンソール (F12) を見てください';
      } catch (e) {
        fail = plan.creates.length + plan.updates.length + plan.deletes.length;
        firstErr = (e as Error).message;
      }

      // ★ レポート PDF をアイテムの添付にも載せる。
      //   リンク列 (脆弱性レポート) はドキュメントライブラリを指すので、そこへの
      //   参照権限が無い利用者は開けない。添付ならアイテムと同じ権限で開ける。
      //   毎回上げ直すと重いので、追加した件 / レポートが変わった件だけにする。
      const attachTargets = targets.filter((i) => i.reportUrl && (
        plan.creates.some((c) => c.issueInstanceId === i.issueInstanceId)
        || plan.updates.some((u) => u.issueInstanceId === i.issueInstanceId && u.fields.reportUrl !== undefined)
      ));
      const att = { ok: 0, noItem: 0, fail: 0, firstErr: '' };
      if (attachTargets.length) {
        toast(rootEl, `レポートを添付しています… ${attachTargets.length} 件`, 'default', 6000);
        await mapLimit(attachTargets, REPORT_FETCH_PARALLEL, async (issue) => {
          try {
            const href = await getRepo().docFileHref(issue.reportUrl!);
            if (!href) throw new Error('保存済みレポートが見つかりません');
            const r = await fetch(href, { credentials: 'same-origin', cache: 'no-store' });
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            const name = issue.reportName || 'report.pdf';
            const res = await getRepo().attachVulnResponseFile(
              issue.issueInstanceId, name, await r.blob(), issue.reportName);
            if (res === 'attached') att.ok++; else att.noItem++;
          } catch (e) {
            att.fail++;
            if (!att.firstErr) att.firstErr = `${issue.issueInstanceId}: ${(e as Error).message}`;
          }
        });
      }

      // ★ アクセス権を付ける対象は「追加した分」だけではない。
      //   ・追加した分 … 継承のままなので必ず付ける
      //   ・事業会社が変わった分 … 割当先が変わるので付け直す
      //   ・まだ継承のままの分 … 先にリストを作ってから権限を設定した場合がこれ。
      //     ここを見ていなかったため、既存アイテムに管理者グループが一生付かなかった。
      //   全件に毎回付け直すのは重い (1 件あたり 4〜6 リクエスト) ので、この 3 つに絞る。
      let permMsg = '';
      try {
        // 書き込み後の状態で引き直す (追加した分の ID と、継承のままかどうか)。
        const [targets, rows] = await Promise.all([
          getRepo().listVulnResponsePermTargets(),
          getRepo().listVulnResponseRows(),
        ]);
        const idByIid = new Map(rows.map((r) => [r.issueInstanceId, r.id]));
        const iidById = new Map(rows.map((r) => [r.id, r.issueInstanceId]));
        const createdIds = new Set(
          plan.creates.map((c) => idByIid.get(c.issueInstanceId)).filter((x): x is number => !!x));
        const changedCompany = new Set(
          plan.updates.filter((u) => u.fields.businessCompany !== undefined).map((u) => u.id));
        const scoped = targets.filter((t) => {
          if (!(createdIds.has(t.id) || changedCompany.has(t.id) || !t.hasUniquePerms)) return false;
          // 選択分の反映では、範囲外のアイテムには触らない。
          return !scope || scope.has(iidById.get(t.id) ?? '');
        });
        if (scoped.length) {
          const pr = await getRepo().applyVulnResponseItemPerms(scoped);
          permMsg = ` / アクセス権 ${pr.applied + pr.adminOnly} 件`
            + (pr.errors.length ? ` (失敗 ${pr.errors.length}: ${pr.errors[0]})` : '');
        }
      } catch (e) {
        // ★ 未設定なら黙って飛ばさず、その旨を出す。「付いていない」ことに気づけないため。
        permMsg = /未設定/.test((e as Error).message)
          ? ' / アクセス権は未設定のため付与していません（アクセス権画面で管理者グループを選んでください）'
          : ` / アクセス権の付与に失敗: ${(e as Error).message}`;
      }

      // ★ 反映した日時を管理対象に残す (明細の「連携リスト反映」に出す)。
      //   書き込みに成功した分だけを対象にする。
      const pushedIids = new Set([
        ...plan.creates.map((c) => c.issueInstanceId),
        ...plan.updates.map((u) => u.issueInstanceId),
      ]);
      if (pushedIids.size && !fail) {
        // ★ 自分が書いた分は「見た」ことにする。反映で連携リスト側の更新時刻も
        //   動くので、ここで覚えないと自分の反映でバッジが出てしまう。
        const after = updatedAtMap(await getRepo().listVulnResponses().catch(() => [] as VulnResponseItem[]));
        for (const iid of pushedIids) markSeen(iid, after.get(iid));
        seen = seenMap();
        const now = new Date().toISOString();
        // 反映日時の記録も 1 件ずつ書かず、まとめて書く。
        await getRepo().applyIssueWrites([], cache
          .filter((i) => pushedIids.has(i.issueInstanceId))
          .map((i) => ({ id: i.id, patch: { responsePushedAt: now } })))
          .catch(() => { /* 反映自体は成功しているので握る */ });
      }

      const attMsg = att.ok || att.fail
        ? ` / レポート添付 ${att.ok} 件${att.fail ? ` (失敗 ${att.fail}: ${att.firstErr})` : ''}` : '';
      const summary = total
        ? `追加 ${plan.creates.length} / 更新 ${plan.updates.length} / 削除 ${plan.deletes.length}`
          + ` / 変更なし ${plan.unchanged}`
        : `変更はありません（一致 ${plan.unchanged} 件）`;
      toast(rootEl,
        `${label}: ${summary}${attMsg}${permMsg}${fail ? ` — ${fail} 件失敗: ${firstErr}` : ''}`,
        fail || att.fail ? 'error' : 'ok', fail || att.fail ? 12000 : 8000);
    } catch (e) {
      toast(rootEl, `連携リストへの反映に失敗しました: ${(e as Error).message}`, 'error', 10000);
    } finally {
      bulkBusy = false;
      await load();
    }
  }

  /**
   * 指定した脆弱性の個別レポートを取得して保存し、連携用リストへ添付する。
   *
   * ★ 取得は relay の /mikke/issues (runspace プールで REFRESH_PARALLEL 件並列)。
   *   同じ応答に脆弱性情報も入るが **ここでは使わない**。一括更新は取込計画側で
   *   ステータスを決めており、こちらで上書きすると固定モードの意図が壊れるため。
   * @returns 取得できた件数などの内訳
   */
  async function downloadReportsFor(targets: ManagedIssue[]): Promise<{
    report: number; noItem: number; fail: number; skipped: boolean; firstErr: string;
  }> {
    const out = { report: 0, noItem: 0, fail: 0, skipped: false, firstErr: '' };
    if (!targets.length) return out;
    const runFolder = await issueReportFolder(new Date().toISOString());
    const devMock = getRepoMode() === 'mock';

    for (let i = 0; i < targets.length; i += REFRESH_PARALLEL) {
      if (out.skipped) break;
      const chunk = targets.slice(i, i + REFRESH_PARALLEL);
      let results: RelayIssueBatchItem[] = [];
      if (!devMock) {
        try {
          results = await relayGetIssues(chunk.map((x) => x.issueInstanceId), true);
        } catch (e) {
          if (isAdapterMissing(e)) { out.skipped = true; break; }
          out.fail += chunk.length;
          if (!out.firstErr) out.firstErr = (e as Error).message;
          continue;
        }
      }
      const byId = new Map(results.map((r) => [r.issueInstanceId, r]));
      await mapLimit(chunk, REFRESH_PARALLEL, async (issue) => {
        const res = byId.get(issue.issueInstanceId);
        if (res?.reportSkipped) { out.skipped = true; return; }
        if (res?.reportError) { out.fail++; if (!out.firstErr) out.firstErr = res.reportError; return; }
        const rep = devMock ? await sampleIssueReport(issue)
          : (res?.report ? { fileName: res.report.fileName, bytes: base64ToBytes(res.report.contentBase64) } : null);
        if (!rep) return;
        try {
          const r = await storeIssueReport(issue, rep, runFolder);
          await getRepo().updateIssue(issue.id, {
            reportUrl: r.url, reportName: r.fileName, reportAt: r.fetchedAt,
          });
          out.report++;
          if (r.attach === 'no-item') out.noItem++;
          else if (r.attach === 'failed') { out.fail++; if (!out.firstErr) out.firstErr = r.attachError ?? ''; }
        } catch (e) {
          out.fail++;
          if (!out.firstErr) out.firstErr = (e as Error).message;
        }
      });
    }
    return out;
  }

  function buildColumns(): DataColumn<ManagedIssue>[] {
    const cols: DataColumn<ManagedIssue>[] = [
      // ★ ラベルは 'Title'。CSV の Title 列がそのまま入るので、管理列に Title を
      //   足すと同じ内容の列が 2 本並ぶ。重複は buildColumns の scanCols 側で外す。
      // ★ 先頭の #No 列。連携リストで事業会社が書き換えたものはここで気づけるようにする。
      //   明細を開いたら消える (開いた時点の更新時刻を覚えて突き合わせる)。
      { id: 'no', label: '#No', width: 132, sortValue: (i) => i.id,
        text: (i) => `#${i.id}${responseUpdated(i) ? ' 連携リスト更新' : ''}`,
        render: (i) => (responseUpdated(i)
          ? el('span', { style: 'display:inline-flex;align-items:center;gap:var(--s-2)' }, [
            el('span', { style: 'color:var(--ink-3)' }, [`#${i.id}`]),
            el('span', {
              class: 'mikke-badge',
              style: 'background:var(--accent-soft);color:var(--accent-strong);white-space:nowrap',
              title: '連携リストで事業会社が記入内容を書き換えました。明細を開くと消えます。',
            }, ['連携リスト更新']),
          ])
          : el('span', { style: 'color:var(--ink-3)' }, [`#${i.id}`])) },
      { id: 'title', label: LABEL.title, width: 260, text: (i) => i.title ?? '', render: (i) => i.title || '(無題)' },
      { id: 'detection', label: LABEL.detectionStatus, width: 110, text: (i) => i.detectionStatus,
        sortValue: (i) => DETECTION_ORDER[i.detectionStatus] ?? 0, render: (i) => detectionBadge(i.detectionStatus) },
      { id: 'mgmt', label: LABEL.mgmtStatus, width: 110, text: (i) => i.mgmtStatus,
        sortValue: (i) => MGMT_ORDER[i.mgmtStatus] ?? 0, render: (i) => mgmtBadge(i.mgmtStatus) },
      // 連携用リストと比べた通知の状態。判定は notifyStatus.ts (更新時刻の比較)。
      { id: 'notify', label: '通知', width: 100,
        text: (i) => notifyOf(i),
        sortValue: (i) => NOTIFY_ORDER[notifyOf(i)],
        render: (i) => notifyBadge(notifyOf(i)) },
      // ── 管理系 ID ──
      //   Issue Instance ID (検査ツール) / WebMAPS管理ID / 外部接続申請ID の 3 種類 +
      //   移行期間中だけ残す旧管理番号。
      // ★ ラベルは検査ツールの呼び名どおり 'Issue Instance ID'。CSV にも同名列が来るので、
      //   管理列に足しても重複表示しない (BUILTIN_SCAN_COLUMNS)。
      { id: 'iid', label: LABEL.issueInstanceId, width: 170, text: (i) => i.issueInstanceId },
      { id: 'assetMgmtId', label: LABEL.assetMgmtId, width: 150, text: (i) => assetMgmtIdOf(i) },
      { id: 'extConnAppId', label: LABEL.extConnAppId, width: 140, text: (i) => i.extConnAppId ?? '' },
      { id: 'legacyMgmtNumber', label: LABEL.legacyMgmtNumber, width: 140, text: (i) => i.legacyMgmtNumber ?? '',
        cellStyle: 'color:var(--ink-3)' },
      // 組織。管理対象に入れた値が優先、無ければ資産リストから引く。
      { id: 'businessCompany', label: LABEL.businessCompany, width: 150, text: (i) => companyOf(i, 'business') },
      { id: 'affiliateCompany', label: LABEL.affiliateCompany, width: 150, text: (i) => companyOf(i, 'affiliate') },
      { id: 'vulnType', label: '脆弱性タイプ', width: 110, text: (i) => i.vulnType ?? '' },
      { id: 'identifyEvidence', label: LABEL.identifyEvidence, width: 200, text: (i) => i.identifyEvidence ?? '' },
      { id: 'assignee', label: LABEL.responder, width: 120, text: (i) => i.assignee ?? '' },
      { id: 'due', label: LABEL.responseDueDate, width: 116, text: (i) => fmtDate(i.dueDate, false) || '' },
      // ★ 検知日は明細と同じ値 (i.lastSeen / i.firstSeen) を同じ表記で出す。
      //   CSV の 'Last Seen' / 'First Seen' 列は同じ内容なので出さない
      //   (BUILTIN_SCAN_COLUMNS)。あちらは原文のままで JST に直っていない。
      { id: 'lastSeen', label: LABEL.lastSeen, width: 150, text: (i) => fmtDate(i.lastSeen) || '',
        sortValue: (i) => i.lastSeen ?? '' },
      { id: 'firstSeen', label: LABEL.firstSeen, width: 150, text: (i) => fmtDate(i.firstSeen) || '',
        sortValue: (i) => i.firstSeen ?? '', cellStyle: 'color:var(--ink-3)' },
      // 「情報更新」で取得した個別レポート。形式は検査ツールが返したまま (現状 PDF) なので、
      // リンク表記もファイル名の拡張子から出す。行クリック (詳細を開く) と競合しないよう
      // リンク側で stopPropagation する。
      // ★ Excel 取込の項目と明細の項目を一覧にも揃える。既定は非表示にして
      //   今までの見た目を変えず、「列」ボタンから出せるようにする。
      { id: 'responsePlan', label: LABEL.responsePlan, width: 200, defaultHidden: true,
        text: (i) => i.responsePlan ?? '' },
      { id: 'noAppReason', label: LABEL.noAppReason, width: 200, defaultHidden: true,
        text: (i) => i.noAppReason ?? '' },
      { id: 'outOfScopeReason', label: '対象外の理由', width: 200, defaultHidden: true,
        text: (i) => i.outOfScopeReason ?? '' },
      { id: 'mgmtNote', label: LABEL.mgmtNote, width: 220, defaultHidden: true,
        text: (i) => stripHtml(i.mgmtNote ?? '') },
      { id: 'responseRemarks', label: LABEL.responseRemarks, width: 200, defaultHidden: true,
        text: (i) => i.responseRemarks ?? '' },
      { id: 'addedReason', label: '取込経緯', width: 110, defaultHidden: true,
        text: (i) => i.addedReason ?? '', cellStyle: 'color:var(--ink-3)' },
      { id: 'scannerStatus', label: '検査ツールステータス', width: 160, defaultHidden: true,
        text: (i) => i.scannerStatus ?? '', cellStyle: 'color:var(--ink-3)' },
      { id: 'firstUndetectedAt', label: '未検出になった日', width: 150, defaultHidden: true,
        text: (i) => fmtDate(i.firstUndetectedAt) || '',
        sortValue: (i) => i.firstUndetectedAt ?? '', cellStyle: 'color:var(--ink-3)' },
      { id: 'report', label: LABEL.report, width: 104,
        text: (i) => i.reportName ?? '',
        sortValue: (i) => i.reportAt ?? '',
        render: (i) => (i.reportUrl
          ? el('a', {
              href: '#', class: 'mikke-link',
              title: `${i.reportName ?? ''}${i.reportAt ? ` (${fmtDate(i.reportAt)})` : ''}`,
              onclick: (e: Event) => { e.preventDefault(); e.stopPropagation(); void openReport(i); },
            }, [reportLinkLabel(i.reportName)])
          : '') },
    ];
    for (const c of scanCols) {
      // 組み込み列と同じ内容になる CSV 列は出さない (Title / Issue Instance ID)。
      if (BUILTIN_SCAN_COLUMNS.has(normScanCol(c))) continue;
      cols.push({ id: `scan:${c}`, label: c.replace(/^Scan_/, ''), width: 160,
        text: (i) => resolveScanValue(i.scanFields, c, csvHeaders) || '', cellStyle: 'color:var(--ink-2)' });
    }
    cols.push({ id: 'synced', label: '脆弱性ツール同期', width: 150, text: (i) => fmtDate(i.lastSyncedAt) || '',
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
    // ★ 並びも名前も全件のツールバーに合わせる (全件 → 選択 と読み替えるだけ)。
    //   レポートの zip 取得は専用ボタンを置かず、情報更新のモーダルで選ぶ。
    const selBtn = (title: string, ic: string, label: string, onclick: () => void): HTMLElement =>
      el('button', {
        class: 'mikke-btn mikke-btn--secondary',
        style: 'height:28px;padding:0 var(--s-5);font-size:var(--fs-sm)',
        title,
        ...(bulkBusy ? { disabled: 'disabled' } : {}),
        onclick,
        html: icon(ic) + `<span>${label}</span>`,
      });
    subbar.append(
      el('span', { class: 'mikke-subbar-count', style: 'color:var(--accent-strong);font-weight:600' }, [`${sel} 件選択`]),
      selBtn('選択中の脆弱性だけを連携リストへ反映します（選択していないアイテムには触れません）',
        'upload', '連携リストへ反映(選択)', () => { void pushToVulnResponse(true); }),
      selBtn('選択中の脆弱性について、連携リストで事業会社が記入した内容を取り込みます',
        'sync', '連携リスト取り込み(選択)', () => { void syncFromVulnResponse(false, true); }),
      selBtn('選択中の脆弱性を 1 件ずつ検査ツールに問い合わせて更新します（固定モード）',
        'download', '情報更新(選択・固定)', () => bulkUpdate('fixed', true)),
      selBtn('選択中の脆弱性を 1 件ずつ検査ツールに問い合わせて更新します（追加モード）',
        'download', '情報更新(選択・追加)', () => bulkUpdate('add', true)),
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

  /**
   * 選択中の脆弱性を 1 件ずつ検査ツールに問い合わせて更新する。
   * @param mode fixed=検知中のステータスは据え置き / add=標準ルールで遷移
   * @param withReport 個別レポートも取り直すか
   */
  async function bulkRefresh(mode: ImportMode = 'add', withReport = true): Promise<void> {
    const ids = [...selected];
    if (!ids.length || bulkBusy) return;
    // dev (mock) は relay を持たないので、ダウンロード取得と同じくサンプル応答で動かす。
    const devMock = getRepoMode() === 'mock';
    if (!devMock) {
      const h = await relayHealth();
      if (!h.ok) {
        // ★ どこへ繋ぎに行ったかを出す。既定は 18120 なので、別ポートで起動していると
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
        // ★ 固定モードは検知中のステータスを据え置く (全件の固定モードと同じ考え方)。
        //   消えたものだけ未検出化する。追加モードは標準ルールで遷移させる。
        if (res.detected === true) {
          if (mode !== 'fixed') patch.detectionStatus = nextDetectionWhenPresent(issue.detectionStatus);
        } else if (res.detected === false) {
          const nd = nextDetectionWhenAbsent(issue.detectionStatus);
          patch.detectionStatus = nd;
          if (nd === '未検出(New)' && !issue.firstUndetectedAt) patch.firstUndetectedAt = new Date().toISOString();
        }
        if (res.reportSkipped) reportSkipped = true;
        if (res.reportError) { reportFail++; if (!firstReportErr) firstReportErr = res.reportError; }
        // レポートの保存・添付で失敗しても情報更新そのものは成功扱い (レポートは付随物)。
        // レポートを取り直さない指定なら、保存も添付もしない。
        const rep = !withReport ? null
          : (devMock ? await sampleIssueReport(issue)
            : (res.report ? { fileName: res.report.fileName, bytes: base64ToBytes(res.report.contentBase64) } : null));
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
    // 列の表示/非表示。非表示にした列を戻す入口はここだけ (ヘッダから消えるため)。
    colBtn = el('button', {
      style: 'height:30px;font-size:var(--fs-sm)',
      title: '表示する列を選びます（列ヘッダのメニューからも非表示にできます）',
      onclick: () => { if (colBtn) table.openColumnPicker(colBtn); },
    }) as HTMLButtonElement;
    paintColBtn();
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
    const pushBtn = el('button', {
      class: 'mikke-btn mikke-btn--secondary', style: 'height:30px;font-size:var(--fs-sm)',
      title: '管理対象すべての内容を連携用リストへ反映します（資産管理者の記入欄には触れません。管理対象外・管理対象から消えたものは削除されます）',
      ...(bulkBusy ? { disabled: 'disabled' } : {}),
      onclick: () => { void pushToVulnResponse(); },
      html: icon('upload') + '<span>連携リストへ反映(全件)</span>',
    });
    const syncBtn = el('button', {
      class: 'mikke-btn mikke-btn--secondary', style: 'height:30px;font-size:var(--fs-sm)',
      title: '連携用リストで資産管理者が記入した内容 (対応状況・対応者・対応期日・対応経緯・備考) を取り込みます',
      ...(bulkBusy ? { disabled: 'disabled' } : {}),
      onclick: () => { void syncFromVulnResponse(false); },
      html: icon('sync') + '<span>連携リスト取り込み(全件)</span>',
    });
    const bulkFixedBtn = el('button', {
      class: 'mikke-btn mikke-btn--secondary', style: 'height:30px;font-size:var(--fs-sm)',
      title: '検査ツールから全レポートを取得し、固定モードで反映（新規は追加せず・検知中は据え置き）',
      ...(bulkBusy ? { disabled: 'disabled' } : {}),
      onclick: () => bulkUpdate('fixed'),
      html: icon('download') + '<span>情報更新(全件・固定)</span>',
    });
    const bulkAddBtn = el('button', {
      // ★ ツールバーの primary は「全文表示」が ON 状態の表示に使っている。
      //   情報更新(全件・追加) を常時 primary にすると状態表示と紛らわしいので secondary に揃える。
      class: 'mikke-btn mikke-btn--secondary', style: 'height:30px;font-size:var(--fs-sm)',
      title: '検査ツールから全レポートを取得し、追加モードで反映（新規追加＋全ステータス更新）',
      ...(bulkBusy ? { disabled: 'disabled' } : {}),
      onclick: () => bulkUpdate('add'),
      html: icon('download') + '<span>情報更新(全件・追加)</span>',
    });
    toolbar.append(
      el('span', { html: icon('filter'), style: 'color:var(--ink-3);display:inline-flex' }),
      search, wrapBtn, colBtn, ...(clearBtn ? [clearBtn] : []),
      el('span', { style: 'display:inline-flex;gap:var(--s-3)' }, [pushBtn, syncBtn, bulkFixedBtn, bulkAddBtn]),
      hiddenToggle,
    );

    if (cache.length === 0) { clear(tableWrap); tableWrap.appendChild(emptyState()); return; }
    refresh();
  }

  /** 「列」ボタンの見た目だけを更新する。
   *  ★ 列を隠すたびに paint() し直すと、開いている列メニューが閉じてしまう。 */
  function paintColBtn(): void {
    if (!colBtn) return;
    const n = table.hiddenColumnCount();
    colBtn.className = n ? 'mikke-btn mikke-btn--primary' : 'mikke-btn mikke-btn--secondary';
    colBtn.innerHTML = icon('columns') + `<span>列${n ? ` (${n} 非表示)` : ''}</span>`;
  }

  /** 行を描いた後にスクロール位置を戻す。
   *  ★ その場で当ててから、届くまで数回だけ試す。仮想スクロールは行を描くまで
   *    高さが足りず値が丸められる。requestAnimationFrame は**タブが裏にあると
   *    発火しない**ので使わない。 */
  function applyScroll(pos: { top: number; left: number }): void {
    if (!pos.top && !pos.left) return;
    let tries = 0;
    const apply = (): void => {
      tableWrap.scrollTop = pos.top;
      tableWrap.scrollLeft = pos.left;
      const off = Math.abs(tableWrap.scrollTop - pos.top) > 1
        || Math.abs(tableWrap.scrollLeft - pos.left) > 1;
      if (off && ++tries < 10) setTimeout(apply, 16);
    };
    apply();
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

  /**
   * 選択中の脆弱性の個別レポートを 1 つの zip にまとめて保存する。
   *
   * ★ 取りに行くのは **SP に保存済みのレポート** だけ。検査ツールへは問い合わせないので
   *   取り直したいときは先に「情報更新」を使う (時間と負荷が段違いなため分けている)。
   * ★ zip 内の名前は取得順ではなく一覧の並び順で決める (実行のたびに連番が入れ替わらない)。
   */
  async function downloadSelectedReports(onlySelected = true): Promise<void> {
    const targets = onlySelected ? cache.filter((i) => selected.has(i.id)) : cache;
    const withReport = targets.filter((i) => i.reportUrl);
    if (!withReport.length) {
      toast(rootEl, '保存済みレポートがありません。先に「情報更新」で取得してください。', 'warn', 8000);
      return;
    }
    bulkBusy = true;
    updateSubbar();
    const missing = targets.length - withReport.length;
    toast(rootEl, `レポートを取得しています… ${withReport.length} 件 (${REPORT_FETCH_PARALLEL} 件並列)`, 'default', 8000);
    try {
      const fetched = new Array<Uint8Array | null>(withReport.length).fill(null);
      const errs: string[] = [];
      await mapLimit(
        withReport.map((issue, idx) => ({ issue, idx })), REPORT_FETCH_PARALLEL,
        async ({ issue, idx }) => {
          try {
            const href = await getRepo().docFileHref(issue.reportUrl!);
            if (!href) throw new Error('保存済みファイルが見つかりません（削除済みの可能性）');
            const r = await fetch(href, { credentials: 'same-origin', cache: 'no-store' });
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            fetched[idx] = new Uint8Array(await r.arrayBuffer());
          } catch (e) {
            errs.push(`${issue.issueInstanceId}: ${(e as Error).message}`);
          }
        },
      );

      const used = new Set<string>();
      const entries: ZipInput[] = [];
      withReport.forEach((issue, idx) => {
        const data = fetched[idx];
        if (data) entries.push({ name: zipEntryName(issue.issueInstanceId, issue.reportName ?? '', used), data });
      });
      if (!entries.length) {
        toast(rootEl, `レポートを 1 件も取得できませんでした: ${errs[0] ?? ''}`, 'error', 10000);
        return;
      }

      downloadFile(bulkReportZipName(), await zipFiles(entries));
      const parts = [`レポート ${entries.length} 件を zip で保存しました`];
      if (missing) parts.push(`レポート未取得 ${missing} 件は除外`);
      if (errs.length) parts.push(`取得失敗 ${errs.length} 件 — ${errs[0]}`);
      toast(rootEl, parts.join(' / '), errs.length ? 'warn' : 'ok', errs.length ? 12000 : 6000);
    } catch (e) {
      toast(rootEl, `レポートの一括ダウンロードに失敗しました: ${(e as Error).message}`, 'error', 10000);
    } finally {
      bulkBusy = false;
      updateSubbar();
    }
  }

  /** 個別レポートを 1 件保存する (形式は検査ツールが返したまま)。SP=絶対URL / mock=data URL。 */
  async function openReport(issue: ManagedIssue): Promise<void> {
    if (!issue.reportUrl) return;
    try {
      const href = await getRepo().docFileHref(issue.reportUrl);
      if (!href) { toast(rootEl, 'レポートが見つかりません（削除済みの可能性）。', 'warn'); return; }
      const a = el('a', { href, download: issue.reportName || 'report', style: 'display:none' });
      rootEl.appendChild(a);
      a.click();
      a.remove();
    } catch (e) {
      toast(rootEl, `レポートの取得に失敗しました: ${(e as Error).message}`, 'error');
    }
  }

  function openDetail(id: number): void {
    // ★ 開いた時点の連携リストの更新時刻を覚える → 「連携リスト更新」が消える。
    const target = cache.find((i) => i.id === id);
    if (target) markSeen(target.issueInstanceId, vulnResponseUpdated.get(target.issueInstanceId));
    // ★ 明細へ移る前に一覧のスクロール位置を覚えておく (縦・横とも)。
    //   一覧は毎回作り直されるので、覚えておかないと先頭に戻ってしまう。
    savedScroll = { top: tableWrap.scrollTop, left: tableWrap.scrollLeft };
    const open = getState().openIssueIds;
    const next = open.includes(id) ? open : [...open, id];
    setState({ view: 'issues', selectedIssueId: id, openIssueIds: next });
  }

  return root;
}
