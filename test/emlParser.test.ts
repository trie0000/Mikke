import { describe, it, expect } from 'vitest';
import { parseEml, parseOutlookDragText, stripHtml, looksLikeEml, looksLikeOutlookDrag, normalizeMailPlainText, splitQuotedReplyText, deEncapsulateHtml } from '../src/lib/emlParser';

const b64 = (s: string): string => Buffer.from(s, 'utf-8').toString('base64');

describe('parseEml', () => {
  it('プレーン UTF-8 base64 本文 + encoded-word 件名 + From', () => {
    const eml = [
      'From: "山田 太郎" <taro@example.com>',
      'To: sec@example.com',
      'Subject: =?UTF-8?B?' + b64('テスト件名') + '?=',
      'Date: Mon, 17 May 2026 10:30:00 +0900',
      'Content-Type: text/plain; charset="UTF-8"',
      'Content-Transfer-Encoding: base64',
      '',
      b64('本文の1行目\n2行目'),
    ].join('\r\n');
    const p = parseEml(eml);
    expect(p.subject).toBe('テスト件名');
    expect(p.fromName).toBe('山田 太郎');
    expect(p.fromEmail).toBe('taro@example.com');
    expect(p.dateISO).toBe('2026-05-17T01:30:00.000Z');
    expect(p.body).toBe('本文の1行目\n2行目');
  });

  it('quoted-printable 本文', () => {
    const eml = [
      'From: a@example.com',
      'Subject: QP',
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: quoted-printable',
      '',
      '=E6=97=A5=E6=9C=AC=E8=AA=9E OK',
    ].join('\r\n');
    expect(parseEml(eml).body).toBe('日本語 OK');
  });

  it('multipart/alternative は text/plain を優先', () => {
    const eml = [
      'From: a@example.com',
      'Subject: MP',
      'Content-Type: multipart/alternative; boundary="BND"',
      '',
      '--BND',
      'Content-Type: text/plain; charset=UTF-8',
      '',
      'プレーン本文',
      '--BND',
      'Content-Type: text/html; charset=UTF-8',
      '',
      '<p>HTML本文</p>',
      '--BND--',
    ].join('\r\n');
    const p = parseEml(eml);
    expect(p.body).toBe('プレーン本文');
    expect(p.bodyHtml).toContain('<p>HTML本文</p>');
  });

  it('text/html のみ → プレーンに変換', () => {
    const eml = [
      'From: a@example.com',
      'Subject: H',
      'Content-Type: text/html; charset=UTF-8',
      '',
      '<div>1行目</div><div>2行目</div>',
    ].join('\r\n');
    expect(parseEml(eml).body).toBe('1行目\n2行目');
  });
});

describe('parseOutlookDragText', () => {
  it('日本語ヘッダを解析', () => {
    const text = ['差出人: 花子 <hanako@example.com>', '送信日時: Mon, 17 May 2026 10:30:00 +0900', '件名: ドラッグ取込', '', '本文です'].join('\n');
    const p = parseOutlookDragText(text);
    expect(p.fromEmail).toBe('hanako@example.com');
    expect(p.subject).toBe('ドラッグ取込');
    expect(p.body).toBe('本文です');
  });
});

describe('splitQuotedReplyText (最新本文のみ)', () => {
  it('----- Original Message ----- で分割', () => {
    const t = ['了解しました。対応します。', '', '-----Original Message-----', 'From: a@example.com', 'Subject: 元の件名', '', '元の本文'].join('\n');
    const r = splitQuotedReplyText(t);
    expect(r.latest).toBe('了解しました。対応します。');
    expect(r.quoted).toContain('元の本文');
  });
  it('差出人: ヘッダブロックで分割', () => {
    const t = ['ご連絡ありがとうございます。', '', '差出人: 田中 <tanaka@example.com>', '送信日時: 2026年5月1日', '件名: 件名', '', '前のメール本文'].join('\n');
    const r = splitQuotedReplyText(t);
    expect(r.latest).toBe('ご連絡ありがとうございます。');
    expect(r.quoted).toContain('前のメール本文');
  });
  it('引用 (>) が2行以上連続で分割', () => {
    const t = ['最新の返信です。', '', '> 過去行1', '> 過去行2'].join('\n');
    expect(splitQuotedReplyText(t).latest).toBe('最新の返信です。');
  });
  it('引用が無ければ全文を latest に (quoted=null)', () => {
    const r = splitQuotedReplyText('ふつうの本文\n2行目');
    expect(r.latest).toBe('ふつうの本文\n2行目');
    expect(r.quoted).toBeNull();
  });
  it('先頭がいきなり引用なら分割しない (最新が空にならない)', () => {
    const t = ['-----Original Message-----', 'From: a@example.com', '', '本文'].join('\n');
    expect(splitQuotedReplyText(t).quoted).toBeNull();
  });
});

describe('normalizeMailPlainText (連続空行を1つの空行に統一)', () => {
  it('Outlook の「空行+空白行+空行」水増しを 1 空行に', () => {
    // 実データ相当: 段落区切りが \r\n\r\n (空白行) \r\n\r\n
    expect(normalizeMailPlainText('曲様\r\n\r\n \r\n\r\nお世話に\r\n\r\n \r\n\r\n契約書'))
      .toBe('曲様\n\nお世話に\n\n契約書');
    expect(normalizeMailPlainText('a\n\n　\n\nb')).toBe('a\n\nb'); // 全角スペースの空行
    expect(normalizeMailPlainText('a\n\n\n\n\n\nb')).toBe('a\n\nb');
  });
  it('段落区切り(1空行)と行内改行は保持', () => {
    expect(normalizeMailPlainText('段落1\n続き\n\n段落2')).toBe('段落1\n続き\n\n段落2');
    expect(normalizeMailPlainText('a\n\nb\n\nc')).toBe('a\n\nb\n\nc');
  });
  it('行末の空白除去', () => {
    expect(normalizeMailPlainText('a  \n\nb')).toBe('a\n\nb');
  });
});

describe('deEncapsulateHtml (RTF カプセル化 HTML → 元 HTML)', () => {
  it('\\htmltag の内容を出力し、\\htmlrtf 区間は無視、\\u で日本語復元', () => {
    // \fromhtml1 = カプセル化 HTML。\htmltag が元 HTML。\htmlrtf..\htmlrtf0 は RTF 専用で無視。
    const rtf = '{\\rtf1\\ansi\\ansicpg1252\\fromhtml1\\deff0'
      + '{\\*\\htmltag84 <html><body>}'
      + '{\\*\\htmltag112 <p>}'
      + 'Hello \\u12354 ?world'
      + '{\\*\\htmltag104 </p>}'
      + '\\htmlrtf \\par \\htmlrtf0'
      + '{\\*\\htmltag72 </body></html>}'
      + '}';
    const html = deEncapsulateHtml(rtf);
    expect(html).toBe('<html><body><p>Hello あworld</p></body></html>');
  });
  it('Shift_JIS(cp932) のマルチバイト \\\'xx\\\'xx を正しくデコード (文字化けしない)', () => {
    // \'82\'a0 = SJIS「あ」, \'82\'a2 =「い」。1 バイトずつだと文字化けする。
    const rtf = "{\\rtf1\\ansi\\ansicpg932\\fromhtml1{\\*\\htmltag <p>}\\'82\\'a0\\'82\\'a2{\\*\\htmltag </p>}}";
    expect(deEncapsulateHtml(rtf)).toBe('<p>あい</p>');
  });
  it('\\par / \\line は改行を出さない (改行は HTML タグ由来。Cc: 後の余計な改行防止)', () => {
    expect(deEncapsulateHtml('{\\rtf1\\fromhtml1{\\*\\htmltag <p>}Cc: a@x.com\\par b@x.com{\\*\\htmltag </p>}}'))
      .toBe('<p>Cc: a@x.comb@x.com</p>');
  });
  it('非カプセル化 (\\fromhtml なし) は null', () => {
    expect(deEncapsulateHtml('{\\rtf1\\ansi hello}')).toBeNull();
  });
  it('{\\*\\generator ...} 等の無視グループは出力しない', () => {
    const rtf = '{\\rtf1\\fromhtml1{\\*\\generator Microsoft}{\\*\\htmltag <b>x</b>}}';
    expect(deEncapsulateHtml(rtf)).toBe('<b>x</b>');
  });
  it('fonttbl / colortbl 等の RTF ヘッダを出力しない (MS PGothic 漏れ防止)', () => {
    // 実データは byte 列 (1文字=1バイト) なので本文は ASCII/エスケープで表現。
    const rtf = '{\\rtf1\\ansi\\fromhtml1\\deff0'
      + '{\\fonttbl{\\f0\\fnil\\fcharset128 MS PGothic;}{\\f1\\fswiss Arial;}}'
      + '{\\colortbl;\\red0\\green0\\blue0;}'
      + '{\\*\\htmltag <p>}hello{\\*\\htmltag </p>}}';
    const html = deEncapsulateHtml(rtf);
    expect(html).toBe('<p>hello</p>');
    expect(html).not.toMatch(/PGothic|Arial/);
  });
});

describe('stripHtml / 判定', () => {
  it('stripHtml', () => {
    expect(stripHtml('<p>a</p>b &amp; c')).toBe('a\nb & c');
    expect(stripHtml('x<br>y')).toBe('x\ny');
  });
  it('Outlook 風 HTML は二重改行にせず単一行間', () => {
    // MsoNormal 段落 (改行のみ)
    expect(stripHtml('<div><p class=MsoNormal>一行目<o:p></o:p></p><p class=MsoNormal>二行目<o:p></o:p></p></div>')).toBe('一行目\n二行目');
    // <div>text<br></div> の冗長 <br> で二重改行にならない
    expect(stripHtml('<div>a<br></div><div>b<br></div>')).toBe('a\nb');
  });
  it('意図的な空行 (空段落 / <div><br></div>) は 1 空行として保持', () => {
    expect(stripHtml('<p>一行目</p><p><o:p>&nbsp;</o:p></p><p>二行目</p>')).toBe('一行目\n\n二行目');
    expect(stripHtml('<div>a</div><div><br></div><div>b</div>')).toBe('a\n\nb');
  });
  it('looksLikeEml / looksLikeOutlookDrag', () => {
    expect(looksLikeEml('From: a@b.com\nSubject: x\n\nbody')).toBe(true);
    expect(looksLikeEml('ただの文章です')).toBe(false);
    expect(looksLikeOutlookDrag('差出人: x\n件名: y')).toBe(true);
  });
});
