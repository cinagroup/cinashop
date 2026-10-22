import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

if (process.env.TEST_DIY_CAROUSEL_BROWSER !== '1' || !process.env.TEST_FINANCE_POSTGRES_URL) {
  throw Error('DIY carousel Browser requires owned local PG16');
}
export default defineConfig({
  resolve: { alias: { '@': resolve(import.meta.dirname, 'src') } },
  test: { environment: 'node', include: ['test/browser/diy-carousel.acceptance.ts'],
    fileParallelism: false, maxWorkers: 1, silent: false, testTimeout: 13 * 60_000, hookTimeout: 45_000 },
});
