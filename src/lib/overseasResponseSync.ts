// 海外脆弱性一覧 → 海外拠点への連携用リスト への反映。
//
// ★ 国内の連携用リスト (vulnResponseSync.ts) との違い
//   - リストは **別物** (LIST_OVERSEAS_RESPONSE)。国内と混ぜない。
//   - 海外拠点に記入してもらう欄は **無い** (読み取り専用)。よって
//     「記入欄には触れない」という配慮が要らず、Mikke の値を全部書く。
//   - 逆取り込みもしない。SP 側は常に Mikke の写しになる。
//
// ★ 突合キーは Issue Instance ID **だけでは足りない**。同じ脆弱性が複数の地域に
//   通知されることがあり、海外一覧も (Issue Instance ID, 地域) で 1 行になる。
//   キーを IID だけにすると地域どうしが上書き合戦になるため、両方でキーにする。
//
// このファイルは UI にも SP にも依存しない (テストしやすくするため)。
import type { OverseasIssue } from '../types';
import { fitSingleLine, jstDateOnly } from './vulnResponseSync';

/** 海外連携用リストに Mikke が書き込む項目。 */
export interface OverseasResponseFields {
  issueInstanceId: string;
  title: string;
  contactedAt: string;
  detectionStatus: string;
  region: string;
  businessCompany: string;
  affiliateCompany: string;
  webMapsId: string;
  identifyEvidence: string;
  assetIp: string;
  assetFqdn: string;
  assetTitle: string;
  assetMappedDomains: string;
  assetHomepageUrl: string;
  lastSeen: string;
  remarks: string;
}

/** OverseasResponseFields のキー → SP 列名 (内部名)。
 *  ★ sp/schema.ts の overseasResponseFieldSpecs() とズレると、SP に無い列を
 *    送って全件 400 になる。突合は test/overseasResponseSync.test.ts で検査。 */
export const OVERSEAS_RESPONSE_COLUMN: Record<keyof OverseasResponseFields, string> = {
  // 突合キーの片方は組込みの Title 列 (ビューの既定リンク列)。
  issueInstanceId: 'Title',
  title: 'VulnTitle',
  contactedAt: 'ContactedAt',
  detectionStatus: 'DetectionStatus',
  region: 'Region',
  businessCompany: 'BusinessCompany',
  affiliateCompany: 'AffiliateCompany',
  webMapsId: 'WebMapsId',
  identifyEvidence: 'IdentifyEvidence',
  assetIp: 'AssetIp',
  assetFqdn: 'AssetFqdn',
  assetTitle: 'AssetTitle',
  assetMappedDomains: 'AssetMappedDomains',
  assetHomepageUrl: 'AssetHomepageUrl',
  lastSeen: 'LastSeen',
  remarks: 'Remarks',
};

/** 列の種類 (schema.ts と一致させること)。 */
export const OVERSEAS_RESPONSE_KIND: Record<keyof OverseasResponseFields, 'text' | 'note' | 'date'> = {
  issueInstanceId: 'text', title: 'text', contactedAt: 'date', detectionStatus: 'text',
  region: 'text', businessCompany: 'text', affiliateCompany: 'text', webMapsId: 'text',
  identifyEvidence: 'note', assetIp: 'text', assetFqdn: 'text', assetTitle: 'text',
  assetMappedDomains: 'note', assetHomepageUrl: 'note', lastSeen: 'date', remarks: 'note',
};

/** 日付列 (空文字ではなく null を送らないと SP が 400 を返す)。 */
export const OVERSEAS_RESPONSE_DATE_FIELDS: (keyof OverseasResponseFields)[] = ['contactedAt', 'lastSeen'];

/** 海外連携用リストの既存アイテム。 */
export interface OverseasResponseRow extends OverseasResponseFields {
  id: number;
}

export interface OverseasResponsePlan {
  creates: OverseasResponseFields[];
  updates: { id: number; key: string; fields: Partial<OverseasResponseFields> }[];
  deletes: { id: number; key: string }[];
  /** 既にあり、内容も一致していた件数。 */
  unchanged: number;
}

const text = (v: unknown): string => (v === undefined || v === null ? '' : String(v)).trim();

/** 日付は日単位で比べる (時刻差で毎回差分にしない)。 */
function day(iso?: string): string {
  const s = text(iso);
  if (!s) return '';
  const t = new Date(s);
  return Number.isNaN(t.getTime()) ? '' : t.toISOString().slice(0, 10);
}

/** 突合キー。(Issue Instance ID, 地域) の組。 */
export function overseasKey(iid: string, region: string): string {
  return `${text(iid)}\u0000${text(region)}`;
}

/** 1 件分の書き込み内容を組み立てる。 */
export function toOverseasResponseFields(issue: OverseasIssue): OverseasResponseFields {
  const raw: OverseasResponseFields = {
    issueInstanceId: text(issue.issueInstanceId),
    title: text(issue.title),
    contactedAt: jstDateOnly(issue.contactedAt),
    detectionStatus: text(issue.detectionStatus),
    region: text(issue.region),
    businessCompany: text(issue.businessCompany),
    affiliateCompany: text(issue.affiliateCompany),
    webMapsId: text(issue.webMapsId),
    identifyEvidence: text(issue.identifyEvidence),
    assetIp: text(issue.assetIp),
    assetFqdn: text(issue.assetFqdn),
    assetTitle: text(issue.assetTitle),
    assetMappedDomains: text(issue.assetMappedDomains),
    assetHomepageUrl: text(issue.assetHomepageUrl),
    lastSeen: jstDateOnly(issue.lastSeen),
    remarks: text(issue.remarks),
  };
  // 単一行テキスト列は 255 文字・改行なしに収める (超えると SP が 500 を返す)。
  const out = { ...raw };
  for (const k of Object.keys(out) as (keyof OverseasResponseFields)[]) {
    if (OVERSEAS_RESPONSE_KIND[k] === 'text') out[k] = fitSingleLine(out[k]);
  }
  return out;
}

/**
 * 海外一覧と海外連携用リストを突合し、追加 / 更新 / 削除の計画を組み立てる。
 *
 * @param scope 指定すると、この突合キー (overseasKey) だけを対象にする (選択分の反映)。
 *   ★ 範囲外の既存アイテムは一切触らない。絞ったまま「一覧に無い」判定をすると
 *     リストのほとんどを消してしまうため、削除の走査も範囲内に限る。
 */
export function buildOverseasResponsePlan(
  issues: OverseasIssue[],
  existing: OverseasResponseRow[],
  scope?: Set<string>,
): OverseasResponsePlan {
  const keyOfIssue = (i: OverseasIssue) => overseasKey(i.issueInstanceId, i.region ?? '');
  const keyOfRow = (r: OverseasResponseRow) => overseasKey(r.issueInstanceId, r.region);
  if (scope) {
    issues = issues.filter((i) => scope.has(keyOfIssue(i)));
    existing = existing.filter((r) => scope.has(keyOfRow(r)));
  }
  const byKey = new Map(existing.filter((r) => text(r.issueInstanceId)).map((r) => [keyOfRow(r), r]));
  const plan: OverseasResponsePlan = { creates: [], updates: [], deletes: [], unchanged: 0 };
  const seen = new Set<string>();

  for (const issue of issues) {
    const iid = text(issue.issueInstanceId);
    if (!iid) continue;              // 突合キーが無いものは扱えない
    const key = keyOfIssue(issue);
    seen.add(key);
    const row = byKey.get(key);
    const fields = toOverseasResponseFields(issue);
    if (!row) { plan.creates.push(fields); continue; }

    const diff: Partial<OverseasResponseFields> = {};
    for (const k of Object.keys(fields) as (keyof OverseasResponseFields)[]) {
      if (k === 'issueInstanceId' || k === 'region') continue;   // 突合キーは変えない
      const isDate = OVERSEAS_RESPONSE_DATE_FIELDS.includes(k);
      const a = isDate ? day(fields[k]) : text(fields[k]);
      const b = isDate ? day(row[k]) : text(row[k]);
      if (a !== b) diff[k] = fields[k];
    }
    if (Object.keys(diff).length) plan.updates.push({ id: row.id, key, fields: diff });
    else plan.unchanged++;
  }

  // 海外一覧から消えたものはリストからも消す (SP 側は常に Mikke の写し)。
  for (const row of existing) {
    const key = keyOfRow(row);
    if (text(row.issueInstanceId) && !seen.has(key)) plan.deletes.push({ id: row.id, key });
  }
  return plan;
}
