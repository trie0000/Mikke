// メール取込パーサ (.eml / .msg / Outlook ドラッグテキスト)。
//   - .eml: RFC 2822 を自前解析 (依存なし)。encoded-word / quoted-printable /
//           base64 / multipart(alternative) / 主要日本語文字コードに対応。
//   - .msg: Outlook (Windows) バイナリ。@kenjiuno/msgreader を使用
//           (iconv-lite 等の Node 依存は build.js の alias でブラウザスタブに差替)。
//   - Outlook ドラッグ: Windows Outlook のドラッグ text/plain ヘッダ。
// UI 非依存。テストは test/emlParser.test.ts。
import MsgReader from '@kenjiuno/msgreader';
import { decompressRTF } from '@kenjiuno/decompressrtf';

export interface ParsedMail {
  subject?: string;
  fromName?: string;
  fromEmail?: string;
  /** ISO 8601 (UTC)。取得できなければ undefined。 */
  dateISO?: string;
  /** プレーンテキスト本文 (改行 \n)。 */
  body?: string;
  /** HTML 本文 (元メールが text/html を持つ場合)。 */
  bodyHtml?: string;
}

// ── 文字コード・デコード ──────────────────────────────────────────────────────
function decodeBytes(bytes: Uint8Array, charset?: string): string {
  const cs = (charset || 'utf-8').toLowerCase().replace(/^["']|["']$/g, '');
  try { return new TextDecoder(cs as string).decode(bytes); }
  catch { try { return new TextDecoder('utf-8').decode(bytes); } catch { return String.fromCharCode(...bytes); } }
}
function base64ToBytes(b64: string): Uint8Array {
  const clean = b64.replace(/[^A-Za-z0-9+/=]/g, '');
  const bin = atob(clean);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function qpToBytes(s: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === '=') {
      const hex = s.substr(i + 1, 2);
      if (hex === '\r\n' || /^\r?\n/.test(s.substr(i + 1))) { // soft line break
        i += s[i + 1] === '\r' ? 2 : 1;
        continue;
      }
      if (/^[0-9a-fA-F]{2}$/.test(hex)) { out.push(parseInt(hex, 16)); i += 2; continue; }
      out.push(0x3d);
    } else {
      out.push(c.charCodeAt(0));
    }
  }
  return new Uint8Array(out);
}

/** MIME encoded-word (=?charset?B|Q?data?=) を解読する。 */
function decodeEncodedWords(value: string): string {
  return value.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_m, cs: string, enc: string, data: string) => {
    if (enc.toUpperCase() === 'B') return decodeBytes(base64ToBytes(data), cs);
    const bytes = qpToBytes(data.replace(/_/g, ' '));
    return decodeBytes(bytes, cs);
  });
}
/** ヘッダ値を解読 (encoded-word 連結時の空白除去も行う)。 */
function decodeHeaderValue(value: string): string {
  const joined = value.replace(/\?=\s+=\?/g, '?==?');
  return decodeEncodedWords(joined).trim();
}

// ── ヘッダ / 本文 ────────────────────────────────────────────────────────────
function splitHeadersBody(src: string): { head: string; body: string } {
  const norm = src.replace(/\r\n/g, '\n');
  const idx = norm.indexOf('\n\n');
  if (idx < 0) return { head: norm, body: '' };
  return { head: norm.slice(0, idx), body: norm.slice(idx + 2) };
}
function parseHeaders(head: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = head.split('\n');
  let cur = '';
  const flush = (): void => {
    const c = cur.indexOf(':');
    if (c > 0) { const k = cur.slice(0, c).trim().toLowerCase(); const v = cur.slice(c + 1).trim(); if (!(k in out)) out[k] = v; else out[k] += ' ' + v; }
    cur = '';
  };
  for (const line of lines) {
    if (/^[ \t]/.test(line) && cur) cur += ' ' + line.trim();
    else { if (cur) flush(); cur = line; }
  }
  if (cur) flush();
  return out;
}
function parseContentType(raw?: string): { mediaType: string; params: Record<string, string> } {
  const out = { mediaType: 'text/plain', params: {} as Record<string, string> };
  if (!raw) return out;
  const parts = raw.split(';');
  out.mediaType = (parts[0] ?? '').trim().toLowerCase();
  for (let i = 1; i < parts.length; i++) {
    const eq = parts[i]!.indexOf('=');
    if (eq < 0) continue;
    const k = parts[i]!.slice(0, eq).trim().toLowerCase();
    let v = parts[i]!.slice(eq + 1).trim().replace(/^"|"$/g, '');
    out.params[k] = v;
  }
  return out;
}
function decodePartBody(body: string, headers: Record<string, string>): string {
  const cte = (headers['content-transfer-encoding'] || '7bit').toLowerCase();
  const ct = parseContentType(headers['content-type']);
  const charset = ct.params['charset'];
  if (cte === 'base64') return decodeBytes(base64ToBytes(body), charset);
  if (cte === 'quoted-printable') return decodeBytes(qpToBytes(body), charset);
  // 7bit/8bit/binary: 文字コードだけ考慮 (UTF-8 想定が多いためそのまま)
  if (charset && !/utf-?8/i.test(charset)) {
    return decodeBytes(new Uint8Array([...body].map((c) => c.charCodeAt(0) & 0xff)), charset);
  }
  return body;
}
interface Part { headers: Record<string, string>; body: string; mediaType: string; params: Record<string, string> }
function splitMultipart(body: string, boundary: string): Part[] {
  const marker = `--${boundary}`;
  const segs = body.split(marker);
  const parts: Part[] = [];
  for (const seg of segs) {
    const s = seg.replace(/^\r?\n/, '');
    if (!s || s.startsWith('--')) continue; // 前段/終端
    const { head, body: pb } = splitHeadersBody(s);
    const headers = parseHeaders(head);
    const ct = parseContentType(headers['content-type']);
    parts.push({ headers, body: pb, mediaType: ct.mediaType, params: ct.params });
  }
  return parts;
}
/** multipart を再帰的に辿り text/plain と text/html を集める。 */
function collectTextParts(mediaType: string, params: Record<string, string>, body: string, headers: Record<string, string>, acc: { plain?: string; html?: string }): void {
  if (mediaType.startsWith('multipart/')) {
    const boundary = params['boundary'];
    if (!boundary) return;
    for (const p of splitMultipart(body, boundary)) collectTextParts(p.mediaType, p.params, p.body, p.headers, acc);
    return;
  }
  if (mediaType === 'text/plain' && acc.plain === undefined) acc.plain = decodePartBody(body, headers);
  else if (mediaType === 'text/html' && acc.html === undefined) acc.html = decodePartBody(body, headers);
}

function parseAddress(raw?: string): { name?: string; email?: string } {
  if (!raw) return {};
  const v = decodeHeaderValue(raw);
  const m = v.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>/) || v.match(/<([^>]+)>/);
  if (m && m.length === 3) return { name: (m[1] || '').trim() || undefined, email: (m[2] || '').trim() };
  const email = (v.match(/[^\s<>]+@[^\s<>]+/) || [])[0];
  return { name: email ? undefined : v.trim() || undefined, email };
}
function toIso(raw?: string): string | undefined {
  if (!raw) return undefined;
  const t = Date.parse(decodeHeaderValue(raw));
  return Number.isNaN(t) ? undefined : new Date(t).toISOString();
}

/** HTML → プレーンテキスト。ブロック要素を改行化 (開きタグ削除で前段の \n を
 *  eat しないよう順序に注意)。 */
export function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    // テキスト直後の <br> がブロック閉じの直前にある場合は冗長 (二重改行になる)
    //  → 除去。ただし <div><br></div> 等「<br> が唯一の中身=意図的な空行」は残す。
    .replace(/([^>\s])\s*<br\s*\/?>\s*(<\/(?:p|div|li|tr|h[1-6])>)/gi, '$1$2')
    .replace(/<\/(p|div|li|tr|h[1-6])>\s*/gi, '\n')
    // <br> は改行に。前後の空白は詰めるが改行 (\n) は残す (空段落=空行を保持)。
    .replace(/[ \t]*<br\s*\/?>[ \t]*/gi, '\n')
    // 開きタグ除去。後続の空白は詰めるが改行 (\n) は残す (空段落=空行を保持)。
    .replace(/<(p|div|li|tr|h[1-6])[^>]*>[ \t]*/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ── RTF から埋め込み HTML を復元 (MS-OXRTFEX de-encapsulation) ─────────────────
// Outlook の .msg は HTML を PidTagBodyHtml ではなく PidTagRtfCompressed
// (compressedRtf) に「カプセル化 HTML」として持つことがある。decompressRTF で
// RTF に展開し、\htmltag / \htmlrtf を解釈して元の HTML を取り出す。
// これがメーラ表示に一致する正しい本文 (plain body は Outlook が二重行間化した劣化版)。
function cpDecoderName(cp?: string): string {
  const map: Record<string, string> = { '1252': 'windows-1252', '65001': 'utf-8', '932': 'shift_jis', '936': 'gbk', '949': 'euc-kr', '950': 'big5', '1250': 'windows-1250', '1251': 'windows-1251' };
  return (cp && map[cp]) || 'windows-1252';
}

/** カプセル化 HTML の RTF から元 HTML を復元する。非カプセル化 RTF は null。 */
export function deEncapsulateHtml(rtf: string): string | null {
  const head = rtf.slice(0, 2000);
  if (!/\\fromhtml1?\b/.test(head)) return null; // HTML カプセル化でなければ対象外
  const ansicpg = (rtf.match(/\\ansicpg(\d+)/) || [])[1];
  const decName = cpDecoderName(ansicpg);
  // ★ 日本語等はマルチバイト (Shift_JIS/cp932 の \'82\'a0 等) なので、連続する
  //   バイトを溜めてから codepage 単位でまとめてデコードする (1 バイトずつだと文字化け)。
  let decoder: TextDecoder;
  try { decoder = new TextDecoder(decName); } catch { decoder = new TextDecoder('windows-1252'); }

  interface Frame { htmlrtf: boolean; ignore: boolean; htmltag: boolean; uc: number }
  let cur: Frame = { htmlrtf: false, ignore: false, htmltag: false, uc: 1 };
  const stack: Frame[] = [];
  let out = '';
  let byteBuf: number[] = [];   // 未デコードのバイト列 (現在の emit 状態で確定済み)
  let skip = 0;                 // \uN の後に読み飛ばす代替文字数
  let expectDest = false;       // 直前に \* を見た (次の制御語は destination)
  const canEmit = (): boolean => cur.htmltag || (!cur.ignore && !cur.htmlrtf);
  const flush = (): void => { if (byteBuf.length) { out += decoder.decode(new Uint8Array(byteBuf)); byteBuf = []; } };
  const emitByte = (bb: number): void => { if (canEmit()) byteBuf.push(bb); };
  const emitStr = (t: string): void => { flush(); if (canEmit()) out += t; };

  const n = rtf.length;
  let i = 0;
  while (i < n) {
    const c = rtf[i]!;
    if (c === '{') { flush(); stack.push(cur); cur = { ...cur }; cur.htmltag = false; cur.ignore = false; i++; continue; }
    if (c === '}') { flush(); cur = stack.pop() ?? cur; i++; continue; }
    if (c === '\r' || c === '\n') { i++; continue; }
    if (c === '\\') {
      const nx = rtf[i + 1];
      if (nx === '*') { expectDest = true; i += 2; continue; }
      if (nx === '\\' || nx === '{' || nx === '}') { if (skip > 0) skip--; else emitByte(nx!.charCodeAt(0)); i += 2; continue; }
      if (nx === "'") {
        const b = parseInt(rtf.substr(i + 2, 2), 16); i += 4;
        if (skip > 0) { skip--; continue; }
        if (!Number.isNaN(b)) emitByte(b);
        continue;
      }
      const m = /^\\([a-zA-Z]+)(-?\d+)? ?/.exec(rtf.slice(i));
      if (m) {
        const word = m[1]!; const param = m[2] !== undefined ? parseInt(m[2], 10) : undefined;
        i += m[0].length;
        if (word === 'htmltag') { flush(); cur.htmltag = true; cur.ignore = false; }
        else if (word === 'htmlrtf') { flush(); cur.htmlrtf = param !== 0; }
        else if (word === 'par' || word === 'line') { emitStr('\n'); }
        else if (word === 'tab') { emitStr('\t'); }
        else if (word === 'lquote') emitStr('‘'); else if (word === 'rquote') emitStr('’');
        else if (word === 'ldblquote') emitStr('“'); else if (word === 'rdblquote') emitStr('”');
        else if (word === 'bullet') emitStr('•'); else if (word === 'endash') emitStr('–'); else if (word === 'emdash') emitStr('—');
        else if (word === 'uc') { if (param !== undefined) cur.uc = param; }
        else if (word === 'u') { if (param !== undefined) { const cp = param < 0 ? param + 65536 : param; if (skip > 0) skip--; else emitStr(String.fromCodePoint(cp)); skip = cur.uc; } }
        else if (expectDest && word !== 'htmltag') { flush(); cur.ignore = true; }
        expectDest = false;
        continue;
      }
      const sym = nx!; i += 2;
      if (skip > 0) { skip--; continue; }
      if (sym === '~') emitStr(' '); else if (sym === '_') emitStr('-'); else if (sym === '-') { /* optional hyphen */ } else emitByte(sym.charCodeAt(0));
      continue;
    }
    if (skip > 0) { skip--; i++; continue; }
    emitByte(c.charCodeAt(0)); i++;
  }
  flush();
  return out.trim() || null;
}

/** compressedRtf (Uint8Array) → 埋め込み HTML。取り出せなければ null。 */
export function htmlFromCompressedRtf(compressed: Uint8Array | number[]): string | null {
  try {
    const bytes = decompressRTF(Array.from(compressed) as number[]);
    let rtf = '';
    for (let i = 0; i < bytes.length; i++) rtf += String.fromCharCode(bytes[i]! & 0xff);
    return deEncapsulateHtml(rtf);
  } catch { return null; }
}

/** メール本文プレーンテキストの整形。
 *  ★ Outlook のプレーン本文は段落区切りを「空行 + 空白だけの行 + 空行」= 空行を
 *    2 つ以上入れて水増しする (実データで確認)。
 *  そこで「連続する空行 (空白だけの行を含む) は 1 つの空行にまとめる」方針にする。
 *  - 空白だけの行 (半角/全角スペース・タブ) は空行とみなす。
 *  - 空行の連続 (=段落区切りの水増し) は 1 つの空行 (\n\n) に統一。
 *  - 段落内の 1 行改行 (\n) と 1 つの空行 (段落区切り) はそのまま保持。 */
export function normalizeMailPlainText(s: string): string {
  return s
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\u3000]+\n/g, '\n')   // 空白だけの行 → 空行
    .replace(/\n{2,}/g, '\n\n')          // 連続する空行を 1 つの空行に統一
    .trim();
}

// ── メールの「最新本文」と「引用(過去履歴)」の分割 ─────────────────────────────
// 返信メールは Outlook/Gmail 等が引用ヘッダ (-----Original Message----- /
// 差出人:… / On … wrote: / > 引用 / blockquote 等) を付けて過去スレを累積する。
// UI では「最新の本文だけ」を表示したいので境界を控えめに検出して分割する。
export function splitQuotedReplyText(text: string): { latest: string; quoted: string | null } {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  let cut = -1;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? '';
    const line = raw.trim();
    if (!line) continue;
    if (/^-{2,}\s*(Original Message|元のメッセージ|転送されたメッセージ|Forwarded message)\s*-{2,}$/i.test(line)) { cut = i; break; }
    if (/^[_=]{20,}$/.test(line)) {
      for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
        if (/^(差出人|From|送信者|送信日時|Sent|To|宛先|Subject|件名)\s*[:：]/.test((lines[j] ?? '').trim())) { cut = i; break; }
      }
      if (cut >= 0) break;
    }
    if (/^On\b.+\bwrote\s*:?\s*$/i.test(line)
        || /^\d{4}[/年\-].+(さん|様)?[\s　]*(が|より)?[\s　]*(書きました|書いた|wrote)[\s　]*[:：]?\s*$/.test(line)) { cut = i; break; }
    if (/^(差出人|From|送信者)\s*[:：]/.test(line)) {
      for (let j = i + 1; j < Math.min(i + 6, lines.length); j++) {
        if (/^(送信日時|Sent|To|宛先|Cc|Subject|件名)\s*[:：]/.test((lines[j] ?? '').trim())) { cut = i; break; }
      }
      if (cut >= 0) break;
    }
    if (/^>/.test(raw)) {
      let consec = 1;
      for (let j = i + 1; j < lines.length && consec < 2; j++) {
        const ln = lines[j] ?? '';
        if (/^>/.test(ln)) consec++;
        else if (ln.trim() === '') continue;
        else break;
      }
      if (consec >= 2) { cut = i; break; }
    }
  }
  if (cut < 0) return { latest: text, quoted: null };
  const latest = lines.slice(0, cut).join('\n').replace(/\s+$/, '');
  const quoted = lines.slice(cut).join('\n');
  if (!latest.trim()) return { latest: text, quoted: null };
  return { latest, quoted };
}

/** HTML メール本文の「最新返信」と「引用部」を分割する (ブラウザ専用: DOMParser)。 */
export function splitQuotedReplyHtml(html: string): { latest: string; quoted: string | null } {
  if (typeof DOMParser === 'undefined') return { latest: html, quoted: null };
  const doc = new DOMParser().parseFromString('<div id="__r">' + html + '</div>', 'text/html');
  const root = doc.getElementById('__r');
  if (!root) return { latest: html, quoted: null };
  const stripCheck = (h: string): string => h.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');
  const HDR_FROM = /(差出人|From|送信者)\s*[:：]/;
  const HDR_OTHER = /(送信日時|Sent|To|宛先|Cc|CC|Subject|件名)\s*[:：]/;

  let marker: Element | null = null;
  for (const sel of ['div#divRplyFwdMsg', 'div#appendonsend', 'div.gmail_quote', 'div.gmail_quote_container', 'hr#stopSpelling', 'blockquote']) {
    const f = root.querySelector(sel); if (f) { marker = f; break; }
  }
  if (!marker) {
    for (const div of Array.from(root.querySelectorAll('div'))) {
      const style = (div.getAttribute('style') || '').toLowerCase();
      if (!/border-top\s*:/.test(style)) continue;
      const text = (div.textContent || '').trim().slice(0, 250);
      if (HDR_FROM.test(text)) { marker = div; break; }
    }
  }
  if (!marker) {
    for (const elem of Array.from(root.querySelectorAll('div, p, blockquote, table, section, article'))) {
      const text = (elem.textContent || '').trim().slice(0, 800);
      if (text && HDR_FROM.test(text) && HDR_OTHER.test(text)) { marker = elem; break; }
    }
  }
  if (!marker) return { latest: html, quoted: null };
  let top: Element = marker;
  while (top.parentElement && top.parentElement !== root) top = top.parentElement;

  const latestParts: string[] = [];
  const quotedParts: string[] = [];
  let inQuoted = false;
  for (const child of Array.from(root.childNodes)) {
    if (child === top) inQuoted = true;
    const h = child instanceof Element ? child.outerHTML : (child.textContent ?? '');
    (inQuoted ? quotedParts : latestParts).push(h);
  }
  const latest = latestParts.join('');
  if (!stripCheck(latest).trim()) return { latest: html, quoted: null };
  return { latest, quoted: quotedParts.join('') };
}

/** .eml (RFC 2822) を解析する。 */
export function parseEml(src: string): ParsedMail {
  const { head, body } = splitHeadersBody(src);
  const headers = parseHeaders(head);
  const ct = parseContentType(headers['content-type']);
  const acc: { plain?: string; html?: string } = {};
  collectTextParts(ct.mediaType, ct.params, body, headers, acc);
  const from = parseAddress(headers['from']);
  const plain = acc.plain ?? (acc.html ? stripHtml(acc.html) : '');
  return {
    subject: headers['subject'] ? decodeHeaderValue(headers['subject']) : undefined,
    fromName: from.name,
    fromEmail: from.email,
    dateISO: toIso(headers['date']),
    body: plain.replace(/\r\n/g, '\n').replace(/[ \t]+\n/g, '\n').trim(),
    bodyHtml: acc.html,
  };
}

/** Windows Outlook のドラッグ (text/plain) ヘッダを解析する。 */
export function parseOutlookDragText(text: string): ParsedMail {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const out: ParsedMail = {};
  let bodyStart = 0;
  const fromRe = /^(From|差出人)\s*[:：]\s*(.+)$/i;
  const sentRe = /^(Sent|送信日時|日付)\s*[:：]\s*(.+)$/i;
  const subjRe = /^(Subject|件名)\s*[:：]\s*(.+)$/i;
  for (let i = 0; i < Math.min(lines.length, 12); i++) {
    const l = lines[i]!;
    let m;
    if ((m = fromRe.exec(l))) { const a = parseAddress(m[2]); out.fromName = a.name ?? m[2]!.trim(); out.fromEmail = a.email; bodyStart = i + 1; }
    else if ((m = sentRe.exec(l))) { out.dateISO = toIso(m[2]) ?? out.dateISO; bodyStart = i + 1; }
    else if ((m = subjRe.exec(l))) { out.subject = m[2]!.trim(); bodyStart = i + 1; }
  }
  out.body = lines.slice(bodyStart).join('\n').trim();
  return out;
}

/** .msg (Outlook for Windows バイナリ) を @kenjiuno/msgreader で解析する。 */
export async function parseMsgFile(file: File): Promise<ParsedMail> {
  const buf = await file.arrayBuffer();
  // CJS default 取り扱いは esbuild に任せる (dynamic import だと二段ネストになる
  // ケースがあったため静的 import に統一)。
  const Ctor = ((MsgReader as unknown) as { default?: unknown }).default ?? MsgReader;
  const reader = new (Ctor as new (b: ArrayBuffer) => { getFileData: () => Record<string, unknown> })(buf);
  const data = reader.getFileData();
  const str = (k: string): string | undefined => { const v = data[k]; return typeof v === 'string' && v.trim() ? v.trim() : undefined; };

  // 送信日時: clientSubmitTime → messageDeliveryTime → creation/modification。
  // msgreader は PT_SYSTIME を UTCString で返す。1980〜2100 外は壊れ値として排除。
  let dateISO: string | undefined;
  for (const k of ['clientSubmitTime', 'messageDeliveryTime', 'creationTime', 'lastModificationTime']) {
    const v = str(k);
    if (!v) continue;
    const t = Date.parse(v);
    if (Number.isNaN(t)) continue;
    const y = new Date(t).getUTCFullYear();
    if (y < 1980 || y > 2100) continue;
    dateISO = new Date(t).toISOString();
    break;
  }

  // HTML 本文: bodyHtml (文字列) → html (バイナリ) → compressedRtf のカプセル化 HTML。
  let bodyHtml = str('bodyHtml');
  let htmlSource = bodyHtml ? 'bodyHtml' : '';
  if (!bodyHtml) {
    const htmlBytes = (data as { html?: unknown }).html;
    if (htmlBytes instanceof Uint8Array && htmlBytes.length) {
      let raw = new TextDecoder('utf-8').decode(htmlBytes);
      const cm = raw.match(/charset\s*=\s*["']?([\w-]+)/i);
      if (cm && cm[1] && !/utf-?8/i.test(cm[1])) { try { raw = new TextDecoder(cm[1].toLowerCase()).decode(htmlBytes); } catch { /* 非対応 charset は UTF-8 */ } }
      bodyHtml = raw.trim() || undefined;
      if (bodyHtml) htmlSource = 'html(bin)';
    }
  }
  if (!bodyHtml) {
    const rtf = (data as { compressedRtf?: unknown }).compressedRtf;
    if (rtf instanceof Uint8Array && rtf.length) {
      bodyHtml = htmlFromCompressedRtf(rtf) ?? undefined;
      if (bodyHtml) htmlSource = 'compressedRtf';
    }
  }

  // plain 本文: HTML があれば HTML から整形して使う (メーラ表示に一致)。
  //  ★ plain body は Outlook が二重行間化した劣化版なので、HTML があれば必ず優先。
  const body = bodyHtml ? (stripHtml(bodyHtml) || undefined) : str('body');

  // 診断ログ (実データ確認用・原因確定後に除去)。
  try {
    const prev = (s: string | undefined): string => JSON.stringify((s ?? '').slice(0, 400));
    console.log('[mikke/msg] htmlSource:', htmlSource || 'none(plainのみ)');
    console.log('[mikke/msg] bodyHtml preview:', prev(bodyHtml));
    console.log('[mikke/msg] chosen body preview:', prev(body));
  } catch { /* noop */ }

  // 送信元: SMTP を優先。EX アドレス (/o=ExchangeLabs/…) は @ が無いので除外。
  const senderSmtp = str('senderSmtpAddress') ?? str('sentRepresentingSmtpAddress');
  const senderEx = str('senderEmail');
  let fromEmail: string | undefined;
  if (senderSmtp && /@/.test(senderSmtp)) fromEmail = senderSmtp;
  else if (senderEx && /@/.test(senderEx)) fromEmail = senderEx;

  return {
    subject: str('subject'),
    fromName: str('senderName'),
    fromEmail,
    dateISO,
    body: body?.replace(/\r\n/g, '\n').trim(),
    bodyHtml,
  };
}

// ── 判定 ────────────────────────────────────────────────────────────────────
export function looksLikeEml(text: string): boolean {
  return /^(from|subject|date|to|content-type|message-id)\s*:/im.test(text.slice(0, 2000)) && /\n\s*\n/.test(text);
}
export function looksLikeOutlookDrag(text: string): boolean {
  return /^(From|差出人)\s*[:：]/im.test(text) && /^(Subject|件名|Sent|送信日時)\s*[:：]/im.test(text);
}
