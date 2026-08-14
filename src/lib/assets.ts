// 資産管理 (FQDN / IP 単位) のコアロジック。
//   - 脆弱性 (ManagedIssues) から資産キーを抽出してユニーク化
//   - 社内の資産管理部門リスト CSV (基本情報 / サイトURL情報) を突合して
//     事業会社・関連会社・管理番号を特定する
// UI 非依存の純関数。テストは test/assets.test.ts。
import type { ManagedIssue, ManagedAsset } from '../types';
import type { ParsedCsv } from './csv';
import { resolveScanValue } from './scanName';

/** 既定の資産列名 (脆弱性 CSV 内で FQDN/IP が入っている列)。 */
export const DEFAULT_ASSET_COLUMN = 'Asset';

/**
 * Excel からの移行が資産を書き込む列。
 * ★ 移行は IP/URL 列の値をここへ入れる (lib/migration.ts)。設定の資産列は
 *   検査ツール CSV の列名なので、移行しかしていない環境では 1 つも一致せず、
 *   **連携用リストの IP / FQDN が空のまま**になっていた。設定に関係なく必ず見る。
 */
export const MIGRATION_ASSET_COLUMNS = ['Asset IP', 'Asset Domain'];

/** 設定の資産列 + 移行が書く列 (重複なし)。資産キーの取り出しはここを見る。 */
export function assetSourceColumns(configured: string[]): string[] {
  return [...new Set([...configured, ...MIGRATION_ASSET_COLUMNS])];
}

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

/** 1 セルから資産キーを取り出す。1 セルに複数値が入っている場合の区切りは
 *  パイプ(|) / カンマ / セミコロン / 空白 に対応 (管理対象一覧では | 区切りが多い)。 */
export function splitAssetCell(cell: string): string[] {
  return (cell ?? '')
    .split(/[|,;\s]+/)
    .map((x) => normalizeAsset(x))
    .filter(Boolean);
}

/** 1 脆弱性・指定列群から資産キー集合 (この脆弱性に紐づく資産) を取り出す。 */
function assetKeysOfIssue(issue: ManagedIssue, columns: string[]): string[] {
  const set = new Set<string>();
  for (const col of assetSourceColumns(columns)) {
    const key = col.startsWith('Scan_') ? col : `Scan_${col}`;
    const cell = resolveScanValue(issue.scanFields, key, []) ?? '';
    for (const k of splitAssetCell(cell)) set.add(k);
  }
  return [...set];
}

/** 脆弱性ごとの資産グループ (同一脆弱性に紐づく資産キー群)。伝播判定に使う。 */
export interface IssueAssetGroup {
  /** 脆弱性の識別子 (Issue Instance ID)。根拠文言に使う。 */
  iid: string;
  /** この脆弱性に紐づく資産キー (正規化済み・ユニーク)。 */
  keys: string[];
}

/** 脆弱性一覧から、ユニーク資産キーと脆弱性ごとのグループを抽出する。
 *  columns: 資産が入っている列 (複数可。例: FQDN 列 + IP 列)。 */
export function extractAssets(
  issues: ManagedIssue[],
  columns: string[],
): { keys: string[]; groups: IssueAssetGroup[] } {
  const all = new Set<string>();
  const groups: IssueAssetGroup[] = [];
  for (const issue of issues) {
    const keys = assetKeysOfIssue(issue, columns);
    if (!keys.length) continue;
    groups.push({ iid: issue.issueInstanceId || String(issue.id), keys });
    for (const k of keys) all.add(k);
  }
  return { keys: [...all], groups };
}

/** 資産ごとの脆弱性件数 (assetKey → 件数。同一脆弱性内の重複は 1 件)。 */
export function countIssuesByAsset(
  issues: ManagedIssue[],
  columns: string[],
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const issue of issues) {
    for (const k of assetKeysOfIssue(issue, columns)) out[k] = (out[k] ?? 0) + 1;
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
  /** 特定の仕方 (プレビュー表示用。永続化しない)。 */
  via: 'direct' | 'propagated';
}

/**
 * 資産一覧とディレクトリを突合し、更新プランを返す (一致・伝播した資産のみ)。
 *
 * 2 段階で特定する:
 *  1) 直接一致: 資産キー(FQDN) が部門ディレクトリに存在 → その会社/管理番号を記載。
 *  2) 伝播: 同一脆弱性に紐づく資産グループ (groups) の中で、どれか 1 つでも直接
 *     一致していれば、同グループの他の資産 (IP など単体では特定できないもの) にも
 *     同じ事業会社・関連会社・管理番号を記載し、根拠に「同一脆弱性に紐づく」旨を残す。
 *
 * @param groups 脆弱性ごとの資産グループ (extractAssets の戻り値)。省略時は伝播なし。
 */
export function matchAssets(
  assets: ManagedAsset[],
  dir: Map<string, AssetDirEntry>,
  nowIso: string,
  groups: IssueAssetGroup[] = [],
): AssetMatch[] {
  // 1) 直接一致 (assetKey → 部門エントリ)
  const direct = new Map<string, AssetDirEntry>();
  for (const a of assets) {
    const hit = dir.get(a.assetKey);
    if (hit) direct.set(a.assetKey, hit);
  }

  // 2) 伝播 (assetKey → 由来: どの脆弱性のどの一致資産から引き継いだか)。先勝ち。
  const propagated = new Map<string, { entry: AssetDirEntry; viaKey: string; iid: string }>();
  for (const g of groups) {
    const matchedKey = g.keys.find((k) => direct.has(k));
    if (!matchedKey) continue;
    const entry = direct.get(matchedKey)!;
    for (const k of g.keys) {
      if (k === matchedKey || direct.has(k) || propagated.has(k)) continue;
      propagated.set(k, { entry, viaKey: matchedKey, iid: g.iid });
    }
  }

  const out: AssetMatch[] = [];
  for (const a of assets) {
    let patch: Partial<ManagedAsset> | null = null;
    let via: 'direct' | 'propagated' = 'direct';
    const hit = direct.get(a.assetKey);
    if (hit) {
      patch = {
        mgmtNumber: hit.mgmtNumber,
        businessCompany: hit.businessCompany,
        affiliateCompany: hit.affiliateCompany,
        // 特定理由は「特定根拠」に統合 (先頭に理由、続けて根拠を併記)。
        identifyEvidence: `資産管理部門リスト CSV 突合: ${hit.evidence}`,
        updatedAt: nowIso,
      };
    } else {
      const p = propagated.get(a.assetKey);
      if (p) {
        via = 'propagated';
        patch = {
          mgmtNumber: p.entry.mgmtNumber,
          businessCompany: p.entry.businessCompany,
          affiliateCompany: p.entry.affiliateCompany,
          identifyEvidence: `同一脆弱性の関連資産から特定: 同一脆弱性(${p.iid})で検出された ${p.viaKey}`
            + (p.entry.mgmtNumber ? ` (管理番号 ${p.entry.mgmtNumber})` : '')
            + ' と同一資産群のため',
          updatedAt: nowIso,
        };
      }
    }
    if (!patch) continue;
    // 変化が無ければスキップ (無駄な書き込みをしない)
    const changed = (['mgmtNumber', 'businessCompany', 'affiliateCompany'] as const)
      .some((k) => (a[k] ?? '') !== (patch![k] ?? ''));
    if (changed) out.push({ asset: a, patch, via });
  }
  return out;
}
