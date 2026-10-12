import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// SWC is required so NestJS decorator metadata is emitted under vitest.
// The ETC and hierarchy rules this service uses live in, and are tested by, @meridian/core.
export default defineConfig({ plugins: [swc.vite()], test: { include: ['src/**/*.spec.ts'], passWithNoTests: true } });
