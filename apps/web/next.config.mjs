/** @type {import('next').NextConfig} */
export default {
  transpilePackages: ['@meridian/ui', '@meridian/types', '@meridian/core'],
  // Native/WASM database drivers must stay external to the server bundle.
  serverExternalPackages: ['@electric-sql/pglite', 'pg'],
  reactStrictMode: true,
  // Workspace packages use NodeNext-style `./x.js` specifiers that point at .ts sources.
  webpack: (config) => {
    config.resolve.extensionAlias = { '.js': ['.ts', '.tsx', '.js'] };
    return config;
  },
};
