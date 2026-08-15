// SharePoint REST リポジトリ。同一オリジン Cookie 認証。
// 役割: contextinfo(digest) / list CRUD / ensureLists(ensureFields) /
//       $batch 一括書き込み。
import type { Repository, ImportLogEntry } from './repo';
import type { ManagedIssue, ManagedAsset, ResponseHistory, ChangeLogEntry, MikkeSettings, SiteUser, DetectionStatus, AddedReason, DownloadRecord, DownloadType, SetupStep, SetupResult } from '../types';
import { normalizeMgmtStatus } from '../types';
import type { ImportOp } from '../lib/import';
import { packScanData, unpackScanData } from '../lib/scanName';
import {
  LIST_MANAGED, LIST_SETTINGS, LIST_IMPORTLOG, LIST_ASSETS, LIST_HISTORY, LIST_CHANGELOG, LIST_DOWNLOADS,
  LIST_VULNRESPONSE, CONDITIONAL_FORMULA_PROPERTY, VULNRESPONSE_VIEW_FIELDS, VULNRESPONSE_OBSOLETE_FIELDS,
  managedIssueFieldSpecs, settingsFieldSpecs, importLogFieldSpecs, assetFieldSpecs, historyFieldSpecs, changeLogFieldSpecs, downloadFieldSpecs,
  vulnResponseFieldSpecs, orderFieldLinks,
  toFieldSchema, spFieldTypeString, type FieldSpec,
  LIST_OVERSEAS, overseasFieldSpecs,
  LIST_OVERSEAS_RESPONSE, overseasResponseFieldSpecs, OVERSEAS_RESPONSE_VIEW_FIELDS,
} from './sp/schema';
import { buildVulnResponseFormFormatter, buildOverseasResponseFormFormatter } from './sp/formFormatter';
import { buildReorderFieldsXml, processQueryError } from './sp/csom';
import type { VulnResponseItem } from '../lib/responseSync';
import type { OverseasIssue } from '../types';
import type { VulnResponseFields, VulnResponseRow } from '../lib/vulnResponseSync';
import { VULNRESPONSE_COLUMN, VULNRESPONSE_DATE_FIELDS, VULNRESPONSE_KIND, REPORT_LINK_TEXT } from '../lib/vulnResponseSync';
import type { OverseasResponseFields, OverseasResponseRow } from '../lib/overseasResponseSync';
import { OVERSEAS_RESPONSE_COLUMN, OVERSEAS_RESPONSE_DATE_FIELDS } from '../lib/overseasResponseSync';
import { normalizePerms, hasAnyPerms, pickRoles, buildItemPermPlan,
  type VulnResponsePerms, type PermRoles } from '../lib/itemPerms';
import { getSelectedSiteUrl, currentWebUrl, normalizeWebUrl } from '../utils/spSites';

const V = 'application/json;odata=verbose';

/** SP のエラー応答ボディから理由テキストを抜き出す (verbose: error.message.value)。
 *  診断用。読めない/無ければ空文字。先頭 200 文字に切り詰める。 */
async function spErrorText(r: Response): Promise<string> {
  try {
    const t = await r.text();
    if (!t) return '';
    try {
      const j = JSON.parse(t);
      const msg = j?.error?.message?.value ?? j?.error?.message ?? j?.['odata.error']?.message?.value;
      if (msg) return `- ${String(msg).slice(0, 200)}`;
    } catch { /* JSON でなければ生テキスト */ }
    return `- ${t.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200)}`;
  } catch { return ''; }
}

/**
 * JSON を期待した応答が JSON でなかったときの説明文を作る。
 *
 * SharePoint は 200 のまま HTML を返すことがある (サインイン画面 / アクセス権エラー /
 * サイト URL 違いなど)。素通しすると「Unexpected token '<'」しか出ず原因が分からない。
 */
export function describeNonJson(text: string, url: string): string {
  const head = text.replace(/\s+/g, ' ').trim().slice(0, 120);
  const lower = text.slice(0, 4000).toLowerCase();
  let cause = '応答が JSON ではありません';
  if (/login\.microsoftonline|\/_forms\/default\.aspx|sign in to your account/.test(lower)) {
    cause = 'サインイン画面が返りました。ブラウザで SharePoint にサインインし直してください';
  } else if (/access denied|アクセスが拒否|hasn'?t been shared|共有されていません/.test(lower)) {
    cause = 'アクセス権がありません。このサイトを開ける権限か、サイト URL の指定を確認してください';
  } else if (lower.startsWith('<!doctype') || lower.startsWith('<html')) {
    cause = 'HTML が返りました。サイト URL の指定が誤っている可能性があります (設定 → 接続 で確認)';
  }
  return `${cause}\n要求先: ${url}\n応答の先頭: ${head}`;
}

/** 構築工程の記録係。工程ごとの 作成/更新/スキップ/失敗 を集計する。 */
class StepReporter {
  private readonly steps: SetupStep[] = [];

  record(category: string, target: string, outcome: SetupStep['outcome'], detail?: string): void {
    this.steps.push({ category, target, outcome, detail });
    const mark = { created: '+', updated: '~', skipped: '=', failed: 'x' }[outcome];
    const line = `[mikke/setup] [${mark}] ${category}: ${target}${detail ? ` — ${detail}` : ''}`;
    if (outcome === 'failed') console.error(line); else console.log(line);
  }

  result(listUrl: string): SetupResult {
    const counts = { created: 0, updated: 0, skipped: 0, failed: 0 };
    for (const s of this.steps) counts[s.outcome]++;
    return { steps: this.steps, counts, listUrl };
  }
}

/** 旧「特定理由」列 (IdentifyReason) を「特定根拠」(IdentifyEvidence) に畳み込む。
 *  新スキーマでは理由列は廃止。旧データが残っていれば根拠の先頭に併記する。 */
function mergeLegacyEvidence(reason: unknown, evidence: unknown): string | undefined {
  const r = typeof reason === 'string' ? reason.trim() : '';
  const e = typeof evidence === 'string' ? evidence.trim() : '';
  if (r && e) return e.includes(r) ? e : `${r}: ${e}`;
  return (e || r) || undefined;
}

export class SpRepository implements Repository {
  private webUrl: string;
  private digest = '';
  private digestExpire = 0;
  /** リスト名 → ListItemEntityTypeFullName のキャッシュ (POST の __metadata.type 用)。 */
  private entityTypeCache = new Map<string, string>();

  constructor(siteUrl?: string) {
    // ★ siteUrl を渡すとそのサイトを見る (開発 ↔ 本番 の設定コピー用)。
    if (siteUrl) { this.webUrl = normalizeWebUrl(siteUrl); return; }
    // 選択済みサイト URL があればそれを、なければ現在ページのサイトを使う。
    // ★ 必ずサイトのルートに正規化する。ライブラリのページ URL のままだと
    //   `…/AllItems.aspx/_api/web/…` を叩いて HTML が返る (実機で発生)。
    this.webUrl = normalizeWebUrl(getSelectedSiteUrl() || this.currentWebUrl());
  }

  private currentWebUrl(): string {
    // 解決ロジックは spSites に集約 (画面のリンク等と食い違わないように)。
    // どちらも取れない時だけ origin にフォールバックする。
    return currentWebUrl() || location.origin;
  }

  private async getDigest(): Promise<string> {
    if (this.digest && Date.now() < this.digestExpire) return this.digest;
    const r = await fetch(`${this.webUrl}/_api/contextinfo`, {
      method: 'POST',
      headers: { Accept: V },
      credentials: 'same-origin',
    });
    if (!r.ok) throw new Error(`contextinfo failed: HTTP ${r.status}`);
    const j = await r.json();
    const info = j.d.GetContextWebInformation;
    this.digest = info.FormDigestValue;
    // 期限は FormDigestTimeoutSeconds (秒)。余裕を見て 80% で再取得。
    this.digestExpire = Date.now() + (info.FormDigestTimeoutSeconds ?? 1800) * 800;
    return this.digest;
  }

  private async spGet(path: string): Promise<any> {
    const url = `${this.webUrl}${path}`;
    const r = await fetch(url, {
      headers: { Accept: V },
      credentials: 'same-origin',
    });
    if (!r.ok) throw new Error(`GET ${path}: HTTP ${r.status}`);
    // ★ JSON を期待しているのに HTML が返ることがある (200 のまま)。
    //   サインイン画面・アクセス権エラー・サイト URL 違いなど。そのまま r.json() すると
    //   「Unexpected token '<'」だけが表示され、どこを直せばよいか分からない。
    //   応答の中身から原因を推測して URL 付きで返す。
    const text = await r.text();
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`${describeNonJson(text, url)}`);
    }
  }

  private async spPost(path: string, body: unknown, extraHeaders: Record<string, string> = {}): Promise<Response> {
    const digest = await this.getDigest();
    const r = await fetch(`${this.webUrl}${path}`, {
      method: 'POST',
      headers: {
        Accept: V, 'Content-Type': V,
        'X-RequestDigest': digest,
        ...extraHeaders,
      },
      credentials: 'same-origin',
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`POST ${path}: HTTP ${r.status} ${await spErrorText(r)}`);
    return r;
  }

  /** リストの ListItemEntityTypeFullName を取得 (POST の __metadata.type に使う)。
   *  リスト名から機械的に組んだ 'SP.Data.<名>ListItem' が実体と食い違うと 400 に
   *  なるため、実際の値を引いてキャッシュする。 */
  private async listEntityType(title: string): Promise<string> {
    const cached = this.entityTypeCache.get(title);
    if (cached) return cached;
    let t = `SP.Data.${title}ListItem`;
    try {
      const j: any = await this.spGet(`/_api/web/lists/getbytitle('${title}')?$select=ListItemEntityTypeFullName`);
      if (j?.d?.ListItemEntityTypeFullName) t = j.d.ListItemEntityTypeFullName;
    } catch { /* 取れなければ既定の推定名で続行 */ }
    this.entityTypeCache.set(title, t);
    return t;
  }

  // ── ensureLists / ensureFields ──────────────────────────────────────────
  async ensureLists(): Promise<void> {
    await this.ensureList(LIST_MANAGED, managedIssueFieldSpecs());
    await this.ensureList(LIST_SETTINGS, settingsFieldSpecs());
    await this.ensureList(LIST_IMPORTLOG, importLogFieldSpecs());
    await this.ensureList(LIST_ASSETS, assetFieldSpecs());
    await this.ensureList(LIST_HISTORY, historyFieldSpecs());
    await this.ensureList(LIST_CHANGELOG, changeLogFieldSpecs());
    await this.ensureList(LIST_DOWNLOADS, downloadFieldSpecs());
    await this.ensureList(LIST_OVERSEAS, overseasFieldSpecs());
  }

  private async ensureList(title: string, fields: FieldSpec[], rep?: StepReporter): Promise<void> {
    // リスト存在確認 (なければ作成)。
    let exists = true;
    try {
      await this.spGet(`/_api/web/lists/getbytitle('${encodeURIComponent(title)}')?$select=Id`);
    } catch { exists = false; }
    if (!exists) {
      // ContentTypesEnabled: true にするとフォームに「コンテンツ タイプ」選択欄が出る。
      // false でも /_api/.../ContentTypes は REST から触れる (フォーム書式設定に必要)。
      await this.spPost(`/_api/web/lists`, {
        __metadata: { type: 'SP.List' },
        Title: title,
        BaseTemplate: 100, // Generic List
        ContentTypesEnabled: false,
      });
      rep?.record('リスト', title, 'created');
    } else {
      rep?.record('リスト', title, 'skipped', '既に存在する');
    }
    await this.ensureFields(title, fields, rep);
  }

  /** 列は必ず InternalName で突合する。
   *  表示名 (Title) は日本語に変えることがあるため、Title で突合すると
   *  「列が無い」と誤判定して毎回作り直しを試みることになる。 */
  private async ensureFields(title: string, fields: FieldSpec[], rep?: StepReporter): Promise<void> {
    const existing = await this.spGet(
      `/_api/web/lists/getbytitle('${encodeURIComponent(title)}')/fields?$select=InternalName,Title,TypeAsString`,
    );
    const have = new Map<string, string>();
    for (const f of existing.d.results as { InternalName: string; TypeAsString: string }[]) {
      have.set(f.InternalName, f.TypeAsString);
    }
    const listPath = `/_api/web/lists/getbytitle('${encodeURIComponent(title)}')`;
    for (const spec of fields) {
      const cur = have.get(spec.name);
      if (cur && cur === spFieldTypeString(spec.type)) {
        if (spec.indexed) await this.tryIndex(listPath, spec.name);
        // ★ 選択肢は「列が既にある = 何もしない」だと永久に古いまま残る。
        //   コード側で選択肢を変えても SP のドロップダウンは旧値のままになり、
        //   新しい値を書くと「候補にない」で弾かれる。ここで実値と突き合わせて直す。
        if (spec.type === 'Choice') await this.syncChoices(title, spec, rep);
        rep?.record('列', spec.name, 'skipped', '既に存在する');
        continue;
      }
      // 型不一致の既存列は DELETE してから再作成 (※データは失われる)。
      if (cur) {
        try {
          await this.spPost(
            `${listPath}/fields/getbyinternalnameortitle('${encodeURIComponent(spec.name)}')`,
            undefined, { 'X-HTTP-Method': 'DELETE', 'IF-MATCH': '*' },
          );
        } catch { /* 削除不可列はスキップ */ }
      }
      try {
        await this.spPost(`${listPath}/fields`, toFieldSchema(spec));
        if (spec.indexed) await this.tryIndex(listPath, spec.name);
        rep?.record('列', spec.name, 'created', cur ? `型変更 ${cur} → ${spFieldTypeString(spec.type)}` : undefined);
      } catch (e) {
        console.warn(`[mikke] ensureField ${spec.name} failed:`, e);
        rep?.record('列', spec.name, 'failed', (e as Error).message);
      }
    }
    // 列を作った可能性があるので実在列キャッシュを無効化 (次の書込で再取得)。
    this.fieldNamesCache = null;
  }

  // ── 連携用リスト (資産管理者向け) の構築 ───────────────────────────────────
  // Mikke の管理表 (MikkeManagedIssues) とは別物。フォームを整形して、
  // 脆弱性情報はヘッダーのカードで読み取り専用表示、本体は対応状況の入力欄だけにする。
  // 設定画面から明示的に実行する (フォーム書式は上書きなので自動では流さない)。

  /** 列を InternalName で引けるようにして返す (SchemaXml / 条件付き数式つき)。 */
  private async loadFieldMap(listTitle: string): Promise<Map<string, any>> {
    const listPath = `/_api/web/lists/getbytitle('${encodeURIComponent(listTitle)}')`;
    const j = await this.spGet(
      `${listPath}/fields?$select=InternalName,Title,Required,SchemaXml,${CONDITIONAL_FORMULA_PROPERTY}&$top=500`,
    );
    const map = new Map<string, any>();
    for (const f of j.d.results) map.set(f.InternalName, f);
    return map;
  }

  private fieldPath(listTitle: string, internalName: string): string {
    return `/_api/web/lists/getbytitle('${encodeURIComponent(listTitle)}')`
      + `/fields/getbyinternalnameortitle('${encodeURIComponent(internalName)}')`;
  }

  /** SchemaXml でしか設定できない属性 (Decimals / RichTextMode) を差し込む。 */
  private async applySchemaXmlAttributes(listTitle: string, fields: FieldSpec[], map: Map<string, any>, rep: StepReporter): Promise<void> {
    for (const spec of fields) {
      if (!spec.schemaXmlAttributes) continue;
      const field = map.get(spec.name);
      if (!field) { rep.record('列(SchemaXml)', spec.name, 'failed', '列が見つかりません'); continue; }
      let xml: string = field.SchemaXml ?? '';
      let changed = false;
      for (const [attr, value] of Object.entries(spec.schemaXmlAttributes)) {
        const re = new RegExp(`\\s${attr}="[^"]*"`);
        if (re.test(xml)) {
          if (new RegExp(`\\s${attr}="${value}"`).test(xml)) continue;
          xml = xml.replace(re, ` ${attr}="${value}"`);
        } else {
          xml = xml.replace(/^<Field\b/, `<Field ${attr}="${value}"`);
        }
        changed = true;
      }
      if (!changed) { rep.record('列(SchemaXml)', spec.name, 'skipped', '設定済み'); continue; }
      try {
        await this.spPost(this.fieldPath(listTitle, spec.name),
          { __metadata: { type: field.__metadata.type }, SchemaXml: xml },
          { 'X-HTTP-Method': 'MERGE', 'IF-MATCH': '*' });
        rep.record('列(SchemaXml)', spec.name, 'updated', JSON.stringify(spec.schemaXmlAttributes));
      } catch (e) { rep.record('列(SchemaXml)', spec.name, 'failed', (e as Error).message); }
    }
  }

  /** 必須/任意を設定する。★ 必須列は条件付き数式で隠せず常にフォームに出るため、
   *  カードで見せる列は required:false にして隠せるようにする。 */
  private async applyRequired(listTitle: string, fields: FieldSpec[], map: Map<string, any>, rep: StepReporter): Promise<void> {
    for (const spec of fields) {
      if (spec.required === undefined) continue;
      const field = map.get(spec.name);
      if (!field) { rep.record('必須設定', spec.name, 'failed', '列が見つかりません'); continue; }
      if (field.Required === spec.required) { rep.record('必須設定', spec.name, 'skipped', '設定済み'); continue; }
      try {
        await this.spPost(this.fieldPath(listTitle, spec.name),
          { __metadata: { type: field.__metadata.type }, Required: spec.required },
          { 'X-HTTP-Method': 'MERGE', 'IF-MATCH': '*' });
        rep.record('必須設定', spec.name, 'updated', spec.required ? '必須' : '任意');
      } catch (e) { rep.record('必須設定', spec.name, 'failed', (e as Error).message); }
    }
  }

  /** 表示名だけを日本語にする (内部名は変わらない)。 */
  private async applyDisplayNames(listTitle: string, fields: FieldSpec[], map: Map<string, any>, rep: StepReporter): Promise<void> {
    for (const spec of fields) {
      if (!spec.displayName) continue;
      const field = map.get(spec.name);
      if (!field) { rep.record('表示名', spec.name, 'failed', '列が見つかりません'); continue; }
      if (field.Title === spec.displayName) { rep.record('表示名', spec.name, 'skipped', '設定済み'); continue; }
      try {
        await this.spPost(this.fieldPath(listTitle, spec.name),
          { __metadata: { type: field.__metadata.type }, Title: spec.displayName },
          { 'X-HTTP-Method': 'MERGE', 'IF-MATCH': '*' });
        rep.record('表示名', `${spec.name} → ${spec.displayName}`, 'updated');
      } catch (e) { rep.record('表示名', spec.name, 'failed', (e as Error).message); }
    }
  }

  /** フォーム本体の表示/非表示 (条件付き数式)。
   *  ★ 数式を「付ける」だけでなく「外す」ことも行う。定義から conditionalFormula を
   *    消しても列に古い数式が残っていると、その列はフォームに出ないままになる
   *    (レイアウト変更で表示に切り替えた列が消えたままになる)。 */
  private async applyConditionalFormulas(listTitle: string, fields: FieldSpec[], map: Map<string, any>, rep: StepReporter): Promise<void> {
    for (const spec of fields) {
      const field = map.get(spec.name);
      if (!field) {
        if (spec.conditionalFormula) rep.record('条件付き数式', spec.name, 'failed', '列が見つかりません');
        continue;
      }
      const cur = field[CONDITIONAL_FORMULA_PROPERTY] || '';
      const want = spec.conditionalFormula || '';
      if (cur === want) {
        if (want) rep.record('条件付き数式', spec.name, 'skipped', '設定済み');
        continue;
      }
      try {
        await this.spPost(this.fieldPath(listTitle, spec.name),
          { __metadata: { type: field.__metadata.type }, [CONDITIONAL_FORMULA_PROPERTY]: want },
          { 'X-HTTP-Method': 'MERGE', 'IF-MATCH': '*' });
        rep.record('条件付き数式', spec.name, 'updated', want ? want : '解除 (常に表示)');
      } catch (e) { rep.record('条件付き数式', spec.name, 'failed', (e as Error).message); }
    }
  }

  /** 既定ビューに列を出す (Title は LinkTitle が既にあるので入れない)。 */
  private async ensureViewFields(listTitle: string, viewFields: string[], rep: StepReporter): Promise<void> {
    const listPath = `/_api/web/lists/getbytitle('${encodeURIComponent(listTitle)}')`;
    try {
      const cur = await this.spGet(`${listPath}/DefaultView/ViewFields`);
      const present: string[] = cur.d?.Items?.results ?? [];
      const missing = viewFields.filter((f) => !present.includes(f));
      if (!missing.length) { rep.record('既定ビュー', viewFields.join(', '), 'skipped', '設定済み'); return; }
      for (const f of missing) {
        await this.spPost(`${listPath}/DefaultView/ViewFields/addviewfield('${encodeURIComponent(f)}')`, {});
      }
      rep.record('既定ビュー', missing.join(', '), 'updated', `${missing.length} 列を追加`);
    } catch (e) { rep.record('既定ビュー', viewFields.join(', '), 'failed', (e as Error).message); }
  }

  /** 既定コンテンツタイプにフォームヘッダーの書式設定を書き込む。 */
  private async applyFormFormatter(listTitle: string, formatter: string, rep: StepReporter): Promise<void> {
    const listPath = `/_api/web/lists/getbytitle('${encodeURIComponent(listTitle)}')`;
    try {
      const cts = await this.spGet(`${listPath}/ContentTypes?$select=StringId,Name,ClientFormCustomFormatter`);
      const list: any[] = cts.d?.results ?? [];
      // 既定コンテンツタイプ = 先頭。フォルダー (0x0120…) は対象外。
      const ct = list.find((c) => !String(c.StringId).startsWith('0x0120'));
      if (!ct) { rep.record('フォーム書式設定', '既定コンテンツタイプ', 'failed', '見つかりません'); return; }
      if (ct.ClientFormCustomFormatter === formatter) {
        rep.record('フォーム書式設定', ct.Name, 'skipped', '設定済み'); return;
      }
      await this.spPost(`${listPath}/ContentTypes('${encodeURIComponent(ct.StringId)}')`,
        { __metadata: { type: 'SP.ContentType' }, ClientFormCustomFormatter: formatter },
        { 'X-HTTP-Method': 'MERGE', 'IF-MATCH': '*' });
      rep.record('フォーム書式設定', ct.Name, 'updated', ct.StringId);
    } catch (e) { rep.record('フォーム書式設定', '既定コンテンツタイプ', 'failed', (e as Error).message); }
  }

  /**
   * CSOM (ProcessQuery) を叩く。REST に無い操作だけに使う。
   * 応答は JSON 配列で、先頭要素の ErrorInfo が null なら成功。
   */
  private async processQuery(xml: string): Promise<void> {
    const digest = await this.getDigest();
    const r = await fetch(`${this.webUrl}/_vti_bin/client.svc/ProcessQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/xml', 'X-RequestDigest': digest },
      credentials: 'same-origin',
      body: xml,
    });
    if (!r.ok) throw new Error(`ProcessQuery: HTTP ${r.status}`);
    const err = processQueryError(await r.text());
    if (err) throw new Error(err);
  }

  /**
   * フォームの項目順を定義順に揃える。
   *
   * ★ 並べ替えは REST に存在しない ($metadata に Reorder は無い)。CSOM の
   *   FieldLinkCollection.Reorder を ProcessQuery 経由で呼ぶ (実機で成功を確認)。
   *   列を後から足すと末尾に積まれるため、整形のたびに定義順へ戻す。
   */
  private async applyFieldOrder(listTitle: string, fields: FieldSpec[], rep: StepReporter): Promise<void> {
    const listPath = `/_api/web/lists/getbytitle('${encodeURIComponent(listTitle)}')`;
    try {
      const cts = await this.spGet(`${listPath}/ContentTypes?$select=StringId,Name`);
      const ct = (cts.d?.results ?? []).find((c: any) => !String(c.StringId).startsWith('0x0120'));
      if (!ct) { rep.record('列の並び順', '既定コンテンツタイプ', 'failed', '見つかりません'); return; }
      const ctPath = `${listPath}/ContentTypes('${encodeURIComponent(ct.StringId)}')`;
      const fl = await this.spGet(`${ctPath}/FieldLinks?$select=Name&$top=500`);
      const current: string[] = (fl.d?.results ?? []).map((f: any) => String(f.Name));
      const ordered = orderFieldLinks(current, fields.map((f) => f.name));
      if (ordered.join('\u0000') === current.join('\u0000')) {
        rep.record('列の並び順', ct.Name, 'skipped', '設定済み'); return;
      }
      await this.processQuery(buildReorderFieldsXml(listTitle, ct.StringId, ordered));
      rep.record('列の並び順', ct.Name, 'updated', `${ordered.length} 列を定義順に並べ替え`);
    } catch (e) { rep.record('列の並び順', listTitle, 'failed', (e as Error).message); }
  }

  /** 旧レイアウトの列を削除する (存在しなければ何もしない)。 */
  private async removeObsoleteFields(listTitle: string, names: string[], map: Map<string, any>, rep: StepReporter): Promise<void> {
    for (const name of names) {
      if (!map.has(name)) { rep.record('旧列の削除', name, 'skipped', '存在しない'); continue; }
      try {
        await this.spPost(this.fieldPath(listTitle, name), undefined,
          { 'X-HTTP-Method': 'DELETE', 'IF-MATCH': '*' });
        rep.record('旧列の削除', name, 'updated', '削除しました');
      } catch (e) { rep.record('旧列の削除', name, 'failed', (e as Error).message); }
    }
  }

  /**
   * リストを開く URL (既定ビュー) を SharePoint から取得する。無ければ null。
   *
   * ★ `/Lists/<Title>/AllItems.aspx` と組み立ててはいけない。リストの URL は
   *   作成時の名前で決まり、後から表示名を変えても URL は変わらない。日本語名や
   *   記号入りでも変わる。組み立てた URL は当たることもあるが外れると 404 になる。
   */
  private async listViewUrl(title: string): Promise<string | null> {
    try {
      const j = await this.spGet(
        `/_api/web/lists/getbytitle('${encodeURIComponent(title)}')?$select=DefaultViewUrl`);
      const rel: string = j?.d?.DefaultViewUrl ?? '';
      return rel ? location.origin + rel : null;
    } catch { return null; }   // 未作成 (404) もここに来る
  }

  /** 連携用リストの各アイテムの最終更新日時 (IssueInstanceId → Modified)。
   *  ★ 連携用リストが未作成 / 権限が無い場合は空 Map を返す (画面を止めない)。 */
  async vulnResponseUpdatedAt(): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    let url: string | null =
      `/_api/web/lists/getbytitle('${LIST_VULNRESPONSE}')/items`
      + '?$select=Title,Modified&$top=5000';
    try {
      while (url) {
        const j: any = await this.spGet(url);
        for (const row of j.d.results as { Title?: string; Modified?: string }[]) {
          if (row.Title) out.set(row.Title, row.Modified ?? '');
        }
        url = j.d.__next ? j.d.__next.replace(this.webUrl, '') : null;
      }
    } catch { return out; }   // 未作成 (404) 等はここに来る
    return out;
  }

  /** 連携用リストの記入内容 (資産管理者が変更できる欄) を全件取得する。
   *  ★ 対応者は User 列なので $expand で表示名まで取る。
   *  リストが未作成 / 権限が無い場合は空配列 (画面を止めない)。 */
  async listVulnResponses(): Promise<VulnResponseItem[]> {
    const out: VulnResponseItem[] = [];
    let url: string | null =
      `/_api/web/lists/getbytitle('${LIST_VULNRESPONSE}')/items`
      + '?$select=Title,Modified,ResponseStatus,DueDate,Remarks,Responder/Title,'
      + 'ExtConnAppId,ResponsePlan,NoAppReason'
      + '&$expand=Responder&$top=5000';
    try {
      while (url) {
        const j: any = await this.spGet(url);
        for (const row of j.d.results as any[]) {
          if (!row.Title) continue;
          out.push({
            issueInstanceId: row.Title,
            responseStatus: row.ResponseStatus ?? undefined,
            responderName: row.Responder?.Title ?? undefined,
            dueDate: row.DueDate ?? undefined,
            remarks: row.Remarks ?? undefined,
            extConnAppId: row.ExtConnAppId ?? undefined,
            responsePlan: row.ResponsePlan ?? undefined,
                  noAppReason: row.NoAppReason ?? undefined,
            updatedAt: row.Modified ?? undefined,
          });
        }
        url = j.d.__next ? j.d.__next.replace(this.webUrl, '') : null;
      }
    } catch { return out; }
    return out;
  }

  /** 連携用リストの既存アイテム (Mikke が書き込む項目のみ)。反映の差分計算に使う。
   *  リストが未作成 / 権限が無い場合は空配列。 */
  async listVulnResponseRows(): Promise<VulnResponseRow[]> {
    const out: VulnResponseRow[] = [];
    let url: string | null =
      `/_api/web/lists/getbytitle('${LIST_VULNRESPONSE}')/items`
      + '?$select=Id,Title,VulnTitle,LegacyMgmtNumber,DetectionStatus,FirstSeen,LastSeen,'
      + 'AssetIp,AssetFqdn,AssetType,BusinessCompany,AffiliateCompany,AssetMgmtId,'
      + 'RelatedAssets,IdentifyEvidence,ReportUrl,'
      // 資産管理者の記入欄。上書きを選んだときに「変わった分だけ書く」ための比較に使う
      // (毎回書くと相手の更新時刻が動いて「通知」列の判定が濁る)。
      + 'ResponseStatus,DueDate,ExtConnAppId,ResponsePlan,NoAppReason,Remarks&$top=5000';
    try {
      while (url) {
        const j: any = await this.spGet(url);
        for (const r of j.d.results as any[]) {
          out.push({
            id: r.Id,
            issueInstanceId: r.Title ?? '',
            title: r.VulnTitle ?? '',
            legacyMgmtNumber: r.LegacyMgmtNumber ?? '',
            detectionStatus: r.DetectionStatus ?? '',
            firstSeen: r.FirstSeen ?? '',
            lastSeen: r.LastSeen ?? '',
            assetIp: r.AssetIp ?? '',
            assetFqdn: r.AssetFqdn ?? '',
            assetType: r.AssetType ?? '',
            businessCompany: r.BusinessCompany ?? '',
            affiliateCompany: r.AffiliateCompany ?? '',
            assetMgmtId: r.AssetMgmtId ?? '',
            relatedAssets: r.RelatedAssets ?? '',
            identifyEvidence: r.IdentifyEvidence ?? '',
            // URL 列は {Url, Description} で返る。差分は Url だけで比べる。
            reportUrl: r.ReportUrl?.Url ?? '',
            responseStatus: r.ResponseStatus ?? '',
            responseDueDate: r.DueDate ?? '',
            extConnAppId: r.ExtConnAppId ?? '',
            responsePlan: r.ResponsePlan ?? '',
            noAppReason: r.NoAppReason ?? '',
            responseRemarks: r.Remarks ?? '',
          });
        }
        url = j.d.__next ? j.d.__next.replace(this.webUrl, '') : null;
      }
    } catch { return out; }
    return out;
  }

  /** 連携用リストの項目 → SP の列。日付は空文字だと 400 になるので null で送る。 */
  /** 書き込み用の行を組み立てる。列名の対応は vulnResponseSync.ts に一本化している
   *  (ここと SP スキーマ宣言がズレると反映が全件 400 になるため)。 */
  private vulnResponseRow(f: Partial<VulnResponseFields>): Record<string, unknown> {
    const row: Record<string, unknown> = {};
    for (const [key, col] of Object.entries(VULNRESPONSE_COLUMN) as [keyof VulnResponseFields, string][]) {
      const v = f[key];
      if (v === undefined) continue;
      if (VULNRESPONSE_KIND[key] === 'url') {
        // URL 列は {Url, Description}。Description が一覧でのリンク文字列になる。
        // 表示テキストは固定文言 (空なら列をクリアする)。
        row[col] = v
          ? { __metadata: { type: 'SP.FieldUrlValue' }, Url: v, Description: REPORT_LINK_TEXT }
          : null;
        continue;
      }
      // 日付は空文字だと SP が 400 を返すので null を送る。
      row[col] = VULNRESPONSE_DATE_FIELDS.includes(key) ? (v || null) : v;
    }
    return row;
  }

  /** 連携用リストに実在する列だけに絞る。
   *  ★ SP は body に無い列が 1 つでもあると **その 1 件ごと 400** を返す。
   *    Mikke に列を足した直後 (連携用リストを作り直していない環境) では、
   *    全件が失敗して「連携リストへの更新でエラー」になっていた。
   *    管理表と同じく、書く前に実在列と突き合わせて落とす。 */
  private async vulnResponseRowExisting(f: Partial<VulnResponseFields>): Promise<Record<string, unknown>> {
    const row = this.vulnResponseRow(f);
    const existing = await this.getFieldNamesOf(LIST_VULNRESPONSE);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(row)) if (existing.has(k)) out[k] = v;
    return out;
  }

  /** 連携用リストに足りない列 (Mikke が書く項目のうち実在しないもの) を返す。 */
  // ── 連携用リストのアイテム単位アクセス権 ─────────────────────────────────
  //   方式は lib/itemPerms.ts のコメントを参照 (WebReg の src/perms.js に準拠)。

  /** メールアドレスから利用者を引く。
   *  ★ ensureuser は SP のユーザー情報リストに居ない相手も AD/Entra から解決できる
   *    (サイトに未参加でも引ける)。副作用はユーザー情報リストへの登録だけ。 */
  async resolveUserByEmail(email: string): Promise<SiteUser | null> {
    const v = (email ?? '').trim();
    if (!v) return null;
    try {
      const r = await this.spPost('/_api/web/ensureuser', { logonName: v });
      const j = await r.json();
      const d = j.d ?? {};
      return { displayName: d.Title ?? '', email: d.Email ?? v };
    } catch {
      return null;
    }
  }

  async listSiteGroups(): Promise<{ id: number; title: string }[]> {
    const j = await this.spGet('/_api/web/sitegroups?$select=Id,Title&$top=999');
    return (j.d?.results ?? [])
      // SP が自動生成するシステムグループは割当先にならない。
      .filter((g: { Title?: string }) => !/^(SharingLinks\.|Limited Access System Group)/.test(g.Title ?? ''))
      .map((g: { Id: number; Title: string }) => ({ id: g.Id, title: g.Title }))
      .sort((a: { title: string }, b: { title: string }) => a.title.localeCompare(b.title, 'ja'));
  }

  async listVulnResponsePermTargets(): Promise<{ id: number; businessCompany: string; hasUniquePerms: boolean }[]> {
    const out: { id: number; businessCompany: string; hasUniquePerms: boolean }[] = [];
    // ★ HasUniqueRoleAssignments も取る。false = まだ継承のまま = 権限未適用。
    //   反映のたびに全件へ付け直すのは重い (1 件あたり 4〜6 リクエスト) ので、
    //   未適用のものだけを対象にできるようにする。
    let url: string | null =
      `/_api/web/lists/getbytitle('${LIST_VULNRESPONSE}')/items`
      + '?$select=Id,BusinessCompany,HasUniqueRoleAssignments&$top=5000';
    while (url) {
      const j: any = await this.spGet(url);
      for (const r of j.d.results as
        { Id: number; BusinessCompany?: string; HasUniqueRoleAssignments?: boolean }[]) {
        out.push({
          id: r.Id, businessCompany: r.BusinessCompany ?? '',
          hasUniquePerms: !!r.HasUniqueRoleAssignments,
        });
      }
      url = j.d.__next ? j.d.__next.replace(this.webUrl, '') : null;
    }
    return out;
  }

  /** 適用に必要な文脈 (ロール定義・実行者・ロックアウト防止の判定) を一度だけ作る。 */
  private async buildPermContext(perms: VulnResponsePerms): Promise<{
    roles: PermRoles; currentUserId: number; keepExecutor: boolean;
  }> {
    const defs = await this.spGet('/_api/web/roledefinitions?$select=Id,Name,RoleTypeKind');
    const roles = pickRoles((defs.d?.results ?? []) as { Id: number; RoleTypeKind: number }[]);
    const me = await this.spGet('/_api/web/currentuser?$select=Id,IsSiteAdmin');
    let myGroupIds: number[] = [];
    try {
      const g = await this.spGet('/_api/web/currentuser/groups?$select=Id');
      myGroupIds = (g.d?.results ?? []).map((x: { Id: number }) => x.Id);
    } catch { /* 取れなければ安全側 (実行者の個別権限を残す) に倒す */ }
    // 実行者がサイト管理者 or 管理者グループの一員なら、グループ経由で全件見られるので
    // 個別権限は外してよい。そうでなければ外すと自分が見られなくなる。
    const adminSet = new Set(perms.adminGroupIds);
    const keepExecutor = !(me.d.IsSiteAdmin || myGroupIds.some((id) => adminSet.has(id)));
    return { roles, currentUserId: me.d.Id, keepExecutor };
  }

  async applyVulnResponseItemPerms(
    targets: { id: number; businessCompany: string }[],
    onProgress?: (done: number, total: number) => void,
  ): Promise<{ applied: number; adminOnly: number; errors: string[] }> {
    return this.applyItemPermsOn(LIST_VULNRESPONSE, targets, onProgress);
  }

  /** アイテム単位アクセス権の適用本体。国内 / 海外の連携用リストで共用する。
   *  ★ 割当の設定 (vulnResponsePerms) は 1 つを共用する。事業会社ごとのグループも
   *    管理者グループも同じものを使う、という仕様のため。
   *  ★ companyRole は事業会社グループに付けるロール。国内は記入してもらうので投稿、
   *    海外は読み取り専用なので参照。管理者グループは両方ともフルコントロール。 */
  private async applyItemPermsOn(
    listTitle: string,
    targets: { id: number; businessCompany: string }[],
    onProgress?: (done: number, total: number) => void,
    companyRole: 'edit' | 'read' = 'edit',
  ): Promise<{ applied: number; adminOnly: number; errors: string[] }> {
    const settings = await this.getSettings();
    const perms = normalizePerms(settings.vulnResponsePerms);
    if (!hasAnyPerms(perms)) throw new Error('アクセス権が未設定です (管理者グループを 1 つ以上選んでください)');
    const ctx = await this.buildPermContext(perms);
    const plans = buildItemPermPlan(targets, perms);
    const listPath = `/_api/web/lists/getbytitle('${listTitle}')`;
    const out = { applied: 0, adminOnly: 0, errors: [] as string[] };
    let done = 0;
    for (const plan of plans) {
      done++;
      onProgress?.(done, plans.length);
      const base = `${listPath}/items(${plan.id})`;
      try {
        await this.spPost(`${base}/breakroleinheritance(copyroleassignments=false,clearsubscopes=true)`, undefined);
        // 1) 先に付与する。実行者の権限を消してから付けると、途中でアイテムを
        //    見失って 400 になる。
        const keep = new Set<number>();
        for (const gid of plan.full) {
          if (keep.has(gid)) continue;
          await this.spPost(`${base}/roleassignments/addroleassignment(principalid=${gid},roledefid=${ctx.roles.full})`, undefined);
          keep.add(gid);
        }
        for (const gid of plan.edit) {
          if (keep.has(gid)) continue;
          await this.spPost(`${base}/roleassignments/addroleassignment(principalid=${gid},roledefid=${ctx.roles[companyRole]})`, undefined);
          keep.add(gid);
        }
        // 2) 付与したもの以外を削除 (既定の継承グループ・継承解除で付く実行者の個別権限)。
        const cur = await this.spGet(`${base}/roleassignments?$select=PrincipalId`);
        for (const ra of (cur.d?.results ?? []) as { PrincipalId: number }[]) {
          if (keep.has(ra.PrincipalId)) continue;
          if (ctx.keepExecutor && ra.PrincipalId === ctx.currentUserId) continue;   // 安全弁
          await this.spPost(`${base}/roleassignments/getbyprincipalid(${ra.PrincipalId})`,
            undefined, { 'X-HTTP-Method': 'DELETE', 'IF-MATCH': '*' });
        }
        if (plan.edit.length) out.applied++; else out.adminOnly++;
      } catch (e) {
        out.errors.push(`#${plan.id}: ${(e as Error).message}`);
      }
    }
    return out;
  }

  async findMissingVulnResponseColumns(): Promise<string[]> {
    this.fieldNamesByList.delete(LIST_VULNRESPONSE);   // 最新の実在列で判定する
    let existing: Set<string>;
    try { existing = await this.getFieldNamesOf(LIST_VULNRESPONSE); }
    catch { return []; }        // リスト自体が無い場合は呼び出し側の別導線に任せる
    const want = Object.values(VULNRESPONSE_COLUMN);
    return want.filter((k) => !existing.has(k));
  }

  async createVulnResponseItem(fields: VulnResponseFields): Promise<void> {
    const type = await this.listEntityType(LIST_VULNRESPONSE);
    await this.spPost(`/_api/web/lists/getbytitle('${LIST_VULNRESPONSE}')/items`,
      { __metadata: { type }, ...(await this.vulnResponseRowExisting(fields)) });
  }

  async updateVulnResponseItem(id: number, fields: Partial<VulnResponseFields>): Promise<void> {
    const type = await this.listEntityType(LIST_VULNRESPONSE);
    const row = await this.vulnResponseRowExisting(fields);
    if (!Object.keys(row).length) return;   // 書ける列が残らなければ何もしない
    await this.spPost(`/_api/web/lists/getbytitle('${LIST_VULNRESPONSE}')/items(${id})`,
      { __metadata: { type }, ...row },
      { 'X-HTTP-Method': 'MERGE', 'IF-MATCH': '*' });
  }

  /**
   * 連携用リストへの反映を **$batch でまとめて** 書く。
   * ★ 1 件ずつ POST/MERGE/DELETE していたので、件数ぶん往復して遅かった。
   *   100 件ずつまとめる。実在しない列を落とす処理は先に 1 回だけ行う。
   */
  async applyVulnResponseWrites(
    creates: VulnResponseFields[],
    updates: { id: number; fields: Partial<VulnResponseFields> }[],
    deletes: number[],
    onProgress?: (done: number, total: number) => void,
  ): Promise<{ ok: number; fail: number }> {
    const existing = await this.getFieldNamesOf(LIST_VULNRESPONSE);
    const dropped = new Set<string>();
    const pick = (f: Partial<VulnResponseFields>): Record<string, unknown> =>
      this.filterExisting(this.vulnResponseRow(f), existing, dropped);
    const ops = [
      // 先に消す。対象外を解除した直後の追加と取り違えにくい。
      ...deletes.map((id) => ({ kind: 'delete' as const, id, row: {} })),
      ...creates.map((c) => ({ kind: 'add' as const, row: pick(c) })),
      ...updates.map((u) => ({ kind: 'update' as const, id: u.id, row: pick(u.fields) })),
    ];
    if (dropped.size) console.warn('[mikke] 連携用リストに存在しない列を除外:', [...dropped]);
    if (!ops.length) return { ok: 0, fail: 0 };
    return this.batchWrite(ops, onProgress, LIST_VULNRESPONSE);
  }

  /**
   * 管理対象への書き込みを **$batch でまとめて** 行う (移行・連携取込など)。
   * ★ createIssue / updateIssue を 1 件ずつ呼ぶと件数ぶん往復する。
   */
  async applyIssueWrites(
    creates: Omit<ManagedIssue, 'id'>[],
    updates: { id: number; patch: Partial<ManagedIssue> }[],
    onProgress?: (done: number, total: number) => void,
  ): Promise<{ ok: number; fail: number }> {
    const existing = await this.getFieldNames();
    const dropped = new Set<string>();
    const ops = [
      ...creates.map((c) => ({ kind: 'add' as const,
        row: this.filterExisting(this.issueToRow(c), existing, dropped) })),
      ...updates.map((u) => ({ kind: 'update' as const, id: u.id,
        row: this.filterExisting(this.issueToRow(u.patch), existing, dropped) })),
    ];
    if (dropped.size) console.warn('[mikke] 管理表に存在しない列を除外:', [...dropped]);
    if (!ops.length) return { ok: 0, fail: 0 };
    return this.batchWrite(ops, onProgress);
  }

  async deleteVulnResponseItem(id: number): Promise<void> {
    await this.spPost(`/_api/web/lists/getbytitle('${LIST_VULNRESPONSE}')/items(${id})`,
      undefined, { 'X-HTTP-Method': 'DELETE', 'IF-MATCH': '*' });
  }

  async vulnResponseListUrl(): Promise<string | null> {
    return this.listViewUrl(LIST_VULNRESPONSE);
  }

  /** 連携用リストを構築する (冪等。何度実行してもよい)。 */
  async ensureVulnResponseList(): Promise<SetupResult> {
    const rep = new StepReporter();
    const fields = vulnResponseFieldSpecs();
    await this.ensureList(LIST_VULNRESPONSE, fields, rep);
    // 作成直後の状態で引き直し、以降の工程はこれを見る
    let map = await this.loadFieldMap(LIST_VULNRESPONSE);
    // 旧レイアウトの列を消してからビュー/フォームを整える (残っているとフォームに出る)
    await this.removeObsoleteFields(LIST_VULNRESPONSE, VULNRESPONSE_OBSOLETE_FIELDS, map, rep);
    map = await this.loadFieldMap(LIST_VULNRESPONSE);
    await this.applySchemaXmlAttributes(LIST_VULNRESPONSE, fields, map, rep);
    await this.applyRequired(LIST_VULNRESPONSE, fields, map, rep);
    await this.applyDisplayNames(LIST_VULNRESPONSE, fields, map, rep);
    await this.ensureViewFields(LIST_VULNRESPONSE, VULNRESPONSE_VIEW_FIELDS, rep);
    await this.applyFieldOrder(LIST_VULNRESPONSE, fields, rep);
    await this.applyFormFormatter(LIST_VULNRESPONSE, buildVulnResponseFormFormatter(), rep);
    await this.applyConditionalFormulas(LIST_VULNRESPONSE, fields, map, rep);
    this.fieldNamesByList.delete(LIST_VULNRESPONSE);   // 列を作ったので実在列を引き直す
    // ★ URL は組み立てず、作成したリストから実際の値を引く (組み立てると 404 になり得る)。
    const listUrl = await this.listViewUrl(LIST_VULNRESPONSE);
    return rep.result(listUrl ?? `${this.webUrl}/Lists/${LIST_VULNRESPONSE}/AllItems.aspx`);
  }

  // ── 実在列チェック ─────────────────────────────────────────────────────────
  // 列は全て固定 ASCII 名 (IssueInstanceId / ScanData 等) で Title=InternalName の
  // ため変換は不要。書込前に実在列と突合し、無い列だけ除外して行ごと 400 を防ぐ。
  private fieldNamesCache: Set<string> | null = null;
  /** リストごとの実在列キャッシュ (管理表以外。連携用リスト等)。 */
  private fieldNamesByList = new Map<string, Set<string>>();

  private async getFieldNames(): Promise<Set<string>> {
    if (this.fieldNamesCache) return this.fieldNamesCache;
    this.fieldNamesCache = await this.fetchFieldNames(LIST_MANAGED);
    return this.fieldNamesCache;
  }

  private async fetchFieldNames(listTitle: string): Promise<Set<string>> {
    const j = await this.spGet(
      `/_api/web/lists/getbytitle('${encodeURIComponent(listTitle)}')/fields?$select=InternalName`,
    );
    const set = new Set<string>();
    for (const f of j.d.results as { InternalName: string }[]) set.add(f.InternalName);
    return set;
  }

  /** 管理表以外のリストの実在列 (キャッシュあり)。 */
  private async getFieldNamesOf(listTitle: string): Promise<Set<string>> {
    const hit = this.fieldNamesByList.get(listTitle);
    if (hit) return hit;
    const set = await this.fetchFieldNames(listTitle);
    this.fieldNamesByList.set(listTitle, set);
    return set;
  }

  /** row のキーを実在列に絞る。除外したキーは dropped に集める。 */
  private filterExisting(
    row: Record<string, unknown>,
    existing: Set<string>,
    dropped: Set<string>,
  ): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(row)) {
      if (existing.has(k)) out[k] = v;
      else dropped.add(k);
    }
    return out;
  }

  /** 既存の Choice 列の選択肢をスキーマ宣言に合わせる (順序・値とも)。
   *  ★ 既にその値が入っているアイテムは SP 側で保持される (選択肢から外しても消えない)。
   *    読み出し側で現行値に畳む必要がある (types.ts の normalizeMgmtStatus)。 */
  private async syncChoices(listTitle: string, spec: FieldSpec, rep?: StepReporter): Promise<void> {
    const want = spec.choices ?? [];
    if (!want.length) return;
    try {
      const path = this.fieldPath(listTitle, spec.name);
      const f = await this.spGet(`${path}?$select=Choices`);
      const have: string[] = f?.d?.Choices?.results ?? [];
      if (have.length === want.length && have.every((v, i) => v === want[i])) return;
      await this.spPost(path,
        { __metadata: { type: 'SP.FieldChoice' }, Choices: { results: want } },
        { 'X-HTTP-Method': 'MERGE', 'IF-MATCH': '*' });
      rep?.record('選択肢', spec.name, 'updated', `${have.join('/')} → ${want.join('/')}`);
    } catch (e) {
      // 選択肢の更新に失敗しても列自体は使えるので、取込全体は止めない。
      console.warn(`[mikke] syncChoices ${spec.name} failed:`, e);
      rep?.record('選択肢', spec.name, 'failed', (e as Error).message);
    }
  }

  private async tryIndex(listPath: string, fieldName: string): Promise<void> {
    try {
      await this.spPost(
        // 表示名を日本語化しても引けるよう内部名で引く。
        `${listPath}/fields/getbyinternalnameortitle('${encodeURIComponent(fieldName)}')`,
        { __metadata: { type: 'SP.Field' }, Indexed: true },
        { 'X-HTTP-Method': 'MERGE', 'IF-MATCH': '*' },
      );
    } catch { /* 後付け index 失敗 (5000 超) はスキップ */ }
  }

  // ── CRUD ────────────────────────────────────────────────────────────────
  async listIssues(): Promise<ManagedIssue[]> {
    const out: ManagedIssue[] = [];
    let url: string | null =
      `/_api/web/lists/getbytitle('${LIST_MANAGED}')/items?$top=5000`;
    while (url) {
      const j: any = await this.spGet(url);
      for (const row of j.d.results) out.push(this.rowToIssue(row));
      url = j.d.__next ? j.d.__next.replace(this.webUrl, '') : null;
    }
    return out;
  }

  async getIssue(id: number): Promise<ManagedIssue | null> {
    try {
      const j = await this.spGet(`/_api/web/lists/getbytitle('${LIST_MANAGED}')/items(${id})`);
      return this.rowToIssue(j.d);
    } catch { return null; }
  }

  async updateIssue(id: number, patch: Partial<ManagedIssue>): Promise<void> {
    const existing = await this.getFieldNames();
    const dropped = new Set<string>();
    const body = this.filterExisting(this.issueToRow(patch), existing, dropped);
    if (dropped.size) console.warn('[mikke] updateIssue: リストに存在しない列を除外:', [...dropped]);
    await this.spPost(
      `/_api/web/lists/getbytitle('${LIST_MANAGED}')/items(${id})`,
      { __metadata: { type: 'SP.Data.MikkeManagedIssuesListItem' }, ...body },
      { 'X-HTTP-Method': 'MERGE', 'IF-MATCH': '*' }, // 後勝ち
    );
  }

  /** 管理対象を全件削除する ($batch で 100 件ずつ)。元に戻せない。 */
  async deleteAllIssues(onProgress?: (done: number, total: number) => void): Promise<{ ok: number; fail: number }> {
    const ids: number[] = [];
    let url: string | null =
      `/_api/web/lists/getbytitle('${LIST_MANAGED}')/items?$select=Id&$top=5000`;
    while (url) {
      const j: any = await this.spGet(url);
      for (const r of j.d.results as { Id: number }[]) ids.push(r.Id);
      url = j.d.__next ? j.d.__next.replace(this.webUrl, '') : null;
    }
    if (!ids.length) return { ok: 0, fail: 0 };
    // ★ 大きい ID から消す。SP はアイテム削除で ID を詰めないので順序は本質ではないが、
    //   途中で止まったときに「どこまで消えたか」が分かりやすい。
    ids.sort((a, b) => b - a);
    return this.batchWrite(ids.map((id) => ({ kind: 'delete' as const, id, row: {} })), onProgress);
  }

  async deleteIssue(id: number): Promise<void> {
    await this.spPost(
      `/_api/web/lists/getbytitle('${LIST_MANAGED}')/items(${id})`,
      undefined, { 'X-HTTP-Method': 'DELETE', 'IF-MATCH': '*' },
    );
  }

  async createIssue(issue: Omit<ManagedIssue, 'id'>): Promise<number> {
    const existing = await this.getFieldNames();
    const dropped = new Set<string>();
    const body = this.filterExisting(this.issueToRow(issue), existing, dropped);
    if (dropped.size) console.warn('[mikke] createIssue: リストに存在しない列を除外:', [...dropped]);
    const r = await this.spPost(
      `/_api/web/lists/getbytitle('${LIST_MANAGED}')/items`,
      { __metadata: { type: 'SP.Data.MikkeManagedIssuesListItem' }, ...body },
    );
    const j = await r.json();
    return j.d.Id as number;
  }

  /**
   * 一括書き込み ($batch)。取込 (約2万件) の create / update をまとめて送る。
   * ops: kind=add は新規 POST、kind=update は MERGE (If-Match:* = 後勝ち)。
   * 1 バッチ最大 BATCH_CHUNK 件でチャンクし、進捗を onProgress で通知。
   *
   * ★ 実機検証で判明した重要点 (n365 で確認):
   *   各サブリクエストの Content-Length は **UTF-8 バイト長** で算出すること。
   *   JS 文字列の .length (UTF-16 コード単位) を使うと、日本語を含む body で
   *   SP が途中で切って HTTP 400 になる。TextEncoder().encode(body).length を使う。
   */
  async batchWrite(
    ops: { kind: 'add' | 'update' | 'delete'; id?: number; row: Record<string, unknown> }[],
    onProgress?: (done: number, total: number) => void,
    /** 書き込み先。省略時は管理表。 */
    listTitle: string = LIST_MANAGED,
  ): Promise<{ ok: number; fail: number }> {
    const BATCH_CHUNK = 100;
    const etype = await this.listEntityType(listTitle);
    const listUrl = `${this.webUrl}/_api/web/lists/getbytitle('${listTitle}')/items`;
    const enc = new TextEncoder();
    let ok = 0, fail = 0;

    for (let i = 0; i < ops.length; i += BATCH_CHUNK) {
      const chunk = ops.slice(i, i + BATCH_CHUNK);
      const digest = await this.getDigest();
      // boundary は固定文字列で十分 (Math.random は使わない=決定性)。
      const bg = `batch_${i}_${chunk.length}`;
      const cg = `changeset_${i}_${chunk.length}`;
      let cs = '';
      for (const op of chunk) {
        const hasId = op.id != null && (op.kind === 'update' || op.kind === 'delete');
        const target = hasId ? `${listUrl}(${op.id})` : listUrl;
        const method = op.kind === 'update' ? 'MERGE' : (op.kind === 'delete' ? 'DELETE' : 'POST');
        cs += `--${cg}\r\nContent-Type: application/http\r\nContent-Transfer-Encoding: binary\r\n\r\n`;
        cs += `${method} ${target} HTTP/1.1\r\nAccept: ${V}\r\n`;
        if (op.kind === 'delete') {
          // ★ DELETE は body を付けない。Content-Type / Content-Length を書くと SP が 400 を返す。
          cs += 'IF-MATCH: *\r\n\r\n';
          continue;
        }
        const body = JSON.stringify({ __metadata: { type: etype }, ...op.row });
        const blen = enc.encode(body).length; // ★ UTF-8 バイト長
        cs += `Content-Type: ${V}\r\n`;
        if (op.kind === 'update') cs += 'IF-MATCH: *\r\n';
        cs += `Content-Length: ${blen}\r\n\r\n${body}\r\n`;
      }
      cs += `--${cg}--\r\n`;
      const payload = `--${bg}\r\nContent-Type: multipart/mixed; boundary=${cg}\r\n\r\n${cs}--${bg}--\r\n`;

      const r = await fetch(`${this.webUrl}/_api/$batch`, {
        method: 'POST',
        headers: { 'Content-Type': `multipart/mixed; boundary=${bg}`, 'X-RequestDigest': digest, Accept: V },
        credentials: 'same-origin',
        body: payload,
      });
      const text = await r.text();
      const successes = (text.match(/HTTP\/1\.1 20\d/g) ?? []).length;
      ok += successes;
      const chunkFails = chunk.length - successes;
      fail += chunkFails;
      // 失敗があったら原因 (最初のエラーサブレスポンス) を console に出す。
      // これが無いと「取込完了と出たのに一覧に出ない」時に原因を特定できない。
      if (chunkFails > 0) {
        const errMatch = text.match(/HTTP\/1\.1 [45]\d\d[\s\S]{0,600}?("message"[\s\S]{0,300}?\})/);
        // eslint-disable-next-line no-console
        console.error(`[mikke] $batch: ${chunkFails} 件失敗 (chunk ${i / BATCH_CHUNK + 1})`,
          errMatch ? errMatch[0].slice(0, 500) : text.slice(0, 500));
      }
      onProgress?.(Math.min(i + chunk.length, ops.length), ops.length);
    }
    return { ok, fail };
  }

  /** 取込確定用: ManagedIssue の create/update を $batch 行データに変換するヘルパ。 */
  rowForBatch(patch: Partial<ManagedIssue>): Record<string, unknown> {
    return this.issueToRow(patch);
  }

  /** 取込計画の ops を $batch で一括適用。add=POST / update・undetect=MERGE。 */
  async applyImportOps(
    ops: ImportOp[],
    onProgress?: (done: number, total: number) => void,
  ): Promise<{ ok: number; fail: number }> {
    // 実在列と突合し、無い列だけ除外して送る (行ごと 400 を防ぐ)。列は全て固定
    // ASCII 名なので変換は不要。
    const existing = await this.getFieldNames();
    const dropped = new Set<string>();
    const batchOps: { kind: 'add' | 'update'; id?: number; row: Record<string, unknown> }[] = [];
    for (const op of ops) {
      if (op.kind === 'add' && op.create) {
        batchOps.push({ kind: 'add', row: this.filterExisting(this.issueToRow(op.create), existing, dropped) });
      } else if ((op.kind === 'update' || op.kind === 'undetect') && op.id != null && op.patch) {
        batchOps.push({ kind: 'update', id: op.id, row: this.filterExisting(this.issueToRow(op.patch), existing, dropped) });
      }
      // skip は何もしない
    }
    if (dropped.size) {
      console.warn('[mikke] 取込: リストに存在しない列を送信から除外しました (行は固定項目のみで登録されます):', [...dropped]);
    }
    if (batchOps.length === 0) return { ok: 0, fail: 0 };
    return this.batchWrite(batchOps, onProgress);
  }

  // ── Settings ──────────────────────────────────────────────────────────────
  async getSettings(): Promise<MikkeSettings> {
    const def: MikkeSettings = { managedColumns: [], matchConditions: null, individualIds: [] };
    try {
      const j = await this.spGet(`/_api/web/lists/getbytitle('${LIST_SETTINGS}')/items?$top=1`);
      const row = j.d.results[0];
      if (row?.SettingsJson) return { ...def, ...JSON.parse(row.SettingsJson) };
    } catch { /* noop */ }
    return def;
  }

  /** 別サイトの設定を読む (同一テナント内)。 */
  async getSettingsAt(siteUrl: string): Promise<MikkeSettings> {
    return new SpRepository(siteUrl).getSettings();
  }

  /** 別サイトへ設定を書く (同一テナント内)。 */
  async saveSettingsAt(siteUrl: string, s: MikkeSettings): Promise<void> {
    await new SpRepository(siteUrl).saveSettings(s);
  }

  /** 別サイトの SharePoint グループ一覧 (グループ名 → ID の引き直しに使う)。 */
  async listSiteGroupsAt(siteUrl: string): Promise<{ id: number; title: string }[]> {
    return new SpRepository(siteUrl).listSiteGroups();
  }

  async saveSettings(s: MikkeSettings): Promise<void> {
    const json = JSON.stringify(s);
    const j = await this.spGet(`/_api/web/lists/getbytitle('${LIST_SETTINGS}')/items?$top=1&$select=Id`);
    const row = j.d.results[0];
    const meta = { __metadata: { type: 'SP.Data.MikkeSettingsListItem' }, Title: 'settings', SettingsJson: json };
    if (row?.Id) {
      await this.spPost(
        `/_api/web/lists/getbytitle('${LIST_SETTINGS}')/items(${row.Id})`,
        meta, { 'X-HTTP-Method': 'MERGE', 'IF-MATCH': '*' },
      );
    } else {
      await this.spPost(`/_api/web/lists/getbytitle('${LIST_SETTINGS}')/items`, meta);
    }
  }

  async getCurrentUser(): Promise<SiteUser | null> {
    try {
      const j = await this.spGet(`/_api/web/currentuser?$select=Title,Email`);
      return { displayName: j.d.Title ?? '', email: j.d.Email ?? '' };
    } catch { return null; }
  }

  /** 検査ツール由来の項目は個別列を作らず ScanData(JSON) に集約するため、
   *  ここでは集約列 ScanData の存在だけを保証する (per-field 列は作らない)。
   *  ★ 個別列方式は SP の列数上限 (複数行テキスト約192列) と行サイズ上限に
   *    抵触し、259 列 CSV で列作成が HTTP 500 になっていた。 */
  async ensureScanColumns(_columns: string[]): Promise<void> {
    await this.ensureFields(LIST_MANAGED, [{ name: 'ScanData', type: 'Note' }]);
  }

  /** 取込 ops が書き込む列のうち、リストに存在しないもの (SP 列名) を返す。 */
  async findMissingColumns(ops: ImportOp[]): Promise<string[]> {
    const keys = new Set<string>();
    for (const op of ops) {
      const row = op.kind === 'add' && op.create
        ? this.issueToRow(op.create)
        : ((op.kind === 'update' || op.kind === 'undetect') && op.patch ? this.issueToRow(op.patch) : null);
      if (row) for (const k of Object.keys(row)) keys.add(k);
    }
    this.fieldNamesCache = null;   // 最新の実在列で判定する
    const existing = await this.getFieldNames();
    return [...keys].filter((k) => !existing.has(k));
  }

  /** 不足列を作成する。固定列は既定スキーマ、それ以外 (Scan_*) は Note で作る。 */
  async createMissingColumns(cols: string[]): Promise<void> {
    if (!cols.length) return;
    const fixed = new Map(managedIssueFieldSpecs().map((s) => [s.name, s]));
    const specs: FieldSpec[] = cols.map((c) => fixed.get(c) ?? { name: c, type: 'Note' });
    await this.ensureFields(LIST_MANAGED, specs);   // 終了時に実在列キャッシュは無効化される
  }

  // ── 資産 (FQDN/IP) 管理 — MikkeAssets ──────────────────────────────────────
  // ── 海外脆弱性一覧 ────────────────────────────────────────────────────────
  private overseasRow(p: Partial<OverseasIssue>): Record<string, unknown> {
    const row: Record<string, unknown> = {};
    if (p.issueInstanceId !== undefined) row.IssueInstanceId = p.issueInstanceId;
    if (p.contactedAt !== undefined) row.ContactedAt = p.contactedAt || null;
    // Choice 列は空文字を受け付けないので、未設定は null で送る。
    if (p.openStatus !== undefined) row.OpenStatus = p.openStatus || null;
    if (p.detectionStatus !== undefined) row.DetectionStatus = p.detectionStatus;
    if (p.region !== undefined) row.Region = p.region || null;
    if (p.title !== undefined) row.VulnTitle = p.title;
    if (p.businessCompany !== undefined) row.BusinessCompany = p.businessCompany;
    if (p.affiliateCompany !== undefined) row.AffiliateCompany = p.affiliateCompany;
    if (p.webMapsId !== undefined) row.WebMapsId = p.webMapsId;
    if (p.identifyEvidence !== undefined) row.IdentifyEvidence = p.identifyEvidence;
    if (p.assetIp !== undefined) row.AssetIp = p.assetIp;
    if (p.assetFqdn !== undefined) row.AssetFqdn = p.assetFqdn;
    if (p.assetTitle !== undefined) row.AssetTitle = p.assetTitle;
    if (p.assetMappedDomains !== undefined) row.AssetMappedDomains = p.assetMappedDomains;
    if (p.assetHomepageUrl !== undefined) row.AssetHomepageUrl = p.assetHomepageUrl;
    if (p.lastSeen !== undefined) row.LastSeen = p.lastSeen || null;
    if (p.remarks !== undefined) row.Remarks = p.remarks;
    if (p.importedAt !== undefined) row.ImportedAt = p.importedAt || null;
    return row;
  }

  async listOverseasIssues(): Promise<OverseasIssue[]> {
    const out: OverseasIssue[] = [];
    let url: string | null = `/_api/web/lists/getbytitle('${LIST_OVERSEAS}')/items?$top=5000`;
    try {
      while (url) {
        const j: any = await this.spGet(url);
        for (const r of j.d.results as any[]) {
          out.push({
            id: r.Id,
            issueInstanceId: r.IssueInstanceId ?? '',
            contactedAt: r.ContactedAt ?? undefined,
            openStatus: r.OpenStatus ?? undefined,
            detectionStatus: r.DetectionStatus ?? '新規',
            region: r.Region ?? undefined,
            title: r.VulnTitle ?? undefined,
            businessCompany: r.BusinessCompany ?? undefined,
            affiliateCompany: r.AffiliateCompany ?? undefined,
            webMapsId: r.WebMapsId ?? undefined,
            identifyEvidence: r.IdentifyEvidence ?? undefined,
            assetIp: r.AssetIp ?? undefined,
            assetFqdn: r.AssetFqdn ?? undefined,
            assetTitle: r.AssetTitle ?? undefined,
            assetMappedDomains: r.AssetMappedDomains ?? undefined,
            assetHomepageUrl: r.AssetHomepageUrl ?? undefined,
            lastSeen: r.LastSeen ?? undefined,
            remarks: r.Remarks ?? undefined,
            importedAt: r.ImportedAt ?? undefined,
          });
        }
        url = j.d.__next ? j.d.__next.replace(this.webUrl, '') : null;
      }
    } catch { return out; }   // 未作成 (404) 等
    return out;
  }

  /** ★ 1 件ずつ POST すると件数ぶん往復して遅い。$batch で 100 件ずつまとめる。 */
  async applyOverseasPlan(
    creates: Omit<OverseasIssue, 'id'>[],
    updates: { id: number; patch: Partial<OverseasIssue> }[],
    onProgress?: (done: number, total: number) => void,
  ): Promise<{ ok: number; fail: number }> {
    const ops = [
      ...creates.map((c) => ({ kind: 'add' as const, row: this.overseasRow(c) })),
      ...updates.map((u) => ({ kind: 'update' as const, id: u.id, row: this.overseasRow(u.patch) })),
    ];
    if (!ops.length) return { ok: 0, fail: 0 };
    return this.batchWrite(ops, onProgress, LIST_OVERSEAS);
  }

  async deleteAllOverseasIssues(onProgress?: (done: number, total: number) => void): Promise<{ ok: number; fail: number }> {
    const rows = await this.listOverseasIssues();
    if (!rows.length) return { ok: 0, fail: 0 };
    const ids = rows.map((r) => r.id).sort((a, b) => b - a);
    return this.batchWrite(ids.map((id) => ({ kind: 'delete' as const, id, row: {} })),
      onProgress, LIST_OVERSEAS);
  }

  // ── 海外連携用リスト (読み取り専用・逆取り込みなし) ───────────────────────

  /** 書き込む行を組み立てる。列名の対応は overseasResponseSync.ts に一本化。 */
  private overseasResponseRow(f: Partial<OverseasResponseFields>): Record<string, unknown> {
    const row: Record<string, unknown> = {};
    for (const [key, col] of
      Object.entries(OVERSEAS_RESPONSE_COLUMN) as [keyof OverseasResponseFields, string][]) {
      const v = f[key];
      if (v === undefined) continue;
      // 日付は空文字だと SP が 400 を返すので null を送る。
      row[col] = OVERSEAS_RESPONSE_DATE_FIELDS.includes(key) ? (v || null) : v;
    }
    return row;
  }

  async listOverseasResponseRows(): Promise<OverseasResponseRow[]> {
    const out: OverseasResponseRow[] = [];
    const cols = Object.values(OVERSEAS_RESPONSE_COLUMN).join(',');
    let url: string | null =
      `/_api/web/lists/getbytitle('${LIST_OVERSEAS_RESPONSE}')/items?$select=Id,${cols}&$top=5000`;
    try {
      while (url) {
        const j: any = await this.spGet(url);
        for (const r of j.d.results as any[]) {
          const row = { id: r.Id } as OverseasResponseRow;
          for (const [key, col] of
            Object.entries(OVERSEAS_RESPONSE_COLUMN) as [keyof OverseasResponseFields, string][]) {
            row[key] = r[col] ?? '';
          }
          out.push(row);
        }
        url = j.d.__next ? j.d.__next.replace(this.webUrl, '') : null;
      }
    } catch { return out; }   // 未作成 (404) 等
    return out;
  }

  async findMissingOverseasResponseColumns(): Promise<string[]> {
    this.fieldNamesByList.delete(LIST_OVERSEAS_RESPONSE);   // 最新の実在列で判定する
    let existing: Set<string>;
    try { existing = await this.getFieldNamesOf(LIST_OVERSEAS_RESPONSE); }
    catch { return []; }        // リスト自体が無い場合は呼び出し側の別導線に任せる
    return Object.values(OVERSEAS_RESPONSE_COLUMN).filter((k) => !existing.has(k));
  }

  async applyOverseasResponseWrites(
    creates: OverseasResponseFields[],
    updates: { id: number; fields: Partial<OverseasResponseFields> }[],
    deletes: number[],
    onProgress?: (done: number, total: number) => void,
  ): Promise<{ ok: number; fail: number }> {
    const existing = await this.getFieldNamesOf(LIST_OVERSEAS_RESPONSE);
    const dropped = new Set<string>();
    const pick = (f: Partial<OverseasResponseFields>): Record<string, unknown> =>
      this.filterExisting(this.overseasResponseRow(f), existing, dropped);
    const ops = [
      ...deletes.map((id) => ({ kind: 'delete' as const, id, row: {} })),
      ...creates.map((c) => ({ kind: 'add' as const, row: pick(c) })),
      ...updates.map((u) => ({ kind: 'update' as const, id: u.id, row: pick(u.fields) })),
    ];
    if (dropped.size) console.warn('[mikke] 海外連携用リストに存在しない列を除外:', [...dropped]);
    if (!ops.length) return { ok: 0, fail: 0 };
    return this.batchWrite(ops, onProgress, LIST_OVERSEAS_RESPONSE);
  }

  async listOverseasResponsePermTargets():
    Promise<{ id: number; businessCompany: string; hasUniquePerms: boolean }[]> {
    const out: { id: number; businessCompany: string; hasUniquePerms: boolean }[] = [];
    let url: string | null =
      `/_api/web/lists/getbytitle('${LIST_OVERSEAS_RESPONSE}')/items`
      + '?$select=Id,BusinessCompany,HasUniqueRoleAssignments&$top=5000';
    while (url) {
      const j: any = await this.spGet(url);
      for (const r of j.d.results as
        { Id: number; BusinessCompany?: string; HasUniqueRoleAssignments?: boolean }[]) {
        out.push({
          id: r.Id, businessCompany: r.BusinessCompany ?? '',
          hasUniquePerms: !!r.HasUniqueRoleAssignments,
        });
      }
      url = j.d.__next ? j.d.__next.replace(this.webUrl, '') : null;
    }
    return out;
  }

  /** ★ 事業会社グループには **参照** を付ける (国内は投稿)。
   *  海外連携用リストは読み取り専用で、記入してもらう欄が無いため。 */
  async applyOverseasResponseItemPerms(
    targets: { id: number; businessCompany: string }[],
    onProgress?: (done: number, total: number) => void,
  ): Promise<{ applied: number; adminOnly: number; errors: string[] }> {
    return this.applyItemPermsOn(LIST_OVERSEAS_RESPONSE, targets, onProgress, 'read');
  }

  async overseasResponseListUrl(): Promise<string | null> {
    return this.listViewUrl(LIST_OVERSEAS_RESPONSE);
  }

  /** 海外連携用リストを構築する (冪等)。
   *  ★ 記入欄が無いので条件付き数式 (HIDDEN_UNLESS_NEW) を全列に付ける。
   *    これでフォーム本体には何も出ず、ヘッダーのカードだけが見える。 */
  async ensureOverseasResponseList(): Promise<SetupResult> {
    const rep = new StepReporter();
    const fields = overseasResponseFieldSpecs();
    await this.ensureList(LIST_OVERSEAS_RESPONSE, fields, rep);
    const map = await this.loadFieldMap(LIST_OVERSEAS_RESPONSE);
    await this.applySchemaXmlAttributes(LIST_OVERSEAS_RESPONSE, fields, map, rep);
    await this.applyRequired(LIST_OVERSEAS_RESPONSE, fields, map, rep);
    await this.applyDisplayNames(LIST_OVERSEAS_RESPONSE, fields, map, rep);
    await this.ensureViewFields(LIST_OVERSEAS_RESPONSE, OVERSEAS_RESPONSE_VIEW_FIELDS, rep);
    await this.applyFieldOrder(LIST_OVERSEAS_RESPONSE, fields, rep);
    await this.applyFormFormatter(LIST_OVERSEAS_RESPONSE, buildOverseasResponseFormFormatter(), rep);
    await this.applyConditionalFormulas(LIST_OVERSEAS_RESPONSE, fields, map, rep);
    this.fieldNamesByList.delete(LIST_OVERSEAS_RESPONSE);
    const listUrl = await this.listViewUrl(LIST_OVERSEAS_RESPONSE);
    return rep.result(listUrl ?? `${this.webUrl}/Lists/${LIST_OVERSEAS_RESPONSE}/AllItems.aspx`);
  }

  async listAssets(): Promise<ManagedAsset[]> {
    const out: ManagedAsset[] = [];
    let url: string | null =
      `/_api/web/lists/getbytitle('${LIST_ASSETS}')/items?$top=5000`;
    while (url) {
      const j: any = await this.spGet(url);
      for (const row of j.d.results) out.push(this.rowToAsset(row));
      url = j.d.__next ? j.d.__next.replace(this.webUrl, '') : null;
    }
    return out;
  }

  async createAsset(asset: Omit<ManagedAsset, 'id'>): Promise<number> {
    const r = await this.spPost(
      `/_api/web/lists/getbytitle('${LIST_ASSETS}')/items`,
      { __metadata: { type: 'SP.Data.MikkeAssetsListItem' }, ...this.assetToRow(asset) },
    );
    const j = await r.json();
    return j.d.Id as number;
  }

  async updateAsset(id: number, patch: Partial<ManagedAsset>): Promise<void> {
    await this.spPost(
      `/_api/web/lists/getbytitle('${LIST_ASSETS}')/items(${id})`,
      { __metadata: { type: 'SP.Data.MikkeAssetsListItem' }, ...this.assetToRow(patch) },
      { 'X-HTTP-Method': 'MERGE', 'IF-MATCH': '*' },
    );
  }

  async deleteAsset(id: number): Promise<void> {
    await this.spPost(
      `/_api/web/lists/getbytitle('${LIST_ASSETS}')/items(${id})`,
      undefined, { 'X-HTTP-Method': 'DELETE', 'IF-MATCH': '*' },
    );
  }

  /** 資産の 特定根拠 / 備考 に貼り付けた画像を MikkeAssets の添付ファイルとして
   *  アップロードし、絶対 URL を返す (base64 インライン肥大化を避ける)。 */
  async uploadAssetImage(assetId: number, file: File): Promise<{ url: string }> {
    const digest = await this.getDigest();
    const name = file.name.replace(/[^\w.\-]/g, '_');
    const buf = await file.arrayBuffer();
    const r = await fetch(
      `${this.webUrl}/_api/web/lists/getbytitle('${LIST_ASSETS}')`
      + `/items(${assetId})/AttachmentFiles/add(FileName='${encodeURIComponent(name)}')`,
      {
        method: 'POST',
        headers: { Accept: V, 'X-RequestDigest': digest },
        credentials: 'same-origin',
        body: buf,
      },
    );
    if (!r.ok) throw new Error(`attachment add: HTTP ${r.status}`);
    const j = await r.json();
    const rel: string = j.d?.ServerRelativeUrl ?? '';
    return { url: rel ? location.origin + rel : '' };
  }

  // ── ダウンロードデータ — MikkeDownloads + ドキュメントライブラリ ─────────────
  async listDownloads(): Promise<DownloadRecord[]> {
    const out: DownloadRecord[] = [];
    let url: string | null =
      `/_api/web/lists/getbytitle('${LIST_DOWNLOADS}')/items?$top=5000&$orderby=DownloadedAt desc`;
    while (url) {
      const j: any = await this.spGet(url);
      for (const row of j.d.results) out.push(this.rowToDownload(row));
      url = j.d.__next ? j.d.__next.replace(this.webUrl, '') : null;
    }
    return out;
  }

  async createDownload(rec: Omit<DownloadRecord, 'id'>): Promise<number> {
    const type = await this.listEntityType(LIST_DOWNLOADS);
    const r = await this.spPost(
      `/_api/web/lists/getbytitle('${LIST_DOWNLOADS}')/items`,
      { __metadata: { type }, ...this.downloadToRow(rec) },
    );
    const j = await r.json();
    return j.d.Id as number;
  }

  async deleteDownload(id: number): Promise<void> {
    await this.spPost(
      `/_api/web/lists/getbytitle('${LIST_DOWNLOADS}')/items(${id})`,
      undefined, { 'X-HTTP-Method': 'DELETE', 'IF-MATCH': '*' },
    );
  }

  /** OData の GetFolderByServerRelativeUrl('...') 等に渡すサーバ相対 URL 引数。
   *  パス区切り '/' は保持し (SP がパスとして解決できるように)、各セグメントのみ
   *  URL エンコード。OData 文字列リテラルの単一引用符は '' に二重化する。
   *  ※ パス全体を encodeURIComponent すると '/' が %2F になり SP がフォルダを
   *    解決できず 404 になる (ダウンロード保存が失敗する原因)。 */
  private srUrlArg(serverRel: string): string {
    return serverRel.split('/').map((s) => encodeURIComponent(s)).join('/').replace(/'/g, "''");
  }

  /** サイト相対フォルダを 1 階層ずつ ensure しながら掘る (無ければ作成)。 */
  private async ensureFolderPath(siteRelFolder: string): Promise<string> {
    const webRel = new URL(this.webUrl).pathname.replace(/\/$/, ''); // 例: /sites/xxx
    let cur = webRel;
    for (const seg of siteRelFolder.split('/').map((s) => s.trim()).filter(Boolean)) {
      cur = `${cur}/${seg}`;
      let exists = false;
      try {
        const j: any = await this.spGet(`/_api/web/GetFolderByServerRelativeUrl('${this.srUrlArg(cur)}')?$select=Exists`);
        exists = j?.d?.Exists === true;
      } catch { exists = false; }
      if (exists) continue;
      try {
        await this.spPost(`/_api/web/folders`, { __metadata: { type: 'SP.Folder' }, ServerRelativeUrl: cur });
      } catch {
        // 作成失敗 = 既存 / 予約フォルダ (ライブラリ直下) 等の可能性。ここでは致命にしない。
        // 本当に無ければ後続の Files/add が明確なエラーを返す。
      }
    }
    return cur; // サーバ相対の最終フォルダ
  }

  async uploadDownloadFile(folder: string, fileName: string, data: Blob): Promise<{ url: string }> {
    const serverRelFolder = await this.ensureFolderPath(folder);
    const digest = await this.getDigest();
    const buf = await data.arrayBuffer();
    const addUrl =
      `/_api/web/GetFolderByServerRelativeUrl('${this.srUrlArg(serverRelFolder)}')`
      + `/Files/add(overwrite=true,url='${encodeURIComponent(fileName)}')`;
    const r = await fetch(`${this.webUrl}${addUrl}`, {
      method: 'POST',
      headers: { Accept: V, 'X-RequestDigest': digest },
      credentials: 'same-origin',
      body: buf,
    });
    if (!r.ok) throw new Error(`ファイル保存に失敗 (${serverRelFolder}/${fileName}): HTTP ${r.status} ${await spErrorText(r)}`);
    const j = await r.json();
    const rel: string = j.d?.ServerRelativeUrl ?? `${serverRelFolder}/${fileName}`;
    return { url: rel };
  }

  /**
   * 連携用リストの該当アイテムに個別レポートを添付する (常に最新 1 つ)。
   *
   * ★ 添付ファイル名はアイテム内で一意。同名を add すると HTTP 400 になるので
   *   先に消す (実機で確認: 削除なし=400 / 削除→再add=200)。
   * ★ 検査ツールのファイル名には日付が入る = 再取得のたびに別名になるため、同名を
   *   消すだけでは古い添付が積み上がる。前回添付した名前 (previousFileName) も消す。
   * ★ アイテムの添付を全消しはしない。資産管理者が付けた証跡ファイルまで消えるため。
   * ★ 資産管理者が SharePoint 上でそのまま開けるよう、ドキュメントライブラリ保存とは
   *   別に「アイテムの添付」としても持たせている (リンク切れ・権限差を避ける)。
   */
  async attachVulnResponseFile(
    issueInstanceId: string, fileName: string, data: Blob, previousFileName?: string,
  ): Promise<'attached' | 'no-item'> {
    const listPath = `/_api/web/lists/getbytitle('${LIST_VULNRESPONSE}')`;
    // 突合キーは組込みの Title 列。
    const q = `${listPath}/items?$select=Id&$filter=Title eq '${issueInstanceId.replace(/'/g, "''")}'&$top=1`;
    const found = await this.spGet(q);
    const itemId: number | undefined = found.d?.results?.[0]?.Id;
    if (!itemId) return 'no-item';

    const safe = (n: string): string => n.replace(/[^\w.\-]/g, '_');
    const name = safe(fileName);
    const itemPath = `${listPath}/items(${itemId})`;
    // 今回と同名 + 前回の名前を消してから追加する (無ければ 400/404 → 無視)。
    for (const old of new Set([name, previousFileName ? safe(previousFileName) : ''].filter(Boolean))) {
      try {
        await this.spPost(`${itemPath}/AttachmentFiles/getByFileName('${encodeURIComponent(old)}')`,
          undefined, { 'X-HTTP-Method': 'DELETE', 'IF-MATCH': '*' });
      } catch { /* 未添付なら何もしなくてよい */ }
    }

    const digest = await this.getDigest();
    const buf = await data.arrayBuffer();
    const r = await fetch(
      `${this.webUrl}${itemPath}/AttachmentFiles/add(FileName='${encodeURIComponent(name)}')`,
      {
        method: 'POST',
        headers: { Accept: V, 'X-RequestDigest': digest },
        credentials: 'same-origin',
        body: buf,
      },
    );
    if (!r.ok) throw new Error(`添付に失敗 (${name}): HTTP ${r.status} ${await spErrorText(r)}`);
    return 'attached';
  }

  async deleteDocFile(serverRelativeUrl: string): Promise<void> {
    await this.spPost(
      `/_api/web/GetFileByServerRelativeUrl('${this.srUrlArg(serverRelativeUrl)}')`,
      undefined, { 'X-HTTP-Method': 'DELETE', 'IF-MATCH': '*' },
    );
  }

  async docFileHref(serverRelativeUrl: string): Promise<string> {
    // サーバ相対 URL を同一オリジンの絶対 URL に。空白等はパス単位でエンコード。
    return location.origin + serverRelativeUrl.split('/').map((s) => encodeURIComponent(s)).join('/');
  }

  private rowToDownload(row: any): DownloadRecord {
    return {
      id: row.Id,
      type: (row.DlType ?? 'vuln') as DownloadType,
      downloadedAt: row.DownloadedAt ?? '',
      scannerDownloadTime: row.ScannerDownloadTime ?? undefined,
      fileName: row.FileName ?? '',
      folder: row.FolderPath ?? '',
      fileUrl: row.FileUrl ?? '',
      itemCount: typeof row.ItemCount === 'number' ? row.ItemCount : undefined,
    };
  }

  private downloadToRow(p: Partial<DownloadRecord>): Record<string, unknown> {
    const row: Record<string, unknown> = {};
    if (p.type !== undefined) { row.Title = p.fileName ?? p.type; row.DlType = p.type; }
    if (p.downloadedAt !== undefined) row.DownloadedAt = p.downloadedAt || null;
    if (p.scannerDownloadTime !== undefined) row.ScannerDownloadTime = p.scannerDownloadTime;
    if (p.fileName !== undefined) row.FileName = p.fileName;
    if (p.folder !== undefined) row.FolderPath = p.folder;
    if (p.fileUrl !== undefined) row.FileUrl = p.fileUrl;
    if (p.itemCount !== undefined) row.ItemCount = p.itemCount;
    return row;
  }

  // ── 対応履歴 — MikkeHistory ────────────────────────────────────────────────
  async listHistory(issueInstanceId: string): Promise<ResponseHistory[]> {
    const q = `IssueInstanceId eq '${issueInstanceId.replace(/'/g, "''")}'`;
    const out: ResponseHistory[] = [];
    let url: string | null =
      `/_api/web/lists/getbytitle('${LIST_HISTORY}')/items?$top=2000&$filter=${encodeURIComponent(q)}`;
    while (url) {
      const j: any = await this.spGet(url);
      for (const row of j.d.results) out.push(this.rowToHistory(row));
      url = j.d.__next ? j.d.__next.replace(this.webUrl, '') : null;
    }
    return out;
  }
  async createHistory(entry: Omit<ResponseHistory, 'id'>): Promise<number> {
    const r = await this.spPost(
      `/_api/web/lists/getbytitle('${LIST_HISTORY}')/items`,
      { __metadata: { type: 'SP.Data.MikkeHistoryListItem' }, ...this.historyToRow(entry) },
    );
    const j = await r.json();
    return j.d.Id as number;
  }
  async deleteHistory(id: number): Promise<void> {
    await this.spPost(
      `/_api/web/lists/getbytitle('${LIST_HISTORY}')/items(${id})`,
      undefined, { 'X-HTTP-Method': 'DELETE', 'IF-MATCH': '*' },
    );
  }

  // ── 更新履歴 — MikkeChangeLog ──────────────────────────────────────────────
  async listChangeLog(issueInstanceId: string): Promise<ChangeLogEntry[]> {
    const q = `IssueInstanceId eq '${issueInstanceId.replace(/'/g, "''")}'`;
    const out: ChangeLogEntry[] = [];
    let url: string | null =
      `/_api/web/lists/getbytitle('${LIST_CHANGELOG}')/items?$top=2000&$filter=${encodeURIComponent(q)}`;
    while (url) {
      const j: any = await this.spGet(url);
      for (const row of j.d.results) out.push(this.rowToChangeLog(row));
      url = j.d.__next ? j.d.__next.replace(this.webUrl, '') : null;
    }
    return out;
  }
  async createChangeLog(entry: Omit<ChangeLogEntry, 'id'>): Promise<number> {
    const r = await this.spPost(
      `/_api/web/lists/getbytitle('${LIST_CHANGELOG}')/items`,
      {
        __metadata: { type: 'SP.Data.MikkeChangeLogListItem' },
        IssueInstanceId: entry.issueInstanceId,
        ChangedAt: entry.changedAt || null,
        ChangesJson: JSON.stringify(entry.changes ?? []),
      },
    );
    const j = await r.json();
    return j.d.Id as number;
  }
  async deleteChangeLog(id: number): Promise<void> {
    await this.spPost(
      `/_api/web/lists/getbytitle('${LIST_CHANGELOG}')/items(${id})`,
      undefined, { 'X-HTTP-Method': 'DELETE', 'IF-MATCH': '*' },
    );
  }
  async clearChangeLog(issueInstanceId: string): Promise<void> {
    const items = await this.listChangeLog(issueInstanceId);
    for (const c of items) { try { await this.deleteChangeLog(c.id); } catch { /* 個別失敗はスキップ */ } }
  }
  private rowToChangeLog(row: any): ChangeLogEntry {
    let changes: ChangeLogEntry['changes'] = [];
    try { const j = JSON.parse(row.ChangesJson || '[]'); if (Array.isArray(j)) changes = j; } catch { /* noop */ }
    return {
      id: row.Id,
      issueInstanceId: row.IssueInstanceId ?? '',
      changedAt: row.ChangedAt ?? row.Created ?? '',
      changedBy: row.Author?.Title ?? undefined,
      changes,
    };
  }
  private rowToHistory(row: any): ResponseHistory {
    return {
      id: row.Id,
      issueInstanceId: row.IssueInstanceId ?? '',
      thread: row.Thread === 'internal' ? 'internal' : 'external',
      source: (['mail', 'manual', 'other'].includes(row.Source) ? row.Source : 'other'),
      author: row.AuthorName ?? undefined,
      fromEmail: row.FromEmail ?? undefined,
      subject: row.Subject ?? undefined,
      body: row.Body ?? '',
      isHtml: !!row.IsHtml,
      occurredAt: row.OccurredAt ?? row.Created ?? '',
      createdAt: row.Created ?? undefined,
      createdBy: row.Author?.Title ?? undefined,
    };
  }
  private historyToRow(p: Partial<ResponseHistory>): Record<string, unknown> {
    const row: Record<string, unknown> = {};
    if (p.issueInstanceId !== undefined) row.IssueInstanceId = p.issueInstanceId;
    if (p.thread !== undefined) row.Thread = p.thread;
    if (p.source !== undefined) row.Source = p.source;
    if (p.author !== undefined) row.AuthorName = p.author;
    if (p.fromEmail !== undefined) row.FromEmail = p.fromEmail;
    if (p.subject !== undefined) row.Subject = p.subject;
    if (p.body !== undefined) row.Body = p.body;
    if (p.isHtml !== undefined) row.IsHtml = p.isHtml;
    if (p.occurredAt !== undefined) row.OccurredAt = p.occurredAt || null;
    return row;
  }

  private rowToAsset(row: any): ManagedAsset {
    return {
      id: row.Id,
      assetKey: row.AssetKey ?? row.Title ?? '',
      assetType: (row.AssetType === 'IP' ? 'IP' : 'FQDN'),
      businessCompany: row.BusinessCompany ?? undefined,
      affiliateCompany: row.AffiliateCompany ?? undefined,
      mgmtNumber: row.MgmtNumber ?? undefined,
      // 旧 IdentifyReason は 特定根拠 に統合。旧データがあれば根拠の頭に畳み込む。
      identifyEvidence: mergeLegacyEvidence(row.IdentifyReason, row.IdentifyEvidence),
      remarks: row.Remarks ?? undefined,
      updatedAt: row.UpdatedAt ?? undefined,
    };
  }

  private assetToRow(p: Partial<ManagedAsset>): Record<string, unknown> {
    const row: Record<string, unknown> = {};
    if (p.assetKey !== undefined) { row.Title = p.assetKey; row.AssetKey = p.assetKey; }
    if (p.assetType !== undefined) row.AssetType = p.assetType;
    if (p.businessCompany !== undefined) row.BusinessCompany = p.businessCompany;
    if (p.affiliateCompany !== undefined) row.AffiliateCompany = p.affiliateCompany;
    if (p.mgmtNumber !== undefined) row.MgmtNumber = p.mgmtNumber;
    if (p.identifyEvidence !== undefined) row.IdentifyEvidence = p.identifyEvidence;
    if (p.remarks !== undefined) row.Remarks = p.remarks;
    // DateTime 列は空文字だと SP が 400 → クリアは null で送る
    if (p.updatedAt !== undefined) row.UpdatedAt = p.updatedAt || null;
    return row;
  }

  /** 取込履歴を MikkeImportLog に記録。 */
  async writeImportLog(entry: ImportLogEntry): Promise<void> {
    await this.spPost(
      `/_api/web/lists/getbytitle('${LIST_IMPORTLOG}')/items`,
      {
        __metadata: { type: 'SP.Data.MikkeImportLogListItem' },
        Title: `取込 ${entry.importedAt}`,
        ImportedAt: entry.importedAt,
        FileName: entry.fileName,
        Operator: entry.operator,
        AddedCount: entry.added,
        UpdatedCount: entry.updated,
        UndetectedCount: entry.undetected,
        SkippedCount: entry.skipped,
        RowCount: entry.rowCount,
      },
    );
  }

  // ── row ↔ entity ──────────────────────────────────────────────────────────
  private rowToIssue(row: any): ManagedIssue {
    // 検査ツール由来の全項目は ScanData(JSON) から復元する。
    const scanFields = unpackScanData(row.ScanData);
    return {
      id: row.Id,
      title: row.Title ?? '',
      issueInstanceId: row.IssueInstanceId ?? '',
      detectionStatus: (row.DetectionStatus ?? '新規') as DetectionStatus,
      // 旧値 ('未通知' / '通知') は '未着手' に畳む (選択肢から外したため)。
      mgmtStatus: normalizeMgmtStatus(row.MgmtStatus),
      isOutOfScope: !!row.IsOutOfScope,
      outOfScopeReason: row.OutOfScopeReason ?? undefined,
      assignee: row.Assignee ?? undefined,
      extConnAppId: row.ExtConnAppId ?? undefined,
      legacyMgmtNumber: row.LegacyMgmtNumber ?? undefined,
      businessCompany: row.BusinessCompany ?? undefined,
      affiliateCompany: row.AffiliateCompany ?? undefined,
      webMapsId: row.WebMapsId ?? undefined,
      identifyEvidence: row.IdentifyEvidence ?? undefined,
      responsePlan: row.ResponsePlan ?? undefined,
      noAppReason: row.NoAppReason ?? undefined,
      vulnType: row.VulnType ?? undefined,
      dueDate: row.DueDate ?? undefined,
      mgmtNote: row.MgmtNote ?? undefined,
      scannerStatus: row.ScannerStatus ?? undefined,
      severity: row.Severity ?? undefined,
      firstSeen: row.FirstSeen ?? undefined,
      lastSeen: row.LastSeen ?? undefined,
      firstUndetectedAt: row.FirstUndetectedAt ?? undefined,
      addedReason: (row.AddedReason ?? undefined) as AddedReason | undefined,
      lastSyncedAt: row.LastSyncedAt ?? undefined,
      reportUrl: row.ReportUrl ?? undefined,
      reportName: row.ReportName ?? undefined,
      reportAt: row.ReportAt ?? undefined,
      // SP の組み込み列。連携用リストとの新旧比較に使う (書き込みはしない)。
      updatedAt: row.Modified ?? undefined,
      responseRemarks: row.ResponseRemarks ?? undefined,
      responsePushedAt: row.ResponsePushedAt ?? undefined,
      responseSyncedAt: row.ResponseSyncedAt ?? undefined,
      scanFields,
    };
  }

  private issueToRow(p: Partial<ManagedIssue>): Record<string, unknown> {
    const row: Record<string, unknown> = {};
    if (p.title !== undefined) row.Title = p.title;
    if (p.issueInstanceId !== undefined) row.IssueInstanceId = p.issueInstanceId;
    if (p.detectionStatus !== undefined) row.DetectionStatus = p.detectionStatus;
    if (p.mgmtStatus !== undefined) row.MgmtStatus = p.mgmtStatus;
    if (p.isOutOfScope !== undefined) row.IsOutOfScope = p.isOutOfScope;
    if (p.outOfScopeReason !== undefined) row.OutOfScopeReason = p.outOfScopeReason;
    if (p.assignee !== undefined) row.Assignee = p.assignee;
    if (p.extConnAppId !== undefined) row.ExtConnAppId = p.extConnAppId;
    if (p.legacyMgmtNumber !== undefined) row.LegacyMgmtNumber = p.legacyMgmtNumber;
    if (p.businessCompany !== undefined) row.BusinessCompany = p.businessCompany;
    if (p.affiliateCompany !== undefined) row.AffiliateCompany = p.affiliateCompany;
    if (p.webMapsId !== undefined) row.WebMapsId = p.webMapsId;
    if (p.identifyEvidence !== undefined) row.IdentifyEvidence = p.identifyEvidence;
    if (p.responsePlan !== undefined) row.ResponsePlan = p.responsePlan;
    if (p.noAppReason !== undefined) row.NoAppReason = p.noAppReason;
    if (p.vulnType !== undefined) row.VulnType = p.vulnType;
    // DateTime 列は空文字 ('') だと SP が HTTP 400。クリアは null で送る。
    if (p.dueDate !== undefined) row.DueDate = p.dueDate || null;
    if (p.mgmtNote !== undefined) row.MgmtNote = p.mgmtNote;
    if (p.scannerStatus !== undefined) row.ScannerStatus = p.scannerStatus;
    if (p.severity !== undefined) row.Severity = p.severity;
    if (p.firstSeen !== undefined) row.FirstSeen = p.firstSeen || null;
    if (p.lastSeen !== undefined) row.LastSeen = p.lastSeen || null;
    if (p.firstUndetectedAt !== undefined) row.FirstUndetectedAt = p.firstUndetectedAt || null;
    if (p.addedReason !== undefined) row.AddedReason = p.addedReason;
    if (p.lastSyncedAt !== undefined) row.LastSyncedAt = p.lastSyncedAt || null;
    if (p.reportUrl !== undefined) row.ReportUrl = p.reportUrl;
    if (p.reportName !== undefined) row.ReportName = p.reportName;
    if (p.reportAt !== undefined) row.ReportAt = p.reportAt || null;
    if (p.responseRemarks !== undefined) row.ResponseRemarks = p.responseRemarks;
    if (p.responsePushedAt !== undefined) row.ResponsePushedAt = p.responsePushedAt || null;
    if (p.responseSyncedAt !== undefined) row.ResponseSyncedAt = p.responseSyncedAt || null;
    // ★ 検査ツール由来の全項目は個別列ではなく ScanData に JSON で集約する
    //   (SP の列数上限/行サイズ上限を回避)。キーは元の "Scan_<元名>" のまま保持し、
    //   表示側 resolveScanValue が raw/安全名/エンコードのいずれでも引ける。
    if (p.scanFields !== undefined) row.ScanData = packScanData(p.scanFields);
    return row;
  }
}
