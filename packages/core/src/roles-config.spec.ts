import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createUser, login, validateSession } from './auth.js';
import type { Db } from './db.js';
import { createCustomRole, deleteCustomRole, listRoles, permissionCatalogue, resetRole, setRolePermissions, updateRole } from './roles-config.js';
import { ALL_PERMISSIONS, ROLES } from './rbac.js';
import { freshDb } from './test-helpers.js';

const SU = { username: 'root-admin', password: 'Correct-Horse-Battery-9' };
let db: Db;
beforeAll(async () => { db = await freshDb(); });
afterAll(async () => { await db.close(); });
beforeEach(() => { process.env.MERIDIAN_SUPERUSER_USERNAME = SU.username; process.env.MERIDIAN_SUPERUSER_PASSWORD = SU.password; });

describe('maintaining what a role can do', () => {
  it('describes every permission, so the editor never shows a bare id', () => {
    expect(permissionCatalogue().map((p) => p.id)).toEqual([...ALL_PERMISSIONS]);
    expect(permissionCatalogue().every((p) => p.group !== 'Other' && p.hint)).toBe(true);
  });

  it('applies a change to the users who hold the role on their next request, and can put it back', async () => {
    const u = await createUser(db, 'root', { username: 'store.one', displayName: 'Store One', roles: ['retail-store'], storeId: 'STORE-SG-001', password: 'Sturdy-Pass-Word-77' });
    const s = await login(db, { username: 'store.one', password: 'Sturdy-Pass-Word-77' });
    s.user.mustChangePassword = false;
    expect(s.user.permissions.has('inventory:write')).toBe(true);
    expect(s.user.permissions.has('billing:credit')).toBe(false);

    const defaults = ROLES['retail-store'].permissions;
    const next = defaults.filter((p) => p !== 'inventory:write').concat('billing:credit');
    const view = await setRolePermissions(db, 'root', 'retail-store', { permissions: next, creditLimitMinor: 5000 });
    expect(view.customised).toBe(true);
    expect(view.users).toBeGreaterThanOrEqual(1);
    const again = (await validateSession(db, s.token))!;
    expect(again.permissions.has('inventory:write')).toBe(false);
    expect(again.permissions.has('billing:credit')).toBe(true);
    expect(again.creditLimitMinor).toBe(5000);
    void u;

    const back = await resetRole(db, 'root', 'retail-store');
    expect(back.customised).toBe(false);
    const restored = (await validateSession(db, s.token))!;
    expect(restored.permissions.has('inventory:write')).toBe(true);
    expect(restored.creditLimitMinor).toBe(0);
  });

  it('refuses what would be unsafe or meaningless', async () => {
    const admin = ROLES.admin.permissions;
    await expect(setRolePermissions(db, 'root', 'retail-store', { permissions: ['settings:manage'] })).rejects.toThrow(/super user/);
    await expect(setRolePermissions(db, 'root', 'retail-store', { permissions: ['nope:read'] })).rejects.toThrow(/unknown permission/);
    await expect(setRolePermissions(db, 'root', 'ghost', { permissions: [] })).rejects.toThrow(/unknown role/);
    await expect(setRolePermissions(db, 'root', 'admin', { permissions: admin.filter((p) => p !== 'user:manage') })).rejects.toThrow(/manage roles/);
    await expect(setRolePermissions(db, 'root', 'finance', { permissions: ['billing:credit'], creditLimitMinor: -1 })).rejects.toThrow(/credit note/);
    expect((await listRoles(db)).every((r) => !r.customised)).toBe(true);
  });

  it('creates a role that users can hold, with its own permissions, scope and landing page', async () => {
    const role = await createCustomRole(db, 'root', { name: 'Shop Supervisor', summary: 'Runs a shop floor', scope: 'store', home: '/orders', copyFrom: 'retail-store' });
    expect(role.id).toBe('shop-supervisor');
    expect(role.custom).toBe(true);
    expect(role.permissions).toContain('order:fulfil');
    const trimmed = await updateRole(db, 'root', role.id, { permissions: role.permissions.filter((p) => p !== 'order:fulfil').concat('order:override') });
    expect(trimmed.permissions).toContain('order:override');

    await expect(createUser(db, 'root', { username: 'sup.nostore', displayName: 'No Store', roles: ['shop-supervisor'], password: 'Sturdy-Pass-Word-77' })).rejects.toThrow(/needs a store id/); // scope is enforced like a built-in role
    await createUser(db, 'root', { username: 'sup.one', displayName: 'Supervisor', roles: ['shop-supervisor'], storeId: 'STORE-SG-001', password: 'Sturdy-Pass-Word-77' });
    const s = await login(db, { username: 'sup.one', password: 'Sturdy-Pass-Word-77' });
    expect(s.user.permissions.has('order:override')).toBe(true);
    expect(s.user.permissions.has('order:fulfil')).toBe(false);
    expect(s.user.roleLabels).toEqual(['Shop Supervisor']);
    expect(s.user.home).toBe('/orders');
    expect(s.user.scope).toMatchObject({ unrestricted: false, storeId: 'STORE-SG-001' });

    await expect(createCustomRole(db, 'root', { name: 'shop supervisor' })).rejects.toThrow(/already a role/);
    await expect(createCustomRole(db, 'root', { name: 'Retail Store' })).rejects.toThrow(/already a role/);
    await expect(createCustomRole(db, 'root', { name: 'Sneaky', permissions: ['settings:manage'] })).rejects.toThrow(/super user/);
    await expect(updateRole(db, 'root', 'shop-supervisor', { scope: 'dealer' })).rejects.toThrow(/cannot change/);
    await expect(updateRole(db, 'root', 'retail-store', { name: 'Renamed' })).rejects.toThrow(/built-in/);
    await expect(deleteCustomRole(db, 'root', 'shop-supervisor')).rejects.toThrow(/still held/);
    await expect(deleteCustomRole(db, 'root', 'retail-store')).rejects.toThrow(/built-in/);

    await db.query(`DELETE FROM users WHERE username='sup.one'`);
    await db.query(`DELETE FROM sessions`);
    expect((await deleteCustomRole(db, 'root', 'shop-supervisor')).deleted).toBe('shop-supervisor');
    expect((await listRoles(db)).some((r) => r.id === 'shop-supervisor')).toBe(false);
  });
});
