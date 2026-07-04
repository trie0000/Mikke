// SharePoint REST リポジトリ。同一オリジン Cookie 認証。
// 役割: contextinfo(digest) / list CRUD / ensureLists(ensureFields) /
//       $batch 一括書き込み。
import type { Repository, ImportLogEntry } from './repo';
import type { ManagedIssue, ManagedAsset, ResponseHistory, ChangeLogEntry, MikkeSettings, SiteUser, DetectionStatus, MgmtStatus, AddedReason } from '../types';
import type { ImportOp } from '../lib/import';
import { packScanData, unpackScanData } from '../lib/scanName';
import {
  LIST_MANAGED, LIST_SETTINGS, LIST_IMPORTLOG, LIST_ASSETS, LIST_HISTORY, LIST_CHANGELOG,
  managedIssueFieldSpecs, settingsFieldSpecs, importLogFieldSpecs, assetFieldSpecs, historyFieldSpecs, changeLogFieldSpecs,
  toFieldSchema, spFieldTypeString, type FieldSpec,
} from './sp/schema';
import { getSelectedSiteUrl } from '../utils/spSites';

const V = 'application/json;odata=verbose';

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

  constructor() {
    // 選択済みサイト URL があればそれを、なければ現在ページのサイトを使う。
    this.webUrl = (getSelectedSiteUrl() || this.currentWebUrl()).replace(/\/$/, '');
  }

  private currentWebUrl(): string {
    const ctx = (window as unknown as { _spPageContextInfo?: { webAbsoluteUrl?: string } })._spPageContextInfo;
    if (ctx?.webAbsoluteUrl) return ctx.webAbsoluteUrl;
    // モダン SP ページでは _spPageContextInfo が無いことがある。
    // location.pathname の /sites/<x> or /teams/<x> から web 絶対 URL を組む。
    const m = location.pathname.match(/^(\/(?:sites|teams)\/[^/]+)/i);
    if (m) return location.origin + m[1];
    return location.origin;
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
    const r = await fetch(`${this.webUrl}${path}`, {
      headers: { Accept: V },
      credentials: 'same-origin',
    });
    if (!r.ok) throw new Error(`GET ${path}: HTTP ${r.status}`);
    return r.json();
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
    if (!r.ok) throw new Error(`POST ${path}: HTTP ${r.status}`);
    return r;
  }

  // ── ensureLists / ensureFields ──────────────────────────────────────────
  async ensureLists(): Promise<void> {
    await this.ensureList(LIST_MANAGED, managedIssueFieldSpecs());
    await this.ensureList(LIST_SETTINGS, settingsFieldSpecs());
    await this.ensureList(LIST_IMPORTLOG, importLogFieldSpecs());
    await this.ensureList(LIST_ASSETS, assetFieldSpecs());
    await this.ensureList(LIST_HISTORY, historyFieldSpecs());
    await this.ensureList(LIST_CHANGELOG, changeLogFieldSpecs());
  }

  private async ensureList(title: string, fields: FieldSpec[]): Promise<void> {
    // リスト存在確認 (なければ作成)。
    let exists = true;
    try {
      await this.spGet(`/_api/web/lists/getbytitle('${encodeURIComponent(title)}')?$select=Id`);
    } catch { exists = false; }
    if (!exists) {
      await this.spPost(`/_api/web/lists`, {
        __metadata: { type: 'SP.List' },
        Title: title,
        BaseTemplate: 100, // Generic List
        ContentTypesEnabled: false,
      });
    }
    await this.ensureFields(title, fields);
  }

  private async ensureFields(title: string, fields: FieldSpec[]): Promise<void> {
    const existing = await this.spGet(
      `/_api/web/lists/getbytitle('${encodeURIComponent(title)}')/fields?$select=Title,TypeAsString`,
    );
    const have = new Map<string, string>();
    for (const f of existing.d.results as { Title: string; TypeAsString: string }[]) {
      have.set(f.Title, f.TypeAsString);
    }
    const listPath = `/_api/web/lists/getbytitle('${encodeURIComponent(title)}')`;
    for (const spec of fields) {
      const cur = have.get(spec.name);
      if (cur && cur === spFieldTypeString(spec.type)) {
        if (spec.indexed) await this.tryIndex(listPath, spec.name);
        continue;
      }
      // 型不一致の既存列は DELETE してから再作成。
      if (cur) {
        try {
          await this.spPost(
            `${listPath}/fields/getbytitle('${encodeURIComponent(spec.name)}')`,
            undefined, { 'X-HTTP-Method': 'DELETE', 'IF-MATCH': '*' },
          );
        } catch { /* 削除不可列はスキップ */ }
      }
      try {
        await this.spPost(`${listPath}/fields`, toFieldSchema(spec));
        if (spec.indexed) await this.tryIndex(listPath, spec.name);
      } catch (e) { console.warn(`[mikke] ensureField ${spec.name} failed:`, e); }
    }
    // 列を作った可能性があるので実在列キャッシュを無効化 (次の書込で再取得)。
    this.fieldNamesCache = null;
  }

  // ── 実在列チェック ─────────────────────────────────────────────────────────
  // 列は全て固定 ASCII 名 (IssueInstanceId / ScanData 等) で Title=InternalName の
  // ため変換は不要。書込前に実在列と突合し、無い列だけ除外して行ごと 400 を防ぐ。
  private fieldNamesCache: Set<string> | null = null;

  private async getFieldNames(): Promise<Set<string>> {
    if (this.fieldNamesCache) return this.fieldNamesCache;
    const j = await this.spGet(
      `/_api/web/lists/getbytitle('${LIST_MANAGED}')/fields?$select=InternalName`,
    );
    const set = new Set<string>();
    for (const f of j.d.results as { InternalName: string }[]) set.add(f.InternalName);
    this.fieldNamesCache = set;
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

  private async tryIndex(listPath: string, fieldName: string): Promise<void> {
    try {
      await this.spPost(
        `${listPath}/fields/getbytitle('${encodeURIComponent(fieldName)}')`,
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
    ops: { kind: 'add' | 'update'; id?: number; row: Record<string, unknown> }[],
    onProgress?: (done: number, total: number) => void,
  ): Promise<{ ok: number; fail: number }> {
    const BATCH_CHUNK = 100;
    const etype = 'SP.Data.MikkeManagedIssuesListItem';
    const listUrl = `${this.webUrl}/_api/web/lists/getbytitle('${LIST_MANAGED}')/items`;
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
        const target = op.kind === 'update' && op.id != null ? `${listUrl}(${op.id})` : listUrl;
        const method = op.kind === 'update' ? 'MERGE' : 'POST';
        const body = JSON.stringify({ __metadata: { type: etype }, ...op.row });
        const blen = enc.encode(body).length; // ★ UTF-8 バイト長
        cs += `--${cg}\r\nContent-Type: application/http\r\nContent-Transfer-Encoding: binary\r\n\r\n`;
        cs += `${method} ${target} HTTP/1.1\r\nAccept: ${V}\r\nContent-Type: ${V}\r\n`;
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
      mgmtStatus: (row.MgmtStatus ?? '未通知') as MgmtStatus,
      isOutOfScope: !!row.IsOutOfScope,
      outOfScopeReason: row.OutOfScopeReason ?? undefined,
      assignee: row.Assignee ?? undefined,
      dueDate: row.DueDate ?? undefined,
      mgmtNote: row.MgmtNote ?? undefined,
      scannerStatus: row.ScannerStatus ?? undefined,
      severity: row.Severity ?? undefined,
      firstSeen: row.FirstSeen ?? undefined,
      lastSeen: row.LastSeen ?? undefined,
      firstUndetectedAt: row.FirstUndetectedAt ?? undefined,
      addedReason: (row.AddedReason ?? undefined) as AddedReason | undefined,
      lastSyncedAt: row.LastSyncedAt ?? undefined,
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
    // ★ 検査ツール由来の全項目は個別列ではなく ScanData に JSON で集約する
    //   (SP の列数上限/行サイズ上限を回避)。キーは元の "Scan_<元名>" のまま保持し、
    //   表示側 resolveScanValue が raw/安全名/エンコードのいずれでも引ける。
    if (p.scanFields !== undefined) row.ScanData = packScanData(p.scanFields);
    return row;
  }
}
