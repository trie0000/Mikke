// 海外脆弱性一覧。国内分とは別に、地域ごとの通知状況だけを追う簡易版。
//
// ★ 入力は地域ごと・モニタリング区分ごとに分かれた Excel。書式はどれも同じで、
//   1 行目がヘッダ (テーブルオブジェクトではない)。月次でまとめて取り込む。
// ★ Excel は **追記型**。その月に検知されたものが open として毎月足されるので、
//   継続している脆弱性は複数月ぶんの行を持つ。未検出になると close/removed の行になる。
//   したがって検知状況は **ファイル内の履歴を古い順にたどって決める**。
//   保存済みの状態は使わない (同じファイルを 2 回取り込んでも結果が変わらない)。
// ★ Excel に入っているのは 通知日 / open / 備考 / 地域 と Issue Instance ID だけ。
//   それ以外 (脆弱性タイトル・資産) は **ダウンロード済みのマージ CSV** から引く。
//   ★ 管理対象一覧ではなく CSV を見るのは、海外分には管理対象条件に一致せず
//     管理対象に入っていない脆弱性があるため。CSV には全件載っている。
//   事業会社・管理会社・WebMAPS管理ID・参考情報は Mikke 側で付ける値なので、
//   管理対象にあればそこから引く (無ければ空)。
//
// UI にも SP にも依存しない (テストしやすくするため)。
import type { DetectionStatus, ManagedIssue, OverseasIssue, OverseasOpenStatus, OverseasRegion } from '../types';
import { OVERSEAS_REGIONS } from '../types';
import { resolveScanValue } from './scanName';
import { fitSingleLine } from './vulnResponseSync';

const text = (v: unknown): string => (v === undefined || v === null ? '' : String(v)).trim();

/** Excel の列名。表記が揺れるので、比較は小文字・空白詰めで行う (下の findColumn)。 */
export const OVERSEAS_COL = {
  issueInstanceId: 'Issue Instance ID',
  contactedAt: 'date of contact',
  open: 'open',
  remarks: 'Remarks/Comments (Free Text)',
  region: 'REALM',
} as const;

/**
 * 突合キー。海外は **Issue Instance ID × 地域** で 1 行になる
 * (同じ脆弱性を複数の地域へ通知していることがあるため、ID だけでは足りない)。
 */
export function overseasKey(iid: unknown, region: unknown): string {
  return `${text(iid)}\u0000${text(region)}`;
}

/** 見出しの比較用キー (小文字・空白と記号のゆれを吸収)。 */
const norm = (s: string): string => text(s).toLowerCase().replace(/[\s　_]+/g, '');

/**
 * 見出しの一覧から 1 列を探す。
 * ★ 完全一致 → 前方一致 → 部分一致 の順。Excel 側で `Remarks/Comments (Free Text)` が
 *   `Remarks/Comments` だけになっていたり、`Issue Instance ID` が `Issue ID` の
 *   ことがあるため、厳密一致だけにしない。
 */
export function findColumn(headers: string[], want: string, alts: string[] = []): string | null {
  const cands = [want, ...alts].map(norm);
  for (const c of cands) {
    const exact = headers.find((h) => norm(h) === c);
    if (exact) return exact;
  }
  for (const c of cands) {
    const partial = headers.find((h) => norm(h).startsWith(c) || c.startsWith(norm(h)));
    if (partial) return partial;
  }
  for (const c of cands) {
    const loose = headers.find((h) => norm(h).includes(c));
    if (loose) return loose;
  }
  return null;
}

export interface OverseasColumnMap {
  issueInstanceId: string | null;
  contactedAt: string | null;
  open: string | null;
  remarks: string | null;
  region: string | null;
}

/** シートの見出しから、使う列を決める。 */
export function resolveOverseasColumns(headers: string[]): OverseasColumnMap {
  return {
    issueInstanceId: findColumn(headers, OVERSEAS_COL.issueInstanceId, ['Issue ID', 'IssueInstanceId']),
    contactedAt: findColumn(headers, OVERSEAS_COL.contactedAt, ['date of contact', 'contact date']),
    open: findColumn(headers, OVERSEAS_COL.open, ['status', 'open/closed']),
    remarks: findColumn(headers, OVERSEAS_COL.remarks, ['Remarks/Comments', 'Remarks', 'Comments']),
    region: findColumn(headers, OVERSEAS_COL.region, ['Region', '地域']),
  };
}

/** 見つからなかった必須列 (画面に出す)。備考は無くても取り込める。 */
export function missingOverseasColumns(m: OverseasColumnMap): string[] {
  const out: string[] = [];
  if (!m.issueInstanceId) out.push(OVERSEAS_COL.issueInstanceId);
  if (!m.contactedAt) out.push(OVERSEAS_COL.contactedAt);
  if (!m.open) out.push(OVERSEAS_COL.open);
  if (!m.region) out.push(OVERSEAS_COL.region);
  return out;
}

/** `open` 列 → 2 値。読めなければ null (行を飛ばす)。 */
export function toOpenStatus(raw: string): OverseasOpenStatus | null {
  const v = norm(raw);
  if (!v) return null;
  // closed / removed / closed-removed / close など
  if (/^(closed?|removed?|close\/?removed?|closed?\/?removed?)$/.test(v)) return 'closed/removed';
  if (v.includes('close') || v.includes('remove')) return 'closed/removed';
  if (v === 'open' || v.includes('open')) return 'open';
  return null;
}

/** `REALM` 列 → 地域。対応表に無ければそのまま返す (勝手に捨てない)。 */
export function toRegion(raw: string): OverseasRegion | string {
  const v = norm(raw);
  const hit = OVERSEAS_REGIONS.find((r) => norm(r) === v);
  if (hit) return hit;
  // NA と LA が別々に書かれていることがある
  if (v === 'na' || v === 'la' || v === 'nala') return 'NA/LA';
  return text(raw);
}

/**
 * 検知状況を 1 段進める。追記型の行を古い順に畳んで使う。
 *
 * @param prev それまでの検知状況 (最初の行では undefined)
 * @param cur  その行の open 状況
 *
 * ★ 対応表
 *     それ以前なし    + open            → 新規
 *     それ以前なし    + closed/removed  → 未検出(New)
 *     検知中          + open            → 継続
 *     検知中          + closed/removed  → 未検出(New)   (消えた初月)
 *     未検出系        + open            → 再検知
 *     未検出系        + closed/removed  → 未検出
 */
export function nextOverseasDetection(
  prev: DetectionStatus | undefined,
  cur: OverseasOpenStatus | undefined,
): DetectionStatus {
  const detected = prev === '新規' || prev === '継続' || prev === '再検知';
  const absent = prev === '未検出(New)' || prev === '未検出';
  if (cur === 'open') {
    if (prev === undefined) return '新規';
    return absent ? '再検知' : '継続';
  }
  if (prev === undefined) return '未検出(New)';
  return detected ? '未検出(New)' : '未検出';
}

/** 日付は国内分と同じ読み方をする (Excel シリアル値・英語月名・ISO)。 */
export type DateParser = (raw: string) => string | null;

export interface OverseasPlan {
  /** 追加する行。 */
  creates: Omit<OverseasIssue, 'id'>[];
  /** 更新する行 (既存の SP アイテム ID 付き)。 */
  updates: { id: number; patch: Partial<OverseasIssue> }[];
  /** Issue Instance ID が空などで取り込めない行。 */
  skipped: number;
  /** 取り込んだ脆弱性の数 (行数ではなく、Issue Instance ID × 地域 の数)。 */
  entries: number;
  /** ダウンロード済み CSV にも管理対象にも見つからず、情報を埋められなかった ID。 */
  unmatched: string[];
  /** 行ごとの気づき (画面に出す)。 */
  warnings: { issueInstanceId: string; message: string }[];
  /** 見つからなかった列。 */
  missingColumns: string[];
}

/** SharePoint 側が単一行テキスト (255 文字) の項目。schema.ts の overseasFieldSpecs と揃える。 */
const OVERSEAS_SINGLE_LINE_FIELDS = [
  'title', 'businessCompany', 'affiliateCompany', 'webMapsId', 'assetIp', 'assetFqdn', 'assetTitle',
] as const satisfies readonly (keyof OverseasIssue)[];

/** 空の項目を落とす (上書きで既存値を消さないため)。 */
function onlyFilled(fields: Omit<OverseasIssue, 'id'>): Partial<OverseasIssue> {
  const out: Partial<OverseasIssue> = {};
  for (const [k, v] of Object.entries(fields) as [keyof OverseasIssue, unknown][]) {
    if (v === undefined || v === '') continue;
    (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

/** マージ CSV の 1 行から、名前のゆれを吸収して値を引く。 */
function csvOf(row: Record<string, string> | undefined, names: string[]): string {
  if (!row) return '';
  const keys = Object.keys(row);
  for (const n of names) {
    const hit = findColumn(keys, n);
    if (hit && text(row[hit])) return text(row[hit]);
  }
  return '';
}

/** 管理対象の Scan_ 値 (CSV に無かったときの控え)。 */
function scanOf(issue: ManagedIssue | undefined, name: string): string {
  if (!issue) return '';
  return text(resolveScanValue(issue.scanFields, `Scan_${name}`, []));
}

/**
 * 検査ツールの応答 (scanFields) から、名前のゆれを吸収して値を引く。
 * ★ アダプタは CSV のヘッダ名そのままで返す (`Asset IP` など) が、管理対象に
 *   保存済みの値は `Scan_` 接頭辞付きのことがある。両方を試す。
 */
export function scanFieldOf(fields: Record<string, string> | undefined, names: string[]): string {
  if (!fields) return '';
  const keys = Object.keys(fields);
  for (const n of names) {
    for (const cand of [n, `Scan_${n}`]) {
      const hit = findColumn(keys, cand);
      if (hit && text(fields[hit])) return text(fields[hit]);
    }
  }
  return '';
}

/** 検査ツールから取り直した 1 件を、海外一覧の行に当てる差分。
 *
 * ★ 更新するのは **検査ツール由来の項目だけ**。
 *   - 検知状況 / open … 月次 Excel の履歴から決まる (ツールの現在値で上書きしない)
 *   - 通知日 / 地域 / 備考 … Excel 由来
 *   - 事業会社 / 管理会社 / WebMAPS管理ID / 参考情報 … 人が決める
 * ★ 取れなかった項目は差分に入れない。空で上書きして既存を消さないため。
 */
export function overseasScannerPatch(
  res: { lastSeen?: string; scanFields?: Record<string, string> },
): Partial<OverseasIssue> {
  const patch: Partial<OverseasIssue> = {};
  const put = (key: keyof OverseasIssue, v: string): void => {
    if (v) (patch as Record<string, unknown>)[key] = v;
  };
  put('title', scanFieldOf(res.scanFields, ['Title']));
  put('assetIp', scanFieldOf(res.scanFields, ['Asset IP']));
  put('assetFqdn', scanFieldOf(res.scanFields, ['Asset Domain', 'Asset']));
  put('assetTitle', scanFieldOf(res.scanFields, ['Asset Title']));
  put('assetMappedDomains', scanFieldOf(res.scanFields, ['Asset Mapped Domains']));
  put('assetHomepageUrl', scanFieldOf(res.scanFields, ['Asset Homepage URL']));
  put('lastSeen', text(res.lastSeen) || scanFieldOf(res.scanFields, ['Last Seen']));
  return patch;
}

/** マージ CSV を Issue Instance ID で引ける形にする。 */
export function indexMergedCsv(rows: Record<string, string>[]): Map<string, Record<string, string>> {
  const out = new Map<string, Record<string, string>>();
  if (!rows.length) return out;
  const key = findColumn(Object.keys(rows[0]!), OVERSEAS_COL.issueInstanceId, ['Issue ID', 'IssueInstanceId']);
  if (!key) return out;
  for (const r of rows) {
    const iid = text(r[key]);
    if (iid) out.set(iid, r);   // 同じ ID が複数行あれば後の行を採用
  }
  return out;
}

/**
 * シート全体 (複数ファイル分をまとめて渡してよい) の取り込み計画を組み立てる。
 *
 * @param rows       Excel の全行 (ファイルを跨いで連結してよい)
 * @param headers    見出し (ファイルを跨ぐ場合は和集合)
 * @param existing   既存の海外脆弱性一覧
 * @param scanner    ダウンロード済みマージ CSV (Issue Instance ID で引ける形)
 * @param domestic   国内の管理対象 (事業会社などの Mikke 側の値を引く元)
 * @param parseDate  日付の読み取り (lib/migration の parseFlexibleDate を渡す)
 * @param nowIso     取り込み日時
 */
export function buildOverseasPlan(
  rows: Record<string, string>[],
  headers: string[],
  existing: OverseasIssue[],
  scanner: Map<string, Record<string, string>>,
  domestic: ManagedIssue[],
  parseDate: DateParser,
  nowIso: string,
): OverseasPlan {
  const col = resolveOverseasColumns(headers);
  const plan: OverseasPlan = {
    creates: [], updates: [], skipped: 0, entries: 0,
    unmatched: [], warnings: [], missingColumns: missingOverseasColumns(col),
  };
  if (!col.issueInstanceId) return plan;   // 突合キーが無ければ何もできない

  const domesticByIid = new Map(domestic.filter((d) => d.issueInstanceId).map((d) => [d.issueInstanceId, d]));
  const unmatched = new Set<string>();

  // ★ 追記型なので、まず Issue Instance ID × 地域 でまとめる。
  //   同じ脆弱性を複数の地域へ通知していることがあるので、地域も鍵に含める。
  interface Entry { iid: string; region: string; rows: { at: string | null; open: OverseasOpenStatus | null; raw: Record<string, string> }[] }
  const groups = new Map<string, Entry>();
  for (const row of rows) {
    const iid = text(row[col.issueInstanceId]);
    if (!iid) { plan.skipped++; continue; }
    const region = col.region ? String(toRegion(row[col.region] ?? '')) : '';
    const rawDate = col.contactedAt ? text(row[col.contactedAt]) : '';
    const at = rawDate ? parseDate(rawDate) : null;
    if (rawDate && !at) {
      plan.warnings.push({ issueInstanceId: iid, message: `通知日「${rawDate}」を日付として読めません` });
    }
    const open = col.open ? toOpenStatus(row[col.open] ?? '') : null;
    if (col.open && !open && text(row[col.open])) {
      plan.warnings.push({ issueInstanceId: iid, message: `open 列「${text(row[col.open])}」を判別できません` });
    }
    const key = overseasKey(iid, region);
    const g = groups.get(key) ?? { iid, region, rows: [] };
    g.rows.push({ at, open, raw: row });
    groups.set(key, g);
  }

  const byKey = new Map(existing
    .filter((e) => e.issueInstanceId)
    .map((e) => [overseasKey(e.issueInstanceId, e.region), e]));

  for (const [key, g] of groups) {
    const iid = g.iid;
    // 古い順にたどって検知状況を積み上げる。日付が読めない行は最後に回す。
    const ordered = [...g.rows].sort((a, b) => {
      if (a.at && b.at) return a.at < b.at ? -1 : (a.at > b.at ? 1 : 0);
      if (a.at) return -1;
      if (b.at) return 1;
      return 0;
    });
    let detectionStatus: DetectionStatus | undefined;
    for (const r of ordered) detectionStatus = nextOverseasDetection(detectionStatus, r.open ?? undefined);
    // ★ 「最新の行」は **日付が読めた行の中の最後**。日付が読めない行は並べようが
    //   ないので末尾に置いているが、それを最新とみなすと、1 行混ざっただけで
    //   通知日・open・備考がその行の内容になってしまう。日付が読める行が
    //   1 つも無いときだけ、仕方なく末尾の行を使う。
    const dated = ordered.filter((r) => r.at);
    const last = dated[dated.length - 1] ?? ordered[ordered.length - 1]!;
    const open = last.open;
    const contactedAt = last.at;
    const row = last.raw;
    plan.entries++;

    const d = domesticByIid.get(iid);
    const c = scanner.get(iid);
    // ★ 「見つからない」は CSV に無いことを指す。管理対象に無いのは普通のこと
    //   (管理対象条件に一致しない脆弱性も海外側では扱うため)。
    if (!c && !d) unmatched.add(iid);

    const prev = byKey.get(key);
    // ★ 事業会社 / 管理会社 / WebMAPS管理ID / 参考情報 は **人が決める値**。
    //   一覧で直接直せるし、初期データの Excel からも入る。月次の取り込みで
    //   国内の管理対象の値 (無ければ空) を上書きすると、手で入れた値が毎月消える。
    //   既に値があればそれを残し、空のときだけ管理対象から引く。
    const keep = (cur: string | undefined, fromDomestic: string): string => text(cur) || fromDomestic;
    const fields: Omit<OverseasIssue, 'id'> = {
      issueInstanceId: iid,
      contactedAt: contactedAt ?? '',
      openStatus: open ?? undefined,
      detectionStatus: detectionStatus ?? '未検出',
      region: g.region,
      remarks: col.remarks ? text(row[col.remarks]) : '',
      // ★ 脆弱性・資産の情報は マージ CSV を優先。無ければ管理対象の控えを使う。
      title: csvOf(c, ['Title']) || text(d?.title),
      assetIp: csvOf(c, ['Asset IP']) || scanOf(d, 'Asset IP'),
      assetFqdn: csvOf(c, ['Asset Domain', 'Asset']) || scanOf(d, 'Asset Domain'),
      assetTitle: csvOf(c, ['Asset Title']) || scanOf(d, 'Asset Title'),
      assetMappedDomains: csvOf(c, ['Asset Mapped Domains']) || scanOf(d, 'Asset Mapped Domains'),
      assetHomepageUrl: csvOf(c, ['Asset Homepage URL']) || scanOf(d, 'Asset Homepage URL'),
      lastSeen: csvOf(c, ['Last Seen']) || text(d?.lastSeen),
      // ここから下は Mikke 側で付ける値。管理対象にあれば引く (無ければ空)。
      businessCompany: keep(prev?.businessCompany, text(d?.businessCompany)),
      affiliateCompany: keep(prev?.affiliateCompany, text(d?.affiliateCompany)),
      webMapsId: keep(prev?.webMapsId, text(d?.webMapsId)),
      identifyEvidence: keep(prev?.identifyEvidence, text(d?.identifyEvidence)),
      importedAt: nowIso,
    };

    // ★ 上書きでは **値が取れた項目だけ** 送る。取れなかった項目 (マージ CSV にも
    //   管理対象にも無い / 日付が読めない / その列がファイルに無い) を空文字で送ると、
    //   初期データの Excel から入れた値や、一覧で手入力した値が黙って消える。
    //   海外分には管理対象条件に一致しない脆弱性が普通に含まれるので、これは例外的な
    //   経路ではない (CSV が 1 本も無ければ全行がこれに当たる)。
    // ★ 単一行テキスト列 (255 文字・改行なし) に収める。CSV から来る FQDN 一覧
    //   (' | ' 連結) と検査ツールの長いタイトルが実際に超え、超えると SharePoint は
    //   その行を HTTP 500 で拒否する。
    for (const k of OVERSEAS_SINGLE_LINE_FIELDS) fields[k] = fitSingleLine(fields[k] ?? '');

    if (prev) plan.updates.push({ id: prev.id, patch: onlyFilled(fields) });
    else plan.creates.push(fields);
  }
  // ★ ファイルに無い既存アイテムには触れない。追記型なので「無い」は
  //   「未検出になった」ではなく「そのファイルの範囲外」を意味する
  //   (地域ごとに分かれたファイルを 1 つだけ取り込むこともある)。

  plan.unmatched = [...unmatched].sort((a, b) => a.localeCompare(b));
  return plan;
}
