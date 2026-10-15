import type { OrderChannel } from '@meridian/types';
import { runCreditCheck, getFinancing, type CreditCheckView } from './device-financing.js';
import type { Queryable } from './db.js';
import { invalid, rejected } from './errors.js';
import { priceBasket, type LineInput } from './order-pricing.js';

/**
 * Runs the credit check for the devices in a basket: works out what would be financed (the device price after the subsidy), asks the bureau about the customer
 * (with their consent) and returns the answer, which the order then uses (`financing.creditCheckId`).
 */
export async function creditCheckForBasket(db: Queryable, i: { customerId: string; idNumber: string; consent: { given: boolean; by: string; how: string }; channel: OrderChannel; marketCode?: string; lines: LineInput[]; actor: string }): Promise<CreditCheckView> {
  if (!(await getFinancing(db)).financeOverContract) throw rejected('Devices are not financed over the contract.');
  const p = await priceBasket(db, { customerId: i.customerId, channel: i.channel, marketCode: i.marketCode, lines: i.lines, payment: { method: 'CREDIT_CARD' }, financing: {} }, { soft: true });
  const devices = p.lines.filter((l) => l.deal && !l.input.payment && l.gross > 0);
  if (!devices.length) throw invalid('There is no device on a contract in this order, so there is nothing to check.');
  return runCreditCheck(db, { customerId: i.customerId, idNumber: i.idNumber, financedMinor: devices.reduce((t, l) => t + l.gross, 0), months: devices[0]!.deal!.termMonths, currency: p.currency, consent: i.consent, actor: i.actor });
}
