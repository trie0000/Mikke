import { describe, it, expect } from 'vitest';
import { describeNonJson } from '../src/api/sp';

const URL = 'https://example.sharepoint.com/sites/x/_api/web/lists/getbytitle(\'MikkeManagedIssues\')/items';

describe('describeNonJson: JSON を期待したのに HTML が返ったときの説明', () => {
  it('サインイン画面は「サインインし直す」と案内する', () => {
    const html = '<!DOCTYPE html><html><head><title>Sign in to your account</title>'
      + '<form action="https://login.microsoftonline.com/common/oauth2/authorize">';
    const msg = describeNonJson(html, URL);
    expect(msg).toContain('サインイン');
    expect(msg).toContain(URL);
  });

  it('アクセス権エラーは権限とサイト URL を疑わせる', () => {
    const html = "<!DOCTYPE html><html><body>Sorry, this site hasn't been shared with you.</body></html>";
    expect(describeNonJson(html, URL)).toContain('アクセス権');
  });

  it('ただの HTML はサイト URL の指定を疑わせる', () => {
    const msg = describeNonJson('<!DOCTYPE html><html><body>Something else</body></html>', URL);
    expect(msg).toContain('サイト URL');
  });

  it('HTML ですらない場合も URL と応答の先頭を出す', () => {
    const msg = describeNonJson('not json at all', URL);
    expect(msg).toContain('要求先: ' + URL);
    expect(msg).toContain('not json at all');
  });

  it('応答が長くても先頭 120 文字に切り詰める (画面が埋まらないように)', () => {
    const msg = describeNonJson('<html>' + 'x'.repeat(5000), URL);
    const head = msg.split('応答の先頭: ')[1] ?? '';
    expect(head.length).toBeLessThanOrEqual(120);
  });

  it('改行やインデントは 1 行に潰す (トーストで読めるように)', () => {
    const msg = describeNonJson('<!DOCTYPE html>\n  <html>\n    <body>a</body>\n</html>', URL);
    const head = msg.split('応答の先頭: ')[1] ?? '';
    expect(head).not.toContain('\n');
  });
});
