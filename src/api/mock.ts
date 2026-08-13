// Mock リポジトリ — 非 SP ホスト / ?mock=1 でのデザイン・動作検証用。
// localStorage に保存して再読込でも保持する。
import type { Repository, ImportLogEntry } from './repo';
import type { ManagedIssue, ManagedAsset, ResponseHistory, ChangeLogEntry, MikkeSettings, SiteUser, DownloadRecord, SetupStep, SetupResult } from '../types';
import { normalizeMgmtStatus } from '../types';
import type { ImportOp } from '../lib/import';
import { vulnResponseFieldSpecs } from './sp/schema';
import type { VulnResponseItem } from '../lib/responseSync';
import type { VulnResponseFields, VulnResponseRow } from '../lib/vulnResponseSync';

const LS_ISSUES = 'mikke.mock.issues';
const LS_SETTINGS = 'mikke.mock.settings';
const LS_ASSETS = 'mikke.mock.assets';
const LS_HISTORY = 'mikke.mock.history';
const LS_CHANGELOG = 'mikke.mock.changelog';
const LS_DOWNLOADS = 'mikke.mock.downloads';
const LS_DOCFILES = 'mikke.mock.docfiles';
const LS_ATTACHMENTS = 'mikke.mock.attachments';   // 連携用リストの添付 (IID → [{name,size}])
const LS_VULNRESPONSE = 'mikke.mock.vulnresponse';

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch { return fallback; }
}
function save<T>(key: string, val: T): void {
  try { localStorage.setItem(key, JSON.stringify(val)); } catch { /* noop */ }
}

function seedIssues(): ManagedIssue[] {
  const now = new Date().toISOString();
  return [
    {
      id: 1, title: 'TLS 1.0 が有効', issueInstanceId: 'iid-0001',
      detectionStatus: '継続', mgmtStatus: '対応中', isOutOfScope: false,
      assignee: 'sec-team', severity: 'High', scannerStatus: 'open',
      firstSeen: now, lastSeen: now, lastSyncedAt: now, addedReason: '条件一致',
      scanFields: { 'Scan_Asset': 'web01.example.com', 'Scan_CVE': 'CVE-2011-3389' },
    },
    {
      id: 2, title: '管理画面が外部公開', issueInstanceId: 'iid-0002',
      detectionStatus: '新規', mgmtStatus: '未着手', isOutOfScope: false,
      severity: 'Critical', scannerStatus: 'open',
      firstSeen: now, lastSeen: now, lastSyncedAt: now, addedReason: '個別指定',
      scanFields: { 'Scan_Asset': 'admin.example.com', 'Scan_CVE': '' },
    },
    {
      id: 3, title: '古い jQuery 使用', issueInstanceId: 'iid-0003',
      detectionStatus: '未検出(New)', mgmtStatus: '対応済み', isOutOfScope: false,
      assignee: 'dev-team', severity: 'Low', scannerStatus: 'resolved',
      firstSeen: now, lastSeen: now, firstUndetectedAt: now, lastSyncedAt: now,
      addedReason: '条件一致',
      scanFields: { 'Scan_Asset': 'shop.example.com', 'Scan_CVE': 'CVE-2020-11023' },
    },
  ];
}

export class MockRepository implements Repository {
  private issues: ManagedIssue[];
  private settings: MikkeSettings;
  private assets: ManagedAsset[];
  private history: ResponseHistory[];
  private changelog: ChangeLogEntry[];
  private downloads: DownloadRecord[];

  constructor() {
    this.issues = load<ManagedIssue[]>(LS_ISSUES, seedIssues());
    this.assets = load<ManagedAsset[]>(LS_ASSETS, []);
    this.history = load<ResponseHistory[]>(LS_HISTORY, []);
    this.changelog = load<ChangeLogEntry[]>(LS_CHANGELOG, []);
    this.downloads = load<DownloadRecord[]>(LS_DOWNLOADS, []);
    this.settings = load<MikkeSettings>(LS_SETTINGS, {
      managedColumns: ['Scan_Asset', 'Scan_CVE'],
      matchConditions: { combinator: 'OR', rules: [{ field: 'Severity', op: 'equals', value: 'Critical' }] },
      individualIds: [],
      downloadFolder: 'Shared Documents/MikkeDownloads',
    });
  }

  async ensureLists(): Promise<void> { /* mock: no-op */ }

  /** 保存済みデータの旧値を現行の選択肢に寄せる (SP 側と同じ扱いにする)。 */
  private normalize(i: ManagedIssue): ManagedIssue {
    return { ...i, mgmtStatus: normalizeMgmtStatus(i.mgmtStatus) };
  }

  async listIssues(): Promise<ManagedIssue[]> {
    return this.issues.map((i) => this.normalize(i));
  }

  async getIssue(id: number): Promise<ManagedIssue | null> {
    const found = this.issues.find((i) => i.id === id);
    return found ? this.normalize(found) : null;
  }

  async updateIssue(id: number, patch: Partial<ManagedIssue>): Promise<void> {
    const idx = this.issues.findIndex((i) => i.id === id);
    if (idx < 0) return;
    this.issues[idx] = { ...this.issues[idx]!, ...patch, id };
    save(LS_ISSUES, this.issues);
  }

  async deleteIssue(id: number): Promise<void> {
    const idx = this.issues.findIndex((i) => i.id === id);
    if (idx >= 0) { this.issues.splice(idx, 1); save(LS_ISSUES, this.issues); }
  }

  // ── 資産 (FQDN/IP) 管理 ──────────────────────────────────────────────────
  async listAssets(): Promise<ManagedAsset[]> {
    return this.assets.map((a) => ({ ...a }));
  }

  async createAsset(asset: Omit<ManagedAsset, 'id'>): Promise<number> {
    const id = this.assets.reduce((m, a) => Math.max(m, a.id), 0) + 1;
    this.assets.push({ ...asset, id });
    save(LS_ASSETS, this.assets);
    return id;
  }

  async updateAsset(id: number, patch: Partial<ManagedAsset>): Promise<void> {
    const idx = this.assets.findIndex((a) => a.id === id);
    if (idx < 0) return;
    this.assets[idx] = { ...this.assets[idx]!, ...patch, id };
    save(LS_ASSETS, this.assets);
  }

  async deleteAsset(id: number): Promise<void> {
    const idx = this.assets.findIndex((a) => a.id === id);
    if (idx >= 0) { this.assets.splice(idx, 1); save(LS_ASSETS, this.assets); }
  }

  /** モックでは添付をアップロードできないので、貼り付け画像は data URL のまま
   *  インライン保持する (= dev では base64 が localStorage に入る)。 */
  async uploadAssetImage(_assetId: number, file: File): Promise<{ url: string }> {
    const url = await new Promise<string>((resolve, reject) => {
      const rd = new FileReader();
      rd.onload = () => resolve(rd.result as string);
      rd.onerror = () => reject(new Error('read failed'));
      rd.readAsDataURL(file);
    });
    return { url };
  }

  // ── ダウンロードデータ ────────────────────────────────────────────────────
  async listDownloads(): Promise<DownloadRecord[]> {
    return this.downloads
      .slice()
      .sort((a, b) => (b.downloadedAt ?? '').localeCompare(a.downloadedAt ?? ''))
      .map((d) => ({ ...d }));
  }
  async createDownload(rec: Omit<DownloadRecord, 'id'>): Promise<number> {
    const id = this.downloads.reduce((m, d) => Math.max(m, d.id), 0) + 1;
    this.downloads.push({ ...rec, id });
    save(LS_DOWNLOADS, this.downloads);
    return id;
  }
  async deleteDownload(id: number): Promise<void> {
    const idx = this.downloads.findIndex((d) => d.id === id);
    if (idx >= 0) { this.downloads.splice(idx, 1); save(LS_DOWNLOADS, this.downloads); }
  }
  /** モックでは実 SP に置けないので data URL を localStorage に退避し、疑似 URL を返す。 */
  async uploadDownloadFile(folder: string, fileName: string, data: Blob): Promise<{ url: string }> {
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const rd = new FileReader();
      rd.onload = () => resolve(rd.result as string);
      rd.onerror = () => reject(new Error('read failed'));
      rd.readAsDataURL(data);
    });
    const url = `/${folder}/${fileName}`;
    const store = load<Record<string, string>>(LS_DOCFILES, {});
    store[url] = dataUrl;
    save(LS_DOCFILES, store);
    return { url };
  }
  async deleteDocFile(serverRelativeUrl: string): Promise<void> {
    const store = load<Record<string, string>>(LS_DOCFILES, {});
    if (store[serverRelativeUrl]) { delete store[serverRelativeUrl]; save(LS_DOCFILES, store); }
  }
  async docFileHref(serverRelativeUrl: string): Promise<string> {
    const store = load<Record<string, string>>(LS_DOCFILES, {});
    return store[serverRelativeUrl] ?? '';
  }

  // ── 連携用リスト (モックには実体が無いので localStorage に持つ) ───────────
  async listVulnResponseRows(): Promise<VulnResponseRow[]> {
    return load<VulnResponseRow[]>(LS_VULNRESPONSE, []);
  }
  async findMissingVulnResponseColumns(): Promise<string[]> { return []; /* mock: 列の概念なし */ }

  async createVulnResponseItem(fields: VulnResponseFields): Promise<void> {
    const rows = load<VulnResponseRow[]>(LS_VULNRESPONSE, []);
    rows.push({ ...fields, id: rows.reduce((m, r) => Math.max(m, r.id), 0) + 1 });
    save(LS_VULNRESPONSE, rows);
  }
  async updateVulnResponseItem(id: number, fields: Partial<VulnResponseFields>): Promise<void> {
    const rows = load<VulnResponseRow[]>(LS_VULNRESPONSE, []);
    const idx = rows.findIndex((r) => r.id === id);
    if (idx >= 0) { rows[idx] = { ...rows[idx]!, ...fields, id }; save(LS_VULNRESPONSE, rows); }
  }
  async deleteVulnResponseItem(id: number): Promise<void> {
    const rows = load<VulnResponseRow[]>(LS_VULNRESPONSE, []).filter((r) => r.id !== id);
    save(LS_VULNRESPONSE, rows);
  }

  /** モックには連携用リストの実体が無いので、取り込む記入内容も無い。 */
  async listVulnResponses(): Promise<VulnResponseItem[]> {
    return [];
  }

  /** モックには連携用リストの実体が無いので、全件「未通知」になる。 */
  async vulnResponseUpdatedAt(): Promise<Map<string, string>> {
    return new Map();
  }

  /** モックには連携用リストの実体が無いので、開く URL も無い (未作成扱い)。 */
  async vulnResponseListUrl(): Promise<string | null> {
    return null;
  }

  /** モックには連携用リストの実体が無いので、添付できたことにして UI を通す。 */
  /** モックにも添付を記録する (件数だけでなく「何が付いたか」を確認できるように)。
   *  実物と同じく、該当アイテムが無ければ 'no-item'、常に最新 1 つだけ残す。 */
  async attachVulnResponseFile(
    issueInstanceId: string, fileName: string, data: Blob, previousFileName?: string,
  ): Promise<'attached' | 'no-item'> {
    const rows = load<VulnResponseRow[]>(LS_VULNRESPONSE, []);
    if (!rows.some((r) => r.issueInstanceId === issueInstanceId)) return 'no-item';
    const store = load<Record<string, { name: string; size: number }[]>>(LS_ATTACHMENTS, {});
    const drop = new Set([fileName, previousFileName ?? ''].filter(Boolean));
    const kept = (store[issueInstanceId] ?? []).filter((a) => !drop.has(a.name));
    store[issueInstanceId] = [...kept, { name: fileName, size: data.size }];
    save(LS_ATTACHMENTS, store);
    return 'attached';
  }

  /** モックでは SP に書けないので、工程の見え方だけ再現する (UI 検証用)。 */
  async ensureVulnResponseList(): Promise<SetupResult> {
    const steps: SetupStep[] = [
      { category: 'リスト', target: 'MikkeVulnResponse', outcome: 'created' },
      ...vulnResponseFieldSpecs().map((f) => ({
        category: '列', target: f.name, outcome: 'created' as const,
      })),
      ...vulnResponseFieldSpecs().filter((f) => f.displayName).map((f) => ({
        category: '表示名', target: `${f.name} → ${f.displayName}`, outcome: 'updated' as const,
      })),
      { category: '既定ビュー', target: 'ビュー列', outcome: 'updated' },
      { category: 'フォーム書式設定', target: 'アイテム', outcome: 'updated' },
      ...vulnResponseFieldSpecs().filter((f) => f.conditionalFormula).map((f) => ({
        category: '条件付き数式', target: f.name, outcome: 'updated' as const,
      })),
    ];
    const counts = { created: 0, updated: 0, skipped: 0, failed: 0 };
    for (const s of steps) counts[s.outcome]++;
    return { steps, counts, listUrl: '' };
  }

  // ── 対応履歴 ──────────────────────────────────────────────────────────────
  async listHistory(issueInstanceId: string): Promise<ResponseHistory[]> {
    return this.history.filter((h) => h.issueInstanceId === issueInstanceId).map((h) => ({ ...h }));
  }
  async createHistory(entry: Omit<ResponseHistory, 'id'>): Promise<number> {
    const id = this.history.reduce((m, h) => Math.max(m, h.id), 0) + 1;
    this.history.push({ ...entry, id, createdAt: new Date().toISOString() });
    save(LS_HISTORY, this.history);
    return id;
  }
  async deleteHistory(id: number): Promise<void> {
    const idx = this.history.findIndex((h) => h.id === id);
    if (idx >= 0) { this.history.splice(idx, 1); save(LS_HISTORY, this.history); }
  }

  // ── 更新履歴 ──────────────────────────────────────────────────────────────
  async listChangeLog(issueInstanceId: string): Promise<ChangeLogEntry[]> {
    return this.changelog.filter((c) => c.issueInstanceId === issueInstanceId).map((c) => ({ ...c }));
  }
  async createChangeLog(entry: Omit<ChangeLogEntry, 'id'>): Promise<number> {
    const id = this.changelog.reduce((m, c) => Math.max(m, c.id), 0) + 1;
    this.changelog.push({ ...entry, id });
    save(LS_CHANGELOG, this.changelog);
    return id;
  }
  async deleteChangeLog(id: number): Promise<void> {
    const idx = this.changelog.findIndex((c) => c.id === id);
    if (idx >= 0) { this.changelog.splice(idx, 1); save(LS_CHANGELOG, this.changelog); }
  }
  async clearChangeLog(issueInstanceId: string): Promise<void> {
    this.changelog = this.changelog.filter((c) => c.issueInstanceId !== issueInstanceId);
    save(LS_CHANGELOG, this.changelog);
  }

  async createIssue(issue: Omit<ManagedIssue, 'id'>): Promise<number> {
    const id = this.issues.reduce((m, i) => Math.max(m, i.id), 0) + 1;
    this.issues.push({ ...issue, id });
    save(LS_ISSUES, this.issues);
    return id;
  }

  async getSettings(): Promise<MikkeSettings> { return { ...this.settings }; }

  async saveSettings(s: MikkeSettings): Promise<void> {
    this.settings = { ...s };
    save(LS_SETTINGS, this.settings);
  }

  async getCurrentUser(): Promise<SiteUser | null> {
    return { displayName: 'テストユーザー', email: 'test@example.com' };
  }

  async applyImportOps(
    ops: ImportOp[],
    onProgress?: (done: number, total: number) => void,
  ): Promise<{ ok: number; fail: number }> {
    let ok = 0, fail = 0;
    let done = 0;
    for (const op of ops) {
      try {
        if (op.kind === 'add' && op.create) { await this.createIssue(op.create); ok++; }
        else if ((op.kind === 'update' || op.kind === 'undetect') && op.id != null && op.patch) {
          await this.updateIssue(op.id, op.patch); ok++;
        }
      } catch { fail++; }
      onProgress?.(++done, ops.length);
    }
    return { ok, fail };
  }

  async ensureScanColumns(_columns: string[]): Promise<void> { /* mock: no-op */ }

  async findMissingColumns(): Promise<string[]> { return []; /* mock: 列の概念なし */ }

  async createMissingColumns(_cols: string[]): Promise<void> { /* mock: no-op */ }

  async writeImportLog(entry: ImportLogEntry): Promise<void> {
    // mock: localStorage に履歴を積む (デバッグ用)。
    try {
      const key = 'mikke.mock.importlog';
      const log = load<ImportLogEntry[]>(key, []);
      log.unshift(entry);
      save(key, log.slice(0, 50));
    } catch { /* noop */ }
  }
}
