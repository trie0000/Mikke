// 自己更新の配布元としてバンドルに同梱する relay スクリプト一式。
//
// ★ なぜバンドルに入れるのか
//   自己更新は「新しいファイルを持っている配布元」が要る。
//   ワンクリック起動はランチャーと同じフォルダのバンドルを注入するので、
//   relay 自身のフォルダを配布元にしても中身は常に同じ = 更新が起きない。
//   SharePoint へ配布物を置かない運用ではそちらも空になる。
//   一方バンドルは git pull で必ず新しくなるので、これを配布元にすれば
//   「pull → 起動 → relay が自動更新」まで手作業なしで閉じる。
//
// ★ BOM と改行
//   .ps1 は UTF-8 BOM 必須 (無いと PowerShell 5.1 で文字化けする)。
//   esbuild の text ローダは BOM と CRLF をそのまま保持することを実測で確認済み。
//   base64 化も TextEncoder で行うので、バイト列は元ファイルと一致する。
import relayPs1 from '../../dist/mikke-relay.ps1';
import launchPs1 from '../../dist/mikke-launch.ps1';
import relayBat from '../../dist/mikke-relay.bat';
import launchBat from '../../dist/mikke-launch.bat';

export interface RelayPayloadFile {
  name: string;
  contentBase64: string;
}

/** UTF-8 のまま base64 化する (BOM・改行をそのまま保つ)。 */
export function textToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

/** バンドルが同梱している relay の版数 (dist/mikke-relay.ps1 から build 時に抽出)。 */
export const BUNDLED_RELAY_VERSION: string = __MIKKE_RELAY_VERSION__;

/** 自己更新で送るファイル一式。relay 側の許可リストと同じ顔ぶれにすること。 */
export const BUNDLED_RELAY_FILES: { name: string; text: string }[] = [
  { name: 'mikke-relay.ps1', text: relayPs1 },
  { name: 'mikke-launch.ps1', text: launchPs1 },
  { name: 'mikke-relay.bat', text: relayBat },
  { name: 'mikke-launch.bat', text: launchBat },
  // ローダは build 時に生成されるファイルなので define 経由で受け取る。
  { name: 'mikke.loader.js', text: __MIKKE_LOADER_JS__ },
];

export function bundledRelayFile(name: string): RelayPayloadFile | null {
  const f = BUNDLED_RELAY_FILES.find((x) => x.name === name);
  return f ? { name: f.name, contentBase64: textToBase64(f.text) } : null;
}
