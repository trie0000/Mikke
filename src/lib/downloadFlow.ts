// 検査ツールからのダウンロード取得 + SP 原本保存の共通フロー。
// ダウンロードデータ画面の「取得」と、管理対象一覧の「一括更新」ボタンが共用する。
import { getRepo, getRepoMode } from '../api/repo';
import { relayDownloadFromScanner, relayMergeReports, type RelayDownloadItem } from '../api/relay';
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

/** SP への保存を何本まで同時に流すか。検査ツールからの取得 (relay 側 runspace プール)
 *  と同じ 6 本に揃える。 */
const SAVE_PARALLEL = 6;

/** 最大 limit 並列で処理 (各 fn は自身で例外処理する前提)。 */
export async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
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
  await mapLimit(items ?? [], SAVE_PARALLEL, async (it) => {
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

/** mock (dev) 用のマージ CSV。取込 CSV と同じ列構成 (資産列を付加)。 */
async function sampleMergedCsv(items: RelayDownloadItem[]): Promise<{ fileName: string; text: string; rowCount: number }> {
  const vuln = await parseVulnReport(items);
  const headers = ['Issue Instance ID', 'Title', 'Severity', 'Status', 'First Seen', 'Last Seen', 'Asset', 'Asset Type'];
  const rows = (vuln?.rows ?? []).map((r, i) => ({
    'Issue Instance ID': r['Issue Instance ID'] ?? '',
    'Title': r['Title'] ?? '',
    'Severity': r['Severity'] ?? '',
    'Status': r['Status'] ?? '',
    'First Seen': r['First Seen'] ?? '',
    'Last Seen': r['Last Seen'] ?? '',
    'Asset': `host${i + 1}.example.com`,   // 資産レポートから突合した想定
    'Asset Type': 'FQDN',
  }));
  const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const text = [headers.join(','), ...rows.map((r) => headers.map((h) => esc(r[h as keyof typeof r] ?? '')).join(','))].join('\n') + '\n';
  return { fileName: `merged_${jstStamp()}.csv`, text, rowCount: rows.length };
}

export interface MergeResult {
  /** 取込に使うパース済み CSV。 */
  parsed: ParsedCsv;
  fileName: string;
  rowCount: number;
}

/**
 * ダウンロード済みファイル群から「脆弱性＋資産」マージ CSV を生成し (relay /mikke/merge)、
 * SP の同じ日時フォルダに保存 + ダウンロード一覧に記録した上で、パース結果を返す。
 * 生成される CSV は通常の CSV 取込と同じ列構成。
 */
export async function mergeAndStore(items: RelayDownloadItem[], runFolder: string): Promise<MergeResult> {
  let fileName: string;
  let text: string;
  let rowCount: number;
  if (getRepoMode() === 'mock') {
    const s = await sampleMergedCsv(items);
    fileName = s.fileName; text = s.text; rowCount = s.rowCount;
  } else {
    const res = await relayMergeReports(items.map((i) => ({ type: i.type, fileName: i.fileName, contentBase64: i.contentBase64 })));
    fileName = res.fileName || `merged_${jstStamp()}.csv`;
    const bytes = base64ToBytes(res.contentBase64);
    text = new TextDecoder('utf-8').decode(bytes);
    rowCount = res.rowCount ?? 0;
  }

  // マージ CSV も原本と同じ日時フォルダに保存し、一覧に記録する (監査・再取込用)。
  try {
    const blob = new Blob([new TextEncoder().encode(text) as BlobPart], { type: 'text/csv' });
    const { url } = await getRepo().uploadDownloadFile(runFolder, fileName, blob);
    await getRepo().createDownload({
      type: 'merged', downloadedAt: new Date().toISOString(),
      fileName, folder: runFolder, fileUrl: url, itemCount: rowCount || undefined,
    });
  } catch (e) {
    // 保存に失敗しても取込は続行できる (マージ結果はメモリ上にある)。
    console.warn('[mikke/downloadFlow] マージ CSV の保存に失敗:', (e as Error).message);
  }

  const parsed = await parseCsvAsync(text);
  return { parsed, fileName, rowCount: rowCount || parsed.rows.length };
}
