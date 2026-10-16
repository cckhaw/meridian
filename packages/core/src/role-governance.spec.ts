import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { assertOrgScope, inOrgScope, requireAnyPermission, requirePermissions } from './access-guards.js';
import { createUser, login, validateSession } from './auth.js';
import type { Db } from './db.js';
import { ALL_PERMISSION_KEYS, permissionKey, resolvePermission } from './permission-catalog.js';
import { ALL_PERMISSIONS, ROLE_CODES, ROLE_IDS, ROLES, roleIdOfCode, scopeOf, permissionsOf } from './rbac.js';
import { createCustomRole, listRoles, setRoleDisabled, setRolePermissions } from './roles-config.js';
import { freshDb } from './test-helpers.js';

const SU = { username: 'root-admin', password: 'Correct-Horse-Battery-9' };
let db: Db;
beforeAll(async () => { db = await freshDb(); });
afterAll(async () => { await db.close(); });
beforeEach(() => { process.env.MERIDIAN_SUPERUSER_USERNAME = SU.username; process.env.MERIDIAN_SUPERUSER_PASSWORD = SU.password; });

describe('the permission catalogue', () => {
  it('names every permission as domain:resource:action, once, and resolves each name back', () => {
    expect(new Set(ALL_PERMISSION_KEYS).size).toBe(ALL_PERMISSIONS.length);
    for (const p of ALL_PERMISSIONS) {
      expect(permissionKey(p)).toMatch(/^[a-z_]+:[a-z_]+:[a-z_]+$/);
      expect(resolvePermission(permissionKey(p))).toBe(p);
      expect(resolvePermission(p)).toBe(p);
    }
  });
  it('lets the business vocabulary stand for the permission that covers it', () => {
    expect(resolvePermission('subscriber:sim:swap')).toBe('service:manage');
    expect(resolvePermission('billing:invoice:waive')).toBe('billing:credit');
    expect(resolvePermission('catalog:offer:publish')).toBe('catalog:write');
    expect(resolvePermission('nonsense:thing:do')).toBeUndefined();
  });
  it('accepts keys and aliases when a role is built', async () => {
    const v = await createCustomRole(db, 'root', { name: 'Waiver desk', permissions: ['billing:invoice:waive', 'customer:profile:read', 'dashboard:read'] });
    expect(v.permissions.sort()).toEqual(['billing:credit', 'customer:read', 'dashboard:read']);
    await expect(createCustomRole(db, 'root', { name: 'Typo role', permissions: ['billing:invoice:wavie'] })).rejects.toThrow(/unknown permission/);
  });
});

describe('the built-in roles', () => {
  it('each has a stable code, and the telecom role names map onto them', () => {
    for (const id of ROLE_IDS) expect(ROLES[id].code).toBe(ROLE_CODES[id]);
    expect(new Set(Object.values(ROLE_CODES)).size).toBe(ROLE_IDS.length);
    expect(roleIdOfCode('ROLE_CALL_CENTER_AGENT')).toBe('call-center');
    expect(roleIdOfCode('role_call_center_supervisor')).toBe('team-lead');
    expect(roleIdOfCode('ROLE_RETAIL_MANAGER')).toBe('retail-manager');
    expect(roleIdOfCode('ROLE_FINANCE_OFFICER')).toBe('finance');
    expect(roleIdOfCode('ROLE_CUSTOMER_SELFCARE')).toBe('self-serve');
  });
  it('gives the store manager the store, not the company', async () => {
    const m = ROLES['retail-manager'];
    expect(m.scope).toBe('store');
    expect(m.permissions).toEqual(expect.arrayContaining(['order:override', 'inventory:writeoff', 'inventory:transfer', 'order:create:RETAIL_ASSISTED']));
    for (const p of ['finance:export', 'billing:credit', 'catalog:write', 'user:manage'] as const) expect(m.permissions).not.toContain(p);
    expect(scopeOf({ isSuperuser: false, roles: ['retail-manager'], storeId: 'S1' })).toMatchObject({ storeId: 'S1', unrestricted: false });
    expect(scopeOf({ isSuperuser: false, roles: ['retail-manager'] }).storeId).toBe('\u0000none');   // no store: sees nothing, never everything
  });
});

describe('switching a role off', () => {
  it('stops it granting anything at once, keeps its users, and cannot lock out the administrators', async () => {
    const u = await createUser(db, 'root', { username: 'mgr.one', displayName: 'Manager', roles: ['retail-manager'], storeId: 'STORE-SG-001', password: 'Sturdy-Pass-Word-77' });
    await db.query('UPDATE users SET must_change_password=false WHERE id=$1', [u.user.id]);
    const token = (await login(db, { username: 'mgr.one', password: 'Sturdy-Pass-Word-77' })).token;
    expect((await validateSession(db, token))!.permissions.has('order:override')).toBe(true);
    const off = await setRoleDisabled(db, 'root', 'retail-manager', true);
    expect(off).toMatchObject({ disabled: true, users: 1, code: 'ROLE_RETAIL_MANAGER' });
    expect((await validateSession(db, token))!.permissions.size).toBe(0);
    expect((await listRoles(db)).find((r) => r.id === 'retail-manager')!.disabled).toBe(true);
    await expect(setRoleDisabled(db, 'root', 'admin', true)).rejects.toThrow(/cannot be switched off/);
    await setRoleDisabled(db, 'root', 'retail-manager', false);
    expect((await validateSession(db, token))!.permissions.has('order:override')).toBe(true);
  });
  it('does not let a switched-off unrestricted role widen what the other roles may see', () => {
    const book = { changes: {}, custom: {}, disabled: ['call-center'] };
    expect(scopeOf({ isSuperuser: false, roles: ['call-center', 'retail-store'], storeId: 'S1' }, book)).toMatchObject({ storeId: 'S1', unrestricted: false });
    expect(scopeOf({ isSuperuser: false, roles: ['call-center', 'retail-store'], storeId: 'S1' }).unrestricted).toBe(true);
    expect(permissionsOf({ isSuperuser: false, roles: ['call-center'] }, book).size).toBe(0);
  });
  it('still lets permissions of a built-in role be edited by key', async () => {
    const v = await setRolePermissions(db, 'root', 'rating-charging', { permissions: ['dashboard:overview:read', 'catalog:offer:read', 'catalog:offer:write'] });
    expect(v.permissions).toEqual(['dashboard:read', 'catalog:read', 'catalog:write']);
  });
});

describe('the guards', () => {
  const store = { permissions: new Set(['order:read', 'billing:credit'] as const), scope: { unrestricted: false, storeId: 'S1' } };
  it('requires every permission named, by id, key or alias, and says which is missing', () => {
    requirePermissions(store, 'order:read', 'billing:credit_note:issue');
    expect(() => requirePermissions(store, 'order:read', 'catalog:offer:publish')).toThrow(/catalog:offer:write/);
    requireAnyPermission(store, 'catalog:write', 'billing:invoice:waive');
    expect(() => requireAnyPermission(store, 'catalog:write', 'finance:export')).toThrow(/not allow/);
    expect(() => requirePermissions(store, 'not:a:thing')).toThrow(/unknown permission/);
  });
  it('keeps a store user to their store, a dealer to their dealer, and a customer to themselves, and reads a miss as not found', () => {
    expect(inOrgScope(store, { storeId: 'S1' })).toBe(true);
    expect(inOrgScope(store, { storeId: 'S2', dealerId: 'D1' })).toBe(false);
    expect(inOrgScope({ scope: { unrestricted: false, dealerId: 'D7' } }, { dealerId: 'D7', storeId: 'S9' })).toBe(true);
    expect(inOrgScope({ scope: { unrestricted: false, customerId: 'C1' } }, { customerId: 'C2' })).toBe(false);
    expect(inOrgScope({ scope: { unrestricted: true } }, { storeId: 'anything' })).toBe(true);
    expect(() => assertOrgScope(store, { storeId: 'S2' })).toThrow(/not found/);
  });
});
