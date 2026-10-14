import { randomUUID } from 'node:crypto';
import { audit } from './audit.js';
import { GL } from './config.js';
import type { Db } from './db.js';
import { today } from './dates.js';
import { invalid, notFound } from './errors.js';
import { postJournal } from './ledger.js';

/** A security deposit taken for an account. Held as a liability; applied to the closing invoice and refunded when the last service ends. */
export async function receiveDeposit(db: Db, accountId: string, o: { amountMinor: number; method?: 'CASH' | 'CREDIT_CARD' | 'QR'; reference?: string }, actor = 'system') {
  if (!Number.isInteger(o.amountMinor) || o.amountMinor <= 0) throw invalid('amountMinor must be a positive whole amount');
  return db.tx(async (q) => {
    const a = (await q.query('SELECT * FROM accounts WHERE id=$1 FOR UPDATE', [accountId])).rows[0];
    if (!a) throw notFound('account', accountId);
    await q.query(`INSERT INTO payments (shard_id, account_id, method, status, amount_minor, currency, reference, idempotency_key) VALUES ($1,$2,$3,'CAPTURED',$4,$5,$6,$7)`,
      [a.shardId, accountId, o.method ?? 'CASH', o.amountMinor, a.currency, o.reference ? `deposit: ${o.reference}` : 'deposit', `deposit-${randomUUID()}`]);
    await postJournal(q, { date: today(), sourceType: 'DEPOSIT', sourceId: accountId, currency: a.currency, lines: [
      { account: GL.CASH, debit: o.amountMinor, description: 'Deposit received' }, { account: GL.DEPOSITS, credit: o.amountMinor, description: 'Deposit received' },
    ] });
    await q.query('UPDATE accounts SET deposit_minor = deposit_minor + $2 WHERE id=$1', [accountId, o.amountMinor]);
    await audit(q, actor, 'account', accountId, 'DEPOSIT_RECEIVED', { amountMinor: o.amountMinor });
    return (await q.query('SELECT id, deposit_minor FROM accounts WHERE id=$1', [accountId])).rows[0]!;
  });
}
