import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

// Explicit interactive Browser-plugin host, outside the zero-skip unit suite.
// The owned local PG16 runner supplies both gates; this launches no driver.
if (process.env.TEST_SUPPLIER_VIDEO_BROWSER !== '1' || !process.env.TEST_FINANCE_POSTGRES_URL) {
  throw Error('Supplier video Browser acceptance requires its explicit owned local PG16 runner');
}
export default defineConfig({
  resolve: { alias: { '@': resolve(import.meta.dirname, 'src') } },
  test: {
    environment: 'node', include: ['test/browser/supplier-product-video.acceptance.ts'],
    fileParallelism: false, silent: false, testTimeout: 19 * 60_000, hookTimeout: 45_000,
  },
});
