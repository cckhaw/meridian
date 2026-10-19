import { audit } from './audit.js';
import type { Db, Queryable } from './db.js';
import { documentLink } from './documents.js';
import { emailSender, emailSenderStatus, sendEmail } from './email-gateway.js';
import { gatewayChannel, messagingGateway, postToGateway } from './otp-gateway.js';
import { BACKOFF_MINUTES, claimDue, markAttemptFailed, markDelivered, markFailedFor, MAX_ATTEMPTS, releaseClaim } from './outbox-retry.js';
import { getSecurityPolicy } from './security-policy.js';

/**
 * Sends the customer their signed agreement. `queueDocumentDelivery` (agreements.ts) writes a CONTRACT_SIGNED row into the outbox when the order is paid
 * (or a plan change is signed); this is its consumer. For each row it makes a fresh 15-minute link to every signed copy (the document link mechanism
 * of the vault, logged like any other) and sends one message per copy: a text message through the SMS / WhatsApp gateway to the customer's mobile number, an e-mail
 * through the e-mail sender to their address, or both in turn. The order is Settings → Security policy → E-mail codes ("Signed copies go first by"): the first channel the
 * customer can be reached on is tried, and if it fails the other one is. The document itself is not attached: the message carries the link only.
 *
 * Nothing is lost when delivery cannot happen yet: with neither a gateway nor an e-mail sender enabled, or no public address to build links from, rows stay queued
 * and untouched. A failed send (on every channel the customer has) is retried with growing waits (1, 5, 15, 60, 240 minutes); after that the row is marked failed with
 * the reason and can be retried by hand from Settings → Documents. A row records the channel that carried each copy.
 */
export const NO_SENDER = 'No SMS / WhatsApp gateway and no e-mail sender is set up in the Integration hub (Messaging), so signed copies wait in the queue.';
export const NO_ADDRESS = 'Signed-copy links need the public address of this site (Settings → Security → Password recovery), so signed copies wait in the queue.';

interface Pending { id: number; payload: { customerId: string; reference: string; documentIds: string[]; documents?: string[]; sentDocumentIds?: string[]; sentVia?: Record<string, string>; linkTtlMinutes?: number } }
type Channel = 'SMS' | 'WHATSAPP' | 'EMAIL';

export async function deliverSignedCopies(db: Db, limit = 20): Promise<{ sent: number; failed: number; gaveUp: number; waiting: number; reason: string | null }> {
  const out = { sent: 0, failed: 0, gaveUp: 0, waiting: 0, reason: null as string | null };
  const [ep, es, policy] = await Promise.all([messagingGateway(db), emailSender(db), getSecurityPolicy(db)]);
  const baseUrl = policy.recovery.publicUrl || '';
  if (!ep && !es) { out.waiting = await pendingCount(db); out.reason = out.waiting ? NO_SENDER : null; return out; }
  const rows = (await claimDue(db, 'CONTRACT_SIGNED', limit)) as unknown as Pending[];
  for (const r of rows) {
    const p = r.payload;
    let channels: Channel[] = [];
    try {
      const c = (await db.query('SELECT display_name, phone, email FROM customers WHERE id=$1', [p.customerId])).rows[0];
      if (!c) { await markFailedFor(db, r.id, 'The customer no longer exists.'); out.gaveUp++; continue; }
      const sms: Channel[] = ep && c.phone ? [gatewayChannel(ep)] : [], mail: Channel[] = es && c.email ? ['EMAIL'] : [];
      channels = policy.email.signedCopyFirst === 'EMAIL' ? [...mail, ...sms] : [...sms, ...mail];
      if (!channels.length) {
        const why = [ep && !c.phone ? 'no mobile number on file' : null, es && !c.email ? 'no e-mail address on file' : null].filter(Boolean).join(' and ');
        await markFailedFor(db, r.id, `The customer has ${why}, so no configured channel can reach them.`); out.gaveUp++; continue;
      }
      const sent = new Set(p.sentDocumentIds ?? []), via: Record<string, string> = { ...(p.sentVia ?? {}) };
      const todo = p.documentIds.filter((d) => !sent.has(d));
      let blocked = false;
      for (const docId of todo) {
        const doc = (await db.query('SELECT name, purged_at FROM documents WHERE id=$1', [docId])).rows[0];
        if (!doc || doc.purgedAt) { sent.add(docId); continue; }
        const link = await documentLink(db, docId, { username: 'system' }, { baseUrl, download: false });
        if (link.url.startsWith('/')) { blocked = true; break; }   // no public address and the file is not in a bucket: a relative link would be useless
        const minutes = Math.round(link.ttlSeconds / 60);
        const text = `Your signed agreement (${doc.name}) is ready. Open this secure link to read or save it: ${link.url} . The link works for ${minutes} minutes; after that, ask us or sign in to your account for a new one.`;
        const errors: string[] = []; let anyRetryable = false, done: Channel | null = null;
        for (const ch of channels) {
          if (ch === 'EMAIL') {
            const res = await sendEmail(db, { to: c.email, subject: 'Your signed agreement', text: `${c.displayName ? `Hello ${c.displayName},\n\n` : ''}${text}\n` });
            if (res.ok) { done = ch; break; }
            errors.push(`e-mail: ${res.error}`); anyRetryable ||= res.retryable;
          } else {
            try { await postToGateway(ep!, { to: c.phone, text, purpose: 'CONTRACT', variables: { name: c.displayName ?? null, document: doc.name, link: link.url, minutes, reference: p.reference }, reference: `outbox-${r.id}-${docId}` }); done = ch; break; }
            catch (e) { errors.push(`${ch === 'WHATSAPP' ? 'WhatsApp' : 'SMS'}: ${(e as Error).message}`); anyRetryable = true; }
          }
        }
        if (!done) { const e = new Error(errors.join('; ')) as Error & { retryable?: boolean }; e.retryable = anyRetryable; throw e; }
        sent.add(docId); via[docId] = done;
        await db.query(`UPDATE lifecycle_outbox SET payload = payload || $2::jsonb WHERE id=$1`, [r.id, JSON.stringify({ sentDocumentIds: [...sent], sentVia: via })]);   // a retry does not send the same copy twice
      }
      if (blocked) { await releaseClaim(db, r.id); out.waiting++; out.reason = NO_ADDRESS; continue; }
      const used = [...new Set(Object.values(via))];
      await markDelivered(db, r.id, { deliveredVia: used.at(-1) ?? channels[0]!, sentDocumentIds: [...sent], sentVia: via });
      await audit(db, 'system', 'document', p.documentIds[0] ?? String(r.id), 'SIGNED_COPY_SENT', { customerId: p.customerId, channels: used, copies: sent.size, reference: p.reference });
      out.sent++;
    } catch (e) {
      out.failed++;
      const msg = (e as Error).message;
      const gaveUp = (e as { retryable?: boolean }).retryable === false ? (await markFailedFor(db, r.id, msg), true) : await markAttemptFailed(db, r.id, msg);
      if (gaveUp) out.gaveUp++;
      await audit(db, 'system', 'document', p.documentIds[0] ?? String(r.id), gaveUp ? 'SIGNED_COPY_GAVE_UP' : 'SIGNED_COPY_FAILED', { customerId: p.customerId, channels, error: msg.slice(0, 200) }).catch(() => undefined);
    }
  }
  return out;
}

const pendingCount = async (q: Queryable) => Number((await q.query(`SELECT count(*) AS n FROM lifecycle_outbox WHERE instruction='CONTRACT_SIGNED' AND delivered_at IS NULL AND failed_at IS NULL`)).rows[0]!.n);

/** What Settings → Documents shows: is delivery possible right now, through which channels, and how the queue stands. */
export async function signedCopyStatus(q: Queryable) {
  const [ep, es, policy] = await Promise.all([messagingGateway(q), emailSenderStatus(q), getSecurityPolicy(q)]);
  const publicUrl = policy.recovery.publicUrl || '';
  const c = (await q.query(`SELECT count(*) FILTER (WHERE delivered_at IS NULL AND failed_at IS NULL) AS queued, count(*) FILTER (WHERE delivered_at IS NOT NULL) AS sent, count(*) FILTER (WHERE failed_at IS NOT NULL) AS failed
      FROM lifecycle_outbox WHERE instruction='CONTRACT_SIGNED'`)).rows[0]!;
  const failures = (await q.query(`SELECT id, payload->>'reference' AS reference, last_error, failed_at FROM lifecycle_outbox WHERE instruction='CONTRACT_SIGNED' AND failed_at IS NOT NULL ORDER BY failed_at DESC LIMIT 5`)).rows;
  const retrying = (await q.query(`SELECT count(*) AS n FROM lifecycle_outbox WHERE instruction='CONTRACT_SIGNED' AND delivered_at IS NULL AND failed_at IS NULL AND attempts > 0`)).rows[0]!.n;
  return {
    gateway: ep ? { configured: true, via: gatewayChannel(ep) } : { configured: false, via: null },
    email: { configured: es.enabled, mode: es.mode },
    canSend: !!ep || es.enabled,
    firstChannel: policy.email.signedCopyFirst,
    publicAddressSet: !!publicUrl,
    blocked: !ep && !es.enabled ? NO_SENDER : !publicUrl ? 'Links to signed copies are built from the public address of this site (Settings → Security → Password recovery). Until it is set, copies stored in the database wait in the queue.' : null,
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
