// PowerShell 中継サーバ (localhost) クライアント。
// 役割: 大容量 CSV 解析 (/mikke/csv-parse) と 検査ツール API 中継 (/mikke/issue・雛形)。

const DEFAULT_BASE = 'http://127.0.0.1:18080/mikke';

export function getRelayBase(): string {
  try {
    return (localStorage.getItem('mikke.relay.base') || DEFAULT_BASE).replace(/\/+$/, '');
  } catch { return DEFAULT_BASE; }
}

export interface RelayHealth { ok: boolean; version?: string; }

/** /mikke/health — 起動確認。 */
export async function relayHealth(): Promise<RelayHealth> {
  try {
    const r = await fetch(`${getRelayBase()}/health`, { method: 'GET' });
    if (!r.ok) return { ok: false };
    return await r.json();
  } catch { return { ok: false }; }
}

export interface CsvParseResult {
  ok: boolean;
  headers: string[];
  /** パース済み行 (連想配列)。差分判定はブラウザ側 import.ts が行う。 */
  rows: Record<string, string>[];
  rowCount: number;
}

/** csv-parse の進捗フェーズ。upload=送信バイト / server=サーバ解析待ち /
 *  download=応答受信バイト。total=0 は総量不明 (不確定表示)。 */
export type CsvParsePhase = 'upload' | 'server' | 'download';

/** /mikke/csv-parse — 大容量 CSV をサーバ側でパース (主経路)。
 *  役割分担: サーバは CSV→行配列 のパースのみ。差分判定は import.ts。
 *  100MB 級のメモリ負荷をサーバ側に逃がす。
 *  XHR を使うのは進捗 (upload.onprogress / onprogress) を取るため。 */
export function relayCsvParse(
  file: File,
  onProgress?: (phase: CsvParsePhase, done: number, total: number) => void,
): Promise<CsvParseResult> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${getRelayBase()}/csv-parse`);
    xhr.responseType = 'json';
    xhr.upload.onprogress = (e) => {
      onProgress?.('upload', e.loaded, e.lengthComputable ? e.total : file.size);
    };
    xhr.upload.onload = () => onProgress?.('server', 0, 0);   // 送信完了 → サーバ解析待ち
    xhr.onprogress = (e) => {
      onProgress?.('download', e.loaded, e.lengthComputable ? e.total : 0);
    };
    xhr.onload = () => {
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(new Error(`csv-parse failed: HTTP ${xhr.status}`));
        return;
      }
      resolve(xhr.response as CsvParseResult);
    };
    xhr.onerror = () => reject(new Error('csv-parse failed: ネットワークエラー'));
    const form = new FormData();
    form.append('file', file);
    xhr.send(form);
  });
}

export interface RelayVersionInfo { version: string; files: string[]; }

/** GET /mikke/relay/version — 動作中 relay スクリプトの版と管理ファイル一覧。
 *  relay 未起動なら null。 */
export async function relayGetVersion(): Promise<RelayVersionInfo | null> {
  try {
    const r = await fetch(`${getRelayBase()}/relay/version`, { method: 'GET' });
    if (!r.ok) return null;
    const j = await r.json();
    return { version: String(j.version ?? ''), files: Array.isArray(j.files) ? (j.files as string[]) : [] };
  } catch { return null; }
}

/** POST /mikke/relay/self-update — 新しい relay ファイル (base64) を送って
 *  relay 自身に入れ替え＆再起動させる。relay は 200 応答後 ~1 秒で exit する。 */
export async function relaySelfUpdate(files: { name: string; contentBase64: string }[]): Promise<void> {
  const r = await fetch(`${getRelayBase()}/relay/self-update`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ files }),
  });
  if (!r.ok) {
    let detail = `HTTP ${r.status}`;
    try { const j = await r.json(); if (j?.error?.detail) detail = j.error.detail; } catch { /* noop */ }
    throw new Error(detail);
  }
}

export interface RelayBundleDir { ok: boolean; dir: string; bundleExists?: boolean; }

/** GET /mikke/bundle-dir — relay が mikke.bundle.js / version.txt を読む現在の
 *  ディレクトリを照会。 */
export async function relayGetBundleDir(): Promise<RelayBundleDir> {
  const r = await fetch(`${getRelayBase()}/bundle-dir`, { method: 'GET' });
  if (!r.ok) throw new Error(`bundle-dir get failed: HTTP ${r.status}`);
  return await r.json();
}

/** POST /mikke/bundle-dir — relay の配信ディレクトリを変更 (開発用)。
 *  relay 側で存在チェックし、存在しなければ 400 を返す。 */
export async function relaySetBundleDir(dir: string): Promise<RelayBundleDir> {
  const r = await fetch(`${getRelayBase()}/bundle-dir`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dir }),
  });
  if (!r.ok) {
    let detail = `HTTP ${r.status}`;
    try { const j = await r.json(); if (j?.error?.detail) detail = j.error.detail; } catch { /* noop */ }
    throw new Error(detail);
  }
  return await r.json();
}

export interface RelayIssueResult {
  scannerStatus?: string;
  severity?: string;
  lastSeen?: string;
  scanFields?: Record<string, string>;
}

/** /mikke/issue — 検査ツール API を Issue 単位で中継 (F3・雛形)。
 *  ※ API 仕様は社内限定のため、サーバ側はスタブ。I/F のみ固定。 */
export async function relayGetIssue(issueInstanceId: string): Promise<RelayIssueResult> {
  const r = await fetch(`${getRelayBase()}/issue`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ issueInstanceId }),
  });
  if (!r.ok) throw new Error(`issue fetch failed: HTTP ${r.status}`);
  return await r.json();
}
