import type { Db, Queryable } from './db.js';
import { audit } from './audit.js';
import { invalid } from './errors.js';

/** What the caller has to type to run the purge. */
export const PURGE_CONFIRMATION = 'DELETE ALL ORDERS SERVICES BILLS AND THE CATALOG';

/** Tables emptied completely: everything an order, a subscription or a bill left behind. Customers, accounts, KYC cases, users, settings and stock pools are not in here. */
const EMPTY = [
  // billing and the books
  'invoice_lines', 'invoices', 'payments', 'payment_intents', 'payment_arrangements', 'collection_placements', 'dunning_steps', 'dunning_runs',
  'bill_run_items', 'bill_run_exclusions', 'bill_runs', 'print_jobs', 'simulation_ledger', 'simulation_runs', 'gl_entries', 'gl_batches', 'journal_batch_files', 'ledger_events', 'reconciliation_exceptions', 'reconciliation_reports',
  // subscriptions
  'service_charges', 'pending_plan_changes', 'service_suspensions', 'service_lifecycle_events', 'service_group_members', 'service_groups', 'services',
  'identifier_registry', 'subscriber_otps', 'ocs_jobs', 'lifecycle_outbox', 'fraud_alerts',
  // orders
  'order_lines', 'order_groups', 'order_state_history', 'orders', 'credit_checks', 'idempotency_keys', 'installation_appointments', 'port_in_requests',
  'inventory_reservations', 'number_reservation_locks', 'msisdn_quarantine',
  // commission earned on those orders
  'agent_ledger_entries', 'commissions', 'commission_settlements', 'commission_payout_batches', 'commission_periods',
  // the catalog
  'catalog_nodes',
];

const count = async (q: Queryable, t: string) => Number((await q.query(`SELECT count(*)::bigint AS n FROM ${t}`)).rows[0]?.n ?? 0);

/**
 * Removes every order, subscription and bill and then the whole product catalog, so a new catalog can be built. Customers, accounts, KYC cases, users, settings,
 * stores, dealers, warehouses and the number/SIM pools stay: numbers, SIMs and IMSIs held by those orders go back to their pools and goods go back on the shelf.
 * One transaction: either all of it happens or none of it. `dryRun` only reports what would go.
 */
export async function purgeSalesAndCatalog(db: Db, o: { actor: string; confirm?: string; dryRun?: boolean }): Promise<Record<string, number | string>> {
  if (!o.dryRun && o.confirm !== PURGE_CONFIRMATION) throw invalid(`Type the confirmation text exactly to run this: ${PURGE_CONFIRMATION}`);
  return db.tx(async (q) => {
    const before: Record<string, number> = {};
    for (const t of EMPTY) before[t] = await count(q, t);
    // a table outside the list that still points at one inside would make TRUNCATE fail halfway: find it first, so the answer is a clear refusal
    const blockers = (await q.query(
      `SELECT DISTINCT c.conrelid::regclass::text AS child, c.confrelid::regclass::text AS parent FROM pg_constraint c
        WHERE c.contype = 'f' AND c.connamespace = 'public'::regnamespace AND c.confrelid::regclass::text = ANY($1::text[]) AND NOT (c.conrelid::regclass::text = ANY($1::text[]))
          AND c.conrelid::regclass::text !~ '_(s|h|p|c)[0-9]+$' AND c.conrelid::regclass::text !~ '_p[0-9]{6}$' AND c.conrelid::regclass::text <> 'gl_entries_default'`, [EMPTY])).rows;
    if (blockers.length) throw invalid(`Cannot purge: ${blockers.map((b) => `${b.child} still points at ${b.parent}`).join('; ')}`);
    const result: Record<string, number | string> = { ...before };
    if (o.dryRun) return { dryRun: 'yes', ...result };

    // goods: what left the building comes back, and nothing is reserved any more
    const back = (await q.query(`SELECT location_id AS "locationId", sku, sum(quantity)::int AS qty FROM inventory_reservations WHERE consumed_at IS NOT NULL GROUP BY 1, 2`)).rows;
    for (const b of back) {
      const r = await q.query(`UPDATE inventory_stock SET on_hand = on_hand + $3 WHERE location_id = $1 AND sku = $2 RETURNING on_hand`, [b.locationId, b.sku, b.qty]);
      if (r.rows[0]) await q.query(`INSERT INTO stock_movements (location_id, sku, delta, on_hand, kind, reason, note, actor) VALUES ($1,$2,$3,$4,'COUNT','OTHER','Demo data reset: goods from purged orders returned',$5)`, [b.locationId, b.sku, b.qty, r.rows[0].onHand, o.actor]);
    }
    await q.query(`UPDATE inventory_stock SET reserved = 0 WHERE reserved <> 0`);

    // SIMs, IMSIs and numbers go back to the pools (a scrapped SIM stays scrapped; numbers held back for VIP or auction stay held back)
    result.simsReturned = (await q.query(
      `UPDATE iccid_inventory SET state = CASE WHEN location_id LIKE 'WH-%' THEN 'WAREHOUSE_INVENTORY' ELSE 'DISTRIBUTED_DEALER' END, previous_state = NULL, order_id = NULL, service_id = NULL, reserved_until = NULL,
              imsi = CASE WHEN kind = 'ESIM' THEN NULL ELSE imsi END, activation_code = CASE WHEN kind = 'ESIM' THEN NULL ELSE activation_code END, updated_at = now()
        WHERE transfer_id IS NULL AND state <> 'DAMAGED_SCRAPPED' AND (order_id IS NOT NULL OR service_id IS NOT NULL OR state IN ('RESERVED','ACTIVE','DECOMMISSIONED'))`)).rowCount ?? 0;
    result.imsisReturned = (await q.query(
      `UPDATE imsi_inventory i SET state = CASE WHEN s.iccid IS NOT NULL THEN 'BOUND_TO_SIM' ELSE 'POOL_UNASSIGNED' END, iccid = s.iccid, service_id = NULL, previous_msisdn = NULL, quarantine_until = NULL, updated_at = now()
         FROM (SELECT i2.imsi, s2.iccid FROM imsi_inventory i2 LEFT JOIN iccid_inventory s2 ON s2.imsi = i2.imsi AND s2.kind = 'PHYSICAL') s
        WHERE s.imsi = i.imsi AND (i.state <> 'POOL_UNASSIGNED' OR i.service_id IS NOT NULL OR i.iccid IS NOT NULL)`)).rowCount ?? 0;
    result.numbersReturned = (await q.query(
      `UPDATE msisdn_inventory SET state = 'AVAILABLE', previous_state = NULL, reserved_by = NULL, reserved_until = NULL, service_id = NULL, quarantine_until = NULL, updated_at = now()
        WHERE state IN ('RESERVED_CHECKOUT','ASSIGNED_ACTIVE','QUARANTINE_COOLING')`)).rowCount ?? 0;

    // things that stay but pointed at what is going
    await q.query(`UPDATE cases SET service_id = NULL WHERE service_id IS NOT NULL`);
    await q.query(`UPDATE customer_interactions SET service_id = NULL WHERE service_id IS NOT NULL`);
    await q.query(`UPDATE applications SET order_id = NULL WHERE order_id IS NOT NULL`);
    await q.query(`DELETE FROM document_signatures`);
    result.documentsDeleted = (await q.query(`DELETE FROM documents WHERE order_id IS NOT NULL OR service_id IS NOT NULL`)).rowCount ?? 0; // normally nothing left: see purgeOrderDocuments
    await q.query(`UPDATE accounts SET dunning_stage = 0 WHERE dunning_stage <> 0`);

    await q.query(`TRUNCATE TABLE ${EMPTY.join(', ')}`);
    await audit(q, o.actor, 'system', 'purge', 'PURGE_SALES_AND_CATALOG', { removed: before });
    return result;
  });
}

/**
 * Deletes the documents that belong to orders and subscriptions (signed agreements, bills) a slice at a time, because they carry file contents and a big deployment
 * has many. Call until `remaining` is 0, then run the purge.
 */
export async function purgeOrderDocuments(db: Db, limit = 1000): Promise<{ deleted: number; remaining: number }> {
  const d = await db.query(
    `WITH ids AS (SELECT id FROM documents WHERE order_id IS NOT NULL OR service_id IS NOT NULL LIMIT $1),
          sig AS (DELETE FROM document_signatures WHERE document_id IN (SELECT id FROM ids) OR signature_document_id IN (SELECT id FROM ids) RETURNING signature_document_id)
     DELETE FROM documents WHERE id IN (SELECT id FROM ids) OR id IN (SELECT signature_document_id FROM sig WHERE signature_document_id IS NOT NULL)`, [limit]);
  const left = await db.query(`SELECT count(*)::int AS n FROM documents WHERE order_id IS NOT NULL OR service_id IS NOT NULL`);
  return { deleted: d.rowCount ?? 0, remaining: Number(left.rows[0]?.n ?? 0) };
}
