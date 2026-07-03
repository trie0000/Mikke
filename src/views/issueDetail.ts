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
import { nextDetectionWhenPresent, nextDetectionWhenAbsent } from '../lib/detection';
import { openModal } from '../components/modal';
import { sanitizeNoteHtml } from '../utils/sanitize';
import {
  parseEml, parseMsgFile, parseOutlookDragText, looksLikeEml, looksLikeOutlookDrag,
  normalizeMailPlainText, splitQuotedReplyText, splitQuotedReplyHtml, stripHtml, type ParsedMail,
} from '../lib/emlParser';
import type { ManagedIssue, ResponseHistory, HistoryThread, HistorySource } from '../types';

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
  // 対応履歴 (現在の Issue) と表示スレッド (external/internal/both)。
  let historyEntries: ResponseHistory[] = [];
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
    await loadHistory();
    paintTabs();
    paintBody();
  }

  function paintTabs(): void {
    clear(detailTabs);
    const tabs: { key: DetailTab; label: string }[] = [
      { key: 'overview', label: '概要' },
      { key: 'scanner', label: '検査ツール詳細' },
      { key: 'mgmt', label: '管理情報' },
      { key: 'history', label: '対応履歴' },
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
      body.appendChild(renderHistory());
    }
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
      toast(rootEl, '中継サーバが起動していません。mikke-start.bat を実行してください。', 'warn');
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

/** ISO 文字列を datetime-local 入力用のローカル 'YYYY-MM-DDTHH:MM' に変換。 */
function toLocalDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
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
