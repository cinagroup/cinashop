import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';
if (process.env.TEST_SUPPLIER_PROACTIVE_REFUND_BROWSER !== '1' || !process.env.TEST_FINANCE_POSTGRES_URL)
  throw Error('Supplier proactive refund Browser acceptance requires its explicit owned local PG16 runner');
export default defineConfig({ resolve: { alias: { '@': resolve(import.meta.dirname, 'src') } }, test: {
  environment: 'node', include: ['test/browser/supplier-proactive-refund.acceptance.ts'],
  fileParallelism: false, silent: false, testTimeout: 19 * 60_000, hookTimeout: 45_000,
} });
