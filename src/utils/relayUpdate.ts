// 中継サーバ (relay) スクリプトの自動更新。
// SP の relay-version.txt (manifest) と 動作中 relay の /relay/version を比較し、
// 差があれば SP 上の最新 relay ファイルを取得して relay に self-update を要求する。
// ※ relay ファイルは常に SP の配布フォルダ (ドキュメント/Mikke) に置かれる前提。
import { relayGetVersion, relaySelfUpdate } from '../api/relay';
import { resolveSpBase } from './bundleVersion';

export interface RelayUpdateInfo {
  localVersion: string;   // 動作中 relay の版
  remoteVersion: string;  // SP manifest の版
  files: string[];        // 更新対象ファイル名 (manifest 由来)
}

/** relay 更新の有無を確認。relay 未起動 / SP 解決不可 / 同版 なら null。 */
export async function checkRelayUpdate(): Promise<RelayUpdateInfo | null> {
  const info = await relayGetVersion();
  if (!info || !info.version) return null;   // relay 未起動 → 何もしない
  const base = resolveSpBase();
  if (!base) return null;                     // 非 SP ホスト → 配布元なし

  let manifest: { version?: unknown; files?: unknown };
  try {
    const r = await fetch(`${base}/relay-version.txt?t=${Date.now()}`, { credentials: 'same-origin', cache: 'no-store' });
    if (!r.ok) return null;
    manifest = JSON.parse(await r.text());
  } catch { return null; }

  const remote = String(manifest.version ?? '').trim();
  const files = Array.isArray(manifest.files)
    ? manifest.files.filter((f): f is string => typeof f === 'string')
    : [];
  if (remote && remote !== info.version && files.length) {
    return { localVersion: info.version, remoteVersion: remote, files };
  }
  return null;
}

/** バイト列を base64 化 (BOM・改行・マルチバイトをそのまま保持)。 */
function bytesToBase64(buf: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]!);
  return btoa(bin);
}

/** SP 上の最新 relay ファイルを取得して relay に self-update を要求する。
 *  ⚠ テキストとしてではなく arrayBuffer (生バイト) で取得し base64 化する。
 *    .ps1 の UTF-8 BOM を保持するため (BOM が剥げると PS5.1 で文字化け)。 */
export async function performRelayUpdate(files: string[]): Promise<void> {
  const base = resolveSpBase();
  if (!base) throw new Error('SharePoint の配布元を解決できません');
  const payload: { name: string; contentBase64: string }[] = [];
  for (const name of files) {
    const r = await fetch(`${base}/${encodeURIComponent(name)}?t=${Date.now()}`, {
      credentials: 'same-origin', cache: 'no-store',
    });
    if (!r.ok) throw new Error(`${name} の取得に失敗: HTTP ${r.status}`);
    const bytes = new Uint8Array(await r.arrayBuffer());
    payload.push({ name, contentBase64: bytesToBase64(bytes) });
  }
  await relaySelfUpdate(payload);
}
