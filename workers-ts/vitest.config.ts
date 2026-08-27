import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@": resolve(import.meta.dirname, "src"),
    },
  },
  test: {
    // 纯单元测试用 node 环境 (不依赖 Workers runtime)
    // 集成测试 (涉及 DO/Queue/Hyperdrive) 后续切 @cloudflare/vitest-pool-workers
    environment: "node",
    include: ["test/*.test.ts"],
    globals: false,
  },
});
