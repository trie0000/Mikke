// Mikke icons — Feather-style inline SVG strings (24x24, stroke 1.7, currentColor)
const SVG = (paths: string) =>
  `<svg viewBox="0 0 24 24" stroke="currentColor" fill="none" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;

export const ICONS: Record<string, string> = {
  gear:        SVG(`<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 0 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 0 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 0 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 0 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>`),
  sync:        SVG(`<path d="M21 12a9 9 0 0 1-15.3 6.4L3 16"/><path d="M3 12a9 9 0 0 1 15.3-6.4L21 8"/><path d="M21 3v5h-5"/><path d="M3 21v-5h5"/>`),
  x:           SVG(`<path d="M6 6l12 12M18 6L6 18"/>`),
  download:    SVG(`<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/>`),
  door:        SVG(`<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/>`),
  building:    SVG(`<rect x="4" y="3" width="16" height="18" rx="1"/><path d="M9 7h2M13 7h2M9 11h2M13 11h2M9 15h2M13 15h2"/><path d="M10 21v-3h4v3"/>`),
  chevronDown: SVG(`<path d="M6 9l6 6 6-6"/>`),
  search:      SVG(`<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>`),
  plus:        SVG(`<path d="M12 5v14M5 12h14"/>`),
  link:        SVG(`<path d="M10 14a5 5 0 0 0 7.07 0l3-3a5 5 0 0 0-7.07-7.07l-1.5 1.5"/><path d="M14 10a5 5 0 0 0-7.07 0l-3 3a5 5 0 0 0 7.07 7.07l1.5-1.5"/>`),
  copy:        SVG(`<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>`),
  external:    SVG(`<path d="M14 4h6v6"/><path d="M10 14L20 4"/><path d="M20 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h5"/>`),
  filter:      SVG(`<path d="M3 5h18l-7 9v6l-4-2v-4z"/>`),
  upload:      SVG(`<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M17 8l-5-5-5 5"/><path d="M12 3v12"/>`),
  list:        SVG(`<path d="M8 6h13M8 12h13M8 18h13"/><circle cx="4" cy="6" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="4" cy="18" r="1"/>`),
  trash:       SVG(`<path d="M3 6h18"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/>`),
  clock:       SVG(`<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>`),
  user:        SVG(`<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>`),
  check:       SVG(`<path d="M5 12l5 5 9-11"/>`),
  alert:       SVG(`<path d="M12 9v4M12 17h.01"/><path d="M10.3 3.86L1.82 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.4 0z"/>`),
  shield:      SVG(`<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/>`),
  moon:        SVG(`<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>`),
  sun:         SVG(`<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/>`),
  refresh:     SVG(`<path d="M23 4v6h-6"/><path d="M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>`),
  hash:        SVG(`<line x1="4" y1="9" x2="20" y2="9"/><line x1="4" y1="15" x2="20" y2="15"/><line x1="10" y1="3" x2="8" y2="21"/><line x1="16" y1="3" x2="14" y2="21"/>`),
  help:        SVG(`<circle cx="12" cy="12" r="9"/><path d="M9.1 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><circle cx="12" cy="17" r="0.6" fill="currentColor"/>`),
  edit:        SVG(`<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 1 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/>`),
  calendar:    SVG(`<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 11h18"/>`),
};

export function icon(name: keyof typeof ICONS | string, className = ''): string {
  const svg = ICONS[name] ?? '';
  if (!svg) return '';
  return className ? svg.replace('<svg ', `<svg class="${className}" `) : svg;
}

/** ブランドマーク「N」(Spira 踏襲、色は淡いブルー = currentColor で継承)。
 *  topbar / favicon / install ページで共通利用。作者・自作ツールの識別子。 */
export function brandMark(className = ''): string {
  // Spira の「N」マークを踏襲した角丸スクエア + N グリフ。fill=currentColor で
  // アクセント色 (淡いブルー) を継承する。
  const svg =
    `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">` +
    `<rect x="2" y="2" width="20" height="20" rx="5" fill="currentColor"/>` +
    `<path d="M8 17V7l8 10V7" stroke="#fff" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" fill="none"/>` +
    `</svg>`;
  return className ? svg.replace('<svg ', `<svg class="${className}" `) : svg;
}
