declare module '*.css' {
  const content: string;
  export default content;
}

// Build identity — injected by build.js via esbuild `define`. Used by the
// settings menu to show which build is currently running.
declare const __MIKKE_BUILD_ID__: string;
declare const __MIKKE_BUILD_TIME__: string;
declare const __MIKKE_BUILD_SHA__: string;
declare const __MIKKE_VERSION__: string;
