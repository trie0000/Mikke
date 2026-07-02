import { describe, it, expect } from 'vitest';
import { parseEml, parseOutlookDragText, stripHtml, looksLikeEml, looksLikeOutlookDrag } from '../src/lib/emlParser';

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
