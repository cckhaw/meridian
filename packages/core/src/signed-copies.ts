import { audit } from './audit.js';
import type { Db, Queryable } from './db.js';
import { documentLink } from './documents.js';
import { gatewayChannel, messagingGateway, postToGateway } from './otp-gateway.js';
import { BACKOFF_MINUTES, claimDue, markAttemptFailed, markDelivered, markFailedFor, MAX_ATTEMPTS, releaseClaim } from './outbox-retry.js';
import { getSecurityPolicy } from './security-policy.js';

/**
 * Sends the customer their signed agreement. `queueDocumentDelivery` (agreements.ts) writes a CONTRACT_SIGNED row into the outbox when the order is paid
 * (or a plan change is signed); this is its consumer. For each row it makes a fresh 15-minute link to every signed copy (the document link mechanism
 * of the vault, logged like any other) and posts one message per copy to the SMS / WhatsApp gateway of the Integration hub, to the customer's mobile number.
 * The document itself is not attached: the gateway contract carries text only.
 *
 * Nothing is lost when delivery cannot happen yet: with no enabled gateway, or no public address to build links from, rows stay queued and untouched.
 * A refused or failed send is retried with growing waits (1, 5, 15, 60, 240 minutes); after that the row is marked failed with the reason and can be
 * retried by hand from Settings → Documents.
 */
export const NO_GATEWAY = 'No SMS / WhatsApp gateway is set up in the Integration hub (Sign-in and identity), so signed copies wait in the queue.';
export const NO_ADDRESS = 'Signed-copy links need the public address of this site (Settings → Security → Password recovery), so signed copies wait in the queue.';

interface Pending { id: number; payload: { customerId: string; reference: string; documentIds: string[]; documents?: string[]; sentDocumentIds?: string[]; linkTtlMinutes?: number } }

export async function deliverSignedCopies(db: Db, limit = 20): Promise<{ sent: number; failed: number; gaveUp: number; waiting: number; reason: string | null }> {
  const out = { sent: 0, failed: 0, gaveUp: 0, waiting: 0, reason: null as string | null };
  const ep = await messagingGateway(db);
  const baseUrl = (await getSecurityPolicy(db)).recovery.publicUrl || '';
  if (!ep) { out.waiting = await pendingCount(db); out.reason = out.waiting ? NO_GATEWAY : null; return out; }
  const channel = gatewayChannel(ep);
  const rows = (await claimDue(db, 'CONTRACT_SIGNED', limit)) as unknown as Pending[];
  for (const r of rows) {
    const p = r.payload;
    try {
      const c = (await db.query('SELECT display_name, phone FROM customers WHERE id=$1', [p.customerId])).rows[0];
      if (!c?.phone) { await markFailedFor(db, r.id, 'The customer has no mobile number on file, and there is no e-mail sender to use instead.'); out.gaveUp++; continue; }
      const sent = new Set(p.sentDocumentIds ?? []);
      const todo = p.documentIds.filter((d) => !sent.has(d));
      let blocked = false;
      for (const docId of todo) {
        const doc = (await db.query('SELECT name, purged_at FROM documents WHERE id=$1', [docId])).rows[0];
        if (!doc || doc.purgedAt) { sent.add(docId); continue; }
        const link = await documentLink(db, docId, { username: 'system' }, { baseUrl, download: false });
        if (link.url.startsWith('/')) { blocked = true; break; }   // no public address and the file is not in a bucket: a relative link would be useless
        const minutes = Math.round(link.ttlSeconds / 60);
        const text = `Your signed agreement (${doc.name}) is ready. Open this secure link to read or save it: ${link.url} . The link works for ${minutes} minutes; after that, ask us or sign in to your account for a new one.`;
        await postToGateway(ep, { to: c.phone, text, purpose: 'CONTRACT', variables: { name: c.displayName ?? null, document: doc.name, link: link.url, minutes, reference: p.reference }, reference: `outbox-${r.id}-${docId}` });
        sent.add(docId);
        await db.query(`UPDATE lifecycle_outbox SET payload = payload || $2::jsonb WHERE id=$1`, [r.id, JSON.stringify({ sentDocumentIds: [...sent] })]);   // a retry does not send the same copy twice
      }
      if (blocked) { await releaseClaim(db, r.id); out.waiting++; out.reason = NO_ADDRESS; continue; }
      await markDelivered(db, r.id, { deliveredVia: channel, sentDocumentIds: [...sent] });
      await audit(db, 'system', 'document', p.documentIds[0] ?? String(r.id), 'SIGNED_COPY_SENT', { customerId: p.customerId, channel, copies: sent.size, reference: p.reference });
      out.sent++;
    } catch (e) {
      out.failed++;
      const msg = (e as Error).message;
      const gaveUp = await markAttemptFailed(db, r.id, msg);
      if (gaveUp) out.gaveUp++;
      await audit(db, 'system', 'document', p.documentIds[0] ?? String(r.id), gaveUp ? 'SIGNED_COPY_GAVE_UP' : 'SIGNED_COPY_FAILED', { customerId: p.customerId, channel, error: msg.slice(0, 200) }).catch(() => undefined);
    }
  }
  return out;
}

const pendingCount = async (q: Queryable) => Number((await q.query(`SELECT count(*) AS n FROM lifecycle_outbox WHERE instruction='CONTRACT_SIGNED' AND delivered_at IS NULL AND failed_at IS NULL`)).rows[0]!.n);

/** What Settings → Documents shows: is delivery possible right now, and how the queue stands. */
export async function signedCopyStatus(q: Queryable) {
  const ep = await messagingGateway(q);
  const publicUrl = (await getSecurityPolicy(q)).recovery.publicUrl || '';
  const c = (await q.query(`SELECT count(*) FILTER (WHERE delivered_at IS NULL AND failed_at IS NULL) AS queued, count(*) FILTER (WHERE delivered_at IS NOT NULL) AS sent, count(*) FILTER (WHERE failed_at IS NOT NULL) AS failed
      FROM lifecycle_outbox WHERE instruction='CONTRACT_SIGNED'`)).rows[0]!;
  const failures = (await q.query(`SELECT id, payload->>'reference' AS reference, last_error, failed_at FROM lifecycle_outbox WHERE instruction='CONTRACT_SIGNED' AND failed_at IS NOT NULL ORDER BY failed_at DESC LIMIT 5`)).rows;
  const retrying = (await q.query(`SELECT count(*) AS n FROM lifecycle_outbox WHERE instruction='CONTRACT_SIGNED' AND delivered_at IS NULL AND failed_at IS NULL AND attempts > 0`)).rows[0]!.n;
  return {
    gateway: ep ? { configured: true, via: gatewayChannel(ep) } : { configured: false, via: null },
    publicAddressSet: !!publicUrl,
    blocked: !ep ? NO_GATEWAY : !publicUrl ? 'Links to signed copies are built from the public address of this site (Settings → Security → Password recovery). Until it is set, copies stored in the database wait in the queue.' : null,
    queued: Number(c.queued), sent: Number(c.sent), failed: Number(c.failed), retrying: Number(retrying),
    attempts: MAX_ATTEMPTS, backoffMinutes: BACKOFF_MINUTES,
    recentFailures: failures.map((f) => ({ id: String(f.id), reference: f.reference, reason: f.lastError, at: String(f.failedAt) })),
  };
}
/** Puts failed signed-copy messages back in the queue (for example after the customer's number was corrected or the gateway fixed). */
export async function retryFailedSignedCopies(db: Db, actor: string): Promise<{ requeued: number }> {
  const r = await db.query(`UPDATE lifecycle_outbox SET failed_at = NULL, attempts = 0, next_attempt_at = NULL, last_error = NULL WHERE instruction='CONTRACT_SIGNED' AND failed_at IS NOT NULL AND delivered_at IS NULL`);
  await audit(db, actor, 'document', 'delivery', 'SIGNED_COPY_RETRY', { requeued: r.rowCount });
  return { requeued: r.rowCount };
}
