import { describe, it, expect } from 'vitest';
import {
  nextOverseasDetection, toOpenStatus, toRegion, resolveOverseasColumns,
  missingOverseasColumns, buildOverseasPlan, OVERSEAS_COL,
} from '../src/lib/overseas';
import { parseFlexibleDate } from '../src/lib/migration';
import type { ManagedIssue, OverseasIssue } from '../src/types';

const NOW = '2026-08-15T00:00:00.000Z';
const H = [OVERSEAS_COL.issueInstanceId, OVERSEAS_COL.contactedAt, OVERSEAS_COL.open,
  OVERSEAS_COL.remarks, OVERSEAS_COL.region];

const row = (iid: string, date: string, open: string, region = 'APAC', remarks = ''): Record<string, string> => ({
  [OVERSEAS_COL.issueInstanceId]: iid,
  [OVERSEAS_COL.contactedAt]: date,
  [OVERSEAS_COL.open]: open,
  [OVERSEAS_COL.remarks]: remarks,
  [OVERSEAS_COL.region]: region,
});

const domestic = (over: Partial<ManagedIssue> = {}): ManagedIssue => ({
  id: 1, title: 'TLS 1.0 が有効', issueInstanceId: 'IID-1',
  detectionStatus: '継続', mgmtStatus: '未着手', isOutOfScope: false,
  businessCompany: 'エナジー事業', affiliateCompany: 'ABC株式会社',
  webMapsId: 'A1234567', identifyEvidence: 'FQDN 一致',
  lastSeen: '2026-07-31T00:00:00Z',
  scanFields: {
    'Scan_Asset IP': '203.0.113.10', 'Scan_Asset Domain': 'web01.example.com',
    'Scan_Asset Title': 'web01', 'Scan_Asset Mapped Domains': 'a.example.com | b.example.com',
    'Scan_Asset Homepage URL': 'https://web01.example.com/',
  },
  ...over,
} as ManagedIssue);

describe('open 列の読み取り', () => {
  it.each([['open', 'open'], ['Open', 'open'], ['OPEN', 'open'],
    ['closed/removed', 'closed/removed'], ['Closed/Removed', 'closed/removed'],
    ['closed', 'closed/removed'], ['removed', 'closed/removed'], ['close/remove', 'closed/removed'],
  ])('%s → %s', (raw, want) => {
    expect(toOpenStatus(raw)).toBe(want);
  });

  it('空や読めない値は null', () => {
    expect(toOpenStatus('')).toBeNull();
    expect(toOpenStatus('なんとか')).toBeNull();
  });
});

describe('REALM → 地域', () => {
  it.each([['NA/LA', 'NA/LA'], ['APAC', 'APAC'], ['CNA', 'CNA'], ['EU', 'EU'], ['ISAMEA', 'ISAMEA'],
    ['apac', 'APAC'], ['NA', 'NA/LA'], ['LA', 'NA/LA']])('%s → %s', (raw, want) => {
    expect(toRegion(raw)).toBe(want);
  });

  it('対応表に無い値はそのまま残す (勝手に捨てない)', () => {
    expect(toRegion('ANZ')).toBe('ANZ');
  });
});

describe('検知状況の遷移 (1 段ぶん)', () => {
  it.each([
    [undefined, 'open', '新規'],
    [undefined, 'closed/removed', '未検出(New)'],
    ['新規', 'open', '継続'],
    ['継続', 'open', '継続'],
    ['再検知', 'open', '継続'],
    ['新規', 'closed/removed', '未検出(New)'],
    ['継続', 'closed/removed', '未検出(New)'],
    ['未検出(New)', 'open', '再検知'],
    ['未検出', 'open', '再検知'],
    ['未検出(New)', 'closed/removed', '未検出'],
    ['未検出', 'closed/removed', '未検出'],
  ] as const)('%s + %s → %s', (prev, cur, want) => {
    expect(nextOverseasDetection(prev as never, cur as never)).toBe(want);
  });
});

describe('★ 追記型の Excel から履歴を積み上げる', () => {
  const plan = (rows: Record<string, string>[], existing: OverseasIssue[] = []) =>
    buildOverseasPlan(rows, H, existing, [domestic()], parseFlexibleDate, NOW);

  it('初回の open は新規', () => {
    expect(plan([row('IID-1', '2026-05-10', 'open')]).creates[0]!.detectionStatus).toBe('新規');
  });

  it('★ 毎月 open が積まれていれば継続', () => {
    const p = plan([
      row('IID-1', '2026-05-10', 'open'),
      row('IID-1', '2026-06-10', 'open'),
      row('IID-1', '2026-07-10', 'open'),
    ]);
    expect(p.creates[0]!.detectionStatus).toBe('継続');
    expect(p.creates[0]!.openStatus).toBe('open');
    expect(p.creates[0]!.contactedAt).toBe(parseFlexibleDate('2026-07-10'));   // 最新の通知日
  });

  it('★ 検知中のあとに close/removed が来たら未検出(New)', () => {
    expect(plan([
      row('IID-1', '2026-05-10', 'open'),
      row('IID-1', '2026-06-10', 'closed/removed'),
    ]).creates[0]!.detectionStatus).toBe('未検出(New)');
  });

  it('★ 未検出のあとに更に close/removed が来たら未検出', () => {
    expect(plan([
      row('IID-1', '2026-05-10', 'open'),
      row('IID-1', '2026-06-10', 'closed/removed'),
      row('IID-1', '2026-07-10', 'closed/removed'),
    ]).creates[0]!.detectionStatus).toBe('未検出');
  });

  it('★ 未検出のあとに open が来たら再検知', () => {
    expect(plan([
      row('IID-1', '2026-05-10', 'open'),
      row('IID-1', '2026-06-10', 'closed/removed'),
      row('IID-1', '2026-07-10', 'closed/removed'),
      row('IID-1', '2026-08-10', 'open'),
    ]).creates[0]!.detectionStatus).toBe('再検知');
  });

  it('★ 行の並びが日付順でなくても結果は同じ', () => {
    const a = plan([row('IID-1', '2026-08-10', 'open'), row('IID-1', '2026-05-10', 'open'),
      row('IID-1', '2026-06-10', 'closed/removed'), row('IID-1', '2026-07-10', 'closed/removed')]);
    expect(a.creates[0]!.detectionStatus).toBe('再検知');
  });

  it('★ 同じファイルを 2 回取り込んでも結果が変わらない', () => {
    const rows = [row('IID-1', '2026-05-10', 'open'), row('IID-1', '2026-06-10', 'open')];
    const first = plan(rows).creates[0]!;
    const existing: OverseasIssue[] = [{ ...first, id: 7 } as OverseasIssue];
    const second = plan(rows, existing);
    expect(second.creates).toHaveLength(0);
    expect(second.updates).toHaveLength(1);
    expect(second.updates[0]!.patch.detectionStatus).toBe('継続');   // 継続のまま (継続→継続)
  });

  it('★ 地域が違えば別の行として扱う (同じ脆弱性を複数地域へ通知)', () => {
    const p = plan([row('IID-1', '2026-05-10', 'open', 'APAC'), row('IID-1', '2026-05-10', 'open', 'EU')]);
    expect(p.creates).toHaveLength(2);
    expect(p.creates.map((c) => c.region).sort()).toEqual(['APAC', 'EU']);
    expect(p.entries).toBe(2);
  });

  it('★ ファイルに無い既存アイテムには触れない (地域ごとに分けて取り込むため)', () => {
    const existing: OverseasIssue[] = [
      { id: 9, issueInstanceId: 'IID-9', detectionStatus: '継続', region: 'EU' } as OverseasIssue,
    ];
    const p = plan([row('IID-1', '2026-05-10', 'open', 'APAC')], existing);
    expect(p.updates).toHaveLength(0);
  });
});

describe('国内の取込済みデータから埋める', () => {
  it('★ Excel に無い項目は国内分から引く', () => {
    const c = buildOverseasPlan([row('IID-1', '2026-05-10', 'open', 'APAC', '要確認')],
      H, [], [domestic()], parseFlexibleDate, NOW).creates[0]!;
    expect(c.title).toBe('TLS 1.0 が有効');
    expect(c.businessCompany).toBe('エナジー事業');
    expect(c.affiliateCompany).toBe('ABC株式会社');
    expect(c.webMapsId).toBe('A1234567');
    expect(c.identifyEvidence).toBe('FQDN 一致');
    expect(c.assetIp).toBe('203.0.113.10');
    expect(c.assetFqdn).toBe('web01.example.com');
    expect(c.assetTitle).toBe('web01');
    expect(c.assetMappedDomains).toBe('a.example.com | b.example.com');
    expect(c.assetHomepageUrl).toBe('https://web01.example.com/');
    expect(c.lastSeen).toBe('2026-07-31T00:00:00Z');
    expect(c.remarks).toBe('要確認');         // Excel の Remarks/Comments
    expect(c.region).toBe('APAC');
  });

  it('★ 国内に無い ID は名指しする (項目が空になることに気づけるように)', () => {
    const p = buildOverseasPlan([row('IID-X', '2026-05-10', 'open')], H, [], [domestic()],
      parseFlexibleDate, NOW);
    expect(p.unmatched).toEqual(['IID-X']);
    expect(p.creates[0]!.title).toBe('');
  });
});

describe('見出しの探し方', () => {
  it('表記が揺れても拾う', () => {
    const m = resolveOverseasColumns(['Issue ID', 'Date of Contact', 'Open', 'Remarks/Comments', 'Realm']);
    expect(m.issueInstanceId).toBe('Issue ID');
    expect(m.contactedAt).toBe('Date of Contact');
    expect(m.open).toBe('Open');
    expect(m.remarks).toBe('Remarks/Comments');
    expect(m.region).toBe('Realm');
    expect(missingOverseasColumns(m)).toEqual([]);
  });

  it('★ 足りない列は名指しする', () => {
    const m = resolveOverseasColumns(['Issue Instance ID']);
    expect(missingOverseasColumns(m)).toEqual([
      OVERSEAS_COL.contactedAt, OVERSEAS_COL.open, OVERSEAS_COL.region]);
  });

  it('突合キーが無ければ何も取り込まない', () => {
    const p = buildOverseasPlan([{ x: '1' }], ['x'], [], [], parseFlexibleDate, NOW);
    expect(p.creates).toEqual([]);
    expect(p.missingColumns).toContain(OVERSEAS_COL.issueInstanceId);
  });
});
