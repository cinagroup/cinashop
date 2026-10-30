import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

if (process.env.TEST_CUSTOMER_CASHIER_CAPABILITIES_BROWSER !== '1' || !process.env.TEST_FINANCE_POSTGRES_URL)
  throw Error('Customer Cashier Browser requires an explicit owned PG16 run');

export default defineConfig({
  resolve: { alias: { '@': resolve(import.meta.dirname, 'src') } },
  test: {
    environment: 'node',
    include: ['test/browser/customer-cashier-capabilities.acceptance.ts'],
    fileParallelism: false,
    maxWorkers: 1,
    silent: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
