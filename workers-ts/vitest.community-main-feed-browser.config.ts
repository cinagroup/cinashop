import { defineConfig } from "vitest/config";
import { resolve } from "node:path";
if (process.env.TEST_COMMUNITY_MAIN_FEED_BROWSER !== "1" || !process.env.TEST_FINANCE_POSTGRES_URL)
  throw Error("Main feed Browser requires owned local PG16");
export default defineConfig({ resolve: { alias: { "@": resolve(import.meta.dirname, "src") } }, test: {
  environment: "node", include: ["test/browser/community-main-feed.acceptance.ts"], fileParallelism: false,
  maxWorkers: 1, silent: false, testTimeout: 9 * 60_000, hookTimeout: 45_000,
} });
