// F1: CSV 一括取込。約2万件/100MB の本番は中継サーバ側で解析 (技術設計書 §11)。
// クライアント側パースは小〜中規模の検証・mock 用フォールバック。
import { el, clear } from '../utils/dom';
import { icon } from '../icons';
import { toast } from '../components/toast';
import { getRepo } from '../api/repo';
import { setState } from '../state';
import { relayHealth } from '../api/relay';
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
    const h = await relayHealth();
    if (!h.ok) {
      toast(rootEl, '中継サーバ未起動 — ブラウザ側で解析します（大容量では重くなります）。', 'warn');
    }
    // 現状はクライアント側でパース → エンジンで差分判定。
    // (中継サーバの /mikke/csv-parse 実装が入ったら h.ok 時にそちらへ切替)
    try {
      const text = await file.text();
      const parsed = parseCsv(text);
      const existing = await getRepo().listIssues();
      const settings = await getRepo().getSettings();
      const nowIso = new Date().toISOString();
      plan = buildImportPlan(parsed.rows, parsed.headers, existing, settings, nowIso);
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
    let ok = 0, fail = 0;
    for (const op of plan.ops) {
      try {
        if (op.kind === 'add' && op.create) { await repo.createIssue(op.create); ok++; }
        else if ((op.kind === 'update' || op.kind === 'undetect') && op.id != null && op.patch) {
          await repo.updateIssue(op.id, op.patch); ok++;
        }
      } catch { fail++; }
    }
    toast(rootEl, `取込完了: ${ok} 件反映${fail ? ` / ${fail} 件失敗` : ''}`, fail ? 'warn' : 'ok');
    // 一覧へ
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
