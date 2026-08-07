// 最小構成の PDF 生成 (dev モックのサンプルレポート用)。
//
// ★ 用途は「モックでも本番と同じ形式 (PDF) のファイルが出る」ことだけ。
//   本番のレポートは検査ツールが作ったものをそのまま保存するので、ここは通らない。
//   フォント埋め込みをしないため標準 14 フォント (Helvetica) = ASCII のみ。
//   非 ASCII は '?' に落とす (モックなので表示できれば十分)。

/** PDF のテキスト文字列としてエスケープする (( ) \ が構文文字)。 */
function escapeText(s: string): string {
  return [...s]
    .map((c) => (c.charCodeAt(0) >= 0x20 && c.charCodeAt(0) <= 0x7e ? c : '?'))
    .join('')
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)');
}

/**
 * 1 ページの PDF を作る。lines は上から順に描画する行。
 * xref のオフセットはバイト位置で書く必要があるので、オブジェクトを 1 つずつ
 * 積みながら実際の長さを数える。
 */
export function simplePdf(lines: string[]): Uint8Array {
  const enc = new TextEncoder();
  const content = [
    'BT',
    '/F1 11 Tf',
    '14 TL',
    '50 780 Td',
    ...lines.map((l) => `(${escapeText(l)}) Tj T*`),
    'ET',
  ].join('\n');

  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] '
      + '/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${enc.encode(content).length} >>\nstream\n${content}\nendstream`,
  ];

  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(enc.encode(body).length);
    body += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });

  const xrefAt = enc.encode(body).length;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) xref += `${String(off).padStart(10, '0')} 00000 n \n`;
  const trailer = `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n`
    + `startxref\n${xrefAt}\n%%EOF\n`;

  return enc.encode(body + xref + trailer);
}
