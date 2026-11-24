// Pages get their policy, with a script nonce per request, from src/middleware.ts (src/lib/csp.ts). What the API serves (JSON, PDFs, downloads) has no scripts at all.
const apiCsp = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-src 'self' blob:",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ');

/** @type {import('next').NextConfig} */
export default {
  transpilePackages: ['@meridian/ui', '@meridian/types', '@meridian/core'],
  // Native/WASM database drivers must stay external to the server bundle.
  serverExternalPackages: ['@electric-sql/pglite', 'pg', 'ldapts', 'nodemailer'],
  reactStrictMode: true,
  poweredByHeader: false,
  // Workspace packages use NodeNext-style `./x.js` specifiers that point at .ts sources.
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
        { key: 'Permissions-Policy', value: 'camera=(self), microphone=(), geolocation=(self), payment=()' },
        { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' },
        { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
      ],
    },
    { source: '/api/:path*', headers: [{ key: 'Content-Security-Policy', value: apiCsp }] },
    // A document is shown to staff inside the Documents page (a frame of our own origin), so these two addresses, and only these, may be framed by us.
    ...['/api/documents/:id/file', '/api/documents/file/:token'].map((source) => ({ source, headers: [
      { key: 'Content-Security-Policy', value: "frame-ancestors 'self'" },
      { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
    ] }))];
  },
};
