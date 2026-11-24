import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createUser } from './auth.js';
import type { Db } from './db.js';
import { securityPosture } from './security-posture.js';
import { setSecurityPolicy } from './security-policy.js';
import { freshDb } from './test-helpers.js';

let db: Db;
beforeAll(async () => { db = await freshDb(); }, 60_000);
afterAll(async () => { await db.close(); });
const by = (items: Awaited<ReturnType<typeof securityPosture>>) => Object.fromEntries(items.map((i) => [i.id, i]));

describe('security posture', () => {
  it('says what is weak and what is in place, from the policy, the environment and the staff', async () => {
    let p = by(await securityPosture(db, {}));
    expect(p['mfa-required']).toMatchObject({ status: 'ATTENTION' });                               // optional second factor
    expect(p['superuser-mfa']).toMatchObject({ status: 'ATTENTION' });
    expect(p['data-key']).toMatchObject({ status: 'ATTENTION' });                                   // no separate data key
    expect(p['cron']).toMatchObject({ status: 'INFO' });
    expect(JSON.stringify(p)).not.toMatch(/secret-value|[A-Z2-7]{16}/);                              // never shows a secret

    await createUser(db, 'seed', { username: 'posture.admin', displayName: 'P Admin', roles: ['admin'], password: 'Str0ng!Passw0rd#1' });
    await setSecurityPolicy(db, 'seed', { mfa: { requirement: 'ALL' } } as never);
    p = by(await securityPosture(db, { MERIDIAN_SUPERUSER_TOTP_SECRET: 'JBSWY3DPEHPK3PXP', MERIDIAN_DATA_KEY: 'a-separate-data-key-value', MERIDIAN_CRON_SECRET: 'c'.repeat(40), MERIDIAN_PRIVATE_NETWORK_HOSTS: 'ocs.corp.example, 10.1.1.1', MERIDIAN_TRUSTED_PROXY_HOPS: '2' }));
    expect(p['mfa-required']).toMatchObject({ status: 'OK' });
    expect(p['mfa-enrolled']).toMatchObject({ status: 'ATTENTION' });                               // the administrator we just made has no second factor yet
    expect(p['mfa-enrolled']!.detail).toMatch(/1 of 1/);
    expect(p['admins-mfa']).toMatchObject({ status: 'ATTENTION' });
    expect(p['superuser-mfa']).toMatchObject({ status: 'OK' });
    expect(p['data-key']).toMatchObject({ status: 'OK' });
    expect(p['cron']).toMatchObject({ status: 'OK' });
    expect(p['private-hosts']!.detail).toMatch(/2 named/);
    expect(p['proxy-hops']!.detail).toMatch(/^2 trusted/);
  });
});
