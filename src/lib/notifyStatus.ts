// 資産管理者への連携用リストと比べた「通知ステータス」。
//   未通知   … 連携用リストに該当アイテムが無い (まだ渡していない)
//   差分あり … アイテムはあるが、Mikke 側がその後に更新されている (渡し直しが必要)
//   同期済み … 連携用リストの方が新しい / 同時刻 (渡した内容が反映済み)
// UI 非依存の純関数。判定は「内容の更新時間」の比較で行う。
export type NotifyStatus = '未通知' | '差分あり' | '同期済み';

export const NOTIFY_STATUSES: NotifyStatus[] = ['未通知', '差分あり', '同期済み'];

/** 表示順 (悪い方＝手当てが要る方を上に)。 */
export const NOTIFY_ORDER: Record<NotifyStatus, number> = {
  '未通知': 3, '差分あり': 2, '同期済み': 1,
};

/** ISO 文字列をミリ秒に。読めなければ NaN。 */
function ms(iso?: string): number {
  if (!iso) return NaN;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? NaN : t;
}

/**
 * 1 件分の通知ステータスを判定する。
 *
 * @param issueUpdatedAt      Mikke 側 (管理対象) の最終更新時刻
 * @param vulnResponseUpdated 連携用リスト側の最終更新時刻。該当アイテムが無ければ undefined
 *
 * ★ 時刻が読めない場合の扱い
 *   - 連携用リスト側が読めない → アイテムはあるので「同期済み」にはせず「差分あり」
 *     (判断できないものを同期済みと言い切ると渡し漏れに気づけない)
 *   - Mikke 側が読めない → 比較できないので「同期済み」扱いにする
 *     (更新時刻を持たない古いデータで全件が差分ありになるのを避ける)
 */
export function notifyStatusOf(issueUpdatedAt?: string, vulnResponseUpdated?: string): NotifyStatus {
  if (vulnResponseUpdated === undefined) return '未通知';
  const b = ms(vulnResponseUpdated);
  if (Number.isNaN(b)) return '差分あり';
  const a = ms(issueUpdatedAt);
  if (Number.isNaN(a)) return '同期済み';
  return a > b ? '差分あり' : '同期済み';
}
