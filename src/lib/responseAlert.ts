// 「連携リスト側で事業会社が書き換えた」ことに気づくための判定。
//
// ★ 判定は **「最後に見た時点から変わったか」** だけで行う。
//   連携リストのアイテムの更新時刻 (Modified) と、こちらが「見た」ときに覚えた
//   時刻を比べる。サーバ側の他の時刻 (反映した時刻・取り込んだ時刻) は使わない。
//   以前は「最後に反映した時刻より後か」で判定していたが、反映の記録が無い
//   既存データでは基準が管理対象の更新時刻になり、取り込みでその時刻が進むと
//   条件が崩れて **出るはずのバッジが出ない** ことがあった。
//
// ★ 「見た」ことになるのは 2 つ。
//     - 明細を開いた (人が中身を見た)
//     - 自分が連携リストへ反映した (自分の書き込みで動いた更新時刻は無視する)
//   取り込みでは「見た」にしない。取り込みは一覧を開くたびに自動でも走るので、
//   ここで消すと事実上バッジが出なくなる。
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
  /** 最後に「見た」時点の linkedAt (明細を開いた / 自分が反映した)。 */
  seenAt?: string;
}

/** 「連携リスト更新」を出すか。 */
export function hasResponseUpdate(v: ResponseAlertInput): boolean {
  const linked = ms(v.linkedAt);
  if (Number.isNaN(linked)) return false;    // アイテムが無い / 時刻が読めない
  const seen = ms(v.seenAt);
  if (Number.isNaN(seen)) return false;      // まだ一度も基準が無い (初回は出さない)
  return linked > seen;
}
