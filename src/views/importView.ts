// F1: CSV 一括取込。約2万件/100MB のため中継サーバ側で解析 (技術設計書 §11)。
// 骨組み: ファイル選択 → (中継 health 確認) → プレビュー → 確定 の 3 ステップ。
import { el, clear } from '../utils/dom';
import { icon } from '../icons';
import { toast } from '../components/toast';
import { relayHealth, relayCsvParse } from '../api/relay';
import { parseCsv } from '../lib/csv';
import type { CsvParseResult } from '../api/relay';

export function renderImportView(rootEl: HTMLElement): HTMLElement {
  const wrap = el('div', { class: 'mikke-main' });
  wrap.appendChild(el('div', { class: 'mikke-subbar' }, [
    el('span', { class: 'mikke-subbar-title' }, ['CSV 取込']),
  ]));
  const area = el('div', { style: 'padding:var(--gutter);max-width:760px' });
  wrap.appendChild(area);

  let step: 'select' | 'preview' = 'select';
  let result: CsvParseResult | null = null;

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
        '※ 大容量 CSV (約2万件/100MB) は中継サーバ側で解析します。中継サーバ (mikke-start.bat) を起動しておいてください。',
      ]),
      el('div', { style: 'margin-top:var(--s-6)' }, [fileInput]),
    );
  }

  async function handleFile(file: File): Promise<void> {
    const h = await relayHealth();
    if (h.ok) {
      try {
        result = await relayCsvParse(file, { /* managedColumns/conditions/individualIds/existingKeys は実装フェーズ */ });
        step = 'preview'; paint();
        return;
      } catch (e) {
        toast(rootEl, `中継サーバでの解析に失敗しました: ${(e as Error).message}`, 'error');
      }
    } else {
      toast(rootEl, '中継サーバが未起動のため、簡易プレビューのみ表示します（本番取込には中継サーバが必要）。', 'warn');
      // フォールバック: 小規模 CSV のヘッダ/件数だけ簡易表示
      try {
        const text = await file.text();
        const parsed = parseCsv(text);
        result = {
          headers: parsed.headers,
          preview: parsed.rows.slice(0, 20),
          summary: { added: 0, updated: 0, undetected: 0, skipped: parsed.rows.length, rowCount: parsed.rows.length },
        };
        step = 'preview'; paint();
      } catch (e) {
        toast(rootEl, `CSV の読み込みに失敗しました: ${(e as Error).message}`, 'error');
      }
    }
  }

  function paintPreview(): void {
    if (!result) { step = 'select'; paint(); return; }
    const s = result.summary;
    area.append(
      el('div', { style: 'display:flex;gap:var(--s-5);margin-bottom:var(--s-6)' }, [
        summaryChip('追加', s.added, 'accent'),
        summaryChip('更新', s.updated, ''),
        summaryChip('未検出', s.undetected, 'muted'),
        summaryChip('スキップ', s.skipped, 'muted'),
        summaryChip('総行数', s.rowCount, ''),
      ]),
    );

    // プレビュー表 (先頭数件)
    if (result.preview.length) {
      const cols = result.headers.slice(0, 6);
      const thead = el('thead', {}, [el('tr', {}, cols.map((c) => el('th', {}, [c])))]);
      const tbody = el('tbody', {}, result.preview.slice(0, 10).map((r) =>
        el('tr', {}, cols.map((c) => el('td', {}, [r[c] ?? '']))),
      ));
      area.appendChild(el('div', { class: 'mikke-table-wrap', style: 'padding:0' }, [
        el('table', { class: 'mikke-table' }, [thead, tbody]),
      ]));
    }

    area.appendChild(el('div', { style: 'margin-top:var(--s-7);display:flex;gap:var(--s-3)' }, [
      el('button', {
        class: 'mikke-btn mikke-btn--secondary',
        onclick: () => { step = 'select'; result = null; paint(); },
      }, ['戻る']),
      el('button', {
        class: 'mikke-btn mikke-btn--primary',
        onclick: () => {
          // 実際の SP 書き込み ($batch) は実装フェーズ。骨組みではトーストのみ。
          toast(rootEl, '取込の確定処理は実装フェーズで接続します（骨組み）。', 'warn');
        },
        html: icon('check') + '<span style="margin-left:6px">この内容で取り込む</span>',
      }),
    ]));
  }

  function summaryChip(label: string, n: number, variant: string): HTMLElement {
    return el('div', { style: 'text-align:center' }, [
      el('div', { style: 'font-size:var(--fs-h3);font-weight:700;color:var(--ink)' }, [String(n)]),
      el('div', { class: variant ? `mikke-badge mikke-badge--${variant}` : 'mikke-badge' }, [label]),
    ]);
  }

  return wrap;
}
