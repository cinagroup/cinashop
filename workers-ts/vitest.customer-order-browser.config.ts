import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

// Explicit opt-in: owned PG16, built storefronts and existing browser tooling.
export default defineConfig({
  resolve: { alias: { '@': resolve(import.meta.dirname, 'src') } },
  test: {
    environment: 'node', include: ['test/browser/customer-order-deletion.acceptance.ts'],
    fileParallelism: false, silent: false, testTimeout: 180000, hookTimeout: 45000,
  },
});
