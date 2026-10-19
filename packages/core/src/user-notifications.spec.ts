import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { changePassword, createUser, login } from './auth.js';
import type { SessionUser } from './auth.js';
import type { Db } from './db.js';
import { saveHubEndpoint } from './integration-hub.js';
import { setOtpHttp } from './otp-gateway.js';
import { deliverUserAlerts, listMyNotifications, markAllNotificationsRead, markNotificationRead, notificationChannelStatus, notifyUser } from './user-notifications.js';
import { freshDb } from './test-helpers.js';

let db: Db;
let calls: Array<{ body: any }> = [];
let status = 200;
const PW = 'Str0ng!Passw0rd#1';
beforeAll(async () => { db = await freshDb(); });
afterAll(async () => { await db.close(); setOtpHttp(null); });
beforeEach(() => { calls = []; status = 200; setOtpHttp(async (_u, init) => { calls.push({ body: JSON.parse(String(init!.body)) }); return new Response('{}', { status }); }); });

let n = 0;
const newUser = async (prefs?: unknown) => {
  const username = `alert.user${++n}`;
  const { user } = await createUser(db, 'admin', { username, displayName: 'Alert User', roles: ['call-center'], email: `${username}@example.com`, phone: '+6591234567', password: PW });
  if (prefs) await db.query('UPDATE users SET notification_prefs=$2 WHERE id=$1', [user.id, JSON.stringify(prefs)]);
  await db.query('UPDATE users SET must_change_password=false WHERE id=$1', [user.id]);
  return { id: user.id as string, username };
};
const outbox = async (userId: string) => (await db.query(`SELECT * FROM lifecycle_outbox WHERE instruction='USER_ALERT' AND payload->>'userId'=$1 ORDER BY id`, [userId])).rows;
let gw = false;
const addGateway = async () => { if (gw) return; gw = true; await saveHubEndpoint(db, 'admin', { group: 'auth', kind: 'OTP_GATEWAY', name: 'Gateway', url: 'https://sms.example.com/send', secret: 'tok', config: { deliver: 'SMS' } }); };

describe('profile notification preferences are honoured', () => {
  it('uses the defaults the screen shows: in the app and e-mail on, SMS off, and says there is no SMS gateway', async () => {
    const u = await newUser();
    const r = await notifyUser(db, { id: u.id }, 'securityAlerts', { title: 'T', body: 'B' });
    expect(r).toEqual({ inApp: true, sms: false, email: true });
    expect((await listMyNotifications(db, u.id)).unread).toBe(1);
    expect(await notificationChannelStatus(db)).toMatchObject({ sms: { available: false, via: null } });
  });
  it('respects each channel and each kind of alert', async () => {
    await addGateway();
    const all = await newUser({ channels: { email: true, sms: true, push: true } });
    expect(await notifyUser(db, { id: all.id }, 'securityAlerts', { title: 'T', body: 'B' })).toEqual({ inApp: true, sms: true, email: true });
    const smsOnly = await newUser({ channels: { email: false, sms: true, push: false } });
    expect(await notifyUser(db, { id: smsOnly.id }, 'securityAlerts', { title: 'T', body: 'B' })).toEqual({ inApp: false, sms: true, email: false });
    expect((await listMyNotifications(db, smsOnly.id)).items).toHaveLength(0);
    const off = await newUser({ events: { securityAlerts: false } });
    expect(await notifyUser(db, { id: off.id }, 'securityAlerts', { title: 'T', body: 'B' })).toEqual({ inApp: false, sms: false, email: false });
    expect(await notifyUser(db, { id: off.id }, 'caseAssigned', { title: 'T', body: 'B' })).toMatchObject({ inApp: true });
    const noPhone = await newUser({ channels: { sms: true } });
    await db.query('UPDATE users SET phone=NULL WHERE id=$1', [noPhone.id]);
    expect((await notifyUser(db, { id: noPhone.id }, 'securityAlerts', { title: 'T', body: 'B' })).sms).toBe(false);
    expect(await notificationChannelStatus(db)).toMatchObject({ sms: { available: true, via: 'SMS' } });
  });
  it('sends the text message through the gateway to the profile number, with no secrets in it, and retries when the gateway is down', async () => {
    await addGateway();
    const u = await newUser({ channels: { sms: true, email: false, push: false } });
    await notifyUser(db, { id: u.id }, 'securityAlerts', { title: 'Password changed', body: 'Your password was changed.' });
    status = 503;
    expect(await deliverUserAlerts(db)).toEqual({ sent: 0, failed: 1 });
    const row = (await outbox(u.id))[0]!;
    expect(row).toMatchObject({ attempts: 1, deliveredAt: null, lastError: expect.stringContaining('503') });
    expect(new Date(row.nextAttemptAt).getTime()).toBeGreaterThan(Date.now());
    expect(await deliverUserAlerts(db)).toEqual({ sent: 0, failed: 0 });   // waits for its backoff
    await db.query('UPDATE lifecycle_outbox SET next_attempt_at = now() - interval \'1 second\' WHERE id=$1', [row.id]);
    status = 200;
    expect(await deliverUserAlerts(db)).toEqual({ sent: 1, failed: 0 });
    expect(calls.at(-1)!.body).toMatchObject({ to: '+6591234567', channel: 'SMS', text: 'Password changed. Your password was changed.' });
    expect((await outbox(u.id))[0]).toMatchObject({ payload: { deliveredVia: 'SMS' } });
  });
  it('gives up after the last attempt and marks the row failed', async () => {
    await addGateway(); status = 500;
    const u = await newUser({ channels: { sms: true, email: false, push: false } });
    await notifyUser(db, { id: u.id }, 'systemAlerts', { title: 'T', body: 'B' });
    for (let i = 0; i < 8; i++) { await db.query(`UPDATE lifecycle_outbox SET next_attempt_at = NULL WHERE payload->>'userId'=$1`, [u.id]); await deliverUserAlerts(db); }
    expect((await outbox(u.id))[0]).toMatchObject({ attempts: 6, failedAt: expect.anything(), deliveredAt: null });
  });
});

describe('the in-app inbox', () => {
  it('lists newest first, marks one or all read, and only for its owner', async () => {
    const a = await newUser(), b = await newUser();
    await notifyUser(db, { id: a.id }, 'caseAssigned', { title: 'First', body: '1' });
    await notifyUser(db, { id: a.id }, 'caseUpdates', { title: 'Second', body: '2', link: '/cases/1' });
    const list = await listMyNotifications(db, a.id);
    expect(list.items.map((i) => i.title)).toEqual(['Second', 'First']);
    expect(list.unread).toBe(2);
    await expect(markNotificationRead(db, b.id, list.items[0]!.id)).rejects.toThrow();
    await markNotificationRead(db, a.id, list.items[0]!.id);
    expect((await listMyNotifications(db, a.id)).unread).toBe(1);
    expect(await markAllNotificationsRead(db, a.id)).toEqual({ marked: 1 });
  });
});

describe('alerts raised by the system', () => {
  it('a sign-in from a new device and a password change reach the person; a failing gateway never breaks either', async () => {
    await addGateway();
    const u = await newUser({ channels: { sms: true, email: false, push: true } });
    const first = await login(db, { username: u.username, password: PW, userAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/120.0 Safari/537.36' });
    expect((await listMyNotifications(db, u.id)).items).toHaveLength(0);   // the very first sign-in is not "new"
    await login(db, { username: u.username, password: PW, userAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/121.0 Safari/537.36' });
    expect((await listMyNotifications(db, u.id)).items).toHaveLength(0);   // same browser and system
    status = 503;                                                           // the gateway is down from here on
    const second = await login(db, { username: u.username, password: PW, ip: '203.0.113.9', userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari/604.1' });
    expect(second.token).toBeTruthy();
    const items = (await listMyNotifications(db, u.id)).items;
    expect(items.map((i) => i.title)).toEqual(['New sign-in']);
    expect(items[0]!.body).toMatch(/Safari on iOS/);
    expect(JSON.stringify(items)).not.toContain(PW);
    expect((await outbox(u.id)).at(-1)).toMatchObject({ attempts: 1, deliveredAt: null });   // queued for another try

    const su = { id: u.id, username: u.username, isSuperuser: false } as unknown as SessionUser;
    await changePassword(db, su, PW, 'N3w!Passw0rd#2Better');
    expect((await listMyNotifications(db, u.id)).items.map((i) => i.title)).toContain('Password changed');
    expect(first.token).not.toEqual(second.token);
  });
  it('does not alert someone who has switched security alerts off', async () => {
    const u = await newUser({ events: { securityAlerts: false } });
    await login(db, { username: u.username, password: PW, userAgent: 'Firefox/120.0 Windows' });
    await login(db, { username: u.username, password: PW, userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X) Safari/605 Chrome/1' });
    expect((await listMyNotifications(db, u.id)).items).toHaveLength(0);
  });
});
