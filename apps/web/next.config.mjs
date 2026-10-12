/** @type {import('next').NextConfig} */
export default {
  transpilePackages: ['@nexus/ui', '@nexus/types'],
  reactStrictMode: true,
  // Workspace packages use NodeNext-style `./x.js` specifiers that point at .ts sources.
  webpack: (config) => {
    config.resolve.extensionAlias = { '.js': ['.ts', '.tsx', '.js'] };
    return config;
  },
};
