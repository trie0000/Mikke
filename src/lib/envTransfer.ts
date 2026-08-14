// 開発環境 ↔ 本番環境 の設定の持ち運び。
//
// ★ いちばん大事な点: **SharePoint グループの ID はサイトごとに違う**。
//   アクセス権の設定は `{ 事業会社: [12, 13] }` のようにグループ ID で持っているので、
//   ID のまま別サイトへ写すと **別のグループに権限が付く**。事故になる。
//   そのため、持ち出すときに ID → グループ名 へ、持ち込むときに グループ名 → ID へ
//   移送先のサイトで引き直す。引けない名前は名指しで報告して、黙って落とさない。
//
// ★ 抽出条件 (管理項目・管理対象条件・個別指定・資産列・脆弱性タイプ判定) は
//   サイトに依存しないのでそのまま写せる。
//
// UI にも SP にも依存しない (テストしやすくするため)。
import type { MikkeSettings } from '../types';
import { normalizePerms } from './itemPerms';
import { normalizeAliasRemap } from './migration';

/** 持ち運ぶ単位。画面のチェックボックスと 1:1。 */
export type TransferPart = 'extraction' | 'perms';

export const PART_LABEL: Record<TransferPart, string> = {
  extraction: '抽出条件',
  perms: 'アクセス権',
};

/** 「抽出条件」に含める設定キー。サイトに依存しない値だけを入れる。 */
export const EXTRACTION_KEYS = [
  'managedColumns', 'columnTypes', 'matchConditions', 'individualIds',
  'assetColumns', 'assetColumn', 'vulnTypeRules',
] as const;

/**
 * 環境をまたいで運ぶ内容。
 * ★ グループは **名前** で持つ (ID はサイトごとに違うため)。
 */
export interface EnvBundle {
  /** 形式の版。読み込み側が古い/新しい形式を判別する。 */
  version: 1;
  /** 書き出した日時 (ISO)。 */
  exportedAt: string;
  /** 書き出し元のサイト URL (取り違え防止のため画面に出す)。 */
  sourceSite: string;
  extraction?: Partial<MikkeSettings>;
  perms?: {
    /** 管理者グループの **名前**。 */
    adminGroups: string[];
    /** 事業会社 → グループ **名** の配列。 */
    byBusinessCompany: Record<string, string[]>;
    /** 事業会社 → 略称。 */
    aliasesByCompany: Record<string, string[]>;
    /** データ移行の旧略称の読み替え (事業会社の対応表と一緒に運ぶ)。 */
    aliasRemap: { to: string; from: string[] }[];
  };
}

export interface SiteGroup { id: number; title: string }

const text = (v: unknown): string => (v === undefined || v === null ? '' : String(v)).trim();

/** 設定 → 持ち出す内容。グループ ID は名前に置き換える。 */
export function toBundle(
  settings: MikkeSettings,
  groups: SiteGroup[],
  parts: TransferPart[],
  sourceSite: string,
  nowIso: string,
): EnvBundle {
  const nameById = new Map(groups.map((g) => [g.id, g.title]));
  const bundle: EnvBundle = { version: 1, exportedAt: nowIso, sourceSite };

  if (parts.includes('extraction')) {
    const e: Partial<MikkeSettings> = {};
    for (const k of EXTRACTION_KEYS) {
      const v = (settings as unknown as Record<string, unknown>)[k];
      if (v !== undefined) (e as Record<string, unknown>)[k] = v;
    }
    bundle.extraction = e;
  }

  if (parts.includes('perms')) {
    const p = normalizePerms(settings.vulnResponsePerms);
    // ★ 引けなかった ID は落とす。名前が分からないものを持ち込んでも当てられない。
    const names = (ids: number[]): string[] =>
      [...new Set(ids.map((id) => nameById.get(id)).filter((t): t is string => !!t))];
    bundle.perms = {
      adminGroups: names(p.adminGroupIds),
      byBusinessCompany: Object.fromEntries(
        Object.entries(p.byBusinessCompany).map(([c, ids]) => [c, names(ids)]),
      ),
      aliasesByCompany: { ...(p.aliasesByCompany ?? {}) },
      aliasRemap: normalizeAliasRemap(settings.migrationAliasRemap),
    };
  }
  return bundle;
}

/** 持ち出した内容のうち、名前を引けなかったグループ ID (画面に出して気づかせる)。 */
export function unresolvedGroupIds(settings: MikkeSettings, groups: SiteGroup[]): number[] {
  const known = new Set(groups.map((g) => g.id));
  const p = normalizePerms(settings.vulnResponsePerms);
  const all = [...p.adminGroupIds, ...Object.values(p.byBusinessCompany).flat()];
  return [...new Set(all.filter((id) => !known.has(id)))].sort((a, b) => a - b);
}

export interface ApplyResult {
  /** 反映後の設定 (まだ保存はしていない)。 */
  settings: MikkeSettings;
  /** 移送先に無かったグループ名。権限が付かないので必ず画面に出す。 */
  missingGroups: string[];
  /** 実際に変わる項目 (プレビュー用。「項目名: 変更前 → 変更後」)。 */
  changes: { field: string; before: string; after: string }[];
}

/** 持ち込む内容を移送先の設定に反映する。グループ名は移送先の ID に引き直す。 */
export function applyBundle(
  current: MikkeSettings,
  bundle: EnvBundle,
  groups: SiteGroup[],
  parts: TransferPart[],
): ApplyResult {
  // ★ 大文字小文字・前後空白の違いで引けないことがあるので、揃えてから引く。
  const idByName = new Map(groups.map((g) => [g.title.trim().toLowerCase(), g.id]));
  const next: MikkeSettings = { ...current };
  const missing = new Set<string>();
  const changes: { field: string; before: string; after: string }[] = [];
  const show = (v: unknown): string => {
    if (v === undefined || v === null) return '(未設定)';
    if (Array.isArray(v)) return v.length ? `${v.length} 件` : '(なし)';
    if (typeof v === 'object') return `${Object.keys(v as object).length} 件`;
    return String(v);
  };
  const put = (field: string, before: unknown, after: unknown): void => {
    const a = JSON.stringify(before ?? null);
    const b = JSON.stringify(after ?? null);
    if (a === b) return;
    changes.push({ field, before: show(before), after: show(after) });
  };

  if (parts.includes('extraction') && bundle.extraction) {
    for (const k of EXTRACTION_KEYS) {
      const v = (bundle.extraction as Record<string, unknown>)[k];
      if (v === undefined) continue;
      put(k, (current as unknown as Record<string, unknown>)[k], v);
      (next as unknown as Record<string, unknown>)[k] = v;
    }
  }

  if (parts.includes('perms') && bundle.perms) {
    const ids = (names: string[]): number[] => {
      const out: number[] = [];
      for (const n of names) {
        const id = idByName.get(text(n).toLowerCase());
        if (id === undefined) { missing.add(n); continue; }
        if (!out.includes(id)) out.push(id);
      }
      return out;
    };
    const perms = {
      adminGroupIds: ids(bundle.perms.adminGroups),
      byBusinessCompany: Object.fromEntries(
        Object.entries(bundle.perms.byBusinessCompany).map(([c, names]) => [c, ids(names)]),
      ),
      aliasesByCompany: { ...bundle.perms.aliasesByCompany },
    };
    put('vulnResponsePerms', current.vulnResponsePerms, perms);
    put('migrationAliasRemap', current.migrationAliasRemap, bundle.perms.aliasRemap);
    next.vulnResponsePerms = perms;
    next.migrationAliasRemap = bundle.perms.aliasRemap;
  }

  return { settings: next, missingGroups: [...missing].sort((a, b) => a.localeCompare(b, 'ja')), changes };
}

/** 保存値が壊れていても落ちないように整える (ファイル読み込み用)。 */
export function normalizeBundle(v: unknown): EnvBundle | null {
  const o = (v ?? {}) as Record<string, unknown>;
  if (o.version !== 1) return null;
  const b: EnvBundle = {
    version: 1,
    exportedAt: text(o.exportedAt),
    sourceSite: text(o.sourceSite),
  };
  if (o.extraction && typeof o.extraction === 'object') b.extraction = o.extraction as Partial<MikkeSettings>;
  const p = o.perms as Record<string, unknown> | undefined;
  if (p && typeof p === 'object') {
    const strs = (x: unknown): string[] =>
      Array.isArray(x) ? [...new Set(x.map((s) => text(s)).filter(Boolean))] : [];
    const rec = (x: unknown): Record<string, string[]> => {
      const out: Record<string, string[]> = {};
      if (x && typeof x === 'object') {
        for (const [k, val] of Object.entries(x as Record<string, unknown>)) {
          const key = text(k);
          if (key) out[key] = strs(val);
        }
      }
      return out;
    };
    b.perms = {
      adminGroups: strs(p.adminGroups),
      byBusinessCompany: rec(p.byBusinessCompany),
      aliasesByCompany: rec(p.aliasesByCompany),
      aliasRemap: normalizeAliasRemap(p.aliasRemap),
    };
  }
  return b;
}

/**
 * 2 つのサイト URL が同じオリジンか。
 * ★ 同じテナント内なら fetch で直接読み書きできる。別テナント (別オリジン) は
 *   ブラウザが遮るので、ファイル経由でしか運べない。
 */
export function sameOrigin(a: string, b: string): boolean {
  try { return new URL(a).origin.toLowerCase() === new URL(b).origin.toLowerCase(); }
  catch { return false; }
}

/** ファイル名 (書き出し時)。 */
export function bundleFileName(parts: TransferPart[], nowIso: string): string {
  const stamp = nowIso.replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');
  return `mikke-settings-${parts.join('+')}-${stamp}.json`;
}
