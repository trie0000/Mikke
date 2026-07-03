import { describe, it, expect } from 'vitest';
import { parseEml, parseOutlookDragText, stripHtml, looksLikeEml, looksLikeOutlookDrag, normalizeMailPlainText, splitQuotedReplyText } from '../src/lib/emlParser';

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

describe('normalizeMailPlainText (段落は保持・水増しは詰める)', () => {
  it('通常メールの段落区切り(空行)は保持', () => {
    expect(normalizeMailPlainText('a\n\nb\n\nc\n\nd')).toBe('a\n\nb\n\nc\n\nd'); // 短い→非二重行間
    expect(normalizeMailPlainText('段落1\n続き\n\n段落2')).toBe('段落1\n続き\n\n段落2');
  });
  it('二重行間(1行ごとに空行)は詰める。段落区切り(空行2つ)は残す', () => {
    // 6行すべてが直後に空行 = 改行の水増し → 1行ずつに詰める
    expect(normalizeMailPlainText('l1\n\nl2\n\nl3\n\nl4\n\nl5\n\nl6')).toBe('l1\nl2\nl3\nl4\nl5\nl6');
    // 空行2つ(段落区切り)は水増しの中でも残す
    expect(normalizeMailPlainText('l1\n\nl2\n\nl3\n\nl4\n\nl5\n\n\np2')).toBe('l1\nl2\nl3\nl4\nl5\n\np2');
  });
  it('行末の空白除去', () => {
    expect(normalizeMailPlainText('a  \n\nb')).toBe('a\n\nb');
  });
});

describe('stripHtml / 判定', () => {
  it('stripHtml', () => {
    expect(stripHtml('<p>a</p>b &amp; c')).toBe('a\nb & c');
    expect(stripHtml('x<br>y')).toBe('x\ny');
  });
  it('looksLikeEml / looksLikeOutlookDrag', () => {
    expect(looksLikeEml('From: a@b.com\nSubject: x\n\nbody')).toBe(true);
    expect(looksLikeEml('ただの文章です')).toBe(false);
    expect(looksLikeOutlookDrag('差出人: x\n件名: y')).toBe(true);
  });
});
