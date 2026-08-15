// ホストページのキー横取りから、Mikke の入力欄を守る。
//
// ★ 症状: SharePoint のページに載せると、入力欄で **Backspace だけ効かない**
//   (文字は打てるのに消せない)。アクセス権・管理対象一覧・リセットの確認欄など、
//   場所を問わず起きる。
// ★ 原因: ページ側に「Backspace でブラウザが戻ってしまうのを防ぐ」種類の
//   keydown ハンドラが載っていて、Mikke の入力欄で押した Backspace まで
//   まとめて preventDefault してしまう。この手のハンドラは
//   「入力欄にフォーカスがあるときは見逃す」判定を document.activeElement で
//   行うが、Mikke は Shadow DOM の中にあるため activeElement は **ホスト要素**
//   を返す。入力欄ではないと判定され、必ず潰される。
//
// ★ 対処は 2 段構え。
//   1. 入力欄で押された編集キーは Mikke の外へ伝えない (stopPropagation)。
//      ページ側のハンドラが bubble 段 (既定) ならこれで届かなくなる。
//   2. capture 段で既に潰されていたら (defaultPrevented)、同じ編集を自前で
//      行って復旧する。潰されていないときは何もしないので二重削除にならない。
//
// ★ 対象は Backspace / Delete だけにする。Escape・Tab・Enter は Mikke 自身が
//   document で拾っている (モーダルを閉じる / フォーカスを閉じ込める) ので、
//   ここで止めると別の壊れ方をする。

/** 文字を編集する欄か (押した先が入力欄でなければ何もしない)。 */
function isTextEntry(t: EventTarget | null): t is HTMLInputElement | HTMLTextAreaElement {
  const el = t as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  if (tag === 'TEXTAREA') return !(el as HTMLTextAreaElement).disabled && !(el as HTMLTextAreaElement).readOnly;
  if (tag !== 'INPUT') return false;
  const input = el as HTMLInputElement;
  if (input.disabled || input.readOnly) return false;
  // チェックボックス等は編集キーと関係ない。
  return !['checkbox', 'radio', 'button', 'submit', 'reset', 'file', 'range', 'color', 'image']
    .includes((input.type || 'text').toLowerCase());
}

/** 選択範囲を扱える欄か (number / date などは selectionStart が null)。 */
function hasSelection(el: HTMLInputElement | HTMLTextAreaElement): boolean {
  try { return el.selectionStart !== null && el.selectionEnd !== null; } catch { return false; }
}

/**
 * Backspace / Delete を当てた後の値とカーソル位置を求める。
 * 何も変わらないとき (先頭で Backspace / 末尾で Delete) は null。
 *
 * ★ サロゲートペア (絵文字など) は 2 コード単位で 1 文字なので、まとめて消す。
 *   1 単位だけ消すと壊れた文字が残る。
 * ★ DOM に触らないので単体で試せる (installKeyGuard から使う)。
 */
export function computeDelete(
  value: string, selStart: number, selEnd: number, key: 'Backspace' | 'Delete',
): { value: string; caret: number } | null {
  let start = Math.max(0, Math.min(selStart, value.length));
  let end = Math.max(start, Math.min(selEnd, value.length));
  if (start === end) {
    if (key === 'Backspace') {
      if (start === 0) return null;
      start -= 1;
      const c = value.charCodeAt(start);
      if (c >= 0xdc00 && c <= 0xdfff && start > 0) start -= 1;   // 下位サロゲート
    } else {
      if (end >= value.length) return null;
      const c = value.charCodeAt(end);
      end += (c >= 0xd800 && c <= 0xdbff && end + 1 < value.length) ? 2 : 1;
    }
  }
  return { value: value.slice(0, start) + value.slice(end), caret: start };
}

/** 潰された Backspace / Delete を自前で当て直す。 */
function applyDelete(el: HTMLInputElement | HTMLTextAreaElement, key: 'Backspace' | 'Delete'): void {
  const next = computeDelete(el.value, el.selectionStart ?? 0, el.selectionEnd ?? 0, key);
  if (!next) return;
  el.value = next.value;
  try { el.setSelectionRange(next.caret, next.caret); } catch { /* 選択位置を戻せない欄もある */ }
  // 画面側の再計算 (入力に応じた表示) が動くよう、通常の入力と同じ通知を出す。
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

/**
 * root 配下の入力欄を、ページ側のキー横取りから守る。
 * ★ bubble 段で受ける。capture 段の横取りは既に走った後なので、
 *   defaultPrevented を見て潰されたかどうかが分かる。
 */
export function installKeyGuard(root: HTMLElement): void {
  root.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key !== 'Backspace' && e.key !== 'Delete') return;
    if (!isTextEntry(e.target)) return;
    // 変換中は IME が処理する。横から触ると確定前の文字列が壊れる。
    if (e.isComposing) return;
    e.stopPropagation();
    if (!e.defaultPrevented) return;              // 誰も邪魔していない = ブラウザに任せる
    // 単語単位の削除 (Ctrl/Alt+Backspace) までは真似しない。
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const el = e.target as HTMLInputElement | HTMLTextAreaElement;
    if (!hasSelection(el)) return;
    applyDelete(el, e.key as 'Backspace' | 'Delete');
  });
  // keypress / keyup も同様に外へ出さない (keyup 側で戻る実装のページがある)。
  for (const type of ['keypress', 'keyup'] as const) {
    root.addEventListener(type, (e: KeyboardEvent) => {
      if (e.key !== 'Backspace' && e.key !== 'Delete') return;
      if (isTextEntry(e.target)) e.stopPropagation();
    });
  }
}
