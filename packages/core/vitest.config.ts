import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['src/**/*.spec.ts'], setupFiles: ['./test-setup/clock.ts'], testTimeout: 60_000, hookTimeout: 120_000 } });
