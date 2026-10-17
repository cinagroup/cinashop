import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';
if (process.env.TEST_SUPPLIER_EXTRACT_MEDIA_BROWSER !== '1' || !process.env.TEST_FINANCE_POSTGRES_URL)
  throw Error('Supplier extract media Browser acceptance requires its explicit owned local PG16 runner');
export default defineConfig({ resolve: { alias: { '@': resolve(import.meta.dirname, 'src') } }, test: {
  environment: 'node', include: ['test/browser/supplier-extract-media.acceptance.ts'],
  fileParallelism: false, silent: false, testTimeout: 19 * 60_000, hookTimeout: 45_000,
} });
