// PowerShell 中継サーバ (localhost) クライアント。
// 役割: 大容量 CSV 解析 (/mikke/csv-parse) と 検査ツール API 中継 (/mikke/issue・雛形)。
import type { ImportSummary } from '../types';

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
  summary: ImportSummary;
  /** 先頭数十件のプレビュー行。 */
  preview: Record<string, string>[];
  /** SP 書き込み用の差分操作 (詳細は実装フェーズで確定)。 */
  diff?: unknown[];
  headers: string[];
}

/** /mikke/csv-parse — 大容量 CSV をサーバ側で解析 (主経路)。
 *  ※ 雛形: 実際のサーバ実装は Phase 1。ここでは I/F のみ固定。 */
export async function relayCsvParse(file: File, params: unknown): Promise<CsvParseResult> {
  const form = new FormData();
  form.append('file', file);
  form.append('params', JSON.stringify(params));
  const r = await fetch(`${getRelayBase()}/csv-parse`, { method: 'POST', body: form });
  if (!r.ok) throw new Error(`csv-parse failed: HTTP ${r.status}`);
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
