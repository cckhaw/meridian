import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from './db.js';
import { INTEGRATIONS, INTEGRATION_GROUPS, integrationOverview } from './integrations.js';
import { setSapSettings } from './sap-exporter.js';
import { queueOutbox } from './lifecycle-state.js';
import { freshDb } from './test-helpers.js';

let db: Db;
beforeAll(async () => { db = await freshDb(); });
afterAll(async () => { await db.close(); });

const find = (o: Awaited<ReturnType<typeof integrationOverview>>, id: string) => o.items.find((i) => i.id === id)!.state;

describe('integration registry', () => {
  it('lists each integration once, in a known group, with what the operator must do', () => {
    const ids = INTEGRATIONS.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const i of INTEGRATIONS) {
      expect(INTEGRATION_GROUPS).toContain(i.group);
      expect(i.needs.length, i.id).toBeGreaterThan(0);
      for (const e of i.endpoints ?? []) expect(e.path.startsWith('/api/'), `${i.id} ${e.path}`).toBe(true);
    }
    for (const g of INTEGRATION_GROUPS) expect(INTEGRATIONS.some((i) => i.group === g), g).toBe(true);
  });

  it('reports environment variables as set or not set and never returns a value', async () => {
    const env = { MERIDIAN_STRIPE_SECRET_KEY: 'sk_test_SECRETVALUE', MERIDIAN_SAP_TOKEN: 'tok-SECRETVALUE' } as NodeJS.ProcessEnv;
    const o = await integrationOverview(db, env);
    expect(JSON.stringify(o)).not.toContain('SECRETVALUE');
    const stripe = find(o, 'stripe');
    expect(stripe.env.find((v) => v.name === 'MERIDIAN_STRIPE_SECRET_KEY')!.set).toBe(true);
    expect(stripe.env.find((v) => v.name === 'MERIDIAN_STRIPE_WEBHOOK_SECRET')!.set).toBe(false);
    expect(stripe.status).toBe('NEEDS_SETUP');
    expect(stripe.detail).toMatch(/MERIDIAN_STRIPE_WEBHOOK_SECRET/);
    expect(find(o, 'temporal').env[0]!.set).toBeNull(); // lives on another deployment
    expect(find(o, 'temporal').status).toBe('REMOTE');
  });

  it('judges Stripe, SAP and the store-front from settings and keys', async () => {
    let o = await integrationOverview(db, {} as NodeJS.ProcessEnv);
    expect(find(o, 'storefront').status).toBe('NEEDS_SETUP');
    expect(find(o, 'sap').status).toBe('MANUAL');
    expect(find(o, 'database').status).toBe('STAND_IN');
    await setSapSettings(db, 'tester', { transport: 'REST', endpoint: 'https://sap.example.com/in' });
    o = await integrationOverview(db, {} as NodeJS.ProcessEnv);
    expect(find(o, 'sap').status).toBe('NEEDS_SETUP');
    expect(find(o, 'sap').detail).toMatch(/MERIDIAN_SAP_TOKEN/);
    o = await integrationOverview(db, { MERIDIAN_SAP_TOKEN: 'x', DATABASE_URL: 'postgres://x' } as NodeJS.ProcessEnv);
    expect(find(o, 'sap').status).toBe('CONNECTED');
    expect(find(o, 'database').status).toBe('CONNECTED');
  });

  it('shows queued instructions as waiting, and acknowledged ones as a connected connector', async () => {
    await queueOutbox(db, { kind: 'NOTIFY', instruction: 'PAYMENT_REMINDER', payload: {} });
    await queueOutbox(db, { kind: 'NETWORK', instruction: 'PROVISION', payload: {} });
    let o = await integrationOverview(db);
    expect(find(o, 'notifications')).toMatchObject({ status: 'WAITING', pending: 1, delivered: 0 });
    expect(find(o, 'network-provisioning').pending).toBe(1);
    expect(find(o, 'collections').detail).toMatch(/No connector/);
    await db.query(`UPDATE lifecycle_outbox SET delivered_at = now() WHERE instruction='PAYMENT_REMINDER'`);
    o = await integrationOverview(db);
    expect(find(o, 'notifications')).toMatchObject({ status: 'CONNECTED', pending: 0, delivered: 1 });
    expect(find(o, 'notifications').lastDeliveredAt).toMatch(/^\d{4}-\d\d-\d\d/);
  });
});
