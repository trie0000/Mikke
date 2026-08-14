import { describe, it, expect } from 'vitest';
import {
  toDetectionStatus, isRiskAccepted, toMgmtStatus, extractWebMapsIds, isIpAddress,
  buildAliasIndex, resolveCompany, detectVulnType, normalizeVulnTypeRules,
  migrateRow, buildMigrationPlan, MIG_COL, isExcelError,
  normalizeAliasRemap, buildRemapIndex, applyAliasRemap, remapConflicts, OTHER_COMPANY,
  resolveMigColumns, indexByIssueInstanceId, splitMigrationWrites, parseFlexibleDate,
  type MigrationRowResult,
} from '../src/lib/migration';
import { normalizePerms, groupIdsFor } from '../src/lib/itemPerms';

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
    remapIndex: new Map<string, string>(),
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
    expect(i.extConnAppId).toBe('EXT-2026-045');
    expect(i.noAppReason).toBe('社内閉域のため');
    // 対応計画 + 完了理由 は「対応状況」に 1 本化される (見出し付きで連結)。
    expect(i.responsePlan).toBe(
      `【${MIG_COL.responsePlan}】\n9 月中に閉塞\n\n【${MIG_COL.responseNote}】\n対処済み`);
    expect(i.mgmtNote).toBe('特記なし');
    expect(i.vulnType).toBe('ポート');
  });

  it('★ 特記事項は連携用リスト由来の項目には入れない', () => {
    // responseRemarks は事業会社の記入欄 (備考) の写しで、
    // 連携内容の取込のたびに上書きされる。移行データを置くと消える。
    expect(migrateRow(row, ctx).issue!.responseRemarks).toBeUndefined();
  });

  it('★ 片方だけ埋まっていれば、その 1 件だけを入れる', () => {
    const only = migrateRow({ ...row, [MIG_COL.responseNote]: '' }, ctx).issue!;
    expect(only.responsePlan).toBe(`【${MIG_COL.responsePlan}】\n9 月中に閉塞`);
  });

  it('両方空なら対応状況も空', () => {
    const none = migrateRow(
      { ...row, [MIG_COL.responsePlan]: '', [MIG_COL.responseNote]: '' }, ctx).issue!;
    expect(none.responsePlan).toBe('');
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

  it('★ 未登録の略称は「その他」に寄せて警告する (黙って別会社に付けない)', () => {
    const r = migrateRow({ ...row, [MIG_COL.businessCompany]: 'XYZ' }, ctx);
    expect(r.issue!.businessCompany).toBe(OTHER_COMPANY);
    expect(r.warnings.join()).toMatch(/XYZ/);
    expect(r.warnings.join()).toMatch(/その他/);
  });

  it('★ 事業会社の欄が空の行は空欄のまま (寄せる元の組織が書かれていない)', () => {
    const r = migrateRow({ ...row, [MIG_COL.businessCompany]: '' }, ctx);
    expect(r.issue!.businessCompany).toBe('');
    expect(r.warnings.join()).not.toMatch(/その他/);
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
    remapIndex: new Map<string, string>(),
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
    // 事業会社は「どの組織か決められなかった」ので その他 に寄せる。
    // 管理会社はただの文字列なので空にするだけ。
    expect(r.issue!.businessCompany).toBe(OTHER_COMPANY);
    expect(r.issue!.affiliateCompany).toBe('');
    const w = r.warnings.join(' ');
    expect(w).toMatch(/数式のエラー値を空にしました/);
    expect(w).toMatch(/事業会社を決められないため「その他」にしました/);
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

describe('旧略称の読み替え (旧 N 件 : 現在 1 件)', () => {
  const REMAP = [
    { to: 'ENG', from: ['エナジー旧', 'ENERGY', 'ENG-OLD'] },   // N:1
    { to: 'MOB', from: ['モビリティ旧'] },
  ];

  it('保存値を整える: 読み替え先が空の行は捨てる', () => {
    expect(normalizeAliasRemap([{ to: '', from: ['A'] }, { to: 'ENG', from: ['B'] }]))
      .toEqual([{ to: 'ENG', from: ['B'] }]);
  });

  it('★ 自分自身への読み替えは落とす (大文字小文字を問わず)', () => {
    expect(normalizeAliasRemap([{ to: 'ENG', from: ['eng', 'ENERGY'] }]))
      .toEqual([{ to: 'ENG', from: ['ENERGY'] }]);
  });

  it('壊れた保存値・空行・重複でも落ちない', () => {
    expect(normalizeAliasRemap(undefined)).toEqual([]);
    expect(normalizeAliasRemap('not-an-array')).toEqual([]);
    expect(normalizeAliasRemap([{ to: ' ENG ', from: [' A ', 'A', '', null] }]))
      .toEqual([{ to: 'ENG', from: ['A'] }]);
    expect(normalizeAliasRemap([{ to: 'ENG' }])).toEqual([{ to: 'ENG', from: [] }]);
  });

  it('旧略称を現在の略称に読み替える。当たらなければそのまま', () => {
    const idx = buildRemapIndex(normalizeAliasRemap(REMAP));
    expect(applyAliasRemap('ENERGY', idx)).toBe('ENG');
    expect(applyAliasRemap('  eng-old ', idx)).toBe('ENG');   // 前後空白・大小を問わない
    expect(applyAliasRemap('MOB', idx)).toBe('MOB');
    expect(applyAliasRemap('', idx)).toBe('');
  });

  it('★ 読み替えは 1 段だけ (A→B, B→C を書いても A は B で止まる)', () => {
    // 連鎖させると書き順で結果が変わり、循環すると止まらない。
    const idx = buildRemapIndex(normalizeAliasRemap([
      { to: 'B', from: ['A'] }, { to: 'C', from: ['B'] },
    ]));
    expect(applyAliasRemap('A', idx)).toBe('B');
  });

  it('★ 循環していても止まる', () => {
    const idx = buildRemapIndex(normalizeAliasRemap([
      { to: 'B', from: ['A'] }, { to: 'A', from: ['B'] },
    ]));
    expect(applyAliasRemap('A', idx)).toBe('B');
    expect(applyAliasRemap('B', idx)).toBe('A');
  });

  it('★ 同じ旧略称が複数行にあると先に書いた行が勝つ', () => {
    // 後勝ちにすると、行を足しただけで既存の読み替え先が変わってしまう。
    const rows = normalizeAliasRemap([{ to: 'ENG', from: ['X'] }, { to: 'MOB', from: ['X'] }]);
    expect(applyAliasRemap('X', buildRemapIndex(rows))).toBe('ENG');
    expect(remapConflicts(rows)).toEqual([{ from: 'X', to: ['ENG', 'MOB'] }]);
  });

  it('重複が無ければ conflicts は空', () => {
    expect(remapConflicts(normalizeAliasRemap(REMAP))).toEqual([]);
  });

  it('旧略称の行でも事業会社が決まり、アクセス権のキーになる', () => {
    const plan = buildMigrationPlan([
      { [MIG_COL.issueInstanceId]: 'IID-1', [MIG_COL.businessCompany]: 'ENERGY' },
      { [MIG_COL.issueInstanceId]: 'IID-2', [MIG_COL.businessCompany]: 'ENG-OLD' },
      { [MIG_COL.issueInstanceId]: 'IID-3', [MIG_COL.businessCompany]: 'モビリティ旧' },
    ], PERMS, {}, '2026-08-14T00:00:00Z', REMAP);
    expect(plan.rows.map((r) => r.issue!.businessCompany))
      .toEqual(['エナジー事業', 'エナジー事業', 'モビリティ事業']);
    expect(plan.rows.flatMap((r) => r.warnings)).toEqual([]);
    expect(plan.unknownAliases).toEqual([]);
  });

  it('読み替えが効いた件数を数える (設定どおり当たっているか画面で確かめる)', () => {
    const plan = buildMigrationPlan([
      { [MIG_COL.issueInstanceId]: 'IID-1', [MIG_COL.businessCompany]: 'ENERGY' },
      { [MIG_COL.issueInstanceId]: 'IID-2', [MIG_COL.businessCompany]: 'ENERGY' },
      { [MIG_COL.issueInstanceId]: 'IID-3', [MIG_COL.businessCompany]: 'モビリティ旧' },
      { [MIG_COL.issueInstanceId]: 'IID-4', [MIG_COL.businessCompany]: 'ENG' },  // 現行なので数えない
    ], PERMS, {}, '2026-08-14T00:00:00Z', REMAP);
    expect(plan.remapped).toEqual([
      { from: 'ENERGY', to: 'ENG', count: 2 },
      { from: 'モビリティ旧', to: 'MOB', count: 1 },
    ]);
  });

  it('★ 読み替え先が未登録なら、読み替えたことが分かる警告を出す', () => {
    const plan = buildMigrationPlan(
      [{ [MIG_COL.issueInstanceId]: 'IID-1', [MIG_COL.businessCompany]: '旧なんとか' }],
      PERMS, {}, '2026-08-14T00:00:00Z', [{ to: 'ZZZ', from: ['旧なんとか'] }]);
    expect(plan.rows[0]!.issue!.businessCompany).toBe(OTHER_COMPANY);
    expect(plan.rows[0]!.warnings[0])
      .toBe('旧略称「旧なんとか」を「ZZZ」に読み替えましたが、対応する事業会社が未登録のため「その他」にしました');
    // 画面に出す未登録一覧は Excel に書かれている値 (探せる値) を出す。
    expect(plan.unknownAliases).toEqual(['旧なんとか']);
  });

  it('読み替え表を渡さなくても今までどおり動く', () => {
    const plan = buildMigrationPlan(
      [{ [MIG_COL.issueInstanceId]: 'IID-1', [MIG_COL.businessCompany]: 'ENG' }],
      PERMS, {}, '2026-08-14T00:00:00Z');
    expect(plan.rows[0]!.issue!.businessCompany).toBe('エナジー事業');
    expect(plan.remapped).toEqual([]);
  });
});

describe('Excel の列名', () => {
  it('★ 実ファイルのヘッダと一字一句同じであること (違うと全列が「見つからない」になる)', () => {
    expect(MIG_COL.identifyEvidence).toBe('その他の参考情報');
    expect(MIG_COL.responsePlan).toBe('一カ月を目処に早めにご計画ください。');
    expect(MIG_COL.extConnAppId).toBe('※ 申請状況を選択ください。');
    expect(MIG_COL.responseNote).toBe('本課題の「対応状況」を「完了」にする場合、その理由をご記入ください。');
  });
});

describe('事業会社を決められない行は「その他」に寄せる', () => {
  it('★ 未登録の略称・読み替えても引けない略称・数式のエラー値をまとめて数える', () => {
    const plan = buildMigrationPlan([
      { [MIG_COL.issueInstanceId]: 'IID-1', [MIG_COL.businessCompany]: 'ENG' },        // 引ける
      { [MIG_COL.issueInstanceId]: 'IID-2', [MIG_COL.businessCompany]: 'ナゾ商事' },   // 未登録
      { [MIG_COL.issueInstanceId]: 'IID-3', [MIG_COL.businessCompany]: '#N/A' },       // エラー値
      { [MIG_COL.issueInstanceId]: 'IID-4', [MIG_COL.businessCompany]: '' },           // 空欄
    ], PERMS, {}, '2026-08-14T00:00:00Z');
    expect(plan.rows.map((r) => r.issue!.businessCompany))
      .toEqual(['エナジー事業', OTHER_COMPANY, OTHER_COMPANY, '']);
    expect(plan.otherCount).toBe(2);
  });

  it('全部引ければ その他 は 0 件', () => {
    const plan = buildMigrationPlan(
      [{ [MIG_COL.issueInstanceId]: 'IID-1', [MIG_COL.businessCompany]: 'MOB' }],
      PERMS, {}, '2026-08-14T00:00:00Z');
    expect(plan.otherCount).toBe(0);
  });

  it('読み替えで引けた行は その他 に落ちない', () => {
    const plan = buildMigrationPlan(
      [{ [MIG_COL.issueInstanceId]: 'IID-1', [MIG_COL.businessCompany]: 'ENERGY' }],
      PERMS, {}, '2026-08-14T00:00:00Z', [{ to: 'ENG', from: ['ENERGY'] }]);
    expect(plan.rows[0]!.issue!.businessCompany).toBe('エナジー事業');
    expect(plan.otherCount).toBe(0);
  });

  it('★「その他」を事業会社として登録してあれば、そのままアクセス権のキーになる', () => {
    // 移行後にアクセス権画面で「その他」を登録すれば、他の事業会社と同じ扱いで割当が付く。
    const perms = normalizePerms({
      adminGroupIds: [11], byBusinessCompany: { [OTHER_COMPANY]: [99] },
    });
    const plan = buildMigrationPlan(
      [{ [MIG_COL.issueInstanceId]: 'IID-1', [MIG_COL.businessCompany]: 'ナゾ商事' }],
      perms, {}, '2026-08-14T00:00:00Z');
    expect(plan.rows[0]!.issue!.businessCompany).toBe(OTHER_COMPANY);
    expect(groupIdsFor(plan.rows[0]!.issue!.businessCompany, perms)).toEqual([99]);
  });
});

describe('列の探し方 (完全一致 / 部分一致)', () => {
  const HEADS = ['Issue ID', '事業会社', '脆弱性'];

  it('通常の列は完全一致で探す', () => {
    const m = resolveMigColumns(HEADS);
    expect(m.byCol[MIG_COL.issueInstanceId]).toBe('Issue ID');
    expect(m.missing).toContain(MIG_COL.lastSeen);
  });

  it('★ 申請状況の列は「申請状況を選択ください」を含む見出しなら拾う', () => {
    // 「※ 」の有無・末尾の「。」の有無が Excel 側で揺れる。
    for (const h of [
      '※ 申請状況を選択ください。', '※ 申請状況を選択ください', '申請状況を選択ください',
      '外部接続申請 ※ 申請状況を選択ください。(必須)',
    ]) {
      expect(resolveMigColumns([h]).byCol[MIG_COL.extConnAppId]).toBe(h);
    }
  });

  it('★ 対応計画の列は「早めにご計画ください」を含む見出しなら拾う', () => {
    for (const h of [
      '一カ月を目処に早めにご計画ください。', '一ヶ月を目処に早めにご計画ください',
      '1カ月を目処に早めにご計画ください。', '早めにご計画ください',
    ]) {
      expect(resolveMigColumns([h]).byCol[MIG_COL.responsePlan]).toBe(h);
    }
  });

  it('部分一致の列も、無ければ見つからない列として挙げる', () => {
    const m = resolveMigColumns(HEADS);
    expect(m.missing).toContain(MIG_COL.extConnAppId);
    expect(m.missing).toContain(MIG_COL.responsePlan);
  });

  it('★ 見出しが揺れていても値がちゃんと入る', () => {
    const plan = buildMigrationPlan([{
      'Issue ID': 'IID-1',
      '申請状況を選択ください': 'EXT-999',
      '一ヶ月を目処に早めにご計画ください': '2026-09 までに対応',
    }], PERMS, {}, '2026-08-14T00:00:00Z');
    expect(plan.rows[0]!.issue!.extConnAppId).toBe('EXT-999');
    expect(plan.rows[0]!.issue!.responsePlan)
      .toBe(`【${MIG_COL.responsePlan}】\n2026-09 までに対応`);
    expect(plan.missingColumns).not.toContain(MIG_COL.extConnAppId);
    expect(plan.missingColumns).not.toContain(MIG_COL.responsePlan);
  });

  it('見出しを渡さなくても行の鍵から拾う', () => {
    const plan = buildMigrationPlan(
      [{ 'Issue ID': 'IID-1', '※ 申請状況を選択ください': 'EXT-1' }],
      PERMS, {}, '2026-08-14T00:00:00Z');
    expect(plan.rows[0]!.issue!.extConnAppId).toBe('EXT-1');
  });

  it('1 行も無ければ、渡した見出しで判定する', () => {
    const plan = buildMigrationPlan([], PERMS, {}, '2026-08-14T00:00:00Z', undefined,
      ['Issue ID', '申請状況を選択ください。']);
    expect(plan.missingColumns).not.toContain(MIG_COL.extConnAppId);
    expect(plan.missingColumns).toContain(MIG_COL.lastSeen);
  });
});

describe('事業会社列に新旧の略称が混じっている場合', () => {
  it('★ 新組織の略称はそのまま引ける (読み替え表に書く必要はない)', () => {
    const plan = buildMigrationPlan([
      { [MIG_COL.issueInstanceId]: 'IID-1', [MIG_COL.businessCompany]: 'ENG' },       // 新
      { [MIG_COL.issueInstanceId]: 'IID-2', [MIG_COL.businessCompany]: 'ENERGY' },    // 旧
      { [MIG_COL.issueInstanceId]: 'IID-3', [MIG_COL.businessCompany]: 'MOB' },       // 新
    ], PERMS, {}, '2026-08-14T00:00:00Z', [{ to: 'ENG', from: ['ENERGY'] }]);
    expect(plan.rows.map((r) => r.issue!.businessCompany))
      .toEqual(['エナジー事業', 'エナジー事業', 'モビリティ事業']);
    expect(plan.remapped).toEqual([{ from: 'ENERGY', to: 'ENG', count: 1 }]);   // 新は読み替え対象外
    expect(plan.otherCount).toBe(0);
  });

  it('新組織の略称を読み替え表の旧側に書いても、自分自身への読み替えは無視される', () => {
    const plan = buildMigrationPlan(
      [{ [MIG_COL.issueInstanceId]: 'IID-1', [MIG_COL.businessCompany]: 'ENG' }],
      PERMS, {}, '2026-08-14T00:00:00Z', [{ to: 'ENG', from: ['ENG', 'ENERGY'] }]);
    expect(plan.rows[0]!.issue!.businessCompany).toBe('エナジー事業');
    expect(plan.remapped).toEqual([]);
  });
});

describe('同じ Issue Instance ID を 2 回読んでも増やさない', () => {
  const rowsOf = (...ids: string[]): MigrationRowResult[] =>
    buildMigrationPlan(ids.map((id) => ({ [MIG_COL.issueInstanceId]: id })),
      PERMS, {}, '2026-08-14T00:00:00Z').rows;

  it('既存の管理対象を Issue Instance ID で引ける形にする', () => {
    const idx = indexByIssueInstanceId([
      { id: 5, issueInstanceId: 'IID-1' },
      { id: 3, issueInstanceId: 'IID-1' },
      { id: 9, issueInstanceId: 'IID-2' },
      { id: 7, issueInstanceId: '' },        // ID 無しは入れない
      { id: 8 },
    ]);
    expect(idx.get('IID-1')).toEqual([3, 5]);   // ID 昇順
    expect(idx.get('IID-2')).toEqual([9]);
    expect(idx.size).toBe(2);
  });

  it('★ 既にある ID は上書き、無い ID だけ追加する', () => {
    const split = splitMigrationWrites(rowsOf('IID-1', 'IID-2', 'IID-3'),
      indexByIssueInstanceId([{ id: 100, issueInstanceId: 'IID-2' }]));
    expect(split.adds.map((r) => r.issue!.issueInstanceId)).toEqual(['IID-1', 'IID-3']);
    expect(split.updates).toEqual([{ row: expect.anything(), id: 100 }]);
    expect(split.updates[0]!.row.issue!.issueInstanceId).toBe('IID-2');
  });

  it('★ 同じファイルを 2 回読んでも増えない (全件が上書きになる)', () => {
    const rows = rowsOf('IID-1', 'IID-2');
    // 1 回目: 全部が新規
    const first = splitMigrationWrites(rows, new Map());
    expect(first.adds).toHaveLength(2);
    expect(first.updates).toHaveLength(0);
    // 1 回目の結果が管理対象に入った状態で、同じファイルをもう一度
    const second = splitMigrationWrites(rows, indexByIssueInstanceId([
      { id: 1, issueInstanceId: 'IID-1' }, { id: 2, issueInstanceId: 'IID-2' },
    ]));
    expect(second.adds).toHaveLength(0);
    expect(second.updates.map((u) => u.id)).toEqual([1, 2]);
  });

  it('★ Excel の中で ID が重複していたら後の行を採用する (1 回の取込でも増やさない)', () => {
    const rows = buildMigrationPlan([
      { [MIG_COL.issueInstanceId]: 'IID-1', [MIG_COL.title]: '古い方' },
      { [MIG_COL.issueInstanceId]: 'IID-1', [MIG_COL.title]: '新しい方' },
    ], PERMS, {}, '2026-08-14T00:00:00Z').rows;
    const split = splitMigrationWrites(rows, new Map());
    expect(split.adds).toHaveLength(1);
    expect(split.adds[0]!.issue!.title).toBe('新しい方');
    expect(split.dupInFile).toEqual([{ issueInstanceId: 'IID-1', count: 2 }]);
  });

  it('★ 管理対象に既に重複があるときは、いちばん古い 1 件だけ上書きして名指しする', () => {
    const split = splitMigrationWrites(rowsOf('IID-1'),
      indexByIssueInstanceId([
        { id: 50, issueInstanceId: 'IID-1' }, { id: 12, issueInstanceId: 'IID-1' },
      ]));
    expect(split.updates.map((u) => u.id)).toEqual([12]);
    expect(split.dupInList).toEqual([{ issueInstanceId: 'IID-1', count: 2 }]);
  });

  it('重複が無ければ dupInFile / dupInList は空', () => {
    const split = splitMigrationWrites(rowsOf('IID-1', 'IID-2'), new Map());
    expect(split.dupInFile).toEqual([]);
    expect(split.dupInList).toEqual([]);
  });

  it('Issue ID が空で取り込めない行は振り分けに入らない', () => {
    const rows = buildMigrationPlan([{ [MIG_COL.issueInstanceId]: '' }],
      PERMS, {}, '2026-08-14T00:00:00Z').rows;
    const split = splitMigrationWrites(rows, new Map());
    expect(split.adds).toHaveLength(0);
    expect(split.updates).toHaveLength(0);
  });
});

describe('表記のばらばらな日付を JST として読む', () => {
  // ★ 返すのは UTC の ISO。画面と連携用リストがそこから JST に直して見せる。
  //   タイムゾーンの無い書き方 (Excel シリアル値・月名・YYYY-MM-DD) は
  //   **JST の壁時計** とみなす。UTC とみなすと 9 時間ずれて前日になる。
  const jstDay = (iso: string): string =>
    new Date(new Date(iso).getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10);

  it('★ タイムゾーン付き ISO はその瞬間のまま', () => {
    expect(parseFlexibleDate('2025-11-26T16:40:13.045Z')).toBe('2025-11-26T16:40:13.045Z');
    // 16:40 UTC は JST では翌 27 日の 01:40。
    expect(jstDay(parseFlexibleDate('2025-11-26T16:40:13.045Z')!)).toBe('2025-11-27');
    expect(parseFlexibleDate('2025-11-26T16:40:13+09:00')).toBe('2025-11-26T07:40:13.000Z');
  });

  it('★ Excel のシリアル値 (44803.67673 = 2022-08-30 16:14 JST)', () => {
    expect(parseFlexibleDate('44803.67673')).toBe('2022-08-30T07:14:29.000Z');
    expect(jstDay(parseFlexibleDate('44803.67673')!)).toBe('2022-08-30');
  });

  it('★ 時刻の無いシリアル値は JST の 0 時', () => {
    expect(parseFlexibleDate('44803')).toBe('2022-08-29T15:00:00.000Z');
    expect(jstDay(parseFlexibleDate('44803')!)).toBe('2022-08-30');
  });

  it('★ 英語の月名 (Nov 23rd 2022)', () => {
    for (const v of ['Nov 23rd 2022', 'November 23, 2022', 'Nov 23 2022', '23 Nov 2022', '23rd Nov 2022']) {
      expect(jstDay(parseFlexibleDate(v)!), v).toBe('2022-11-23');
    }
    expect(parseFlexibleDate('Nov 23rd 2022')).toBe('2022-11-22T15:00:00.000Z');
  });

  it('月名に時刻が付いていても読む', () => {
    expect(parseFlexibleDate('Nov 23rd 2022 16:40')).toBe('2022-11-23T07:40:00.000Z');
  });

  it('タイムゾーンなしの日付・和式は JST の壁時計とみなす', () => {
    expect(parseFlexibleDate('2025-11-26')).toBe('2025-11-25T15:00:00.000Z');
    expect(jstDay(parseFlexibleDate('2025-11-26')!)).toBe('2025-11-26');
    expect(parseFlexibleDate('2025/11/26')).toBe('2025-11-25T15:00:00.000Z');
    expect(parseFlexibleDate('2025年11月26日')).toBe('2025-11-25T15:00:00.000Z');
    expect(parseFlexibleDate('2025-11-26 16:40:13')).toBe('2025-11-26T07:40:13.000Z');
  });

  it('大文字小文字・前後の空白は問わない', () => {
    expect(parseFlexibleDate('  NOV 23RD 2022  ')).toBe('2022-11-22T15:00:00.000Z');
  });

  it('★ 読めない値は null (SP の日付列に入れると 1 行まるごと 400 になる)', () => {
    for (const v of ['', '  ', '未検出', 'N/A', '2022-13-01', '2022-02-31', 'Foo 23rd 2022', '0']) {
      expect(parseFlexibleDate(v), v).toBeNull();
    }
  });

  it('★ 移行時に最終検知日が ISO で入り、読めない値は空にして警告する', () => {
    const plan = buildMigrationPlan([
      { [MIG_COL.issueInstanceId]: 'IID-1', [MIG_COL.lastSeen]: 'Nov 23rd 2022' },
      { [MIG_COL.issueInstanceId]: 'IID-2', [MIG_COL.lastSeen]: '44803.67673' },
      { [MIG_COL.issueInstanceId]: 'IID-3', [MIG_COL.lastSeen]: '2025-11-26T16:40:13.045Z' },
      { [MIG_COL.issueInstanceId]: 'IID-4', [MIG_COL.lastSeen]: 'いつか' },
    ], PERMS, {}, '2026-08-14T00:00:00Z');
    expect(plan.rows.map((r) => r.issue!.lastSeen)).toEqual([
      '2022-11-22T15:00:00.000Z', '2022-08-30T07:14:29.000Z', '2025-11-26T16:40:13.045Z', '',
    ]);
    expect(plan.rows[3]!.warnings.join())
      .toBe('最終検知日「いつか」を日付として読めないため空にしました');
    expect(plan.rows[0]!.warnings).toEqual([]);
  });

  it('最終検知日が空の行は警告を出さない', () => {
    const plan = buildMigrationPlan([{ [MIG_COL.issueInstanceId]: 'IID-1' }],
      PERMS, {}, '2026-08-14T00:00:00Z');
    expect(plan.rows[0]!.issue!.lastSeen).toBe('');
    expect(plan.rows[0]!.warnings).toEqual([]);
  });
});
