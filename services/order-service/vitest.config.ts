import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// SWC is required so NestJS decorator metadata is emitted under vitest.
export default defineConfig({ plugins: [swc.vite()], test: { include: ['src/**/*.spec.ts'], testTimeout: 60_000 } });
