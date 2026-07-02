// ファイル選択フィールド (モーダル内などのコンパクト用途)。
// 素の <input type="file"> はブラウザ標準の見た目になりデザインが崩れるため、
// F1 のドロップゾーンと同じトークン (破線枠 / accent hover / ドラッグ受付) で
// 統一したフィールドを提供する。クリックでもドラッグ&ドロップでも選択できる。
import { el } from '../utils/dom';
import { icon } from '../icons';

export interface FilePickerHandle {
  root: HTMLElement;
  getFile(): File | null;
}

function fmtSize(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

export function filePicker(opts: { accept?: string; placeholder?: string } = {}): FilePickerHandle {
  let file: File | null = null;

  const input = el('input', {
    type: 'file', class: 'mikke-dropzone-input',
    ...(opts.accept ? { accept: opts.accept } : {}),
    onchange: (e: Event) => {
      const f = (e.target as HTMLInputElement).files?.[0];
      if (f) setFile(f);
    },
  }) as HTMLInputElement;

  const iconEl = el('span', { class: 'mikke-filefield-icon', html: icon('upload') });
  const nameEl = el('span', { class: 'mikke-filefield-name' }, [opts.placeholder ?? 'ファイルを選択']);
  const hintEl = el('span', { class: 'mikke-filefield-hint' }, ['クリック または ドラッグ&ドロップ']);

  const root = el('div', {
    class: 'mikke-filefield', role: 'button', tabindex: '0',
    onclick: () => input.click(),
    onkeydown: (e: Event) => {
      const k = (e as KeyboardEvent).key;
      if (k === 'Enter' || k === ' ') { e.preventDefault(); input.click(); }
    },
    ondragenter: (e: Event) => { e.preventDefault(); root.classList.add('is-dragover'); },
    ondragover: (e: Event) => { e.preventDefault(); root.classList.add('is-dragover'); },
    ondragleave: (e: Event) => {
      if (!root.contains((e as DragEvent).relatedTarget as Node)) root.classList.remove('is-dragover');
    },
    ondrop: (e: Event) => {
      e.preventDefault();
      root.classList.remove('is-dragover');
      const f = (e as DragEvent).dataTransfer?.files?.[0];
      if (f) setFile(f);
    },
  }, [iconEl, el('span', { class: 'mikke-filefield-text' }, [nameEl, hintEl]), input]);

  function setFile(f: File): void {
    file = f;
    root.classList.add('is-selected');
    iconEl.innerHTML = icon('check');
    nameEl.textContent = `${f.name} (${fmtSize(f.size)})`;
    hintEl.textContent = 'クリックで変更';
  }

  return { root, getFile: () => file };
}
