// PowerShell 中継サーバ (localhost) クライアント。
// 役割: 大容量 CSV 解析 (/mikke/csv-parse) と 検査ツール API 中継 (/mikke/issue・雛形)。
//
// ★ 検査ツールの API ベース URL / API キーは **リクエストごとに引数で渡す**。
//   relay の .env には置かない (秘密情報を配布物・リポジトリに混ぜないため)。
//   設定は各自のブラウザに保存する (utils/scannerApi.ts)。
import { scannerApiArgs } from '../utils/scannerApi';

// ★ Mikke に割り当てたポート (共通ガイド §14.2 の採番表: relay 18120 / CDP 19320)。
const DEFAULT_PORT = 18120;
const DEFAULT_BASE = `http://127.0.0.1:${DEFAULT_PORT}/mikke`;
/** 接続先の記憶場所。**人が設定する項目ではない**。
 *  ★ ポートの指定は mikke-relay.env の MIKKE_RELAY_PORT だけ。ここはその結果を
 *    覚えておくキャッシュで、次の 2 つが書く:
 *      - ランチャー (mikke-launch.ps1) … 起動時に実際のポートを書き込む
 *      - 自動探索 (discoverRelayBase)  … ブックマークレット起動などで見つけたもの
 *    画面に設定欄を置くと env と二重管理になり、片方だけ直して繋がらなくなる。 */
const BASE_KEY = 'mikke.relay.base';
/** 自動探索で当たるポートの数 (既定ポートから連番)。 */
const SCAN_COUNT = 20;

export function getRelayBase(): string {
  try {
    return (localStorage.getItem(BASE_KEY) || DEFAULT_BASE).replace(/\/+$/, '');
  } catch { return DEFAULT_BASE; }
}

/** 見つけた接続先を覚える (次回から探さない)。 */
function rememberRelayBase(base: string): void {
  try { localStorage.setItem(BASE_KEY, base.replace(/\/+$/, '')); } catch { /* noop */ }
}

/** その接続先が応答するか (短めに打ち切る)。 */
async function pingRelay(base: string, timeoutMs = 1500): Promise<boolean> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(`${base}/health`, { method: 'GET', signal: ac.signal });
    return r.ok;
  } catch { return false; } finally { clearTimeout(timer); }
}

/**
 * 接続先を自動で見つける。
 * ★ MIKKE_RELAY_PORT を既定から変えても、画面で設定し直さなくて済むようにするため。
 *   ランチャー起動なら起動時に書き込まれるのでここは通らない。ブックマークレット
 *   起動や、ポートを変えた直後だけ効く。
 * ★ 既定ポートから連番で当たる (18120, 18121, …)。閉じているポートへの fetch は
 *   即座に失敗するので、並列に投げてしまってよい。
 */
export async function discoverRelayBase(): Promise<string | null> {
  const seen = new Set<string>();
  const cands: string[] = [];
  const add = (b: string): void => {
    const v = b.replace(/\/+$/, '');
    if (!seen.has(v)) { seen.add(v); cands.push(v); }
  };
  add(getRelayBase());
  for (let i = 0; i < SCAN_COUNT; i++) add(`http://127.0.0.1:${DEFAULT_PORT + i}/mikke`);
  const hits = await Promise.all(cands.map(async (b) => ((await pingRelay(b)) ? b : null)));
  const found = hits.find((b): b is string => !!b) ?? null;
  if (found) rememberRelayBase(found);
  return found;
}

export interface RelayHealth { ok: boolean; version?: string; }

/** /mikke/health — 起動確認。
 *  ★ 覚えている接続先で駄目なら 1 度だけ自動探索する。ポートを env で変えた直後や、
 *    ブックマークレットで開いたときに、画面の設定を触らずに繋がるようにするため。 */
export async function relayHealth(): Promise<RelayHealth> {
  const ask = async (base: string): Promise<RelayHealth | null> => {
    try {
      const r = await fetch(`${base}/health`, { method: 'GET' });
      if (!r.ok) return null;
      return await r.json() as RelayHealth;
    } catch { return null; }
  };
  const first = await ask(getRelayBase());
  if (first) return first;
  const found = await discoverRelayBase();
  if (!found) return { ok: false };
  return (await ask(found)) ?? { ok: false };
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

// ★ 配信ディレクトリを変更する API (POST /mikke/bundle-dir) は呼ばない。
//   指定は mikke-relay.env の MIKKE_BUNDLE_DIR だけにする (画面からは表示のみ)。

export interface RelayIssueResult {
  scannerStatus?: string;
  severity?: string;
  lastSeen?: string;
  scanFields?: Record<string, string>;
  /** 現在も検出されているか (アダプタが正規化して返す。省略 = 検知ステータスを変更しない)。
   *  true → 継続/再検知、false → 未検出(New)/未検出 へ CSV 取込と同じ遷移を適用する。 */
  detected?: boolean;
}

/** /mikke/issue — 検査ツール API を Issue 単位で中継 (F3)。
 *  実装は relay 側の mikke-scanner-adapter.ps1 (委託先環境で作成) に委譲される。
 *  未配置 (501) / アダプタエラー (502) は detail をそのままエラーメッセージにする。 */
export async function relayGetIssue(issueInstanceId: string): Promise<RelayIssueResult> {
  const r = await fetch(`${getRelayBase()}/issue`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ issueInstanceId, ...scannerApiArgs() }),
  });
  if (!r.ok) {
    let detail = `HTTP ${r.status}`;
    try { const j = await r.json(); if (j?.error?.detail) detail = j.error.detail; } catch { /* noop */ }
    throw new Error(detail);
  }
  return await r.json();
}

/** /mikke/issue-report が返す 1 件分のレポート。 */
export interface RelayIssueReport {
  ok: boolean;
  /** 検査ツールが付けたファイル名 (通常 zip)。 */
  fileName: string;
  /** ファイル内容 (base64)。 */
  contentBase64: string;
  /** 検査ツール側のエクスポート日時 (ISO 文字列。任意)。 */
  scannerDownloadTime?: string;
}

/** /mikke/issue-report — 脆弱性 1 件分のレポートを取得 (アダプタ委譲)。
 *  実装は relay 側の mikke-scanner-adapter.ps1 の Invoke-MikkeScannerIssueReport。
 *  未配置 (501) はアダプタ未実装。呼び出し側は情報更新を止めずにスキップする。 */
export async function relayGetIssueReport(issueInstanceId: string): Promise<RelayIssueReport> {
  const r = await fetch(`${getRelayBase()}/issue-report`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ issueInstanceId, ...scannerApiArgs() }),
  });
  if (!r.ok) {
    let detail = `HTTP ${r.status}`;
    try { const j = await r.json(); if (j?.error?.detail) detail = j.error.detail; } catch { /* noop */ }
    const err = new Error(detail) as Error & { status?: number };
    err.status = r.status;
    throw err;
  }
  return await r.json();
}

/** /mikke/issues が返す 1 件分 (情報 + 任意でレポート)。 */
export interface RelayIssueBatchItem extends RelayIssueResult {
  issueInstanceId: string;
  /** この 1 件の取得に成功したか。false なら error にメッセージが入る。 */
  ok: boolean;
  error?: string;
  /** レポート本体。アダプタ未実装 / 取得失敗のときは無い。 */
  report?: { fileName: string; contentBase64: string; scannerDownloadTime?: string };
  /** アダプタに個別レポートの実装が無い (= 以降も取れない)。 */
  reportSkipped?: boolean;
  /** レポートだけの失敗理由 (情報更新は成功している)。 */
  reportError?: string;
}

/** /mikke/issues — 複数件の情報 (+レポート) を relay 側の runspace プールで並列取得。
 *  ★ relay の request loop は 1 リクエストずつしか処理しないため、ブラウザから
 *    /mikke/issue を並列に投げても直列化される。並列化は relay 内で行う。 */
export async function relayGetIssues(
  issueInstanceIds: string[], includeReport: boolean,
): Promise<RelayIssueBatchItem[]> {
  const r = await fetch(`${getRelayBase()}/issues`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ issueInstanceIds, includeReport, ...scannerApiArgs() }),
  });
  if (!r.ok) {
    let detail = `HTTP ${r.status}`;
    try { const j = await r.json(); if (j?.error?.detail) detail = j.error.detail; } catch { /* noop */ }
    const err = new Error(detail) as Error & { status?: number };
    err.status = r.status;
    throw err;
  }
  const j = await r.json();
  return (j.items ?? []) as RelayIssueBatchItem[];
}

/** /mikke/download が返す 1 ファイル。content は base64 (バイナリ安全)。 */
export interface RelayDownloadItem {
  /** 種別 (vuln / ip / iprange / domain / cert / webapps)。 */
  type: string;
  /** 元ファイル名 (例: vulnerabilities.csv)。 */
  fileName: string;
  /** ファイル内容 (base64)。 */
  contentBase64: string;
  /** 検査ツール側のエクスポート日時 (ISO 文字列。任意)。 */
  scannerDownloadTime?: string;
  /** 元データ件数 (任意・参考)。 */
  itemCount?: number;
}

export interface RelayDownloadResult {
  ok: boolean;
  items: RelayDownloadItem[];
}

/** /mikke/merge が返すマージ結果 (取込用 CSV 1 ファイル)。 */
export interface RelayMergeResult {
  ok: boolean;
  /** 生成された CSV のファイル名 (例: merged_2026_Jul_05.csv)。 */
  fileName: string;
  /** CSV 本体 (base64)。通常の CSV 取込と同じ列構成。 */
  contentBase64: string;
  /** データ行数 (任意・参考)。 */
  rowCount?: number;
}

/** /mikke/merge — ダウンロード済みファイル群から「脆弱性＋資産」マージ CSV を生成 (アダプタ委譲)。
 *  実装は relay 側の mikke-scanner-adapter.ps1 の Invoke-MikkeScannerMerge に委譲。 */
export async function relayMergeReports(
  files: { type: string; fileName: string; contentBase64: string }[],
): Promise<RelayMergeResult> {
  const r = await fetch(`${getRelayBase()}/merge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ files }),
  });
  if (!r.ok) {
    let detail = `HTTP ${r.status}`;
    try { const j = await r.json(); if (j?.error?.detail) detail = j.error.detail; } catch { /* noop */ }
    throw new Error(detail);
  }
  return await r.json();
}

/** /mikke/download — 検査ツールから脆弱性/資産データを一括取得 (アダプタ委譲)。
 *  実装は relay 側の mikke-scanner-adapter.ps1 の Invoke-MikkeScannerDownload に委譲。
 *  未配置 (501) / アダプタエラー (502) は detail をそのままエラーメッセージにする。 */
export async function relayDownloadFromScanner(types: string[]): Promise<RelayDownloadResult> {
  const r = await fetch(`${getRelayBase()}/download`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ types, ...scannerApiArgs() }),
  });
  if (!r.ok) {
    let detail = `HTTP ${r.status}`;
    try { const j = await r.json(); if (j?.error?.detail) detail = j.error.detail; } catch { /* noop */ }
    throw new Error(detail);
  }
  return await r.json();
}
