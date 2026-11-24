// The store-front talks to the CRM only from its server (see src/server/core.ts); the browser only ever calls this app.
// Stripe's browser SDK is the one third party allowed: it renders the card form in its own iframe so card numbers never touch this site.
const csp = [
  "default-src 'self'",
  `script-src 'self'`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https://*.stripe.com",
  "font-src 'self' data:",
  "connect-src 'self' https://api.stripe.com https://*.stripe.com",
  "frame-src https://js.stripe.com https://hooks.stripe.com https://*.stripe.com",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ');

/** @type {import('next').NextConfig} */
export default {
  transpilePackages: ['@meridian/ui', '@meridian/types'],
  reactStrictMode: true,
  poweredByHeader: false,
  webpack: (config) => {
    config.resolve.extensionAlias = { '.js': ['.ts', '.tsx', '.js'] };
    return config;
  },
  async headers() {
    return [{
      source: '/:path*',
      headers: [
        { key: 'X-Frame-Options', value: 'DENY' },
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        { key: 'Permissions-Policy', value: 'camera=(self), microphone=(), geolocation=(self), payment=(self "https://js.stripe.com")' },
        { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' },
      ],
    },
    // Pages get their policy, with a script nonce per request, from src/middleware.ts (src/lib/csp.ts); what the API serves has no scripts at all.
    ...['/api/:path*'].map((source) => ({ source, headers: [{ key: 'Content-Security-Policy', value: csp }] }))];
  },
};
