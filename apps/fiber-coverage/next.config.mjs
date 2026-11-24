// Map tiles are the one outside resource: OpenStreetMap's tile servers (change the tile host here and in src/components/map.tsx to use another provider).
const csp = [
  "default-src 'self'",
  `script-src 'self'`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https://tile.openstreetmap.org https://*.tile.openstreetmap.org",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ');

/** @type {import('next').NextConfig} */
export default {
  transpilePackages: ['@meridian/ui', '@meridian/types', '@meridian/core', '@meridian/fiber'],
  // Native/WASM database drivers must stay external to the server bundle.
  serverExternalPackages: ['@electric-sql/pglite', 'pg', 'ldapts', 'nodemailer'],
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
        { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(self), payment=()' },
        { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' },
        { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
      ],
    },
    // Pages get their policy, with a script nonce per request, from src/middleware.ts (src/lib/csp.ts); what the API serves has no scripts at all.
    ...['/api/:path*', '/tmf-api/:path*'].map((source) => ({ source, headers: [{ key: 'Content-Security-Policy', value: csp }] }))];
  },
};
