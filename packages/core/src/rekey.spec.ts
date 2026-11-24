import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from './db.js';
import { decryptText, keyIdOf } from './field-crypto.js';
import { saveHubEndpoint, saveHubWebhook } from './integration-hub.js';
import { addCase } from './kyc-review-helpers.js';
import { rekeyAll } from './rekey.js';
import { freshDb } from './test-helpers.js';

let db: Db;
const KEYS = ['MERIDIAN_DATA_KEY', 'MERIDIAN_DATA_KEY_ID', 'MERIDIAN_DATA_KEYS_OLD', 'MERIDIAN_ID_PEPPER'] as const;
const saved: Record<string, string | undefined> = {};
beforeAll(async () => { for (const k of KEYS) saved[k] = process.env[k]; db = await freshDb(); }, 60_000);
afterAll(async () => { await db.close(); });
afterEach(() => { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });
const use = (cur: string, id: number, old?: Record<number, string>) => { process.env.MERIDIAN_DATA_KEY = cur; process.env.MERIDIAN_DATA_KEY_ID = String(id); if (old) process.env.MERIDIAN_DATA_KEYS_OLD = JSON.stringify(old); else delete process.env.MERIDIAN_DATA_KEYS_OLD; };
const stored = async (sql: string) => (await db.query(sql)).rows[0]!.v as string;
const idOf = (b64: string) => keyIdOf(Buffer.from(b64, 'base64'));

describe('re-encrypting what is stored after a key change', () => {
  it('moves every stored secret and ID number to the new key, reports what it would do first, can be repeated, and leaves the data readable', async () => {
    use('first-key-first-key-first-key', 1);
    const caseId = await addCase(db, { idNumber: 'S1111111A' });
    await saveHubEndpoint(db, 'admin', { group: 'auth', kind: 'OTP_GATEWAY', name: 'Rekey gateway', url: 'https://sms.example.com/send', secret: 'gateway-token-123' } as never);
    await saveHubWebhook(db, 'admin', { kind: 'OUTBOUND', name: 'Rekey hook', targetUrl: 'https://hooks.example.com/x', authKind: 'HMAC', secret: 'hmac-key-0123456789abcdef' } as never);
    const before = { kyc: await stored(`SELECT id_number_enc AS v FROM kyc_cases WHERE id = '${caseId}'`), ep: await stored(`SELECT secret_enc AS v FROM integration_endpoints WHERE name = 'Rekey gateway'`), wh: await stored(`SELECT secret_enc AS v FROM webhook_subscriptions WHERE name = 'Rekey hook'`) };
    expect([before.kyc, before.ep, before.wh].map(idOf)).toEqual([1, 1, 1]);

    use('second-key-second-key-second-key', 2, { 1: 'first-key-first-key-first-key' });
    const dry = await rekeyAll(db, { dryRun: true });
    expect(dry.find((r) => r.target === 'KYC ID numbers')).toMatchObject({ rewritten: 1, failed: 0 });
    expect(await stored(`SELECT id_number_enc AS v FROM kyc_cases WHERE id = '${caseId}'`)).toBe(before.kyc);   // a dry run writes nothing

    const run = await rekeyAll(db);
    expect(run.reduce((n, r) => n + r.failed, 0)).toBe(0);
    expect(run.find((r) => r.target === 'Integration secrets')).toMatchObject({ rewritten: 1 });
    expect(run.find((r) => r.target === 'Webhook and listener secrets')).toMatchObject({ rewritten: 1 });
    const after = { kyc: await stored(`SELECT id_number_enc AS v FROM kyc_cases WHERE id = '${caseId}'`), ep: await stored(`SELECT secret_enc AS v FROM integration_endpoints WHERE name = 'Rekey gateway'`), wh: await stored(`SELECT secret_enc AS v FROM webhook_subscriptions WHERE name = 'Rekey hook'`) };
    expect([after.kyc, after.ep, after.wh].map(idOf)).toEqual([2, 2, 2]);
    expect([decryptText(after.kyc), decryptText(after.ep), decryptText(after.wh)]).toEqual(['S1111111A', 'gateway-token-123', 'hmac-key-0123456789abcdef']);

    const again = await rekeyAll(db);
    expect(again.every((r) => r.rewritten === 0 && r.failed === 0)).toBe(true);                                       // nothing left to do
    use('second-key-second-key-second-key', 2);                                                                      // the old key is dropped
    expect(decryptText(await stored(`SELECT id_number_enc AS v FROM kyc_cases WHERE id = '${caseId}'`))).toBe('S1111111A');
  });

  it('reports a value it cannot read and leaves it as it is, and keeps going with the rest', async () => {
    use('third-key-third-key-third-key', 3);
    const a = await addCase(db, { idNumber: 'S2222222B' });
    const b = await addCase(db, { idNumber: 'S3333333C' });
    use('fourth-key-fourth-key-fourth-key', 4);                                                                      // key 3 was not kept
    const damaged = await stored(`SELECT id_number_enc AS v FROM kyc_cases WHERE id = '${a}'`);
    const res = await rekeyAll(db, { only: ['kyc_cases'] });
    expect(res[0]!.failed).toBeGreaterThanOrEqual(2);
    expect(res[0]!.errors.join(' ')).toMatch(/key 3, which is not configured/);
    expect(await stored(`SELECT id_number_enc AS v FROM kyc_cases WHERE id = '${a}'`)).toBe(damaged);
    use('fourth-key-fourth-key-fourth-key', 4, { 3: 'third-key-third-key-third-key', 2: 'second-key-second-key-second-key' });   // and the key the first test left behind
    const fixed = await rekeyAll(db, { only: ['kyc_cases'] });
    expect(fixed[0]!.failed).toBe(0);
    expect([a, b].map((id) => id)).toHaveLength(2);
    expect(decryptText(await stored(`SELECT id_number_enc AS v FROM kyc_cases WHERE id = '${b}'`))).toBe('S3333333C');
  });

  it('works through a table in batches', async () => {
    use('fifth-key-fifth-key-fifth-key', 5);
    for (let i = 0; i < 7; i++) await addCase(db, { idNumber: `S90000${i}0Z` });
    use('sixth-key-sixth-key-sixth-key', 6, { 5: 'fifth-key-fifth-key-fifth-key' });
    const seen: number[] = [];
    const res = await rekeyAll(db, { only: ['kyc_cases'], batch: 3, onProgress: (r) => seen.push(r.rewritten) });
    expect(res[0]!.rewritten).toBeGreaterThanOrEqual(7);
    expect(res[0]!.scanned).toBeGreaterThanOrEqual(7);
    expect((await rekeyAll(db, { only: ['kyc_cases'], batch: 3 }))[0]!.rewritten).toBe(0);
  });
});
