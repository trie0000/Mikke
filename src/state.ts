// Tiny global state — single store with subscribe.
import type { ViewName, SiteUser } from './types';
import type { RelayUpdateInfo } from './utils/relayUpdate';

interface Filter {
  // 複数選択可 = 配列。空配列 = フィルタ無効。配列内いずれか一致 (OR) でヒット。
  detection: string[];   // DetectionStatus
  mgmt: string[];        // MgmtStatus
  assignee: string[];
  query: string;
  /** 対象外・過検出・未検出をデフォルトで隠す。トグルで表示。 */
  showHidden: boolean;
}

interface State {
  view: ViewName;
  selectedIssueId: number | null;
  openIssueIds: number[]; // 詳細タブで開いている ID
  filter: Filter;
  sortBy: 'id' | 'title' | 'detection' | 'mgmt' | 'assignee' | 'due' | 'synced';
  sortDir: 'asc' | 'desc';
  issueCount: number;
  /** 現在ログインしているユーザー。 */
  currentUser: SiteUser | null;
  /** 現在接続中の SP サイト表示名 / URL。 */
  siteTitle: string | null;
  siteUrl: string | null;
  // bootstrap status
  ready: boolean;
  errorBanner: string | null;
  /** relay スクリプト更新通知 (配布元の relay-version.txt と relay 自己 version の差)。 */
  relayUpdateAvailable: RelayUpdateInfo | null;
  /** バンドル本体の更新通知 (version.txt と起動中 build id の差)。最新 build id か null。 */
  bundleUpdateAvailable: string | null;
}

type Listener = () => void;

const FILTER_KEY = 'mikke.issueFilter';
function loadPersistedFilter(): Filter {
  const base: Filter = {
    detection: [], mgmt: [], assignee: [], query: '', showHidden: false,
  };
  try {
    const raw = localStorage.getItem(FILTER_KEY);
    if (!raw) return base;
    const j = JSON.parse(raw) as Record<string, unknown>;
    const arr = (v: unknown): string[] => Array.isArray(v) ? v.map(String) : [];
    const str = (v: unknown): string => typeof v === 'string' ? v : '';
    return {
      detection: arr(j.detection), mgmt: arr(j.mgmt),
      assignee: arr(j.assignee),
      query: str(j.query), showHidden: j.showHidden === true,
    };
  } catch { return base; }
}
function persistFilter(): void {
  try { localStorage.setItem(FILTER_KEY, JSON.stringify(state.filter)); } catch { /* noop */ }
}

const TABS_KEY = 'mikke.openTabs';
function loadPersistedTabs(): Pick<State, 'view' | 'selectedIssueId' | 'openIssueIds'> {
  const base: Pick<State, 'view' | 'selectedIssueId' | 'openIssueIds'> = {
    view: 'issues', selectedIssueId: null, openIssueIds: [],
  };
  try {
    const raw = localStorage.getItem(TABS_KEY);
    if (!raw) return base;
    const j = JSON.parse(raw) as Record<string, unknown>;
    const ids = Array.isArray(j.openIssueIds)
      ? j.openIssueIds.filter((x): x is number => typeof x === 'number')
      : [];
    const sel = typeof j.selectedIssueId === 'number' ? j.selectedIssueId : null;
    const validViews: ViewName[] = ['issues', 'import', 'assets', 'downloads'];
    const view = (typeof j.view === 'string' && validViews.includes(j.view as ViewName))
      ? (j.view as ViewName) : 'issues';
    return { view, selectedIssueId: sel, openIssueIds: ids };
  } catch { return base; }
}
function persistTabs(): void {
  try {
    localStorage.setItem(TABS_KEY, JSON.stringify({
      view: state.view,
      selectedIssueId: state.selectedIssueId,
      openIssueIds: state.openIssueIds,
    }));
  } catch { /* noop */ }
}

const persistedTabs = loadPersistedTabs();
const state: State = {
  view: persistedTabs.view,
  selectedIssueId: persistedTabs.selectedIssueId,
  openIssueIds: persistedTabs.openIssueIds,
  filter: loadPersistedFilter(),
  sortBy: 'synced',
  sortDir: 'desc',
  issueCount: 0,
  currentUser: null,
  siteTitle: null,
  siteUrl: null,
  ready: false,
  errorBanner: null,
  relayUpdateAvailable: null,
  bundleUpdateAvailable: null,
};

const listeners = new Set<Listener>();

export function getState(): Readonly<State> { return state; }

export function setState(
  patch: Partial<State> | ((s: State) => Partial<State>),
  opts: { silent?: boolean } = {},
): void {
  const next = typeof patch === 'function' ? patch(state) : patch;
  Object.assign(state, next);
  if ('view' in next || 'selectedIssueId' in next || 'openIssueIds' in next) persistTabs();
  if (opts.silent) return;
  for (const l of listeners) l();
}

export function setFilter(
  patch: Partial<Filter>,
  opts: { silent?: boolean } = {},
): void {
  Object.assign(state.filter, patch);
  persistFilter();
  if (opts.silent) return;
  for (const l of listeners) l();
}

export function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
