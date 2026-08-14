import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { fitSingleLine } from '../src/lib/vulnResponseSync';

// 連携用リストへの書込を、SharePoint と同じ振る舞いのスタブに対して検証する。
//
// ★ 再現したい事故
//   SharePoint は body にリストへ無い列が 1 つでも入っていると **その 1 件ごと 400**
//   を返す。Mikke 側に列を足したあと連携用リストを構築し直していない環境では、
//   追加も更新も全件失敗し「連携リストへの更新でエラーになる」状態になっていた。

/** 単一行テキスト列 (SharePoint 既定 255 文字・改行不可)。 */
const TEXT_COLUMNS = new Set([
  'Title', 'VulnTitle', 'LegacyMgmtNumber', 'DetectionStatus',
  'AssetIp', 'AssetFqdn', 'AssetType', 'BusinessCompany', 'AffiliateCompany',
  'AssetMgmtId', 'ExtConnAppId',
]);

/** 旧レイアウトのまま = 最近足した LegacyMgmtNumber / ExtConnAppId が無い連携用リスト。 */
const COLUMNS = new Set([
  'Title', 'IssueInstanceId', 'DetectionStatus', 'FirstSeen', 'LastSeen',
  'AssetIp', 'AssetFqdn', 'AssetType', 'BusinessCompany', 'AffiliateCompany',
  'AssetMgmtId', 'RelatedAssets', 'IdentifyEvidence',
  'ResponseStatus', 'Responder', 'DueDate', 'ResponseNote', 'Remarks', 'ID', 'Modified',
  // 欠けているもの: VulnTitle / LegacyMgmtNumber / ExtConnAppId / ReportUrl
]);

const posted: { path: string; columns: string[] }[] = [];
let server: http.Server;
let base = '';

function startStub(): Promise<void> {
  server = http.createServer((req, res) => {
    const u = new URL(req.url!, 'http://x');
    const path = decodeURIComponent(u.pathname);
    const json = (o: unknown, code = 200): void => {
      res.writeHead(code, { 'Content-Type': 'application/json;odata=verbose' });
      res.end(JSON.stringify(o));
    };
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (path === '/_api/contextinfo') {
        return json({ d: { GetContextWebInformation: { FormDigestValue: 'D', FormDigestTimeoutSeconds: 1800 } } });
      }
      if (u.searchParams.get('$select') === 'InternalName') {
        return json({ d: { results: [...COLUMNS].map((n) => ({ InternalName: n })) } });
      }
      if (u.searchParams.get('$select') === 'ListItemEntityTypeFullName') {
        return json({ d: { ListItemEntityTypeFullName: 'SP.Data.MikkeVulnResponseListItem' } });
      }
      if (req.method === 'POST' && /\/items(\(\d+\))?$/.test(path)) {
        const b = JSON.parse(body || '{}') as Record<string, unknown>;
        const cols = Object.keys(b).filter((k) => k !== '__metadata');
        posted.push({ path, columns: cols });
        const unknown = cols.filter((k) => !COLUMNS.has(k));
        if (unknown.length) {
          // 本物と同じ形のエラー
          return json({ error: { message: { value:
            `The property '${unknown[0]}' does not exist on type 'SP.Data.MikkeVulnResponseListItem'.` } } }, 400);
        }
        // ★ 単一行テキストに 255 文字超 / 改行 が入ると本物は 500 を返す。
        const badText = cols.filter((k) => TEXT_COLUMNS.has(k)
          && typeof b[k] === 'string' && (String(b[k]).length > 255 || /[\r\n]/.test(String(b[k]))));
        if (badText.length) {
          return json({ error: { message: { value:
            'テキストの値が正しくありません。テキストのフィールドに正しくない値が含まれています。値を確認し、再度行ってください。' } } }, 500);
        }
        return json({ d: { Id: 1 } }, 201);
      }
      json({ error: 'not handled' }, 404);
    });
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => {
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    r();
  }));
}

const FIELDS = {
  issueInstanceId: 'IID-1', title: 'TLS 1.0 有効', legacyMgmtNumber: 'AAA-2606-01',
  detectionStatus: '継続', firstSeen: '2026-05-01T00:00:00Z', lastSeen: '2026-07-30T00:00:00Z',
  assetIp: '', assetFqdn: 'web01.example.com', assetType: 'FQDN',
  businessCompany: 'エナジー事業', affiliateCompany: 'ABC株式会社', assetMgmtId: 'W-0001',
  extConnAppId: 'EXT-1', relatedAssets: '', identifyEvidence: 'FQDN一致',
  reportUrl: '/sites/x/Shared Documents/MikkeDownloads/issues/20260808-101500/IID-1_20260808.pdf',
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let repo: any;

beforeAll(async () => {
  await startStub();
  const loc = { origin: base, pathname: '/sites/x/SitePages/Home.aspx', href: `${base}/sites/x/SitePages/Home.aspx` };
  const g = globalThis as Record<string, unknown>;
  g.location = loc;
  g.localStorage = { getItem: () => null, setItem: () => undefined };
  g.window = { location: loc, localStorage: g.localStorage, _spPageContextInfo: { webAbsoluteUrl: base } };
  g.document = { getElementById: () => null };
  const { SpRepository } = await import('../src/api/sp');
  repo = new SpRepository();
  repo.webUrl = base;
});

afterAll(() => { server?.close(); });

describe('連携用リストへの書込: リストに無い列を送らない', () => {
  it('足りない列を名指しで報告する (エラーに出して構築を促すため)', async () => {
    expect(await repo.findMissingVulnResponseColumns()).toEqual(
      ['VulnTitle', 'LegacyMgmtNumber', 'ReportUrl', 'ExtConnAppId',
        'ResponsePlan', 'NoAppReason']);
  });

  it('★ 絞らずに送ると SharePoint は 400 を返す (これが「反映が全件エラー」の正体)', async () => {
    const row = repo.vulnResponseRow(FIELDS);
    await expect(repo.spPost(
      `/_api/web/lists/getbytitle('MikkeVulnResponse')/items`,
      { __metadata: { type: 'SP.Data.MikkeVulnResponseListItem' }, ...row },
    )).rejects.toThrow(/400/);
  });

  it('createVulnResponseItem は実在列だけを送るので通る', async () => {
    posted.length = 0;
    await expect(repo.createVulnResponseItem(FIELDS)).resolves.toBeUndefined();
    const cols = posted.at(-1)!.columns;
    expect(cols).not.toContain('LegacyMgmtNumber');
    expect(cols).not.toContain('ExtConnAppId');
    expect(cols).toContain('Title');          // 突合キーは組込みの Title
    expect(cols).toContain('AssetMgmtId');
  });

  it('差分が欠落列だけの更新は、要求そのものを出さない', async () => {
    posted.length = 0;
    await expect(repo.updateVulnResponseItem(1, { extConnAppId: 'EXT-9' })).resolves.toBeUndefined();
    expect(posted).toEqual([]);
  });

  it('実在列を含む更新は通る (欠落列だけが落ちる)', async () => {
    posted.length = 0;
    await expect(repo.updateVulnResponseItem(1, { detectionStatus: '再検知', extConnAppId: 'EXT-9' }))
      .resolves.toBeUndefined();
    expect(posted.at(-1)!.columns).toEqual(['DetectionStatus']);
  });
});

describe('連携用リストへの書込: 単一行テキストに収まらない値', () => {
  // ★ 実機で出たエラー:
  //   HTTP 500 - テキストの値が正しくありません。テキストのフィールドに
  //   正しくない値が含まれています。値を確認し、再度行ってください。
  //   列が揃っていても、単一行テキスト列 (既定 255 文字・改行不可) に
  //   収まらない値を送ると SharePoint は保存時に 500 で拒否する。
  const LONG_FQDN = Array.from({ length: 40 }, (_, i) => `host${i}.example.com`).join(' | ');

  it('★ 255 文字超をそのまま送ると 500 になる (実機のエラーの正体)', async () => {
    expect(LONG_FQDN.length).toBeGreaterThan(255);
    await expect(repo.spPost(
      `/_api/web/lists/getbytitle('MikkeVulnResponse')/items`,
      { __metadata: { type: 'SP.Data.MikkeVulnResponseListItem' },
        Title: 'IID-L', AssetFqdn: LONG_FQDN },
    )).rejects.toThrow(/500/);
  });

  it('改行入りをそのまま送っても 500 になる', async () => {
    await expect(repo.spPost(
      `/_api/web/lists/getbytitle('MikkeVulnResponse')/items`,
      { __metadata: { type: 'SP.Data.MikkeVulnResponseListItem' },
        Title: 'a\nb' },
    )).rejects.toThrow(/500/);
  });

  it('toVulnResponseFields を通した値なら通る', async () => {
    const f = { ...FIELDS, assetFqdn: LONG_FQDN, title: 'a\nb' };
    const fitted = {
      ...f,
      assetFqdn: fitSingleLine(f.assetFqdn),
      title: fitSingleLine(f.title),
    };
    await expect(repo.createVulnResponseItem(fitted)).resolves.toBeUndefined();
  });
});

describe('連携用リストの「脆弱性レポート」列 (URL 列)', () => {
  // 資産管理者が一覧から 1 クリックで PDF を開けるようにするための列。
  it('URL 列は {Url, Description} で送り、表示テキストは「レポートを開く」', async () => {
    const row = repo.vulnResponseRow(FIELDS) as Record<string, { Url: string; Description: string }>;
    expect(row.ReportUrl.Url).toBe(FIELDS.reportUrl);
    expect(row.ReportUrl.Description).toBe('レポートを開く');
  });

  it('レポート未取得なら null を送って列を空にする', async () => {
    const row = repo.vulnResponseRow({ ...FIELDS, reportUrl: '' }) as Record<string, unknown>;
    expect(row.ReportUrl).toBeNull();
  });
});

describe('アイテム単位アクセス権の適用 (SharePoint への要求)', () => {
  // ★ 順序が肝。継承解除 → 先に付与 → 付与したもの以外を削除、で行う。
  //   付与より先に削除すると、実行者がアイテムを見失って以降が 400 になる。
  const calls: { method: string; path: string }[] = [];

  beforeAll(() => {
    // このブロックだけ SP 呼び出しを記録するスタブに差し替える
    repo.spGet = async (path: string): Promise<unknown> => {
      calls.push({ method: 'GET', path });
      if (path.includes('roledefinitions')) {
        return { d: { results: [
          { Id: 1073741826, RoleTypeKind: 2 }, { Id: 1073741827, RoleTypeKind: 3 },
          { Id: 1073741829, RoleTypeKind: 5 },
        ] } };
      }
      if (path.includes('currentuser/groups')) return { d: { results: [{ Id: 11 }] } };
      if (path.includes('currentuser')) return { d: { Id: 99, IsSiteAdmin: false } };
      if (path.includes('roleassignments')) {
        // 継承解除で付く既定グループ + 実行者の個別権限が残っている状態
        return { d: { results: [{ PrincipalId: 11 }, { PrincipalId: 12 }, { PrincipalId: 77 }, { PrincipalId: 99 }] } };
      }
      return { d: { results: [] } };
    };
    repo.spPost = async (path: string, _b?: unknown, h?: Record<string, string>): Promise<unknown> => {
      calls.push({ method: h?.['X-HTTP-Method'] ?? 'POST', path });
      return {};
    };
    repo.getSettings = async (): Promise<unknown> => ({
      managedColumns: [], matchConditions: null, individualIds: [],
      vulnResponsePerms: { adminGroupIds: [11], byBusinessCompany: { 'エナジー事業': [12] } },
    });
  });

  it('継承解除 → 付与 → 不要な割当の削除、の順に呼ぶ', async () => {
    calls.length = 0;
    const r = await repo.applyVulnResponseItemPerms([{ id: 5, businessCompany: 'エナジー事業' }]);
    expect(r).toEqual({ applied: 1, adminOnly: 0, errors: [] });

    const seq = calls.filter((c) => c.path.includes('items(5)')).map((c) => {
      if (c.path.includes('breakroleinheritance')) return '継承解除';
      if (c.path.includes('addroleassignment')) return `付与 ${/principalid=(\d+)/.exec(c.path)![1]}=${/roledefid=(\d+)/.exec(c.path)![1]}`;
      if (c.method === 'DELETE') return `削除 ${/getbyprincipalid\((\d+)\)/.exec(c.path)![1]}`;
      return '取得';
    });
    expect(seq).toEqual([
      '継承解除',
      '付与 11=1073741829',   // 管理者 = フルコントロール
      '付与 12=1073741827',   // 事業会社の割当 = 投稿
      '取得',
      '削除 77',              // 付与していない既定グループだけ消す
      '削除 99',              // 実行者は管理者グループの一員なので個別権限を残さない
    ]);
  });

  it('★ 継承解除は copyroleassignments=false (既定の割当を持ち込まない)', async () => {
    calls.length = 0;
    await repo.applyVulnResponseItemPerms([{ id: 5, businessCompany: 'エナジー事業' }]);
    const brk = calls.find((c) => c.path.includes('breakroleinheritance'))!;
    expect(brk.path).toContain('copyroleassignments=false');
    expect(brk.path).toContain('clearsubscopes=true');
  });

  it('割当が無い事業会社は管理者のみ (adminOnly に数える)', async () => {
    const r = await repo.applyVulnResponseItemPerms([{ id: 6, businessCompany: '未登録の会社' }]);
    expect(r).toEqual({ applied: 0, adminOnly: 1, errors: [] });
  });

  it('未設定なら適用そのものを行わない', async () => {
    const orig = repo.getSettings;
    repo.getSettings = async (): Promise<unknown> => ({ managedColumns: [], matchConditions: null, individualIds: [] });
    await expect(repo.applyVulnResponseItemPerms([{ id: 5, businessCompany: 'A' }])).rejects.toThrow(/未設定/);
    repo.getSettings = orig;
  });
});
