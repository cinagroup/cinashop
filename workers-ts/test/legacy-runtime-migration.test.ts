import { readFileSync } from "node:fs";
import { getTableColumns, getTableName } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { queueAuxiliary, queueList, systemTimer } from "@/models/schema";
import { requiredAdminPermission } from "@/services/admin/AdminPermissionService";
import {
  LEGACY_QUEUE_TYPE_NAMES,
  LEGACY_TIMER_TASK_NAMES,
  describeLegacyTimerCycle,
} from "@/services/system/LegacyRuntimeCatalogService";
import {
  MIGRATION_MANIFEST_VERSION,
  MIGRATION_TABLES,
} from "../scripts/data-migration/manifest";

describe("legacy queue and timer catalog migration", () => {
  it("preserves all three source tables and exact source columns", () => {
    expect(getTableName(queueList)).toBe("queue_list");
    expect(getTableName(queueAuxiliary)).toBe("queue_auxiliary");
    expect(getTableName(systemTimer)).toBe("system_timer");
    expect(Object.keys(getTableColumns(queueList))).toEqual([
      "id", "type", "source", "executeKey", "title", "queueInValue", "sort", "status",
      "firstTime", "againTime", "finishTime", "surplusNum", "totalNum", "isDel", "addTime",
    ]);
    expect(Object.keys(getTableColumns(queueAuxiliary))).toEqual([
      "id", "bindingId", "relationId", "type", "other", "status", "updateTime", "addTime",
    ]);
    expect(Object.keys(getTableColumns(systemTimer))).toEqual([
      "id", "name", "mark", "type", "title", "isOpen", "cycle", "lastExecutionTime",
      "updateExecutionTime", "isDel", "addTime",
    ]);
    expect(MIGRATION_TABLES.find((entry) => entry.table === "queue_list")?.key)
      .toEqual(["id", "type", "status"]);
    expect(MIGRATION_TABLES.find((entry) => entry.table === "queue_auxiliary")?.key)
      .toEqual(["id"]);
    expect(MIGRATION_TABLES.find((entry) => entry.table === "system_timer")?.key)
      .toEqual(["id"]);
    expect(MIGRATION_MANIFEST_VERSION).toBe("2026-08-11.57");
  });

  it("keeps external 0073 and embedded 0080 SQL exactly equivalent", () => {
    const migration = readFileSync("migrations/0073_legacy_runtime_catalog.sql", "utf8").trim();
    const service = readFileSync("src/services/MigrationService.ts", "utf8");
    const embedded = service.match(
      /private migration_0080\(\): string \{\s*return `([\s\S]*?)`;\s*\}/,
    )?.[1]?.trim();
    expect(embedded).toBe(migration);
    expect(migration).toContain('CONSTRAINT "queue_list_pk" PRIMARY KEY ("id", "type", "status")');
    expect(migration).not.toMatch(/FOREIGN KEY\s*\(|REFERENCES\s+"/i);
    expect(migration).not.toMatch(/CREATE UNIQUE INDEX/i);
    expect(migration).not.toMatch(/\bINSERT\s+INTO\b/i);
  });

  it("retains the source catalogs while exposing the honest Worker boundary", () => {
    expect(Object.keys(LEGACY_QUEUE_TYPE_NAMES)).toHaveLength(10);
    expect(Object.keys(LEGACY_TIMER_TASK_NAMES)).toHaveLength(18);
    expect(LEGACY_TIMER_TASK_NAMES.auto_take).toBe("自动确认收货");
    expect(describeLegacyTimerCycle(1, "30")).toBe("每隔 30 分钟");
    expect(describeLegacyTimerCycle(4, "10/25")).toBe("每天 10:25");
    expect(describeLegacyTimerCycle(8, "1/2/3/4")).toBe("每年 1 月 2 日，3:4");

    const runtime = readFileSync(
      "src/services/system/LegacyRuntimeCatalogService.ts",
      "utf8",
    );
    expect(runtime).toContain('auto_take: {');
    expect(runtime).toContain('workerJob: "auto_receipt"');
    expect(runtime).toContain('auto_comment: {');
    expect(runtime).toContain('status: "partially_implemented"');
    expect(runtime).toContain('runtime_status: runtime?.status ?? (runtime ? "implemented_independently" : "not_migrated")');
    expect(runtime).toContain('runtime_authority: "cloudflare_queues"');
    expect(runtime).not.toContain("ORDER_QUEUE.send");
  });

  it("restores read-only compatibility routes and isolates their permission", () => {
    const adminRoutes = readFileSync("src/routes/adminapi.ts", "utf8");
    const aliases = readFileSync("src/routes/v1/index.ts", "utf8");
    for (const path of [
      "/system/timer/task",
      "/system/timer/index",
      "/system/timer/one/:id",
      "/queue/index",
      "/queue/delivery/log/:id/:type",
    ]) {
      expect(adminRoutes).toContain(path);
    }
    expect(aliases).toContain('/admin/system/timer/index');
    expect(aliases).toContain('/admin/queue/index');
    expect(adminRoutes).not.toContain("/queue/again/do_queue");
    expect(adminRoutes).not.toContain("/queue/stop/wrong_queue");
    expect(adminRoutes).not.toContain("/system/timer/save");
    expect(requiredAdminPermission("GET", "/adminapi/system/timer/index"))
      .toBe("legacy_runtime.view");
    expect(requiredAdminPermission("GET", "/adminapi/queue/index"))
      .toBe("legacy_runtime.view");
  });

  it("wires a responsive read-only Admin view with no fake controls", () => {
    const router = readFileSync("../view/admin-ts/src/router/index.ts", "utf8");
    const layout = readFileSync("../view/admin-ts/src/layouts/AdminLayout.vue", "utf8");
    const page = readFileSync(
      "../view/admin-ts/src/pages/operations/LegacyRuntimeHistory.vue",
      "utf8",
    );
    expect(router).toContain('path: "operations/legacy-runtime"');
    expect(layout).toContain('index="/operations/legacy-runtime"');
    expect(page).toContain("不是 Cloudflare 的任务控制台");
    expect(page).toContain("不提供伪重试按钮");
    expect(page).toContain("mobile-list");
    expect(page).toContain("apiLegacyQueueLogs");
    expect(page).not.toContain("重试任务");
    expect(page).not.toContain("停止任务");
    expect(page).not.toContain("启用任务");
  });
});
