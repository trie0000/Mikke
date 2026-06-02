// F1: CSV 一括取込。約2万件/100MB の本番は中継サーバ側で解析 (技術設計書 §11)。
// クライアント側パースは小〜中規模の検証・mock 用フォールバック。
import { el, clear } from '../utils/dom';
import { icon } from '../icons';
import { toast } from '../components/toast';
import { getRepo } from '../api/repo';
import { setState } from '../state';
import { relayHealth, relayCsvParse } from '../api/relay';
import { parseCsv } from '../lib/csv';
import { buildImportPlan, type ImportPlan } from '../lib/import';

export function renderImportView(rootEl: HTMLElement): HTMLElement {
  const wrap = el('div', { class: 'mikke-main' });
  wrap.appendChild(el('div', { class: 'mikke-subbar' }, [
    el('span', { class: 'mikke-subbar-title' }, ['CSV 取込']),
  ]));
  const area = el('div', { style: 'padding:var(--gutter);max-width:860px' });
  wrap.appendChild(area);

  let step: 'select' | 'preview' = 'select';
  let plan: ImportPlan | null = null;
  let fileName = '';

  paint();

  function paint(): void {
    clear(area);
    if (step === 'select') paintSelect();
    else paintPreview();
  }

  function paintSelect(): void {
    const fileInput = el('input', {
      type: 'file', accept: '.csv,text/csv',
      onchange: (e: Event) => {
        const f = (e.target as HTMLInputElement).files?.[0];
        if (f) void handleFile(f);
      },
    }) as HTMLInputElement;

    area.append(
      el('p', { style: 'color:var(--ink-2)' }, [
        '脆弱性検査ツールからダウンロードした全件 CSV を選択してください。',
      ]),
      el('p', { style: 'color:var(--ink-4);font-size:var(--fs-sm)' }, [
        '※ 大容量 CSV (約2万件/100MB) は中継サーバ側で解析します。中継サーバ (mikke-launch) を起動しておいてください。中継未起動時はブラウザ側で解析します。',
      ]),
      el('div', { style: 'margin-top:var(--s-6)' }, [fileInput]),
    );
  }

  async function handleFile(file: File): Promise<void> {
    fileName = file.name;
    try {
      let headers: string[];
      let rows: Record<string, string>[];

      // 中継サーバ起動時はサーバ側パース (大容量対応)、未起動時はブラウザ側。
      const h = await relayHealth();
      if (h.ok) {
        const res = await relayCsvParse(file);
        headers = res.headers;
        rows = res.rows;
      } else {
        toast(rootEl, '中継サーバ未起動 — ブラウザ側で解析します（大容量では重くなります）。', 'warn');
        const parsed = parseCsv(await file.text());
        headers = parsed.headers;
        rows = parsed.rows;
      }

      const existing = await getRepo().listIssues();
      const settings = await getRepo().getSettings();
      const nowIso = new Date().toISOString();
      plan = buildImportPlan(rows, headers, existing, settings, nowIso);
      step = 'preview';
      paint();
    } catch (e) {
      toast(rootEl, `CSV の解析に失敗しました: ${(e as Error).message}`, 'error');
    }
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
        onclick: () => { step = 'select'; plan = null; paint(); },
      }, ['戻る']),
      el('button', {
        class: 'mikke-btn mikke-btn--primary',
        onclick: () => void commit(),
        html: icon('check') + '<span style="margin-left:6px">この内容で取り込む</span>',
      }),
    ]));
  }

  async function commit(): Promise<void> {
    if (!plan) return;
    const repo = getRepo();
    try {
      // F6: 取込前に、設定でチェックした動的列 (Scan_*) を SP に作成しておく。
      const settings = await repo.getSettings();
      if (settings.managedColumns.length) {
        await repo.ensureScanColumns(settings.managedColumns);
      }
      // F6/F7 の列候補サジェスト用に、今回の CSV ヘッダを設定に保存。
      if (plan.headers.length) {
        await repo.saveSettings({ ...settings, lastCsvHeaders: plan.headers }).catch(() => { /* noop */ });
      }
      const { ok, fail } = await repo.applyImportOps(plan.ops);
      // ImportLog 記録
      const user = await repo.getCurrentUser();
      await repo.writeImportLog({
        fileName,
        operator: user?.displayName ?? user?.email ?? '',
        added: plan.summary.added,
        updated: plan.summary.updated,
        undetected: plan.summary.undetected,
        skipped: plan.summary.skipped,
        rowCount: plan.summary.rowCount,
        importedAt: new Date().toISOString(),
      }).catch(() => { /* ログ失敗は取込自体を止めない */ });
      toast(rootEl, `取込完了: ${ok} 件反映${fail ? ` / ${fail} 件失敗` : ''}`, fail ? 'warn' : 'ok');
    } catch (e) {
      toast(rootEl, `取込に失敗しました: ${(e as Error).message}`, 'error');
      return;
    }
    setState({ view: 'issues', selectedIssueId: null });
  }

  function summaryChip(label: string, n: number, variant: string): HTMLElement {
    return el('div', { style: 'text-align:center' }, [
      el('div', { style: 'font-size:var(--fs-h3);font-weight:700;color:var(--ink)' }, [String(n)]),
      el('div', { class: variant ? `mikke-badge mikke-badge--${variant}` : 'mikke-badge' }, [label]),
    ]);
  }

  return wrap;
}
