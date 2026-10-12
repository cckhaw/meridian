import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { core, CoreError } from './core';
import { sameSite, shopperIp } from './session';

const env = { ...process.env };
beforeEach(() => { process.env.MERIDIAN_API_URL = 'https://crm.example.com/api/'; process.env.MERIDIAN_API_KEY = 'mk_test_abcdefghij_' + 'x'.repeat(40); });
afterEach(() => { process.env = { ...env }; vi.unstubAllGlobals(); });

const reply = (status: number, body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status }));

describe('CRM client', () => {
  it('sends the API key and the shopper token from the server side only', async () => {
    const f = reply(200, { ok: true }); vi.stubGlobal('fetch', f);
    await core('/store/applications/1', { method: 'POST', json: { a: 1 }, token: 'tok', shopperIp: '203.0.113.9' });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://crm.example.com/api/store/applications/1');
    expect(init.headers).toMatchObject({ authorization: expect.stringMatching(/^Bearer mk_test_/), 'x-application-token': 'tok', 'x-shopper-ip': '203.0.113.9' });
  });

  it('turns CRM errors into shopper-safe ones, and hides a bad key behind a generic outage', async () => {
    vi.stubGlobal('fetch', reply(422, { error: { code: 'REJECTED', message: 'Identity verification must be completed first.' } }));
    await expect(core('/x')).rejects.toMatchObject({ status: 422, message: 'Identity verification must be completed first.' });
    vi.stubGlobal('fetch', reply(401, { error: { code: 'UNAUTHENTICATED', message: 'A valid API key is required.' } }));
    const e = await core('/x').catch((x) => x as CoreError);
    expect(e).toMatchObject({ status: 503, code: 'NOT_CONFIGURED' });
    expect(e.message).not.toMatch(/API key/);
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
    await expect(core('/x')).rejects.toMatchObject({ status: 503, code: 'UNAVAILABLE' });
  });

  it('refuses to run without configuration', async () => {
    delete process.env.MERIDIAN_API_KEY;
    await expect(core('/x')).rejects.toMatchObject({ code: 'NOT_CONFIGURED' });
  });
});

describe('same-site check for mutations', () => {
  const req = (headers: Record<string, string>) => new Request('https://shop.example.com/api/shop/start', { method: 'POST', headers });
  it('accepts only requests from the shop’s own origin', () => {
    expect(sameSite(req({ origin: 'https://shop.example.com', host: 'shop.example.com' }))).toBe(true);
    expect(sameSite(req({ origin: 'https://evil.example.net', host: 'shop.example.com' }))).toBe(false);
    expect(sameSite(req({ host: 'shop.example.com' }))).toBe(false);
    expect(sameSite(req({ origin: 'not a url', host: 'shop.example.com' }))).toBe(false);
  });
  it('reads the first forwarded address', () => {
    expect(shopperIp(req({ 'x-forwarded-for': '203.0.113.9, 10.0.0.1' }))).toBe('203.0.113.9');
    expect(shopperIp(req({}))).toBeNull();
  });
});
