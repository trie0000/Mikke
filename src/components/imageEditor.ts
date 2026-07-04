// imageEditor.ts
//
// 画像を貼り付け / ドラッグできる最小の入力欄。資産の「特定根拠」「備考」で使う。
// <textarea> の代わりに <div contenteditable> を使い、以下を提供する:
//   1. クリップボード / ドラッグの画像を paste 直後に <img src="data:...">
//      としてインライン挿入 (= プレビュー即時表示)。
//   2. 保存直前に getFinalHtml(assetId) を呼ぶと、HTML 内の data: URL を
//      添付ファイルにアップロードし SP 絶対 URL に置換する (base64 肥大化回避)。
//
// 別アプリの本文エディタの貼り付け方式を踏襲した最小サブセット (リサイズ /
// ツールバー等は持たず、文字入力と画像だけ扱う)。
import { getRepo } from '../api/repo';
import { sanitizeAssetHtml } from '../utils/sanitize';

export interface ImageEditorHandle {
  /** ルート要素 (contenteditable div)。フォームに append する。 */
  root: HTMLElement;
  /** 現在の HTML (data: URL を含みうる)。 */
  getHtml(): string;
  /** 内容を設定 (サニタイズ済 HTML を挿入)。 */
  setHtml(html: string): void;
  /** 保存用に data: URL → 添付 URL に置換した HTML を返す。 */
  getFinalHtml(assetId: number): Promise<string>;
  /** data: URL 画像が残っているか。 */
  hasPendingImages(): boolean;
}

export function createImageEditor(placeholder = ''): ImageEditorHandle {
  const inner = document.createElement('div');
  inner.contentEditable = 'true';
  inner.className = 'mikke-imgedit';
  inner.dataset.placeholder = placeholder;
  inner.setAttribute('role', 'textbox');
  inner.setAttribute('aria-multiline', 'true');

  // 画像 paste: clipboard に image/* があれば横取りして base64 inline に。
  inner.addEventListener('paste', (e: ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items || items.length === 0) return;
    let idx = 0;
    for (let i = 0; i < items.length; i++) {
      const item = items[i]!;
      if (!item.type.startsWith('image/')) continue;
      const blob = item.getAsFile();
      if (!blob) continue;
      e.preventDefault();
      readAndInsert(inner, blob, idx++);
    }
    // 画像以外 (テキスト) はブラウザ標準の paste に任せる。
  });

  // ドラッグ&ドロップ: 画像ファイルのみ取り込む。
  inner.addEventListener('dragover', (e) => { e.preventDefault(); inner.classList.add('is-drop'); });
  inner.addEventListener('dragleave', () => inner.classList.remove('is-drop'));
  inner.addEventListener('drop', (e: DragEvent) => {
    inner.classList.remove('is-drop');
    const files = e.dataTransfer?.files;
    if (!files || files.length === 0) return;
    const imgs = Array.from(files).filter((f) => f.type.startsWith('image/'));
    if (imgs.length === 0) return;
    e.preventDefault();
    imgs.forEach((f, i) => readAndInsert(inner, f, i));
  });

  return {
    root: inner,
    getHtml: () => inner.innerHTML,
    setHtml: (html: string) => { inner.innerHTML = sanitizeAssetHtml(html || ''); },
    getFinalHtml: (assetId: number) => uploadInlineImages(inner.innerHTML, assetId),
    hasPendingImages: () => /data:image\//.test(inner.innerHTML),
  };
}

/** blob を data URL 化してカーソル位置 (なければ末尾) に <img> 挿入。 */
function readAndInsert(editor: HTMLElement, blob: Blob, offset: number): void {
  const reader = new FileReader();
  reader.onload = () => insertImageAtCursor(editor, reader.result as string, offset);
  reader.readAsDataURL(blob);
}

function insertImageAtCursor(editor: HTMLElement, dataUrl: string, offset: number): void {
  if (!editor.isConnected) return;
  const img = document.createElement('img');
  img.src = dataUrl;
  const mime = dataUrl.slice(5, dataUrl.indexOf(';'));
  img.dataset.pendingExt = (mime.split('/')[1] ?? 'png').replace(/[^a-z0-9]/gi, '') || 'png';
  img.dataset.pendingOffset = String(offset);

  let range: Range | null = null;
  const sel = window.getSelection();
  if (sel && sel.rangeCount > 0) {
    const r = sel.getRangeAt(0);
    if (editor.contains(r.commonAncestorContainer)) range = r;
  }
  if (range) {
    range.deleteContents();
    range.insertNode(img);
    range.setStartAfter(img);
    range.collapse(true);
    sel!.removeAllRanges();
    sel!.addRange(range);
  } else {
    editor.appendChild(img);
  }
}

/** HTML 内の data: URL を添付アップロードした URL に置換。画像が無ければ no-op。 */
async function uploadInlineImages(html: string, assetId: number): Promise<string> {
  const clean = sanitizeAssetHtml(html || '');
  if (!/data:image\//.test(clean)) return clean;

  const doc = new DOMParser().parseFromString(`<div>${clean}</div>`, 'text/html');
  const root = doc.body.firstElementChild as HTMLElement | null;
  if (!root) return clean;

  const dataImgs = Array.from(root.querySelectorAll('img'))
    .filter((i) => (i.getAttribute('src') ?? '').startsWith('data:image/'))
    .sort((a, b) => Number(a.dataset.pendingOffset ?? '0') - Number(b.dataset.pendingOffset ?? '0'));
  if (dataImgs.length === 0) return root.innerHTML;

  const ts = timestamp14();
  for (let i = 0; i < dataImgs.length; i++) {
    const img = dataImgs[i]!;
    const blob = await dataUrlToBlob(img.getAttribute('src')!);
    if (!blob) continue;
    const ext = img.dataset.pendingExt ?? (blob.type.split('/')[1]?.replace(/[^a-z0-9]/g, '') ?? 'png');
    const fname = `paste-${ts}${i === 0 ? '' : `-${i + 1}`}.${ext}`;
    try {
      const { url } = await getRepo().uploadAssetImage(assetId, new File([blob], fname, { type: blob.type }));
      if (url) {
        img.setAttribute('src', url);
        delete img.dataset.pendingExt;
        delete img.dataset.pendingOffset;
      }
    } catch (e) {
      // 1 枚の失敗で全体を巻き戻さない。失敗画像は data: のまま残し再保存で再試行可。
      console.warn(`[mikke/imageEditor] 画像アップロード失敗 (${fname}):`, (e as Error).message);
    }
  }
  return root.innerHTML;
}

function dataUrlToBlob(dataUrl: string): Promise<Blob | null> {
  return fetch(dataUrl).then((r) => r.blob()).catch(() => null);
}

function timestamp14(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
