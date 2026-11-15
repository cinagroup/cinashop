import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';
if (process.env.TEST_PC_MESSAGE_CENTER_BROWSER !== '1' || !process.env.TEST_FINANCE_POSTGRES_URL) throw Error('PC message center Browser requires its explicit owned PG16 runner');
export default defineConfig({ resolve: { alias: { '@': resolve(import.meta.dirname, 'src') } }, test: {
  environment: 'node', include: ['test/browser/pc-message-center.acceptance.ts'], fileParallelism: false, maxWorkers: 1,
  silent: false, testTimeout: 92 * 60000, hookTimeout: 60000,
} });
