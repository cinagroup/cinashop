import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';
if (process.env.TEST_SUPPLIER_ORDER_INVOICE_REVIEW_BROWSER !== '1' || !process.env.TEST_FINANCE_POSTGRES_URL)
  throw Error('Supplier invoice review Browser acceptance requires the owned local PG16 runner');
export default defineConfig({ resolve: { alias: { '@': resolve(import.meta.dirname, 'src') } }, test: {
  environment: 'node', include: ['test/browser/supplier-order-invoice-review.acceptance.ts'],
  fileParallelism: false, silent: false, testTimeout: 21 * 60_000, hookTimeout: 45_000,
} });
