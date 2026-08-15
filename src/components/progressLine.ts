// 一括処理の進捗を出す 1 行。
//
// ★ これまでは件数が多いときだけトーストを間引いて出していたので、
//   ふつうの件数では「押したあと何も起きていないように見える」時間が長かった。
//   連携リストへの反映は 書き込み → レポート添付 → アクセス権 と段階があり、
//   どこを走っているのかも分からなかった。
// ★ ツールバーの下に居座る 1 行にして、段階と件数と割合をそのまま見せる。
// ★ class 名は mikke-bulkprog-*。CSV 取込のバー (.mikke-progress) とは別物なので、
//   名前を分けている (同じ名前にすると後から書いた方の指定で潰し合う)。
//   更新は文字と幅を書き換えるだけなので、細かく呼ばれても重くならない。
import { el } from '../utils/dom';

export interface ProgressLine {
  /** 画面に差し込む要素 (ツールバーの下など、描き直されない場所に置く)。 */
  el: HTMLElement;
  /**
   * 進捗を出す。
   * @param label 何をしているか (「連携リストへ反映」など)
   * @param done  済んだ数。省略すると件数を出さず、動いていることだけ示す
   * @param total 全体の数
   */
  set(label: string, done?: number, total?: number): void;
  /** 消す (処理が終わったら必ず呼ぶ)。 */
  hide(): void;
}

export function createProgressLine(): ProgressLine {
  const label = el('span', { class: 'mikke-bulkprog-label' });
  const count = el('span', { class: 'mikke-bulkprog-count' });
  const bar = el('div', { class: 'mikke-bulkprog-bar' });
  const track = el('div', { class: 'mikke-bulkprog-track' }, [bar]);
  const root = el('div', { class: 'mikke-bulkprog', hidden: 'hidden' }, [label, count, track]);

  return {
    el: root,
    set(text: string, done?: number, total?: number): void {
      root.removeAttribute('hidden');
      label.textContent = text;
      if (total && total > 0) {
        const d = Math.min(done ?? 0, total);
        count.textContent = `${d} / ${total} 件`;
        bar.style.width = `${Math.round((d / total) * 100)}%`;
        bar.classList.remove('is-indeterminate');
      } else {
        // 全体の数が分からない段階 (準備中など) は、進み具合を出さずに動きだけ見せる。
        count.textContent = '';
        bar.style.width = '100%';
        bar.classList.add('is-indeterminate');
      }
    },
    hide(): void {
      root.setAttribute('hidden', 'hidden');
      bar.style.width = '0%';
      bar.classList.remove('is-indeterminate');
      label.textContent = '';
      count.textContent = '';
    },
  };
}
