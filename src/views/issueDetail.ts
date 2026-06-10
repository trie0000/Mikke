// F5: 脆弱性詳細画面。タブストリップで複数 Issue を切替、4 タブ構成。
import { el, clear, fmtDate } from '../utils/dom';
import { icon } from '../icons';
import { getState, setState } from '../state';
import { getRepo } from '../api/repo';
import { detectionBadge, mgmtBadge, severityBadge } from './badges';
import { openEditModal } from './editModal';
import { relayGetIssue, relayHealth } from '../api/relay';
import { toast } from '../components/toast';
import { scanDisplayMap, scanFieldName, decodeSpInternalName } from '../lib/scanName';
import type { ManagedIssue } from '../types';

type DetailTab = 'overview' | 'scanner' | 'mgmt' | 'history';

// 詳細タブのフォーカス履歴 (表示した順)。アクティブタブを閉じたとき
// 「前回開いていたタブ」へ戻すために使う。モジュールスコープで再描画を跨いで保持。
const tabFocusHistory: number[] = [];
function recordTabFocus(id: number): void {
  const i = tabFocusHistory.indexOf(id);
  if (i >= 0) tabFocusHistory.splice(i, 1);
  tabFocusHistory.push(id);
}

export function renderIssueDetail(rootEl: HTMLElement): HTMLElement {
  const wrap = el('div', { class: 'mikke-main', style: 'display:flex;flex-direction:column' });
  const tabStrip = el('div', { class: 'mikke-tabstrip' });
  const detailTabs = el('div', { class: 'mikke-detail-tabs' });
  const body = el('div', { class: 'mikke-detail-body', style: 'flex:1' });
  wrap.append(tabStrip, detailTabs, body);

  let activeTab: DetailTab = 'overview';
  let current: ManagedIssue | null = null;
  // SP の安全列名 (Scan_xxx_hash) → 元の列名 の逆引き (検査ツール詳細タブの表示用)
  let scanNames: Record<string, string> = {};
  // 直近取込 CSV のヘッダ (検査ツール詳細を CSV の列順で表示するため)
  let csvHeaders: string[] = [];

  paintTabStrip();
  void loadCurrent();

  function paintTabStrip(): void {
    clear(tabStrip);
    const ids = getState().openIssueIds;
    const sel = getState().selectedIssueId;
    // 戻るボタン
    tabStrip.appendChild(el('button', {
      class: 'mikke-iconbtn', 'aria-label': '一覧へ戻る', title: '一覧へ戻る',
      onclick: () => setState({ view: 'issues', selectedIssueId: null }),
      html: icon('list'),
    }));
    for (const id of ids) {
      const tab = el('div', {
        class: `mikke-tab${id === sel ? ' is-active' : ''}`,
        onclick: () => { setState({ selectedIssueId: id }); },
      }, [
        el('span', {}, [`#${id}`]),
        el('span', {
          class: 'mikke-iconbtn', style: 'width:18px;height:18px',
          'aria-label': 'タブを閉じる',
          onclick: (e: Event) => { e.stopPropagation(); closeTab(id); },
          html: icon('x'),
        }),
      ]);
      tabStrip.appendChild(tab);
    }
  }

  function closeTab(id: number): void {
    const ids = getState().openIssueIds.filter((x) => x !== id);
    // 閉じた ID はフォーカス履歴からも除去。
    const hi = tabFocusHistory.indexOf(id);
    if (hi >= 0) tabFocusHistory.splice(hi, 1);
    let sel = getState().selectedIssueId;
    if (sel === id) {
      // アクティブタブを閉じた → 直近に開いていた (履歴の新しい順) まだ開いているタブへ。
      sel = [...tabFocusHistory].reverse().find((x) => ids.includes(x)) ?? ids[ids.length - 1] ?? null;
    }
    setState({ openIssueIds: ids, selectedIssueId: sel, view: 'issues' });
  }

  async function loadCurrent(): Promise<void> {
    const id = getState().selectedIssueId;
    if (id == null) { body.appendChild(el('div', { class: 'mikke-empty' }, ['Issue を選択してください'])); return; }
    recordTabFocus(id);
    clear(body);
    body.appendChild(el('div', { class: 'mikke-empty' }, ['読み込み中…']));
    current = await getRepo().getIssue(id);
    try {
      const settings = await getRepo().getSettings();
      csvHeaders = settings.lastCsvHeaders ?? [];
      scanNames = scanDisplayMap([...csvHeaders, ...settings.managedColumns]);
    } catch { /* noop */ }
    paintTabs();
    paintBody();
  }

  function paintTabs(): void {
    clear(detailTabs);
    const tabs: { key: DetailTab; label: string }[] = [
      { key: 'overview', label: '概要' },
      { key: 'scanner', label: '検査ツール詳細' },
      { key: 'mgmt', label: '管理情報' },
      { key: 'history', label: '履歴' },
    ];
    for (const t of tabs) {
      detailTabs.appendChild(el('div', {
        class: `mikke-detail-tab${activeTab === t.key ? ' is-active' : ''}`,
        onclick: () => { activeTab = t.key; paintTabs(); paintBody(); },
      }, [t.label]));
    }
    // アクション
    detailTabs.appendChild(el('div', { style: 'flex:1' }));
    detailTabs.appendChild(el('button', {
      class: 'mikke-btn mikke-btn--secondary',
      onclick: () => void fetchLatest(),
      html: icon('sync') + '<span>最新状態を取得</span>',
    }));
    detailTabs.appendChild(el('button', {
      class: 'mikke-btn mikke-btn--primary', style: 'margin-left:8px',
      onclick: () => { if (current) openEditModal(rootEl, current, () => void loadCurrent()); },
      html: icon('edit') + '<span>編集</span>',
    }));
  }

  function paintBody(): void {
    clear(body);
    if (!current) { body.appendChild(el('div', { class: 'mikke-empty' }, ['Issue が見つかりません'])); return; }
    const i = current;
    if (activeTab === 'overview') {
      body.appendChild(metaGrid([
        ['ID', `#${i.id}`],
        ['Issue Instance ID', i.issueInstanceId],
        ['タイトル', i.title],
        ['深刻度', null, severityBadge(i.severity)],
        ['検知ステータス', null, detectionBadge(i.detectionStatus)],
        ['対応ステータス', null, mgmtBadge(i.mgmtStatus)],
        ['担当', i.assignee || '—'],
        ['期限', fmtDate(i.dueDate, false) || '—'],
        ['取込経緯', i.addedReason || '—'],
        ['最終同期', fmtDate(i.lastSyncedAt) || '—'],
      ]));
    } else if (activeTab === 'scanner') {
      const rows: [string, string][] = [
        ['検査ツールステータス', i.scannerStatus || '—'],
        ['深刻度', i.severity || '—'],
        ['初回検出', fmtDate(i.firstSeen) || '—'],
        ['最終検出', fmtDate(i.lastSeen) || '—'],
        ['未検出になった日', fmtDate(i.firstUndetectedAt) || '—'],
      ];
      // CSV の全項目を「ヘッダの列順」で表示する。
      // キーは SP=安全列名 (scanFieldName) / mock=Scan_<元名> の両対応で引く。
      const sf = i.scanFields ?? {};
      const used = new Set<string>();
      for (const h of csvHeaders) {
        const safe = scanFieldName(h);
        const raw = `Scan_${h}`;
        const v = sf[safe] !== undefined ? sf[safe] : sf[raw];
        if (v === undefined) continue;
        rows.push([h, v || '—']);
        used.add(safe); used.add(raw);
      }
      // 残りのキー (ヘッダ外・旧形式列など)。逆引きできなければ SP 内部名の
      // エンコード (_x0020_ 等) を解除して表示。不明キーで値も空なら出さない
      // (旧形式で作られた空列がゴミとして並ぶのを防ぐ)。
      for (const [k, v] of Object.entries(sf)) {
        if (used.has(k)) continue;
        const known = scanNames[k];
        if (!known && !v) continue;
        const label = known ?? decodeSpInternalName(k.replace(/^Scan_/, '')).replace(/^_+/, '');
        rows.push([label, v || '—']);
      }
      body.appendChild(metaGrid(rows.map(([k, v]) => [k, v] as [string, string])));
      body.appendChild(el('p', { style: 'margin-top:var(--s-5);color:var(--ink-4);font-size:var(--fs-sm)' },
        ['※ 検査ツール由来の項目は読み取り専用です。']));
    } else if (activeTab === 'mgmt') {
      body.appendChild(metaGrid([
        ['対応ステータス', null, mgmtBadge(i.mgmtStatus)],
        ['対象外', i.isOutOfScope ? `はい — ${i.outOfScopeReason || ''}` : 'いいえ'],
        ['担当', i.assignee || '—'],
        ['期限', fmtDate(i.dueDate, false) || '—'],
      ]));
      body.appendChild(el('div', { style: 'margin-top:var(--s-6)' }, [
        el('div', { class: 'mikke-meta-label', style: 'margin-bottom:var(--s-2)' }, ['メモ']),
        el('div', { style: 'white-space:pre-wrap;color:var(--ink)' }, [i.mgmtNote || '（メモなし）']),
      ]));
    } else {
      body.appendChild(el('div', { class: 'mikke-empty' }, ['変更履歴は Phase 3 で実装予定です。']));
    }
  }

  async function fetchLatest(): Promise<void> {
    if (!current) return;
    const h = await relayHealth();
    if (!h.ok) {
      toast(rootEl, '中継サーバが起動していません。mikke-start.bat を実行してください。', 'warn');
      return;
    }
    try {
      const res = await relayGetIssue(current.issueInstanceId);
      await getRepo().updateIssue(current.id, {
        scannerStatus: res.scannerStatus, severity: res.severity,
        lastSeen: res.lastSeen, lastSyncedAt: new Date().toISOString(),
        scanFields: { ...current.scanFields, ...(res.scanFields ?? {}) },
      });
      toast(rootEl, '最新状態を取得しました', 'ok');
      void loadCurrent();
    } catch (e) {
      toast(rootEl, `取得に失敗しました: ${(e as Error).message}`, 'error');
    }
  }

  return wrap;
}

function metaGrid(rows: ([string, string] | [string, null, HTMLElement])[]): HTMLElement {
  const grid = el('div', { class: 'mikke-meta' });
  for (const r of rows) {
    grid.appendChild(el('div', { class: 'mikke-meta-label' }, [r[0]]));
    if (r.length === 3 && r[2]) {
      grid.appendChild(el('div', { class: 'mikke-meta-value' }, [r[2]]));
    } else {
      grid.appendChild(el('div', { class: 'mikke-meta-value' }, [String(r[1] ?? '')]));
    }
  }
  return grid;
}
