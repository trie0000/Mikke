// Mock リポジトリ — 非 SP ホスト / ?mock=1 でのデザイン・動作検証用。
// localStorage に保存して再読込でも保持する。
import type { Repository, ImportLogEntry } from './repo';
import type { ManagedIssue, MikkeSettings, SiteUser } from '../types';
import type { ImportOp } from '../lib/import';

const LS_ISSUES = 'mikke.mock.issues';
const LS_SETTINGS = 'mikke.mock.settings';

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
      detectionStatus: '新規', mgmtStatus: '未通知', isOutOfScope: false,
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

  constructor() {
    this.issues = load<ManagedIssue[]>(LS_ISSUES, seedIssues());
    this.settings = load<MikkeSettings>(LS_SETTINGS, {
      managedColumns: ['Scan_Asset', 'Scan_CVE'],
      matchConditions: { combinator: 'OR', rules: [{ field: 'Severity', op: 'equals', value: 'Critical' }] },
      individualIds: [],
    });
  }

  async ensureLists(): Promise<void> { /* mock: no-op */ }

  async listIssues(): Promise<ManagedIssue[]> {
    return this.issues.map((i) => ({ ...i }));
  }

  async getIssue(id: number): Promise<ManagedIssue | null> {
    const found = this.issues.find((i) => i.id === id);
    return found ? { ...found } : null;
  }

  async updateIssue(id: number, patch: Partial<ManagedIssue>): Promise<void> {
    const idx = this.issues.findIndex((i) => i.id === id);
    if (idx < 0) return;
    this.issues[idx] = { ...this.issues[idx]!, ...patch, id };
    save(LS_ISSUES, this.issues);
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
