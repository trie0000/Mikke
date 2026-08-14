// Excel 管理時代のデータを Mikke の管理対象へ移行する。
//
// ★ 前提
//   - Excel のシート「list」がテーブルオブジェクトになっている。1 行目がヘッダ。
//   - 事業会社は **略称** で書かれている。アクセス権画面で登録した
//     「事業会社 → 略称」の対応でどの事業会社かを決める (lib/itemPerms.ts)。
//     解決できた事業会社がそのままアクセス権の割当キーになる。
//   - 検知状況・対応状況は Excel 側の表記を Mikke のステータスへ寄せる。
//   - 担当者はメールアドレスを鍵に AD から引く (氏名列は引けなかったときの控え)。
//
// UI にも SP にも依存しない (テストしやすくするため)。
import type { ManagedIssue, DetectionStatus, MgmtStatus, VulnType } from '../types';
import { MGMT_STATUSES, DEFAULT_MGMT_STATUS } from '../types';
import { normalizePerms, type VulnResponsePerms } from './itemPerms';

const text = (v: unknown): string => (v === undefined || v === null ? '' : String(v)).trim();

/** Excel の数式エラー値 (XLOOKUP が外れたときの #N/A など)。 */
const EXCEL_ERROR = /^#(N\/A|REF!|VALUE!|NAME\?|DIV\/0!|NUM!|NULL!|SPILL!|CALC!|GETTING_DATA)$/i;
export function isExcelError(v: string): boolean { return EXCEL_ERROR.test(text(v)); }

// ── Excel の列名 (シート「list」のヘッダ) ────────────────────────────────────
export const MIG_COL = {
  legacyMgmtNumber: 'No.',
  detection: 'Cycognitoでの検知状況',
  businessCompany: '事業会社',
  affiliateCompany: '管理会社',
  webMaps: 'WebMAPS登録情報',
  identifyEvidence: 'その他の参考情報',
  ipOrUrl: 'IP/URL',
  dynamicIp: '動的IP',
  title: '脆弱性',
  assetTitle: 'Asset Title',
  assetMappedDomains: 'Asset Mapped Domains',
  assetHomepageUrl: 'Asset Homepage URL',
  lastSeen: '最終検知日',
  mgmtStatus: '対応状況',
  personName: '氏名',
  personEmail: 'Eメールアドレス',
  responsePlan: '一カ月を目処に早めにご計画ください。',
  extConnAppId: '※ 申請状況を選択ください。',
  noAppReason: '備考2',
  responseNote: '本課題の「対応状況」を「完了」にする場合、その理由をご記入ください。',
  remarks: '特記事項',
  description: 'Description',
  remediationSteps: 'Remediation Steps',
  references: 'References',
  cveIds: 'CVE-IDs',
  evidence: 'Evidence',
  issueInstanceId: 'Issue ID',
} as const;

/**
 * 見出しの一部だけで探す列。
 * ★ この 2 列は Excel 側で句読点や前後の但し書きが揺れる (「※ 」の有無、末尾の
 *   「。」の有無など)。完全一致で探すと丸ごと取りこぼすので、**必ず残る部分**だけ
 *   で探す。ここに書いていない列は今までどおり完全一致。
 */
const PARTIAL_MATCH: Record<string, string> = {
  [MIG_COL.extConnAppId]: '申請状況を選択ください',
  [MIG_COL.responsePlan]: '目処に早めにご計画',
};

/** MIG_COL の列名 → シートにある実際の見出し。 */
export interface ColumnMap {
  byCol: Record<string, string>;
  /** シートに見つからなかった列 (MIG_COL の列名)。 */
  missing: string[];
}

/** シートの見出しから、どの列を使うかを決める。 */
export function resolveMigColumns(headers: string[]): ColumnMap {
  const byCol: Record<string, string> = {};
  const missing: string[] = [];
  for (const col of Object.values(MIG_COL) as string[]) {
    const needle = PARTIAL_MATCH[col];
    const hit = needle
      ? headers.find((h) => h.includes(needle))
      : headers.find((h) => h === col);
    if (hit === undefined) missing.push(col);
    else byCol[col] = hit;
  }
  return { byCol, missing };
}

/** そのまま同名の Scan_ 列として持ち込むもの (検査ツール由来の参考情報)。 */
const PASSTHROUGH_SCAN_COLUMNS = [
  MIG_COL.assetTitle, MIG_COL.assetMappedDomains, MIG_COL.assetHomepageUrl,
  MIG_COL.description, MIG_COL.remediationSteps, MIG_COL.references,
  MIG_COL.cveIds, MIG_COL.evidence,
];

// ── 検知状況の対応表 ────────────────────────────────────────────────────────
// Excel 側の表記 (日本語 / 英語) → Mikke の検知ステータス。
// ★「未検出(リスク受容)」は検知としては「未検出」。リスク受容は対応ステータス側の
//   話なので、対応状況の列で決める (ここでは触らない)。
const DETECTION_MAP: [RegExp, DetectionStatus][] = [
  [/未検出\s*\(\s*new\s*\)|not\s*detected\s*\(\s*new\s*\)/i, '未検出(New)'],
  [/未検出\s*\(\s*リスク受容\s*\)/, '未検出'],
  [/未検出|not\s*detected/i, '未検出'],
  [/継続|contin/i, '継続'],
  [/再検出|再検知|re-?det/i, '再検知'],
  [/新規|^new$/i, '新規'],
];

/** Excel の検知状況 → Mikke の検知ステータス。読めなければ null。 */
export function toDetectionStatus(raw: string): DetectionStatus | null {
  const v = text(raw);
  if (!v) return null;
  for (const [re, status] of DETECTION_MAP) if (re.test(v)) return status;
  return null;
}

/** Excel の検知状況が「未検出(リスク受容)」か (対応ステータスをリスク受容にする)。 */
export function isRiskAccepted(raw: string): boolean {
  return /リスク受容/.test(text(raw));
}

/** Excel の対応状況 → Mikke の対応ステータス。一致しなければ既定値。 */
export function toMgmtStatus(raw: string): MgmtStatus {
  const v = text(raw);
  const hit = MGMT_STATUSES.find((s) => s === v);
  return hit ?? DEFAULT_MGMT_STATUS;
}

// ── WebMAPS 管理ID ──────────────────────────────────────────────────────────
/**
 * WebMAPS 登録情報から管理ID を抜き出す。
 * ★ A または B で始まり数字 6 桁が続く、合計 7 文字。周りに説明文が付いていても拾う。
 *   複数書かれている場合はすべて (重複は除く) を並べる。
 */
export function extractWebMapsIds(raw: string): string {
  const found = text(raw).toUpperCase().match(/\b[AB]\d{6}\b/g) ?? [];
  return [...new Set(found)].join(' | ');
}

// ── 資産 (IP / FQDN) ────────────────────────────────────────────────────────
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** IPv4 か。IP なら Asset IP、そうでなければ Asset Domain に入れる。 */
export function isIpAddress(v: string): boolean {
  const m = IPV4.exec(text(v));
  return !!m && m.slice(1).every((o) => Number(o) <= 255);
}

// ── 事業会社 (略称からの解決) ───────────────────────────────────────────────
/** 略称 → 事業会社名 の逆引き表を作る。比較は前後空白を落として小文字で行う。 */
export function buildAliasIndex(perms: VulnResponsePerms): Map<string, string> {
  const idx = new Map<string, string>();
  for (const [company, aliases] of Object.entries(perms.aliasesByCompany ?? {})) {
    // 正式名そのものでも引けるようにしておく (略称でない行が混じっていても通る)
    idx.set(company.trim().toLowerCase(), company);
    for (const a of aliases) {
      const k = text(a).toLowerCase();
      if (k) idx.set(k, company);
    }
  }
  for (const company of Object.keys(perms.byBusinessCompany)) {
    idx.set(company.trim().toLowerCase(), company);
  }
  return idx;
}

/**
 * どの事業会社にも寄せられなかった行の行き先。
 * ★ 空欄のまま入れると、後から「誰の担当か決まっていない行」を探せなくなる。
 *   まとめてここに入れておけば、一覧で絞り込めるしアクセス権も付けられる。
 */
export const OTHER_COMPANY = 'その他';

/** 略称から事業会社を決める。決まらなければ null (呼び出し側で警告する)。 */
export function resolveCompany(alias: string, idx: Map<string, string>): string | null {
  const k = text(alias).toLowerCase();
  if (!k) return null;
  return idx.get(k) ?? null;
}

// ── 旧略称の読み替え ────────────────────────────────────────────────────────
// 移行データには組織再編前の略称が書かれている行がある。現在の略称に読み替えて
// から事業会社を引く。旧略称 N 件 → 現在の略称 1 件 (N:1)。

/** 読み替え 1 行。`to` が現在の略称、`from` がそれに読み替える旧略称 (複数可)。 */
export interface AliasRemapRow { to: string; from: string[] }

/** 設定の保存値を安全な形に整える (壊れた値・空行・重複を落とす)。 */
export function normalizeAliasRemap(v: unknown): AliasRemapRow[] {
  if (!Array.isArray(v)) return [];
  const out: AliasRemapRow[] = [];
  for (const r of v) {
    const o = (r ?? {}) as Record<string, unknown>;
    const to = text(o.to);
    if (!to) continue;                                  // 読み替え先が無い行は捨てる
    const from = Array.isArray(o.from)
      ? [...new Set(o.from.map((x) => text(x)).filter(Boolean))]
      : [];
    // ★ 自分自身への読み替えは意味がないので落とす (無限ループの元でもある)。
    out.push({ to, from: from.filter((f) => f.toLowerCase() !== to.toLowerCase()) });
  }
  return out;
}

/**
 * 旧略称 → 現在の略称 の逆引き表。比較は前後空白を落として小文字で行う。
 * ★ 同じ旧略称が複数行に書かれていたら **先に書いた行が勝つ**
 *   (後勝ちにすると、行を足しただけで既存の読み替え先が変わってしまう)。
 */
export function buildRemapIndex(rows: AliasRemapRow[]): Map<string, string> {
  const idx = new Map<string, string>();
  for (const r of rows) {
    for (const f of r.from) {
      const k = f.toLowerCase();
      if (!idx.has(k)) idx.set(k, r.to);
    }
  }
  return idx;
}

/** 同じ旧略称が複数の読み替え先に書かれている箇所を挙げる (画面で注意を出す)。 */
export function remapConflicts(rows: AliasRemapRow[]): { from: string; to: string[] }[] {
  const seen = new Map<string, { from: string; to: string[] }>();
  for (const r of rows) {
    for (const f of r.from) {
      const k = f.toLowerCase();
      const hit = seen.get(k);
      if (hit) { if (!hit.to.includes(r.to)) hit.to.push(r.to); }
      else seen.set(k, { from: f, to: [r.to] });
    }
  }
  return [...seen.values()].filter((c) => c.to.length > 1);
}

/**
 * 旧略称なら現在の略称に読み替える。当たらなければそのまま返す。
 * ★ 読み替えは **1 段だけ**。A→B かつ B→C と書かれていても A は B で止める
 *   (連鎖させると書き順で結果が変わり、循環すると止まらない)。
 */
export function applyAliasRemap(alias: string, idx: Map<string, string>): string {
  const v = text(alias);
  if (!v) return v;
  return idx.get(v.toLowerCase()) ?? v;
}

// ── 脆弱性タイプ ────────────────────────────────────────────────────────────
export interface VulnTypeRules { port: string[]; admin: string[] }
export const DEFAULT_VULN_TYPE_RULES: VulnTypeRules = { port: [], admin: [] };

/** 設定の判定条件を安全な形に整える。 */
export function normalizeVulnTypeRules(v: unknown): VulnTypeRules {
  const o = (v ?? {}) as Record<string, unknown>;
  const list = (x: unknown): string[] =>
    Array.isArray(x) ? [...new Set(x.map((s) => text(s)).filter(Boolean))] : [];
  return { port: list(o.port), admin: list(o.admin) };
}

/**
 * Title から脆弱性タイプを判定する。
 * ★ 条件は「含まれていれば該当」の OR。どれにも当たらなければ「脆弱性」。
 *   ポートと管理画面の両方に当たった場合は **ポートを優先** する
 *   (先に評価する方を固定しておかないと、条件の並び順で結果が変わる)。
 */
export function detectVulnType(title: string, rules: VulnTypeRules): VulnType {
  const v = text(title).toLowerCase();
  const hit = (words: string[]): boolean => words.some((w) => v.includes(w.toLowerCase()));
  if (hit(rules.port)) return 'ポート';
  if (hit(rules.admin)) return '管理画面';
  return '脆弱性';
}

// ── 1 行 → 管理対象 ─────────────────────────────────────────────────────────

export interface MigrationRowResult {
  /** 登録する内容 (Issue Instance ID が無い行は null)。 */
  issue: Omit<ManagedIssue, 'id'> | null;
  /** 担当者を引くためのメールアドレス (AD 検索の鍵。登録はしない)。 */
  assigneeEmail: string;
  /** 氏名列の値 (AD で引けなかったときの控え)。 */
  assigneeFallback: string;
  /** この行で気づいたこと (画面に出す)。 */
  warnings: string[];
}

export interface MigrationContext {
  aliasIndex: Map<string, string>;
  /** 旧略称 → 現在の略称 (buildRemapIndex の結果)。 */
  remapIndex: Map<string, string>;
  vulnTypeRules: VulnTypeRules;
  nowIso: string;
  /** MIG_COL の列名 → シートの実際の見出し (部分一致で探した列があるため)。
   *  省略したときは列名をそのまま鍵にする。 */
  columns?: Record<string, string>;
}

/** Excel の 1 行を管理対象に変換する。 */
export function migrateRow(row: Record<string, string>, ctx: MigrationContext): MigrationRowResult {
  const warnings: string[] = [];
  // ★ 数式セルは値 (キャッシュ結果) で読まれる。XLOOKUP が外れた行は #N/A などの
  //   エラー値になるので、そのまま保存せず空として扱い、気づけるよう警告に出す。
  const errorCells: string[] = [];
  /** 列名 → シートの実際の見出しを引いてから値を読む (部分一致で探した列があるため)。 */
  const cell = (col: string): string => text(row[ctx.columns?.[col] ?? col]);
  const get = (k: string): string => {
    const v = cell(k);
    if (isExcelError(v)) { errorCells.push(`${k}=${v}`); return ''; }
    return v;
  };

  const issueInstanceId = get(MIG_COL.issueInstanceId);
  if (!issueInstanceId) {
    return { issue: null, assigneeEmail: '', assigneeFallback: '', warnings: ['Issue ID が空のため取り込めません'] };
  }

  // 事業会社は略称から引く。旧略称は現在の略称に読み替えてから引く。
  // ★ 引けなかった行は空欄にせず「その他」へ寄せる。
  //   Excel の欄自体が空の行は、寄せる元の組織が書かれていないので空欄のまま。
  const companyCell = cell(MIG_COL.businessCompany);        // 数式のエラー値も含む生の値
  const rawCompany = get(MIG_COL.businessCompany);
  const usedAlias = applyAliasRemap(rawCompany, ctx.remapIndex);
  const resolved = resolveCompany(usedAlias, ctx.aliasIndex);
  const company = resolved ?? (companyCell ? OTHER_COMPANY : '');
  if (rawCompany && !resolved) {
    warnings.push(usedAlias === rawCompany
      ? `事業会社の略称「${rawCompany}」に対応する事業会社が未登録のため「${OTHER_COMPANY}」にしました`
      : `旧略称「${rawCompany}」を「${usedAlias}」に読み替えましたが、対応する事業会社が未登録のため「${OTHER_COMPANY}」にしました`);
  } else if (!rawCompany && companyCell) {
    // 数式のエラー値だった行 (どの組織か書かれていない)。行き先を明示しておく。
    warnings.push(`事業会社を決められないため「${OTHER_COMPANY}」にしました`);
  }

  const detectionRaw = get(MIG_COL.detection);
  const detection = toDetectionStatus(detectionRaw);
  if (detectionRaw && !detection) warnings.push(`検知状況「${detectionRaw}」を判別できません`);

  // 対応ステータス。検知状況が「未検出(リスク受容)」ならリスク受容を優先する。
  const mgmtStatus = isRiskAccepted(detectionRaw) ? 'リスク受容' : toMgmtStatus(get(MIG_COL.mgmtStatus));

  const webMapsRaw = get(MIG_COL.webMaps);
  const webMapsId = extractWebMapsIds(webMapsRaw);
  if (webMapsRaw && !webMapsId) warnings.push(`WebMAPS登録情報から管理ID を抽出できません: ${webMapsRaw.slice(0, 40)}`);

  // 資産は IP か FQDN かで入れ先を変える (検査ツールの列名に合わせる)。
  const asset = get(MIG_COL.ipOrUrl);
  const scanFields: Record<string, string> = {};
  if (asset) scanFields[isIpAddress(asset) ? 'Scan_Asset IP' : 'Scan_Asset Domain'] = asset;
  const dynamic = get(MIG_COL.dynamicIp);
  if (dynamic) scanFields['Scan_Asset Dynamically resolved'] = dynamic;
  for (const c of PASSTHROUGH_SCAN_COLUMNS) {
    const v = get(c);
    if (v) scanFields[`Scan_${c}`] = v;
  }

  const title = get(MIG_COL.title);
  const issue: Omit<ManagedIssue, 'id'> = {
    issueInstanceId,
    title,
    detectionStatus: detection ?? '継続',
    mgmtStatus,
    isOutOfScope: mgmtStatus === '対象外',
    legacyMgmtNumber: get(MIG_COL.legacyMgmtNumber),
    businessCompany: company ?? '',
    affiliateCompany: get(MIG_COL.affiliateCompany),
    webMapsId,
    identifyEvidence: get(MIG_COL.identifyEvidence),
    lastSeen: get(MIG_COL.lastSeen),
    responsePlan: get(MIG_COL.responsePlan),
    extConnAppId: get(MIG_COL.extConnAppId),
    noAppReason: get(MIG_COL.noAppReason),
    responseNote: get(MIG_COL.responseNote),
    responseRemarks: get(MIG_COL.remarks),
    vulnType: detectVulnType(title, ctx.vulnTypeRules),
    addedReason: '個別指定',
    lastSyncedAt: ctx.nowIso,
    scanFields,
  };

  if (errorCells.length) {
    warnings.push(`数式のエラー値を空にしました: ${errorCells.join(' / ')}`);
  }
  return {
    issue,
    assigneeEmail: get(MIG_COL.personEmail),
    assigneeFallback: get(MIG_COL.personName),
    warnings,
  };
}

export interface MigrationPlan {
  rows: MigrationRowResult[];
  /** 取り込める件数。 */
  ready: number;
  /** Issue ID が無くて取り込めない件数。 */
  skipped: number;
  /** 事業会社を引けなかった略称 (画面に出して登録を促す)。Excel に書かれている値。 */
  unknownAliases: string[];
  /** 実際に読み替えが効いた件数 (設定どおりに当たっているか画面で確かめる)。 */
  remapped: { from: string; to: string; count: number }[];
  /** 事業会社を決められず「その他」に寄せた件数。 */
  otherCount: number;
  /** シートに見つからなかった列 (画面に出す)。 */
  missingColumns: string[];
}

/** シート全体の移行計画を組み立てる (書き込みは行わない)。 */
export function buildMigrationPlan(
  rows: Record<string, string>[],
  perms: unknown,
  rules: unknown,
  nowIso: string,
  aliasRemap?: unknown,
  headers?: string[],
): MigrationPlan {
  const remapRows = normalizeAliasRemap(aliasRemap);
  // 見出しを渡されなければ行の鍵から拾う (1 行も無ければ空)。
  const heads = headers ?? [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const cols = resolveMigColumns(heads);
  const ctx: MigrationContext = {
    aliasIndex: buildAliasIndex(normalizePerms(perms)),
    remapIndex: buildRemapIndex(remapRows),
    vulnTypeRules: normalizeVulnTypeRules(rules),
    nowIso,
    columns: cols.byCol,
  };
  const results = rows.map((r) => migrateRow(r, ctx));
  const unknown = new Set<string>();
  const hits = new Map<string, { from: string; to: string; count: number }>();
  const companyCol = cols.byCol[MIG_COL.businessCompany] ?? MIG_COL.businessCompany;
  for (const r of rows) {
    const a = text(r[companyCol]);
    // 数式のエラー値は「未登録の略称」ではない (原因が別なので混ぜない)。
    if (!a || isExcelError(a)) continue;
    const mapped = applyAliasRemap(a, ctx.remapIndex);
    if (mapped !== a) {
      const key = `${a} ${mapped}`;
      const hit = hits.get(key);
      if (hit) hit.count++;
      else hits.set(key, { from: a, to: mapped, count: 1 });
    }
    // 読み替え後も引けない値だけを「未登録」として挙げる。表示は Excel の値のまま。
    if (!resolveCompany(mapped, ctx.aliasIndex)) unknown.add(a);
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
