import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { changePassword, createUser, listUsers, login, logout, publicUser, RateLimited, resetPassword, unlockUser, updateUser, validateSession } from './auth.js';
import type { Db } from './db.js';
import { passwordProblem } from './passwords.js';
import { getRegional, setMarketSettings } from './settings.js';
import { ALL_PERMISSIONS, creditLimitOf, homeOf, MODULES, modulesOf, permissionsOf, ROLES, ROLE_IDS, scopeOf } from './rbac.js';
import { freshDb, newCustomer } from './test-helpers.js';

const SU = { username: 'root-admin', password: 'Correct-Horse-Battery-9' };
let db: Db;
beforeAll(async () => { db = await freshDb(); });
afterAll(async () => { await db.close(); });
beforeEach(() => { process.env.MERIDIAN_SUPERUSER_USERNAME = SU.username; process.env.MERIDIAN_SUPERUSER_PASSWORD = SU.password; });
afterEach(async () => { await db.query('DELETE FROM auth_attempts'); });

describe('role matrix', () => {
  it('only references real permissions and every module is reachable by some role', () => {
    for (const id of ROLE_IDS) for (const p of ROLES[id].permissions) expect(ALL_PERMISSIONS).toContain(p);
    // Settings is the one module reserved for the environment-defined super user (see the test below).
    for (const m of MODULES.filter((x) => x.id !== 'settings' && x.id !== 'integrations')) expect(ROLE_IDS.some((r) => m.anyOf.some((p) => ROLES[r].permissions.includes(p))), m.id).toBe(true);
  });
  it('keeps settings:manage (currency, branding, payment gateways, API keys) with the super user only', () => {
    for (const id of ROLE_IDS) expect(ROLES[id].permissions as string[], id).not.toContain('settings:manage');
    expect(permissionsOf({ isSuperuser: true, roles: [] }).has('settings:manage')).toBe(true);
  });
  it('encodes the separation of duties that matter', () => {
    const has = (r: (typeof ROLE_IDS)[number], p: string) => (ROLES[r].permissions as string[]).includes(p);
    expect(has('admin', 'billing:credit')).toBe(false);          // administrators cannot move money
    expect(has('admin', 'billing:pay')).toBe(false);
    expect(has('call-center', 'billing:credit')).toBe(false);
    expect(has('call-center', 'service:terminate')).toBe(false); // escalate to customer service
    expect(has('customer-service', 'finance:export')).toBe(false);
    expect(has('finance', 'order:create:SELF_SERVE')).toBe(false);
    expect(has('dealer', 'order:create:RETAIL_ASSISTED')).toBe(false);
    expect(has('retail-store', 'order:create:DEALER')).toBe(false);
    expect(has('self-serve', 'customer:search')).toBe(false);    // a customer can never list other customers
    expect(has('self-serve', 'service:manage')).toBe(false);
  });
  it('resolves scope, credit limits, home and navigation per user', () => {
    expect(scopeOf({ isSuperuser: false, roles: ['retail-store'], storeId: 'S1' })).toMatchObject({ storeId: 'S1', unrestricted: false });
    expect(scopeOf({ isSuperuser: false, roles: ['retail-store'] }).storeId).toBe('\u0000none'); // missing binding fails closed
    expect(scopeOf({ isSuperuser: false, roles: ['retail-store', 'call-center'], storeId: 'S1' }).unrestricted).toBe(true);
    expect(scopeOf({ isSuperuser: true, roles: [] }).unrestricted).toBe(true);
    expect(creditLimitOf({ isSuperuser: false, roles: ['call-center'] })).toBe(0);
    expect(creditLimitOf({ isSuperuser: false, roles: ['customer-service'] })).toBe(20_000);
    expect(creditLimitOf({ isSuperuser: false, roles: ['customer-service', 'finance'] })).toBeNull();
    expect(homeOf({ isSuperuser: false, roles: ['call-center'] })).toBe('/customers');
    expect(modulesOf({ isSuperuser: false, roles: ['call-center'] }).map((m) => m.id)).toEqual(expect.arrayContaining(['customers', 'cases', 'sell']));
    expect(modulesOf({ isSuperuser: false, roles: ['call-center'] }).map((m) => m.id)).not.toContain('finance');
    expect(modulesOf({ isSuperuser: false, roles: ['self-serve'], customerId: 'c' })[0]).toMatchObject({ id: 'account', href: '/account' });
    expect(permissionsOf({ isSuperuser: true, roles: [] }).size).toBe(ALL_PERMISSIONS.length);
  });
});

describe('passwords', () => {
  it('enforces length, blocklist and username rules', () => {
    expect(passwordProblem('short')).toMatch(/12/);
    expect(passwordProblem('Password1234!')).toBeNull();
    expect(passwordProblem('changemechangeme')).toBeNull(); // not exact blocklist match, but length-ok
    expect(passwordProblem('administrator')).toMatch(/common/);
    expect(passwordProblem('hello-alice-world', 'alice')).toMatch(/username/);
    expect(passwordProblem('aaaaaaaaaaaaaa')).toMatch(/repetitive/);
  });
});

describe('super user from the environment', () => {
  it('signs in with the configured credentials, gets every permission, and is never stored with a password', async () => {
    const r = await login(db, { username: SU.username, password: SU.password, ip: '1.1.1.1' });
    expect(r.user.isSuperuser).toBe(true);
    expect(r.user.permissions.size).toBe(ALL_PERMISSIONS.length);
    expect((await db.query('SELECT password_hash FROM users WHERE is_superuser')).rows.every((u) => u.passwordHash === null)).toBe(true);
    expect((await validateSession(db, r.token))?.username).toBe(SU.username);
  });
  it('rejects wrong credentials without saying which part was wrong', async () => {
    await expect(login(db, { username: SU.username, password: 'wrong-password-123' })).rejects.toThrow('Incorrect username or password.');
    await expect(login(db, { username: 'nobody', password: SU.password })).rejects.toThrow('Incorrect username or password.');
  });
  it('is disabled when the environment is missing or weak', async () => {
    process.env.MERIDIAN_SUPERUSER_PASSWORD = 'short';
    await expect(login(db, { username: SU.username, password: 'short' })).rejects.toThrow('Incorrect username or password.');
    delete process.env.MERIDIAN_SUPERUSER_USERNAME;
    await expect(login(db, { username: SU.username, password: SU.password })).rejects.toThrow('Incorrect');
  });
  it('rotating the environment password invalidates existing super-user sessions', async () => {
    const r = await login(db, { username: SU.username, password: SU.password });
    expect(await validateSession(db, r.token)).not.toBeNull();
    process.env.MERIDIAN_SUPERUSER_PASSWORD = 'A-Brand-New-Passphrase-77';
    expect(await validateSession(db, r.token)).toBeNull();
    await expect(login(db, { username: SU.username, password: SU.password })).rejects.toThrow('Incorrect');
    expect((await login(db, { username: SU.username, password: 'A-Brand-New-Passphrase-77' })).user.isSuperuser).toBe(true);
  });
  it('cannot be shadowed by a database user with the same name', async () => {
    await expect(createUser(db, 'test', { username: SU.username, displayName: 'x', roles: ['admin'] })).rejects.toThrow(/reserved/);
  });
});

describe('database users', () => {
  it('creates a user with a one-time password that must be changed at first sign-in', async () => {
    const { user, temporaryPassword } = await createUser(db, 'root', { username: 'agent.one', displayName: 'Agent One', roles: ['call-center'] });
    expect(temporaryPassword).toMatch(/^[A-Za-z0-9]{16}$/);
    expect(user).not.toHaveProperty('passwordHash');
    const r = await login(db, { username: 'Agent.One', password: temporaryPassword! }); // case-insensitive username
    expect(r.user.mustChangePassword).toBe(true);
    expect(publicUser(r.user).home).toBe('/change-password');
    await changePassword(db, r.user, temporaryPassword!, 'A-Much-Better-Passphrase-1');
    expect(await validateSession(db, r.token)).toBeNull(); // all sessions end on password change
    const again = await login(db, { username: 'agent.one', password: 'A-Much-Better-Passphrase-1' });
    expect(again.user.mustChangePassword).toBe(false);
    expect(publicUser(again.user).home).toBe('/customers');
    await expect(changePassword(db, again.user, 'wrong', 'Another-Passphrase-22')).rejects.toThrow(/incorrect/);
    await expect(changePassword(db, again.user, 'A-Much-Better-Passphrase-1', 'A-Much-Better-Passphrase-1')).rejects.toThrow(/different/);
  });

  it('validates input, roles and bindings', async () => {
    await expect(createUser(db, 'r', { username: 'a b', displayName: 'x', roles: ['admin'] })).rejects.toThrow(/username/);
    await expect(createUser(db, 'r', { username: 'valid.name', displayName: 'x', roles: ['wizard'] })).rejects.toThrow(/unknown role/);
    await expect(createUser(db, 'r', { username: 'valid.name', displayName: 'x', roles: [] })).rejects.toThrow(/at least one role/);
    await expect(createUser(db, 'r', { username: 'store.user', displayName: 'x', roles: ['retail-store'] })).rejects.toThrow(/store id/);
    await expect(createUser(db, 'r', { username: 'dealer.user', displayName: 'x', roles: ['dealer'] })).rejects.toThrow(/dealer id/);
    await expect(createUser(db, 'r', { username: 'portal.user', displayName: 'x', roles: ['self-serve'] })).rejects.toThrow(/linked customer/);
    await expect(createUser(db, 'r', { username: 'weak.pw', displayName: 'x', roles: ['admin'], password: 'short' })).rejects.toThrow(/12/);
    await createUser(db, 'r', { username: 'dup.user', displayName: 'x', roles: ['admin'] });
    await expect(createUser(db, 'r', { username: 'DUP.user', displayName: 'x', roles: ['admin'] })).rejects.toThrow(/taken/);
  });

  it('locks after repeated failures and an administrator can unlock', async () => {
    const { user, temporaryPassword } = await createUser(db, 'r', { username: 'lock.me', displayName: 'Lock Me', roles: ['finance'] });
    for (let i = 0; i < 5; i++) await expect(login(db, { username: 'lock.me', password: 'wrong-password-xx', ip: `9.9.9.${i}` })).rejects.toThrow('Incorrect');
    await expect(login(db, { username: 'lock.me', password: temporaryPassword!, ip: '9.9.9.9' })).rejects.toThrow(/locked/);
    await unlockUser(db, 'r', user.id);
    expect((await login(db, { username: 'lock.me', password: temporaryPassword!, ip: '9.9.9.9' })).user.username).toBe('lock.me');
  });

  it('throttles guessing by username (even for accounts that do not exist) and by address', async () => {
    for (let i = 0; i < 10; i++) await expect(login(db, { username: 'ghost', password: 'wrong-password-xx', ip: `7.7.7.${i}` })).rejects.toThrow('Incorrect');
    await expect(login(db, { username: 'ghost', password: 'wrong-password-xx', ip: '7.7.7.99' })).rejects.toBeInstanceOf(RateLimited);
    for (let i = 0; i < 30; i++) await db.query(`INSERT INTO auth_attempts (key) VALUES ('ip:5.5.5.5')`);
    await expect(login(db, { username: SU.username, password: SU.password, ip: '5.5.5.5' })).rejects.toBeInstanceOf(RateLimited);
  });

  it('expires idle sessions, honours logout, and revokes on role change, disable and reset', async () => {
    const { user, temporaryPassword } = await createUser(db, 'r', { username: 'sess.user', displayName: 'S', roles: ['call-center'], password: 'Initial-Passphrase-5551' });
    void temporaryPassword;
    const fresh = () => login(db, { username: 'sess.user', password: 'Initial-Passphrase-5551' });

    let s = await fresh();
    await db.query(`UPDATE sessions SET last_seen_at = now() - interval '31 minutes'`);
    expect(await validateSession(db, s.token)).toBeNull();                       // idle timeout

    s = await fresh();
    await db.query(`UPDATE sessions SET expires_at = now() - interval '1 second' WHERE id <> ''`);
    expect(await validateSession(db, s.token)).toBeNull();                       // absolute lifetime

    s = await fresh();
    await logout(db, s.token);
    expect(await validateSession(db, s.token)).toBeNull();

    s = await fresh();
    await updateUser(db, 'r', user.id, { roles: ['finance'] });
    expect(await validateSession(db, s.token)).toBeNull();                       // new permissions apply on next sign-in

    s = await fresh();
    await updateUser(db, 'r', user.id, { status: 'DISABLED' });
    expect(await validateSession(db, s.token)).toBeNull();
    await expect(fresh()).rejects.toThrow('Incorrect');                          // disabled accounts cannot sign in
    await updateUser(db, 'r', user.id, { status: 'ACTIVE' });

    s = await fresh();
    const { temporaryPassword: t2 } = await resetPassword(db, 'r', user.id);
    expect(await validateSession(db, s.token)).toBeNull();
    expect((await login(db, { username: 'sess.user', password: t2 })).user.mustChangePassword).toBe(true);
  });

  it('never accepts a forged or truncated token, and stores only token hashes', async () => {
    const s = await login(db, { username: SU.username, password: SU.password });
    expect(await validateSession(db, s.token.slice(0, -2) + 'xx')).toBeNull();
    expect(await validateSession(db, 'x')).toBeNull();
    expect(await validateSession(db, undefined)).toBeNull();
    expect((await db.query('SELECT id FROM sessions')).rows.some((r) => r.id === s.token)).toBe(false);
  });

  it('binds a portal login to exactly one customer', async () => {
    const { customer } = await newCustomer(db);
    const { user } = await createUser(db, 'r', { username: 'portal.cust', displayName: 'Portal', roles: ['self-serve'], customerId: customer.id });
    expect(user.customerId).toBe(customer.id);
    await expect(createUser(db, 'r', { username: 'portal.two', displayName: 'Portal 2', roles: ['self-serve'], customerId: customer.id })).rejects.toThrow(/already has a portal login/);
    expect((await listUsers(db)).items.some((u: { username: string }) => u.username === 'portal.cust')).toBe(true);
  });
});

describe('documentation', () => {
  it('docs/ROLES.md matches the permission table the API enforces', async () => {
    const { readFileSync } = await import('node:fs');
    const { rolesMarkdown } = await import('./roles-doc.js');
    const onDisk = readFileSync(new URL('../../../docs/ROLES.md', import.meta.url), 'utf8');
    expect(onDisk, 'docs/ROLES.md is out of date: run `pnpm --filter @meridian/core docs:roles`').toBe(rolesMarkdown());
  });
});

describe('the market a login sells in', () => {
  it('is the deployment\'s own country whatever is asked while there is one market', async () => {
    await setMarketSettings(db, 'root', { multiple: false });
    const u = await createUser(db, 'root', { username: 'market.single', displayName: 'Single Market', roles: ['call-center'], marketCode: 'TH' });
    expect(u.user.marketCode).toBe((await getRegional(db)).country);
  });
  it('starts as the deployment\'s own country, can be chosen, and can be changed later (several markets)', async () => {
    await setMarketSettings(db, 'root', { multiple: true, defaultMarket: 'MY' });
    const regional = (await db.query(`SELECT value FROM settings WHERE key='regional'`)).rows[0]?.value ?? {};
    await db.query(`INSERT INTO settings (key, value, updated_by) VALUES ('regional', $1, 'test') ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`, [JSON.stringify({ ...regional, country: 'MY' })]);
    const a = await createUser(db, 'root', { username: 'market.default', displayName: 'Default Market', roles: ['call-center'] });
    expect(a.user.marketCode).toBe('MY'); // the default market, not Singapore by habit
    const b = await createUser(db, 'root', { username: 'market.chosen', displayName: 'Chosen Market', roles: ['call-center'], marketCode: 'th' });
    expect(b.user.marketCode).toBe('TH');
    await expect(createUser(db, 'root', { username: 'market.bad', displayName: 'Bad', roles: ['call-center'], marketCode: 'ZZ' })).rejects.toThrow(/unknown market/);
    expect((await updateUser(db, 'root', b.user.id, { marketCode: 'SG' })).marketCode).toBe('SG');
    expect((await updateUser(db, 'root', b.user.id, { displayName: 'Chosen Market 2' })).marketCode).toBe('SG'); // other edits leave it alone
  });
});
