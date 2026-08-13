import { describe, it, expect } from 'vitest';
import {
  toDetectionStatus, isRiskAccepted, toMgmtStatus, extractWebMapsIds, isIpAddress,
  buildAliasIndex, resolveCompany, detectVulnType, normalizeVulnTypeRules,
  migrateRow, buildMigrationPlan, MIG_COL, isExcelError,
} from '../src/lib/migration';
import { normalizePerms } from '../src/lib/itemPerms';

const PERMS = normalizePerms({
  adminGroupIds: [11],
  byBusinessCompany: { 'エナジー事業': [12], 'モビリティ事業': [13] },
  aliasesByCompany: { 'エナジー事業': ['ENG', 'エナジー'], 'モビリティ事業': ['MOB'] },
});

describe('検知状況の対応付け', () => {
  it.each([
    ['未検出 / Not detected', '未検出'],
    ['未検出(New) / Not detected(New)', '未検出(New)'],
    ['継続 / Continiously detected', '継続'],
    ['未検出(リスク受容)', '未検出'],
    ['新規 / New', '新規'],
    ['再検出 / Re-dected', '再検知'],
  ])('%s → %s', (raw, expected) => {
    expect(toDetectionStatus(raw)).toBe(expected);
  });

  it('★ 未検出(New) を「未検出」と取り違えない (順序が効いている)', () => {
    expect(toDetectionStatus('未検出(New)')).toBe('未検出(New)');
    expect(toDetectionStatus('Not detected(New)')).toBe('未検出(New)');
  });

  it('判別できない値は null (呼び出し側で警告する)', () => {
    expect(toDetectionStatus('よくわからない')).toBeNull();
    expect(toDetectionStatus('')).toBeNull();
  });

  it('「未検出(リスク受容)」は対応をリスク受容にする', () => {
    expect(isRiskAccepted('未検出(リスク受容)')).toBe(true);
    expect(isRiskAccepted('未検出 / Not detected')).toBe(false);
  });
});

describe('対応状況の対応付け', () => {
  it('Mikke の選択肢と一致すればそのまま', () => {
    expect(toMgmtStatus('対応中')).toBe('対応中');
    expect(toMgmtStatus('リスク受容')).toBe('リスク受容');
  });
  it('一致しない値・空は既定値', () => {
    expect(toMgmtStatus('完了')).toBe('未着手');
    expect(toMgmtStatus('')).toBe('未着手');
  });
});

describe('WebMAPS 管理ID の抽出', () => {
  it('A/B + 数字6桁 (合計7文字) を説明文の中からでも拾う', () => {
    expect(extractWebMapsIds('登録済み A123456 (2024年申請)')).toBe('A123456');
    expect(extractWebMapsIds('B999888')).toBe('B999888');
  });

  it('複数あればすべて並べる (重複は除く)', () => {
    expect(extractWebMapsIds('A123456 と B999888、再掲 A123456')).toBe('A123456 | B999888');
  });

  it('桁数や接頭辞が違うものは拾わない', () => {
    expect(extractWebMapsIds('C123456')).toBe('');
    expect(extractWebMapsIds('A12345')).toBe('');
    expect(extractWebMapsIds('A1234567')).toBe('');
    expect(extractWebMapsIds('未登録')).toBe('');
  });

  it('小文字でも拾う', () => {
    expect(extractWebMapsIds('a123456')).toBe('A123456');
  });
});

describe('資産の振り分け', () => {
  it('IPv4 は Asset IP、それ以外は Asset Domain', () => {
    expect(isIpAddress('203.0.113.10')).toBe(true);
    expect(isIpAddress('999.0.0.1')).toBe(false);
    expect(isIpAddress('app.example.com')).toBe(false);
  });
});

describe('事業会社を略称から引く', () => {
  const idx = buildAliasIndex(PERMS);

  it('登録した略称から正式名を引く', () => {
    expect(resolveCompany('ENG', idx)).toBe('エナジー事業');
    expect(resolveCompany('エナジー', idx)).toBe('エナジー事業');
    expect(resolveCompany('MOB', idx)).toBe('モビリティ事業');
  });

  it('正式名そのものでも引ける (略称でない行が混じっていても通る)', () => {
    expect(resolveCompany('エナジー事業', idx)).toBe('エナジー事業');
  });

  it('大文字小文字・前後の空白を無視する', () => {
    expect(resolveCompany('  eng ', idx)).toBe('エナジー事業');
  });

  it('未登録の略称は null (取込前に警告を出すため)', () => {
    expect(resolveCompany('XYZ', idx)).toBeNull();
  });
});

describe('脆弱性タイプの自動判定', () => {
  const rules = normalizeVulnTypeRules({ port: ['open port', 'ポート'], admin: ['管理画面', 'admin panel'] });

  it('条件に含まれればその型', () => {
    expect(detectVulnType('Open port 3389 detected', rules)).toBe('ポート');
    expect(detectVulnType('Admin Panel exposed', rules)).toBe('管理画面');
  });

  it('どれにも当たらなければ「脆弱性」', () => {
    expect(detectVulnType('TLS 1.0 が有効', rules)).toBe('脆弱性');
  });

  it('条件が空なら全部「脆弱性」', () => {
    expect(detectVulnType('Open port 3389', normalizeVulnTypeRules({}))).toBe('脆弱性');
  });

  it('★ 両方に当たったらポートを優先 (条件の並び順で結果が変わらないように)', () => {
    const both = normalizeVulnTypeRules({ port: ['exposed'], admin: ['exposed'] });
    expect(detectVulnType('Something exposed', both)).toBe('ポート');
  });
});

describe('1 行の移行', () => {
  const ctx = {
    aliasIndex: buildAliasIndex(PERMS),
    vulnTypeRules: normalizeVulnTypeRules({ port: ['open port'], admin: ['管理画面'] }),
    nowIso: '2026-08-13T00:00:00Z',
  };
  const row = {
    [MIG_COL.issueInstanceId]: 'IID-1001',
    [MIG_COL.legacyMgmtNumber]: 'ENG-2406-01',
    [MIG_COL.title]: 'Open port 3389 detected',
    [MIG_COL.detection]: '継続 / Continiously detected',
    [MIG_COL.businessCompany]: 'ENG',
    [MIG_COL.affiliateCompany]: 'ABC株式会社',
    [MIG_COL.webMaps]: '登録済み A123456',
    [MIG_COL.identifyEvidence]: 'FQDN 一致',
    [MIG_COL.ipOrUrl]: '203.0.113.10',
    [MIG_COL.dynamicIp]: 'Yes',
    [MIG_COL.lastSeen]: '2026-07-30T20:00:00.000Z',
    [MIG_COL.mgmtStatus]: '対応中',
    [MIG_COL.personEmail]: 'taro@example.com',
    [MIG_COL.personName]: '山田 太郎',
    [MIG_COL.responsePlan]: '9 月中に閉塞',
    [MIG_COL.extConnAppId]: 'EXT-2026-045',
    [MIG_COL.noAppReason]: '社内閉域のため',
    [MIG_COL.responseNote]: '対処済み',
    [MIG_COL.remarks]: '特記なし',
    [MIG_COL.description]: 'RDP is exposed',
    [MIG_COL.assetTitle]: 'web01',
  };

  it('列の対応どおりに入る', () => {
    const r = migrateRow(row, ctx);
    const i = r.issue!;
    expect(i.issueInstanceId).toBe('IID-1001');
    expect(i.legacyMgmtNumber).toBe('ENG-2406-01');
    expect(i.detectionStatus).toBe('継続');
    expect(i.mgmtStatus).toBe('対応中');
    expect(i.businessCompany).toBe('エナジー事業');     // 略称から解決
    expect(i.affiliateCompany).toBe('ABC株式会社');
    expect(i.webMapsId).toBe('A123456');
    expect(i.identifyEvidence).toBe('FQDN 一致');
    expect(i.responsePlan).toBe('9 月中に閉塞');
    expect(i.extConnAppId).toBe('EXT-2026-045');
    expect(i.noAppReason).toBe('社内閉域のため');
    expect(i.responseNote).toBe('対処済み');
    expect(i.responseRemarks).toBe('特記なし');
    expect(i.vulnType).toBe('ポート');
  });

  it('IP は Asset IP、参考情報は同名の Scan_ 列に入る', () => {
    const i = migrateRow(row, ctx).issue!;
    expect(i.scanFields!['Scan_Asset IP']).toBe('203.0.113.10');
    expect(i.scanFields!['Scan_Asset Domain']).toBeUndefined();
    expect(i.scanFields!['Scan_Asset Dynamically resolved']).toBe('Yes');
    expect(i.scanFields!['Scan_Description']).toBe('RDP is exposed');
    expect(i.scanFields!['Scan_Asset Title']).toBe('web01');
  });

  it('FQDN なら Asset Domain に入る', () => {
    const i = migrateRow({ ...row, [MIG_COL.ipOrUrl]: 'app.example.com' }, ctx).issue!;
    expect(i.scanFields!['Scan_Asset Domain']).toBe('app.example.com');
    expect(i.scanFields!['Scan_Asset IP']).toBeUndefined();
  });

  it('担当者はメールを鍵に引く。氏名列は控え (そのままは入れない)', () => {
    const r = migrateRow(row, ctx);
    expect(r.assigneeEmail).toBe('taro@example.com');
    expect(r.assigneeFallback).toBe('山田 太郎');
    expect(r.issue!.assignee).toBeUndefined();
  });

  it('Issue ID が空の行は取り込まない', () => {
    const r = migrateRow({ ...row, [MIG_COL.issueInstanceId]: '' }, ctx);
    expect(r.issue).toBeNull();
    expect(r.warnings[0]).toMatch(/Issue ID/);
  });

  it('★ 未登録の略称は空にして警告する (黙って別会社に付けない)', () => {
    const r = migrateRow({ ...row, [MIG_COL.businessCompany]: 'XYZ' }, ctx);
    expect(r.issue!.businessCompany).toBe('');
    expect(r.warnings.join()).toMatch(/XYZ/);
  });

  it('未検出(リスク受容) は検知=未検出 / 対応=リスク受容', () => {
    const i = migrateRow({ ...row, [MIG_COL.detection]: '未検出(リスク受容)' }, ctx).issue!;
    expect(i.detectionStatus).toBe('未検出');
    expect(i.mgmtStatus).toBe('リスク受容');
  });

  it('対応状況が対象外なら管理対象外にする', () => {
    const i = migrateRow({ ...row, [MIG_COL.mgmtStatus]: '対象外', [MIG_COL.detection]: '継続' }, ctx).issue!;
    expect(i.isOutOfScope).toBe(true);
  });
});

describe('シート全体の計画', () => {
  const rows = [
    { [MIG_COL.issueInstanceId]: 'IID-1', [MIG_COL.businessCompany]: 'ENG', [MIG_COL.title]: 'A' },
    { [MIG_COL.issueInstanceId]: 'IID-2', [MIG_COL.businessCompany]: 'XYZ', [MIG_COL.title]: 'B' },
    { [MIG_COL.issueInstanceId]: '', [MIG_COL.businessCompany]: 'ENG', [MIG_COL.title]: 'C' },
  ];

  it('取り込める件数・飛ばす件数・引けない略称を返す', () => {
    const plan = buildMigrationPlan(rows, PERMS, {}, '2026-08-13T00:00:00Z');
    expect(plan.ready).toBe(2);
    expect(plan.skipped).toBe(1);
    expect(plan.unknownAliases).toEqual(['XYZ']);
  });

  it('設定が空でも落ちない (略称は全部未解決になる)', () => {
    const plan = buildMigrationPlan(rows, undefined, undefined, '2026-08-13T00:00:00Z');
    expect(plan.ready).toBe(2);
    expect(plan.unknownAliases).toEqual(['ENG', 'XYZ']);
  });
});

describe('数式セル (XLOOKUP) の扱い', () => {
  // ★ 別シート参照の XLOOKUP は、Excel が保存したキャッシュ値で読まれる。
  //   引き当たらなかった行は #N/A などのエラー値になるので、そのまま保存しない。
  const ctx = {
    aliasIndex: buildAliasIndex(PERMS),
    vulnTypeRules: normalizeVulnTypeRules({}),
    nowIso: '2026-08-13T00:00:00Z',
  };

  it.each(['#N/A', '#REF!', '#VALUE!', '#NAME?', '#DIV/0!', '#SPILL!'])('%s はエラー値', (v) => {
    expect(isExcelError(v)).toBe(true);
  });

  it('似ているだけの文字列はエラー扱いしない', () => {
    expect(isExcelError('#1')).toBe(false);
    expect(isExcelError('N/A')).toBe(false);
    expect(isExcelError('対応不要 #N/A の件')).toBe(false);
  });

  it('★ エラー値は空にして、どのセルだったかを警告に出す', () => {
    const r = migrateRow({
      [MIG_COL.issueInstanceId]: 'IID-1',
      [MIG_COL.businessCompany]: '#N/A',
      [MIG_COL.affiliateCompany]: '#REF!',
      [MIG_COL.title]: 'TLS 1.0',
    }, ctx);
    expect(r.issue!.businessCompany).toBe('');
    expect(r.issue!.affiliateCompany).toBe('');
    const w = r.warnings.join(' ');
    expect(w).toMatch(/数式のエラー値を空にしました/);
    expect(w).toMatch(/事業会社=#N\/A/);
    expect(w).toMatch(/管理会社=#REF!/);
  });

  it('エラー値は「未登録の略称」としては数えない (原因が別なので)', () => {
    const r = migrateRow({
      [MIG_COL.issueInstanceId]: 'IID-1', [MIG_COL.businessCompany]: '#N/A',
    }, ctx);
    expect(r.warnings.join()).not.toMatch(/対応する事業会社が未登録/);
  });

  it('引き当たった行は値がそのまま入る', () => {
    const r = migrateRow({
      [MIG_COL.issueInstanceId]: 'IID-2', [MIG_COL.businessCompany]: 'ENG',
    }, ctx);
    expect(r.issue!.businessCompany).toBe('エナジー事業');
    expect(r.warnings).toEqual([]);
  });
});

describe('未解決の略称の集計', () => {
  it('★ 数式のエラー値は「未登録の略称」に混ぜない (原因が別なので)', () => {
    const plan = buildMigrationPlan([
      { [MIG_COL.issueInstanceId]: 'IID-1', [MIG_COL.businessCompany]: '#N/A' },
      { [MIG_COL.issueInstanceId]: 'IID-2', [MIG_COL.businessCompany]: 'XYZ' },
    ], PERMS, {}, '2026-08-14T00:00:00Z');
    expect(plan.unknownAliases).toEqual(['XYZ']);
  });
});
