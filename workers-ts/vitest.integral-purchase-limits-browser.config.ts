import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';
if (process.env.TEST_INTEGRAL_PURCHASE_LIMITS_BROWSER !== '1' || !process.env.TEST_FINANCE_POSTGRES_URL)
  throw Error('Integral limits Browser requires owned local PG16');
export default defineConfig({ resolve: { alias: { '@': resolve(import.meta.dirname, 'src') } }, test: {
  environment: 'node', include: ['test/browser/integral-purchase-limits.acceptance.ts'], fileParallelism: false,
  silent: false, testTimeout: 21 * 60_000, hookTimeout: 45_000,
} });
