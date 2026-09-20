import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

// Opt-in, reproducible regression: owned PG16 and prebuilt Admin, no dependency installation.
export default defineConfig({
  resolve: { alias: { '@': resolve(import.meta.dirname, 'src') } },
  test: { environment: 'node', include: ['test/browser/admin-order-generations.acceptance.ts'],
    fileParallelism: false, silent: false, testTimeout: 180000, hookTimeout: 45000 },
});
