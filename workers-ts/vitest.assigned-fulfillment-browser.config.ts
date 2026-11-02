import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';
if (process.env.TEST_ASSIGNED_FULFILLMENT_BROWSER !== '1' || !process.env.TEST_FINANCE_POSTGRES_URL)
  throw Error('Assigned fulfillment Browser requires the owned PG16 host');
export default defineConfig({ resolve: { alias: { '@': resolve(import.meta.dirname, 'src') } }, test: {
  environment: 'node', include: ['test/browser/assigned-fulfillment.acceptance.ts'], fileParallelism: false, maxWorkers: 1,
  silent: false, testTimeout: 9 * 60000, hookTimeout: 60000,
} });
