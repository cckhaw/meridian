import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { updateNode } from './catalog.js';
import type { Db } from './db.js';
import { bandFor, getFinancing, runCreditCheck, setFinancing, simulatedScore, financingProblems, DEFAULT_FINANCING } from './device-financing.js';
import { creditCheckForBasket } from './financing-check.js';
import { saveHubEndpoint } from './integration-hub.js';
import { priceBasket, quoteOrder } from './order-pricing.js';
import { placeOrder } from './orders.js';
import { freshDb, newCustomer } from './test-helpers.js';

let db: Db;
beforeAll(async () => {
  db = await freshDb();
  await updateNode(db, 'good-phone-outright', { deals: [{ termMonths: 24, subsidyMinor: 40000 }, { termMonths: 12, subsidyMinor: 20000 }] }, 'admin');
});
afterAll(async () => { await db.close(); });

const lines = (extra: Record<string, unknown> = {}) => [{ offerId: 'plan-sim-5g' }, { offerId: 'good-phone-outright', attachTo: 0, dealTermMonths: 24, ...extra }];
let seq = 0;
const withId = async (id = `FINID-${++seq}-7`) => ({ customer: (await newCustomer(db, { idDocument: id })).customer, idNumber: id });
const consent = { given: true, by: 'agent', how: 'verbal at counter' };
const base = (customerId: string, financing?: object) => ({ customerId, channel: 'RETAIL_ASSISTED', payment: { method: 'CASH' }, lines: lines(), financing }) as never;

describe('a device on a contract is financed over the contract', () => {
  it('splits the price after the subsidy evenly across the contract by default, and the customer may pay in full', async () => {
    const { customer } = await newCustomer(db);
    const p = await priceBasket(db, base(customer.id));
    const phone = p.lines[1]!;
    expect(phone.payMode).toBe('INSTALLMENT');
    expect(phone.months).toBe(24);
    expect(phone.downMinor).toBe(0);
    expect(phone.instalmentMinor).toBe(Math.floor(phone.gross / 24));
    expect(p.financing).toMatchObject({ applied: true, months: 24, upfrontMinor: 0, requiresCreditCheck: false });
    const full = await priceBasket(db, base(customer.id, { payInFull: true }));
    expect(full.lines[1]!.payMode).toBe('UPFRONT');
    expect(full.dueNow).toBe(p.dueNow + phone.gross);
  });

  it('can be switched off', async () => {
    const { customer } = await newCustomer(db);
    await setFinancing(db, 'admin', { financeOverContract: false });
    const p = await priceBasket(db, base(customer.id));
    expect(p.lines[1]!.payMode).toBe('UPFRONT');
    expect(p.financing).toBeUndefined();
    await setFinancing(db, 'admin', { financeOverContract: true });
  });

  it('keeps an explicit choice on the line', async () => {
    const { customer } = await newCustomer(db);
    const p = await priceBasket(db, { ...(base(customer.id) as object), lines: lines({ payment: { mode: 'INSTALLMENT', months: 12, downPaymentMinor: 5900 } }) } as never);
    expect(p.lines[1]).toMatchObject({ months: 12, downMinor: 5900 });
  });
});

describe('the settings', () => {
  it('map a score to an upfront share and refuse overlapping bands', () => {
    expect(bandFor(DEFAULT_FINANCING, 720)!.upfrontBps).toBe(0);
    expect(bandFor(DEFAULT_FINANCING, 610)!.upfrontBps).toBe(1000);
    expect(bandFor(DEFAULT_FINANCING, 120)!.label).toBe('Poor');
    expect(financingProblems({ ...DEFAULT_FINANCING, bands: [{ label: 'A', minScore: 0, maxScore: 600, upfrontBps: 0 }, { label: 'B', minScore: 500, maxScore: 900, upfrontBps: 0 }] }).join(' ')).toMatch(/overlap/);
  });
});

describe('the credit check', () => {
  it('needs consent, and the ID number of the customer', async () => {
    const { customer } = await newCustomer(db);
    await expect(runCreditCheck(db, { customerId: customer.id, idNumber: 'X1234567', financedMinor: 100000, currency: 'SGD', consent: { ...consent, given: false }, actor: 'a' })).rejects.toThrow(/agree to a credit check/);
    await expect(runCreditCheck(db, { customerId: customer.id, idNumber: 'WRONG-ID-1', financedMinor: 100000, currency: 'SGD', consent, actor: 'a' })).rejects.toThrow(/not the one this customer was registered with/);
  });

  it('without a bureau applies the fallback share; with the simulator maps the score to a band', async () => {
    const { customer, idNumber } = await withId();
    const none = await runCreditCheck(db, { customerId: customer.id, idNumber, financedMinor: 100000, months: 24, currency: 'SGD', consent, actor: 'a' });
    expect(none).toMatchObject({ fallback: true, ratioBps: 2500, upfrontMinor: 25000, decision: 'UPFRONT' });
    await saveHubEndpoint(db, 'admin', { group: 'finance', kind: 'CREDIT_BUREAU', name: 'Bureau', config: { mode: 'SIMULATOR' } } as never);
    const c = await runCreditCheck(db, { customerId: customer.id, idNumber: 'ABC1239', financedMinor: 100000, months: 24, currency: 'SGD', consent, actor: 'a', skipCustomerMatch: true });
    expect(simulatedScore('ABC1239')).toBe(890);
    expect(c).toMatchObject({ score: 890, band: 'Good', ratioBps: 0, decision: 'NO_UPFRONT', source: 'SIMULATOR' });
  });
});

describe('an order with a credit check', () => {
  it('asks for a check when the settings require one, then charges the upfront share and spreads the rest', async () => {
    await setFinancing(db, 'admin', { creditCheckRequired: true, onProviderFailure: 'FALLBACK_SHARE' });
    const { customer, idNumber } = await withId('FINID-3');
    const q = await quoteOrder(db, base(customer.id));
    expect(q.financing?.requiresCreditCheck).toBe(true);
    expect(q.problems.join(' ')).toMatch(/credit check is needed/);
    await expect(placeOrder(db, { ...(base(customer.id) as object), deferred: undefined, payment: { method: 'CASH', deferred: true }, attribution: { storeId: 'STORE-SG-001', salespersonId: 'a1' } } as never)).rejects.toThrow(/credit check is needed/);
    // the simulator (set up above) scores by the last digit of the ID: 3 → 530, the Low band, 25% upfront
    const check = await runCreditCheck(db, { customerId: customer.id, idNumber, financedMinor: 100000, months: 24, currency: 'SGD', consent, actor: 'a' });
    const chk = await creditCheckForBasket(db, { customerId: customer.id, idNumber, consent, channel: 'RETAIL_ASSISTED', lines: lines(), actor: 'a' });
    expect(chk.financedMinor).toBeGreaterThan(0);
    const p = await priceBasket(db, base(customer.id, { creditCheckId: chk.id }));
    const phone = p.lines[1]!;
    expect(phone.downMinor).toBe(Math.round((phone.gross * chk.ratioBps) / 10000));
    expect(phone.instalmentMinor).toBe(Math.floor((phone.gross - phone.downMinor) / 24));
    expect(check.id).not.toBe(chk.id);
    const placed = await placeOrder(db, { ...(base(customer.id, { creditCheckId: chk.id }) as object), payment: { method: 'CASH', deferred: true }, attribution: { storeId: 'STORE-SG-001', salespersonId: 'a1' } } as never);
    expect(placed.lines.find((l: any) => l.deal).payMode ?? placed.lines.find((l: any) => l.deal).pay_mode).toBe(phone.downMinor >= phone.gross ? 'UPFRONT' : 'INSTALLMENT');
    // a check belongs to one order
    await expect(priceBasket(db, base(customer.id, { creditCheckId: chk.id }))).rejects.toThrow(/already used/);
    // and to its customer
    const other = await newCustomer(db);
    const again = await creditCheckForBasket(db, { customerId: customer.id, idNumber, consent, channel: 'RETAIL_ASSISTED', lines: lines(), actor: 'a' });
    await expect(priceBasket(db, base(other.customer.id, { creditCheckId: again.id }))).rejects.toThrow(/another customer/);
    await setFinancing(db, 'admin', { creditCheckRequired: false });
    expect((await getFinancing(db)).creditCheckRequired).toBe(false);
  });
});
