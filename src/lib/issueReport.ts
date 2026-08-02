// 脆弱性 1 件ごとのレポート取得フロー。
//   管理対象一覧の「情報更新」から呼ばれ、1 件につき
//     1. 検査ツールからレポート (zip) を取得        … relay /mikke/issue-report
//     2. SP のドキュメントライブラリに原本を保存    … 一覧からリンクで開く用
//     3. 連携用リストの該当アイテムに添付           … 資産管理者が SP 上で開く用
//   の順で処理する。UI 非依存。
import { getRepo, getRepoMode } from '../api/repo';
import { relayGetIssueReport } from '../api/relay';
import { zipFiles } from './zip';
import { jstStamp, base64ToBytes } from './downloadFlow';
import type { ManagedIssue } from '../types';

const DEFAULT_FOLDER = 'Shared Documents/MikkeDownloads';
/** 個別レポートの保存先 (ダウンロードデータの一括分と混ざらないよう分ける)。 */
export const ISSUE_REPORT_SUBFOLDER = 'issues';

/** アダプタ未配置 (501) か。未配置ならレポートだけ諦めて情報更新は続ける。 */
export function isAdapterMissing(e: unknown): boolean {
  const err = e as { status?: number; message?: string };
  if (err?.status === 501) return true;
  return /未配置|未実装|adapter/i.test(err?.message ?? '');
}

/** dev (mock) 用のサンプルレポート。中身は識別できれば十分。 */
async function sampleReport(issue: ManagedIssue): Promise<{ fileName: string; bytes: Uint8Array }> {
  const enc = new TextEncoder();
  const text = [
    `Issue Instance ID,${issue.issueInstanceId}`,
    `Title,${issue.title}`,
    `Severity,${issue.severity ?? ''}`,
    `Exported,${new Date().toISOString()}`,
  ].join('\n') + '\n';
  const zip = await zipFiles([{ name: `${issue.issueInstanceId || 'issue'}.csv`, data: enc.encode(text) }]);
  return {
    fileName: `${issue.issueInstanceId || 'issue'}_${jstStamp()}.zip`,
    bytes: new Uint8Array(await zip.arrayBuffer()),
  };
}

export interface IssueReportResult {
  /** SP 上のサーバ相対 URL (一覧のリンク先)。 */
  url: string;
  fileName: string;
  fetchedAt: string;
  /** 連携用リストへの添付結果。'no-item' = 連携用リストに該当アイテムが無い。 */
  attach: 'attached' | 'no-item' | 'failed';
  /** 添付に失敗したときの理由 (attach='failed' のときだけ)。 */
  attachError?: string;
}

/**
 * 1 件分のレポートを取得して保存し、連携用リストにも添付する。
 * 取得・保存に失敗したら throw する (呼び出し側で 1 件だけ失敗扱いにする)。
 * 添付の失敗は致命的ではないので throw せず結果に載せる。
 */
export async function fetchAndStoreIssueReport(issue: ManagedIssue): Promise<IssueReportResult> {
  const settings = await getRepo().getSettings();
  const baseFolder = (settings.downloadFolder ?? '').trim() || DEFAULT_FOLDER;

  let fileName: string;
  let bytes: Uint8Array;
  if (getRepoMode() === 'mock') {
    const s = await sampleReport(issue);
    fileName = s.fileName; bytes = s.bytes;
  } else {
    const res = await relayGetIssueReport(issue.issueInstanceId);
    fileName = res.fileName || `${issue.issueInstanceId}_${jstStamp()}.zip`;
    bytes = base64ToBytes(res.contentBase64);
  }

  const fetchedAt = new Date().toISOString();
  const blob = new Blob([bytes as BlobPart], { type: 'application/zip' });
  // 検査ツールが付けたファイル名にはたいてい日付が入っているが、同名で上書きされると
  // 履歴が消えるので、取得日時のフォルダに分けて保存する。
  const folder = `${baseFolder}/${ISSUE_REPORT_SUBFOLDER}/${jstStamp(fetchedAt)}`;
  const { url } = await getRepo().uploadDownloadFile(folder, fileName, blob);

  let attach: IssueReportResult['attach'] = 'no-item';
  let attachError: string | undefined;
  try {
    attach = await getRepo().attachVulnResponseFile(issue.issueInstanceId, fileName, blob);
  } catch (e) {
    attach = 'failed';
    attachError = (e as Error).message;
  }
  return { url, fileName, fetchedAt, attach, attachError };
}
