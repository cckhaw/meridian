import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  test: { include: ['src/**/*.spec.ts'], setupFiles: ['../../packages/core/test-setup/clock.ts'], testTimeout: 60_000, hookTimeout: 120_000, env: { NODE_ENV: 'test' } },
});
