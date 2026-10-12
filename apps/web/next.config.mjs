const isDev = process.env.NODE_ENV !== 'production';

// Next.js needs inline scripts/styles for hydration and the theme bootstrap; everything else is locked to this origin.
// (Tighten script-src with per-request nonces if your security policy requires removing 'unsafe-inline'.)
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ''}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ');

/** @type {import('next').NextConfig} */
export default {
  transpilePackages: ['@meridian/ui', '@meridian/types', '@meridian/core'],
  // Native/WASM database drivers must stay external to the server bundle.
  serverExternalPackages: ['@electric-sql/pglite', 'pg'],
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
        { key: 'Content-Security-Policy', value: csp },
        { key: 'X-Frame-Options', value: 'DENY' },
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=()' },
        { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' },
        { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
      ],
    }];
  },
};
