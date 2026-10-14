import { describe, expect, it } from 'vitest';
import { monthsElapsed, quoteEtc } from './etc.js';

const contract = (term: 12 | 24 | 36) => ({
  termMonths: term,
  etc: { method: 'SUBSIDY_AMORTISED' as const, waiveInLastMonths: 1 },
  subsidy: {
    deviceRetailPrice: { amountMinor: 120000, currency: 'SGD' as const },
    subsidyAmount: { amountMinor: 72000, currency: 'SGD' as const },
  },
});

describe('quoteEtc', () => {
  it('amortises the subsidy over the remaining months', () => {
    const q = quoteEtc({ offerId: 'o', contract: contract(24), contractStart: new Date('2026-01-15'), terminationDate: new Date('2026-07-20') });
    expect(q.monthsElapsed).toBe(6);
    expect(q.chargeMinor).toBe(54000); // 72000 * 18/24
  });

  it('adds the remaining recurring fees to the unearned subsidy (RECURRING_PLUS_SUBSIDY)', () => {
    const c = { ...contract(24), etc: { method: 'RECURRING_PLUS_SUBSIDY' as const, waiveInLastMonths: 1 } };
    const q = quoteEtc({ offerId: 'o', contract: c, contractStart: new Date('2026-01-15'), terminationDate: new Date('2026-07-20'), monthlyRecurring: { amountMinor: 5000, currency: 'SGD' } });
    // 18 months left: 18 x 50.00 + 72000 x 18/24
    expect([q.recurringMinor, q.clawbackMinor, q.chargeMinor]).toEqual([90000, 54000, 144000]);
    const half = quoteEtc({ offerId: 'o', contract: { ...c, etc: { ...c.etc, percentOfRemaining: 50 } }, contractStart: new Date('2026-01-15'), terminationDate: new Date('2026-07-20'), monthlyRecurring: { amountMinor: 5000, currency: 'SGD' } });
    expect(half.chargeMinor).toBe(45000 + 54000); // pro-ration applies to the recurring part
    expect(() => quoteEtc({ offerId: 'o', contract: c, contractStart: new Date('2026-01-15'), terminationDate: new Date('2026-07-20') })).toThrow(/monthlyRecurring/);
  });

  it('does not count a partial month', () => {
    expect(monthsElapsed(new Date('2026-01-15'), new Date('2026-02-14'), 12)).toBe(0);
    expect(monthsElapsed(new Date('2026-01-15'), new Date('2026-02-15'), 12)).toBe(1);
  });

  it('waives in the last month', () => {
    const q = quoteEtc({ offerId: 'o', contract: contract(12), contractStart: new Date('2026-01-01'), terminationDate: new Date('2026-12-05') });
    expect(q).toMatchObject({ waived: true, chargeMinor: 0 });
  });

  it('charges the full subsidy when terminating on day zero', () => {
    const q = quoteEtc({ offerId: 'o', contract: contract(36), contractStart: new Date('2026-01-01'), terminationDate: new Date('2026-01-01') });
    expect(q.chargeMinor).toBe(72000);
  });

  it('supports percent-of-remaining-recurring', () => {
    const q = quoteEtc({
      offerId: 'o',
      contract: { termMonths: 12, etc: { method: 'REMAINING_RECURRING_PERCENT', percentOfRemaining: 50 } },
      contractStart: new Date('2026-01-01'),
      terminationDate: new Date('2026-04-01'),
      monthlyRecurring: { amountMinor: 8000, currency: 'MYR' },
    });
    expect(q.chargeMinor).toBe(36000); // 8000 * 9 * 50%
  });

  it('returns zero for month-to-month', () => {
    const q = quoteEtc({ offerId: 'o', contract: { termMonths: 0 }, contractStart: new Date('2026-01-01'), terminationDate: new Date('2026-02-01'), monthlyRecurring: { amountMinor: 1, currency: 'SGD' } });
    expect(q.chargeMinor).toBe(0);
  });
});
