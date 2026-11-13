/** Pure helpers for the KYC workspace: which tab asks the server what, the address that keeps the view, the batch selection, and KPI formatting. */

export type Tab = 'mine' | 'waiting' | 'unassigned' | 'escalated' | 'second' | 'qa' | 'decided' | 'returned' | 'performance';
export const TABS: Tab[] = ['mine', 'waiting', 'unassigned', 'escalated', 'second', 'qa', 'decided', 'returned', 'performance'];
export const SORTS = [{ value: 'priority', label: 'Priority' }, { value: 'oldest', label: 'Oldest first' }, { value: 'due', label: 'Due soonest' }, { value: 'newest', label: 'Newest first' }];
/** What the Decided tab shows. "Everything" is the old "All" filter: every case, waiting ones included. */
export const OUTCOMES = [{ value: 'DECIDED', label: 'Approved or rejected' }, { value: 'APPROVED', label: 'Approved' }, { value: 'REJECTED', label: 'Rejected' }, { value: 'ALL', label: 'Everything' }];

export interface Filters {
  q: string; source: string; risk: string; flag: string; overdue: boolean; escalated: boolean;
  /** '' = the tab's own rule; otherwise a username (assigners pick one from the workload strip or the officer picker). */
  assignee: string; from: string; to: string; sort: string; outcome: string; who: 'me' | 'any';
}
export const NO_FILTERS: Filters = { q: '', source: '', risk: '', flag: '', overdue: false, escalated: false, assignee: '', from: '', to: '', sort: '', outcome: 'DECIDED', who: 'any' };

export const defaultTab = (can: (...p: string[]) => boolean): Tab => (can('kyc:assign') ? 'waiting' : can('kyc:review') ? 'mine' : 'waiting');

/** The list endpoint's query for a tab and its filters. Empty values are left out so the address stays short. */
export function listParams(tab: Tab, f: Filters): Record<string, string> {
  const p: Record<string, string> = {};
  const set = (k: string, v: string | undefined | false) => { if (v) p[k] = v; };
  switch (tab) {
    case 'mine': p.status = 'PENDING'; p.assignee = 'me'; break;
    case 'waiting': p.status = 'PENDING'; p.assignee = f.assignee || 'any'; break;
    case 'unassigned': p.status = 'PENDING'; p.assignee = 'unassigned'; break;
    case 'escalated': p.status = 'PENDING'; p.escalated = '1'; p.assignee = f.assignee || 'any'; break;
    case 'second': p.status = 'SECOND_REVIEW'; p.assignee = 'any'; break;
    case 'qa': p.qa = '1'; p.assignee = 'any'; break;
    case 'returned': p.status = 'RETURNED'; p.assignee = f.assignee || 'any'; break;
    case 'decided': p.status = f.outcome === 'ALL' ? '' : f.outcome || 'DECIDED'; p.assignee = f.who === 'me' ? 'me' : f.assignee || 'any'; break;
    default: break;
  }
  if (!p.status) delete p.status;
  set('q', f.q.trim()); set('source', f.source); set('risk', f.risk); set('flag', f.flag);
  set('overdue', f.overdue && '1'); if (tab !== 'escalated') set('escalated', f.escalated && '1');
  set('from', f.from); set('to', f.to);
  p.sort = f.sort || (tab === 'decided' || tab === 'returned' ? 'newest' : 'priority');
  return p;
}
export const toQuery = (p: Record<string, string | number | undefined>) => Object.entries(p).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&');
export const listQuery = (tab: Tab, f: Filters, extra: Record<string, string | number> = {}) => toQuery({ ...listParams(tab, f), ...extra });

/** The view as it is kept in the address: only what differs from the defaults. */
export function viewToSearch(tab: Tab, f: Filters, defTab: Tab): string {
  const s = new URLSearchParams();
  if (tab !== defTab) s.set('tab', tab);
  const put = (k: string, v: string, d = '') => { if (v && v !== d) s.set(k, v); };
  put('q', f.q); put('source', f.source); put('risk', f.risk); put('flag', f.flag); put('assignee', f.assignee); put('from', f.from); put('to', f.to); put('sort', f.sort); put('outcome', f.outcome, 'DECIDED');
  if (f.overdue) s.set('overdue', '1'); if (f.escalated) s.set('escalated', '1'); if (f.who === 'me') s.set('who', 'me');
  return s.toString();
}
export function searchToView(sp: URLSearchParams, defTab: Tab): { tab: Tab; f: Filters } {
  const t = sp.get('tab') as Tab | null;
  const g = (k: string) => sp.get(k) ?? '';
  return {
    tab: t && TABS.includes(t) ? t : defTab,
    f: { q: g('q'), source: g('source'), risk: g('risk'), flag: g('flag'), overdue: g('overdue') === '1', escalated: g('escalated') === '1', assignee: g('assignee'), from: g('from'), to: g('to'), sort: g('sort'), outcome: g('outcome') || 'DECIDED', who: g('who') === 'me' ? 'me' : 'any' },
  };
}

/* ---------------- batch selection ---------------- */
export const MAX_FILTER_ASSIGN = 2000;
/** Chosen rows, or "every case matching the current search and filters" (`all`). */
export interface Selection { ids: string[]; all: boolean }
export const EMPTY_SELECTION: Selection = { ids: [], all: false };
export const toggleId = (s: Selection, id: string): Selection => ({ all: false, ids: s.ids.includes(id) ? s.ids.filter((x) => x !== id) : [...s.ids, id] });
/** Header checkbox: select every row on screen, or clear when they are all selected already. */
export const togglePage = (s: Selection, pageIds: string[]): Selection => (pageIds.length && pageIds.every((i) => s.ids.includes(i)) ? EMPTY_SELECTION : { all: false, ids: [...new Set([...s.ids, ...pageIds])] });
export const isSelected = (s: Selection, id: string) => s.all || s.ids.includes(id);
export const selectionCount = (s: Selection, matching: number | null) => (s.all ? matching : s.ids.length);
/** A reason is required when any chosen case already has an officer (reassigning), and for "all matching" outside the Unassigned tab, where that cannot be known. */
export function needsReason(s: Selection, rows: Array<{ id: string; assignedTo: string | null }>, tab: Tab): boolean {
  if (s.all) return tab !== 'unassigned';
  return rows.some((r) => s.ids.includes(r.id) && !!r.assignedTo);
}
/** The body of POST /kyc/assignments for a selection. */
export function assignmentTarget(s: Selection, tab: Tab, f: Filters): { caseIds: string[] } | { filter: Record<string, string> } {
  if (!s.all) return { caseIds: s.ids };
  const { sort: _sort, ...filter } = listParams(tab, f);
  return { filter };
}

/* ---------------- time and KPI formatting ---------------- */
export const initials = (name: string) => name.split(/[\s._-]+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('') || '?';

/** "2 h 10 min left" or "overdue by 3 h": how long until the due time. */
export function dueText(dueAt: string | null | undefined, now = Date.now()): { text: string; overdue: boolean } | null {
  if (!dueAt) return null;
  const ms = new Date(dueAt).getTime() - now;
  if (Number.isNaN(ms)) return null;
  const span = spanText(Math.abs(ms) / 60000);
  return ms < 0 ? { text: ms > -60000 ? 'overdue' : `overdue by ${span}`, overdue: true } : { text: `${span} left`, overdue: false };
}
/** Minutes as the two biggest units: 45 min, 3 h 20 min, 2 d 4 h. */
export function spanText(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  if (m < 1) return 'under a minute';
  if (m < 60) return `${m} min`;
  if (m < 1440) { const h = Math.floor(m / 60), r = m % 60; return r ? `${h} h ${r} min` : `${h} h`; }
  const dd = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60);
  return h ? `${dd} d ${h} h` : `${dd} d`;
}
export const fmtMinutes = (m: number | null | undefined) => (m === null || m === undefined ? '–' : spanText(m));
export const fmtHours = (h: number | null | undefined) => (h === null || h === undefined ? '–' : spanText(h * 60));
export const fmtPct = (n: number | null | undefined) => (n === null || n === undefined || Number.isNaN(n) ? '–' : `${Math.round(n)}%`);
/** Approved out of everything decided (approved + rejected + sent back). */
export const approvalRate = (t: { decided: number; approved: number }) => (t.decided > 0 ? (t.approved / t.decided) * 100 : null);

/* ---------------- performance ---------------- */
export type Preset = 'today' | '7d' | '30d' | 'month' | 'custom';
export const PRESETS: Array<{ value: Preset; label: string }> = [{ value: 'today', label: 'Today' }, { value: '7d', label: 'Last 7 days' }, { value: '30d', label: 'Last 30 days' }, { value: 'month', label: 'This month' }, { value: 'custom', label: 'Custom' }];
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
export function presetRange(p: Exclude<Preset, 'custom'>, now = new Date()): { from: string; to: string } {
  const to = ymd(now);
  if (p === 'today') return { from: to, to };
  if (p === 'month') return { from: ymd(new Date(now.getFullYear(), now.getMonth(), 1)), to };
  const back = p === '7d' ? 6 : 29;
  return { from: ymd(new Date(now.getFullYear(), now.getMonth(), now.getDate() - back)), to };
}
/** A sensible grouping for a range: days up to 31, weeks up to a year, then months. */
export function defaultBy(from: string, to: string): 'day' | 'week' | 'month' {
  const days = Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1;
  return days <= 31 ? 'day' : days <= 366 ? 'week' : 'month';
}
export interface SeriesPoint { bucket: string; decided: number; approved: number; rejected: number; returned: number; avgMinutes: number | null }
/** One point per bucket in `buckets`, zero where the officer decided nothing, so empty days show as empty bars. */
export function fillSeries(series: SeriesPoint[] | undefined, buckets: string[]): SeriesPoint[] {
  const by = new Map((series ?? []).map((s) => [s.bucket, s]));
  return buckets.map((b) => by.get(b) ?? { bucket: b, decided: 0, approved: 0, rejected: 0, returned: 0, avgMinutes: null });
}
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
/** `short` is for an axis tick, the long form for a table row or tooltip. */
export function bucketLabel(bucket: string, by: string, short = false): string {
  const m = /^(\d{4})-(\d{2})(?:-(\d{2}))?/.exec(bucket);
  if (!m) return bucket;
  const mon = MONTHS[Number(m[2]) - 1] ?? m[2]!;
  if (by === 'month') return short ? mon : `${mon} ${m[1]}`;
  const day = Number(m[3]);
  if (by === 'week') return short ? `${day} ${mon}` : `Week of ${day} ${mon} ${m[1]}`;
  const dow = DAYS[new Date(Number(m[1]), Number(m[2]) - 1, day).getDay()]!;
  return short ? String(day) : `${dow} ${day} ${mon} ${m[1]}`;
}
/** A round top for a chart axis: 1, 2, 5 times a power of ten, at or above `max`. */
export function niceMax(max: number): number {
  if (max <= 4) return Math.max(4, Math.ceil(max));
  const p = 10 ** Math.floor(Math.log10(max));
  return ([1, 2, 4, 5, 10].map((k) => k * p).find((v) => v >= max)) ?? max;
}
/** The `n` busiest officers by reviews done; the rest are folded into one "Others" row so a chart never needs more than n + 1 colours. */
export function topOfficers<T extends { totals: { decided: number } }>(officers: T[], n: number): { top: T[]; rest: T[] } {
  const sorted = [...officers].sort((a, b) => b.totals.decided - a.totals.decided);
  return { top: sorted.slice(0, n), rest: sorted.slice(n) };
}
