// F5: 脆弱性詳細画面。タブストリップで複数 Issue を切替、4 タブ構成。
import { LABEL, RESPONSE_SECTION } from '../lib/fieldLabels';
import { el, clear, fmtDate } from '../utils/dom';
import { icon } from '../icons';
import { getState, setState } from '../state';
import { getRepo } from '../api/repo';
import { detectionBadge, mgmtBadge, notifyBadge } from './badges';
import { notifyStatusOf } from '../lib/notifyStatus';
import { openEditModal } from './editModal';
import { relayGetIssue, relayHealth, getRelayBase } from '../api/relay';
import { toast } from '../components/toast';
import { scanDisplayMap, scanFieldName, decodeSpInternalName } from '../lib/scanName';
import { nextDetectionWhenPresent, nextDetectionWhenAbsent } from '../lib/detection';
import { openModal } from '../components/modal';
import { sanitizeNoteHtml } from '../utils/sanitize';
import { reportLinkLabel } from '../lib/reportFile';
import {
  parseEml, parseMsgFile, parseOutlookDragText, looksLikeEml, looksLikeOutlookDrag,
  normalizeMailPlainText, splitQuotedReplyText, splitQuotedReplyHtml, stripHtml, type ParsedMail,
} from '../lib/emlParser';
import type { ManagedIssue, ResponseHistory, ChangeLogEntry, HistoryThread, HistorySource } from '../types';

type DetailTab = 'overview' | 'scanner' | 'mgmt' | 'response' | 'history' | 'changelog';

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
  /** 連携用リスト側の最終更新時刻 (Issue Instance ID → ISO)。通知ステータスの判定に使う。 */
  let vulnResponseUpdated = new Map<string, string>();
  // SP の安全列名 (Scan_xxx_hash) → 元の列名 の逆引き (検査ツール詳細タブの表示用)
  let scanNames: Record<string, string> = {};
  // 直近取込 CSV のヘッダ (検査ツール詳細を CSV の列順で表示するため)
  let csvHeaders: string[] = [];
  // 対応履歴 (現在の Issue) と表示スレッド (external/internal/both)。
  let historyEntries: ResponseHistory[] = [];
  let changeLog: ChangeLogEntry[] = [];
  let historyThread: HistoryThread | 'both' = 'both';

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
    // 通知ステータス用。連携用リストが未作成でも詳細表示は続ける (その場合は「未通知」)。
    try { vulnResponseUpdated = await getRepo().vulnResponseUpdatedAt(); } catch { /* noop */ }
    await loadHistory();
    await loadChangeLog();
    paintTabs();
    paintBody();
  }

  function paintTabs(): void {
    clear(detailTabs);
    const tabs: { key: DetailTab; label: string }[] = [
      { key: 'overview', label: '概要' },
      { key: 'scanner', label: '検査ツール詳細' },
      { key: 'mgmt', label: '管理情報' },
      { key: 'response', label: RESPONSE_SECTION },
      { key: 'history', label: '対応履歴' },
      { key: 'changelog', label: '更新履歴' },
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
        [LABEL.issueInstanceId, i.issueInstanceId],
        [LABEL.title, i.title],
        // 深刻度は Mikke の項目としては表示しない (CSV に Severity 列があれば
        // 検査ツール詳細タブに原本のまま並ぶ)。
        [LABEL.detectionStatus, null, detectionBadge(i.detectionStatus)],
        ['脆弱性タイプ', i.vulnType || '—'],
        // 通知 = 連携用リストとの同期状態 (対応状況とは別軸)。
        [LABEL.mgmtStatus, null, mgmtBadge(i.mgmtStatus)],
        ['通知', null, notifyBadge(notifyStatusOf(i.updatedAt, vulnResponseUpdated.get(i.issueInstanceId)))],
        ['取込経緯', i.addedReason || '—'],
        // 一覧の「レポート」列と同じもの。明細から直接開けるようにする。
        [LABEL.report, null, reportLink(i, rootEl)],
        // ★ どの経路の時刻かが分かるよう 3 つに分ける (「最終同期」だけでは読めない)。
        ['脆弱性ツール同期', fmtDate(i.lastSyncedAt) || '—'],
        ['連携リスト反映', fmtDate(i.responsePushedAt) || '—'],
        ['連携リスト取り込み', fmtDate(i.responseSyncedAt) || '—'],
      ]));
    } else if (activeTab === 'scanner') {
      const rows: [string, string][] = [
        ['検査ツールステータス', i.scannerStatus || '—'],
        [LABEL.firstSeen, fmtDate(i.firstSeen) || '—'],
        [LABEL.lastSeen, fmtDate(i.lastSeen) || '—'],
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
      // ★ 資産管理者が記入する項目 (対応状況 / 対応者 / 対応期日 / 対応経緯 / 備考) は
      //   「資産管理者の記入」タブに分けてある。ここは Mikke 側で管理する項目だけ。
      body.appendChild(metaGrid([
        ['対象外', i.isOutOfScope ? `はい — ${i.outOfScopeReason || ''}` : 'いいえ'],
        [LABEL.businessCompany, i.businessCompany || '—'],
        [LABEL.affiliateCompany, i.affiliateCompany || '—'],
        [LABEL.identifyEvidence, i.identifyEvidence || '—'],
        [LABEL.assetMgmtId, i.webMapsId || '—'],
        [LABEL.legacyMgmtNumber, i.legacyMgmtNumber || '—'],
      ]));
      body.appendChild(el('div', { style: 'margin-top:var(--s-6)' }, [
        el('div', { class: 'mikke-meta-label', style: 'margin-bottom:var(--s-2)' }, [LABEL.mgmtNote]),
        el('div', { style: 'white-space:pre-wrap;color:var(--ink)' }, [i.mgmtNote || '（記入なし）']),
        el('div', { style: 'margin-top:var(--s-2);color:var(--ink-4);font-size:var(--fs-sm)' }, [
          '※ Mikke の中だけで使うメモです。連携用リストには出ません（資産管理者が書く欄は「備考」）。',
        ]),
      ]));
    } else if (activeTab === 'response') {
      // ★ 連携用リストで資産管理者が記入する欄。項目名は連携用リストと同じにしてある
      //   (同じ値を画面ごとに別の名前で呼ばない)。
      //   全項目が「連携内容を取込」で相手の記入内容として入ってくる。
      // ★ 並びは RESPONSE_FIELD_ORDER に合わせる (明細・編集モーダル・連携用リストで同じ順)。
      body.appendChild(metaGrid([
        [LABEL.mgmtStatus, null, mgmtBadge(i.mgmtStatus)],
        [LABEL.responder, i.assignee || '—'],
        [LABEL.extConnAppId, i.extConnAppId || '—'],
        [LABEL.noAppReason, i.noAppReason || '—'],
        [LABEL.responseDueDate, fmtDate(i.dueDate, false) || '—'],
      ]));
      body.appendChild(el('div', { style: 'margin-top:var(--s-6)' }, [
        el('div', { class: 'mikke-meta-label', style: 'margin-bottom:var(--s-2)' }, [LABEL.responsePlan]),
        el('div', { style: 'white-space:pre-wrap;color:var(--ink)' }, [i.responsePlan || '（記入なし）']),
      ]));
      body.appendChild(el('div', { style: 'margin-top:var(--s-6)' }, [
        el('div', { class: 'mikke-meta-label', style: 'margin-bottom:var(--s-2)' }, [LABEL.responseRemarks]),
        el('div', { style: 'white-space:pre-wrap;color:var(--ink)' }, [i.responseRemarks || '（記入なし）']),
      ]));
      body.appendChild(el('p', { style: 'margin-top:var(--s-6);color:var(--ink-4);font-size:var(--fs-sm);line-height:1.8' }, [
        `※ 連携用リストの記入内容を取り込んだ日時: ${fmtDate(i.responseSyncedAt) || '（未取込）'}`,
        el('br'),
        '※ 記入は連携用リスト側で行います（この画面では「編集」から直せます）。',
        el('br'),
        '※ 上の項目は「連携リストへ反映」で上書きを選んだときだけ Mikke から書き戻します（対応者を除く）。',
      ]));
    } else if (activeTab === 'history') {
      body.appendChild(renderHistory());
    } else {
      body.appendChild(renderChangeLog());
    }
  }

  // ── 更新履歴タブ ────────────────────────────────────────────────────────────
  async function loadChangeLog(): Promise<void> {
    try { changeLog = current ? await getRepo().listChangeLog(current.issueInstanceId) : []; }
    catch { changeLog = []; }
  }

  function renderChangeLog(): HTMLElement {
    const wrapEl = el('div', {});
    if (!current) return wrapEl;
    const i = current;

    // 見出し + 一括リセット
    const head = el('div', { style: 'display:flex;align-items:center;gap:var(--s-3);margin-bottom:var(--s-5)' }, [
      el('span', { style: 'color:var(--ink-3);font-size:var(--fs-sm)' }, ['管理項目の変更を日ごとに記録します（新規追加は作成のみ）。']),
      el('span', { style: 'flex:1' }),
    ]);
    if (changeLog.length) {
      head.appendChild(el('button', {
        class: 'mikke-btn mikke-btn--danger', style: 'height:28px;font-size:var(--fs-sm)',
        onclick: () => void resetChangeLog(),
        html: icon('trash') + '<span>履歴を一括リセット</span>',
      }));
    }
    wrapEl.appendChild(head);

    // 日ごとにグループ化 (更新エントリ + 作成マーカー)。
    type DayItem = { time: string; entry?: ChangeLogEntry; created?: boolean };
    const byDay = new Map<string, DayItem[]>();
    const push = (iso: string, item: DayItem): void => {
      const day = localDayOf(iso);   // ローカル日付でグループ化 (表示時刻と一致させる)
      if (!byDay.has(day)) byDay.set(day, []);
      byDay.get(day)!.push(item);
    };
    for (const e of changeLog) push(e.changedAt, { time: e.changedAt, entry: e });
    const createdAt = i.firstSeen || i.lastSyncedAt || '';
    if (createdAt) push(createdAt, { time: createdAt, created: true });

    const days = [...byDay.keys()].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0)); // 新しい日が上
    if (!days.length) {
      wrapEl.appendChild(el('div', { class: 'mikke-empty' }, ['更新履歴がありません。管理情報を編集すると記録されます。']));
      return wrapEl;
    }
    for (const day of days) {
      const items = byDay.get(day)!.sort((a, b) => (a.time < b.time ? 1 : a.time > b.time ? -1 : 0));
      const card = el('div', { class: 'mikke-hist-card' });
      card.appendChild(el('div', { class: 'mikke-changelog-day' }, [fmtDate(day + 'T00:00:00', false) || day]));
      for (const it of items) {
        if (it.created) {
          card.appendChild(el('div', { class: 'mikke-changelog-row' }, [
            el('span', { class: 'mikke-changelog-time' }, [fmtDate(it.time) || '']),
            el('span', { class: 'mikke-badge mikke-badge--accent' }, ['作成']),
            el('span', { style: 'color:var(--ink-3)' }, ['管理対象に追加']),
          ]));
          continue;
        }
        const e = it.entry!;
        const rows = (e.changes ?? []).map((c) => el('div', { style: 'font-size:var(--fs-sm)' }, [
          el('span', { style: 'color:var(--ink-3)' }, [`${c.field}: `]),
          el('span', { style: 'text-decoration:line-through;color:var(--ink-4)' }, [c.before || '（空）']),
          ' → ',
          el('span', { style: 'color:var(--accent-strong);font-weight:600' }, [c.after || '（空）']),
        ]));
        card.appendChild(el('div', { class: 'mikke-changelog-row' }, [
          el('span', { class: 'mikke-changelog-time' }, [fmtDate(e.changedAt) || '']),
          el('div', { style: 'flex:1' }, rows),
          el('button', {
            class: 'mikke-iconbtn', style: 'width:22px;height:22px', 'aria-label': '削除', title: 'この更新履歴を削除',
            onclick: () => void deleteChangeLogEntry(e),
            html: icon('trash'),
          }),
        ]));
      }
      wrapEl.appendChild(card);
    }
    return wrapEl;
  }

  async function deleteChangeLogEntry(e: ChangeLogEntry): Promise<void> {
    try { await getRepo().deleteChangeLog(e.id); toast(rootEl, '削除しました', 'ok'); }
    catch (err) { toast(rootEl, `削除に失敗: ${(err as Error).message}`, 'error'); return; }
    await loadChangeLog();
    paintBody();
  }

  async function resetChangeLog(): Promise<void> {
    if (!current) return;
    const iid = current.issueInstanceId;
    const ok = await new Promise<boolean>((resolve) => {
      openModal(rootEl, {
        title: '更新履歴を一括リセット',
        body: el('div', { style: 'line-height:1.7' }, [
          `このチケットの更新履歴 (${changeLog.length} 件) をすべて削除します。`, el('br'),
          el('span', { style: 'color:var(--danger)' }, ['元に戻せません。']),
          el('br'), el('span', { style: 'color:var(--ink-4);font-size:var(--fs-sm)' }, ['※「作成」表示はチケット情報から算出したものなので残ります。']),
        ]),
        primaryLabel: '一括リセット', primaryVariant: 'danger',
        onPrimary: () => resolve(true), onClose: () => resolve(false),
      });
    });
    if (!ok) return;
    try { await getRepo().clearChangeLog(iid); toast(rootEl, '更新履歴をリセットしました', 'ok'); }
    catch (e) { toast(rootEl, `リセットに失敗: ${(e as Error).message}`, 'error'); return; }
    await loadChangeLog();
    paintBody();
  }

  // ── 対応履歴タブ ────────────────────────────────────────────────────────────
  async function loadHistory(): Promise<void> {
    try { historyEntries = current ? await getRepo().listHistory(current.issueInstanceId) : []; }
    catch { historyEntries = []; }
  }

  function renderHistory(): HTMLElement {
    const wrapEl = el('div', {});
    const extCount = historyEntries.filter((h) => h.thread === 'external').length;
    const intCount = historyEntries.filter((h) => h.thread === 'internal').length;

    const segBtn = (label: string, key: HistoryThread | 'both'): HTMLElement => el('button', {
      class: 'mikke-btn ' + (historyThread === key ? 'mikke-btn--primary' : 'mikke-btn--secondary'),
      style: 'height:28px;font-size:var(--fs-sm)',
      onclick: () => { historyThread = key; paintBody(); },
    }, [label]);

    wrapEl.appendChild(el('div', { style: 'display:flex;align-items:center;gap:var(--s-3);margin-bottom:var(--s-5)' }, [
      segBtn('両方', 'both'),
      segBtn(`外部対応履歴 (${extCount})`, 'external'),
      segBtn(`内部対応履歴 (${intCount})`, 'internal'),
      el('span', { style: 'flex:1' }),
      el('button', {
        class: 'mikke-btn mikke-btn--primary', style: 'height:28px;font-size:var(--fs-sm)',
        onclick: () => openAddHistory(historyThread === 'internal' ? 'internal' : 'external'),
        html: icon('plus') + '<span>履歴を追加</span>',
      }),
    ]));

    const shown = historyEntries
      .filter((h) => historyThread === 'both' || h.thread === historyThread)
      .sort((a, b) => (a.occurredAt < b.occurredAt ? 1 : a.occurredAt > b.occurredAt ? -1 : b.id - a.id));

    if (!shown.length) {
      wrapEl.appendChild(el('div', { class: 'mikke-empty' }, [
        el('div', {}, ['対応履歴がありません。「履歴を追加」から登録できます（メール .msg / .eml をドラッグでも取り込めます）。']),
      ]));
      return wrapEl;
    }
    const list = el('div', { class: 'mikke-hist-list' });
    for (const h of shown) list.appendChild(historyCard(h));
    wrapEl.appendChild(list);
    return wrapEl;
  }

  function historyCard(h: ResponseHistory): HTMLElement {
    const srcIcon = h.source === 'mail' ? 'external' : h.source === 'manual' ? 'edit' : 'hash';
    const threadLabel = h.thread === 'internal' ? '内部' : '外部';
    const head = el('div', { class: 'mikke-hist-head' }, [
      el('span', { class: 'mikke-hist-icon', html: icon(srcIcon) }),
      el('span', { class: 'mikke-hist-from' }, [h.author || (h.fromEmail ?? '（記入者なし）')]),
      ...(h.fromEmail && h.author ? [el('span', { class: 'mikke-hist-email' }, [`<${h.fromEmail}>`])] : []),
      el('span', { class: `mikke-badge ${h.thread === 'internal' ? 'mikke-badge--ok' : 'mikke-badge--accent'}` }, [threadLabel]),
      el('span', { style: 'flex:1' }),
      el('span', { class: 'mikke-hist-date' }, [fmtDate(h.occurredAt) || '']),
      el('button', {
        class: 'mikke-iconbtn', style: 'width:22px;height:22px', 'aria-label': '削除', title: '削除',
        onclick: () => void deleteHistory(h),
        html: icon('trash'),
      }),
    ]);
    // メールは「最新本文のみ」を表示する (引用=過去履歴は表示しない。記録は保持)。
    const { latest } = h.isHtml ? splitQuotedReplyHtml(h.body) : splitQuotedReplyText(h.body);
    const bodyEl = el('div', { class: 'mikke-hist-body' });
    if (h.isHtml) bodyEl.innerHTML = sanitizeNoteHtml(latest);
    else bodyEl.textContent = latest;
    if (h.subject) bodyEl.prepend(el('div', { class: 'mikke-hist-subject' }, [`件名: ${h.subject}`]));
    return el('div', { class: 'mikke-hist-card', 'data-thread': h.thread }, [head, bodyEl]);
  }

  async function deleteHistory(h: ResponseHistory): Promise<void> {
    const ok = await new Promise<boolean>((resolve) => {
      openModal(rootEl, {
        title: '対応履歴を削除',
        body: el('div', { style: 'line-height:1.7' }, ['この対応履歴を削除します。元に戻せません。']),
        primaryLabel: '削除する', primaryVariant: 'danger',
        onPrimary: () => resolve(true), onClose: () => resolve(false),
      });
    });
    if (!ok) return;
    try { await getRepo().deleteHistory(h.id); toast(rootEl, '削除しました', 'ok'); }
    catch (e) { toast(rootEl, `削除に失敗: ${(e as Error).message}`, 'error'); return; }
    await loadHistory();
    paintBody();
  }

  // ── 履歴の追加 (手入力 + メール .msg/.eml ドラッグ取込) ─────────────────────────
  function openAddHistory(defaultThread: HistoryThread): void {
    if (!current) return;
    const iid = current.issueInstanceId;
    const threadSel = el('select', { class: 'mikke-input' }, [
      el('option', { value: 'external', ...(defaultThread === 'external' ? { selected: 'selected' } : {}) }, ['外部対応履歴']),
      el('option', { value: 'internal', ...(defaultThread === 'internal' ? { selected: 'selected' } : {}) }, ['内部対応履歴']),
    ]) as HTMLSelectElement;
    const sourceSel = el('select', { class: 'mikke-input' }, [
      el('option', { value: 'manual' }, ['ソース (手入力)']),
      el('option', { value: 'mail' }, ['メール']),
      el('option', { value: 'other' }, ['その他']),
    ]) as HTMLSelectElement;
    const authorInput = el('input', { class: 'mikke-input', type: 'text', placeholder: '記入者 / 送信者名' }) as HTMLInputElement;
    const dtInput = el('input', { class: 'mikke-input', type: 'datetime-local', value: toLocalDateTime(new Date().toISOString()) }) as HTMLInputElement;
    const subjectInput = el('input', { class: 'mikke-input', type: 'text', placeholder: '件名 (任意)' }) as HTMLInputElement;
    const bodyArea = el('textarea', { class: 'mikke-input', style: 'min-height:160px;width:100%;font-family:inherit', placeholder: '対応内容。ここに .msg / .eml をドラッグするとメールを取り込みます。' }) as HTMLTextAreaElement;
    let pendingFromEmail: string | undefined;

    const field = (label: string, control: HTMLElement): HTMLElement =>
      el('div', { class: 'mikke-field' }, [el('label', { class: 'mikke-field-label' }, [label]), control]);

    const applyMail = (p: ParsedMail): void => {
      sourceSel.value = 'mail';
      if (p.fromName && !authorInput.value) authorInput.value = p.fromName;
      if (p.dateISO) dtInput.value = toLocalDateTime(p.dateISO);
      if (p.subject) subjectInput.value = p.subject;
      // 本文はプレーンテキストで取り込む (HTML の style 依存で空行が消える問題を避け、
      //  表示を pre-wrap で統一。改行・空行はそのまま保持)。
      const src = p.body ?? (p.bodyHtml ? stripHtml(p.bodyHtml) : '');
      if (src) { const b = normalizeMailPlainText(src); bodyArea.value = b; bodyArea.defaultValue = b; }
      pendingFromEmail = p.fromEmail;
    };

    const dropZone = el('div', { class: 'mikke-hist-drop' }, [
      el('div', {}, [
        el('span', { html: icon('upload'), style: 'display:inline-flex;vertical-align:-2px;margin-right:6px' }),
        'メール (.msg / .eml) をここにドラッグして取り込み',
      ]),
    ]);
    const onDragOver = (e: DragEvent): void => { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'; dropZone.classList.add('is-over'); };
    const onDragLeave = (): void => dropZone.classList.remove('is-over');
    const onDrop = async (e: DragEvent): Promise<void> => {
      e.preventDefault();
      dropZone.classList.remove('is-over');
      const dt = e.dataTransfer;
      if (!dt) return;
      const files = [...(dt.files ?? [])];
      const eml = files.find((f) => /\.eml$/i.test(f.name) || f.type === 'message/rfc822');
      const msg = files.find((f) => /\.msg$/i.test(f.name) || f.type === 'application/vnd.ms-outlook');
      try {
        if (eml) { applyMail(parseEml(await eml.text())); toast(rootEl, `「${eml.name}」を取り込みました`, 'ok'); return; }
        if (msg) { applyMail(await parseMsgFile(msg)); toast(rootEl, `「${msg.name}」を取り込みました`, 'ok'); return; }
        const txt = dt.getData('text/plain');
        if (txt && looksLikeEml(txt)) { applyMail(parseEml(txt)); toast(rootEl, 'メールを取り込みました', 'ok'); return; }
        if (txt && looksLikeOutlookDrag(txt)) { applyMail(parseOutlookDragText(txt)); toast(rootEl, 'Outlook ヘッダから取り込みました', 'ok'); return; }
        toast(rootEl, '取り込めるメール (.msg / .eml) が見つかりませんでした。', 'warn');
      } catch (err) {
        toast(rootEl, `メール取込に失敗: ${(err as Error).message}`, 'error');
      }
    };
    dropZone.addEventListener('dragover', onDragOver);
    dropZone.addEventListener('dragleave', onDragLeave);
    dropZone.addEventListener('drop', (e) => void onDrop(e));

    const modalBody = el('div', {}, [
      el('div', { style: 'display:flex;gap:var(--s-4)' }, [
        el('div', { style: 'flex:1' }, [field('種別', threadSel)]),
        el('div', { style: 'flex:1' }, [field('記録元', sourceSel)]),
      ]),
      dropZone,
      el('div', { style: 'display:flex;gap:var(--s-4)' }, [
        el('div', { style: 'flex:1' }, [field('記入者 / 送信者', authorInput)]),
        el('div', { style: 'flex:1' }, [field('対応日時', dtInput)]),
      ]),
      field('件名', subjectInput),
      field('内容', bodyArea),
    ]);
    openModal(rootEl, {
      title: '対応履歴を追加', body: modalBody, size: 'lg', primaryLabel: '登録する',
      onPrimary: async () => {
        const body = bodyArea.value.trim();
        if (!body && !subjectInput.value.trim()) { toast(rootEl, '内容を入力してください。', 'warn'); throw new Error('empty'); }
        const entry: Omit<ResponseHistory, 'id'> = {
          issueInstanceId: iid,
          thread: threadSel.value as HistoryThread,
          source: sourceSel.value as HistorySource,
          author: authorInput.value.trim() || undefined,
          fromEmail: pendingFromEmail,
          subject: subjectInput.value.trim() || undefined,
          body,
          isHtml: false,
          occurredAt: dtInput.value ? new Date(dtInput.value).toISOString() : new Date().toISOString(),
        };
        try { await getRepo().createHistory(entry); }
        catch (e) { toast(rootEl, `登録に失敗: ${(e as Error).message}`, 'error'); throw e; }
        toast(rootEl, '対応履歴を登録しました', 'ok');
        await loadHistory();
        paintBody();
      },
    });
  }

  async function fetchLatest(): Promise<void> {
    if (!current) return;
    const h = await relayHealth();
    if (!h.ok) {
      toast(rootEl,
        `中継サーバに接続できません (${getRelayBase()})。mikke-launch.bat を実行するか、`
        + 'ポートを変えている場合は mikke-relay.env の MIKKE_RELAY_PORT を確認してください。', 'warn', 10000);
      return;
    }
    try {
      const res = await relayGetIssue(current.issueInstanceId);
      const patch: Partial<ManagedIssue> = {
        scannerStatus: res.scannerStatus, severity: res.severity,
        lastSeen: res.lastSeen, lastSyncedAt: new Date().toISOString(),
        scanFields: { ...current.scanFields, ...(res.scanFields ?? {}) },
      };
      // アダプタが detected を返した場合のみ、CSV 取込と同じ遷移で検知を更新。
      if (res.detected === true) {
        patch.detectionStatus = nextDetectionWhenPresent(current.detectionStatus);
      } else if (res.detected === false) {
        const nd = nextDetectionWhenAbsent(current.detectionStatus);
        patch.detectionStatus = nd;
        if (nd === '未検出(New)' && !current.firstUndetectedAt) {
          patch.firstUndetectedAt = new Date().toISOString();
        }
      }
      await getRepo().updateIssue(current.id, patch);
      toast(rootEl, '最新状態を取得しました', 'ok');
      void loadCurrent();
    } catch (e) {
      toast(rootEl, `取得に失敗しました: ${(e as Error).message}`, 'error');
    }
  }

  return wrap;
}

/** ISO 文字列をローカル日付 'YYYY-MM-DD' に変換 (無効なら '—')。 */
function localDayOf(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** ISO 文字列を datetime-local 入力用のローカル 'YYYY-MM-DDTHH:MM' に変換。 */
function toLocalDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 個別レポートを開くリンク。一覧の「レポート」列と同じ振る舞いにする
 *  (クリックで SP 上のファイルを取得してダウンロード)。無ければ「—」。 */
function reportLink(i: ManagedIssue, root: HTMLElement): HTMLElement {
  if (!i.reportUrl) return el('span', {}, ['—']);
  return el('a', {
    href: '#', class: 'mikke-link',
    title: `${i.reportName ?? ''}${i.reportAt ? ` (${fmtDate(i.reportAt)})` : ''}`,
    onclick: (e: Event) => void (async () => {
      e.preventDefault();
      try {
        const href = await getRepo().docFileHref(i.reportUrl!);
        if (!href) { toast(root, 'レポートが見つかりません（削除済みの可能性）。', 'warn'); return; }
        const a = el('a', { href, download: i.reportName || 'report', style: 'display:none' });
        root.appendChild(a); a.click(); a.remove();
      } catch (err) {
        toast(root, `レポートの取得に失敗しました: ${(err as Error).message}`, 'error');
      }
    })(),
  }, [reportLinkLabel(i.reportName)]);
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
