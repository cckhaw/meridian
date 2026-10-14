import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createUser, login, validateSession } from './auth.js';
import type { Db } from './db.js';
import { listRoles, permissionCatalogue, resetRole, setRolePermissions } from './roles-config.js';
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
});
