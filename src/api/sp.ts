// SharePoint REST リポジトリ。同一オリジン Cookie 認証。
// 役割: contextinfo(digest) / list CRUD / ensureLists(ensureFields) /
//       $batch 一括書き込み。
import type { Repository } from './repo';
import type { ManagedIssue, MikkeSettings, SiteUser, DetectionStatus, MgmtStatus, AddedReason } from '../types';
import {
  LIST_MANAGED, LIST_SETTINGS, LIST_IMPORTLOG,
  managedIssueFieldSpecs, settingsFieldSpecs, importLogFieldSpecs,
  toFieldSchema, spFieldTypeString, type FieldSpec,
} from './sp/schema';
import { getSelectedSiteUrl } from '../utils/spSites';

const V = 'application/json;odata=verbose';

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
    const body = this.issueToRow(patch);
    await this.spPost(
      `/_api/web/lists/getbytitle('${LIST_MANAGED}')/items(${id})`,
      { __metadata: { type: 'SP.Data.MikkeManagedIssuesListItem' }, ...body },
      { 'X-HTTP-Method': 'MERGE', 'IF-MATCH': '*' }, // 後勝ち
    );
  }

  async createIssue(issue: Omit<ManagedIssue, 'id'>): Promise<number> {
    const body = this.issueToRow(issue);
    const r = await this.spPost(
      `/_api/web/lists/getbytitle('${LIST_MANAGED}')/items`,
      { __metadata: { type: 'SP.Data.MikkeManagedIssuesListItem' }, ...body },
    );
    const j = await r.json();
    return j.d.Id as number;
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

  // ── row ↔ entity ──────────────────────────────────────────────────────────
  private rowToIssue(row: any): ManagedIssue {
    const scanFields: Record<string, string> = {};
    for (const k of Object.keys(row)) {
      if (k.startsWith('Scan_')) scanFields[k] = String(row[k] ?? '');
    }
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
    if (p.dueDate !== undefined) row.DueDate = p.dueDate;
    if (p.mgmtNote !== undefined) row.MgmtNote = p.mgmtNote;
    if (p.scannerStatus !== undefined) row.ScannerStatus = p.scannerStatus;
    if (p.severity !== undefined) row.Severity = p.severity;
    if (p.firstSeen !== undefined) row.FirstSeen = p.firstSeen;
    if (p.lastSeen !== undefined) row.LastSeen = p.lastSeen;
    if (p.firstUndetectedAt !== undefined) row.FirstUndetectedAt = p.firstUndetectedAt;
    if (p.addedReason !== undefined) row.AddedReason = p.addedReason;
    if (p.lastSyncedAt !== undefined) row.LastSyncedAt = p.lastSyncedAt;
    if (p.scanFields) for (const [k, v] of Object.entries(p.scanFields)) row[k] = v;
    return row;
  }
}
