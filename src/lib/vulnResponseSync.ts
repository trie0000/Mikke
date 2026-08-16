// Mikke の管理対象一覧 → 資産管理者への連携用リスト への反映。
//
// ★ 書き分けの原則
//   - Mikke が持つ情報 (脆弱性・資産) だけを書く。
//     資産管理者が記入する 対応状況 / 対応者 / 対応期日 / 対応経緯 / 備考 には触らない。
//   - 値が変わるものだけ更新する (毎回全件書き込むと、資産管理者側の更新時刻が
//     動いて「通知」列の判定が濁る)。
//   - 管理対象外にしたものは連携用リストから削除する。対象外を解除すれば
//     「連携用リストに無い」状態になり、次の反映で作り直される。
import type { ManagedIssue, ManagedAsset } from '../types';

/** 連携用リストに Mikke が書き込む項目。 */
export interface VulnResponseFields {
  issueInstanceId: string;
  title: string;
  legacyMgmtNumber: string;
  detectionStatus: string;
  firstSeen: string;
  lastSeen: string;
  assetIp: string;
  assetFqdn: string;
  assetType: string;
  businessCompany: string;
  affiliateCompany: string;
  assetMgmtId: string;
  relatedAssets: string;
  identifyEvidence: string;
  /** 脆弱性レポート (PDF) の SP 上のサーバ相対 URL。空なら未取得。 */
  reportUrl: string;
  /** Mikke がこの内容を確認した日 (JST の暦日)。
   *  ★ 見る側が「最終検知日が動かない = 更新されていない」と誤解しないための欄。
   *    最終検知日と並べて「8/16 に確認した / 検知は 7/31 のまま」と読める。 */
  confirmedAt: string;

  // ── 資産管理者が記入する欄 (既定では書かない) ──────────────────────────────
  // ★ ここは全部 任意 (?) にしてある。値が入っているときだけ body に載るので、
  //   上書きを選ばなければ資産管理者の記入内容には一切触れない。
  //   Excel から移行した内容をリスト側へ載せたいときだけ ON にする。
  /** 対応状況 (Mikke 側の mgmtStatus)。 */
  responseStatus?: string;
  /** 対応期日 (Mikke 側の dueDate)。 */
  responseDueDate?: string;
  /** 外部接続申請ID。 */
  extConnAppId?: string;
  /** 対応状況 (自由記入。旧 対応計画/対応経緯/完了理由)。 */
  responsePlan?: string;
  /** 外部接続申請不要の理由。 */
  noAppReason?: string;
  /** 備考。 */
  responseRemarks?: string;
}

/** VulnResponseFields のキー → 連携用リストの SP 列名 (内部名)。
 *  ★ ここと sp/schema.ts の vulnResponseFieldSpecs() がズレると、SP に無い列を
 *    送ることになり **1 件ごと 400 = 反映が全件失敗** する。突合は
 *    test/vulnResponseSync.test.ts で検査している。 */
export const VULNRESPONSE_COLUMN: Record<keyof VulnResponseFields, string> = {
  // ★ 突合キーは SharePoint 組込みの Title 列に入れる (ビューの既定リンク列)。
  issueInstanceId: 'Title',
  title: 'VulnTitle',
  legacyMgmtNumber: 'LegacyMgmtNumber',
  detectionStatus: 'DetectionStatus',
  firstSeen: 'FirstSeen',
  lastSeen: 'LastSeen',
  assetIp: 'AssetIp',
  assetFqdn: 'AssetFqdn',
  assetType: 'AssetType',
  businessCompany: 'BusinessCompany',
  affiliateCompany: 'AffiliateCompany',
  assetMgmtId: 'AssetMgmtId',
  relatedAssets: 'RelatedAssets',
  identifyEvidence: 'IdentifyEvidence',
  reportUrl: 'ReportUrl',
  confirmedAt: 'ConfirmedAt',
  responseStatus: 'ResponseStatus',
  responseDueDate: 'DueDate',
  extConnAppId: 'ExtConnAppId',
  responsePlan: 'ResponsePlan',
  noAppReason: 'NoAppReason',
  responseRemarks: 'Remarks',
};

/**
 * 検知日を **JST の暦日** に直して返す (`YYYY-MM-DDT00:00:00Z`)。
 *
 * ★ 検査ツールの値は UTC の ISO (例 2026-07-30T20:00:00Z)。そのまま日付列へ入れると
 *   UTC の暦日 (7/30) で登録され、JST では 7/31 なのに 1 日ずれて見える。
 *   9 時間ずらしてから日付部分を取れば JST の暦日になる。
 * ★ 時刻を 00:00:00Z に固定するのは、SharePoint の「日付のみ」列がタイムゾーンに
 *   依存せずその日付を表示するため。時刻付きのまま入れると閲覧者の地域設定で
 *   前後にずれ得る。
 * ★ 変換は「書き込む値の組み立て時」に行う。差分比較も同じ値どうしで行われるので、
 *   毎回「差分あり」になってしまうことがない。
 */
export function jstDateOnly(iso?: string): string {
  const s = text(iso);
  if (!s) return '';
  const t = new Date(s);
  if (Number.isNaN(t.getTime())) return '';
  const jst = new Date(t.getTime() + 9 * 60 * 60 * 1000);
  return `${jst.toISOString().slice(0, 10)}T00:00:00Z`;
}

/** 日付列 (空文字ではなく null を送らないと SP が 400 を返す)。 */
export const VULNRESPONSE_DATE_FIELDS: (keyof VulnResponseFields)[] =
  ['firstSeen', 'lastSeen', 'responseDueDate', 'confirmedAt'];

/** 列の種類。sp/schema.ts の vulnResponseFieldSpecs() と一致させること
 *  (ズレは test/vulnResponseSync.test.ts で検査)。 */
export const VULNRESPONSE_KIND: Record<keyof VulnResponseFields, 'text' | 'note' | 'date' | 'url'> = {
  issueInstanceId: 'text', title: 'text', legacyMgmtNumber: 'text', detectionStatus: 'text',
  firstSeen: 'date', lastSeen: 'date',
  assetIp: 'text', assetFqdn: 'text', assetType: 'text',
  businessCompany: 'text', affiliateCompany: 'text', assetMgmtId: 'text',
  relatedAssets: 'note', identifyEvidence: 'note',
  reportUrl: 'url',
  confirmedAt: 'date',
  responseStatus: 'text', responseDueDate: 'date', extConnAppId: 'text',
  responsePlan: 'note', noAppReason: 'note', responseRemarks: 'note',
};

/**
 * 連携用リストの「脆弱性レポート」列に出すリンク文字列。
 * ★ ファイル名 (IID_日時.pdf) や形式ではなく、何をする列かが分かる固定文言にする。
 *   ファイル名は長くて一覧の幅を食い、形式だけだと押せると分かりにくい。
 *   レポートが無い行は URL 列自体を空にするので、この文言は出ない。
 */
export const REPORT_LINK_TEXT = 'レポートを開く';

/** SharePoint の単一行テキスト列の既定上限。 */
export const TEXT_MAX_LENGTH = 255;

/**
 * 単一行テキスト列に入る形に整える。
 *
 * ★ これをやらないと SharePoint は作成/更新を **HTTP 500** で拒否する:
 *     「テキストの値が正しくありません。テキストのフィールドに正しくない値が
 *       含まれています。値を確認し、再度行ってください。」
 *   超過はよくある。資産が多い脆弱性の FQDN 一覧 (' | ' 連結) や、
 *   検査ツールが付ける長いタイトルが 255 文字を軽く超える。
 *   改行・制御文字も単一行テキストには入れられないので空白に潰す。
 *
 * ★ 切り詰めは **反映前の値の組み立て時に** 行う。書込直前で切ると、
 *   SharePoint に入った値と Mikke が計算した値が食い違い、毎回「差分あり」と
 *   判定されて延々と更新し続ける。
 */
export function fitSingleLine(v: string): string {
  const s = v.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/ {2,}/g, ' ').trim();
  if (s.length <= TEXT_MAX_LENGTH) return s;
  let cut = TEXT_MAX_LENGTH - 1;
  // サロゲートペアの途中で切らない (絵文字等が壊れた文字になるのを防ぐ)。
  const c = s.charCodeAt(cut - 1);
  if (c >= 0xd800 && c <= 0xdbff) cut -= 1;
  return `${s.slice(0, cut)}…`;
}

/** 連携用リストの既存アイテム (Mikke が書く項目のみ)。 */
export interface VulnResponseRow extends VulnResponseFields {
  id: number;
}

export interface VulnResponsePlan {
  creates: VulnResponseFields[];
  updates: { id: number; issueInstanceId: string; fields: Partial<VulnResponseFields> }[];
  deletes: { id: number; issueInstanceId: string; reason: '対象外' | '管理対象に無い' }[];
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

/** IPv4 か (資産キーを IP と FQDN に振り分けるための簡易判定)。 */
function isIpKey(s: string): boolean {
  const m = s.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  return !!m && m.slice(1).every((o) => Number(o) <= 255);
}

/** 管理対象から外れているか (連携用リストから消す対象)。 */
export function isExcluded(issue: ManagedIssue): boolean {
  return issue.isOutOfScope || issue.mgmtStatus === '対象外';
}

/**
 * 1 件分の書き込み内容を組み立てる。
 * 資産の情報 (事業会社 / 管理会社 / Web資産管理ID / 特定根拠) は資産リストから引く。
 * 複数の資産に跨る場合、代表値は最初に見つかったものを使い、資産キーは全部並べる。
 */
export function toVulnResponseFields(
  issue: ManagedIssue,
  assetKeys: string[],
  assetsByKey: Map<string, ManagedAsset>,
  /** true なら資産管理者の記入欄 (対応状況 / 対応期日) も Mikke の値で上書きする。 */
  overwriteResponse = false,
  /** Mikke がこの内容を確認した日 (JST の暦日。省略時は空)。 */
  confirmedAt = '',
): VulnResponseFields {
  const ips = assetKeys.filter(isIpKey);
  const fqdns = assetKeys.filter((k) => !isIpKey(k));
  const pick = (get: (a: ManagedAsset) => string | undefined): string => {
    for (const k of assetKeys) {
      const v = text(get(assetsByKey.get(k) ?? ({} as ManagedAsset)));
      if (v) return v;
    }
    return '';
  };
  // 代表以外の資産キー = 関連資産 (どの資産と一緒に検出されたかが分かる)
  const primary = fqdns[0] ?? ips[0] ?? '';
  const related = assetKeys.filter((k) => k !== primary);

  const raw: VulnResponseFields = {
    issueInstanceId: text(issue.issueInstanceId),
    title: text(issue.title),
    legacyMgmtNumber: text(issue.legacyMgmtNumber),
    detectionStatus: text(issue.detectionStatus),
    firstSeen: jstDateOnly(issue.firstSeen),
    lastSeen: jstDateOnly(issue.lastSeen),
    assetIp: ips.join(' | '),
    assetFqdn: fqdns.join(' | '),
    assetType: fqdns.length ? 'FQDN' : (ips.length ? 'IP' : ''),
    // ★ 管理対象に直接入れた値を優先し、無ければ資産リストから引く。
    //   事業会社はアクセス権の割当キーなので、脆弱性ごとに直したいことがある。
    businessCompany: text(issue.businessCompany) || pick((a) => a.businessCompany),
    affiliateCompany: text(issue.affiliateCompany) || pick((a) => a.affiliateCompany),
    // ★ WebMAPS管理ID と 事業会社特定の根拠 も、管理対象に直接入れた値を優先する。
    //   資産リストからしか引いていなかったため、Excel から移行した値
    //   (WebMAPS登録情報 / その他の参考情報) が連携用リストに出なかった。
    assetMgmtId: text(issue.webMapsId) || pick((a) => a.mgmtNumber),
    relatedAssets: related.join(' | '),
    // 改行を含む複数行がそのまま入る (この列は Note なので 1 行に潰さない)。
    identifyEvidence: text(issue.identifyEvidence) || pick((a) => a.identifyEvidence),
    // ★ レポートは「情報更新」で取得したときに管理対象へ記録される。ここでは
    //   その URL をそのまま渡すだけ (未取得なら空 = 列も空になる)。
    reportUrl: text(issue.reportUrl),
    confirmedAt,
    // ★ 既定では入れない (undefined = body に載らない = 記入内容に触れない)。
    ...(overwriteResponse ? {
      responseStatus: text(issue.mgmtStatus),
      responseDueDate: jstDateOnly(issue.dueDate),
      extConnAppId: text(issue.extConnAppId),
      responsePlan: text(issue.responsePlan),
      noAppReason: text(issue.noAppReason),
      responseRemarks: text(issue.responseRemarks),
    } : {}),
  };
  // 単一行テキスト列は 255 文字・改行なしに収める (超えると SP が 500 を返す)。
  const out = { ...raw };
  for (const k of Object.keys(out) as (keyof VulnResponseFields)[]) {
    if (VULNRESPONSE_KIND[k] === 'text') out[k] = fitSingleLine(out[k] ?? '');
  }
  return out;
}

/** 単一行テキスト列に収まらない項目を洗い出す (原因を利用者に見せるため)。 */
export function overlongTextFields(f: VulnResponseFields): { field: keyof VulnResponseFields; length: number }[] {
  const out: { field: keyof VulnResponseFields; length: number }[] = [];
  for (const k of Object.keys(f) as (keyof VulnResponseFields)[]) {
    if (VULNRESPONSE_KIND[k] !== 'text') continue;
    const v = String(f[k] ?? '');
    if (v.length > TEXT_MAX_LENGTH) out.push({ field: k, length: v.length });
  }
  return out;
}

/** 日付として比べる項目 (他は文字列として比べる)。 */
const DATE_FIELDS: (keyof VulnResponseFields)[] = ['firstSeen', 'lastSeen', 'responseDueDate', 'confirmedAt'];

/**
 * その脆弱性は「クローズ」か (検査ツール上から消えている)。
 * ★ クローズした行は中身が動かないので、最終確認日を毎日書き足さない。
 *   書くと変更が無いのに全件更新が走り、版履歴だけが増える。
 *   クローズした当日は検知状況の変化と一緒に日付も入るので、
 *   「その日に未検出を確認して、以後変化なし」と読める。
 */
export function isClosedDetection(status: string | undefined): boolean {
  return status === '未検出' || status === '未検出(New)';
}

/**
 * 管理対象一覧と連携用リストを突合し、追加 / 更新 / 削除の計画を組み立てる。
 *
 * @param assetKeysOf 脆弱性から資産キーを取り出す関数 (設定の資産列に依存するため外から渡す)
 * @param scope 指定すると、この Issue Instance ID だけを対象にする (選択分の反映)。
 *   ★ 範囲外の既存アイテムは **一切触らない**。絞ったまま「管理対象に無い」判定を
 *     するとリストのほとんどを消してしまうため、削除の走査も範囲内に限る。
 */
export function buildVulnResponsePlan(
  issues: ManagedIssue[],
  assetsByKey: Map<string, ManagedAsset>,
  assetKeysOf: (issue: ManagedIssue) => string[],
  existing: VulnResponseRow[],
  scope?: Set<string>,
  /** true なら資産管理者の記入欄 (対応状況 / 対応期日) も上書きする。 */
  overwriteResponse = false,
  /** 反映を実行した日時 (ISO)。最終確認日はこの **JST の暦日** で入れる。
   *  ★ 時刻まで持たせない。持たせると毎回すべての行に差分が出て、変更が無くても
   *    全件書き込みになる。日付なら同じ日に何度反映しても差分ゼロで済む。 */
  nowIso = '',
): VulnResponsePlan {
  if (scope) {
    issues = issues.filter((i) => scope.has(text(i.issueInstanceId)));
    existing = existing.filter((r) => scope.has(text(r.issueInstanceId)));
  }
  const byId = new Map(existing.filter((r) => r.issueInstanceId).map((r) => [r.issueInstanceId, r]));
  const asOf = jstDateOnly(nowIso);
  const plan: VulnResponsePlan = { creates: [], updates: [], deletes: [], unchanged: 0 };
  const seen = new Set<string>();

  for (const issue of issues) {
    const iid = text(issue.issueInstanceId);
    if (!iid) continue;              // 突合キーが無いものは扱えない
    seen.add(iid);
    const row = byId.get(iid);

    if (isExcluded(issue)) {
      // 管理対象外 → 連携用リストから消す。解除すれば次回また追加される。
      if (row) plan.deletes.push({ id: row.id, issueInstanceId: iid, reason: '対象外' });
      continue;
    }

    const fields = toVulnResponseFields(issue, assetKeysOf(issue), assetsByKey, overwriteResponse, asOf);
    if (!row) { plan.creates.push(fields); continue; }

    // ★ 最終確認日は最後に決める。他の項目に差分があるかで扱いが変わるため。
    const diff: Partial<VulnResponseFields> = {};
    for (const k of Object.keys(fields) as (keyof VulnResponseFields)[]) {
      if (k === 'issueInstanceId' || k === 'confirmedAt') continue;   // 突合キーは変えない
      const a = DATE_FIELDS.includes(k) ? day(fields[k]) : text(fields[k]);
      const b = DATE_FIELDS.includes(k) ? day(row[k]) : text(row[k]);
      if (a !== b) diff[k] = fields[k];
    }
    // 最終確認日を書くのは次のどちらか。
    //   1. 他に変化があった   … その日に内容が変わったので、確認日も揃える
    //   2. まだ検知中で日付が変わった … 「今日時点でも同じ内容」を示すため 1 日 1 回
    // クローズ (未検出系) で変化が無い行は書かない。無駄な全件更新を避ける。
    const changed = Object.keys(diff).length > 0;
    const active = !isClosedDetection(text(issue.detectionStatus));
    if (asOf && day(asOf) !== day(row.confirmedAt) && (changed || active)) {
      diff.confirmedAt = asOf;
    }
    if (Object.keys(diff).length) plan.updates.push({ id: row.id, issueInstanceId: iid, fields: diff });
    else plan.unchanged++;
  }

  // 管理対象から消えた (削除された) ものも連携用リストから消す。
  for (const row of existing) {
    if (row.issueInstanceId && !seen.has(row.issueInstanceId)) {
      plan.deletes.push({ id: row.id, issueInstanceId: row.issueInstanceId, reason: '管理対象に無い' });
    }
  }
  return plan;
}
