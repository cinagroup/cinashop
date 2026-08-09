import { defineConfig } from "drizzle-kit";

// 本地开发用环境变量; 生产读 Hyperdrive
const url =
  process.env.DATABASE_URL ??
  "postgresql://crmeb:crmeb@localhost:5432/crmeb";

export default defineConfig({
  schema: "./src/models/schema/index.ts",
  out: "./migrations",
  dialect: "postgresql",
  dbCredentials: {
    url,
  },
  strict: true,
  verbose: true,
});
