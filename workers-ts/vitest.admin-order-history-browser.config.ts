import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';
if (process.env.TEST_ADMIN_ORDER_HISTORY_BROWSER !== '1' || !process.env.TEST_FINANCE_POSTGRES_URL)
  throw Error('Admin order history Browser acceptance requires its explicit owned PG16 runner');
export default defineConfig({ resolve: { alias: { '@': resolve(import.meta.dirname, 'src') } }, test: {
  environment: 'node', include: ['test/browser/admin-order-history.acceptance.ts'],
  fileParallelism: false, silent: false, testTimeout: 16 * 60_000, hookTimeout: 45_000,
} });
