import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';
if (process.env.TEST_CUSTOMER_SIGN_CENTRE_BROWSER !== '1' || !process.env.TEST_FINANCE_POSTGRES_URL) throw Error('Sign centre Browser requires owned local PG16');
export default defineConfig({ resolve: { alias: { '@': resolve(import.meta.dirname, 'src') } }, test: {
  environment: 'node', include: ['test/browser/customer-sign-centre.acceptance.ts'], fileParallelism: false, maxWorkers: 1,
  silent: false, testTimeout: 54 * 60_000, hookTimeout: 45_000,
} });
