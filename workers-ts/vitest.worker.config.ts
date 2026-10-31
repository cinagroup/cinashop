import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import { resolve } from "node:path";
import process from "node:process";

// Only Node reads the dedicated local-test URL. The worker receives this one
// value through Vitest, and the native fixture validates it before any SQL.
const financePostgresUrl = process.env.TEST_FINANCE_POSTGRES_URL;
if (typeof financePostgresUrl !== "string" || financePostgresUrl.length === 0) {
  throw new Error("workerd tests require an explicit TEST_FINANCE_POSTGRES_URL for the owned PostgreSQL16 fixture");
}

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: {
        configPath: "./wrangler.test.toml",
      },
    }),
  ],
  resolve: {
    alias: {
      "@": resolve(import.meta.dirname, "src"),
    },
  },
  test: {
    include: ["test/runtime/**/*.test.ts"],
    globals: false,
    maxWorkers: 1,
    fileParallelism: false,
    provide: { financePostgresUrl },
  },
});
