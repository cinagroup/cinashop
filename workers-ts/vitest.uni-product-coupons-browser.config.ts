import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';
if (process.env.TEST_UNI_PRODUCT_COUPONS_BROWSER !== '1' || !process.env.TEST_FINANCE_POSTGRES_URL)
  throw Error('Uni product coupons Browser requires the explicit owned PG16 runner');
export default defineConfig({ resolve: { alias: { '@': resolve(import.meta.dirname, 'src') } }, test: {
  environment: 'node', include: ['test/browser/uni-product-coupons.acceptance.ts'], fileParallelism: false,
  silent: false, testTimeout: 92 * 60000, hookTimeout: 45000,
} });
