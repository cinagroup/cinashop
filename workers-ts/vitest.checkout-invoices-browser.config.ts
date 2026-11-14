import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';
if (process.env.TEST_CHECKOUT_INVOICES_BROWSER !== '1' || !process.env.TEST_FINANCE_POSTGRES_URL)
  throw Error('Checkout invoices Browser acceptance requires its explicit owned PG16 runner');
export default defineConfig({ resolve: { alias: { '@': resolve(import.meta.dirname, 'src') } }, test: {
  environment: 'node', include: ['test/browser/checkout-invoices.acceptance.ts'],
  fileParallelism: false, silent: false, testTimeout: 36 * 60_000, hookTimeout: 45_000,
} });
