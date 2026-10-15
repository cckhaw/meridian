import { createHmac, randomUUID } from 'node:crypto';
import { decryptText } from './field-crypto.js';
import type { Db, Queryable, Row } from './db.js';
import { queueOutbox } from './lifecycle-state.js';

/**
 * Business events leave Meridian in two steps. The code that causes one (an order, a SIM swap, a payment) writes it to the outbox in the same transaction.
 * The dispatcher then fans it out into one delivery per outbound webhook, per TM Forum 688 listener and per mapped topic, and delivers each with its own
 * retries. A listener sees only the events it asked for, in TM Forum event shape.
 */
export type DomainEventType = 'ORDER_CREATED' | 'ORDER_CANCELLED' | 'ORDER_COMPLETED' | 'SIM_SWAPPED' | 'MSISDN_CHANGED' | 'OWNERSHIP_TRANSFERRED' | 'SERVICE_SUSPENDED' | 'SERVICE_RESUMED' | 'SERVICE_BARRED' | 'SERVICE_TERMINATED' | 'PLAN_CHANGED' | 'VAS_CHANGED' | 'PAYMENT_RECEIVED' | 'INVOICE_ISSUED';
export const EVENT_TYPES: DomainEventType[] = ['ORDER_CREATED', 'ORDER_CANCELLED', 'ORDER_COMPLETED', 'SIM_SWAPPED', 'MSISDN_CHANGED', 'OWNERSHIP_TRANSFERRED', 'SERVICE_SUSPENDED', 'SERVICE_RESUMED', 'SERVICE_BARRED', 'SERVICE_TERMINATED', 'PLAN_CHANGED', 'VAS_CHANGED', 'PAYMENT_RECEIVED', 'INVOICE_ISSUED'];

/** The TM Forum event each business event is announced as, and the resource it carries. */
export const TMF_EVENT: Record<DomainEventType, { type: string; resource: string; domain: string }> = {
  ORDER_CREATED: { type: 'ProductOrderCreateEvent', resource: 'productOrder', domain: 'productOrdering' },
  ORDER_CANCELLED: { type: 'ProductOrderStateChangeEvent', resource: 'productOrder', domain: 'productOrdering' },
  ORDER_COMPLETED: { type: 'ProductOrderStateChangeEvent', resource: 'productOrder', domain: 'productOrdering' },
  SIM_SWAPPED: { type: 'ServiceAttributeValueChangeEvent', resource: 'service', domain: 'serviceInventory' },
  MSISDN_CHANGED: { type: 'ServiceAttributeValueChangeEvent', resource: 'service', domain: 'serviceInventory' },
  OWNERSHIP_TRANSFERRED: { type: 'ServiceAttributeValueChangeEvent', resource: 'service', domain: 'serviceInventory' },
  SERVICE_SUSPENDED: { type: 'ServiceStateChangeEvent', resource: 'service', domain: 'serviceInventory' },
  SERVICE_RESUMED: { type: 'ServiceStateChangeEvent', resource: 'service', domain: 'serviceInventory' },
  SERVICE_BARRED: { type: 'ServiceStateChangeEvent', resource: 'service', domain: 'serviceInventory' },
  SERVICE_TERMINATED: { type: 'ServiceStateChangeEvent', resource: 'service', domain: 'serviceInventory' },
  PLAN_CHANGED: { type: 'ProductAttributeValueChangeEvent', resource: 'product', domain: 'productInventory' },
  VAS_CHANGED: { type: 'ProductAttributeValueChangeEvent', resource: 'product', domain: 'productInventory' },
  PAYMENT_RECEIVED: { type: 'PaymentCreateEvent', resource: 'payment', domain: 'payment' },
  INVOICE_ISSUED: { type: 'CustomerBillCreateEvent', resource: 'customerBill', domain: 'customerBillManagement' },
};

// ───────────────────────── raising an event ─────────────────────────
let gate: { at: number; wanted: Set<string> } | null = null;
/** Forget what we knew about who is listening (a subscription or mapping just changed). */
export const resetEventGate = () => { gate = null; };
/** Does anyone want this kind of event? Cached for a few seconds so high-volume events (every invoice, every payment) cost nothing when nobody listens. */
export async function eventWanted(q: Queryable, type: string): Promise<boolean> {
  if (!gate || Date.now() - gate.at > 5000) {
    const subs = (await q.query(`SELECT events FROM webhook_subscriptions WHERE kind IN ('OUTBOUND','TMF688') AND status='ACTIVE'`)).rows;
    const topics = (await q.query(`SELECT event_type FROM event_topic_mappings WHERE enabled`)).rows;
    const wanted = new Set<string>(topics.map((t) => t.eventType as string));
    for (const s of subs) { const ev = s.events as string[]; if (!ev.length) EVENT_TYPES.forEach((e) => wanted.add(e)); else ev.forEach((e) => { wanted.add(e); for (const [k, v] of Object.entries(TMF_EVENT)) if (v.type === e) wanted.add(k); }); }
    gate = { at: Date.now(), wanted };
  }
  return gate.wanted.has(type);
}
export interface EventInput { serviceId?: string | null; accountId?: string | null; resourceId?: string; payload?: Record<string, unknown> }
/** Writes a business event to the outbox in the caller's transaction. With `onlyIfWanted`, nothing is written when nobody listens. */
export async function raiseEvent(q: Queryable, type: DomainEventType, e: EventInput, o: { onlyIfWanted?: boolean } = {}): Promise<void> {
  if (o.onlyIfWanted && !(await eventWanted(q, type))) return;
  await queueOutbox(q, { kind: 'EVENT', instruction: type, serviceId: e.serviceId ?? null, accountId: e.accountId ?? null, payload: { eventType: type, resourceId: e.resourceId ?? e.serviceId ?? null, occurredAt: new Date().toISOString(), ...(e.payload ?? {}) } });
}

// ───────────────────────── the TM Forum envelope ─────────────────────────
export function tmfEnvelope(type: DomainEventType, eventId: string, payload: Record<string, any>) {
  const t = TMF_EVENT[type];
  const { eventType: _t, occurredAt, resourceId, ...rest } = payload;
  return { eventId, eventTime: occurredAt ?? new Date().toISOString(), eventType: t.type, domain: t.domain, title: type, priority: '1', correlationId: resourceId ?? undefined,
    event: { [t.resource]: { id: resourceId ?? rest.serviceId ?? rest.orderId ?? null, '@type': t.resource[0]!.toUpperCase() + t.resource.slice(1), ...rest, businessEvent: type } } };
}
const matchesQuery = (sub: Row, type: DomainEventType) => {
  const ev = sub.events as string[];
  return !ev.length || ev.includes(type) || ev.includes(TMF_EVENT[type].type);
};

// ───────────────────────── fan-out and delivery ─────────────────────────
let fanning = false;
/** Turns new outbox events into deliveries: one for every matching webhook or listener, one for every mapped topic. Safe to run often and from several servers. */
export async function fanOutEvents(db: Db, o: { limit?: number } = {}): Promise<{ events: number; deliveries: number }> {
  if (fanning) return { events: 0, deliveries: 0 };
  fanning = true;
  try {
    return await db.tx(async (q) => {
      const rows = (await q.query(`SELECT * FROM lifecycle_outbox WHERE kind='EVENT' AND delivered_at IS NULL AND instruction = ANY($1::text[]) ORDER BY id LIMIT $2 FOR UPDATE SKIP LOCKED`, [EVENT_TYPES, o.limit ?? 200])).rows;
      if (!rows.length) return { events: 0, deliveries: 0 };
      const subs = (await q.query(`SELECT * FROM webhook_subscriptions WHERE kind IN ('OUTBOUND','TMF688') AND status='ACTIVE'`)).rows;
      const topics = (await q.query(`SELECT event_type, topic FROM event_topic_mappings WHERE enabled`)).rows;
      let n = 0;
      for (const r of rows) {
        const type = r.instruction as DomainEventType;
        const eventId = randomUUID();
        const body = tmfEnvelope(type, eventId, { ...(r.payload as Record<string, unknown>), serviceId: r.serviceId, accountId: r.accountId });
        for (const s of subs) {
          if (!matchesQuery(s, type)) continue;
          await q.query(`INSERT INTO event_deliveries (event_id, event_type, tmf_type, subscription_id, payload) VALUES ($1,$2,$3,$4,$5)`, [eventId, type, TMF_EVENT[type].type, s.id, JSON.stringify(body)]); n++;
        }
        for (const t of topics) {
          if (t.eventType !== type) continue;
          await q.query(`INSERT INTO event_deliveries (event_id, event_type, tmf_type, topic, payload, status) VALUES ($1,$2,$3,$4,$5,'READY')`, [eventId, type, TMF_EVENT[type].type, t.topic, JSON.stringify(body)]); n++;
        }
        await q.query('UPDATE lifecycle_outbox SET delivered_at = now() WHERE id=$1', [r.id]);
      }
      return { events: rows.length, deliveries: n };
    });
  } finally { fanning = false; }
}

export type TopicPublisher = (topic: string, key: string, body: unknown) => Promise<void>;
let publisher: TopicPublisher | null = null;
/** Connect an event-bus producer (Kafka). Without one, topic deliveries wait as READY for a relay to read from `event_deliveries`. */
export const setTopicPublisher = (p: TopicPublisher | null) => { publisher = p; };

export interface DeliveryOptions { limit?: number; fetchImpl?: typeof fetch; nowMs?: number; timeoutMs?: number }
/** Sends what is due. A failed delivery is tried again after the subscriber's wait, doubling each time, until its retries are used up. */
export async function deliverEvents(db: Db, o: DeliveryOptions = {}): Promise<{ delivered: number; failed: number; retrying: number; published: number }> {
  const out = { delivered: 0, failed: 0, retrying: 0, published: 0 };
  const now = o.nowMs ?? Date.now();
  const rows = (await db.query(`SELECT * FROM event_deliveries WHERE status='PENDING' AND next_attempt_at <= $1 ORDER BY id LIMIT $2`, [new Date(now).toISOString(), o.limit ?? 50])).rows;
  const doFetch = o.fetchImpl ?? fetch;
  for (const d of rows) {
    const claimed = await db.query(`UPDATE event_deliveries SET attempts = attempts + 1, next_attempt_at = $2 WHERE id=$1 AND status='PENDING' AND attempts = $3`, [d.id, new Date(now + 120_000).toISOString(), d.attempts]);   // another server may have it
    if (!claimed.rowCount) continue;
    const sub = (await db.query('SELECT * FROM webhook_subscriptions WHERE id=$1', [d.subscriptionId])).rows[0];
    if (!sub || sub.status !== 'ACTIVE') { await db.query(`UPDATE event_deliveries SET status='CANCELLED' WHERE id=$1`, [d.id]); continue; }
    const body = JSON.stringify(d.payload);
    const headers: Record<string, string> = { 'content-type': 'application/json', 'user-agent': 'Meridian-Events/1', 'x-meridian-event-id': d.eventId, 'x-meridian-event-type': d.eventType };
    if (sub.authKind === 'BEARER' && sub.secretEnc) headers.authorization = `Bearer ${decryptText(sub.secretEnc)}`;
    if (sub.authKind === 'HMAC' && sub.secretEnc) { const t = Math.floor(now / 1000); headers['x-meridian-signature'] = `t=${t},v1=${createHmac('sha256', decryptText(sub.secretEnc)).update(`${t}.${body}`).digest('hex')}`; }
    let error: string | null = null, status: number | null = null;
    try {
      const res = await doFetch(sub.targetUrl, { method: 'POST', headers, body, redirect: 'manual', signal: AbortSignal.timeout(o.timeoutMs ?? 10_000) });
      status = res.status;
      if (res.status < 200 || res.status >= 300) error = `HTTP ${res.status}`;
    } catch (e) { error = (e as Error).name === 'TimeoutError' ? 'timed out' : (e as Error).message.slice(0, 200); }
    if (!error) { await db.query(`UPDATE event_deliveries SET status='DELIVERED', delivered_at=now(), response_status=$2, last_error=NULL WHERE id=$1`, [d.id, status]); out.delivered++; continue; }
    const attempt = d.attempts + 1;
    if (attempt > sub.retryMax) { await db.query(`UPDATE event_deliveries SET status='FAILED', last_error=$2, response_status=$3 WHERE id=$1`, [d.id, error, status]); out.failed++; }
    else {
      const wait = Math.min(86_400, sub.retryBackoffSeconds * 2 ** (attempt - 1));
      await db.query(`UPDATE event_deliveries SET last_error=$2, response_status=$3, next_attempt_at=$4 WHERE id=$1`, [d.id, error, status, new Date(now + wait * 1000).toISOString()]);
      out.retrying++;
    }
  }
  if (publisher) {
    const ready = (await db.query(`SELECT * FROM event_deliveries WHERE status='READY' ORDER BY id LIMIT $1`, [o.limit ?? 50])).rows;
    for (const d of ready) {
      try { await publisher(d.topic, d.eventId, d.payload); await db.query(`UPDATE event_deliveries SET status='DELIVERED', delivered_at=now(), attempts=attempts+1 WHERE id=$1`, [d.id]); out.published++; }
      catch (e) { await db.query(`UPDATE event_deliveries SET attempts=attempts+1, last_error=$2 WHERE id=$1`, [d.id, (e as Error).message.slice(0, 200)]); }
    }
  }
  return out;
}
/** Fan out, then deliver. This is what the daily job and the "dispatch now" button run, and what a mutating northbound call kicks off. */
export async function dispatchEvents(db: Db, o: DeliveryOptions = {}) {
  const fan = await fanOutEvents(db, { limit: o.limit });
  return { ...fan, ...(await deliverEvents(db, o)) };
}
export async function listDeliveries(q: Queryable, f: { status?: string; subscriptionId?: string; limit?: number } = {}): Promise<Row[]> {
  const w: string[] = [], a: unknown[] = [];
  if (f.status) { a.push(f.status); w.push(`status=$${a.length}`); }
  if (f.subscriptionId) { a.push(f.subscriptionId); w.push(`subscription_id=$${a.length}`); }
  return (await q.query(`SELECT id, event_id, event_type, tmf_type, subscription_id, topic, status, attempts, next_attempt_at, last_error, response_status, created_at, delivered_at FROM event_deliveries ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY id DESC LIMIT ${Math.min(f.limit ?? 50, 200)}`, a)).rows;
}
/** Puts a failed delivery back in the queue. */
export async function retryDelivery(q: Queryable, id: number) {
  const r = await q.query(`UPDATE event_deliveries SET status='PENDING', attempts=0, next_attempt_at=now(), last_error=NULL WHERE id=$1 AND status IN ('FAILED','CANCELLED') RETURNING id`, [id]);
  return { ok: !!r.rowCount };
}
