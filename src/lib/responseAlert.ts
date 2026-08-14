// 「連携リスト側で事業会社が書き換えた」ことに気づくための判定。
//
// ★ 連携リストのアイテムの更新時刻は、Mikke が反映したときにも動く。
//   そのままだと自分の反映で「更新あり」になってしまうので、
//   **最後に自分が反映した時刻より後か** で判定する。
// ★ 一度明細を開いたら消す。開いた時点の更新時刻を端末に覚えておき、
//   それと同じ間は出さない (次に書き換えられたらまた出る)。
// UI にも SP にも依存しない (テストしやすくするため)。

/** ISO をミリ秒に。読めなければ NaN。 */
function ms(iso?: string): number {
  if (!iso) return NaN;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? NaN : t;
}

export interface ResponseAlertInput {
  /** 連携リストのアイテムの最終更新時刻。アイテムが無ければ undefined。 */
  linkedAt?: string;
  /** 最後に Mikke から反映した時刻。 */
  pushedAt?: string;
  /** Mikke 側 (管理対象) の最終更新時刻。pushedAt が無いときの代わり。 */
  issueUpdatedAt?: string;
  /** 明細を開いたときに覚えた、その時点の linkedAt。 */
  seenAt?: string;
}

/**
 * 「連携リスト更新」を出すか。
 *
 * 出す条件は 3 つとも満たすとき:
 *   - 連携リストにアイテムがあり、更新時刻が読める
 *   - その更新時刻が、こちらが最後に反映した時刻より後 (= 相手が書き換えた)
 *   - まだ明細を開いていない (開いた時点の時刻と違う)
 */
export function hasResponseUpdate(v: ResponseAlertInput): boolean {
  const linked = ms(v.linkedAt);
  if (Number.isNaN(linked)) return false;              // アイテムが無い / 時刻が読めない
  if (v.seenAt && ms(v.seenAt) === linked) return false; // 開いて確認済み
  const base = ms(v.pushedAt) || ms(v.issueUpdatedAt);
  if (Number.isNaN(base)) return false;                // 比べる基準が無ければ出さない
  return linked > base;
}
