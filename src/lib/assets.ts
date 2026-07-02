// 資産管理 (FQDN / IP 単位) のコアロジック。
//   - 脆弱性 (ManagedIssues) から資産キーを抽出してユニーク化
//   - 社内の資産管理部門リスト CSV (基本情報 / サイトURL情報) を突合して
//     事業会社・関連会社・管理番号を特定する
// UI 非依存の純関数。テストは test/assets.test.ts。
import type { ManagedIssue, ManagedAsset } from '../types';
import type { ParsedCsv } from './csv';

/** 既定の資産列名 (脆弱性 CSV 内で FQDN/IP が入っている列)。 */
export const DEFAULT_ASSET_COLUMN = 'Asset';

/** IPv4 か (簡易判定。各オクテット 0-255)。 */
export function isIp(s: string): boolean {
  const m = s.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  return m.slice(1).every((o) => Number(o) <= 255);
}

/** 資産キーの正規化: trim / 小文字化 / 末尾ドット除去 / スキーム・パス除去。 */
export function normalizeAsset(raw: string): string {
  let s = (raw ?? '').trim().toLowerCase();
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');   // http:// 等のスキーム
  s = s.split('/')[0] ?? s;                        // パス以降
  s = s.split(':')[0] ?? s;                        // ポート
  s = s.replace(/\.+$/, '');                       // 末尾ドット
  return s;
}

export function assetTypeOf(key: string): 'FQDN' | 'IP' {
  return isIp(key) ? 'IP' : 'FQDN';
}

/** 1 セルから資産キーを取り出す (カンマ / セミコロン / 空白区切りの複数値対応)。 */
export function splitAssetCell(cell: string): string[] {
  return (cell ?? '')
    .split(/[,;\s]+/)
    .map((x) => normalizeAsset(x))
    .filter(Boolean);
}

/** 脆弱性一覧から資産キーをユニーク抽出する。
 *  資産列は scanFields (Scan_<列名> / SP 安全名) と固定項目の両方から探す。 */
export function extractAssetKeys(
  issues: ManagedIssue[],
  assetColumn: string,
  scanKeyOf: (col: string) => string,
): string[] {
  const out = new Set<string>();
  const rawKey = `Scan_${assetColumn}`;
  const safeKey = scanKeyOf(assetColumn);
  for (const i of issues) {
    const cell = i.scanFields?.[safeKey] ?? i.scanFields?.[rawKey] ?? '';
    for (const k of splitAssetCell(cell)) out.add(k);
  }
  return [...out];
}

/** 資産ごとの脆弱性件数 (assetKey → 件数)。 */
export function countIssuesByAsset(
  issues: ManagedIssue[],
  assetColumn: string,
  scanKeyOf: (col: string) => string,
): Record<string, number> {
  const out: Record<string, number> = {};
  const rawKey = `Scan_${assetColumn}`;
  const safeKey = scanKeyOf(assetColumn);
  for (const i of issues) {
    const cell = i.scanFields?.[safeKey] ?? i.scanFields?.[rawKey] ?? '';
    for (const k of splitAssetCell(cell)) out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

// ── 資産管理部門 CSV (2種) の突合 ────────────────────────────────────────────

/** ヘッダ照合用の正規化 (全角/半角スペース除去)。
 *  例:「組織区分　第１階層名」は空白入りのため、空白を無視して比較する。 */
function normHeader(h: string): string {
  return (h ?? '').replace(/[\s　]+/g, '');
}

/** 正規化済みヘッダ名で列値を引く。 */
function pick(row: Record<string, string>, headerNorm: string): string {
  for (const [k, v] of Object.entries(row)) {
    if (normHeader(k) === headerNorm) return (v ?? '').trim();
  }
  return '';
}

/** 部門リスト CSV の実データ行を返す。
 *  仕様: 1 行目 = ヘッダ、2 行目 = 列の意味 (コメント)、3 行目以降 = 値。
 *  parseCsv 済みの rows から先頭 1 行 (コメント行) を除いて返す。 */
export function dataRowsOfDeptCsv(parsed: ParsedCsv): Record<string, string>[] {
  return parsed.rows.slice(1);
}

/** サブドメイン + ドメインネーム を FQDN に結合する。
 *  - サブドメイン空 → ドメインネームのみ
 *  - サブドメインが既に FQDN 全体 (ドメインで終わる) ならそのまま */
export function joinFqdn(sub: string, domain: string): string {
  const s = normalizeAsset(sub);
  const d = normalizeAsset(domain);
  if (!d) return s;
  if (!s) return d;
  if (s === d || s.endsWith(`.${d}`)) return s;
  return `${s}.${d}`;
}

/** 突合ディレクトリ: FQDN → 管理部門情報。 */
export interface AssetDirEntry {
  mgmtNumber: string;
  businessCompany: string;
  affiliateCompany: string;
  /** 特定根拠 (どの CSV 行から特定したか)。 */
  evidence: string;
}

/**
 * 2 種の CSV から FQDN → 管理部門情報 のディレクトリを構築する。
 * @param baseInfo 基本情報 CSV (管理番号 / 組織区分 第１階層名 = 事業会社 /
 *                 関係会社/事業場略称 = 関連会社)
 * @param siteUrl  サイトURL情報 CSV (管理番号 / サブドメイン / ドメインネーム。
 *                 同一管理番号で複数行 = 複数 FQDN)
 */
export function buildAssetDirectory(baseInfo: ParsedCsv, siteUrl: ParsedCsv): Map<string, AssetDirEntry> {
  // 基本情報: 管理番号 → 会社情報
  const byMgmt = new Map<string, { businessCompany: string; affiliateCompany: string }>();
  for (const row of dataRowsOfDeptCsv(baseInfo)) {
    const no = pick(row, '管理番号');
    if (!no) continue;
    byMgmt.set(no, {
      businessCompany: pick(row, '組織区分第１階層名'),
      affiliateCompany: pick(row, '関係会社/事業場略称'),
    });
  }
  // サイトURL情報: FQDN → 管理番号 (→ 会社情報)
  const dir = new Map<string, AssetDirEntry>();
  for (const row of dataRowsOfDeptCsv(siteUrl)) {
    const no = pick(row, '管理番号');
    const fqdn = joinFqdn(pick(row, 'サブドメイン'), pick(row, 'ドメインネーム'));
    if (!no || !fqdn) continue;
    const company = byMgmt.get(no);
    dir.set(fqdn, {
      mgmtNumber: no,
      businessCompany: company?.businessCompany ?? '',
      affiliateCompany: company?.affiliateCompany ?? '',
      evidence: `サイトURL情報の FQDN 一致 (${fqdn} → 管理番号 ${no})`
        + (company ? '' : ' ※基本情報に該当する管理番号なし'),
    });
  }
  return dir;
}

/** 突合結果 1 件。 */
export interface AssetMatch {
  asset: ManagedAsset;
  patch: Partial<ManagedAsset>;
}

/** 資産一覧とディレクトリを突合し、更新プランを返す (一致した資産のみ)。 */
export function matchAssets(
  assets: ManagedAsset[],
  dir: Map<string, AssetDirEntry>,
  nowIso: string,
): AssetMatch[] {
  const out: AssetMatch[] = [];
  for (const a of assets) {
    const hit = dir.get(a.assetKey);
    if (!hit) continue;
    const patch: Partial<ManagedAsset> = {
      mgmtNumber: hit.mgmtNumber,
      businessCompany: hit.businessCompany,
      affiliateCompany: hit.affiliateCompany,
      identifyReason: '資産管理部門リスト CSV 突合',
      identifyEvidence: hit.evidence,
      updatedAt: nowIso,
    };
    // 変化が無ければスキップ (無駄な書き込みをしない)
    const changed = (['mgmtNumber', 'businessCompany', 'affiliateCompany'] as const)
      .some((k) => (a[k] ?? '') !== (patch[k] ?? ''));
    if (changed) out.push({ asset: a, patch });
  }
  return out;
}
