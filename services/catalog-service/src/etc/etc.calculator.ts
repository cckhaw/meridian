import type { ContractTerms, EtcQuote, Money } from '@meridian/types';

export interface EtcInput {
  offerId: string;
  contract: ContractTerms;
  contractStart: Date;
  terminationDate: Date;
  /** Recurring monthly fee; required for REMAINING_RECURRING_PERCENT. */
  monthlyRecurring?: Money;
}

/** Whole calendar months elapsed, clamped to [0, term]. */
export function monthsElapsed(start: Date, end: Date, term: number): number {
  let m = (end.getUTCFullYear() - start.getUTCFullYear()) * 12 + (end.getUTCMonth() - start.getUTCMonth());
  if (end.getUTCDate() < start.getUTCDate()) m -= 1;
  return Math.min(Math.max(m, 0), term);
}

/**
 * Early Termination Charge.
 *  - SUBSIDY_AMORTISED: subsidy * remaining/term, capped at subsidy * cap.
 *  - REMAINING_RECURRING_PERCENT: monthlyRecurring * remaining * pct/100.
 * Month-to-month contracts (term 0) and the waiver window return a zero charge.
 */
export function quoteEtc(input: EtcInput): EtcQuote {
  const { contract } = input;
  const term = contract.termMonths;
  const policy = contract.etc;
  const currency = (contract.subsidy?.subsidyAmount ?? input.monthlyRecurring)?.currency ?? 'USD';
  const elapsed = monthsElapsed(input.contractStart, input.terminationDate, term);
  const remaining = term - elapsed;
  const base = { offerId: input.offerId, currency, monthsElapsed: elapsed, monthsRemaining: remaining };

  if (term === 0 || !policy || remaining === 0) return { ...base, chargeMinor: 0, waived: false };
  if (policy.waiveInLastMonths !== undefined && remaining <= policy.waiveInLastMonths) {
    return { ...base, chargeMinor: 0, waived: true };
  }

  let charge: number;
  if (policy.method === 'SUBSIDY_AMORTISED') {
    if (!contract.subsidy) throw new Error('SUBSIDY_AMORTISED ETC requires a device subsidy');
    const subsidy = contract.subsidy.subsidyAmount.amountMinor;
    charge = Math.round((subsidy * remaining) / term);
    charge = Math.min(charge, Math.round(subsidy * (policy.capSubsidyFraction ?? 1)));
  } else {
    if (!input.monthlyRecurring) throw new Error('REMAINING_RECURRING_PERCENT ETC requires monthlyRecurring');
    charge = Math.round((input.monthlyRecurring.amountMinor * remaining * (policy.percentOfRemaining ?? 100)) / 100);
  }
  return { ...base, chargeMinor: charge, waived: false };
}
