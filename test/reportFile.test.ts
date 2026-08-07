import { describe, it, expect } from 'vitest';
import { reportExt, reportMime, reportLinkLabel, zipEntryName, bulkReportZipName } from '../src/lib/reportFile';
import { simplePdf } from '../src/lib/pdf';

describe('reportExt / reportMime: 形式は拡張子から決める', () => {
  it('検査ツールが返す PDF を PDF として扱う', () => {
    expect(reportExt('IID-1001_2026_Jul_05.pdf')).toBe('pdf');
    expect(reportMime('IID-1001_2026_Jul_05.pdf')).toBe('application/pdf');
  });

  it('zip で返ってきても壊れない (以前の形式)', () => {
    expect(reportMime('IID-1001.zip')).toBe('application/zip');
  });

  it('大文字拡張子・空・拡張子なしでも落ちない', () => {
    expect(reportExt('REPORT.PDF')).toBe('pdf');
    expect(reportMime('')).toBe('application/octet-stream');
    expect(reportMime(undefined)).toBe('application/octet-stream');
    expect(reportMime('report')).toBe('application/octet-stream');
  });

  it('一覧のリンク表記は拡張子の大文字。不明なら「開く」', () => {
    expect(reportLinkLabel('a.pdf')).toBe('PDF');
    expect(reportLinkLabel('a.zip')).toBe('ZIP');
    expect(reportLinkLabel('report')).toBe('開く');
  });
});

describe('zipEntryName: 一括ダウンロード zip の中の名前', () => {
  it('脆弱性 ID が名前に無ければ前置する', () => {
    expect(zipEntryName('IID-9', 'report.pdf', new Set())).toBe('IID-9_report.pdf');
  });

  it('既に名前に入っていれば二重に付けない', () => {
    expect(zipEntryName('IID-9', 'IID-9_2026.pdf', new Set())).toBe('IID-9_2026.pdf');
  });

  it('同名は連番で避ける (zip 内で衝突すると片方が消える)', () => {
    const used = new Set<string>();
    expect(zipEntryName('IID-1', 'r.pdf', used)).toBe('IID-1_r.pdf');
    expect(zipEntryName('IID-1', 'r.pdf', used)).toBe('IID-1_r_2.pdf');
    expect(zipEntryName('IID-1', 'r.pdf', used)).toBe('IID-1_r_3.pdf');
  });

  it('Windows で使えない文字は潰す。ハイフン・空白は残す', () => {
    expect(zipEntryName('', 'a/b:c*d?.pdf', new Set())).toBe('a_b_c_d_.pdf');
    expect(zipEntryName('', 'first seen-2026.pdf', new Set())).toBe('first seen-2026.pdf');
  });

  it('ファイル名が空でも名前を作る', () => {
    expect(zipEntryName('IID-1', '', new Set())).toBe('IID-1_report');
  });
});

describe('bulkReportZipName', () => {
  it('JST の日時が入った zip 名になる', () => {
    expect(bulkReportZipName('2026-08-07T01:23:45Z')).toBe('mikke-reports_20260807-102345.zip');
  });
});

describe('simplePdf: モックのサンプルレポート', () => {
  const bytes = simplePdf(['Mikke sample', 'Issue Instance ID: IID-1']);
  const text = new TextDecoder().decode(bytes);

  it('PDF のヘッダと終端を持つ', () => {
    expect(text.startsWith('%PDF-1.4')).toBe(true);
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true);
  });

  it('startxref が指す位置に実際に xref がある', () => {
    const at = Number(/startxref\s+(\d+)/.exec(text)![1]);
    expect(text.slice(at, at + 4)).toBe('xref');
  });

  it('括弧やバックスラッシュを含む行でも構文を壊さない', () => {
    const t = new TextDecoder().decode(simplePdf(['a (b) c \\ d']));
    expect(t).toContain('(a \\(b\\) c \\\\ d) Tj');
  });

  it('非 ASCII は ? に落とす (標準フォントに字形が無いため)', () => {
    const t = new TextDecoder().decode(simplePdf(['深刻度: 高']));
    expect(t).toContain('(???: ?) Tj');
  });
});
