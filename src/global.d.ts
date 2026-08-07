declare module '*.css' {
  const content: string;
  export default content;
}

// relay スクリプトはテキストとしてバンドルへ取り込む (自己更新の配布元にするため)。
// esbuild の text ローダが BOM・改行をそのまま保持する。
declare module '*.ps1' {
  const content: string;
  export default content;
}
declare module '*.bat' {
  const content: string;
  export default content;
}

// Build identity — injected by build.js via esbuild `define`. Used by the
// settings menu to show which build is currently running.
declare const __MIKKE_BUILD_ID__: string;
declare const __MIKKE_BUILD_TIME__: string;
declare const __MIKKE_BUILD_SHA__: string;
declare const __MIKKE_VERSION__: string;
// バンドルが同梱する relay の版数と、生成済みローダ本文 (自己更新の配布元)。
declare const __MIKKE_RELAY_VERSION__: string;
declare const __MIKKE_LOADER_JS__: string;
