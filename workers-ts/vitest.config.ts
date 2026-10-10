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
    // 集成测试 (涉及 DO/Queue/Hyperdrive) 使用 @cloudflare/vitest-plugin
    environment: "node",
    globals: false,
    // Keep the full cluster-role snapshot isolated from other files' role setup and cleanup.
    projects: [
      {
        extends: true,
        test: {
          name: "regular-unit",
          include: ["test/*.test.ts"],
          exclude: ["test/admin-authority-maintenance-native.test.ts"],
          sequence: { groupOrder: 0 },
        },
      },
      {
        extends: true,
        test: {
          name: "admin-authority-maintenance-native",
          include: ["test/admin-authority-maintenance-native.test.ts"],
          sequence: { groupOrder: 1 },
        },
      },
    ],
  },
});
