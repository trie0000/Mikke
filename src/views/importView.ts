// F1: CSV 一括取込。約2万件/100MB の本番は中継サーバ側で解析 (技術設計書 §11)。
// クライアント側パースは小〜中規模の検証・mock 用フォールバック。
import { el, clear } from '../utils/dom';
import { icon } from '../icons';
import { toast } from '../components/toast';
import { getRepo } from '../api/repo';
import { getState, setState } from '../state';
import { relayHealth, relayCsvParse } from '../api/relay';
import { parseCsvAsync } from '../lib/csv';
import { buildImportPlan, type ImportPlan } from '../lib/import';

// ── 取込の進行状態 (モジュールスコープ) ──────────────────────────────────────
// ビュー切替 (一覧⇄取込) でビューは作り直されるため、ローカル state だと
// 「プレビューまで進めたのにメニューを切り替えたら消える」事故になる。
// step / plan / 進捗をモジュールスコープに保持し、再マウント時に復元する。
type ImportStep = 'select' | 'parsing' | 'preview' | 'committing';
let step: ImportStep = 'select';
let plan: ImportPlan | null = null;
let fileName = '';
let parsingMsg = '';
let progress: { done: number; total: number } | null = null;
/** 解析進捗の単位 (relay=バイト / ブラウザ=文字数)。 */
let parseUnit: 'bytes' | 'chars' = 'bytes';
// 非同期完了 (解析/取込) 時に「現在マウント中の」ビューを再描画するためのフック。
// 古いインスタンスの paint を呼ぶと detached DOM を更新するだけになるため。
let repaintCurrent: (() => void) | null = null;
// 進捗のみの軽量更新 (committing 表示中のラベル/バー)。
let progressNotify: (() => void) | null = null;

function resetImportState(): void {
  step = 'select';
  plan = null;
  fileName = '';
  parsingMsg = '';
  progress = null;
}

export function renderImportView(rootEl: HTMLElement): HTMLElement {
  const wrap = el('div', { class: 'mikke-main' });
  wrap.appendChild(el('div', { class: 'mikke-subbar' }, [
    el('span', { class: 'mikke-subbar-title' }, ['CSV 取込']),
  ]));
  const area = el('div', { style: 'padding:var(--gutter);max-width:860px' });
  wrap.appendChild(area);

  repaintCurrent = paint;
  paint();

  function paint(): void {
    clear(area);
    if (step === 'select') paintSelect();
    else if (step === 'parsing') paintParsing();
    else if (step === 'preview') paintPreview();
    else paintCommitting();
  }

  /** 解析中: フェーズメッセージ + 進捗バー (送信バイト / 解析文字数)。 */
  function paintParsing(): void {
    const fmtVal = (nv: number): string =>
      parseUnit === 'bytes' ? fmtBytes(nv) : `${nv.toLocaleString()} 文字`;
    const text = (): string => {
      const msg = parsingMsg || '解析中…';
      if (!progress || !progress.total) return msg;
      const pct = Math.round((progress.done / progress.total) * 100);
      return `${msg} ${fmtVal(progress.done)} / ${fmtVal(progress.total)} (${pct}%)`;
    };
    const pctWidth = (): string =>
      (progress && progress.total) ? `${Math.round((progress.done / progress.total) * 100)}%` : '0%';
    const label = el('div', { style: 'color:var(--ink-2);font-size:var(--fs-base);margin-bottom:var(--s-4)' }, [text()]);
    const bar = el('div', { class: 'mikke-progress-bar' });
    bar.style.width = pctWidth();
    const barWrap = el('div', { class: 'mikke-progress' }, [bar]);
    // 総量不明 (サーバ解析待ち等) の間はバーを隠してメッセージのみ
    barWrap.style.visibility = (progress && progress.total) ? 'visible' : 'hidden';
    area.append(
      el('p', { style: 'color:var(--ink-3);font-size:var(--fs-sm)' }, [`ファイル: ${fileName}`]),
      el('div', { style: 'text-align:center;padding:var(--s-10) 0' }, [label, barWrap]),
    );
    progressNotify = () => {
      if (!label.isConnected) return;
      label.textContent = text();
      bar.style.width = pctWidth();
      barWrap.style.visibility = (progress && progress.total) ? 'visible' : 'hidden';
    };
  }

  function fmtBytes(n: number): string {
    if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
    if (n >= 1024) return `${Math.round(n / 1024)} KB`;
    return `${n} B`;
  }

  function paintSelect(): void {
    const fileInput = el('input', {
      type: 'file', accept: '.csv,text/csv', class: 'mikke-dropzone-input',
      onchange: (e: Event) => {
        const f = (e.target as HTMLInputElement).files?.[0];
        if (f) void handleFile(f);
      },
    }) as HTMLInputElement;

    const dropzone = el('div', {
      class: 'mikke-dropzone',
      onclick: () => fileInput.click(),
      ondragenter: (e: Event) => { e.preventDefault(); dropzone.classList.add('is-dragover'); },
      ondragover: (e: Event) => { e.preventDefault(); dropzone.classList.add('is-dragover'); },
      ondragleave: (e: Event) => {
        // 子要素間の移動では外さない (relatedTarget が dropzone 内なら維持)
        if (!dropzone.contains((e as DragEvent).relatedTarget as Node)) {
          dropzone.classList.remove('is-dragover');
        }
      },
      ondrop: (e: Event) => {
        e.preventDefault();
        dropzone.classList.remove('is-dragover');
        const f = (e as DragEvent).dataTransfer?.files?.[0];
        if (!f) return;
        if (!/\.csv$/i.test(f.name)) {
          toast(rootEl, 'CSV ファイル（.csv）を選択してください。', 'warn');
          return;
        }
        void handleFile(f);
      },
    }, [
      el('div', { class: 'mikke-dropzone-icon', html: icon('upload') }),
      el('div', { class: 'mikke-dropzone-title', html: 'ここに CSV を<b>ドラッグ &amp; ドロップ</b>' }),
      el('div', { class: 'mikke-dropzone-hint' }, ['または']),
      el('button', {
        class: 'mikke-btn mikke-btn--primary', type: 'button',
        onclick: (e: Event) => { e.stopPropagation(); fileInput.click(); },
      }, ['ファイルを選択']),
      fileInput,
    ]);

    area.append(
      el('p', { style: 'color:var(--ink-2)' }, [
        '脆弱性検査ツールからダウンロードした全件 CSV を選択してください。',
      ]),
      el('p', { style: 'color:var(--ink-4);font-size:var(--fs-sm)' }, [
        '※ 大容量 CSV (約2万件/100MB) は中継サーバ側で解析します。中継サーバ (mikke-launch) を起動しておいてください。中継未起動時はブラウザ側で解析します。',
      ]),
      el('div', { style: 'margin-top:var(--s-6)' }, [dropzone]),
    );
  }

  async function handleFile(file: File): Promise<void> {
    fileName = file.name;
    // 解析には時間がかかる (大容量 CSV / 中継サーバ往復) ので、まず「解析中」を
    // 表示する。これが無いと押下後に画面が無反応に見えて「何も起きない」と誤認する。
    showBusy(`「${file.name}」を解析中…`);
    // eslint-disable-next-line no-console
    console.log('[mikke] import: handleFile start', { name: file.name, size: file.size });
    try {
      let headers: string[];
      let rows: Record<string, string>[];

      // 中継サーバ起動時はサーバ側パース (大容量対応)、未起動時はブラウザ側。
      const h = await relayHealth();
      // eslint-disable-next-line no-console
      console.log('[mikke] import: relayHealth', h);
      if (h.ok) {
        parseUnit = 'bytes';
        showBusy(`「${file.name}」を中継サーバへ送信中…`);
        const res = await relayCsvParse(file, (phase, done, total) => {
          if (phase === 'upload') {
            parsingMsg = `「${file.name}」を中継サーバへ送信中…`;
            progress = total ? { done, total } : null;
          } else if (phase === 'server') {
            parsingMsg = '中継サーバで解析中…（サイズにより時間がかかります）';
            progress = null;
          } else {
            parsingMsg = '解析結果を受信中…';
            progress = total ? { done, total } : null;
          }
          progressNotify?.();
        });
        headers = res.headers;
        rows = res.rows;
        // eslint-disable-next-line no-console
        console.log('[mikke] import: relay parsed', { rows: rows.length, cols: headers.length });
      } else {
        toast(rootEl, '中継サーバ未起動 — ブラウザ側で解析します（大容量では重くなります）。', 'warn');
        parseUnit = 'chars';
        showBusy(`「${file.name}」をブラウザで解析中…`);
        const textData = await file.text();
        const parsed = await parseCsvAsync(textData, (done, total) => {
          progress = { done, total };
          progressNotify?.();
        });
        headers = parsed.headers;
        rows = parsed.rows;
        // eslint-disable-next-line no-console
        console.log('[mikke] import: browser parsed', { rows: rows.length, cols: headers.length });
      }
      progress = null;

      if (!headers.length) {
        throw new Error('ヘッダを検出できませんでした（空の CSV か区切り文字が不正の可能性）。');
      }

      const existing = await getRepo().listIssues();
      const settings = await getRepo().getSettings();
      const nowIso = new Date().toISOString();
      plan = buildImportPlan(rows, headers, existing, settings, nowIso);
      step = 'preview';
      repaintCurrent?.();
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[mikke] import: failed', e);
      toast(rootEl, `CSV の解析に失敗しました: ${(e as Error).message}`, 'error');
      step = 'select';
      repaintCurrent?.();
    }
  }

  /** 解析中の一時表示（押下後の無反応を防ぐ）。ビュー切替後も復元される。 */
  function showBusy(msg: string): void {
    step = 'parsing';
    parsingMsg = msg;
    repaintCurrent?.();
  }

  function paintPreview(): void {
    if (!plan) { step = 'select'; paint(); return; }
    const s = plan.summary;
    area.append(
      el('p', { style: 'color:var(--ink-3);font-size:var(--fs-sm)' }, [`ファイル: ${fileName}`]),
      el('div', { style: 'display:flex;gap:var(--s-7);margin:var(--s-5) 0' }, [
        summaryChip('追加', s.added, 'accent'),
        summaryChip('更新', s.updated, ''),
        summaryChip('未検出', s.undetected, 'muted'),
        summaryChip('スキップ', s.skipped, 'muted'),
        summaryChip('総行数', s.rowCount, ''),
      ]),
    );

    // 差分プレビュー (追加・更新・未検出を抜粋表示)
    const shown = plan.ops.filter((o) => o.kind !== 'skip').slice(0, 50);
    if (shown.length) {
      const thead = el('thead', {}, [el('tr', {}, [
        el('th', {}, ['操作']), el('th', {}, ['Issue Instance ID']), el('th', {}, ['タイトル']), el('th', {}, ['備考']),
      ])]);
      const tbody = el('tbody', {}, shown.map((o) => {
        const opLabel = { add: '追加', update: '更新', undetect: '未検出化', skip: 'スキップ' }[o.kind];
        const variant = { add: 'accent', update: '', undetect: 'muted', skip: 'muted' }[o.kind];
        let note = o.note ?? '';
        if (o.kind === 'update' && o.patch?.detectionStatus) note = `検知→${o.patch.detectionStatus}`;
        if (o.kind === 'undetect' && o.patch?.detectionStatus) note = `検知→${o.patch.detectionStatus}`;
        if (o.kind === 'add' && o.create?.addedReason) note = o.create.addedReason;
        return el('tr', {}, [
          el('td', {}, [el('span', { class: variant ? `mikke-badge mikke-badge--${variant}` : 'mikke-badge' }, [opLabel])]),
          el('td', {}, [o.issueInstanceId || '—']),
          el('td', {}, [o.title || '(無題)']),
          el('td', { style: 'color:var(--ink-3)' }, [note]),
        ]);
      }));
      area.appendChild(el('div', { class: 'mikke-table-wrap', style: 'padding:0;max-height:380px' }, [
        el('table', { class: 'mikke-table' }, [thead, tbody]),
      ]));
    } else {
      area.appendChild(el('div', { class: 'mikke-empty' }, ['追加・更新・未検出化の対象がありません（全行スキップ）。']));
    }

    area.appendChild(el('div', { style: 'margin-top:var(--s-7);display:flex;gap:var(--s-3)' }, [
      el('button', {
        class: 'mikke-btn mikke-btn--secondary',
        onclick: () => { resetImportState(); paint(); },
      }, ['戻る']),
      el('button', {
        class: 'mikke-btn mikke-btn--primary',
        onclick: () => void commit(),
        html: icon('check') + '<span>この内容で取り込む</span>',
      }),
    ]));
  }

  /** 取込確定中: 「N / 合計 件」の進捗を表示。ビュー切替後も復元される。 */
  function paintCommitting(): void {
    const text = (): string => {
      const d = progress?.done ?? 0;
      const t = progress?.total ?? 0;
      const pct = t ? Math.round((d / t) * 100) : 0;
      return `${d} / ${t} 件を書き込み中… (${pct}%)`;
    };
    const pctWidth = (): string => {
      const d = progress?.done ?? 0;
      const t = progress?.total ?? 0;
      return t ? `${Math.round((d / t) * 100)}%` : '0%';
    };
    const label = el('div', { style: 'color:var(--ink-2);font-size:var(--fs-base);margin-bottom:var(--s-4)' }, [text()]);
    const bar = el('div', { class: 'mikke-progress-bar' });
    bar.style.width = pctWidth();   // 動的状態 (進捗) のためここだけ style 直接更新
    area.append(
      el('p', { style: 'color:var(--ink-3);font-size:var(--fs-sm)' }, [`ファイル: ${fileName}`]),
      el('div', { style: 'text-align:center;padding:var(--s-10) 0' }, [
        label,
        el('div', { class: 'mikke-progress' }, [bar]),
        el('div', { style: 'margin-top:var(--s-4);color:var(--ink-4);font-size:var(--fs-sm)' }, [
          '画面を切り替えても取込は継続します。',
        ]),
      ]),
    );
    progressNotify = () => {
      if (!label.isConnected) return;   // 別ビュー表示中は更新不要 (再表示時に復元)
      label.textContent = text();
      bar.style.width = pctWidth();
    };
  }

  async function commit(): Promise<void> {
    if (!plan) return;
    const repo = getRepo();
    const myPlan = plan;
    step = 'committing';
    progress = { done: 0, total: myPlan.ops.filter((o) => o.kind !== 'skip').length };
    repaintCurrent?.();
    try {
      // F6: 取込前に、設定でチェックした動的列 (Scan_*) を SP に作成しておく。
      const settings = await repo.getSettings();
      if (settings.managedColumns.length) {
        await repo.ensureScanColumns(settings.managedColumns);
      }
      // F6/F7 の列候補サジェスト用に、今回の CSV ヘッダを設定に保存。
      if (myPlan.headers.length) {
        await repo.saveSettings({ ...settings, lastCsvHeaders: myPlan.headers }).catch(() => { /* noop */ });
      }
      const { ok, fail } = await repo.applyImportOps(myPlan.ops, (done, total) => {
        progress = { done, total };
        progressNotify?.();
      });
      // ImportLog 記録
      const user = await repo.getCurrentUser();
      await repo.writeImportLog({
        fileName,
        operator: user?.displayName ?? user?.email ?? '',
        added: myPlan.summary.added,
        updated: myPlan.summary.updated,
        undetected: myPlan.summary.undetected,
        skipped: myPlan.summary.skipped,
        rowCount: myPlan.summary.rowCount,
        importedAt: new Date().toISOString(),
      }).catch(() => { /* ログ失敗は取込自体を止めない */ });
      // 失敗があれば手動 dismiss の error で目立たせる (一覧に出ない原因の特定用に
      // $batch のエラー詳細を console に出している → F12 で確認できる旨を案内)。
      toast(rootEl,
        `取込完了: ${ok} 件反映${fail ? ` / ${fail} 件失敗（詳細は F12 コンソール）` : ''}`,
        fail ? 'error' : 'ok');
      resetImportState();
      // 取込ビューを見ている時だけ一覧へ移動 (別ビュー閲覧中に画面を奪わない)。
      if (getState().view === 'import') {
        setState({ view: 'issues', selectedIssueId: null });
      } else {
        repaintCurrent?.();
      }
    } catch (e) {
      toast(rootEl, `取込に失敗しました: ${(e as Error).message}`, 'error');
      step = 'preview';
      progress = null;
      repaintCurrent?.();
    }
  }

  function summaryChip(label: string, n: number, variant: string): HTMLElement {
    return el('div', { style: 'text-align:center' }, [
      el('div', { style: 'font-size:var(--fs-h3);font-weight:700;color:var(--ink)' }, [String(n)]),
      el('div', { class: variant ? `mikke-badge mikke-badge--${variant}` : 'mikke-badge' }, [label]),
    ]);
  }

  return wrap;
}
