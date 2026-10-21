import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createUser, login, validateSession } from './auth.js';
import type { Db } from './db.js';
import { createCustomRole, deleteCustomRole, getRoleOverrides, listRoles, permissionCatalogue, resetRole, setRoleDisabled, setRolePermissions, superuserGrantRoles, updateRole } from './roles-config.js';
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
    const view = await setRolePermissions(db, 'root', 'retail-store', { permissions: next, creditLimitMinor: 5000 }, true);
    expect(view.customised).toBe(true);
    expect(view.users).toBeGreaterThanOrEqual(1);
    const again = (await validateSession(db, s.token))!;
    expect(again.permissions.has('inventory:write')).toBe(false);
    expect(again.permissions.has('billing:credit')).toBe(true);
    expect(again.creditLimitMinor).toBe(5000);
    void u;

    const back = await resetRole(db, 'root', 'retail-store', true);
    expect(back.customised).toBe(false);
    const restored = (await validateSession(db, s.token))!;
    expect(restored.permissions.has('inventory:write')).toBe(true);
    expect(restored.creditLimitMinor).toBe(0);
  });

  it('refuses what would be unsafe or meaningless', async () => {
    const admin = ROLES.admin.permissions;
    await expect(setRolePermissions(db, 'root', 'retail-store', { permissions: ['nope:read'] }, true)).rejects.toThrow(/unknown permission/);
    await expect(setRolePermissions(db, 'root', 'ghost', { permissions: [] }, true)).rejects.toThrow(/unknown role/);
    await expect(setRolePermissions(db, 'root', 'admin', { permissions: admin.filter((p) => p !== 'user:manage') }, true)).rejects.toThrow(/manage roles/);
    await expect(setRolePermissions(db, 'root', 'finance', { permissions: ['billing:credit'], creditLimitMinor: -1 }, true)).rejects.toThrow(/credit note/);
    expect((await listRoles(db)).every((r) => !r.customised)).toBe(true);
  });

  it('creates a role that users can hold, with its own permissions, scope and landing page', async () => {
    const role = await createCustomRole(db, 'root', { name: 'Shop Supervisor', summary: 'Runs a shop floor', scope: 'store', home: '/orders', copyFrom: 'retail-store' }, true);
    expect(role.id).toBe('shop-supervisor');
    expect(role.custom).toBe(true);
    expect(role.permissions).toContain('order:fulfil');
    const trimmed = await updateRole(db, 'root', role.id, { permissions: role.permissions.filter((p) => p !== 'order:fulfil').concat('order:override') }, true);
    expect(trimmed.permissions).toContain('order:override');

    await expect(createUser(db, 'root', { username: 'sup.nostore', displayName: 'No Store', roles: ['shop-supervisor'], password: 'Sturdy-Pass-Word-77' })).rejects.toThrow(/needs a store id/); // scope is enforced like a built-in role
    await createUser(db, 'root', { username: 'sup.one', displayName: 'Supervisor', roles: ['shop-supervisor'], storeId: 'STORE-SG-001', password: 'Sturdy-Pass-Word-77' });
    const s = await login(db, { username: 'sup.one', password: 'Sturdy-Pass-Word-77' });
    expect(s.user.permissions.has('order:override')).toBe(true);
    expect(s.user.permissions.has('order:fulfil')).toBe(false);
    expect(s.user.roleLabels).toEqual(['Shop Supervisor']);
    expect(s.user.home).toBe('/orders');
    expect(s.user.scope).toMatchObject({ unrestricted: false, storeId: 'STORE-SG-001' });

    await expect(createCustomRole(db, 'root', { name: 'shop supervisor' }, true)).rejects.toThrow(/already a role/);
    await expect(createCustomRole(db, 'root', { name: 'Retail Store Assistant' }, true)).rejects.toThrow(/already a role/);
    await expect(updateRole(db, 'root', 'shop-supervisor', { scope: 'dealer' }, true)).rejects.toThrow(/cannot change/);
    await expect(updateRole(db, 'root', 'retail-store', { name: 'Renamed' }, true)).rejects.toThrow(/built-in/);
    await expect(deleteCustomRole(db, 'root', 'shop-supervisor', true)).rejects.toThrow(/still held/);
    await expect(deleteCustomRole(db, 'root', 'retail-store', true)).rejects.toThrow(/built-in/);

    await db.query(`DELETE FROM users WHERE username='sup.one'`);
    await db.query(`DELETE FROM sessions`);
    expect((await deleteCustomRole(db, 'root', 'shop-supervisor', true)).deleted).toBe('shop-supervisor');
    expect((await listRoles(db)).some((r) => r.id === 'shop-supervisor')).toBe(false);
  });

  describe('Settings and Integration: assignable, but only the super user gives or takes them away', () => {
    const MSG = /Only the super user can give or take away Settings and Integration/;
    const GRANTS = ['settings:manage', 'integration:manage'] as const;

    it('lets the super user give each to a role, by id or by its domain:resource:action key', async () => {
      for (const p of GRANTS) {
        const v = await createCustomRole(db, 'root', { name: `Holder ${p}`, permissions: [p] }, true);
        expect(v.permissions).toEqual([p]);
        expect(v.grantsSuperuser).toBe(true);
      }
      const byKey = await createCustomRole(db, 'root', { name: 'By key', permissions: ['system:integration:manage', 'system:settings:manage'] }, true);
      expect([...byKey.permissions].sort()).toEqual(['integration:manage', 'settings:manage']);
      const built = await setRolePermissions(db, 'root', 'retail-store', { permissions: [...ROLES['retail-store'].permissions, 'integration:manage'] }, true);
      expect(built.permissions).toContain('integration:manage');
      expect((await resetRole(db, 'root', 'retail-store', true)).permissions).not.toContain('integration:manage');
      for (const id of ['holder-settings-manage', 'holder-integration-manage', 'by-key']) await deleteCustomRole(db, 'root', id, true);
    });

    it('refuses an administrator who is not the super user: create, update, copy, reset, switch off, delete', async () => {
      const held = await createCustomRole(db, 'root', { name: 'Desk', permissions: ['dashboard:read', 'settings:manage'] }, true);
      await setRolePermissions(db, 'root', 'telesales', { permissions: [...ROLES.telesales.permissions, 'integration:manage'] }, true);
      for (const p of GRANTS) {
        await expect(createCustomRole(db, 'admin', { name: 'Sneaky', permissions: [p] }, false)).rejects.toThrow(MSG);
        await expect(setRolePermissions(db, 'admin', 'finance', { permissions: [...ROLES.finance.permissions, p] }, false)).rejects.toThrow(MSG);
        await expect(updateRole(db, 'admin', 'finance', { permissions: [p] }, false)).rejects.toThrow(MSG);
      }
      await expect(createCustomRole(db, 'admin', { name: 'Copy', copyFrom: held.id }, false)).rejects.toThrow(MSG);           // copying a role that holds one
      await expect(createCustomRole(db, 'admin', { name: 'Copy 2', copyFrom: 'telesales' }, false)).rejects.toThrow(MSG);     // a built-in role carrying an added one
      await expect(updateRole(db, 'admin', held.id, { permissions: ['dashboard:read'] }, false)).rejects.toThrow(MSG);        // taking it away
      await expect(updateRole(db, 'admin', held.id, { name: 'Renamed' }, false)).rejects.toThrow(MSG);                          // any change to a role that holds one
      await expect(setRoleDisabled(db, 'admin', held.id, true, false)).rejects.toThrow(MSG);
      await expect(resetRole(db, 'admin', 'telesales', false)).rejects.toThrow(MSG);                                          // reset would remove it
      await expect(setRolePermissions(db, 'admin', 'telesales', { permissions: ROLES.telesales.permissions as string[] }, false)).rejects.toThrow(MSG);
      await expect(deleteCustomRole(db, 'admin', held.id, false)).rejects.toThrow(MSG);
      // switched off, the role still holds it: it cannot be switched back on by someone else
      await setRoleDisabled(db, 'root', held.id, true, true);
      await expect(setRoleDisabled(db, 'admin', held.id, false, false)).rejects.toThrow(MSG);
      await setRoleDisabled(db, 'root', held.id, false, true);
      // nothing changed, and the super user may do all of it
      expect((await listRoles(db)).find((r) => r.id === held.id)!.permissions).toContain('settings:manage');
      expect((await listRoles(db)).find((r) => r.id === 'telesales')!.permissions).toContain('integration:manage');
      await resetRole(db, 'root', 'telesales', true);
      await updateRole(db, 'root', held.id, { name: 'Renamed' }, true);
      await deleteCustomRole(db, 'root', held.id, true);
    });

    it('leaves every other edit to user:manage, and the guard covers the live role book', async () => {
      const plain = await createCustomRole(db, 'admin', { name: 'Plain', permissions: ['dashboard:read'] }, false);
      await updateRole(db, 'admin', plain.id, { name: 'Plain 2', permissions: ['dashboard:read', 'billing:read'] }, false);
      await setRolePermissions(db, 'admin', 'finance', { permissions: ROLES.finance.permissions.filter((p) => p !== 'finance:export') }, false);
      await setRoleDisabled(db, 'admin', plain.id, true, false);
      await resetRole(db, 'admin', 'finance', false);
      expect((await superuserGrantRoles(db)).size).toBe(0);
      await setRolePermissions(db, 'root', 'finance', { permissions: [...ROLES.finance.permissions, 'settings:manage'] }, true);
      await setRoleDisabled(db, 'root', 'finance', true, true);
      expect([...(await superuserGrantRoles(db))]).toEqual(['finance']);                    // overrides count, and so does a role that is switched off
      await resetRole(db, 'root', 'finance', true);
      await setRoleDisabled(db, 'root', 'finance', false, true);
      await deleteCustomRole(db, 'admin', plain.id, false);
      expect((await superuserGrantRoles(db)).size).toBe(0);
    });

    it('audits who gave or took away Settings or Integration', async () => {
      const v = await createCustomRole(db, 'root', { name: 'Audited', permissions: ['settings:manage'] }, true);
      await updateRole(db, 'root', v.id, { permissions: ['integration:manage'] }, true);
      await deleteCustomRole(db, 'root', v.id, true);
      const rows = (await db.query(`SELECT actor, detail FROM audit_log WHERE entity='role' AND entity_id=$1 AND action='grant-super-user-permission' ORDER BY id`, [v.id])).rows;
      expect(rows.map((r) => [r.actor, r.detail.added, r.detail.removed])).toEqual([['root', ['settings:manage'], []], ['root', ['integration:manage'], ['settings:manage']]]);
    });

    it('stores that tolerate the new permission id and drop ones that do not exist', async () => {
      await db.query(`INSERT INTO settings (key, value, updated_by) VALUES ('rolePermissions', $1, 'test') ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`, [JSON.stringify({ telesales: { permissions: ['dashboard:read', 'integration:manage', 'no:such'] } })]);
      expect((await getRoleOverrides(db)).changes.telesales!.permissions).toEqual(['dashboard:read', 'integration:manage']);
      await resetRole(db, 'root', 'telesales', true);
    });
  });
});
