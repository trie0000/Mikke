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
import { createProgressLine } from '../components/progressLine';
import { DataTable } from './dataTable';
import { parseXlsxSheet, xlsxSheetNames } from '../lib/xlsx';
import { parseFlexibleDate } from '../lib/migration';
import { buildOverseasPlan, indexMergedCsv, OVERSEAS_COL, type OverseasPlan } from '../lib/overseas';
import { loadLatestMergedCsv } from '../lib/downloadFlow';
import { LABEL } from '../lib/fieldLabels';
import { buildOverseasResponsePlan, overseasKey } from '../lib/overseasResponseSync';
import { normalizePerms, registeredCompanies } from '../lib/itemPerms';
import type { OverseasIssue } from '../types';

export function renderOverseasView(rootEl: HTMLElement): HTMLElement {
  const root = el('div', { class: 'mikke-main', style: 'display:flex;flex-direction:column' });
  const subbar = el('div', { class: 'mikke-subbar' });
  const toolbar = el('div', { class: 'mikke-toolbar' });
  const tableWrap = el('div', { class: 'mikke-table-wrap' });
  // ★ 一括処理の進捗。subbar / toolbar は描き直しで中身が消えるので、
  //   進捗行は独立した要素として置く。
  const progress = createProgressLine();
  root.append(subbar, toolbar, progress.el, tableWrap);

  let cache: OverseasIssue[] = [];
  let busy = false;
  /** 反映などの一括処理中。二重起動を防ぐ。 */
  let bulkBusy = false;
  /** 選択分の反映で使う (行 ID)。 */
  const selected = new Set<number>();
  /** 事業会社の選択肢 (アクセス権画面で登録した一覧)。 */
  let companies: string[] = [];
  /** 取り込み前の確認を出している間は表を描き直さない (描くと確認画面が消える)。 */
  let previewing = false;

  const table = new DataTable<OverseasIssue>(tableWrap, {
    storeKey: 'mikke.overseas',
    columns: [],
    rowId: (i) => i.id,
    virtualMin: 40,
    selection: {
      checked: (i) => selected.has(i.id),
      onToggle: (i, on) => { if (on) selected.add(i.id); else selected.delete(i.id); paintSubbar(); },
      onToggleAll: (on, visible) => {
        for (const i of visible) { if (on) selected.add(i.id); else selected.delete(i.id); }
        paintSubbar(); table.render();
      },
    },
    emptyText: 'まだ取り込んでいません。「Excel を取り込む」から月次のファイルを読み込んでください。',
  });

  /** 表から直接直した 1 項目を保存する。
   *  ★ 保存は **その場で 1 件だけ** 書く (まとめ保存にすると、どこまで保存されたか
   *    分からなくなる)。失敗したら画面を引き直して、直したつもりのまま残さない。 */
  async function saveCell(row: OverseasIssue, patch: Partial<OverseasIssue>): Promise<void> {
    try {
      await getRepo().applyOverseasPlan([], [{ id: row.id, patch }]);
      Object.assign(row, patch);    // 表の行オブジェクトは cache と同じ実体
    } catch (e) {
      toast(rootEl, `保存できませんでした: ${(e as Error).message}`, 'error');
      await load();
    }
  }

  /** 文字を直接書き込める入力欄。値の確定は blur / Enter (change) 時。 */
  function textCell(
    row: OverseasIssue, get: (i: OverseasIssue) => string, set: (v: string) => Partial<OverseasIssue>,
  ): HTMLElement {
    const inp = el('input', {
      class: 'mikke-cell-edit', type: 'text', value: get(row), placeholder: '—',
    }) as HTMLInputElement;
    inp.addEventListener('change', () => {
      const v = inp.value.trim();
      if (v === get(row)) return;               // 変わっていなければ書かない
      void saveCell(row, set(v));
    });
    // Enter で確定 (change が走る)。表の行クリックには伝えない。
    inp.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Enter') inp.blur();
      e.stopPropagation();
    });
    inp.addEventListener('click', (e) => e.stopPropagation());
    return inp;
  }

  /**
   * 複数行を書ける欄 (参考情報)。SP 側も複数行テキスト列なので改行がそのまま入る。
   * ★ Enter は改行。確定は欄から離れたとき (change) にする。
   * ★ 表の行は 1 行ぶんの高さしかないので、書いている間だけ内容の高さまで広げる。
   *   広げないと 2 行目以降が見えないまま書くことになる。
   */
  function noteCell(
    row: OverseasIssue, get: (i: OverseasIssue) => string, set: (v: string) => Partial<OverseasIssue>,
  ): HTMLElement {
    const ta = el('textarea', {
      class: 'mikke-cell-edit mikke-cell-edit--multi', rows: '1', placeholder: '—', spellcheck: 'false',
    }, [get(row)]) as HTMLTextAreaElement;
    const MAX_ROWS_PX = 140;
    const grow = (): void => {
      ta.style.height = 'auto';
      ta.style.height = `${Math.min(ta.scrollHeight, MAX_ROWS_PX)}px`;
    };
    ta.addEventListener('focus', grow);
    ta.addEventListener('input', grow);
    ta.addEventListener('blur', () => { ta.style.height = ''; });
    ta.addEventListener('change', () => {
      const v = ta.value.trim();
      if (v === get(row)) return;               // 変わっていなければ書かない
      void saveCell(row, set(v));
    });
    // Enter は改行として使うので確定しない。表の行クリックには伝えない。
    ta.addEventListener('keydown', (e) => e.stopPropagation());
    ta.addEventListener('click', (e) => e.stopPropagation());
    return ta;
  }

  /** 事業会社は登録済み一覧からの選択式 (国内と同じ顔ぶれ)。
   *  ★ 既に入っている値が一覧に無いことがある (登録前に取り込んだ / 会社を消した)。
   *    その値も選択肢に残す。残さないと、開いただけで別の会社に化ける。 */
  function companyCell(row: OverseasIssue): HTMLElement {
    const cur = row.businessCompany ?? '';
    const opts = [...companies];
    if (cur && !opts.includes(cur)) opts.unshift(cur);
    const sel = el('select', { class: 'mikke-cell-edit' }, [
      el('option', { value: '' }, ['—']),
      ...opts.map((c) => el('option', { value: c, ...(c === cur ? { selected: 'selected' } : {}) }, [c])),
    ]) as HTMLSelectElement;
    sel.value = cur;
    sel.addEventListener('change', () => {
      if (sel.value === cur) return;
      void saveCell(row, { businessCompany: sel.value });
    });
    sel.addEventListener('click', (e) => e.stopPropagation());
    return sel;
  }

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
      // ★ この 4 つは表から直接直せる (Excel にも検査ツールにも無い、人が決める情報)。
      { id: 'businessCompany', label: LABEL.businessCompany, width: 170,
        text: (i) => i.businessCompany ?? '', render: (i) => companyCell(i) },
      { id: 'affiliateCompany', label: LABEL.affiliateCompany, width: 170,
        text: (i) => i.affiliateCompany ?? '',
        render: (i) => textCell(i, (x) => x.affiliateCompany ?? '', (v) => ({ affiliateCompany: v })) },
      { id: 'webMapsId', label: LABEL.assetMgmtId, width: 160,
        text: (i) => i.webMapsId ?? '',
        render: (i) => textCell(i, (x) => x.webMapsId ?? '', (v) => ({ webMapsId: v })) },
      // ★ 参考情報は複数行 (SP 側も複数行テキスト列)。改行をそのまま入れられる。
      { id: 'identifyEvidence', label: '参考情報', width: 220,
        text: (i) => i.identifyEvidence ?? '',
        render: (i) => noteCell(i, (x) => x.identifyEvidence ?? '', (v) => ({ identifyEvidence: v })) },
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
      // 事業会社の選択肢はアクセス権の設定 (登録済み事業会社) から引く。国内と同じ顔ぶれ。
      const [rows, settings] = await Promise.all([
        getRepo().listOverseasIssues(),
        getRepo().getSettings().catch(() => null),
      ]);
      cache = rows;
      companies = registeredCompanies(normalizePerms(settings?.vulnResponsePerms));
      // 消えた行の選択は残さない (選択分の反映で存在しない ID を触らないため)。
      const alive = new Set(cache.map((i) => i.id));
      for (const id of [...selected]) if (!alive.has(id)) selected.delete(id);
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

  // ── 海外連携用リストへの反映 ───────────────────────────────────────────────
  //   ★ 国内と違い **一方通行**。リスト側は読み取り専用で、取り込み (逆方向) は無い。
  async function push(onlySelected: boolean): Promise<void> {
    if (bulkBusy) return;
    const targets = onlySelected ? cache.filter((i) => selected.has(i.id)) : cache;
    if (!targets.length) {
      toast(rootEl, onlySelected ? '行を選択してください。' : '反映するものがありません。', 'warn');
      return;
    }
    const scope = onlySelected
      ? new Set(targets.map((i) => overseasKey(i.issueInstanceId, i.region ?? '')))
      : undefined;
    bulkBusy = true;
    paint();
    progress.set('海外連携リストへ反映: 準備中');
    try {
      // ★ 列が 1 つでも足りないと SP は書込を 400 で返し、全件失敗する。
      //   何が足りないのか・どう直すのかを先に出す。
      const missing = await getRepo().findMissingOverseasResponseColumns().catch(() => [] as string[]);
      if (missing.length) {
        toast(rootEl,
          `海外連携用リストに列が足りません (${missing.join(', ')})。`
          + '設定 → 連携用リスト の「海外連携用リストを構築」を実行してから、もう一度反映してください。',
          'error', 0);
        return;
      }
      progress.set('海外連携リストへ反映: 現在の内容を読んでいます');
      const existing = await getRepo().listOverseasResponseRows();
      const plan = buildOverseasResponsePlan(cache, existing, scope);
      const label = onlySelected ? `選択 ${targets.length} 件の反映` : '海外連携リストへの反映';
      const total = plan.creates.length + plan.updates.length + plan.deletes.length;
      // ★ 内容に変更が無くても止まらない。権限だけ未適用のことがある
      //   (先にリストを作ってから、あとでアクセス権を設定した場合)。
      if (total) {
        toast(rootEl, `${label}… 追加 ${plan.creates.length} / 更新 ${plan.updates.length} / 削除 ${plan.deletes.length}`,
          'default', 6000);
      }

      let fail = 0;
      let firstErr = '';
      progress.set('海外連携リストへ反映: 書き込み', 0, total);
      try {
        const w = await getRepo().applyOverseasResponseWrites(
          plan.creates, plan.updates.map((u) => ({ id: u.id, fields: u.fields })), plan.deletes.map((d) => d.id),
          (d, t) => progress.set('海外連携リストへ反映: 書き込み', d, t));
        fail = w.fail;
        if (fail) firstErr = 'くわしくはブラウザのコンソール (F12) を見てください';
      } catch (e) {
        fail = total;
        firstErr = (e as Error).message;
      }

      // ★ アクセス権を付ける対象は「追加した分」だけではない (国内と同じ)。
      //   追加した分 / 事業会社が変わった分 / まだ継承のままの分 の 3 つ。
      let permMsg = '';
      try {
        progress.set('海外連携リストへ反映: アクセス権の対象を確認中');
        const [permTargets, rows] = await Promise.all([
          getRepo().listOverseasResponsePermTargets(),
          getRepo().listOverseasResponseRows(),
        ]);
        const keyById = new Map(rows.map((r) => [r.id, overseasKey(r.issueInstanceId, r.region)]));
        const idByKey = new Map(rows.map((r) => [overseasKey(r.issueInstanceId, r.region), r.id]));
        const createdIds = new Set(plan.creates
          .map((c) => idByKey.get(overseasKey(c.issueInstanceId, c.region)))
          .filter((x): x is number => !!x));
        const changedCompany = new Set(
          plan.updates.filter((u) => u.fields.businessCompany !== undefined).map((u) => u.id));
        const scoped = permTargets.filter((t) => {
          if (!(createdIds.has(t.id) || changedCompany.has(t.id) || !t.hasUniquePerms)) return false;
          return !scope || scope.has(keyById.get(t.id) ?? '');
        });
        if (scoped.length) {
          // ★ 1 件あたり 4〜6 リクエストかかる。ここがいちばん待たされるので必ず出す。
          progress.set('海外連携リストへ反映: アクセス権', 0, scoped.length);
          const pr = await getRepo().applyOverseasResponseItemPerms(scoped,
            (d, t) => progress.set('海外連携リストへ反映: アクセス権', d, t));
          permMsg = ` / アクセス権 ${pr.applied + pr.adminOnly} 件`
            + (pr.errors.length ? ` (失敗 ${pr.errors.length}: ${pr.errors[0]})` : '');
        }
      } catch (e) {
        permMsg = /未設定/.test((e as Error).message)
          ? ' / アクセス権は未設定のため付与していません（アクセス権画面で管理者グループを選んでください）'
          : ` / アクセス権の付与に失敗: ${(e as Error).message}`;
      }

      const done = total - fail;
      toast(rootEl,
        `${label}: ${done} 件${fail ? ` / 失敗 ${fail} 件 (${firstErr})` : ''}`
        + (plan.unchanged ? ` / 変更なし ${plan.unchanged} 件` : '') + permMsg,
        fail ? 'warn' : 'ok', fail ? 0 : 6000);
    } catch (e) {
      toast(rootEl, `反映に失敗しました: ${(e as Error).message}`, 'error', 0);
    } finally {
      progress.hide();
      bulkBusy = false;
      paint();
    }
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

  /** 選択件数を出す帯。選択のたびに表ごと描き直さないよう分けてある。 */
  function paintSubbar(): void {
    clear(subbar);
    subbar.append(
      el('span', { class: 'mikke-subbar-title' }, ['海外脆弱性一覧']),
      el('span', { class: 'mikke-subbar-count' }, [`${cache.length} 件`]),
    );
    if (selected.size) {
      subbar.append(
        el('span', { class: 'mikke-subbar-count' }, [`選択 ${selected.size} 件`]),
        el('button', {
          class: 'mikke-btn mikke-btn--secondary', style: 'height:26px;font-size:var(--fs-sm)',
          ...(bulkBusy ? { disabled: 'disabled' } : {}),
          onclick: () => void push(true),
        }, ['連携リストへ反映(選択)']),
        el('button', {
          class: 'mikke-btn mikke-btn--ghost', style: 'height:26px;font-size:var(--fs-sm)',
          onclick: () => { selected.clear(); paintSubbar(); table.render(); },
        }, ['選択を解除']),
      );
    }
  }

  function paint(): void {
    paintSubbar();
    clear(toolbar);
    const importBtn = el('button', {
      class: 'mikke-btn mikke-btn--primary', style: 'height:30px;font-size:var(--fs-sm)',
      title: '地域ごとの Excel をまとめて選べます。画面へドラッグしても取り込めます',
      ...(busy || bulkBusy ? { disabled: 'disabled' } : {}),
      onclick: () => fileInput.click(),
      html: icon('upload') + '<span>Excel を取り込む</span>',
    });
    const pushBtn = el('button', {
      class: 'mikke-btn mikke-btn--secondary', style: 'height:30px;font-size:var(--fs-sm)',
      title: '海外拠点向けの連携リスト (国内とは別リスト) へ一覧の内容を書き出します',
      ...(busy || bulkBusy ? { disabled: 'disabled' } : {}),
      onclick: () => void push(false),
    }, ['連携リストへ反映(全件)']);
    toolbar.append(
      importBtn,
      pushBtn,
      fileInput,
      el('span', { style: 'color:var(--ink-3);font-size:var(--fs-sm)' }, [
        '地域ごと・モニタリング区分ごとのファイルをまとめて読み込めます（ドラッグ＆ドロップ可）。'
        + ' 事業会社・管理会社・WebMAPS管理ID・参考情報は表から直接直せます。',
      ]),
    );
    if (!busy && !previewing) table.render();
  }

  paint();
  void load();
  return root;
}
