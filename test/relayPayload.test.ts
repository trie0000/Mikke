import { describe, it, expect } from 'vitest';
import fs from 'node:fs';

// 自己更新は「manifest / relay の許可リスト / バンドル同梱」の 3 つが一致して
// 初めて成立する。1 つでもズレると relay が 400 を返し **全ファイルが更新されない**
// (過去に mikke.loader.js を manifest だけに足して自己更新が全滅した)。
// ビルドでも弾いているが、こちらは npm test で即座に気づくための番人。

function names(re: RegExp, text: string): string[] {
  const m = text.match(re);
  return m ? [...m[1]!.matchAll(/'([^']+)'/g)].map((x) => x[1]!) : [];
}

const relayPs1 = fs.readFileSync('dist/mikke-relay.ps1', 'utf8');
const payloadTs = fs.readFileSync('src/utils/relayPayload.ts', 'utf8');
const manifest = JSON.parse(fs.readFileSync('dist/relay-version.txt', 'utf8')) as
  { version: string; files: string[] };

const allowed = names(/\$MIKKE_RELAY_MANAGED_FILES\s*=\s*@\(([\s\S]*?)\)/, relayPs1);
const bundled = [...payloadTs.matchAll(/name:\s*'([^']+)'/g)].map((x) => x[1]!);

describe('自己更新: 配布ファイル一覧の整合', () => {
  it('manifest のファイルは relay の許可リストに全部ある', () => {
    expect(manifest.files.filter((f) => !allowed.includes(f))).toEqual([]);
  });

  it('manifest のファイルはバンドルに全部同梱されている', () => {
    expect(manifest.files.filter((f) => !bundled.includes(f))).toEqual([]);
  });

  it('manifest の版数は relay 本体の版数と一致する', () => {
    // ズレていたら relay を編集して build していない (= 配布される manifest が古い)。
    const inPs1 = /\$MIKKE_RELAY_VERSION\s*=\s*'([^']+)'/.exec(relayPs1)?.[1];
    expect({ 'relay-version.txt': manifest.version, 'mikke-relay.ps1': inPs1 })
      .toEqual({ 'relay-version.txt': inPs1, 'mikke-relay.ps1': inPs1 });
  });
});

describe('自己更新: PowerShell スクリプトの BOM', () => {
  // .ps1 は UTF-8 BOM 必須 (無いと PowerShell 5.1 で文字化けする)。ただし 2 個あると
  // 先頭の param ブロックが解釈されず引数が全部無視される (過去に -Port が効かなくなった)。
  it.each(['dist/mikke-relay.ps1', 'dist/mikke-launch.ps1'])('%s の BOM はちょうど 1 個', (p) => {
    const b = fs.readFileSync(p);
    expect([b[0], b[1], b[2]]).toEqual([0xef, 0xbb, 0xbf]);
    expect([b[3], b[4], b[5]]).not.toEqual([0xef, 0xbb, 0xbf]);
  });
});

describe('自己更新: 生成される updater.bat は ASCII のみ', () => {
  // ★ 実機 (日本語 Windows) で再現した事故:
  //   cmd.exe は .bat をシステム ANSI コードページ (CP932) で解釈する。
  //   UTF-8 の日本語を書くと化けたバイト列が行を分断し、バッチが別のコマンドとして
  //   実行されて置換も再起動も起きない。relay は既に終了しているので
  //   「更新したら中継サーバが落ちたまま」になる。
  const src = fs.readFileSync('dist/mikke-relay.ps1', 'utf8');
  const start = src.indexOf('$batContent = @"');
  const bat = src.slice(start, src.indexOf('\n"@', start));

  it('here-string の中身に非 ASCII が無い', () => {
    const bad = [...bat].filter((c) => c.charCodeAt(0) > 127);
    expect(bad).toEqual([]);
  });

  it('ASCII エンコードで書き出している', () => {
    expect(src).toContain('[System.Text.ASCIIEncoding]::new()');
  });

  it('待機は timeout ではなく ping (標準入力がリダイレクトされていても動く)', () => {
    expect(bat).not.toContain('timeout /t');
    expect(bat).toContain('ping -n 2 127.0.0.1');
  });

  it('再起動時にポートを引き継ぐ', () => {
    expect(bat).toContain('-Port %RELAY_PORT%');
  });

  it('居残り relay の掃除はポート所有者ではなく自分のスクリプトを狙う', () => {
    // HttpListener は http.sys (カーネル) が待受を持つため、
    // Get-NetTCPConnection の OwningProcess は PID 4 (System) になる (実機で確認)。
    // それを Stop-Process -Force するのは掃除にならないうえ危ない。
    expect(bat).not.toContain('Get-NetTCPConnection');
    expect(bat).toContain("CommandLine -like '*%SCRIPT_DIR%mikke-relay.ps1*'");
    expect(bat).toContain('Stop-Process -Id `$_.ProcessId -Force');
  });
});
