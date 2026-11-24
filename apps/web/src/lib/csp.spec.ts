import { describe, expect, it } from 'vitest';
import { buildCsp, newNonce } from './csp';

describe('page Content-Security-Policy', () => {
  it('lets scripts run only with the request nonce: no unsafe-inline for scripts, no eval in production', () => {
    const csp = buildCsp('abc123==', false);
    const script = csp.split('; ').find((d) => d.startsWith('script-src'))!;
    expect(script).toBe("script-src 'self' 'nonce-abc123==' 'strict-dynamic'");
    expect(script).not.toMatch(/unsafe-inline|unsafe-eval/);
    expect(csp).toMatch(/frame-ancestors 'none'/);
    expect(csp).toMatch(/object-src 'none'/);
    expect(csp).toMatch(/base-uri 'self'/);
    expect(buildCsp('abc123==', true)).toMatch(/script-src [^;]*'unsafe-eval'/);                 // development tooling only
  });
  it('makes a new unguessable nonce each time', () => {
    const n = new Set(Array.from({ length: 200 }, () => newNonce()));
    expect(n.size).toBe(200);
    for (const v of n) { expect(v).toMatch(/^[A-Za-z0-9+/]{22}==$/); }                            // 16 random bytes, base64
  });
});
