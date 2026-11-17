import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';
if (process.env.TEST_KEFU_PRODUCT_MEDIA_BROWSER !== '1' || !process.env.TEST_FINANCE_POSTGRES_URL)
  throw Error('Kefu product media Browser requires the explicit owned PG16 runner');
export default defineConfig({ resolve: { alias: { '@': resolve(import.meta.dirname, 'src') } }, test: {
  environment: 'node', include: ['test/browser/kefu-product-media.acceptance.ts'], fileParallelism: false,
  silent: false, testTimeout: 18 * 60_000, hookTimeout: 45_000,
} });
