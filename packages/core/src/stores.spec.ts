import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createUser } from './auth.js';
import type { Db } from './db.js';
import { assertStoreUsable, createStore, deleteStore, getStore, listStores, updateStore } from './stores.js';
import { freshDb } from './test-helpers.js';

let db: Db;
beforeAll(async () => { db = await freshDb(); });
afterAll(async () => { await db.close(); });

describe('stores', () => {
  it('issues store ids itself and lists them with search', async () => {
    const a = await createStore(db, 'admin', { name: 'Bugis Junction', address: '200 Victoria St', phone: '+6561234567' });
    const b = await createStore(db, 'admin', { name: 'Jurong Point' });
    expect(a.id).toMatch(/^STORE-\d{5}$/);
    expect(Number(String(b.id).slice(6))).toBe(Number(String(a.id).slice(6)) + 1);
    await expect(createStore(db, 'admin', { name: 'bugis junction' })).rejects.toThrow(/already a store/);
    await expect(createStore(db, 'admin', { name: '  ' })).rejects.toThrow(/needs a name/);
    expect((await listStores(db, { q: 'bug' })).items.map((s) => s.name)).toEqual(['Bugis Junction']);
    expect((await listStores(db, { q: a.id as string })).items).toHaveLength(1);
    // the seeded stores are there too
    expect((await listStores(db)).items.map((s) => s.id)).toEqual(expect.arrayContaining(['STORE-SG-001', 'STORE-SG-002']));
  });

  it('binds store staff to a store that exists and is switched on', async () => {
    const s = await createStore(db, 'admin', { name: 'Staff Store' });
    const make = (n: string, storeId?: string) => createUser(db, 'admin', { username: n, displayName: n, roles: ['retail-store'], storeId, password: 'Long-Enough-Passphrase-1' });
    await expect(make('clerk.none')).rejects.toThrow(/needs a store/);
    await expect(make('clerk.ghost', 'STORE-NOPE')).rejects.toThrow(/unknown store/);
    const u = await make('clerk.ok', s.id as string);
    expect(u.user.storeId).toBe(s.id);
    expect(Number((await listStores(db, { q: s.id as string })).items[0]!.staffCount)).toBe(1);
    await updateStore(db, 'admin', s.id as string, { status: 'INACTIVE' });
    await expect(make('clerk.off', s.id as string)).rejects.toThrow(/switched off/);
    await expect(assertStoreUsable(db, s.id as string)).rejects.toThrow(/switched off/);
  });

  it('edits a store, and removes only one that was never used', async () => {
    const s = await createStore(db, 'admin', { name: 'Temp Store' });
    expect(await updateStore(db, 'admin', s.id as string, { name: 'Temp Store 2', address: '1 Road', phone: '' })).toMatchObject({ name: 'Temp Store 2', address: '1 Road', phone: null });
    await deleteStore(db, 'admin', s.id as string);
    await expect(getStore(db, s.id as string)).rejects.toThrow(/not found/);
    // a seeded store has stock (and the demo has orders): it can only be switched off
    await expect(deleteStore(db, 'admin', 'STORE-SG-001')).rejects.toThrow(/Switch it off/);
    const used = await createStore(db, 'admin', { name: 'Used Store' });
    await createUser(db, 'admin', { username: 'used.clerk', displayName: 'Used', roles: ['retail-store'], storeId: used.id as string, password: 'Long-Enough-Passphrase-1' });
    await expect(deleteStore(db, 'admin', used.id as string)).rejects.toThrow(/1 staff/);
  });
});
