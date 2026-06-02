import { el, qs } from '../utils/dom';
import { icon } from '../icons';

type Variant = 'default' | 'ok' | 'warn' | 'error';

function ensureStack(root: HTMLElement): HTMLElement {
  let stack = qs('.mikke-toast-stack', root);
  if (!stack) {
    stack = el('div', { class: 'mikke-toast-stack', role: 'status', 'aria-live': 'polite' });
    root.appendChild(stack);
  }
  return stack;
}

export function toast(root: HTMLElement, msg: string, variant: Variant = 'default', durationMs?: number): void {
  const stack = ensureStack(root);
  const cls = ['mikke-toast'];
  if (variant !== 'default') cls.push(`mikke-toast--${variant}`);

  const closeBtn = el('button', {
    class: 'mikke-iconbtn',
    'aria-label': '閉じる',
    style: 'width:22px;height:22px;flex-shrink:0;color:var(--ink-3)',
    html: icon('x'),
  });

  const node = el('div', {
    class: cls.join(' '),
    style: 'display:flex;align-items:flex-start;gap:var(--s-3)',
  }, [
    el('div', { style: 'flex:1;min-width:0;word-break:break-word' }, [msg]),
    closeBtn,
  ]);

  function dismiss(): void {
    if (!node.isConnected) return;
    node.style.transition = 'opacity .15s, transform .15s';
    node.style.opacity = '0';
    node.style.transform = 'translateY(-4px)';
    setTimeout(() => node.remove(), 160);
  }

  closeBtn.addEventListener('click', (e) => { e.stopPropagation(); dismiss(); });

  stack.appendChild(node);

  // default TTL: 2s for ok/info, 3s for warn, error stays until dismissed.
  const ttl = durationMs ?? (variant === 'error' ? 0 : variant === 'warn' ? 3000 : 2000);
  if (ttl > 0) setTimeout(dismiss, ttl);
}
