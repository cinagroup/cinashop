import { defineConfig } from "vitest/config";
import { resolve } from "node:path";
import { collectFixedRoleTestFiles } from "./scripts/fixedRoleTestFiles";

const fixedRoleTestFiles = collectFixedRoleTestFiles(import.meta.dirname).files;
const fixedRoleSet = new Set(fixedRoleTestFiles);

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
        extends: true as const,
        test: {
          name: "regular-unit",
          include: ["test/*.test.ts"],
          exclude: ["test/admin-authority-maintenance-native.test.ts", "test/admin-profile-native.test.ts", "test/admin-platform-menu-native.test.ts", "test/admin-express-native.test.ts", "test/admin-level-native.test.ts", "test/admin-label-native.test.ts", "test/admin-store-native.test.ts", "test/admin-staff-native.test.ts",
            "test/admin-guest-invoice-manual-red-note-postgres.test.ts",
            ...fixedRoleTestFiles],
          sequence: { groupOrder: 0 },
        },
      },
      {
        extends: true as const,
        test: {
          name: "admin-authority-maintenance-native",
          include: ["test/admin-authority-maintenance-native.test.ts"],
          sequence: { groupOrder: 1 },
        },
      },
      {
        extends: true as const,
        test: {
          name: "admin-profile-native",
          include: ["test/admin-profile-native.test.ts"],
          maxWorkers: 1,
          fileParallelism: false,
          sequence: { groupOrder: 4 },
        },
      },
      {
        extends: true as const,
        test: {
          name: "admin-platform-menu-native",
          include: ["test/admin-platform-menu-native.test.ts"],
          maxWorkers: 1,
          fileParallelism: false,
          sequence: { groupOrder: 5 },
        },
      },
      {
        extends: true as const,
        test: {
          name: "admin-express-native",
          include: ["test/admin-express-native.test.ts"],
          maxWorkers: 1,
          fileParallelism: false,
          sequence: { groupOrder: 6 },
        },
      },
      {
        extends: true as const,
        test: {
          name: "admin-level-native",
          include: ["test/admin-level-native.test.ts"],
          maxWorkers: 1,
          fileParallelism: false,
          sequence: { groupOrder: 7 },
        },
      },
      {
        extends: true as const,
        test: {
          name: "admin-label-native",
          include: ["test/admin-label-native.test.ts"],
          maxWorkers: 1,
          fileParallelism: false,
          sequence: { groupOrder: 8 },
        },
      },
      {
        extends: true as const,
        test: {
          name: "admin-store-native",
          include: ["test/admin-store-native.test.ts"],
          maxWorkers: 1,
          fileParallelism: false,
          sequence: { groupOrder: 9 },
        },
      },
      {
        extends: true as const,
        test: {
          name: "admin-staff-native",
          include: ["test/admin-staff-native.test.ts"],
          maxWorkers: 1,
          fileParallelism: false,
          sequence: { groupOrder: 9 },
        },
      },
      {
        extends: true as const,
        test: {
          name: "fixed-role-native",
          include: fixedRoleTestFiles,
          maxWorkers: 1,
          fileParallelism: false,
          sequence: { groupOrder: 2 },
        },
      },
      {
        extends: true as const,
        test: {
          name: "guest-invoice-manual-red-note-native",
          include: ["test/admin-guest-invoice-manual-red-note-postgres.test.ts"],
          maxWorkers: 1,
          fileParallelism: false,
          sequence: { groupOrder: 3 },
        },
      },
    ].map(project => {
      // A newly dependent dedicated file moves to the same serial project;
      // it must not be collected a second time by its former project.
      if (project.test.name === "regular-unit" || project.test.name === "fixed-role-native") return project;
      return { ...project, test: { ...project.test, include: project.test.include.filter(file => !fixedRoleSet.has(file)) } };
    }).filter(project => project.test.include.length > 0),
  },
});
