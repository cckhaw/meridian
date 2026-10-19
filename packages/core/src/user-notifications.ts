import { audit } from './audit.js';
import type { Db, Queryable, Row } from './db.js';
import { notFound } from './errors.js';
import { messagingGateway, gatewayChannel, postToGateway } from './otp-gateway.js';
import { claimDue, markAttemptFailed, markDelivered } from './outbox-retry.js';
import { notificationPrefs, type NotificationPrefs } from './profile.js';

/**
 * The alerts My profile → Notifications lets a person switch on and off. `notifyUser` honours their choices per kind of alert and per channel:
 *  - In the app: a row in `user_notifications`, shown in the bell and on the Notifications tab.
 *  - SMS: a message through the SMS / WhatsApp gateway of the Integration hub (the same one that carries one-time codes), sent to the mobile number on the profile.
 *    Without a gateway nothing is queued, and the tab says so.
 *  - E-mail: a NOTIFY instruction (USER_ALERT, channel EMAIL) in the outbox, like every other e-mail the system raises; whatever delivers e-mail at the operator sends it.
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
    if (r.sms && typeof db.tx === 'function') {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([deliverUserAlerts(db), new Promise<void>((res) => { timer = setTimeout(res, 4000); timer.unref?.(); })]).finally(() => clearTimeout(timer));
    }
  } catch (e) { console.error('[notify] alert delivery failed', (e as Error).message); }
}

/** Sends the queued text-message alerts through the gateway. A failure waits and tries again later (see outbox-retry.ts); after the last try the row is marked failed. */
export async function deliverUserAlerts(db: Db, limit = 25): Promise<{ sent: number; failed: number }> {
  const ep = await messagingGateway(db);
  if (!ep) return { sent: 0, failed: 0 };
  const rows = await claimDue(db, 'USER_ALERT', limit, `AND payload->>'channel'='SMS'`);
  let sent = 0, failed = 0;
  for (const r of rows) {
    const p = r.payload as { to: string; text: string; title: string; event: string };
    try {
      await postToGateway(ep, { to: p.to, text: p.text, purpose: 'ALERT', variables: { title: p.title, event: p.event, text: p.text }, reference: `outbox-${r.id}` });
      await markDelivered(db, r.id, { deliveredVia: gatewayChannel(ep) });
      sent++;
    } catch (e) {
      failed++;
      const gaveUp = await markAttemptFailed(db, r.id, (e as Error).message);
      await audit(db, 'notifications', 'user', String(r.payload.userId ?? r.id), gaveUp ? 'ALERT_DELIVERY_GAVE_UP' : 'ALERT_DELIVERY_FAILED', { channel: gatewayChannel(ep), error: (e as Error).message.slice(0, 200) }).catch(() => undefined);
    }
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
export async function notificationChannelStatus(q: Queryable): Promise<{ inApp: true; sms: { available: boolean; via: 'SMS' | 'WHATSAPP' | null }; email: { available: boolean; note: string } }> {
  const ep = await messagingGateway(q);
  return { inApp: true, sms: { available: !!ep, via: ep ? gatewayChannel(ep) : null }, email: { available: false, note: 'E-mail alerts are queued in the notification outbox for the connector your administrator has set up to send e-mail.' } };
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
