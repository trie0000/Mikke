import { describe, it, expect } from 'vitest';
import { parseXlsxSheet } from '../src/lib/xlsx';
import { parseFlexibleDate, OTHER_COMPANY } from '../src/lib/migration';
import {
  buildOverseasMigrationPlan, indexOverseasByKey, migrateOverseasRow, resolveOvsMigColumns,
  splitIpAndFqdn, splitOverseasMigrationWrites, OVS_MIG_COL,
} from '../src/lib/overseasMigration';
import { overseasKey } from '../src/lib/overseas';
import type { OverseasIssue } from '../src/types';

// ── xlsx の組み立て (実ファイルと同じ形で読ませる) ─────────────────────────
function buildZip(files: [string, string][]): ArrayBuffer {
  const enc = new TextEncoder();
  const locals: Uint8Array[] = []; const central: Uint8Array[] = [];
  let offset = 0;
  const crcTable = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
    return t;
  })();
  const crc32 = (b: Uint8Array): number => {
    let c = 0xffffffff;
    for (let i = 0; i < b.length; i++) c = crcTable[(c ^ b[i]!) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const w = (n: number, bytes: number): number[] => {
    const out: number[] = [];
    for (let i = 0; i < bytes; i++) out.push((n >>> (i * 8)) & 0xff);
    return out;
  };
  for (const [name, content] of files) {
    const nameB = enc.encode(name); const data = enc.encode(content);
    const c = crc32(data);
    const local = new Uint8Array([...w(0x04034b50, 4), ...w(20, 2), ...w(0, 2), ...w(0, 2), ...w(0, 2), ...w(0, 2),
      ...w(c, 4), ...w(data.length, 4), ...w(data.length, 4), ...w(nameB.length, 2), ...w(0, 2), ...nameB, ...data]);
    locals.push(local);
    central.push(new Uint8Array([...w(0x02014b50, 4), ...w(20, 2), ...w(20, 2), ...w(0, 2), ...w(0, 2), ...w(0, 2), ...w(0, 2),
      ...w(c, 4), ...w(data.length, 4), ...w(data.length, 4), ...w(nameB.length, 2), ...w(0, 2), ...w(0, 2),
      ...w(0, 2), ...w(0, 2), ...w(0, 4), ...w(offset, 4), ...nameB]));
    offset += local.length;
  }
  const cdSize = central.reduce((s, x) => s + x.length, 0);
  const eocd = new Uint8Array([...w(0x06054b50, 4), ...w(0, 2), ...w(0, 2),
    ...w(files.length, 2), ...w(files.length, 2), ...w(cdSize, 4), ...w(offset, 4), ...w(0, 2)]);
  const out = new Uint8Array(offset + cdSize + eocd.length);
  let p = 0;
  for (const b of [...locals, ...central, eocd]) { out.set(b, p); p += b.length; }
  return out.buffer;
}

const colLetter = (n: number): string => {
  let s = ''; let x = n;
  do { s = String.fromCharCode(65 + (x % 26)) + s; x = Math.floor(x / 26) - 1; } while (x >= 0);
  return s;
};
const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * 実際の書式に合わせたブックを作る。
 * ★ シート名「list」/ テーブルオブジェクト「テーブル1」/ 見出しは **2 行目** から。
 *   1 行目には表題を置く (実ファイルと同じく、見出しが先頭行ではない)。
 */
function makeBook(headers: string[], rows: string[][]): ArrayBuffer {
  const cell = (ref: string, v: string): string =>
    `<c r="${ref}" t="inlineStr"><is><t>${esc(v)}</t></is></c>`;
  let sheetRows = `<row r="1">${cell('A1', '海外脆弱性 通知一覧')}</row>`;
  sheetRows += `<row r="2">${headers.map((h, i) => cell(`${colLetter(i)}2`, h)).join('')}</row>`;
  rows.forEach((r, ri) => {
    sheetRows += `<row r="${ri + 3}">${r.map((v, i) => cell(`${colLetter(i)}${ri + 3}`, v)).join('')}</row>`;
  });
  const ref = `A2:${colLetter(headers.length - 1)}${rows.length + 2}`;
  const sheetXml =
    '<?xml version="1.0"?><worksheet xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
    + `<sheetData>${sheetRows}</sheetData>`
    + '<tableParts count="1"><tablePart r:id="rId1"/></tableParts></worksheet>';
  const tableXml = `<table name="テーブル1" displayName="テーブル1" ref="${ref}" headerRowCount="1"><tableColumns>`
    + headers.map((h) => `<tableColumn name="${esc(h)}"/>`).join('') + '</tableColumns></table>';
  return buildZip([
    ['[Content_Types].xml', '<Types/>'],
    ['_rels/.rels', '<Relationships/>'],
    ['xl/workbook.xml',
      '<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
      + '<sheets><sheet name="list" sheetId="1" r:id="rId1"/></sheets></workbook>'],
    ['xl/_rels/workbook.xml.rels',
      '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>'],
    ['xl/worksheets/sheet1.xml', sheetXml],
    ['xl/worksheets/_rels/sheet1.xml.rels',
      '<Relationships><Relationship Id="rId1" Target="../tables/table1.xml"/></Relationships>'],
    ['xl/tables/table1.xml', tableXml],
  ]);
}

// 実ファイルの見出し (検知状況の見出しには検査ツール名が頭に付く)。
const HEADERS = [
  'Issue Instance ID', '通知日', 'ある検査ツールでの通知状況', '事業会社', '地域', '管理会社',
  'WebMaps登録情報', 'その他参考情報', 'IP/URL', '脆弱性',
  'Asset Title', 'Asset Mapped Domains', 'Asset Homepage URL', '最終検知日', '備考',
];
const ROW1 = [
  'IID-1', '2026-06-10', '継続', 'ENG', 'APAC', 'ABC株式会社',
  '登録あり A1234567', 'FQDN 一致', 'https://web01.example.com/login?a=1', 'TLS 1.0 が有効',
  'web01', 'a.example.com | b.example.com', 'https://web01.example.com/', '2026-07-31', '継続監視',
];

const PERMS = {
  adminGroupIds: [11],
  byBusinessCompany: { エナジー事業: [12], その他: [] },
  aliasesByCompany: { エナジー事業: ['ENG'] },
};

const parsed = (headers = HEADERS, rows = [ROW1]) => {
  const sheet = parseXlsxSheet(makeBook(headers, rows), 'list');
  if (!sheet) throw new Error('シート list が読めない');
  return sheet;
};

const plan = (rows = [ROW1], headers = HEADERS, remap: unknown = []) => {
  const sheet = parsed(headers, rows);
  return buildOverseasMigrationPlan(sheet.rows, sheet.headers, PERMS, remap,
    parseFlexibleDate, '2026-08-15T00:00:00.000Z');
};

describe('★ 実ファイルの形 (シート list / テーブル / 見出しは 2 行目) を読める', () => {
  it('表題行を飛ばし、テーブルの見出し行から読む', () => {
    expect(parsed().headers).toEqual(HEADERS);
    expect(parsed().rows).toHaveLength(1);
  });

  it('見つからない列が無い', () => {
    expect(plan().missingColumns).toEqual([]);
  });

  it('検知状況の見出しは検査ツール名が付いていても見つかる (後半の一致で探す)', () => {
    const cols = resolveOvsMigColumns(HEADERS);
    expect(cols.byKey.detection).toBe('ある検査ツールでの通知状況');
    expect(cols.missing).toEqual([]);
  });

  it('1 件ぶんの内容が全部入る', () => {
    const issue = plan().rows[0]!.issue!;
    expect(issue).toMatchObject({
      issueInstanceId: 'IID-1',
      detectionStatus: '継続',
      region: 'APAC',
      businessCompany: 'エナジー事業',     // 略称 ENG から解決
      affiliateCompany: 'ABC株式会社',
      webMapsId: 'A1234567',               // 説明文が付いていても ID だけ抜く
      identifyEvidence: 'FQDN 一致',
      title: 'TLS 1.0 が有効',
      assetTitle: 'web01',
      assetMappedDomains: 'a.example.com | b.example.com',
      assetHomepageUrl: 'https://web01.example.com/',
      remarks: '継続監視',
      importedAt: '2026-08-15T00:00:00.000Z',
    });
    // 通知日・最終検知日は JST の壁時計として読む (UTC 扱いだと 1 日ずれる)
    expect(issue.contactedAt).toBe('2026-06-09T15:00:00.000Z');
    expect(issue.lastSeen).toBe('2026-07-30T15:00:00.000Z');
    // この Excel には open 列が無いので openStatus は持たない
    expect(issue.openStatus).toBeUndefined();
  });
});

describe('IP/URL を IP と FQDN に分ける', () => {
  it('URL はスキーム (http/https) を外してホスト名だけにする', () => {
    expect(splitIpAndFqdn('https://web01.example.com/login?a=1'))
      .toEqual({ ip: '', fqdn: 'web01.example.com' });
    expect(splitIpAndFqdn('http://web01.example.com:8443/x'))
      .toEqual({ ip: '', fqdn: 'web01.example.com' });
  });

  it('IP は IP 側に入れる', () => {
    expect(splitIpAndFqdn('203.0.113.10')).toEqual({ ip: '203.0.113.10', fqdn: '' });
    expect(splitIpAndFqdn('http://203.0.113.10/')).toEqual({ ip: '203.0.113.10', fqdn: '' });
  });

  it('複数書かれていたら全部拾う (改行 / | / カンマ)', () => {
    const r = splitIpAndFqdn('203.0.113.10\nhttps://a.example.com/ | b.example.com, 203.0.113.11');
    expect(r.ip).toBe('203.0.113.10 | 203.0.113.11');
    expect(r.fqdn).toBe('a.example.com | b.example.com');
  });

  it('同じ値は 1 回だけ並べる', () => {
    expect(splitIpAndFqdn('a.example.com | https://a.example.com/x').fqdn).toBe('a.example.com');
  });

  it('★ スキームの無い値は切らない (N/A が N になる取り違えを防ぐ)', () => {
    // 「/」で機械的に切ると N/A が N になる。URL と分かる場合だけ切る。
    expect(splitIpAndFqdn('N/A')).toEqual({ ip: '', fqdn: '' });     // 値なしとして捨てる
    expect(splitIpAndFqdn('web01')).toEqual({ ip: '', fqdn: 'web01' });
  });

  it('値なしの書き方は捨てる', () => {
    for (const v of ['', '-', '—', 'なし', 'none', '#N/A']) {
      expect(splitIpAndFqdn(v), v).toEqual({ ip: '', fqdn: '' });
    }
  });
});

describe('事業会社の判定 (国内の移行と同じ扱い)', () => {
  it('登録済みの略称は事業会社に直す', () => {
    expect(plan().rows[0]!.issue!.businessCompany).toBe('エナジー事業');
  });

  it('判定できない略称は「その他」に寄せ、警告に出す', () => {
    const p = plan([[...ROW1.slice(0, 3), 'XXX', ...ROW1.slice(4)]]);
    expect(p.rows[0]!.issue!.businessCompany).toBe(OTHER_COMPANY);
    expect(p.otherCount).toBe(1);
    expect(p.unknownAliases).toEqual(['XXX']);
    expect(p.rows[0]!.warnings.join()).toContain('未登録');
  });

  it('空欄はそのまま空欄 (寄せる元が無いため)', () => {
    const p = plan([[...ROW1.slice(0, 3), '', ...ROW1.slice(4)]]);
    expect(p.rows[0]!.issue!.businessCompany).toBe('');
    expect(p.otherCount).toBe(0);
  });

  it('旧略称は読み替えてから引く (「データ移行」で設定した表を使う)', () => {
    const p = plan([[...ROW1.slice(0, 3), 'OLD', ...ROW1.slice(4)]], HEADERS,
      [{ to: 'ENG', from: ['OLD'] }]);
    expect(p.rows[0]!.issue!.businessCompany).toBe('エナジー事業');
    expect(p.remapped).toEqual([{ from: 'OLD', to: 'ENG', count: 1 }]);
  });
});

describe('取り込めない行 / 読めない値', () => {
  it('Issue Instance ID が空の行は取り込まない', () => {
    const p = plan([['', ...ROW1.slice(1)]]);
    expect(p.ready).toBe(0);
    expect(p.skipped).toBe(1);
    expect(p.rows[0]!.issue).toBeNull();
  });

  it('日付として読めない値は空にして警告する (そのまま送ると行ごと 400 になる)', () => {
    const p = plan([[ROW1[0]!, 'いつか', ...ROW1.slice(2)]]);
    expect(p.rows[0]!.issue!.contactedAt).toBe('');
    expect(p.rows[0]!.warnings.join()).toContain('通知日');
  });

  it('Excel シリアル値の日付も読む', () => {
    // シリアル値 44803 は Excel の見た目で 2022-08-30。JST の壁時計として読むので
    // UTC では前日の 15:00 になる (画面と連携用リストはここから JST に戻す)。
    const p = plan([[ROW1[0]!, '44803', ...ROW1.slice(2)]]);
    expect(p.rows[0]!.issue!.contactedAt).toBe('2022-08-29T15:00:00.000Z');
  });

  it('数式のエラー値は空にして警告する', () => {
    const p = plan([[ROW1[0]!, ROW1[1]!, ROW1[2]!, '#N/A', ...ROW1.slice(4)]]);
    expect(p.rows[0]!.issue!.businessCompany).toBe(OTHER_COMPANY);
    expect(p.rows[0]!.warnings.join()).toContain('エラー値');
  });

  it('判別できない検知状況は警告し、既定 (継続) にする', () => {
    const p = plan([[ROW1[0]!, ROW1[1]!, 'よくわからない', ...ROW1.slice(3)]]);
    expect(p.rows[0]!.issue!.detectionStatus).toBe('継続');
    expect(p.rows[0]!.warnings.join()).toContain('検知状況');
  });

  it('WebMAPS の登録情報から ID を抜けなければ警告する', () => {
    const p = plan([[...ROW1.slice(0, 6), '未登録', ...ROW1.slice(7)]]);
    expect(p.rows[0]!.issue!.webMapsId).toBe('');
    expect(p.rows[0]!.warnings.join()).toContain('管理ID');
  });
});

describe('★ 二重登録しない (突合キーは Issue Instance ID × 地域)', () => {
  const row = (iid: string, region: string): string[] =>
    [iid, ROW1[1]!, ROW1[2]!, ROW1[3]!, region, ...ROW1.slice(5)];

  const existing = (over: Partial<OverseasIssue> = {}): OverseasIssue => ({
    id: 100, issueInstanceId: 'IID-1', detectionStatus: '継続', region: 'APAC', ...over,
  });

  it('既にある組は上書きする (増えない)', () => {
    const p = plan([row('IID-1', 'APAC')]);
    const s = splitOverseasMigrationWrites(p.rows, indexOverseasByKey([existing()]));
    expect(s.adds).toHaveLength(0);
    expect(s.updates.map((u) => u.id)).toEqual([100]);
  });

  it('同じ ID でも地域が違えば別の行として追加する', () => {
    const p = plan([row('IID-1', 'EU')]);
    const s = splitOverseasMigrationWrites(p.rows, indexOverseasByKey([existing()]));
    expect(s.adds).toHaveLength(1);
    expect(s.updates).toHaveLength(0);
  });

  it('Excel の中で同じ組が重複していたら後の行を採用する', () => {
    const a = row('IID-1', 'APAC'); const b = row('IID-1', 'APAC');
    b[14] = 'あとの行';
    const p = plan([a, b]);
    const s = splitOverseasMigrationWrites(p.rows, new Map());
    expect(s.adds).toHaveLength(1);
    expect(s.adds[0]!.remarks).toBe('あとの行');
    expect(s.dupInFile).toEqual([
      { key: overseasKey('IID-1', 'APAC'), issueInstanceId: 'IID-1', region: 'APAC', count: 2 },
    ]);
  });

  it('一覧に同じ組が複数あれば、いちばん古い 1 件を上書きして知らせる', () => {
    const p = plan([row('IID-1', 'APAC')]);
    const s = splitOverseasMigrationWrites(p.rows,
      indexOverseasByKey([existing({ id: 200 }), existing({ id: 100 })]));
    expect(s.updates.map((u) => u.id)).toEqual([100]);
    expect(s.dupInList).toEqual([{ issueInstanceId: 'IID-1', region: 'APAC', count: 1 + 1 }]);
  });

  it('地域が空でも突合できる (組として扱う)', () => {
    const p = plan([row('IID-1', '')]);
    const s = splitOverseasMigrationWrites(p.rows, indexOverseasByKey([existing({ region: '' })]));
    expect(s.updates.map((u) => u.id)).toEqual([100]);
  });
});

describe('見出しのゆれ', () => {
  it('「その他の参考情報」でも「WebMAPS登録情報」でも読める', () => {
    const h = [...HEADERS];
    h[6] = 'WebMAPS登録情報'; h[7] = 'その他の参考情報';
    expect(plan([ROW1], h).missingColumns).toEqual([]);
    expect(plan([ROW1], h).rows[0]!.issue!.identifyEvidence).toBe('FQDN 一致');
  });

  it('「Issue ID」でも読める', () => {
    const h = [...HEADERS]; h[0] = 'Issue ID';
    expect(plan([ROW1], h).rows[0]!.issue!.issueInstanceId).toBe('IID-1');
  });

  it('列が足りなければ名指しで知らせる', () => {
    const h = HEADERS.filter((x) => x !== '備考');
    const p = plan([ROW1.slice(0, 14)], h);
    expect(p.missingColumns).toEqual([OVS_MIG_COL.remarks]);
    expect(p.rows[0]!.issue!.remarks).toBe('');
  });
});

describe('★ 列の取り違えを起こさない (曖昧一致で他の列を横取りしない)', () => {
  // 実際に見つかった事故: 「脆弱性」の見出しが変わると、別名 'Title' が
  // 'Asset Title' に部分一致し、脆弱性名の欄に資産名が入ったまま
  // 「見つからない列は無い」と表示されていた。
  const without = (name: string) => HEADERS.filter((h) => h !== name);

  it('「脆弱性」列が無ければ、Asset Title を掴まずに missing として挙げる', () => {
    const cols = resolveOvsMigColumns(without('脆弱性'));
    expect(cols.byKey.title).toBeUndefined();
    expect(cols.byKey.assetTitle).toBe('Asset Title');
    expect(cols.missing).toContain(OVS_MIG_COL.title);
  });

  it('見出しが「タイトル」でも Asset Title は掴まない', () => {
    const h = HEADERS.map((x) => (x === '脆弱性' ? 'タイトル' : x));
    const cols = resolveOvsMigColumns(h);
    expect(cols.byKey.title).not.toBe('Asset Title');
    expect(cols.byKey.assetTitle).toBe('Asset Title');
  });

  it('英語の見出し (Vulnerability) は拾う', () => {
    const h = HEADERS.map((x) => (x === '脆弱性' ? 'Vulnerability' : x));
    expect(resolveOvsMigColumns(h).byKey.title).toBe('Vulnerability');
  });

  it('同じ見出しを 2 つの列に割り当てない', () => {
    const cols = resolveOvsMigColumns(HEADERS);
    const used = Object.values(cols.byKey);
    expect(new Set(used).size).toBe(used.length);
  });
});

describe('★ 単一行テキスト列に収まる形にする (超えると SP が 500 を返す)', () => {
  it('FQDN が多い行は 255 文字に丸める', () => {
    const many = Array.from({ length: 20 }, (_, i) => `host${i}.subdomain.example.co.jp`).join('\n');
    const p = plan([[...ROW1.slice(0, 8), many, ...ROW1.slice(9)]]);
    const issue = p.rows[0]!.issue!;
    expect(issue.assetFqdn!.length).toBeLessThanOrEqual(255);
    expect(issue.assetFqdn!.endsWith('…')).toBe(true);
    expect(issue.assetFqdn!.startsWith('host0.subdomain.example.co.jp | ')).toBe(true);
  });

  it('長い脆弱性タイトルも丸める', () => {
    const p = plan([[...ROW1.slice(0, 9), 'x'.repeat(300), ...ROW1.slice(10)]]);
    expect(p.rows[0]!.issue!.title!.length).toBeLessThanOrEqual(255);
  });

  it('複数行の列 (参考情報 / Asset Mapped Domains) は丸めない', () => {
    const long = 'y'.repeat(400);
    const p = plan([[...ROW1.slice(0, 7), long, ...ROW1.slice(8)]]);
    expect(p.rows[0]!.issue!.identifyEvidence!.length).toBe(400);
  });
});

describe('★ 空欄で既存値を消さない (再取込しても手入力が残る)', () => {
  const existing: OverseasIssue = {
    id: 100, issueInstanceId: 'IID-1', detectionStatus: '継続', region: 'APAC',
    businessCompany: '手で入れた事業会社', affiliateCompany: '手で入れた管理会社',
    webMapsId: 'BW7654321', identifyEvidence: '手で入れた参考情報', remarks: '前回の備考',
  };
  /** 事業会社 / 管理会社 / WebMaps / 参考情報 / 備考 が空の行。 */
  const blank = ['IID-1', ROW1[1]!, ROW1[2]!, '', 'APAC', '', '', '', ROW1[8]!, ROW1[9]!,
    ROW1[10]!, ROW1[11]!, ROW1[12]!, ROW1[13]!, ''];

  it('空欄の項目は patch に入らない', () => {
    const p = plan([blank]);
    const s = splitOverseasMigrationWrites(p.rows, indexOverseasByKey([existing]));
    const patch = s.updates[0]!.patch;
    expect(patch.businessCompany).toBeUndefined();
    expect(patch.affiliateCompany).toBeUndefined();
    expect(patch.webMapsId).toBeUndefined();
    expect(patch.identifyEvidence).toBeUndefined();
    expect(patch.remarks).toBeUndefined();
  });

  it('書いてある値はちゃんと上書きする', () => {
    const p = plan([ROW1]);
    const s = splitOverseasMigrationWrites(p.rows, indexOverseasByKey([existing]));
    const patch = s.updates[0]!.patch;
    expect(patch.businessCompany).toBe('エナジー事業');
    expect(patch.webMapsId).toBe('A1234567');
    expect(patch.remarks).toBe('継続監視');
  });

  it('新規の行は空欄のまま登録する (消す既存値が無い)', () => {
    const p = plan([[...blank.slice(0, 4), 'EU', ...blank.slice(5)]]);
    const s = splitOverseasMigrationWrites(p.rows, indexOverseasByKey([existing]));
    expect(s.adds).toHaveLength(1);
    expect(s.adds[0]!.businessCompany).toBe('');
  });
});

describe('列が 1 つも当たらないとき', () => {
  it('見出しが全く違えば全列を missing として挙げ、行は取り込まない', () => {
    const cols = resolveOvsMigColumns(['foo', 'bar']);
    expect(cols.missing).toHaveLength(Object.keys(OVS_MIG_COL).length);
    const r = migrateOverseasRow({ foo: 'x' }, {
      aliasIndex: new Map(), remapIndex: new Map(),
      parseDate: parseFlexibleDate, nowIso: 'now', columns: cols.byKey,
    });
    expect(r.issue).toBeNull();
  });
});
