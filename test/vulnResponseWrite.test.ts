import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

// 連携用リストへの書込を、SharePoint と同じ振る舞いのスタブに対して検証する。
//
// ★ 再現したい事故
//   SharePoint は body にリストへ無い列が 1 つでも入っていると **その 1 件ごと 400**
//   を返す。Mikke 側に列を足したあと連携用リストを構築し直していない環境では、
//   追加も更新も全件失敗し「連携リストへの更新でエラーになる」状態になっていた。

/** 旧レイアウトのまま = 最近足した LegacyMgmtNumber / ExtConnAppId が無い連携用リスト。 */
const COLUMNS = new Set([
  'Title', 'IssueInstanceId', 'DetectionStatus', 'FirstSeen', 'LastSeen',
  'AssetIp', 'AssetFqdn', 'AssetType', 'BusinessCompany', 'AffiliateCompany',
  'AssetMgmtId', 'RelatedAssets', 'IdentifyEvidence',
  'ResponseStatus', 'Responder', 'DueDate', 'ResponseNote', 'Remarks', 'ID', 'Modified',
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
    expect(await repo.findMissingVulnResponseColumns()).toEqual(['LegacyMgmtNumber', 'ExtConnAppId']);
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
    expect(cols).toContain('IssueInstanceId');
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
