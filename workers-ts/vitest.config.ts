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
          exclude: ["test/admin-authority-maintenance-native.test.ts", "test/admin-profile-native.test.ts", "test/admin-platform-menu-native.test.ts", "test/admin-express-native.test.ts", "test/admin-level-native.test.ts", "test/admin-label-native.test.ts", "test/admin-store-native.test.ts", "test/admin-staff-native.test.ts",
            "test/admin-guest-invoice-manual-red-note-postgres.test.ts",
            "test/manager-runtime-privileges-native.test.ts", "test/manager-runtime-provision-postgres.test.ts",
            "test/manager-routine-payment-runtime-native.test.ts", "test/manager-routine-payment-provision-native.test.ts",
            "test/manager-runtime-bootstrap-postgres.test.ts", "test/manager-runtime-capabilities-bootstrap-postgres.test.ts"],
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
      {
        extends: true,
        test: {
          name: "admin-profile-native",
          include: ["test/admin-profile-native.test.ts"],
          maxWorkers: 1,
          fileParallelism: false,
          sequence: { groupOrder: 4 },
        },
      },
      {
        extends: true,
        test: {
          name: "admin-platform-menu-native",
          include: ["test/admin-platform-menu-native.test.ts"],
          maxWorkers: 1,
          fileParallelism: false,
          sequence: { groupOrder: 5 },
        },
      },
      {
        extends: true,
        test: {
          name: "admin-express-native",
          include: ["test/admin-express-native.test.ts"],
          maxWorkers: 1,
          fileParallelism: false,
          sequence: { groupOrder: 6 },
        },
      },
      {
        extends: true,
        test: {
          name: "admin-level-native",
          include: ["test/admin-level-native.test.ts"],
          maxWorkers: 1,
          fileParallelism: false,
          sequence: { groupOrder: 7 },
        },
      },
      {
        extends: true,
        test: {
          name: "admin-label-native",
          include: ["test/admin-label-native.test.ts"],
          maxWorkers: 1,
          fileParallelism: false,
          sequence: { groupOrder: 8 },
        },
      },
      {
        extends: true,
        test: {
          name: "admin-store-native",
          include: ["test/admin-store-native.test.ts"],
          maxWorkers: 1,
          fileParallelism: false,
          sequence: { groupOrder: 9 },
        },
      },
      {
        extends: true,
        test: {
          name: "admin-staff-native",
          include: ["test/admin-staff-native.test.ts"],
          maxWorkers: 1,
          fileParallelism: false,
          sequence: { groupOrder: 9 },
        },
      },
      {
        extends: true,
        test: {
          name: "manager-runtime-commissioning-native",
          include: ["test/manager-runtime-privileges-native.test.ts", "test/manager-runtime-provision-postgres.test.ts",
            "test/manager-routine-payment-runtime-native.test.ts", "test/manager-routine-payment-provision-native.test.ts",
            "test/manager-runtime-bootstrap-postgres.test.ts", "test/manager-runtime-capabilities-bootstrap-postgres.test.ts"],
          maxWorkers: 1,
          fileParallelism: false,
          sequence: { groupOrder: 2 },
        },
      },
      {
        extends: true,
        test: {
          name: "guest-invoice-manual-red-note-native",
          include: ["test/admin-guest-invoice-manual-red-note-postgres.test.ts"],
          maxWorkers: 1,
          fileParallelism: false,
          sequence: { groupOrder: 3 },
        },
      },
    ],
  },
});
