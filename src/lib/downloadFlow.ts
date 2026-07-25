// 検査ツールからのダウンロード取得 + SP 原本保存の共通フロー。
// ダウンロードデータ画面の「取得」と、管理対象一覧の「一括更新」ボタンが共用する。
import { getRepo, getRepoMode } from '../api/repo';
import { relayDownloadFromScanner, type RelayDownloadItem } from '../api/relay';
import { zipFiles } from './zip';
import { extractCsvTextFromZip } from './xlsx';
import { parseCsvAsync, type ParsedCsv } from './csv';
import type { DownloadType } from '../types';

const DEFAULT_FOLDER = 'Shared Documents/MikkeDownloads';

/** 全種別 (脆弱性 + 資産各種)。一括更新で全レポートを取得する。 */
export const ALL_DOWNLOAD_TYPES: DownloadType[] = ['vuln', 'ip', 'iprange', 'domain', 'cert', 'webapps'];

/** 日時 (省略時は現在) を JST の 'YYYYMMDD-HHMMSS' に (フォルダ名用)。 */
export function jstStamp(iso?: string): string {
  const d = iso ? new Date(iso) : new Date();
  if (Number.isNaN(d.getTime())) return '';
  const s = d.toLocaleString('sv-SE', { timeZone: 'Asia/Tokyo' });
  return s.replace(/[-:]/g, '').replace(' ', '-');
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}

function bytesToBase64(bytes: Uint8Array): string {
  let s = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) s += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(s);
}

/** 最大 limit 並列で処理 (各 fn は自身で例外処理する前提)。 */
async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let idx = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (idx < items.length) { const cur = items[idx++]!; await fn(cur); }
  });
  await Promise.all(runners);
}

/** mock (dev) 用サンプル。vuln は取込検証のため CSV 入り zip を返す。 */
async function sampleItems(types: DownloadType[]): Promise<RelayDownloadItem[]> {
  const enc = new TextEncoder();
  const nowIso = new Date().toISOString();
  const out: RelayDownloadItem[] = [];
  for (const t of types) {
    if (t === 'vuln') {
      const csv = [
        'Issue Instance ID,Title,Severity,Status,First Seen,Last Seen',
        'IID-9001,TLS 1.0 有効,Critical,open,2026-07-01,2026-07-05',
        'IID-9002,古い jQuery,Low,open,2026-07-01,2026-07-05',
        'IID-9003,管理画面公開,Critical,open,2026-07-01,2026-07-05',
      ].join('\n') + '\n';
      const zip = await zipFiles([{ name: 'vulnerabilities.csv', data: enc.encode(csv) }]);
      const bytes = new Uint8Array(await zip.arrayBuffer());
      out.push({ type: t, fileName: 'vuln_export_2026_Jul_05.zip', contentBase64: bytesToBase64(bytes), scannerDownloadTime: nowIso, itemCount: 3 });
    } else {
      const csv = `asset,sample\n${t},row-1\n`;
      out.push({ type: t, fileName: `${t}_export_2026_Jul_05.zip`, contentBase64: bytesToBase64(enc.encode(csv)), scannerDownloadTime: nowIso, itemCount: 1 });
    }
  }
  return out;
}

export interface AcquireResult {
  items: RelayDownloadItem[];
  saved: number;
  errors: string[];
  runFolder: string;
}

/** 指定種別を検査ツールから取得し、SP に原本保存 + 一覧記録する。取得結果 (items) も返す。
 *  relay 未起動 / アダプタ未配置などは throw (呼び出し側でトースト表示)。 */
export async function acquireAndStore(types: DownloadType[]): Promise<AcquireResult> {
  const settings = await getRepo().getSettings();
  const baseFolder = (settings.downloadFolder ?? '').trim() || DEFAULT_FOLDER;
  const items = getRepoMode() === 'mock'
    ? await sampleItems(types)
    : (await relayDownloadFromScanner(types)).items;

  const nowIso = new Date().toISOString();
  const runFolder = `${baseFolder}/${jstStamp(nowIso)}`;
  let saved = 0;
  const errors: string[] = [];
  await mapLimit(items ?? [], 4, async (it) => {
    try {
      const blob = new Blob([base64ToBytes(it.contentBase64) as BlobPart], { type: 'application/octet-stream' });
      const { url } = await getRepo().uploadDownloadFile(runFolder, it.fileName, blob);
      await getRepo().createDownload({
        type: it.type as DownloadType, downloadedAt: nowIso,
        scannerDownloadTime: it.scannerDownloadTime, fileName: it.fileName,
        folder: runFolder, fileUrl: url, itemCount: it.itemCount,
      });
      saved++;
    } catch (e) {
      errors.push(`${it.type} (${it.fileName}): ${(e as Error).message}`);
      console.warn(`[mikke/downloadFlow] ${it.type} の保存に失敗:`, (e as Error).message);
    }
  });
  return { items: items ?? [], saved, errors, runFolder };
}

/** items から脆弱性レポート (zip 内 CSV / CSV) を取り出してパースする。無ければ null。 */
export async function parseVulnReport(items: RelayDownloadItem[]): Promise<ParsedCsv | null> {
  for (const it of items.filter((x) => x.type === 'vuln')) {
    const bytes = base64ToBytes(it.contentBase64);
    const text = /\.zip$/i.test(it.fileName)
      ? extractCsvTextFromZip(bytes.buffer as ArrayBuffer)
      : new TextDecoder('utf-8').decode(bytes);
    if (text) return await parseCsvAsync(text);
  }
  return null;
}
