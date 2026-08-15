// 連携用リストのアイテム単位アクセス権。
//
// ★ 方式は WebReg (src/perms.js) に合わせる:
//   - 管理者グループ … 全アイテムに **フルコントロール**
//   - 割当グループ   … その事業会社のアイテムに **投稿** (更新は参照を含むので分けない)
//   - 適用は「継承解除 → 先に付与 → 付与したもの以外を削除」の順。
//     先に付与するのが重要で、実行者の権限を消してから付与すると途中でアイテムを
//     見失って失敗する。
//   - 個別ユーザ権限は残さない (グループだけで構成)。ただし実行者がどの管理者
//     グループにも属していない場合だけは自分の権限を残す (ロックアウト防止の安全弁)。
//
// ★ 割当のキーは **事業会社**。連携用リストのアイテムは「連携リストへ反映」で
//   作り直されるので、行 ID に紐づけると割当が消える。アイテムが持つ値
//   (BusinessCompany) をキーにすれば作り直されても割当は残る。
//
// このファイルは UI にも SP にも依存しない (テストしやすくするため)。

/** 連携用リストのアクセス権設定 (共通設定に JSON で保存する)。 */
export interface VulnResponsePerms {
  /** 全アイテムにフルコントロールを付ける SP 権限グループ ID。 */
  adminGroupIds: number[];
  /** 事業会社名 → 投稿を付ける SP 権限グループ ID。 */
  byBusinessCompany: Record<string, number[]>;
  /** 事業会社名 → 略称。移行データ (Excel) は略称で書かれているので、
   *  取込のときにここから正式名を引く。1 社に複数の略称を持てる。 */
  aliasesByCompany: Record<string, string[]>;
}

export const EMPTY_PERMS: VulnResponsePerms = { adminGroupIds: [], byBusinessCompany: {}, aliasesByCompany: {} };

/** SP のサイト権限グループ。 */
export interface SiteGroup { id: number; title: string }

/** SP のロール定義 (必要な 3 つだけ)。 */
export interface PermRoles { read: number; edit: number; full: number }

const ids = (v: unknown): number[] =>
  Array.isArray(v) ? [...new Set(v.map(Number).filter((n) => Number.isInteger(n) && n > 0))] : [];

/** 保存済み JSON を安全な形に整える (壊れていても落とさない)。 */
export function normalizePerms(v: unknown): VulnResponsePerms {
  const o = (v ?? {}) as Record<string, unknown>;
  const byCompany: Record<string, number[]> = {};
  const src = (o.byBusinessCompany ?? {}) as Record<string, unknown>;
  if (src && typeof src === 'object') {
    for (const [company, list] of Object.entries(src)) {
      const name = String(company).trim();
      // ★ 割当が空でもキーは残す。一括登録した事業会社は「登録済み・割当なし」
      //   という状態を持つ (消すと画面から消えて登録し直しになる)。
      if (name) byCompany[name] = ids(list);
    }
  }
  // 略称は登録済みの事業会社にひもづくものだけ持つ (会社を消したら略称も消える)。
  const aliases: Record<string, string[]> = {};
  const asrc = (o.aliasesByCompany ?? {}) as Record<string, unknown>;
  if (asrc && typeof asrc === 'object') {
    for (const [company, list] of Object.entries(asrc)) {
      const name = String(company).trim();
      if (!name || !(name in byCompany)) continue;
      const arr = Array.isArray(list)
        ? [...new Set(list.map((x) => String(x ?? '').trim()).filter(Boolean))] : [];
      if (arr.length) aliases[name] = arr;
    }
  }
  return { adminGroupIds: ids(o.adminGroupIds), byBusinessCompany: byCompany, aliasesByCompany: aliases };
}

/** その事業会社の略称。 */
export function aliasesFor(company: string, p: VulnResponsePerms): string[] {
  return p.aliasesByCompany[String(company ?? '').trim()] ?? [];
}

/** 入力欄 (カンマ / 読点 / 改行区切り) を略称の配列にする。 */
export function parseAliases(text: string): string[] {
  return [...new Set(String(text ?? '').split(/[,、\n]/).map((s) => s.trim()).filter(Boolean))];
}

/** 何か設定されているか (未設定なら権限適用そのものを行わない)。
 *  ★ 事業会社を登録しただけ (割当なし) では適用しない。管理者グループが無いまま
 *    継承を解除すると、誰も見られないアイテムができる。 */
export function hasAnyPerms(p: VulnResponsePerms): boolean {
  // ★ 管理者グループが必須。ここを「事業会社の割当だけでも可」にしていたため、
  //   管理者グループ未設定のまま継承を解除し、**管理者に権限が付かない**
  //   アイテムができていた (実際に踏んだ)。
  return p.adminGroupIds.length > 0;
}

/** 一括登録された事業会社 (割当の有無を問わない)。画面の一覧に出す順。 */
/**
 * 事業会社の選択肢に **常に出す枠**。
 *
 * ★ 移行データ (Excel) にこの表記で書かれている行は、略称として解決しようとせず
 *   **そのまま** 登録する。どこの会社か分からない行をまとめて「その他」に寄せると、
 *   「他社の資産と分かっている行」と「判定できなかった行」が混ざって区別できなくなる。
 * ★ 選択肢にも出すので、一覧や明細から後から選び直せる。アクセス権の割当は
 *   他の事業会社と同じで、アクセス権画面で割り当てる (未割当なら管理者だけが見られる)。
 */
export const BUILTIN_COMPANIES = ['他社', '不明'] as const;

/** その値が常設の枠か (前後の空白は無視。表記は一致させる)。 */
export function asBuiltinCompany(v: unknown): string | null {
  const s = String(v ?? '').trim();
  return (BUILTIN_COMPANIES as readonly string[]).find((b) => b === s) ?? null;
}

/** 事業会社の選択肢 (登録済み + 常設の枠)。 */
export function registeredCompanies(p: VulnResponsePerms): string[] {
  const set = new Set([...Object.keys(p.byBusinessCompany), ...BUILTIN_COMPANIES]);
  return [...set].sort((a, b) => a.localeCompare(b, 'ja'));
}

/**
 * 一括入力 (1 行 1 件) を事業会社名の配列にする。
 * Excel から貼り付けられるよう、タブ区切りは先頭列だけを使う。
 * 空行・重複は落とし、順序は入力順を保つ。
 */
export function parseCompanyList(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const name = (line.split('\t')[0] ?? '').trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

/** 一括登録の結果を既存の割当にマージする。既存の割当は消さない。 */
export function mergeCompanies(p: VulnResponsePerms, names: string[]): VulnResponsePerms {
  const next: Record<string, number[]> = {};
  for (const name of names) next[name] = p.byBusinessCompany[name] ?? [];
  const aliases: Record<string, string[]> = {};
  for (const name of names) if (p.aliasesByCompany[name]) aliases[name] = p.aliasesByCompany[name]!;
  return { adminGroupIds: [...p.adminGroupIds], byBusinessCompany: next, aliasesByCompany: aliases };
}

/** その事業会社に割り当てられたグループ。未設定なら空 (= 管理者だけが見られる)。 */
export function groupIdsFor(businessCompany: string, p: VulnResponsePerms): number[] {
  return p.byBusinessCompany[String(businessCompany ?? '').trim()] ?? [];
}

/**
 * SP のロール定義から使う 3 つを選ぶ。
 * RoleTypeKind: 2=読み取り / 3=投稿 (無ければ 6=編集) / 5=フルコントロール。
 */
export function pickRoles(defs: { Id: number; RoleTypeKind: number }[]): PermRoles {
  const byKind = (k: number): number | undefined => defs.find((d) => d.RoleTypeKind === k)?.Id;
  const read = byKind(2);
  const edit = byKind(3) ?? byKind(6);
  const full = byKind(5);
  if (!read || !edit || !full) {
    throw new Error('サイトのロール定義 (読み取り / 投稿 / フルコントロール) を取得できません');
  }
  return { read, edit, full };
}

/** 1 アイテムに付与する内容。 */
export interface ItemPermPlan {
  id: number;
  businessCompany: string;
  /** フルコントロールを付けるグループ (管理者)。 */
  full: number[];
  /** 投稿を付けるグループ (事業会社の割当)。管理者と重複するものは除く。 */
  edit: number[];
}

/**
 * アイテムごとの付与内容を組み立てる。
 * ★ 同じグループに 2 つのロールを付けない。SP は後勝ちにならず、
 *   フルコントロールを付けた直後に投稿を付けると権限が下がる。
 */
export function buildItemPermPlan(
  items: { id: number; businessCompany: string }[],
  p: VulnResponsePerms,
): ItemPermPlan[] {
  const admin = [...new Set(p.adminGroupIds)];
  const adminSet = new Set(admin);
  return items.map((it) => ({
    id: it.id,
    businessCompany: it.businessCompany,
    full: admin,
    edit: groupIdsFor(it.businessCompany, p).filter((g) => !adminSet.has(g)),
  }));
}

/** 事業会社ごとの割当を作るとき、画面に出す候補 (実データにある値 + 割当済みの値)。 */
export function companyChoices(inUse: string[], p: VulnResponsePerms): string[] {
  const set = new Set<string>();
  for (const c of inUse) { const s = String(c ?? '').trim(); if (s) set.add(s); }
  for (const c of Object.keys(p.byBusinessCompany)) set.add(c);
  return [...set].sort((a, b) => a.localeCompare(b, 'ja'));
}

/** 割当が 1 つも無い事業会社 (= 管理者しか見られない)。画面で注意を出すために使う。 */
export function companiesWithoutGroups(inUse: string[], p: VulnResponsePerms): string[] {
  return companyChoices(inUse, p).filter((c) => groupIdsFor(c, p).length === 0);
}
