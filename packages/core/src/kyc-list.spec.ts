import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from './db.js';
import { decideKycCase, listKycCases } from './kyc.js';
import { kycSummary, type KycListFilter } from './kyc-list.js';
import { claimCase, escalateCase, setKycReviewSettings } from './kyc-review.js';
import { addCase, addOfficer } from './kyc-review-helpers.js';
import { getStoreSettings } from './store-settings.js';
import { freshDb, newCustomer } from './test-helpers.js';

let db: Db;
const ids: Record<string, string> = {};
const names = async (f: KycListFilter) => (await listKycCases(db, { limit: 100, ...f })).items.map((i) => i.fullName as string);

beforeAll(async () => {
  db = await freshDb();
  for (const u of ['l.one', 'l.two']) await addOfficer(db, u);
  await addOfficer(db, 'lead', ['compliance-lead'], { displayName: 'Lena Lead' });
  await setKycReviewSettings(db, 'root', { autoAssign: false });
  const { customer } = await newCustomer(db, { displayName: 'Priya Nair', email: 'priya.nair@example.org', phone: '+6598761234' });
  ids.tan = await addCase(db, { name: 'Tan Wei Ming', idNumber: 'S1234567A', source: 'STOREFRONT', submittedHoursAgo: 10 });
  ids.nguyen = await addCase(db, { name: 'Nguyễn Văn An', idNumber: 'T7654321B', source: 'ASSISTED', flags: ['NOT_LIVE_CAPTURE'], submittedHoursAgo: 8 });
  ids.priya = await addCase(db, { name: 'P. Nair', idNumber: 'G1111222C', customerId: customer.id as string, flags: ['DUPLICATE_IDENTITY'], submittedHoursAgo: 2 });
  ids.li = await addCase(db, { name: 'Li 李明', idNumber: 'S9999000D', submittedHoursAgo: 1 });
  ids.pct = await addCase(db, { name: '100% Real_Name', idNumber: 'S5555111E', submittedHoursAgo: 3 });
  ids.done = await addCase(db, { name: 'Decided Dora', idNumber: 'S2222333F', submittedHoursAgo: 5 });
  await claimCase(db, 'l.one', ids.tan!);
  await claimCase(db, 'l.one', ids.nguyen!);
  await claimCase(db, 'l.two', ids.priya!);
  await claimCase(db, 'lead', ids.done!);
  await decideKycCase(db, ids.done!, 'lead', { decision: 'APPROVE', reason: 'ok' }, await getStoreSettings(db));
});
afterAll(async () => { await db.close(); });

describe('searching the review list', () => {
  it('matches a name anywhere, ignoring case, and anchors the pattern when a wildcard is used', async () => {
    expect(await names({ q: 'wei' })).toEqual(['Tan Wei Ming']);
    expect(await names({ q: 'TAN WEI' })).toEqual(['Tan Wei Ming']);
    expect(await names({ q: 'tan*' })).toEqual(['Tan Wei Ming']);
    expect(await names({ q: 'wei*' })).toEqual([]);
    expect(await names({ q: '*ming' })).toEqual(['Tan Wei Ming']);
    expect(await names({ q: 'T?n*' })).toEqual(['Tan Wei Ming']);
    expect(await names({ q: 'Nguyễn*' })).toEqual(['Nguyễn Văn An']);
    expect(await names({ q: '李' })).toEqual(['Li 李明']);
    expect((await names({ q: '*' })).length).toBe(6);
  });

  it('never treats a typed % or _ as a SQL wildcard', async () => {
    expect(await names({ q: '%' })).toEqual(['100% Real_Name']);
    expect(await names({ q: '100%' })).toEqual(['100% Real_Name']);
    expect(await names({ q: 'real_n' })).toEqual(['100% Real_Name']);
    expect(await names({ q: 'real_x' })).toEqual([]);
    expect(await names({ q: 'a_b' })).toEqual([]);
    expect(await names({ q: '\\' })).toEqual([]);
  });

  it('finds the last digits of the ID, and the whole ID number only when typed in full (by its keyed hash)', async () => {
    expect(await names({ q: '67A' })).toEqual(['Tan Wei Ming']);
    expect(await names({ q: 'S****67A' })).toEqual(['Tan Wei Ming']);
    expect(await names({ q: 'S1234567A' })).toEqual(['Tan Wei Ming']);
    expect(await names({ q: 's1234567a' })).toEqual(['Tan Wei Ming']);
    expect(await names({ q: 'S123456' })).toEqual([]);          // part of the number that is not shown is not searchable
    expect(await names({ q: 'S12*' })).toEqual([]);
  });

  it('finds a case by its number, as KYC-123 or just 123', async () => {
    const one = (await db.query(`SELECT case_number FROM kyc_cases WHERE id=$1`, [ids.tan])).rows[0]!.caseNumber as string;
    expect(one).toBe('KYC-000001');
    expect(await names({ q: 'KYC-000001' })).toEqual(['Tan Wei Ming']);
    expect(await names({ q: 'kyc-1' })).toEqual(['Tan Wei Ming']);
    expect(await names({ q: 'KYC1' })).toEqual(['Tan Wei Ming']);
    expect(await names({ q: 'KYC-9' })).toEqual([]);
    expect((await names({ q: '1' })).includes('Tan Wei Ming')).toBe(true);
    expect(await names({ q: 'KYC-00000?' })).toHaveLength(6);
  });

  it('finds the customer’s name, phone and e-mail, and the officer holding the case by username or name', async () => {
    expect(await names({ q: 'priya' })).toEqual(['P. Nair']);
    expect(await names({ q: '*8761234' })).toEqual(['P. Nair']);
    expect(await names({ q: 'nair@example' })).toEqual(['P. Nair']);
    expect((await names({ q: 'l.one' })).sort()).toEqual(['Nguyễn Văn An', 'Tan Wei Ming']);
    expect(await names({ q: 'LENA*' })).toEqual(['Decided Dora']);
    expect(await names({ q: 'lena', status: 'PENDING' })).toEqual([]);
  });

  it('finds the number of an order waiting on the case while looking at waiting cases', async () => {
    expect(await names({ q: 'ORD-NOPE', status: 'PENDING' })).toEqual([]);
  });
});

describe('filtering the review list', () => {
  it('filters by status, assignee, source, risk, flag, overdue and escalation', async () => {
    expect((await names({ status: 'PENDING' })).length).toBe(5);
    expect(await names({ status: 'APPROVED' })).toEqual(['Decided Dora']);
    expect(await names({ status: 'any' })).toHaveLength(6);
    expect((await names({ assignee: 'unassigned' })).sort()).toEqual(['100% Real_Name', 'Li 李明']);
    expect((await names({ assignee: 'l.one' })).sort()).toEqual(['Nguyễn Văn An', 'Tan Wei Ming']);
    expect((await names({ assignee: 'L.ONE', status: 'PENDING' })).length).toBe(2);
    expect(await names({ assignee: 'me', me: 'l.two' })).toEqual(['P. Nair']);
    expect((await names({ assignee: 'any', status: 'PENDING' })).length).toBe(5);
    await expect(listKycCases(db, { assignee: 'me' })).rejects.toThrow(/Sign in/);
    expect(await names({ source: 'ASSISTED' })).toEqual(['Nguyễn Văn An']);
    expect(await names({ risk: 'HIGH' })).toEqual(['P. Nair']);
    expect(await names({ risk: 'MEDIUM' })).toEqual(['Nguyễn Văn An']);
    expect(await names({ flag: 'not_live_capture' })).toEqual(['Nguyễn Văn An']);
    expect((await names({ overdue: true })).sort()).toEqual(['Nguyễn Văn An', 'Tan Wei Ming']);        // target is 4 hours
    await escalateCase(db, { username: 'l.one' }, ids.tan!, { note: 'second opinion' });
    expect(await names({ escalated: true })).toEqual(['Tan Wei Ming']);
    await expect(listKycCases(db, { status: 'LOST' })).rejects.toThrow(/status is one of/);
    await expect(listKycCases(db, { risk: 'EXTREME' })).rejects.toThrow(/risk is LOW/);
    await expect(listKycCases(db, { sort: 'random' as never })).rejects.toThrow(/sort is/);
  });

  it('filters by submission date in the regional time zone (a case at 23:30 local belongs to that local day)', async () => {
    await db.query(`UPDATE kyc_cases SET submitted_at = $2 WHERE id=$1`, [ids.li, '2026-03-10T15:30:00Z']);     // 23:30 on 10 March in Singapore
    await db.query(`UPDATE kyc_cases SET submitted_at = $2 WHERE id=$1`, [ids.pct, '2026-03-10T16:30:00Z']);    // 00:30 on 11 March
    expect(await names({ from: '2026-03-10', to: '2026-03-10' })).toEqual(['Li 李明']);
    expect(await names({ from: '2026-03-11', to: '2026-03-11' })).toEqual(['100% Real_Name']);
    expect((await names({ from: '2026-03-10', to: '2026-03-11' })).sort()).toEqual(['100% Real_Name', 'Li 李明']);
    expect(await names({ to: '2026-03-09' })).toEqual([]);
    await expect(listKycCases(db, { from: '10/03/2026' })).rejects.toThrow(/YYYY-MM-DD/);
  });
});

describe('sorting and paging the review list', () => {
  const walk = async (f: KycListFilter, limit: number) => {
    const out: string[] = [];
    let cursor: string | undefined, pages = 0;
    do { const p = await listKycCases(db, { ...f, limit, cursor }); out.push(...p.items.map((i) => i.id as string)); cursor = p.nextCursor ?? undefined; pages++; } while (cursor && pages < 100);
    return out;
  };
  beforeAll(async () => {
    // many cases with the same priority and the same submission time, so only the tie-break keeps the pages consistent
    for (let i = 0; i < 14; i++) await addCase(db, { name: `Bulk ${i}`, submittedHoursAgo: i % 3, flags: i % 4 === 0 ? ['NOT_LIVE_CAPTURE'] : [] });
    await db.query(`UPDATE kyc_cases SET submitted_at = '2026-01-01T00:00:00Z' WHERE full_name IN ('Bulk 1','Bulk 2','Bulk 3')`);
    await db.query(`UPDATE kyc_cases SET status='APPROVED', decided_by='lead', decided_at = '2026-02-01T10:00:00Z' WHERE full_name IN ('Bulk 5','Bulk 6','Bulk 7','Bulk 8')`);
  });

  for (const sort of ['priority', 'oldest', 'due', 'newest'] as const) {
    it(`pages through the whole list in ${sort} order without skipping or repeating a case`, async () => {
      const all = await walk({ sort, status: sort === 'newest' ? undefined : 'PENDING' }, 1000);
      for (const limit of [1, 3, 5, 7]) expect(await walk({ sort, status: sort === 'newest' ? undefined : 'PENDING' }, limit), `limit ${limit}`).toEqual(all);
      expect(new Set(all).size).toBe(all.length);
      expect(all.length).toBeGreaterThan(10);
    });
  }

  it('orders by priority (overdue, escalated, risk), then oldest; by oldest; and decided cases newest first', async () => {
    const rows = (await listKycCases(db, { status: 'PENDING', sort: 'priority', limit: 100 })).items;
    const prios = rows.map((r) => r.priority as number);
    expect(prios).toEqual([...prios].sort((a, b) => b - a));
    expect(rows[0]!.fullName).toBe('Tan Wei Ming');                  // escalated and overdue
    const oldest = (await listKycCases(db, { status: 'PENDING', sort: 'oldest', limit: 100 })).items.map((r) => Date.parse(r.submittedAt as string));
    expect(oldest).toEqual([...oldest].sort((a, b) => a - b));
    const newest = (await listKycCases(db, { status: 'APPROVED', sort: 'newest', limit: 100 })).items;
    expect(newest[0]!.fullName).toBe('Decided Dora');                // decided just now; the Bulk cases were decided in February
    expect(newest.map((r) => Date.parse(r.decidedAt as string))).toEqual([...newest.map((r) => Date.parse(r.decidedAt as string))].sort((a, b) => b - a));
  });

  it('returns the documented row shape', async () => {
    const item = (await listKycCases(db, { q: 'tan wei', status: 'PENDING' })).items[0]!;
    expect(Object.keys(item)).toEqual(expect.arrayContaining(['id', 'caseNumber', 'fullName', 'idType', 'idNumberMasked', 'source', 'method', 'status', 'flags', 'risk', 'priority', 'submittedAt', 'dueAt', 'overdue', 'waitingOrders', 'assignedTo', 'assignedToName', 'assignedAt', 'assignmentSource', 'escalated', 'decidedBy', 'decidedAt', 'reasonCode']));
    expect(item).toMatchObject({ assignedTo: 'lead', assignedToName: 'Lena Lead', assignmentSource: 'ESCALATED', escalated: true, risk: 'LOW', overdue: true, waitingOrders: 0, decidedBy: null });
    expect(Date.parse(item.dueAt as string) - Date.parse(item.submittedAt as string)).toBe(4 * 3_600_000);
  });
});

describe('the summary', () => {
  it('counts the queue and the signed-in officer’s share', async () => {
    const s = await kycSummary(db, 'l.one');
    const waiting = (await listKycCases(db, { status: 'PENDING', limit: 100 })).items.length;
    expect(s.waiting).toBe(waiting);
    expect(s.mine).toBe((await listKycCases(db, { status: 'PENDING', assignee: 'me', me: 'l.one', limit: 100 })).items.length);
    expect(s.unassigned).toBe((await listKycCases(db, { assignee: 'unassigned', limit: 100 })).items.length);
    expect(s).toMatchObject({ escalated: 1, awaitingSecondReview: 0, qaTasks: 0, decidedToday: 0 });
    expect(s.overdue).toBeGreaterThanOrEqual(2);
    expect(s.mineOverdue).toBeGreaterThanOrEqual(1);
    expect((await kycSummary(db, 'lead')).decidedToday).toBe(1);
  });
});
