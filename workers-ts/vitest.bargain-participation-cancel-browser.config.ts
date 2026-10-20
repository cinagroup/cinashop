import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';
if (process.env.TEST_BARGAIN_PARTICIPATION_CANCEL_BROWSER !== '1' || !process.env.TEST_FINANCE_POSTGRES_URL)
  throw Error('Bargain participation cancellation Browser requires owned local PG16');
export default defineConfig({ resolve: { alias: { '@': resolve(import.meta.dirname, 'src') } }, test: {
  environment: 'node', include: ['test/browser/bargain-participation-cancel.acceptance.ts'], fileParallelism: false,
  silent: false, testTimeout: 21 * 60_000, hookTimeout: 45_000,
} });
