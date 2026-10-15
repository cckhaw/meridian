import { payInvoice, runBillCycle } from './billing.js';
import { dayOf, today } from './dates.js';
import type { Db } from './db.js';
import { placeOrder } from './orders.js';
import { backdate, newCustomer } from './test-helpers.js';

void payInvoice;
/** A customer with a live service and one cycle invoice for the account, ready to be made overdue. */
export async function billedAccount(db: Db): Promise<{ customerId: string; accountId: string; invoiceId: string; serviceId: string }> {
  const { customer, account } = await newCustomer(db, { address: { line1: '1 Road', postcode: '100001' } });
  await db.query('UPDATE accounts SET bill_cycle_day=$2 WHERE id=$1', [account!.id, dayOf(today())]);
  const o = await placeOrder(db, { customerId: customer.id, channel: 'RETAIL_ASSISTED', attribution: { storeId: 'STORE-SG-001', salespersonId: 'a1' }, payment: { method: 'CASH' }, lines: [{ offerId: 'plan-sim-5g' }] });
  await backdate(db, customer.id, 100);
  await runBillCycle(db, today(), { accountId: account!.id });
  const inv = (await db.query(`SELECT id FROM invoices WHERE account_id=$1 AND kind='CYCLE' ORDER BY issue_date DESC LIMIT 1`, [account!.id])).rows[0]!;
  return { customerId: customer.id, accountId: account!.id, invoiceId: inv.id as string, serviceId: o.services[0].id as string };
}
