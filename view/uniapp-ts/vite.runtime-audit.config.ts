import { defineConfig } from "vite";
import base from "./vite.config";
const { runtimeI18nAudit } = require("./scripts/runtime-i18n-audit.cjs");

// Audit-only wrapper; ordinary builds keep the original configuration and output.
export default defineConfig({
  ...base,
  plugins: [...(base.plugins || []), runtimeI18nAudit()],
});
