// メール取込パーサ (.eml / .msg / Outlook ドラッグテキスト)。
//   - .eml: RFC 2822 を自前解析 (依存なし)。encoded-word / quoted-printable /
//           base64 / multipart(alternative) / 主要日本語文字コードに対応。
//   - .msg: Outlook (Windows) バイナリ (CFB/OLE2)。自前パーサ (依存なし・ブラウザ安全)。
//   - Outlook ドラッグ: Windows Outlook のドラッグ text/plain ヘッダ。
// UI 非依存。テストは test/emlParser.test.ts。

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

/** HTML → プレーンテキスト (簡易)。 */
export function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
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

// ── .msg (CFB/OLE2) 自前パーサ ────────────────────────────────────────────────
// .msg は OLE2 複合ファイル。MAPI プロパティは "__substg1.0_<PROPID><TYPE>" という
// ストリーム名で格納される。必要な文字列/HTML/日時だけ取り出す。
const CFB_ENDOFCHAIN = 0xfffffffe;
const CFB_FREESECT = 0xffffffff;

function readCfbStreams(buf: ArrayBuffer): Map<string, Uint8Array> {
  const b = new Uint8Array(buf);
  const dv = new DataView(buf);
  const sig = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
  for (let i = 0; i < 8; i++) if (b[i] !== sig[i]) throw new Error('.msg (CFB) 形式ではありません');
  const u16 = (o: number): number => dv.getUint16(o, true);
  const u32 = (o: number): number => dv.getUint32(o, true);
  const sectorSize = 1 << u16(30);
  const miniSectorSize = 1 << u16(32);
  const firstDirSector = u32(48);
  const miniCutoff = u32(56);
  const firstMiniFat = u32(60);
  const firstDifat = u32(68);
  const numDifat = u32(72);
  const secOff = (sid: number): number => 512 + sid * sectorSize;

  // FAT (DIFAT: ヘッダ内 109 個 + チェーン)
  const fatSectors: number[] = [];
  for (let i = 0; i < 109; i++) { const s = u32(76 + i * 4); if (s !== CFB_FREESECT) fatSectors.push(s); }
  let difat = firstDifat, guard = 0;
  while (difat !== CFB_ENDOFCHAIN && difat !== CFB_FREESECT && numDifat > 0 && guard++ < 1000) {
    const base = secOff(difat);
    const perSector = sectorSize / 4;
    for (let i = 0; i < perSector - 1; i++) { const s = u32(base + i * 4); if (s !== CFB_FREESECT) fatSectors.push(s); }
    difat = u32(base + (perSector - 1) * 4);
  }
  const fat: number[] = [];
  for (const fs of fatSectors) { const base = secOff(fs); for (let i = 0; i < sectorSize / 4; i++) fat.push(u32(base + i * 4)); }

  const readChain = (start: number, size?: number): Uint8Array => {
    const parts: number[] = [];
    let sid = start, g = 0;
    while (sid !== CFB_ENDOFCHAIN && sid !== CFB_FREESECT && g++ < 1_000_000) {
      const o = secOff(sid);
      for (let i = 0; i < sectorSize; i++) parts.push(b[o + i] ?? 0);
      sid = fat[sid] ?? CFB_ENDOFCHAIN;
    }
    const arr = new Uint8Array(parts);
    return size != null && size < arr.length ? arr.subarray(0, size) : arr;
  };

  // ディレクトリ
  const dir = readChain(firstDirSector);
  const ddv = new DataView(dir.buffer, dir.byteOffset, dir.byteLength);
  const entries: { name: string; type: number; start: number; size: number }[] = [];
  for (let off = 0; off + 128 <= dir.length; off += 128) {
    const nameLen = ddv.getUint16(off + 64, true);
    if (nameLen <= 0) continue;
    let name = '';
    for (let i = 0; i < nameLen - 2; i += 2) name += String.fromCharCode(ddv.getUint16(off + i, true));
    entries.push({ name, type: dir[off + 66]!, start: ddv.getUint32(off + 116, true), size: ddv.getUint32(off + 120, true) });
  }
  const root = entries.find((e) => e.type === 5);
  const miniStream = root ? readChain(root.start, root.size) : new Uint8Array(0);
  const miniFatRaw = firstMiniFat !== CFB_ENDOFCHAIN ? readChain(firstMiniFat) : new Uint8Array(0);
  const miniFat: number[] = [];
  { const mdv = new DataView(miniFatRaw.buffer, miniFatRaw.byteOffset, miniFatRaw.byteLength);
    for (let i = 0; i + 4 <= miniFatRaw.length; i += 4) miniFat.push(mdv.getUint32(i, true)); }
  const readMini = (start: number, size: number): Uint8Array => {
    const parts: number[] = [];
    let sid = start, g = 0;
    while (sid !== CFB_ENDOFCHAIN && sid !== CFB_FREESECT && g++ < 1_000_000) {
      const o = sid * miniSectorSize;
      for (let i = 0; i < miniSectorSize; i++) parts.push(miniStream[o + i] ?? 0);
      sid = miniFat[sid] ?? CFB_ENDOFCHAIN;
    }
    return new Uint8Array(parts).subarray(0, size);
  };

  const out = new Map<string, Uint8Array>();
  for (const e of entries) {
    if (e.type !== 2) continue;
    out.set(e.name, e.size < miniCutoff ? readMini(e.start, e.size) : readChain(e.start, e.size));
  }
  return out;
}

function filetimeToIso(bytes: Uint8Array): string | undefined {
  if (bytes.length < 8) return undefined;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, 8);
  const lo = dv.getUint32(0, true), hi = dv.getUint32(4, true);
  const ft = hi * 4294967296 + lo; // 100ns since 1601
  if (ft === 0) return undefined;
  const ms = Math.floor(ft / 10000) - 11644473600000;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}
/** __properties ストリームから FILETIME プロパティ (tag) を探す。 */
function findFiletime(props: Uint8Array | undefined, tag: number): string | undefined {
  if (!props) return undefined;
  const t = [tag & 0xff, (tag >>> 8) & 0xff, (tag >>> 16) & 0xff, (tag >>> 24) & 0xff];
  for (let i = 0; i + 16 <= props.length; i += 8) {
    if (props[i] === t[0] && props[i + 1] === t[1] && props[i + 2] === t[2] && props[i + 3] === t[3]) {
      return filetimeToIso(props.subarray(i + 8, i + 16));
    }
  }
  return undefined;
}

/** .msg (Outlook for Windows バイナリ) を解析する。 */
export async function parseMsgFile(file: File): Promise<ParsedMail> {
  const streams = readCfbStreams(await file.arrayBuffer());
  const getStr = (propId: string): string | undefined => {
    const uni = streams.get(`__substg1.0_${propId}001F`);
    if (uni) { let s = ''; const dv = new DataView(uni.buffer, uni.byteOffset, uni.byteLength); for (let i = 0; i + 2 <= uni.length; i += 2) s += String.fromCharCode(dv.getUint16(i, true)); return s || undefined; }
    const asc = streams.get(`__substg1.0_${propId}001E`);
    if (asc) return decodeBytes(asc).replace(/\0+$/, '') || undefined;
    return undefined;
  };
  const html = getStr('1013') ?? (() => { const bin = streams.get('__substg1.0_10130102'); return bin ? decodeBytes(bin) : undefined; })();
  const plain = getStr('1000') ?? (html ? stripHtml(html) : undefined);
  const props = streams.get('__properties_version1.0');
  const dateISO = findFiletime(props, 0x00390040) ?? findFiletime(props, 0x0e060040);
  const smtp = getStr('5D01') ?? getStr('0C1F');
  return {
    subject: getStr('0037'),
    fromName: getStr('0C1A'),
    fromEmail: smtp && smtp.includes('@') ? smtp : undefined,
    dateISO,
    body: plain?.replace(/\r\n/g, '\n').replace(/\0+$/, '').trim(),
    bodyHtml: html,
  };
}

// ── 判定 ────────────────────────────────────────────────────────────────────
export function looksLikeEml(text: string): boolean {
  return /^(from|subject|date|to|content-type|message-id)\s*:/im.test(text.slice(0, 2000)) && /\n\s*\n/.test(text);
}
export function looksLikeOutlookDrag(text: string): boolean {
  return /^(From|差出人)\s*[:：]/im.test(text) && /^(Subject|件名|Sent|送信日時)\s*[:：]/im.test(text);
}
