import { describe, expect, it } from 'vitest';
import { assignmentTarget, bucketLabel, defaultBy, defaultTab, dueText, fillSeries, listQuery, needsReason, niceMax, NO_FILTERS, presetRange, searchToView, spanText, togglePage, toggleId, viewToSearch, EMPTY_SELECTION } from './view';

describe('list query per tab', () => {
  it('My queue is pending work assigned to me, by priority', () => {
    expect(listQuery('mine', NO_FILTERS, { limit: 25 })).toBe('status=PENDING&assignee=me&sort=priority&limit=25');
  });
  it('All waiting searches everyone and carries the search and filters', () => {
    const q = listQuery('waiting', { ...NO_FILTERS, q: 'Tan*', risk: 'HIGH', overdue: true, assignee: 'siti' });
    expect(q).toBe('status=PENDING&assignee=siti&q=Tan*&risk=HIGH&overdue=1&sort=priority'.replace('Tan*', encodeURIComponent('Tan*')));
  });
  it('Decided: everything drops the status, mine narrows to me, newest first', () => {
    expect(listQuery('decided', { ...NO_FILTERS, outcome: 'ALL' })).toBe('assignee=any&sort=newest');
    expect(listQuery('decided', { ...NO_FILTERS, who: 'me', from: '2026-11-01', to: '2026-11-13' })).toBe('status=DECIDED&assignee=me&from=2026-11-01&to=2026-11-13&sort=newest');
  });
  it('Escalated and Unassigned fix their own rule', () => {
    expect(listQuery('escalated', NO_FILTERS)).toContain('escalated=1');
    expect(listQuery('unassigned', { ...NO_FILTERS, assignee: 'x' })).toContain('assignee=unassigned');
  });
});

describe('view in the address', () => {
  it('keeps only what differs from the defaults and reads it back', () => {
    const f = { ...NO_FILTERS, q: 'KYC-00120?', overdue: true };
    const s = viewToSearch('unassigned', f, 'waiting');
    expect(s).toBe('tab=unassigned&q=KYC-00120%3F&overdue=1');
    const back = searchToView(new URLSearchParams(s), 'waiting');
    expect(back.tab).toBe('unassigned'); expect(back.f).toEqual(f);
    expect(viewToSearch('waiting', NO_FILTERS, 'waiting')).toBe('');
    expect(searchToView(new URLSearchParams('tab=nonsense'), 'mine').tab).toBe('mine');
  });
  it('defaults the tab by permission', () => {
    expect(defaultTab((...p) => p.includes('kyc:assign'))).toBe('waiting');
    expect(defaultTab((...p) => p.includes('kyc:review'))).toBe('mine');
  });
});

describe('batch selection', () => {
  const rows = [{ id: 'a', assignedTo: null }, { id: 'b', assignedTo: 'siti' }];
  it('toggles rows and the page, and clearing the page selection empties it', () => {
    let s = toggleId(EMPTY_SELECTION, 'a'); expect(s.ids).toEqual(['a']);
    s = togglePage(s, ['a', 'b']); expect(s.ids).toEqual(['a', 'b']);
    expect(togglePage(s, ['a', 'b']).ids).toEqual([]);
    expect(toggleId({ ids: ['a'], all: true }, 'a').all).toBe(false);
  });
  it('requires a reason only when reassigning', () => {
    expect(needsReason({ ids: ['a'], all: false }, rows, 'waiting')).toBe(false);
    expect(needsReason({ ids: ['a', 'b'], all: false }, rows, 'waiting')).toBe(true);
    expect(needsReason({ ids: [], all: true }, rows, 'unassigned')).toBe(false);
    expect(needsReason({ ids: [], all: true }, rows, 'waiting')).toBe(true);
  });
  it('sends ids, or the filter without the sort or paging', () => {
    expect(assignmentTarget({ ids: ['a'], all: false }, 'waiting', NO_FILTERS)).toEqual({ caseIds: ['a'] });
    expect(assignmentTarget({ ids: [], all: true }, 'waiting', { ...NO_FILTERS, q: 'Tan*' })).toEqual({ filter: { status: 'PENDING', assignee: 'any', q: 'Tan*' } });
  });
});

describe('time and KPI formatting', () => {
  it('formats spans and due times', () => {
    expect(spanText(0.2)).toBe('under a minute'); expect(spanText(45)).toBe('45 min'); expect(spanText(200)).toBe('3 h 20 min'); expect(spanText(1500)).toBe('1 d 1 h');
    const now = Date.parse('2026-11-13T10:00:00Z');
    expect(dueText('2026-11-13T12:10:00Z', now)).toEqual({ text: '2 h 10 min left', overdue: false });
    expect(dueText('2026-11-13T07:00:00Z', now)).toEqual({ text: 'overdue by 3 h', overdue: true });
    expect(dueText(null)).toBeNull();
  });
  it('builds date presets and picks a grouping', () => {
    const now = new Date(2026, 10, 13);
    expect(presetRange('today', now)).toEqual({ from: '2026-11-13', to: '2026-11-13' });
    expect(presetRange('7d', now)).toEqual({ from: '2026-11-07', to: '2026-11-13' });
    expect(presetRange('month', now)).toEqual({ from: '2026-11-01', to: '2026-11-13' });
    expect(defaultBy('2026-11-01', '2026-11-13')).toBe('day'); expect(defaultBy('2026-01-01', '2026-06-30')).toBe('week'); expect(defaultBy('2025-01-01', '2026-06-30')).toBe('month');
  });
  it('fills empty buckets with zero and labels them', () => {
    const f = fillSeries([{ bucket: '2026-11-02', decided: 3, approved: 2, rejected: 1, returned: 0, avgMinutes: 8 }], ['2026-11-01', '2026-11-02']);
    expect(f.map((x) => x.decided)).toEqual([0, 3]);
    expect(bucketLabel('2026-11-13', 'day')).toBe('Fri 13 Nov 2026'); expect(bucketLabel('2026-11', 'month')).toBe('Nov 2026'); expect(bucketLabel('2026-11-09', 'week', true)).toBe('9 Nov');
    expect(niceMax(0)).toBe(4); expect(niceMax(13)).toBe(20); expect(niceMax(47)).toBe(50);
  });
});
