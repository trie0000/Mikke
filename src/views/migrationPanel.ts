// 設定 → データ移行: Excel 管理時代のデータを管理対象へ取り込む。
//
// ★ 流れ
//   1. Excel を選ぶ → シート「list」を読む
//   2. 事業会社の略称からアクセス権画面の事業会社を引き当て、内容を組み立てる (lib/migration.ts)
//   3. 内容を確認 (取り込める件数 / 引けなかった略称 / 気づいたこと) してから登録
//   4. 担当者はメールアドレスを鍵に SharePoint から引く (引けなければ氏名列を使う)
// ★ 旧略称の読み替え表は国内・海外で共通なので、独立した画面
//   (設定 → 取込 → 旧略称の読み替え) に置いてある。ここでは保存済みの内容を
//   **ファイルを読むたびに引き直して** 使う (別画面で直した内容がすぐ効く)。
import { el, clear } from '../utils/dom';
import { getRepo } from '../api/repo';
import { toast } from '../components/toast';
import { parseXlsxSheet, xlsxSheetNames } from '../lib/xlsx';
import {
  buildMigrationPlan, OTHER_COMPANY, indexByIssueInstanceId, splitMigrationWrites,
  type MigrationPlan, type MigrationWriteSplit,
} from '../lib/migration';
import type { MikkeSettings } from '../types';

/** 移行元のシート名 (Excel のテーブルが載っているシート)。 */
const SHEET_NAME = 'list';

export interface MigrationPanelParts { body: HTMLElement; save?: () => Promise<void> }

export async function renderMigrationPanel(root: HTMLElement): Promise<MigrationPanelParts> {
  const settings: MikkeSettings = await getRepo().getSettings();
  let plan: MigrationPlan | null = null;
  let fileName = '';
  /** 読み込んだシート。読み替え表を直したら、選び直さずに作り直せるようにしておく。 */
  let sheet: { headers: string[]; rows: Record<string, string>[] } | null = null;
  /** 既にある Issue Instance ID → アイテム ID。ファイルを読むたびに取り直す。 */
  let existingIdx = new Map<string, number[]>();
  /** 追加と上書きの振り分け。 */
  let split: MigrationWriteSplit | null = null;

  const result = el('div', { style: 'margin-top:var(--s-4)' });
  const runBtn = el('button', {
    class: 'mikke-btn mikke-btn--primary', type: 'button', disabled: 'disabled',
  }, ['この内容で登録']) as HTMLButtonElement;

  /** 読み込み済みのシートから計画を作り直す。 */
  function rebuildPlan(): void {
    if (!sheet) return;
    plan = buildMigrationPlan(sheet.rows, settings.vulnResponsePerms, settings.vulnTypeRules,
      new Date().toISOString(), settings.migrationAliasRemap, sheet.headers);
    split = splitMigrationWrites(plan.rows, existingIdx);
    paintPreview();
    if (plan.ready) runBtn.removeAttribute('disabled');
    else runBtn.setAttribute('disabled', '');
  }

  const file = el('input', { type: 'file', accept: '.xlsx' }) as HTMLInputElement;
  file.addEventListener('change', () => void (async () => {
    const f = file.files?.[0];
    if (!f) return;
    // ★ 直したファイルを選び直せるようにする。value が同じままだと、ブラウザは
    //   同じパスのファイルを選んでも change を出さず、画面が古い警告のまま固まる。
    //   File はもう取れているので、ここで空にしても読み込みには影響しない。
    file.value = '';
    fileName = f.name;
    plan = null;
    sheet = null;
    runBtn.setAttribute('disabled', '');
    clear(result);
    result.appendChild(el('div', { class: 'mikke-note' }, ['読み込み中…']));
    try {
      const buf = await f.arrayBuffer();
      const parsed = parseXlsxSheet(buf, SHEET_NAME);
      if (!parsed) {
        clear(result);
        result.appendChild(el('div', { class: 'mikke-error' }, [
          `シート「${SHEET_NAME}」が見つかりません。このブックのシート: ${xlsxSheetNames(buf).join(' / ') || '(読めません)'}`,
        ]));
        return;
      }
      // ★ 設定を引き直す。読み替え表は別画面で直せるので、パネルを開いたときの
      //   内容のままだと「直したのに効かない」ことになる。
      Object.assign(settings, await getRepo().getSettings());
      // 既にある Issue Instance ID を引けるようにしてから振り分ける
      // (同じ ID を 2 回読んでも増やさず、上書きにするため)。
      existingIdx = indexByIssueInstanceId(await getRepo().listIssues());
      sheet = parsed;
      rebuildPlan();
    } catch (e) {
      clear(result);
      result.appendChild(el('div', { class: 'mikke-error' }, [`読み込みに失敗しました: ${(e as Error).message}`]));
    }
  })());

  /** 取り込む前に中身を見せる。ここで気づけないと、入れてから直すことになる。 */
  function paintPreview(): void {
    if (!plan) return;
    clear(result);
    const missing = plan.missingColumns;
    result.append(
      el('div', { class: 'mikke-note' }, [
        `${fileName} / シート「${SHEET_NAME}」: `
        + (split
          ? `新規 ${split.adds.length} 件 / 既存を上書き ${split.updates.length} 件`
          : `取り込める ${plan.ready} 件`)
        + (plan.skipped ? ` / Issue ID が空で取り込めない ${plan.skipped} 件` : ''),
      ]),
      ...(split?.dupInFile.length ? [el('div', { class: 'mikke-error', style: 'margin-top:var(--s-3)' }, [
        `Excel の中で Issue Instance ID が重複しています (${split.dupInFile.length} 件): `
        + `${split.dupInFile.slice(0, 10).map((d) => `${d.issueInstanceId} × ${d.count}`).join(' / ')}`
        + (split.dupInFile.length > 10 ? ' …' : ''),
        el('br'),
        '重複した ID は、シートで後ろにある行の内容で登録します。',
      ])] : []),
      ...(split?.dupInList.length ? [el('div', { class: 'mikke-error', style: 'margin-top:var(--s-3)' }, [
        `管理対象に同じ Issue Instance ID が複数あります (${split.dupInList.length} 件): `
        + `${split.dupInList.slice(0, 10).map((d) => `${d.issueInstanceId} × ${d.count}`).join(' / ')}`
        + (split.dupInList.length > 10 ? ' …' : ''),
        el('br'),
        'いちばん古い 1 件だけを上書きします。残りは古い内容のまま残るので、管理対象一覧で消してください。',
      ])] : []),
      ...(missing.length ? [el('div', { class: 'mikke-error', style: 'margin-top:var(--s-3)' }, [
        `見つからない列があります (この項目は空になります): ${missing.join(' / ')}`,
      ])] : []),
      ...(plan.remapped.length ? [el('div', { class: 'mikke-note', style: 'margin-top:var(--s-3)' }, [
        `旧略称を読み替えました: ${plan.remapped.map((r) => `${r.from} → ${r.to} (${r.count} 件)`).join('、')}`,
      ])] : []),
      ...(plan.otherCount ? [el('div', { class: 'mikke-note', style: 'margin-top:var(--s-3)' }, [
        `事業会社を決められない ${plan.otherCount} 件は「${OTHER_COMPANY}」で登録します。`,
        `アクセス権を付けるには、アクセス権画面で「${OTHER_COMPANY}」を事業会社として登録してグループを割り当ててください。`,
      ])] : []),
      ...(plan.unknownAliases.length ? [el('div', { class: 'mikke-error', style: 'margin-top:var(--s-3)' }, [
        `事業会社を判定できない略称が ${plan.unknownAliases.length} 件あります: ${plan.unknownAliases.join(' / ')}`,
        el('br'),
        '現在も使っている略称ならアクセス権画面で登録し、組織再編前の古い略称なら下の「旧略称の読み替え」に追加してください。',
        `このまま登録すると、これらの行は「${OTHER_COMPANY}」になります。`,
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
    if (!plan || !split) return;
    runBtn.setAttribute('disabled', '');
    const line = el('div', { class: 'mikke-note' }, ['登録しています…']);
    clear(result); result.appendChild(line);
    // 既にある Issue Instance ID は上書き、無いものだけ追加する。
    const targets = [
      ...split.updates.map((u) => ({ row: u.row, id: u.id as number | null })),
      ...split.adds.map((row) => ({ row, id: null as number | null })),
    ];
    // ★ 担当者を引くのは 1 件ずつのネットワーク往復。同じメールは 1 回で済ませる。
    const byEmail = new Map<string, string>();
    const emails = [...new Set(targets.map((t) => t.row.assigneeEmail).filter(Boolean))];
    for (const [i, mail] of emails.entries()) {
      line.textContent = `担当者を引いています… (${i + 1}/${emails.length})`;
      const found = await getRepo().resolveUserByEmail(mail).catch(() => null);
      if (found?.displayName) byEmail.set(mail, found.displayName);
    }
    const withAssignee = (t: typeof targets[number]) => ({
      ...t.row.issue!,
      assignee: byEmail.get(t.row.assigneeEmail) ?? t.row.assigneeFallback,
    });
    // ★ 書き込みは $batch でまとめる。1 件ずつだと件数ぶん往復して遅い。
    const creates = targets.filter((t) => t.id === null).map(withAssignee);
    const updates = targets.filter((t) => t.id !== null)
      .map((t) => ({ id: t.id!, patch: withAssignee(t) }));
    line.textContent = '登録しています…';
    let fail = 0; let firstErr = '';
    try {
      const w = await getRepo().applyIssueWrites(creates, updates, (d, t) => {
        line.textContent = `登録しています… (${d}/${t})`;
      });
      fail = w.fail;
      if (fail) firstErr = 'くわしくはブラウザのコンソール (F12) を見てください';
    } catch (e) {
      fail = creates.length + updates.length;
      firstErr = (e as Error).message;
    }
    // ★ 失敗した件があっても、成功した分は実際に入っている。0 件と言わない
    //   (「何も入らなかった」と誤解して、原因を探さずにやり直すことになる)。
    const total = creates.length + updates.length;
    const okCount = total - fail;
    clear(result);
    result.appendChild(el('div', { class: fail ? 'mikke-error' : 'mikke-note' }, [
      fail
        ? `登録 ${okCount} 件 / 失敗 ${fail} 件 — ${firstErr}`
          + `（内訳は新規 ${creates.length} 件 / 上書き ${updates.length} 件のうち。もう一度読み込めば、`
          + `入った分は上書きになるので二重にはなりません）`
        : `登録しました: 新規 ${creates.length} 件 / 上書き ${updates.length} 件`,
    ]));
    toast(root, fail
      ? `移行データ: ${okCount} 件を登録、${fail} 件が失敗しました`
      : `移行データを登録しました (新規 ${creates.length} / 上書き ${updates.length})`,
      fail ? 'warn' : 'ok');
    plan = null;
    split = null;
    sheet = null;
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
      el('li', {}, ['既にある Issue Instance ID は上書きします (二重に増えません)。']),
      el('li', {}, ['脆弱性タイプは Title から自動判定します (判定条件は「脆弱性タイプの判定」で設定)。']),
      el('li', {}, ['組織再編前の古い略称は「旧略称の読み替え」(この下のメニュー) で現在の略称に寄せてから判定します。']),
      el('li', {}, [`どの事業会社にも寄せられなかった行は「${OTHER_COMPANY}」で登録します (事業会社の欄が空の行はそのまま空欄)。`]),
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

