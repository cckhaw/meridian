export interface TaxSplit { net: number; tax: number; gross: number }

/** Split a price into net/tax/gross in integer minor units. Rounds half up; net + tax === gross always. */
export function taxSplit(amountMinor: number, taxBps: number, taxInclusive: boolean): TaxSplit {
  if (taxInclusive) {
    const net = Math.round((amountMinor * 10_000) / (10_000 + taxBps));
    return { net, tax: amountMinor - net, gross: amountMinor };
  }
  const tax = Math.round((amountMinor * taxBps) / 10_000);
  return { net: amountMinor, tax, gross: amountMinor + tax };
}
