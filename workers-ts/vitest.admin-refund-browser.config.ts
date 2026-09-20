import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

// Explicit opt-in acceptance workflow, not a skipped test in the unit suite.
// Requires the owned native PostgreSQL runner and existing browser tooling.
export default defineConfig({
  resolve: { alias: { '@': resolve(import.meta.dirname, 'src') } },
  test: {
    environment: 'node', include: ['test/browser/admin-refund-operation.acceptance.ts'],
    fileParallelism: false, silent: false, testTimeout: 180000, hookTimeout: 45000,
  },
});
