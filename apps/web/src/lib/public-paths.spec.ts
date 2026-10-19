import { describe, expect, it } from 'vitest';
import { isPublicPath } from './public-paths';

describe('isPublicPath', () => {
  it('lets the sign-in pages and the single sign-on return page through without a session', () => {
    for (const p of ['/login', '/login/sso', '/login/sso/', '/pay/done', '/forgot-password', '/reset-password']) expect(isPublicPath(p)).toBe(true);
  });
  it('keeps everything else behind sign-in, including look-alikes', () => {
    for (const p of ['/', '/customers', '/loginx', '/login-help', '/admin/login/sso', '/pay', '/profile']) expect(isPublicPath(p)).toBe(false);
  });
});
