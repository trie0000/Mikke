// 脆弱性 1 件ごとのレポートを SP に保存し、連携用リストへ添付するフロー。
//   管理対象一覧の「情報更新」から呼ばれる。取得そのものは relay の /mikke/issues
//   (runspace プールで並列) がまとめて行うので、ここは保存と添付だけを担う。
//     1. SP のドキュメントライブラリに原本を保存 … 一覧からリンクで開く用 (世代が残る)
//     2. 連携用リストの該当アイテムに添付       … 資産管理者が SP 上で開く用 (常に最新1つ)
//   UI 非依存。
import { getRepo } from '../api/repo';
import { zipFiles } from './zip';
import { jstStamp } from './downloadFlow';
import type { ManagedIssue } from '../types';

const DEFAULT_FOLDER = 'Shared Documents/MikkeDownloads';
/** 個別レポートの保存先 (一括ダウンロードの日時フォルダと混ざらないよう分ける)。 */
export const ISSUE_REPORT_SUBFOLDER = 'issues';

/** アダプタ未配置 (501) か。未配置ならレポートだけ諦めて情報更新は続ける。 */
export function isAdapterMissing(e: unknown): boolean {
  const err = e as { status?: number; message?: string };
  if (err?.status === 501) return true;
  return /未配置|未実装|adapter/i.test(err?.message ?? '');
}

/** 検査ツールから取得済みのレポート 1 件分。 */
export interface FetchedReport {
  fileName: string;
  bytes: Uint8Array;
}

/** この実行ぶんの保存先 (1 回の情報更新 = 1 フォルダ)。 */
export async function issueReportFolder(nowIso: string): Promise<string> {
  const settings = await getRepo().getSettings();
  const baseFolder = (settings.downloadFolder ?? '').trim() || DEFAULT_FOLDER;
  return `${baseFolder}/${ISSUE_REPORT_SUBFOLDER}/${jstStamp(nowIso)}`;
}

/** dev (mock) 用のサンプルレポート。中身は識別できれば十分。 */
export async function sampleIssueReport(issue: ManagedIssue): Promise<FetchedReport> {
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
 * 取得済みレポートを SP に保存し、連携用リストにも添付する。
 * 保存に失敗したら throw する (呼び出し側で 1 件だけ失敗扱いにする)。
 * 添付の失敗は致命的ではないので throw せず結果に載せる。
 *
 * ★ 添付は「常に最新 1 つ」にする。SharePoint の添付はファイル名が違えば別物として
 *   積み上がってしまい、検査ツールのファイル名には日付が入る = 毎回別名になるため、
 *   前回添付したファイル名 (issue.reportName) も消してから追加する。
 *   ※ アイテムに付いている他の添付 (資産管理者が付けた証跡など) は消さない。
 */
export async function storeIssueReport(
  issue: ManagedIssue, rep: FetchedReport, folder: string,
): Promise<IssueReportResult> {
  const fetchedAt = new Date().toISOString();
  const blob = new Blob([rep.bytes as BlobPart], { type: 'application/zip' });
  const { url } = await getRepo().uploadDownloadFile(folder, rep.fileName, blob);

  let attach: IssueReportResult['attach'] = 'no-item';
  let attachError: string | undefined;
  try {
    attach = await getRepo().attachVulnResponseFile(
      issue.issueInstanceId, rep.fileName, blob, issue.reportName,
    );
  } catch (e) {
    attach = 'failed';
    attachError = (e as Error).message;
  }
  return { url, fileName: rep.fileName, fetchedAt, attach, attachError };
}
