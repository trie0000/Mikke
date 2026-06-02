import { el } from '../utils/dom';
import { icon } from '../icons';

interface ModalOptions {
  title: string;
  body: HTMLElement;
  size?: 'default' | 'lg' | 'xl';
  primaryLabel?: string;
  primaryVariant?: 'primary' | 'danger' | 'dark';
  onPrimary?: () => void | Promise<void>;
  cancelLabel?: string;
  hideCancel?: boolean;
  /** フッタ左側 (保存ボタンの左) に追加表示するボタン等。primary/cancel は
   *  右寄せのまま、これらは左寄せで並ぶ。 */
  footerLeft?: HTMLElement[];
  /** モーダルが閉じる時 (× / Esc / backdrop / primary 完了後) に必ず呼ばれる。 */
  onClose?: () => void;
}

// B2: モーダルのスタック。多階層モーダルで Esc / Ctrl+Enter が最前面のみに
// 効くように、現在開いているモーダル backdrop の順序を保持する。
const modalStack: HTMLElement[] = [];

export interface ModalHandle {
  close(): void;
  setPrimaryDisabled(disabled: boolean): void;
}

export function openModal(root: HTMLElement, opts: ModalOptions): ModalHandle {
  const primaryLabel = opts.primaryLabel ?? 'OK';
  const primaryVariant = opts.primaryVariant ?? 'primary';
  const cancelLabel = opts.cancelLabel ?? 'キャンセル';

  // 保存中フラグ。true の間は Esc / × / backdrop / cancel での close を抑止し、
  // 保存失敗で onPrimary が throw した時の「保存途中で本文が消える」「成功時
  // に二重 close される」事故を防ぐ。primary ボタンの disable とセット。
  let busy = false;

  const primaryBtn = el('button', {
    type: 'button',
    class: `mikke-btn mikke-btn--${primaryVariant}`,
    onclick: async () => {
      if (!opts.onPrimary) { close(); return; }
      if (busy) return;
      try {
        busy = true;
        primaryBtn.setAttribute('disabled', '');
        if (cancelBtn) cancelBtn.setAttribute('disabled', '');
        closeBtn.setAttribute('disabled', '');
        await opts.onPrimary();
        // ★ 成功時のみ close。busy フラグは close 後に立っているままでも
        //   モーダルは消えるので問題ない。
        busy = false;
        close();
      } catch (e) {
        // throw された = 失敗 → モーダルは残す。busy 解除して再試行できるように。
        busy = false;
        primaryBtn.removeAttribute('disabled');
        if (cancelBtn) cancelBtn.removeAttribute('disabled');
        closeBtn.removeAttribute('disabled');
        // エラー throw 元はトーストで詳細を出している前提 (上位の onPrimary 実装側)。
        // ここでは silent に再試行可能状態に戻す。
        void e;
      }
    },
  }, [primaryLabel]);

  const cancelBtn = opts.hideCancel ? null : el('button', {
    type: 'button',
    class: 'mikke-btn mikke-btn--secondary',
    onclick: () => { if (!busy) close(); },
  }, [cancelLabel]);

  const closeBtn = el('button', {
    type: 'button',
    class: 'mikke-iconbtn mikke-modal-close',
    'aria-label': '閉じる',
    onclick: () => { if (!busy) close(); },
    html: icon('x'),
  });

  const sizeClass = opts.size === 'xl' ? ' mikke-modal--xl' : opts.size === 'lg' ? ' mikke-modal--lg' : '';
  const modal = el('div', { class: `mikke-modal${sizeClass}`, role: 'dialog', 'aria-modal': 'true' }, [
    el('div', { class: 'mikke-modal-header' }, [
      el('h2', { class: 'mikke-modal-title' }, [opts.title]),
      closeBtn,
    ]),
    el('div', { class: 'mikke-modal-body' }, [opts.body]),
    el('div', { class: 'mikke-modal-footer' }, [
      ...(opts.footerLeft && opts.footerLeft.length
        ? [el('div', { style: 'margin-right:auto;display:flex;gap:var(--s-3);flex-wrap:wrap' }, opts.footerLeft)]
        : []),
      ...(cancelBtn ? [cancelBtn] : []),
      primaryBtn,
    ]),
  ]);

  const backdrop = el('div', {
    class: 'mikke-modal-backdrop',
    onclick: (e: Event) => { if (e.target === backdrop && !busy) close(); },
  }, [modal]);

  function onKey(e: KeyboardEvent) {
    // B2: モーダルが多階層に重なった時、Esc / Ctrl+Enter で最前面のみ
    // 処理する。stopImmediatePropagation で他の (背後の) モーダルの listener へ
    // 到達させない。最前面判定は modalStack の末尾と自分が一致するか。
    if (modalStack[modalStack.length - 1] !== backdrop) return;
    if (e.key === 'Escape') {
      // ★ ESC は常にモーダルを閉じる。
      //   以前は <select> / datalist / 日付ピッカーにフォーカス時に
      //   「ドロップダウンを閉じる用」とみなして bypass していたが、
      //   ドロップダウンが開いている時はブラウザがネイティブで keydown を
      //   消費する (= ここに来ない) ため bypass は不要。閉じている時に
      //   bypass してしまうと「<select> に focus がある間は ESC で modal が
      //   閉じない」というユーザーから見て不可解な挙動になっていた。
      //   ただし保存中 (busy) は閉じない。
      if (busy) { e.stopImmediatePropagation(); return; }
      e.stopImmediatePropagation();
      close();
    } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.stopImmediatePropagation();
      primaryBtn.click();
    } else if (e.key === 'Tab') {
      // M4: focus trap — フォーカスが modal 内をループするように制御。
      // 最前面 modal でのみ動作。
      // ★ busy 中は全ボタン disabled で focusables=0 になり、Tab で背面 UI へ
      //   フォーカスが逃げる問題があった。fallback として「modal 内に focus を
      //   留める」ため、modal 自体を tabindex=-1 で focus 可能にして使う。
      const focusables = modal.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), ' +
        'textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (focusables.length === 0) {
        // 何も focusable が無い時は modal 自身に focus を保持して背面に逃がさない
        e.preventDefault();
        modal.setAttribute('tabindex', '-1');
        modal.focus();
        return;
      }
      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey) {
        if (active === first || !modal.contains(active)) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (active === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }
  }

  // 二重 close 防止フラグ (close() を冪等にする)
  let closed = false;
  function close() {
    // ★ busy 中の外部 close() を抑止 (内部の primary 成功時のみ呼ばれるので
    //   外部経路 = handle.close() / 上位コード経由)。
    if (busy) {
      console.warn('[mikke] modal close() ignored while busy');
      return;
    }
    if (closed) return; // 冪等性 — onClose の二重発火防止
    closed = true;
    backdrop.remove();
    document.removeEventListener('keydown', onKey);
    const idx = modalStack.indexOf(backdrop);
    if (idx >= 0) modalStack.splice(idx, 1);
    try { opts.onClose?.(); } catch (e) { console.warn('[mikke] modal onClose error:', e); }
  }

  modalStack.push(backdrop);
  root.appendChild(backdrop);
  document.addEventListener('keydown', onKey);

  // focus first input/textarea/button
  setTimeout(() => {
    const first = modal.querySelector<HTMLElement>('input, textarea, select, button.mikke-btn--primary');
    first?.focus();
  }, 0);

  return {
    close,
    setPrimaryDisabled(d) { d ? primaryBtn.setAttribute('disabled', '') : primaryBtn.removeAttribute('disabled'); },
  };
}

export function confirmModal(root: HTMLElement, opts: {
  title: string;
  message: string;
  primaryLabel?: string;
  primaryVariant?: 'primary' | 'danger';
  onConfirm: () => void | Promise<void>;
  /** ユーザーがキャンセル / Esc / × で閉じた時のロールバック処理。 */
  onCancel?: () => void;
}): void {
  // Use a div with `white-space: pre-line` so newlines in the message are preserved.
  const body = el('div', { class: 'mikke-modal-body', style: 'white-space:pre-line;line-height:1.7' }, [opts.message]);
  let confirmed = false;
  const handle = openModal(root, {
    title: opts.title,
    body,
    primaryLabel: opts.primaryLabel ?? 'OK',
    primaryVariant: opts.primaryVariant ?? 'primary',
    onPrimary: async () => {
      confirmed = true;
      await opts.onConfirm();
    },
    onClose: () => {
      // primary 押下で閉じた場合は何もしない (confirmed=true)。
      // Esc / × / キャンセルボタンで閉じた場合のみロールバック。
      if (!confirmed && opts.onCancel) opts.onCancel();
    },
  });
  void handle;
}
