import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkCustomerDetails, DEFAULT_CUSTOMER_FIELDS, defaultCycleDay, getBillCycles, resolveBillCycle, setBillCycles } from './customer-config.js';
import { createAccount, createCustomer, getCustomer, updateCustomer } from './customers.js';
import type { Db } from './db.js';
import { getCustomerSettings, setCustomerSettings } from './segments.js';
import { freshDb } from './test-helpers.js';

let db: Db;
beforeAll(async () => { db = await freshDb(); });
afterAll(async () => { await db.close(); });
const fields = (o: Record<string, string>) => ({ ...DEFAULT_CUSTOMER_FIELDS, ...o }) as typeof DEFAULT_CUSTOMER_FIELDS;

describe('which customer details are asked for', () => {
  it('drops hidden details, insists on required ones and checks what was entered', () => {
    const f = fields({ postcode: 'required', gender: 'hidden', dateOfBirth: 'required' });
    expect(() => checkCustomerDetails(f, { address: { line1: '1 Road' } })).toThrow(/Date of birth is required\. Postcode is required\./);
    const ok = checkCustomerDetails(f, { dateOfBirth: '1990-04-12', gender: 'female', email: ' a@b.co ', address: { line1: ' 1 Road ', postcode: '12345', country: 'my', city: '' } });
    expect(ok).toEqual({ email: 'a@b.co', dateOfBirth: '1990-04-12', address: { line1: '1 Road', postcode: '12345', country: 'MY' } }); // gender is hidden, so it is not kept; empty city is left out
    expect(() => checkCustomerDetails(fields({}), { dateOfBirth: '2999-01-01' })).toThrow(/future/);
    expect(() => checkCustomerDetails(fields({}), { dateOfBirth: '12/04/1990' })).toThrow(/YYYY-MM-DD/);
    expect(() => checkCustomerDetails(fields({}), { gender: 'robot' })).toThrow(/Gender should be/);
    expect(() => checkCustomerDetails(fields({}), { address: { country: 'Malaysia' } })).toThrow(/two-letter/);
    // editing only judges what is being changed
    expect(checkCustomerDetails(f, { address: { city: 'Penang' } }, { partial: true })).toEqual({ address: { city: 'Penang' } });
  });

  it('is kept in Settings: everything optional at first, and changing one field leaves the rest', async () => {
    expect((await getCustomerSettings(db)).fields).toEqual(DEFAULT_CUSTOMER_FIELDS);
    const s = await setCustomerSettings(db, 'root', { allowCreateWithoutOrder: true, fields: { postcode: 'required', gender: 'hidden' } });
    expect(s.fields).toMatchObject({ postcode: 'required', gender: 'hidden', city: 'optional' });
    const toggled = await setCustomerSettings(db, 'root', { allowCreateWithoutOrder: false }); // the on/off switch alone keeps the field choices
    expect(toggled.fields).toMatchObject({ postcode: 'required', gender: 'hidden' });
    await setCustomerSettings(db, 'root', { allowCreateWithoutOrder: false, fields: DEFAULT_CUSTOMER_FIELDS });
  });
});

describe('customer details are stored', () => {
  it('keeps date of birth, gender and the address, and an edit merges the address', async () => {
    const { customer } = await createCustomer(db, { segment: 'CONSUMER', displayName: 'Siti Aminah', idDocument: 'S9012345A', dateOfBirth: '1990-04-12', gender: 'FEMALE', address: { line1: '12 Jalan Ampang', postcode: '50450', city: 'Kuala Lumpur', state: 'WP', country: 'MY' } });
    expect(customer).toMatchObject({ dateOfBirth: '1990-04-12', gender: 'FEMALE', address: { postcode: '50450', city: 'Kuala Lumpur', country: 'MY' } });
    const edited = await updateCustomer(db, customer.id, { address: { city: 'Petaling Jaya', postcode: '46000' } });
    expect(edited.address).toEqual({ line1: '12 Jalan Ampang', postcode: '46000', city: 'Petaling Jaya', state: 'WP', country: 'MY' });
    const bare = await createCustomer(db, { segment: 'CONSUMER', displayName: 'No Extras', idDocument: 'S9012346B' });
    expect(bare.customer.address ?? null).toBeNull();
  });
});

describe('bill cycles', () => {
  it('offer every day at first (never a daily cycle), and the operator chooses which to keep and which is the default', async () => {
    const d = await getBillCycles(db);
    expect(d.days).toHaveLength(28); expect(d.daily).toBe(false); expect(d.defaultCycle).toBe(1); expect(d.defaultMode).toBe('FIXED');
    await expect(setBillCycles(db, 'root', { days: [1, 29], daily: true, defaultCycle: 1 })).rejects.toThrow(/1 to 28/);
    await expect(setBillCycles(db, 'root', { days: [], daily: false, defaultCycle: 1 })).rejects.toThrow(/at least one/);
    await expect(setBillCycles(db, 'root', { days: [1, 15], daily: false, defaultCycle: 7 })).rejects.toThrow(/default/);
    const s = await setBillCycles(db, 'root', { days: [25, 1, 15], daily: false, defaultCycle: 25 });
    expect(s).toEqual({ days: [1, 15, 25], daily: false, defaultCycle: 25, defaultMode: 'FIXED' });
    expect(await resolveBillCycle(db, undefined)).toBe(25);
    expect(await resolveBillCycle(db, 15)).toBe(15);
    await expect(resolveBillCycle(db, 7)).rejects.toThrow(/not offered/);
    await expect(resolveBillCycle(db, null)).rejects.toThrow(/daily/i);
  });

  it('give a new account the default cycle unless one is chosen', async () => {
    const { customer } = await createCustomer(db, { segment: 'CONSUMER', displayName: 'Cycle Test', idDocument: 'S9012347C', account: false });
    expect((await createAccount(db, customer.id, {})).billCycleDay).toBe(25);
    expect((await createAccount(db, customer.id, { billCycleDay: 15 })).billCycleDay).toBe(15);
    expect(await getCustomer(db, customer.id)).toBeTruthy();
    await setBillCycles(db, 'root', { days: Array.from({ length: 28 }, (_, i) => i + 1), defaultCycle: 1 });
  });

  it('the default can follow the day the billing account is created: the next or the previous cycle date, going round the month', () => {
    const s = { days: [1, 15, 25], daily: false, defaultCycle: 1 as number | 'daily' };
    const day = (mode: 'NEXT' | 'PREVIOUS', d: string) => defaultCycleDay({ ...s, defaultMode: mode }, d);
    expect([day('NEXT', '2026-10-10'), day('NEXT', '2026-10-15'), day('NEXT', '2026-10-27'), day('NEXT', '2026-10-31')]).toEqual([15, 25, 1, 1]);
    expect([day('PREVIOUS', '2026-10-10'), day('PREVIOUS', '2026-10-15'), day('PREVIOUS', '2026-10-01'), day('PREVIOUS', '2026-10-31')]).toEqual([1, 1, 25, 25]);
    expect(defaultCycleDay({ ...s, defaultMode: 'FIXED', defaultCycle: 15 }, '2026-10-10')).toBe(15);
  });

  it('saves the mode, needs no fixed day for it, and a new account follows it', async () => {
    await expect(setBillCycles(db, 'root', { days: [1, 15], defaultCycle: 7, defaultMode: 'FIXED' })).rejects.toThrow(/default/);
    const saved = await setBillCycles(db, 'root', { days: [1, 15, 25], defaultCycle: 7, defaultMode: 'NEXT' });
    expect(saved).toMatchObject({ defaultMode: 'NEXT', defaultCycle: 1 });
    const expected = defaultCycleDay(saved);
    expect(await resolveBillCycle(db, undefined)).toBe(expected);
    const { customer } = await createCustomer(db, { segment: 'CONSUMER', displayName: 'Next Cycle', idDocument: 'S9012348A', account: false });
    expect((await createAccount(db, customer.id, {})).billCycleDay).toBe(expected);
    await setBillCycles(db, 'root', { days: Array.from({ length: 28 }, (_, i) => i + 1), defaultCycle: 1 });
  });
});
