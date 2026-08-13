// 設定 → データ移行: Excel 管理時代のデータを管理対象へ取り込む。
//
// ★ 流れ
//   1. Excel を選ぶ → シート「list」を読む
//   2. 事業会社の略称からアクセス権画面の事業会社を引き当て、内容を組み立てる (lib/migration.ts)
//   3. 内容を確認 (取り込める件数 / 引けなかった略称 / 気づいたこと) してから登録
//   4. 担当者はメールアドレスを鍵に SharePoint から引く (引けなければ氏名列を使う)
import { el, clear } from '../utils/dom';
import { getRepo } from '../api/repo';
import { toast } from '../components/toast';
import { parseXlsxSheet, xlsxSheetNames } from '../lib/xlsx';
import { buildMigrationPlan, MIG_COL, type MigrationPlan } from '../lib/migration';

/** 移行元のシート名 (Excel のテーブルが載っているシート)。 */
const SHEET_NAME = 'list';

export interface MigrationPanelParts { body: HTMLElement }

export function renderMigrationPanel(root: HTMLElement): MigrationPanelParts {
  let plan: MigrationPlan | null = null;
  let fileName = '';

  const result = el('div', { style: 'margin-top:var(--s-4)' });
  const runBtn = el('button', {
    class: 'mikke-btn mikke-btn--primary', type: 'button', disabled: 'disabled',
  }, ['この内容で登録']) as HTMLButtonElement;

  const file = el('input', { type: 'file', accept: '.xlsx' }) as HTMLInputElement;
  file.addEventListener('change', () => void (async () => {
    const f = file.files?.[0];
    if (!f) return;
    fileName = f.name;
    plan = null;
    runBtn.setAttribute('disabled', '');
    clear(result);
    result.appendChild(el('div', { class: 'mikke-note' }, ['読み込み中…']));
    try {
      const buf = await f.arrayBuffer();
      const sheet = parseXlsxSheet(buf, SHEET_NAME);
      if (!sheet) {
        clear(result);
        result.appendChild(el('div', { class: 'mikke-error' }, [
          `シート「${SHEET_NAME}」が見つかりません。このブックのシート: ${xlsxSheetNames(buf).join(' / ') || '(読めません)'}`,
        ]));
        return;
      }
      const settings = await getRepo().getSettings();
      plan = buildMigrationPlan(sheet.rows, settings.vulnResponsePerms, settings.vulnTypeRules,
        new Date().toISOString());
      paintPreview(sheet.headers);
      if (plan.ready) runBtn.removeAttribute('disabled');
    } catch (e) {
      clear(result);
      result.appendChild(el('div', { class: 'mikke-error' }, [`読み込みに失敗しました: ${(e as Error).message}`]));
    }
  })());

  /** 取り込む前に中身を見せる。ここで気づけないと、入れてから直すことになる。 */
  function paintPreview(headers: string[]): void {
    if (!plan) return;
    clear(result);
    const missing = Object.values(MIG_COL).filter((c) => !headers.includes(c));
    result.append(
      el('div', { class: 'mikke-note' }, [
        `${fileName} / シート「${SHEET_NAME}」: 取り込める ${plan.ready} 件`
        + (plan.skipped ? ` / Issue ID が空で取り込めない ${plan.skipped} 件` : ''),
      ]),
      ...(missing.length ? [el('div', { class: 'mikke-error', style: 'margin-top:var(--s-3)' }, [
        `見つからない列があります (この項目は空になります): ${missing.join(' / ')}`,
      ])] : []),
      ...(plan.unknownAliases.length ? [el('div', { class: 'mikke-error', style: 'margin-top:var(--s-3)' }, [
        `事業会社を判定できない略称が ${plan.unknownAliases.length} 件あります: ${plan.unknownAliases.join(' / ')}`,
        el('br'),
        'アクセス権画面で該当の事業会社に略称を登録してから、もう一度読み込んでください。',
        'このまま登録すると、これらの行は事業会社が空になり、アクセス権も付きません。',
      ])] : []),
    );
    // 行ごとの気づき (先頭 20 件まで)
    const warned = plan.rows.filter((r) => r.warnings.length).slice(0, 20);
    if (warned.length) {
      result.appendChild(el('div', { style: 'margin-top:var(--s-3)' }, [
        el('div', { class: 'mikke-note' }, ['気づいたこと (先頭 20 件):']),
        el('ul', { style: 'margin:var(--s-2) 0;padding-left:1.2em;font-size:var(--fs-sm);color:var(--ink-2)' },
          warned.map((r) => el('li', {}, [
            `${r.issue?.issueInstanceId ?? '(ID なし)'}: ${r.warnings.join(' / ')}`,
          ]))),
      ]));
    }
    // 先頭 3 件のプレビュー
    const sample = plan.rows.filter((r) => r.issue).slice(0, 3);
    if (sample.length) {
      const t = el('table', { class: 'mikke-table', style: 'margin-top:var(--s-4);width:100%;table-layout:auto' });
      t.appendChild(el('thead', {}, [el('tr', {}, [
        'Issue Instance ID', 'Title', '検知', '対応', '事業会社', 'WebMAPS管理ID', '脆弱性タイプ',
      ].map((h) => el('th', {}, [h])))]));
      t.appendChild(el('tbody', {}, sample.map((r) => el('tr', {}, [
        r.issue!.issueInstanceId, r.issue!.title, r.issue!.detectionStatus, r.issue!.mgmtStatus,
        r.issue!.businessCompany || '—', r.issue!.webMapsId || '—', r.issue!.vulnType ?? '—',
      ].map((v) => el('td', {}, [String(v)]))))));
      result.appendChild(t);
    }
  }

  runBtn.addEventListener('click', () => void (async () => {
    if (!plan) return;
    runBtn.setAttribute('disabled', '');
    const line = el('div', { class: 'mikke-note' }, ['登録しています…']);
    clear(result); result.appendChild(line);
    let ok = 0; let fail = 0; let firstErr = '';
    const targets = plan.rows.filter((r) => r.issue);
    for (const [i, r] of targets.entries()) {
      line.textContent = `登録しています… (${i + 1}/${targets.length})`;
      try {
        // 担当者はメールアドレスから引く。引けなければ氏名列をそのまま入れる。
        let assignee = r.assigneeFallback;
        if (r.assigneeEmail) {
          const found = await getRepo().resolveUserByEmail(r.assigneeEmail).catch(() => null);
          if (found?.displayName) assignee = found.displayName;
        }
        await getRepo().createIssue({ ...r.issue!, assignee });
        ok++;
      } catch (e) {
        fail++;
        if (!firstErr) firstErr = `${r.issue!.issueInstanceId}: ${(e as Error).message}`;
      }
    }
    clear(result);
    result.appendChild(el('div', { class: fail ? 'mikke-error' : 'mikke-note' }, [
      `登録しました: ${ok} 件${fail ? ` / 失敗 ${fail} 件 — ${firstErr}` : ''}`,
    ]));
    toast(root, `移行データを登録しました (${ok} 件)`, fail ? 'warn' : 'ok');
    plan = null;
    file.value = '';
  })());

  const body = el('div', {}, [
    el('div', { class: 'mikke-note', style: 'margin-bottom:var(--s-4)' }, [
      'Excel 管理時代のデータを管理対象へ取り込みます。',
      el('br'),
      `テーブルが載っているシート「${SHEET_NAME}」を読みます。`,
      el('br'),
      '事業会社は略称で書かれているので、アクセス権画面で登録した略称から判定します。',
      el('br'),
      '担当者は「Eメールアドレス」列を鍵に SharePoint から引きます (氏名列は引けなかったときに使います)。',
    ]),
    el('ul', { style: 'margin:0 0 var(--s-5);padding-left:1.2em;font-size:var(--fs-sm);color:var(--ink-2);line-height:1.8' }, [
      el('li', {}, ['読み込んだ内容を確認してから登録します。読み込むだけでは何も書き込みません。']),
      el('li', {}, ['Issue ID が空の行は取り込みません。']),
      el('li', {}, ['既にある Issue Instance ID でも新規として追加します (取込のような突合はしません)。']),
      el('li', {}, ['脆弱性タイプは Title から自動判定します (判定条件は「脆弱性タイプの判定」で設定)。']),
    ]),
    el('div', { class: 'mikke-field' }, [
      el('label', { class: 'mikke-field-label' }, ['移行元の Excel (.xlsx)']),
      file,
    ]),
    runBtn,
    result,
  ]);
  return { body };
}
