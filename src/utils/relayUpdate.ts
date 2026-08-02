// 中継サーバ (relay) スクリプトの自動更新。
//
// 仕組み:
//   1. 配布物 (relay-version.txt + 管理対象の ps1/bat/js) が「最新版」。
//   2. relay は自分の版を返す /mikke/relay/version と、配布物を配信する
//      /mikke/relay-version.txt・/mikke/<ファイル名> を持つ。
//   3. このモジュールは
//      - 配布元の manifest と relay の版を比較 → 差があれば更新ありと返す
//      - 更新実行: 配布元からファイルを取得 → relay の /mikke/relay/self-update
//        に base64 で POST → relay は *.new に staging して updater を起動し自分を落とす
//      - relay が再起動して応答を返すまで待つ
//
// ★ 配布元は「relay → SharePoint」の順に探す。
//   バンドル直挿し運用では SharePoint に何も置かないので、relay 自身が配布元に
//   なれないと自己更新が一切できない (以前はここが SP 固定で、SP に配布物を
//   上げていない環境では更新が始まらなかった)。
import { relayGetVersion, relaySelfUpdate, relayHealth, getRelayBase } from '../api/relay';
import { resolveSpBase } from './bundleVersion';

export interface RelayUpdateInfo {
  localVersion: string;   // 動作中 relay の版
  remoteVersion: string;  // 配布元 manifest の版
  files: string[];        // 更新対象ファイル名 (manifest 由来)
  /** 配布元 ('relay' = relay 自身のフォルダ / 'sp' = SharePoint)。 */
  source: 'relay' | 'sp';
}

interface Manifest { version: string; files: string[] }

function parseManifest(text: string, label: string): Manifest | null {
  try {
    const j = JSON.parse(text) as { version?: unknown; files?: unknown };
    const version = String(j.version ?? '').trim();
    const files = Array.isArray(j.files) ? j.files.filter((f): f is string => typeof f === 'string') : [];
    if (!version || !files.length) {
      console.warn(`[mikke/relay-update] ${label} の manifest が不正です:`, text.slice(0, 200));
      return null;
    }
    return { version, files };
  } catch (e) {
    console.warn(`[mikke/relay-update] ${label} の manifest を解釈できません:`, (e as Error).message);
    return null;
  }
}

async function manifestFromRelay(): Promise<Manifest | null> {
  try {
    const r = await fetch(`${getRelayBase()}/relay-version.txt?t=${Date.now()}`, { cache: 'no-store' });
    if (!r.ok) { console.warn(`[mikke/relay-update] relay manifest HTTP ${r.status} (旧 relay か配布物未配置)`); return null; }
    return parseManifest(await r.text(), 'relay');
  } catch (e) {
    console.warn('[mikke/relay-update] relay manifest 取得に失敗:', (e as Error).message);
    return null;
  }
}

async function manifestFromSp(): Promise<Manifest | null> {
  const base = resolveSpBase();
  if (!base) return null;
  try {
    const r = await fetch(`${base}/relay-version.txt?t=${Date.now()}`, { credentials: 'same-origin', cache: 'no-store' });
    if (!r.ok) { console.warn(`[mikke/relay-update] SP manifest HTTP ${r.status}`); return null; }
    return parseManifest(await r.text(), 'SharePoint');
  } catch (e) {
    console.warn('[mikke/relay-update] SP manifest 取得に失敗:', (e as Error).message);
    return null;
  }
}

/** relay 更新の有無を確認。relay 未起動 / 配布元なし / 同版 なら null。 */
export async function checkRelayUpdate(): Promise<RelayUpdateInfo | null> {
  const info = await relayGetVersion();
  if (!info || !info.version) return null;   // relay 未起動 → 何もしない

  let source: 'relay' | 'sp' = 'relay';
  let manifest = await manifestFromRelay();
  if (!manifest) {
    source = 'sp';
    manifest = await manifestFromSp();
  }
  if (!manifest) return null;

  if (manifest.version === info.version) return null;
  console.log(`[mikke/relay-update] v${info.version} → v${manifest.version} (配布元: ${source})`);
  return { localVersion: info.version, remoteVersion: manifest.version, files: manifest.files, source };
}

/** バイト列を base64 化 (BOM・改行・マルチバイトをそのまま保持)。 */
function bytesToBase64(buf: Uint8Array): string {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < buf.length; i += chunk) {
    bin += String.fromCharCode(...buf.subarray(i, i + chunk));
  }
  return btoa(bin);
}

/** 配布元からファイルを取る。⚠ テキストではなく arrayBuffer (生バイト) で取得する。
 *  .ps1 の UTF-8 BOM を保つため (BOM が剥げると PowerShell 5.1 で文字化けする)。 */
async function fetchFile(name: string, source: 'relay' | 'sp'): Promise<Uint8Array | null> {
  const url = source === 'relay'
    ? `${getRelayBase()}/${encodeURIComponent(name)}?t=${Date.now()}`
    : (() => { const b = resolveSpBase(); return b ? `${b}/${encodeURIComponent(name)}?t=${Date.now()}` : ''; })();
  if (!url) return null;
  try {
    const r = await fetch(url, {
      cache: 'no-store',
      ...(source === 'sp' ? { credentials: 'same-origin' as const } : {}),
    });
    if (!r.ok) { console.warn(`[mikke/relay-update] ${source} から ${name} を取得できません: HTTP ${r.status}`); return null; }
    const bytes = new Uint8Array(await r.arrayBuffer());
    return bytes.length ? bytes : null;
  } catch (e) {
    console.warn(`[mikke/relay-update] ${source} から ${name} の取得に失敗:`, (e as Error).message);
    return null;
  }
}

export interface RelayUpdateResult {
  /** relay が再起動して応答を返したか。 */
  relayBackUp: boolean;
  /** 再起動後の版 (取れなければ null)。 */
  newVersion: string | null;
}

/**
 * 配布元から最新ファイルを取得し、relay に self-update を要求する。
 *
 * ★ relay は 200 を返した直後に自分を落とすので、POST の応答が読めずに
 *   fetch が例外になることがある。updater は既に起動しているので、そこで
 *   失敗扱いにせず再起動を待つ。
 */
export async function performRelayUpdate(files: string[], source: 'relay' | 'sp' = 'relay'): Promise<RelayUpdateResult> {
  const payload: { name: string; contentBase64: string }[] = [];
  for (const name of files) {
    // 主たる配布元 → もう一方、の順に探す (どちらかにあれば更新できる)。
    const bytes = (await fetchFile(name, source)) ?? (await fetchFile(name, source === 'relay' ? 'sp' : 'relay'));
    if (!bytes) throw new Error(`${name} を配布元から取得できませんでした`);
    payload.push({ name, contentBase64: bytesToBase64(bytes) });
  }

  try {
    await relaySelfUpdate(payload);
  } catch (e) {
    // 応答を読む前に relay が落ちた場合。updater は起動済みなので継続する。
    console.warn('[mikke/relay-update] self-update の応答取得中に切断 (relay 終了とみなして継続):', (e as Error).message);
  }

  // updater は relay の終了待ち → ファイル置換 → 再起動。手元の環境差 (AV スキャン等) を
  // 見込んで長めに待つ。待ちきれなくても置換自体は別プロセスで進む。
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000));
    const h = await relayHealth();
    if (h.ok) {
      const info = await relayGetVersion();
      return { relayBackUp: true, newVersion: info?.version ?? null };
    }
  }
  return { relayBackUp: false, newVersion: null };
}
