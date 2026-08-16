import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import { getScannerApi, setScannerApi, hasScannerApi, scannerApiArgs } from '../src/utils/scannerApi';

// 検査ツール API の接続情報は **この端末にだけ** 置き、relay へは実行のたびに
// 引数で渡す。env / SharePoint には置かない。

const g = globalThis as unknown as {
  localStorage?: {
    getItem(k: string): string | null;
    setItem(k: string, v: string): void;
    removeItem(k: string): void;
  };
};

let store: Record<string, string> = {};
beforeEach(() => {
  store = {};
  g.localStorage = {
    getItem: (k) => (k in store ? store[k]! : null),
    setItem: (k, v) => { store[k] = v; },
    removeItem: (k) => { delete store[k]; },
  };
});

describe('検査ツール API の設定 (端末ローカル)', () => {
  it('保存して読み戻せる', () => {
    setScannerApi({ base: 'https://api.example.com', key: 'k-123' });
    expect(getScannerApi()).toEqual({ base: 'https://api.example.com', key: 'k-123' });
    expect(hasScannerApi()).toBe(true);
  });

  it('末尾のスラッシュは落とす (URL の組み立てで // にならないように)', () => {
    setScannerApi({ base: 'https://api.example.com/', key: 'k' });
    expect(getScannerApi().base).toBe('https://api.example.com');
  });

  it('空文字で保存すると消える', () => {
    setScannerApi({ base: 'https://api.example.com', key: 'k' });
    setScannerApi({ base: '', key: '' });
    expect(getScannerApi()).toEqual({ base: '', key: '' });
    expect(hasScannerApi()).toBe(false);
  });

  it('片方だけでは「設定済み」にしない', () => {
    setScannerApi({ base: 'https://api.example.com', key: '' });
    expect(hasScannerApi()).toBe(false);
  });
});

describe('★ relay へ渡す引数', () => {
  it('設定してあれば apiBase / apiKey を載せる', () => {
    setScannerApi({ base: 'https://api.example.com', key: 'k-123' });
    expect(scannerApiArgs()).toEqual({ apiBase: 'https://api.example.com', apiKey: 'k-123' });
  });

  it('★ 未設定の項目は載せない (空文字で relay の設定を上書きしないため)', () => {
    expect(scannerApiArgs()).toEqual({});
    setScannerApi({ base: 'https://api.example.com', key: '' });
    expect(scannerApiArgs()).toEqual({ apiBase: 'https://api.example.com' });
  });
});

describe('★ relay へ実際に送られる body', () => {
  /** fetch を差し替えて、送った body を覗く。 */
  async function capture(run: () => Promise<unknown>): Promise<Record<string, unknown>> {
    let body: Record<string, unknown> = {};
    (globalThis as unknown as { fetch: unknown }).fetch = async (_u: string, init: { body: string }) => {
      body = JSON.parse(init.body) as Record<string, unknown>;
      return { ok: true, json: async () => ({ ok: true }) };
    };
    try { await run(); } finally { delete (globalThis as unknown as { fetch?: unknown }).fetch; }
    return body;
  }

  it('情報更新 (1 件) に apiBase / apiKey が載る', async () => {
    setScannerApi({ base: 'https://api.example.com', key: 'k-1' });
    const { relayGetIssue } = await import('../src/api/relay');
    const body = await capture(() => relayGetIssue('IID-1'));
    expect(body).toEqual({ issueInstanceId: 'IID-1', apiBase: 'https://api.example.com', apiKey: 'k-1' });
  });

  it('情報更新 (複数件) にも載る', async () => {
    setScannerApi({ base: 'https://api.example.com', key: 'k-1' });
    const { relayGetIssues } = await import('../src/api/relay');
    const body = await capture(() => relayGetIssues(['A', 'B'], true));
    expect(body).toMatchObject({ issueInstanceIds: ['A', 'B'], includeReport: true, apiKey: 'k-1' });
  });

  it('ダウンロードにも載る', async () => {
    setScannerApi({ base: 'https://api.example.com', key: 'k-1' });
    const { relayDownloadFromScanner } = await import('../src/api/relay');
    const body = await capture(() => relayDownloadFromScanner(['issues']));
    expect(body).toMatchObject({ types: ['issues'], apiBase: 'https://api.example.com' });
  });

  it('★ 未設定なら項目自体を送らない (relay 側の設定を空で潰さない)', async () => {
    const { relayGetIssue } = await import('../src/api/relay');
    const body = await capture(() => relayGetIssue('IID-1'));
    expect(body).toEqual({ issueInstanceId: 'IID-1' });
    expect('apiKey' in body).toBe(false);
  });

  it('CSV 解析のような API を使わない経路には載せない', async () => {
    const relay = fs.readFileSync('src/api/relay.ts', 'utf8');
    const csv = relay.slice(relay.indexOf('export function relayCsvParse'), relay.indexOf('export async function relayGetVersion'));
    expect(csv).not.toContain('scannerApiArgs');
  });
});

describe('★ 秘密情報を残さない作りになっていること', () => {
  it('検査ツールを呼ぶ 4 つの経路すべてに引数を載せている', () => {
    const relay = fs.readFileSync('src/api/relay.ts', 'utf8');
    // /issue, /issue-report, /issues, /download
    expect((relay.match(/scannerApiArgs\(\)/g) ?? []).length).toBe(4);
  });

  it('SharePoint の共通設定には保存しない', () => {
    const src = fs.readFileSync('src/utils/scannerApi.ts', 'utf8');
    expect(src).not.toContain('saveSettings');
    expect(src).not.toContain('getRepo');
  });

  it('env の見本に「ここには書かない」と明記してある', () => {
    const env = fs.readFileSync('dist/mikke-relay.env.example', 'utf8');
    expect(env).toContain('通常はここに書かない');
  });

  it('★ 中継サーバが 4 経路すべてで接続情報を受け取り、アダプタへ渡す', () => {
    const relay = fs.readFileSync('dist/mikke-relay.ps1', 'utf8');
    // body から取り出すヘルパを 4 か所で使っている (/issue /issue-report /issues /download)
    expect((relay.match(/Get-ScannerCredential -Parsed/g) ?? []).length).toBe(4);
    // 並列実行の runspace へは引数で渡す (呼び出し元の変数を引き継がないため)
    expect(relay).toContain('param($AdapterPath, $Iid, $WithReport, $ApiBase, $ApiKey)');
    expect(relay).toContain('param($AdapterPath, $Type, $ApiBase, $ApiKey)');
  });

  it('★ 古いアダプタ (引数を宣言していない) を壊さない', () => {
    const relay = fs.readFileSync('dist/mikke-relay.ps1', 'utf8');
    // 宣言を見てから渡す (PowerShell は宣言の無いパラメータでエラーになる)
    expect(relay).toContain("Parameters.ContainsKey('ApiBase')");
    expect(relay).toContain("Parameters.ContainsKey('ApiKey')");
    // 直接渡し (splat でない) が残っていないこと
    expect(relay).not.toMatch(/Invoke-MikkeScanner\w+ [^\n]*-ApiBase \$/);
  });

  it('relay を変えたのでバージョンを上げてある (自己更新で配るため)', () => {
    const relay = fs.readFileSync('dist/mikke-relay.ps1', 'utf8');
    const manifest = JSON.parse(fs.readFileSync('dist/relay-version.txt', 'utf8')) as { version: string };
    const inScript = /\$MIKKE_RELAY_VERSION = '([^']+)'/.exec(relay)?.[1];
    expect(inScript).toBe(manifest.version);
  });

  it('★ アダプタ仕様書が新しい契約 (引数で受け取る) で書かれている', () => {
    const spec = fs.readFileSync('dist/SCANNER-ADAPTER-SPEC.md', 'utf8');
    // 3 つの関数すべてに引数が入っている
    for (const must of [
      '-ApiBase <URL> -ApiKey <KEY>',            // 全体像の図
      '[string]$ApiBase',                        // 関数の署名
      '設定 → 個人設定 → 接続 → 検査ツール API', // 設定場所の案内
      '4-2. 環境変数はフォールバック',
      '4-3. 秘密情報を残さない',
    ]) {
      expect(spec, `${must} の記載が無い`).toContain(must);
    }
    // 旧方式 (env が原則) の記述が残っていない
    expect(spec).not.toContain('MIKKE_SCANNER_API_BASE が未設定です (mikke-relay.env に設定してください)');
  });

  it('★ 雛形スクリプトも新しい契約になっている', () => {
    const tpl = fs.readFileSync('dist/mikke-scanner-adapter.example.ps1', 'utf8');
    // Fetch / Download / IssueReport の 3 関数ぶん
    expect((tpl.match(/\[string\]\$ApiBase/g) ?? []).length).toBe(3);
    expect(tpl).not.toContain('param([Parameter(Mandatory = $true)][string]$IssueInstanceId)');
  });

  it('一括ダウンロードの依頼書も揃っている', () => {
    const md = fs.readFileSync('dist/SCANNER-ADAPTER-DOWNLOAD-REQUEST.md', 'utf8');
    expect(md).toContain('-ApiBase <string> -ApiKey <string>');
  });

  it('★ 変更依頼書はアダプタだけを対象にしている (relay はこちらで直す)', () => {
    const md = fs.readFileSync('dist/RELAY-API-CREDENTIALS-CHANGE.md', 'utf8');
    // API 仕様に依存するアダプタの直し方だけを書く
    for (const must of [
      '対象ファイル: `mikke-scanner-adapter.ps1` のみ',
      'Invoke-MikkeScannerFetch', 'Invoke-MikkeScannerIssueReport', 'Invoke-MikkeScannerDownload',
      'ApiBase', 'ApiKey', 'ログに', '後方互換',
    ]) {
      expect(md, `${must} の記載が無い`).toContain(must);
    }
    // relay の実装手順を依頼しない (この環境で直して git で同期する)
    expect(md).not.toContain('mikke-relay.ps1 の変更内容');
    expect(md).not.toContain('AddArgument');
    expect(md).toContain('中継サーバ (`mikke-relay.ps1`) は対応済み');
  });
});
