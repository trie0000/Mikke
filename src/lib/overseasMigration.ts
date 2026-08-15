// 海外分の初期データ移行 (Excel → 海外脆弱性一覧)。
//
// ★ 位置づけは国内の「データ移行 (Excel)」と同じ。今 Excel で運用している内容を
//   そのまま海外脆弱性一覧の初期データとして入れる。毎月の通知ファイル
//   (lib/overseas.ts) とは **別の入口・別の書式** なので混ぜない。
//     - 初期データ … シート「list」のテーブル。1 行 = 1 件の現状。日本語の見出し。
//     - 月次        … 地域ごとの追記型ファイル。履歴から検知状況を決める。
//
// ★ 突合キーは海外一覧と同じ **Issue Instance ID × 地域**。同じ ID を 2 回読んでも
//   増えないよう、既にある行は上書きする (国内の移行と同じ考え方)。
//
// UI にも SP にも依存しない (テストしやすくするため)。
import type { DetectionStatus, OverseasIssue } from '../types';
import { findColumn, overseasKey, toRegion, type DateParser } from './overseas';
import {
  applyAliasRemap, buildAliasIndex, buildRemapIndex, extractWebMapsIds, isExcelError,
  isIpAddress, normalizeAliasRemap, OTHER_COMPANY, resolveCompany, toDetectionStatus,
} from './migration';
import { fitSingleLine } from './vulnResponseSync';
import { normalizePerms } from './itemPerms';

const text = (v: unknown): string => (v === undefined || v === null ? '' : String(v)).trim();

/**
 * Excel の列名 (シート「list」のテーブル)。
 * ★ 検知状況の見出しは実際には検査ツール名が頭に付く (「〜での通知状況」)。
 *   ツール名は書かず、**必ず残る部分**だけで探す (findColumn が部分一致で拾う)。
 *   ツールを乗り換えても見出しの後半は変わらないので、こちらの方が壊れにくい。
 */
export const OVS_MIG_COL = {
  issueInstanceId: 'Issue Instance ID',
  contactedAt: '通知日',
  detection: '通知状況',
  businessCompany: '事業会社',
  region: '地域',
  affiliateCompany: '管理会社',
  webMaps: 'WebMaps登録情報',
  identifyEvidence: 'その他参考情報',
  ipOrUrl: 'IP/URL',
  title: '脆弱性',
  assetTitle: 'Asset Title',
  assetMappedDomains: 'Asset Mapped Domains',
  assetHomepageUrl: 'Asset Homepage URL',
  lastSeen: '最終検知日',
  remarks: '備考',
} as const;

export type OvsMigColKey = keyof typeof OVS_MIG_COL;

/** 見出しのゆれを吸収するための別名。 */
const ALTS: Partial<Record<OvsMigColKey, string[]>> = {
  issueInstanceId: ['Issue ID', 'IssueInstanceId'],
  webMaps: ['WebMAPS登録情報', 'WebMaps管理ID', 'WebMAPS管理ID'],
  identifyEvidence: ['その他の参考情報', '参考情報'],
  ipOrUrl: ['IP/FQDN'],
  // ★ 'Title' は入れない。'Asset Title' に部分一致してしまい、脆弱性名の欄に
  //   資産名が入ったまま「列は全部見つかった」ことになる。
  title: ['脆弱性タイトル', 'Vulnerability'],
};

/** 見出しの比較用キー (findColumn と同じ揃え方)。 */
const norm = (s: string): string => text(s).toLowerCase().replace(/[\s\u3000_]+/g, '');

export type OvsColumnMap = Partial<Record<OvsMigColKey, string>>;

/**
 * シートの見出しから、どの列を使うかを決める。
 *
 * ★ 2 巡に分ける。1 巡目は **完全一致だけ**、2 巡目で残った見出しだけを曖昧一致で拾う。
 *   1 巡目から曖昧一致を許すと、ある列が **他の列の見出しを横取り** する。
 *   実際にあった例: 「脆弱性」の見出しが変わると、部分一致で 'Asset Title' を掴み、
 *   脆弱性名の欄に資産名が入ったまま「見つからない列は無い」と表示されてしまう。
 * ★ 同じ見出しを 2 つの列に割り当てない (used)。取り違えたまま静かに登録するより、
 *   「見つからない列があります」と赤字で出したほうがよい。
 */
export function resolveOvsMigColumns(headers: string[]): { byKey: OvsColumnMap; missing: string[] } {
  const byKey: OvsColumnMap = {};
  const missing: string[] = [];
  const used = new Set<string>();
  const keys = Object.keys(OVS_MIG_COL) as OvsMigColKey[];
  for (const key of keys) {
    const cands = [OVS_MIG_COL[key], ...(ALTS[key] ?? [])].map(norm);
    const hit = headers.find((h) => !used.has(h) && cands.includes(norm(h)));
    if (hit) { byKey[key] = hit; used.add(hit); }
  }
  for (const key of keys) {
    if (byKey[key]) continue;
    const hit = findColumn(headers.filter((h) => !used.has(h)), OVS_MIG_COL[key], ALTS[key] ?? []);
    if (hit) { byKey[key] = hit; used.add(hit); } else missing.push(OVS_MIG_COL[key]);
  }
  return { byKey, missing };
}

// ── IP / URL の切り分け ─────────────────────────────────────────────────────
/** 値なしとみなす書き方 (この列に入っていても資産ではない)。 */
const NOT_A_VALUE = /^(n\/?a|なし|none|-+|—+|ー+)$/i;

/**
 * `IP/URL` 列の 1 セルを IP と FQDN に振り分ける。
 *
 * ★ URL で書かれていたら **スキーム (http:// https://) を落として** ホストだけにする。
 *   ユーザー要望「http は含まない」。ポート・パス・クエリも落とす (ホスト名ではないため)。
 * ★ スキームが無い値は **切らずにそのまま** 使う。`/` で切ると `N/A` が `N` になる
 *   ような取り違えが起きる (実際に踏んだ)。切るのは URL と分かる場合だけにする。
 * ★ 複数書かれていることがある (改行 / `|` / カンマ区切り)。全部拾って並べる。
 */
export function splitIpAndFqdn(raw: string): { ip: string; fqdn: string } {
  const ips: string[] = [];
  const fqdns: string[] = [];
  for (const tok of text(raw).split(/[\r\n|,、;；\s]+/)) {
    const t = tok.trim();
    if (!t || NOT_A_VALUE.test(t) || isExcelError(t)) continue;
    let host = t;
    const m = /^[a-z][a-z0-9+.-]*:\/\/(.*)$/i.exec(t);
    if (m) {
      // URL と分かる場合だけ authority を取り出す (user@host:port/path?query#frag)
      host = m[1]!.split(/[/?#]/)[0] ?? '';
      const at = host.lastIndexOf('@');
      if (at >= 0) host = host.slice(at + 1);
      host = host.replace(/:\d+$/, '');
      // IPv6 リテラルの括弧は外す
      host = host.replace(/^\[(.*)\]$/, '$1');
    }
    host = host.trim();
    if (!host) continue;
    const list = isIpAddress(host) ? ips : fqdns;
    if (!list.includes(host)) list.push(host);
  }
  return { ip: ips.join(' | '), fqdn: fqdns.join(' | ') };
}

/** SharePoint 側が単一行テキスト (255 文字) の項目。schema.ts の overseasFieldSpecs と揃える。 */
const SINGLE_LINE_FIELDS = [
  'title', 'businessCompany', 'affiliateCompany', 'webMapsId', 'assetIp', 'assetFqdn', 'assetTitle',
] as const satisfies readonly (keyof OverseasIssue)[];

// ── 1 行の変換 ──────────────────────────────────────────────────────────────
export interface OvsMigrationRowResult {
  /** 登録する内容 (Issue Instance ID が無い行は null)。 */
  issue: Omit<OverseasIssue, 'id'> | null;
  /** この行で気づいたこと (画面に出す)。 */
  warnings: string[];
}

export interface OvsMigrationContext {
  aliasIndex: Map<string, string>;
  /** 旧略称 → 現在の略称。 */
  remapIndex: Map<string, string>;
  parseDate: DateParser;
  nowIso: string;
  columns: OvsColumnMap;
}

/** Excel の 1 行を海外脆弱性一覧の 1 件に変換する。 */
export function migrateOverseasRow(
  row: Record<string, string>, ctx: OvsMigrationContext,
): OvsMigrationRowResult {
  const warnings: string[] = [];
  const errorCells: string[] = [];
  /** 論理列 → シートの実際の見出しを引いてから値を読む。 */
  const cell = (key: OvsMigColKey): string => {
    const col = ctx.columns[key];
    return col ? text(row[col]) : '';
  };
  const get = (key: OvsMigColKey): string => {
    const v = cell(key);
    // 数式セルは値 (キャッシュ結果) で読まれる。XLOOKUP が外れた行は #N/A などに
    // なるので、そのまま保存せず空として扱い、気づけるよう警告に出す。
    if (isExcelError(v)) { errorCells.push(`${OVS_MIG_COL[key]}=${v}`); return ''; }
    return v;
  };

  const issueInstanceId = get('issueInstanceId');
  if (!issueInstanceId) {
    return { issue: null, warnings: [`${OVS_MIG_COL.issueInstanceId} が空のため取り込めません`] };
  }

  // 事業会社は略称で書かれている。旧略称は現在の略称に読み替えてから引く。
  // ★ 引けなかった行は空欄にせず「その他」へ寄せる (国内の移行と同じ)。
  //   事業会社はアクセス権の割当キーなので、空欄だと誰にも見えない行になる。
  const companyCell = cell('businessCompany');
  const rawCompany = get('businessCompany');
  const usedAlias = applyAliasRemap(rawCompany, ctx.remapIndex);
  const resolved = resolveCompany(usedAlias, ctx.aliasIndex);
  const businessCompany = resolved ?? (companyCell ? OTHER_COMPANY : '');
  if (rawCompany && !resolved) {
    warnings.push(usedAlias === rawCompany
      ? `事業会社の略称「${rawCompany}」に対応する事業会社が未登録のため「${OTHER_COMPANY}」にしました`
      : `旧略称「${rawCompany}」を「${usedAlias}」に読み替えましたが、対応する事業会社が未登録のため「${OTHER_COMPANY}」にしました`);
  } else if (!rawCompany && companyCell) {
    warnings.push(`事業会社を決められないため「${OTHER_COMPANY}」にしました`);
  }

  const detectionRaw = get('detection');
  const detection = toDetectionStatus(detectionRaw);
  if (detectionRaw && !detection) warnings.push(`検知状況「${detectionRaw}」を判別できません`);

  // 日付は SP の日付列に入る。読めない値を送ると 1 行まるごと 400 になるので、
  // 読めたものだけ ISO で入れて、読めなければ警告に出す。
  const date = (key: OvsMigColKey): string => {
    const raw = get(key);
    if (!raw) return '';
    const iso = ctx.parseDate(raw);
    if (!iso) {
      warnings.push(`${OVS_MIG_COL[key]}「${raw}」を日付として読めないため空にしました`);
      return '';
    }
    return iso;
  };

  const webMapsRaw = get('webMaps');
  const webMapsId = extractWebMapsIds(webMapsRaw);
  if (webMapsRaw && !webMapsId) {
    warnings.push(`${OVS_MIG_COL.webMaps}から管理ID を抽出できません: ${webMapsRaw.slice(0, 40)}`);
  }

  const regionRaw = get('region');
  const region = regionRaw ? String(toRegion(regionRaw)) : '';
  const { ip, fqdn } = splitIpAndFqdn(get('ipOrUrl'));

  const issue: Omit<OverseasIssue, 'id'> = {
    issueInstanceId,
    contactedAt: date('contactedAt'),
    // ★ openStatus は入れない。この Excel には open/closed の列が無く、
    //   検知状況が直接書かれている (月次ファイルとはそこが違う)。
    detectionStatus: (detection ?? '継続') as DetectionStatus,
    region,
    title: get('title'),
    businessCompany,
    affiliateCompany: get('affiliateCompany'),
    webMapsId,
    identifyEvidence: get('identifyEvidence'),
    assetIp: ip,
    assetFqdn: fqdn,
    assetTitle: get('assetTitle'),
    assetMappedDomains: get('assetMappedDomains'),
    assetHomepageUrl: get('assetHomepageUrl'),
    lastSeen: date('lastSeen'),
    remarks: get('remarks'),
    importedAt: ctx.nowIso,
  };

  // ★ 単一行テキスト列 (255 文字・改行なし) に収める。超えると SharePoint が
  //   HTTP 500 で拒否し、その行だけ登録されない。資産が多い脆弱性の FQDN 一覧
  //   (' | ' 連結) と検査ツールの長いタイトルが実際に超える。
  //   切り詰めは **値の組み立て時に** 行う (書込直前で切ると差分比較とズレる)。
  for (const k of SINGLE_LINE_FIELDS) issue[k] = fitSingleLine(issue[k] ?? '');

  if (errorCells.length) warnings.push(`数式のエラー値を空にしました: ${errorCells.join(' / ')}`);
  return { issue, warnings };
}

// ── 書き込み先の振り分け ────────────────────────────────────────────────────
export interface OvsMigrationSplit {
  /** 新規に追加する行。 */
  adds: Omit<OverseasIssue, 'id'>[];
  /** 既存を上書きする行 (空欄の項目は入っていない = 既存値を残す)。 */
  updates: { id: number; patch: Partial<OverseasIssue> }[];
  /** Excel の中で 突合キーが重複していた分 (後の行を採用した)。 */
  dupInFile: { key: string; issueInstanceId: string; region: string; count: number }[];
  /** 一覧に同じ突合キーが複数ある分 (いちばん小さい ID を上書きする)。 */
  dupInList: { issueInstanceId: string; region: string; count: number }[];
}

/** 既存の海外脆弱性一覧を突合キーで引ける形にする。 */
export function indexOverseasByKey(rows: OverseasIssue[]): Map<string, number[]> {
  const idx = new Map<string, number[]>();
  for (const r of rows) {
    if (!text(r.issueInstanceId)) continue;
    const k = overseasKey(r.issueInstanceId, r.region);
    const hit = idx.get(k);
    if (hit) hit.push(r.id); else idx.set(k, [r.id]);
  }
  for (const ids of idx.values()) ids.sort((a, b) => a - b);
  return idx;
}

/**
 * 上書き用の patch。**空欄の項目は入れない**。
 *
 * ★ Excel の空セルで既存値を消さないため。移行は 1 回で終わらない
 *   (略称を登録し直して読み直す・追記された Excel をもう一度読む)。そのとき
 *   一覧で手入力した事業会社や、月次取込で埋まった資産情報が、Excel 側が空という
 *   だけで消えると復旧できない。**書いてある値だけを反映する** と決める。
 * ★ 値を消したいときは一覧の画面で消す (そちらは 1 項目だけを狙って書く)。
 */
function toPatch(issue: Omit<OverseasIssue, 'id'>): Partial<OverseasIssue> {
  const out: Partial<OverseasIssue> = {};
  for (const [k, v] of Object.entries(issue) as [keyof OverseasIssue, unknown][]) {
    if (v === undefined || v === '') continue;
    (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

/**
 * 取り込む行を「追加」と「上書き」に振り分ける。
 * ★ Excel の中で同じ突合キーが複数あったら **後の行を採用** する
 *   (1 回の取り込みで同じキーを 2 行書くと、それ自体が二重登録になる)。
 */
export function splitOverseasMigrationWrites(
  rows: OvsMigrationRowResult[], existing: Map<string, number[]>,
): OvsMigrationSplit {
  const byKey = new Map<string, Omit<OverseasIssue, 'id'>>();
  const seen = new Map<string, number>();
  for (const r of rows) {
    if (!r.issue) continue;
    const k = overseasKey(r.issue.issueInstanceId, r.issue.region);
    byKey.set(k, r.issue);
    seen.set(k, (seen.get(k) ?? 0) + 1);
  }
  const adds: Omit<OverseasIssue, 'id'>[] = [];
  const updates: { id: number; patch: Partial<OverseasIssue> }[] = [];
  const dupInList: OvsMigrationSplit['dupInList'] = [];
  for (const [k, issue] of byKey) {
    const ids = existing.get(k);
    if (ids?.length) {
      updates.push({ id: ids[0]!, patch: toPatch(issue) });
      if (ids.length > 1) {
        dupInList.push({ issueInstanceId: issue.issueInstanceId, region: issue.region ?? '', count: ids.length });
      }
    } else {
      adds.push(issue);
    }
  }
  const dupInFile = [...seen.entries()].filter(([, n]) => n > 1).map(([k, count]) => {
    const issue = byKey.get(k)!;
    return { key: k, issueInstanceId: issue.issueInstanceId, region: issue.region ?? '', count };
  });
  return { adds, updates, dupInFile, dupInList };
}

// ── シート全体の計画 ────────────────────────────────────────────────────────
export interface OvsMigrationPlan {
  rows: OvsMigrationRowResult[];
  /** 取り込める件数。 */
  ready: number;
  /** Issue Instance ID が無くて取り込めない件数。 */
  skipped: number;
  /** 事業会社を引けなかった略称 (画面に出して登録を促す)。 */
  unknownAliases: string[];
  /** 実際に読み替えが効いた件数。 */
  remapped: { from: string; to: string; count: number }[];
  /** 事業会社を決められず「その他」に寄せた件数。 */
  otherCount: number;
  /** シートに見つからなかった列。 */
  missingColumns: string[];
}

/** シート全体の移行計画を組み立てる (書き込みは行わない)。 */
export function buildOverseasMigrationPlan(
  rows: Record<string, string>[],
  headers: string[],
  perms: unknown,
  aliasRemap: unknown,
  parseDate: DateParser,
  nowIso: string,
): OvsMigrationPlan {
  const cols = resolveOvsMigColumns(headers);
  const ctx: OvsMigrationContext = {
    aliasIndex: buildAliasIndex(normalizePerms(perms)),
    remapIndex: buildRemapIndex(normalizeAliasRemap(aliasRemap)),
    parseDate,
    nowIso,
    columns: cols.byKey,
  };
  const results = rows.map((r) => migrateOverseasRow(r, ctx));

  const unknown = new Set<string>();
  const hits = new Map<string, { from: string; to: string; count: number }>();
  const companyCol = cols.byKey.businessCompany;
  if (companyCol) {
    for (const r of rows) {
      const a = text(r[companyCol]);
      // 数式のエラー値は「未登録の略称」ではない (原因が別なので混ぜない)。
      if (!a || isExcelError(a)) continue;
      const mapped = applyAliasRemap(a, ctx.remapIndex);
      if (mapped !== a) {
        const key = `${a} ${mapped}`;
        const hit = hits.get(key);
        if (hit) hit.count++; else hits.set(key, { from: a, to: mapped, count: 1 });
      }
      if (!resolveCompany(mapped, ctx.aliasIndex)) unknown.add(a);
    }
  }

  return {
    rows: results,
    ready: results.filter((r) => r.issue).length,
    skipped: results.filter((r) => !r.issue).length,
    unknownAliases: [...unknown].sort((a, b) => a.localeCompare(b, 'ja')),
    remapped: [...hits.values()].sort((a, b) => b.count - a.count || a.from.localeCompare(b.from, 'ja')),
    otherCount: results.filter((r) => r.issue?.businessCompany === OTHER_COMPANY).length,
    missingColumns: cols.missing,
  };
}
