// 海外脆弱性一覧。国内の管理対象一覧より項目が少ない、通知状況を追うための画面。
//
// ★ 取り込みは Excel。地域ごと・モニタリング区分ごとにファイルが分かれているので、
//   **複数ファイルをまとめて** 選ぶ / ドラッグできるようにしている。月次で取り込む想定。
// ★ Excel は追記型。検知状況はファイル内の履歴から決まるので、同じファイルを
//   2 回取り込んでも結果は変わらない (lib/overseas.ts)。
import { el, clear, fmtDate } from '../utils/dom';
import { icon } from '../icons';
import { getRepo } from '../api/repo';
import { toast } from '../components/toast';
import { DataTable } from './dataTable';
import { parseXlsxSheet, xlsxSheetNames } from '../lib/xlsx';
import { parseFlexibleDate } from '../lib/migration';
import { buildOverseasPlan, indexMergedCsv, OVERSEAS_COL, type OverseasPlan } from '../lib/overseas';
import { loadLatestMergedCsv } from '../lib/downloadFlow';
import { LABEL } from '../lib/fieldLabels';
import type { OverseasIssue } from '../types';

export function renderOverseasView(rootEl: HTMLElement): HTMLElement {
  const root = el('div', { class: 'mikke-main', style: 'display:flex;flex-direction:column' });
  const subbar = el('div', { class: 'mikke-subbar' });
  const toolbar = el('div', { class: 'mikke-toolbar' });
  const tableWrap = el('div', { class: 'mikke-table-wrap' });
  root.append(subbar, toolbar, tableWrap);

  let cache: OverseasIssue[] = [];
  let busy = false;
  /** 取り込み前の確認を出している間は表を描き直さない (描くと確認画面が消える)。 */
  let previewing = false;

  const table = new DataTable<OverseasIssue>(tableWrap, {
    storeKey: 'mikke.overseas',
    columns: [],
    rowId: (i) => i.id,
    virtualMin: 40,
    emptyText: 'まだ取り込んでいません。「Excel を取り込む」から月次のファイルを読み込んでください。',
  });

  function buildColumns(): void {
    table.setColumns([
      { id: 'no', label: '#No', width: 80, sortValue: (i) => i.id,
        text: (i) => `#${i.id}`, cellStyle: 'color:var(--ink-3)' },
      { id: 'iid', label: LABEL.issueInstanceId, width: 170, text: (i) => i.issueInstanceId },
      { id: 'contactedAt', label: '通知日', width: 116,
        text: (i) => fmtDate(i.contactedAt, false) || '', sortValue: (i) => i.contactedAt ?? '' },
      { id: 'detection', label: LABEL.detectionStatus, width: 110, text: (i) => i.detectionStatus },
      { id: 'open', label: 'open', width: 120, text: (i) => i.openStatus ?? '',
        cellStyle: 'color:var(--ink-3)' },
      { id: 'region', label: '地域', width: 100, text: (i) => i.region ?? '' },
      { id: 'businessCompany', label: LABEL.businessCompany, width: 150, text: (i) => i.businessCompany ?? '' },
      { id: 'affiliateCompany', label: LABEL.affiliateCompany, width: 150, text: (i) => i.affiliateCompany ?? '' },
      { id: 'webMapsId', label: LABEL.assetMgmtId, width: 150, text: (i) => i.webMapsId ?? '' },
      { id: 'identifyEvidence', label: '参考情報', width: 200, text: (i) => i.identifyEvidence ?? '' },
      { id: 'assetIp', label: 'IP', width: 140, text: (i) => i.assetIp ?? '' },
      { id: 'assetFqdn', label: 'FQDN', width: 200, text: (i) => i.assetFqdn ?? '' },
      { id: 'title', label: LABEL.title, width: 260, text: (i) => i.title ?? '' },
      { id: 'assetTitle', label: 'Asset Title', width: 180, text: (i) => i.assetTitle ?? '' },
      { id: 'assetMappedDomains', label: 'Asset Mapped Domains', width: 220,
        text: (i) => i.assetMappedDomains ?? '' },
      { id: 'assetHomepageUrl', label: 'Asset Homepage URL', width: 220,
        text: (i) => i.assetHomepageUrl ?? '' },
      { id: 'lastSeen', label: LABEL.lastSeen, width: 150,
        text: (i) => fmtDate(i.lastSeen) || '', sortValue: (i) => i.lastSeen ?? '' },
      { id: 'remarks', label: LABEL.responseRemarks, width: 240, text: (i) => i.remarks ?? '' },
    ]);
  }

  async function load(): Promise<void> {
    previewing = false;
    clear(tableWrap);
    tableWrap.appendChild(el('div', { class: 'mikke-empty' }, ['読み込み中…']));
    try {
      cache = await getRepo().listOverseasIssues();
      buildColumns();
      table.setRows(cache);
      paint();
    } catch (e) {
      clear(tableWrap);
      tableWrap.appendChild(el('div', { class: 'mikke-error' }, [
        `海外脆弱性一覧の取得に失敗しました: ${(e as Error).message}`,
      ]));
    }
  }

  // ── 取り込み ──────────────────────────────────────────────────────────────
  const fileInput = el('input', {
    type: 'file', accept: '.xlsx', multiple: 'multiple', style: 'display:none',
  }) as HTMLInputElement;
  fileInput.addEventListener('change', () => {
    const files = [...(fileInput.files ?? [])];
    fileInput.value = '';
    if (files.length) void importFiles(files);
  });

  /** 複数ファイルを 1 回の取り込みとして扱う (地域ごとのファイルをまとめて読む)。 */
  async function importFiles(files: File[]): Promise<void> {
    if (busy) return;
    busy = true;
    paint();
    const box = el('div', { class: 'mikke-note' }, [`${files.length} ファイルを読み込んでいます…`]);
    clear(tableWrap); tableWrap.appendChild(box);
    try {
      const rows: Record<string, string>[] = [];
      const headers = new Set<string>();
      const badFiles: string[] = [];
      // ★ ファイルの読み出しは待ち時間なので **まとめて先に** 済ませる。
      //   解析 (unzip + XML) は CPU の仕事で並列にしても速くならないため、
      //   読み出しだけ並行にして、解析は順にかけて進捗を出す。
      const buffers = await Promise.all(files.map(async (f) => {
        try { return { f, buf: await f.arrayBuffer(), err: '' }; }
        catch (e) { return { f, buf: null, err: (e as Error).message }; }
      }));
      for (const [i, b] of buffers.entries()) {
        box.textContent = `読み込んでいます… (${i + 1}/${files.length}) ${b.f.name}`;
        if (!b.buf) { badFiles.push(`${b.f.name} (${b.err})`); continue; }
        try {
          // ★ シート名は決まっていないので先頭シートを読む (テーブルオブジェクトでもない)。
          const names = xlsxSheetNames(b.buf);
          const sheet = parseXlsxSheet(b.buf, names[0] ?? '');
          if (!sheet || !sheet.rows.length) { badFiles.push(`${b.f.name} (行が読めません)`); continue; }
          for (const h of sheet.headers) headers.add(h);
          rows.push(...sheet.rows);
        } catch (e) {
          badFiles.push(`${b.f.name} (${(e as Error).message})`);
        }
        // 大きいファイルが続くと画面が固まるので、1 ファイルごとに描画を通す。
        await new Promise((r) => setTimeout(r, 0));
      }
      if (!rows.length) {
        previewing = true;
        clear(tableWrap);
        tableWrap.appendChild(el('div', { class: 'mikke-error' }, [
          `読み込める行がありませんでした。${badFiles.join(' / ')}`,
        ]));
        return;
      }
      box.textContent = 'ダウンロード済みの CSV と突き合わせています…';
      // ★ 脆弱性・資産の情報は「ダウンロードデータ」のマージ CSV から引く。
      //   管理対象一覧だと、管理対象条件に一致しなかった脆弱性が見つからない。
      const [existing, domestic, merged] = await Promise.all([
        getRepo().listOverseasIssues(),
        getRepo().listIssues(),
        loadLatestMergedCsv().catch(() => null),
      ]);
      const plan = buildOverseasPlan(rows, [...headers], existing,
        indexMergedCsv(merged?.rows ?? []), domestic,
        parseFlexibleDate, new Date().toISOString());
      previewing = true;
      showPreview(plan, files.length, rows.length, badFiles, merged);
    } catch (e) {
      previewing = true;
      clear(tableWrap);
      tableWrap.appendChild(el('div', { class: 'mikke-error' }, [`取り込みに失敗しました: ${(e as Error).message}`]));
    } finally {
      busy = false;
      paint();
    }
  }

  /** 取り込む前に中身を見せる。ここで気づけないと、入れてから直すことになる。 */
  function showPreview(
    plan: OverseasPlan, fileCount: number, rowCount: number, badFiles: string[],
    merged: { fileName: string; downloadedAt: string; rows: unknown[] } | null,
  ): void {
    clear(tableWrap);
    const box = el('div', { style: 'padding:var(--s-6) var(--gutter);max-width:900px' });
    box.append(
      el('div', { class: 'mikke-note' }, [
        `${fileCount} ファイル / ${rowCount} 行を読みました。`,
        el('br'),
        `追加 ${plan.creates.length} 件 / 更新 ${plan.updates.length} 件`
        + `（脆弱性 × 地域 で ${plan.entries} 件）`
        + (plan.skipped ? ` / ${OVERSEAS_COL.issueInstanceId} が空で取り込めない ${plan.skipped} 行` : ''),
      ]),
      el('div', { class: merged ? 'mikke-note' : 'mikke-error', style: 'margin-top:var(--s-3)' }, [
        merged
          ? `脆弱性・資産の情報は ${merged.fileName} (${fmtDate(merged.downloadedAt)} / ${merged.rows.length} 行) から引きます。`
          : 'ダウンロードデータにマージ CSV がありません。脆弱性タイトル・資産の情報は空になります'
            + '（「情報更新(全件)」でレポートを取得してください）。',
      ]),
      ...(badFiles.length ? [el('div', { class: 'mikke-error', style: 'margin-top:var(--s-3)' }, [
        `読めなかったファイル: ${badFiles.join(' / ')}`,
      ])] : []),
      ...(plan.missingColumns.length ? [el('div', { class: 'mikke-error', style: 'margin-top:var(--s-3)' }, [
        `見つからない列があります: ${plan.missingColumns.join(' / ')}`,
        el('br'),
        '1 行目が見出しになっているか確認してください。',
      ])] : []),
      ...(plan.unmatched.length ? [el('div', { class: 'mikke-error', style: 'margin-top:var(--s-3)' }, [
        `ダウンロード済み CSV にも管理対象にも無い ${OVERSEAS_COL.issueInstanceId} が `
        + `${plan.unmatched.length} 件あります: `
        + plan.unmatched.slice(0, 10).join(' / ') + (plan.unmatched.length > 10 ? ' …' : ''),
        el('br'),
        '脆弱性タイトル・資産の情報は空になります。',
      ])] : []),
    );
    const warned = plan.warnings.slice(0, 20);
    if (warned.length) {
      box.appendChild(el('div', { style: 'margin-top:var(--s-3)' }, [
        el('div', { class: 'mikke-note' }, [`気づいたこと (先頭 20 件 / 全 ${plan.warnings.length} 件):`]),
        el('ul', { style: 'margin:var(--s-2) 0;padding-left:1.2em;font-size:var(--fs-sm);color:var(--ink-2)' },
          warned.map((w) => el('li', {}, [`${w.issueInstanceId}: ${w.message}`]))),
      ]));
    }
    const run = el('button', { class: 'mikke-btn mikke-btn--primary', type: 'button' }, ['この内容で取り込む']);
    const cancel = el('button', { class: 'mikke-btn mikke-btn--secondary', type: 'button' }, ['やめる']);
    cancel.addEventListener('click', () => void load());
    run.addEventListener('click', () => void (async () => {
      run.setAttribute('disabled', '');
      const line = el('div', { class: 'mikke-note', style: 'margin-top:var(--s-4)' }, ['書き込んでいます…']);
      box.appendChild(line);
      try {
        const r = await getRepo().applyOverseasPlan(plan.creates, plan.updates, (d, t) => {
          line.textContent = `書き込んでいます… (${d}/${t})`;
        });
        toast(rootEl, `海外脆弱性一覧を取り込みました (${r.ok} 件${r.fail ? ` / 失敗 ${r.fail} 件` : ''})`,
          r.fail ? 'warn' : 'ok');
        await load();
      } catch (e) {
        toast(rootEl, `取り込みに失敗しました: ${(e as Error).message}`, 'error');
        run.removeAttribute('disabled');
      }
    })());
    box.appendChild(el('div', { style: 'margin-top:var(--s-5);display:flex;gap:var(--s-3)' }, [run, cancel]));
    tableWrap.appendChild(box);
  }

  // ドラッグ＆ドロップ (複数ファイルまとめて)
  const stop = (e: Event): void => { e.preventDefault(); e.stopPropagation(); };
  for (const t of ['dragenter', 'dragover']) {
    root.addEventListener(t, (e) => { stop(e); root.style.outline = '2px dashed var(--accent)'; });
  }
  for (const t of ['dragleave', 'drop']) {
    root.addEventListener(t, (e) => { stop(e); root.style.outline = ''; });
  }
  root.addEventListener('drop', (e) => {
    const files = [...((e as DragEvent).dataTransfer?.files ?? [])]
      .filter((f) => /\.xlsx$/i.test(f.name));
    if (files.length) void importFiles(files);
    else toast(rootEl, '.xlsx ファイルをドロップしてください。', 'warn');
  });

  function paint(): void {
    clear(subbar);
    subbar.append(
      el('span', { class: 'mikke-subbar-title' }, ['海外脆弱性一覧']),
      el('span', { class: 'mikke-subbar-count' }, [`${cache.length} 件`]),
    );
    clear(toolbar);
    const importBtn = el('button', {
      class: 'mikke-btn mikke-btn--primary', style: 'height:30px;font-size:var(--fs-sm)',
      title: '地域ごとの Excel をまとめて選べます。画面へドラッグしても取り込めます',
      ...(busy ? { disabled: 'disabled' } : {}),
      onclick: () => fileInput.click(),
      html: icon('upload') + '<span>Excel を取り込む</span>',
    });
    toolbar.append(
      importBtn,
      fileInput,
      el('span', { style: 'color:var(--ink-3);font-size:var(--fs-sm)' }, [
        '地域ごと・モニタリング区分ごとのファイルをまとめて読み込めます（ドラッグ＆ドロップ可）。',
      ]),
    );
    if (!busy && !previewing) table.render();
  }

  paint();
  void load();
  return root;
}
