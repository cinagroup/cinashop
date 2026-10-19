import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';
if (process.env.TEST_REFUND_APPLICATION_EVIDENCE_BROWSER !== '1' || !process.env.TEST_FINANCE_POSTGRES_URL)
  throw Error('Refund application evidence Browser requires the owned local PG16 runner');
export default defineConfig({ resolve: { alias: { '@': resolve(import.meta.dirname, 'src') } }, test: {
  environment: 'node', include: ['test/browser/refund-application-evidence.acceptance.ts'],
  fileParallelism: false, silent: false, testTimeout: 21 * 60_000, hookTimeout: 45_000,
} });
