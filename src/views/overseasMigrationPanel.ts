// 設定 → 海外データ移行: Excel で通知している海外分を海外脆弱性一覧へ取り込む。
//
// ★ 位置づけは国内の「データ移行 (Excel)」と同じ (初期データの取り込み)。
//   毎月の通知ファイルは海外脆弱性一覧の画面から取り込む。あちらは追記型で
//   検知状況を履歴から決めるので、入口も書式も別物。
// ★ 旧略称の読み替えは独立した画面 (設定 → 取込 → 旧略称の読み替え) の設定を
//   そのまま使う。国内と共通 (同じ会社の話なので、表を 2 つ持つと必ず食い違う)。
import { el, clear } from '../utils/dom';
import { getRepo } from '../api/repo';
import { toast } from '../components/toast';
import { parseXlsxSheet, xlsxSheetNames } from '../lib/xlsx';
import { parseFlexibleDate, OTHER_COMPANY } from '../lib/migration';
import {
  buildOverseasMigrationPlan, indexOverseasByKey, splitOverseasMigrationWrites, OVS_MIG_COL,
  type OvsMigrationPlan, type OvsMigrationSplit,
} from '../lib/overseasMigration';
import { BUILTIN_COMPANIES } from '../lib/itemPerms';
import type { MikkeSettings } from '../types';

/** 移行元のシート名 (Excel のテーブルが載っているシート)。 */
const SHEET_NAME = 'list';

export interface OverseasMigrationPanelParts { body: HTMLElement }

export async function renderOverseasMigrationPanel(root: HTMLElement): Promise<OverseasMigrationPanelParts> {
  const settings: MikkeSettings = await getRepo().getSettings();
  let plan: OvsMigrationPlan | null = null;
  let split: OvsMigrationSplit | null = null;
  let fileName = '';

  const result = el('div', { style: 'margin-top:var(--s-4)' });
  const runBtn = el('button', {
    class: 'mikke-btn mikke-btn--primary', type: 'button', disabled: 'disabled',
  }, ['この内容で登録']) as HTMLButtonElement;

  const file = el('input', { type: 'file', accept: '.xlsx' }) as HTMLInputElement;
  file.addEventListener('change', () => void (async () => {
    const f = file.files?.[0];
    if (!f) return;
    // ★ 直したファイルを選び直せるようにする。value が同じままだと、ブラウザは
    //   同じパスのファイルを選んでも change を出さず、画面が古い警告のまま固まる。
    //   File はもう取れているので、ここで空にしても読み込みには影響しない。
    file.value = '';
    fileName = f.name;
    plan = null; split = null;
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
      // ★ 設定を引き直す。読み替え表は別画面 (旧略称の読み替え) で直せるので、
      //   パネルを開いたときの内容のままだと「直したのに効かない」ことになる。
      Object.assign(settings, await getRepo().getSettings());
      // 既にある行を突合キー (Issue Instance ID × 地域) で引けるようにしてから
      // 振り分ける (同じキーを 2 回読んでも増やさず、上書きにするため)。
      const existing = indexOverseasByKey(await getRepo().listOverseasIssues());
      plan = buildOverseasMigrationPlan(parsed.rows, parsed.headers,
        settings.vulnResponsePerms, settings.migrationAliasRemap,
        parseFlexibleDate, new Date().toISOString());
      split = splitOverseasMigrationWrites(plan.rows, existing);
      paintPreview();
      if (plan.ready) runBtn.removeAttribute('disabled');
    } catch (e) {
      clear(result);
      result.appendChild(el('div', { class: 'mikke-error' }, [`読み込みに失敗しました: ${(e as Error).message}`]));
    }
  })());

  /** 取り込む前に中身を見せる。ここで気づけないと、入れてから直すことになる。 */
  function paintPreview(): void {
    if (!plan) return;
    clear(result);
    result.append(
      el('div', { class: 'mikke-note' }, [
        `${fileName} / シート「${SHEET_NAME}」: `
        + (split
          ? `新規 ${split.adds.length} 件 / 既存を上書き ${split.updates.length} 件`
          : `取り込める ${plan.ready} 件`)
        + (plan.skipped ? ` / ${OVS_MIG_COL.issueInstanceId} が空で取り込めない ${plan.skipped} 件` : ''),
      ]),
      ...(split?.dupInFile.length ? [el('div', { class: 'mikke-error', style: 'margin-top:var(--s-3)' }, [
        `Excel の中で ${OVS_MIG_COL.issueInstanceId} と地域の組が重複しています (${split.dupInFile.length} 件): `
        + split.dupInFile.slice(0, 10).map((d) => `${d.issueInstanceId}${d.region ? ` (${d.region})` : ''} × ${d.count}`).join(' / ')
        + (split.dupInFile.length > 10 ? ' …' : ''),
        el('br'),
        '重複した組は、シートで後ろにある行の内容で登録します。',
      ])] : []),
      ...(split?.dupInList.length ? [el('div', { class: 'mikke-error', style: 'margin-top:var(--s-3)' }, [
        `海外脆弱性一覧に同じ組が複数あります (${split.dupInList.length} 件): `
        + split.dupInList.slice(0, 10).map((d) => `${d.issueInstanceId}${d.region ? ` (${d.region})` : ''} × ${d.count}`).join(' / ')
        + (split.dupInList.length > 10 ? ' …' : ''),
        el('br'),
        'いちばん古い 1 件だけを上書きします。残りは古い内容のまま残ります。',
      ])] : []),
      ...(plan.missingColumns.length ? [el('div', { class: 'mikke-error', style: 'margin-top:var(--s-3)' }, [
        `見つからない列があります (この項目は空になります): ${plan.missingColumns.join(' / ')}`,
        el('br'),
        `テーブルの見出し行を読んでいます。シート「${SHEET_NAME}」のテーブルかどうか確認してください。`,
      ])] : []),
      ...(plan.remapped.length ? [el('div', { class: 'mikke-note', style: 'margin-top:var(--s-3)' }, [
        `旧略称を読み替えました: ${plan.remapped.map((r) => `${r.from} → ${r.to} (${r.count} 件)`).join('、')}`,
      ])] : []),
      ...(plan.otherCount ? [el('div', { class: 'mikke-note', style: 'margin-top:var(--s-3)' }, [
        `事業会社を決められない ${plan.otherCount} 件は「${OTHER_COMPANY}」で登録します。`,
      ])] : []),
      ...(plan.unknownAliases.length ? [el('div', { class: 'mikke-error', style: 'margin-top:var(--s-3)' }, [
        `事業会社を判定できない略称が ${plan.unknownAliases.length} 件あります: ${plan.unknownAliases.join(' / ')}`,
        el('br'),
        '現在も使っている略称ならアクセス権画面で登録し、組織再編前の古い略称なら'
        + '「旧略称の読み替え」に追加してください。',
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
        'Issue Instance ID', '通知日', '検知状況', '地域', '事業会社', 'WebMAPS管理ID', 'IP', 'FQDN',
      ].map((h) => el('th', {}, [h])))]));
      t.appendChild(el('tbody', {}, sample.map((r) => el('tr', {}, [
        r.issue!.issueInstanceId, (r.issue!.contactedAt ?? '').slice(0, 10), r.issue!.detectionStatus,
        r.issue!.region || '—', r.issue!.businessCompany || '—', r.issue!.webMapsId || '—',
        r.issue!.assetIp || '—', r.issue!.assetFqdn || '—',
      ].map((v) => el('td', {}, [String(v)]))))));
      result.appendChild(t);
    }
  }

  runBtn.addEventListener('click', () => void (async () => {
    if (!split) return;
    runBtn.setAttribute('disabled', '');
    const line = el('div', { class: 'mikke-note' }, ['登録しています…']);
    clear(result); result.appendChild(line);
    const creates = split.adds;
    const updates = split.updates;
    let fail = 0; let firstErr = '';
    try {
      // ★ 書き込みは $batch でまとめる。1 件ずつだと件数ぶん往復して遅い。
      const w = await getRepo().applyOverseasPlan(creates, updates, (d, t) => {
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
      ? `海外の移行データ: ${okCount} 件を登録、${fail} 件が失敗しました`
      : `海外の移行データを登録しました (新規 ${creates.length} / 上書き ${updates.length})`,
      fail ? 'warn' : 'ok');
    plan = null; split = null;
  })());

  const body = el('div', {}, [
    el('div', { class: 'mikke-note', style: 'margin-bottom:var(--s-4)' }, [
      'Excel で通知している海外分を、海外脆弱性一覧の初期データとして取り込みます。',
      el('br'),
      `テーブルが載っているシート「${SHEET_NAME}」を読みます (見出しはテーブルの見出し行)。`,
      el('br'),
      '毎月の通知ファイルは、この画面ではなく「海外脆弱性一覧」から取り込んでください (書式が別です)。',
    ]),
    el('ul', { style: 'margin:0 0 var(--s-5);padding-left:1.2em;font-size:var(--fs-sm);color:var(--ink-2);line-height:1.8' }, [
      el('li', {}, ['読み込んだ内容を確認してから登録します。読み込むだけでは何も書き込みません。']),
      el('li', {}, [`${OVS_MIG_COL.issueInstanceId} が空の行は取り込みません。`]),
      el('li', {}, ['同じ Issue Instance ID でも地域が違えば別の行として登録します (同じ組は上書き)。']),
      el('li', {}, ['IP/URL は IP と FQDN に振り分けます。URL で書かれている場合は http:// を外してホスト名だけにします。']),
      el('li', {}, ['事業会社は略称で書かれているので、アクセス権画面で登録した略称から判定します。'
        + '旧略称の読み替えは「旧略称の読み替え」(国内と共通) の設定を使います。']),
      el('li', {}, [`どの事業会社にも寄せられなかった行は「${OTHER_COMPANY}」で登録します (事業会社の欄が空の行はそのまま空欄)。`]),
      el('li', {}, [`「${BUILTIN_COMPANIES.join('」「')}」と書かれた行は、そのままその名前で登録します (事業会社の選択肢にも出ます)。`]),
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
