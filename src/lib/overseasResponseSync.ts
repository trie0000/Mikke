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
import { overseasKey } from './overseas';

// 突合キーは海外一覧と同じもの (定義は lib/overseas.ts に 1 本化)。
export { overseasKey };

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
  /** Mikke がこの内容を確認した日 (JST の暦日)。
   *  ★ 見る側が「最終検知日が動かない = 更新されていない」と誤解しないための欄。 */
  confirmedAt: string;
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
  confirmedAt: 'ConfirmedAt',
};

/** 列の種類 (schema.ts と一致させること)。 */
export const OVERSEAS_RESPONSE_KIND: Record<keyof OverseasResponseFields, 'text' | 'note' | 'date'> = {
  issueInstanceId: 'text', title: 'text', contactedAt: 'date', detectionStatus: 'text',
  region: 'text', businessCompany: 'text', affiliateCompany: 'text', webMapsId: 'text',
  identifyEvidence: 'note', assetIp: 'text', assetFqdn: 'text', assetTitle: 'text',
  assetMappedDomains: 'note', assetHomepageUrl: 'note', lastSeen: 'date', remarks: 'note',
  confirmedAt: 'date',
};

/** 日付列 (空文字ではなく null を送らないと SP が 400 を返す)。 */
export const OVERSEAS_RESPONSE_DATE_FIELDS: (keyof OverseasResponseFields)[] =
  ['contactedAt', 'lastSeen', 'confirmedAt'];

/** 海外連携用リストの既存アイテム。 */
export interface OverseasResponseRow extends OverseasResponseFields {
  id: number;
}

export interface OverseasResponsePlan {
  creates: OverseasResponseFields[];
  updates: { id: number; key: string; fields: Partial<OverseasResponseFields> }[];
  deletes: { id: number; key: string; reason: '対象外' | '一覧に無い' }[];
  /** 既にあり、内容も一致していた件数。 */
  unchanged: number;
}

const text = (v: unknown): string => (v === undefined || v === null ? '' : String(v)).trim();

/** 管理対象から外れているか (連携用リストから消す対象)。国内の isExcluded と同じ考え方。 */
export function isExcludedOverseas(issue: OverseasIssue): boolean {
  return !!issue.isOutOfScope;
}

/** 日付は日単位で比べる (時刻差で毎回差分にしない)。 */
function day(iso?: string): string {
  const s = text(iso);
  if (!s) return '';
  const t = new Date(s);
  return Number.isNaN(t.getTime()) ? '' : t.toISOString().slice(0, 10);
}

/**
 * クローズか (検査ツール上から消えている)。国内の isClosedDetection と同じ扱い。
 * ★ クローズした行は中身が動かないので、最終確認日を毎日書き足さない。
 */
export function isClosedOverseas(issue: OverseasIssue): boolean {
  return issue.detectionStatus === '未検出' || issue.detectionStatus === '未検出(New)';
}

/** 1 件分の書き込み内容を組み立てる。
 *  @param confirmedAt Mikke がこの内容を確認した日 (JST の暦日。省略時は空)。 */
export function toOverseasResponseFields(
  issue: OverseasIssue, confirmedAt = '',
): OverseasResponseFields {
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
    confirmedAt,
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
  /** 反映を実行した日時 (ISO)。最終確認日はこの **JST の暦日** で入れる。
   *  ★ 時刻まで持たせない。持たせると毎回すべての行に差分が出て全件書き込みになる。 */
  nowIso = '',
): OverseasResponsePlan {
  const keyOfIssue = (i: OverseasIssue) => overseasKey(i.issueInstanceId, i.region ?? '');
  const keyOfRow = (r: OverseasResponseRow) => overseasKey(r.issueInstanceId, r.region);
  if (scope) {
    issues = issues.filter((i) => scope.has(keyOfIssue(i)));
    existing = existing.filter((r) => scope.has(keyOfRow(r)));
  }
  const byKey = new Map(existing.filter((r) => text(r.issueInstanceId)).map((r) => [keyOfRow(r), r]));
  const asOf = jstDateOnly(nowIso);
  const plan: OverseasResponsePlan = { creates: [], updates: [], deletes: [], unchanged: 0 };
  const seen = new Set<string>();

  for (const issue of issues) {
    const iid = text(issue.issueInstanceId);
    if (!iid) continue;              // 突合キーが無いものは扱えない
    const key = keyOfIssue(issue);
    seen.add(key);
    const row = byKey.get(key);

    // ★ 管理対象から除外した行は連携用リストから消す。除外を解除すれば
    //   「リストに無い」状態になり、次の反映で作り直される (国内と同じ)。
    if (isExcludedOverseas(issue)) {
      if (row) plan.deletes.push({ id: row.id, key, reason: '対象外' });
      continue;
    }

    const fields = toOverseasResponseFields(issue, asOf);
    if (!row) { plan.creates.push(fields); continue; }

    // ★ 最終確認日は最後に決める (国内と同じ考え方)。
    const diff: Partial<OverseasResponseFields> = {};
    for (const k of Object.keys(fields) as (keyof OverseasResponseFields)[]) {
      // 突合キーは変えない。確認日は下で決める。
      if (k === 'issueInstanceId' || k === 'region' || k === 'confirmedAt') continue;
      const isDate = OVERSEAS_RESPONSE_DATE_FIELDS.includes(k);
      const a = isDate ? day(fields[k]) : text(fields[k]);
      const b = isDate ? day(row[k]) : text(row[k]);
      if (a !== b) diff[k] = fields[k];
    }
    // 他に変化があった日か、まだ検知中で日付が変わったときだけ書く。
    // クローズ (未検出系) で変化が無い行は書かない。
    const changed = Object.keys(diff).length > 0;
    const active = !isClosedOverseas(issue);
    if (asOf && day(asOf) !== day(row.confirmedAt) && (changed || active)) {
      diff.confirmedAt = asOf;
    }
    if (Object.keys(diff).length) plan.updates.push({ id: row.id, key, fields: diff });
    else plan.unchanged++;
  }

  // 海外一覧から消えたものはリストからも消す (SP 側は常に Mikke の写し)。
  for (const row of existing) {
    const key = keyOfRow(row);
    if (text(row.issueInstanceId) && !seen.has(key)) plan.deletes.push({ id: row.id, key, reason: '一覧に無い' });
  }
  return plan;
}
