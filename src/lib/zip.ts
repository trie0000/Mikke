// zip.ts — 依存なしの ZIP 生成 (DEFLATE 圧縮、非対応環境は STORED フォールバック)。
//
// ブラウザ標準の CompressionStream('deflate-raw') で各エントリを圧縮する。
// 未対応 (古い環境) では無圧縮 (STORED) で格納する。いずれも正しい .zip。
// xlsx.ts の buildZip は STORED 専用の内部関数なので、汎用の圧縮版をここに置く。

export interface ZipInput {
  /** zip 内のパス (例: 'vuln.csv')。 */
  name: string;
  /** ファイル内容。 */
  data: Uint8Array;
}

// ── CRC32 (xlsx.ts と同一多項式) ──────────────────────────────────────────────
let CRC_TABLE: Uint32Array | null = null;
function crcTable(): Uint32Array {
  if (CRC_TABLE) return CRC_TABLE;
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  CRC_TABLE = t;
  return t;
}
function crc32(buf: Uint8Array): number {
  const t = crcTable();
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = t[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const u16 = (n: number): Uint8Array => new Uint8Array([n & 0xff, (n >>> 8) & 0xff]);
const u32 = (n: number): Uint8Array =>
  new Uint8Array([n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]);

function concat(parts: Uint8Array[]): Uint8Array {
  const len = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** raw DEFLATE 圧縮。CompressionStream 非対応なら null (= STORED)。 */
async function deflateRaw(data: Uint8Array): Promise<Uint8Array | null> {
  const CS = (globalThis as { CompressionStream?: typeof CompressionStream }).CompressionStream;
  if (typeof CS !== 'function') return null;
  try {
    const cs = new CS('deflate-raw');
    const stream = new Blob([data as BlobPart]).stream().pipeThrough(cs);
    const buf = await new Response(stream).arrayBuffer();
    return new Uint8Array(buf);
  } catch {
    return null;
  }
}

/** 複数ファイルを 1 つの zip (Blob) にまとめる。可能なら DEFLATE 圧縮する。 */
export async function zipFiles(entries: ZipInput[]): Promise<Blob> {
  const enc = new TextEncoder();
  const locals: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  for (const e of entries) {
    const nameBytes = enc.encode(e.name);
    const crc = crc32(e.data);
    const rawSize = e.data.length;
    const compressed = await deflateRaw(e.data);
    // 圧縮が効かない (逆に増える) 場合は STORED を選ぶ。
    const useDeflate = compressed != null && compressed.length < rawSize;
    const method = useDeflate ? 8 : 0;
    const payload = useDeflate ? compressed! : e.data;

    const local = concat([
      u32(0x04034b50), u16(20), u16(0), u16(method), u16(0), u16(0),
      u32(crc), u32(payload.length), u32(rawSize),
      u16(nameBytes.length), u16(0), nameBytes, payload,
    ]);
    locals.push(local);
    central.push(concat([
      u32(0x02014b50), u16(20), u16(20), u16(0), u16(method), u16(0), u16(0),
      u32(crc), u32(payload.length), u32(rawSize),
      u16(nameBytes.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset),
      nameBytes,
    ]));
    offset += local.length;
  }

  const centralBlob = concat(central);
  const eocd = concat([
    u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length),
    u32(centralBlob.length), u32(offset), u16(0),
  ]);
  return new Blob([concat([...locals, centralBlob, eocd]) as BlobPart], { type: 'application/zip' });
}
