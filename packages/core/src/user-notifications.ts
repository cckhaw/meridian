import { audit } from './audit.js';
import type { Db, Queryable, Row } from './db.js';
import { emailSender, emailSenderStatus, sendEmail } from './email-gateway.js';
import { notFound } from './errors.js';
import { messagingGateway, gatewayChannel, postToGateway } from './otp-gateway.js';
import { claimDue, markAttemptFailed, markDelivered, markFailedFor } from './outbox-retry.js';
import { notificationPrefs, type NotificationPrefs } from './profile.js';

/**
 * The alerts My profile → Notifications lets a person switch on and off. `notifyUser` honours their choices per kind of alert and per channel:
 *  - In the app: a row in `user_notifications`, shown in the bell and on the Notifications tab.
 *  - SMS: a message through the SMS / WhatsApp gateway of the Integration hub (the same one that carries one-time codes), sent to the mobile number on the profile.
 *    Without a gateway nothing is queued, and the tab says so.
 *  - E-mail: a NOTIFY instruction (USER_ALERT, channel EMAIL) in the outbox, sent through the e-mail sender of the Integration hub (the same retry and back-off as SMS).
 *    Without an enabled e-mail sender the row stays queued untouched, and goes out once one is set up.
 * Alerts never carry codes, links or passwords. A failure here is logged and swallowed: it must never break the action that raised the alert.
 */
export type AlertEvent = keyof NotificationPrefs['events'];
export const ALERT_EVENTS: AlertEvent[] = ['caseAssigned', 'caseUpdates', 'systemAlerts', 'securityAlerts'];
export interface Alert { title: string; body: string; link?: string }
type Who = { id: string } | { username: string };

export async function notifyUser(q: Queryable, who: Who, event: AlertEvent, a: Alert): Promise<{ inApp: boolean; sms: boolean; email: boolean }> {
  const none = { inApp: false, sms: false, email: false };
  try {
    const u = (await q.query(`SELECT id, username, email, phone, notification_prefs FROM users WHERE ${'id' in who ? 'id=$1' : 'username=$1'} AND status='ACTIVE' AND NOT is_superuser`, ['id' in who ? who.id : who.username])).rows[0];
    if (!u) return none;
    const prefs = notificationPrefs(u.notificationPrefs);
    if (!prefs.events[event]) return none;
    const out = { ...none };
    if (prefs.channels.push) {
      await q.query('INSERT INTO user_notifications (user_id, event, title, body, link) VALUES ($1,$2,$3,$4,$5)', [u.id, event, a.title.slice(0, 160), a.body.slice(0, 500), a.link ?? null]);
      out.inApp = true;
    }
    const text = `${a.title}. ${a.body}`.slice(0, 300);
    if (prefs.channels.sms && u.phone && (await messagingGateway(q))) {
      await q.query(`INSERT INTO lifecycle_outbox (kind, instruction, payload) VALUES ('NOTIFY','USER_ALERT',$1)`, [JSON.stringify({ channel: 'SMS', userId: u.id, to: u.phone, event, title: a.title, text })]);
      out.sms = true;
    }
    if (prefs.channels.email && u.email) {
      await q.query(`INSERT INTO lifecycle_outbox (kind, instruction, payload) VALUES ('NOTIFY','USER_ALERT',$1)`, [JSON.stringify({ channel: 'EMAIL', userId: u.id, to: u.email, event, title: a.title, text: a.body })]);
      out.email = true;
    }
    return out;
  } catch (e) {
    console.error('[notify] could not raise an alert', (e as Error).message);
    return none;
  }
}

/**
 * Raises an alert after the action that caused it has committed, and hands any text message to the gateway at once (waiting no longer than a few seconds;
 * what is not delivered by then is retried by `deliverUserAlerts`). Never throws.
 */
export async function raiseUserAlert(q: Queryable, who: Who, event: AlertEvent, a: Alert): Promise<void> {
  try {
    const r = await notifyUser(q, who, event, a);
    const db = q as Db;
    if ((r.sms || r.email) && typeof db.tx === 'function') {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([deliverUserAlerts(db), new Promise<void>((res) => { timer = setTimeout(res, 4000); timer.unref?.(); })]).finally(() => clearTimeout(timer));
    }
  } catch (e) { console.error('[notify] alert delivery failed', (e as Error).message); }
}

/**
 * Sends the queued alerts: text messages through the SMS / WhatsApp gateway, e-mails through the e-mail sender. A channel with nothing behind it is left alone.
 * A failure waits and tries again later (see outbox-retry.ts); after the last try, or at once when the e-mail sender says another try cannot help (a bad address), the row is marked failed.
 */
export async function deliverUserAlerts(db: Db, limit = 25): Promise<{ sent: number; failed: number }> {
  const [ep, es] = await Promise.all([messagingGateway(db), emailSender(db)]);
  const channels = [...(ep ? ['SMS'] : []), ...(es ? ['EMAIL'] : [])];
  if (!channels.length) return { sent: 0, failed: 0 };
  const rows = await claimDue(db, 'USER_ALERT', limit, `AND payload->>'channel' IN (${channels.map((c) => `'${c}'`).join(',')})`);
  let sent = 0, failed = 0;
  for (const r of rows) {
    const p = r.payload as { to: string; text: string; title: string; event: string; channel?: string };
    const email = p.channel === 'EMAIL';
    const via = email ? 'EMAIL' : gatewayChannel(ep!);
    let error: string | null = null, retryable = true;
    if (email) {
      const res = await sendEmail(db, { to: p.to, subject: p.title.slice(0, 150), text: `${p.text}\n\nYou get this alert because of your settings in My profile, Notifications.` });
      if (!res.ok) { error = res.error ?? 'The e-mail was not sent.'; retryable = res.retryable; }
    } else {
      try { await postToGateway(ep!, { to: p.to, text: p.text, purpose: 'ALERT', variables: { title: p.title, event: p.event, text: p.text }, reference: `outbox-${r.id}` }); } catch (e) { error = (e as Error).message; }
    }
    if (error === null) { await markDelivered(db, r.id, { deliveredVia: via }); sent++; continue; }
    failed++;
    const gaveUp = retryable ? await markAttemptFailed(db, r.id, error) : (await markFailedFor(db, r.id, error), true);
    await audit(db, 'notifications', 'user', String(r.payload.userId ?? r.id), gaveUp ? 'ALERT_DELIVERY_GAVE_UP' : 'ALERT_DELIVERY_FAILED', { channel: via, error: error.slice(0, 200) }).catch(() => undefined);
  }
  return { sent, failed };
}

// ───────────────────────── the in-app inbox ─────────────────────────
export interface InboxItem { id: string; event: AlertEvent; title: string; body: string; link: string | null; createdAt: string; read: boolean }
const itemOf = (r: Row): InboxItem => ({ id: r.id, event: r.event, title: r.title, body: r.body, link: r.link, createdAt: String(r.createdAt), read: !!r.readAt });
export async function listMyNotifications(q: Queryable, userId: string, o: { limit?: number; unreadOnly?: boolean } = {}): Promise<{ items: InboxItem[]; unread: number }> {
  const rows = (await q.query(`SELECT * FROM user_notifications WHERE user_id=$1 ${o.unreadOnly ? 'AND read_at IS NULL' : ''} ORDER BY created_at DESC, id LIMIT $2`, [userId, Math.min(Math.max(o.limit ?? 30, 1), 100)])).rows;
  const unread = Number((await q.query('SELECT count(*) AS n FROM user_notifications WHERE user_id=$1 AND read_at IS NULL', [userId])).rows[0]!.n);
  return { items: rows.map(itemOf), unread };
}
export async function markNotificationRead(q: Queryable, userId: string, id: string): Promise<void> {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw notFound('notification', id);
  const r = await q.query('UPDATE user_notifications SET read_at = COALESCE(read_at, now()) WHERE id=$1 AND user_id=$2', [id, userId]);
  if (!r.rowCount) throw notFound('notification', id);
}
export async function markAllNotificationsRead(q: Queryable, userId: string): Promise<{ marked: number }> {
  return { marked: (await q.query('UPDATE user_notifications SET read_at = now() WHERE user_id=$1 AND read_at IS NULL', [userId])).rowCount };
}

/** What the Notifications tab can honestly promise: which channels have something behind them right now. */
export async function notificationChannelStatus(q: Queryable): Promise<{ inApp: true; sms: { available: boolean; via: 'SMS' | 'WHATSAPP' | null }; email: { available: boolean; via: 'API' | 'SMTP' | 'SIMULATOR' | null; note: string } }> {
  const [ep, es] = await Promise.all([messagingGateway(q), emailSenderStatus(q)]);
  const email = !es.enabled ? { available: false, via: null, note: 'No e-mail sender is set up, so e-mail alerts wait in the notification outbox. Ask your administrator to add one under Integration, Messaging.' }
    : es.mode === 'SIMULATOR' ? { available: false, via: es.mode, note: 'The e-mail sender is the simulator, which sends nothing, so no e-mail reaches anyone. Ask your administrator to set up a real sender under Integration, Messaging.' }
    : { available: true, via: es.mode, note: `A short e-mail to the address on your profile, through the e-mail sender your administrator set up (${es.mode === 'SMTP' ? 'SMTP' : 'HTTPS API'}). It never carries codes, links or passwords.` };
  return { inApp: true, sms: { available: !!ep, via: ep ? gatewayChannel(ep) : null }, email };
}

/** A system notice (an outage, planned maintenance) to every active staff member who has system alerts on. */
export async function broadcastSystemAlert(db: Db, actor: string, a: Alert): Promise<{ recipients: number }> {
  const ids = (await db.query(`SELECT id FROM users WHERE status='ACTIVE' AND NOT is_superuser ORDER BY created_at LIMIT 5000`)).rows.map((r) => r.id as string);
  let recipients = 0;
  for (const id of ids) { const r = await notifyUser(db, { id }, 'systemAlerts', a); if (r.inApp || r.sms || r.email) recipients++; }
  await audit(db, actor, 'notification', 'system', 'SYSTEM_ALERT_SENT', { title: a.title, recipients });
  try { await deliverUserAlerts(db); } catch { /* retried by the scheduler */ }
  return { recipients };
}
