import { describe, expect, it } from 'vitest';
import { cronAuth } from './cron.js';
import { clientIp } from './session.js';

const req = (h: Record<string, string>) => new Request('https://x.example/api/x', { headers: h });

describe('the address used for rate limiting', () => {
  it('takes the entry the nearest trusted proxy appended, counted from the end, so what a client puts in front is ignored', () => {
    expect(clientIp(req({ 'x-forwarded-for': '203.0.113.9' }), {})).toBe('203.0.113.9');                        // behind one proxy that sets it
    expect(clientIp(req({ 'x-forwarded-for': '6.6.6.6, 203.0.113.9' }), {})).toBe('203.0.113.9');               // a forged first entry is ignored
    expect(clientIp(req({ 'x-forwarded-for': '1.1.1.1, 2.2.2.2, 203.0.113.9' }), {})).toBe('203.0.113.9');     // however many were forged
    expect(clientIp(req({ 'x-forwarded-for': '6.6.6.6, 203.0.113.9, 10.0.0.2' }), { MERIDIAN_TRUSTED_PROXY_HOPS: '2' })).toBe('203.0.113.9');   // two proxies in front: the second from the end
    expect(clientIp(req({ 'x-forwarded-for': '203.0.113.9' }), { MERIDIAN_TRUSTED_PROXY_HOPS: '3' })).toBe('203.0.113.9');   // fewer entries than hops: the first there is
  });
  it('falls back to x-real-ip, then "unknown", and survives nonsense', () => {
    expect(clientIp(req({ 'x-real-ip': '198.51.100.4' }), {})).toBe('198.51.100.4');
    expect(clientIp(req({}), {})).toBe('unknown');
    expect(clientIp(req({ 'x-forwarded-for': ' , ,' }), {})).toBe('unknown');
    expect(clientIp(req({ 'x-forwarded-for': '203.0.113.9' }), { MERIDIAN_TRUSTED_PROXY_HOPS: 'abc' })).toBe('203.0.113.9');
    expect(clientIp(req({ 'x-forwarded-for': 'a'.repeat(500) }), {}).length).toBeLessThanOrEqual(64);
  });
});

describe('the scheduled-job secret', () => {
  const env = { MERIDIAN_CRON_SECRET: 's'.repeat(40) };
  it('is off unless a long enough secret is set', () => {
    expect(cronAuth(`Bearer ${'s'.repeat(40)}`, {})).toBe('disabled');
    expect(cronAuth(`Bearer ${'s'.repeat(10)}`, { MERIDIAN_CRON_SECRET: 's'.repeat(10) })).toBe('disabled');
  });
  it('accepts only the exact bearer secret', () => {
    expect(cronAuth(`Bearer ${'s'.repeat(40)}`, env)).toBe('ok');
    for (const h of [null, '', 'Bearer ', `Bearer ${'s'.repeat(39)}`, `Bearer ${'s'.repeat(41)}`, `bearer ${'s'.repeat(40)}`, 's'.repeat(40), `Basic ${'s'.repeat(40)}`]) expect(cronAuth(h, env), String(h)).toBe('denied');
  });
});
