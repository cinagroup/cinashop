import { readFileSync } from "node:fs";
import { getTableColumns, getTableName } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { MIGRATION_TABLES } from "../scripts/data-migration/manifest";
import { agentLevelTask, agentLevelTaskRecord } from "../src/models/schema";
import { requiredAdminPermission } from "../src/services/admin/AdminPermissionService";
import {
  AGENT_TASK_TYPES,
  calculateAgentTaskProgress,
  type AgentTaskMetrics,
} from "../src/services/agent/AgentLevelTaskService";

const metrics: AgentTaskMetrics = {
  inviteCount: 4,
  ownOrderCents: 12_345,
  ownOrderCount: 3,
  downlineOrderCents: 45_600,
  downlineOrderCount: 8,
};

describe("agent level task migration", () => {
  it("preserves both source table contracts exactly", () => {
    expect(getTableName(agentLevelTask)).toBe("agent_level_task");
    expect(Object.keys(getTableColumns(agentLevelTask))).toEqual([
      "id",
      "levelId",
      "name",
      "type",
      "number",
      "desc",
      "isMust",
      "sort",
      "status",
      "isDel",
      "addTime",
    ]);
    expect(getTableName(agentLevelTaskRecord)).toBe("agent_level_task_record");
    expect(Object.keys(getTableColumns(agentLevelTaskRecord))).toEqual([
      "id",
      "uid",
      "levelId",
      "taskId",
      "status",
      "addTime",
    ]);
  });

  it("uses stable primary keys without inventing historical uniqueness", () => {
    expect(MIGRATION_TABLES.find((entry) => entry.table === "agent_level_task")?.key)
      .toEqual(["id"]);
    const recordSpec = MIGRATION_TABLES.find(
      (entry) => entry.table === "agent_level_task_record",
    );
    expect(recordSpec?.key).toEqual(["id"]);
    expect(recordSpec?.note).toContain("historical duplicate");
    const migration = readFileSync("migrations/0051_agent_level_tasks.sql", "utf8");
    expect(migration).not.toContain("CREATE UNIQUE INDEX");
    expect(migration).toContain('("uid", "level_id", "task_id", "id")');
  });

  it("calculates count and money task progress without floating-point thresholds", () => {
    expect(AGENT_TASK_TYPES.map((item) => item.type)).toEqual([1, 2, 3, 4, 5]);
    expect(calculateAgentTaskProgress({ type: 1, number: 5 }, metrics)).toMatchObject({
      complete: false,
      current: 4,
      displayRemaining: 1,
      speed: 80,
    });
    expect(calculateAgentTaskProgress({ type: 2, number: 100 }, metrics)).toMatchObject({
      complete: true,
      current: 12_345,
      target: 10_000,
      displayCurrent: 123.45,
      speed: 100,
    });
    expect(calculateAgentTaskProgress({ type: 4, number: 500 }, metrics)).toMatchObject({
      complete: false,
      displayRemaining: 44,
      speed: 91,
    });
    expect(calculateAgentTaskProgress({ type: 0, number: 0 }, metrics).complete).toBe(false);
  });

  it("batches task metrics and serializes catalog and per-user completion writes", () => {
    const service = readFileSync("src/services/agent/AgentLevelTaskService.ts", "utf8");
    expect(service).toContain("pg_advisory_xact_lock_shared");
    expect(service).toContain("pg_advisory_xact_lock");
    expect(service).toContain('.for("update")');
    expect(service).toContain("innerJoin(userTable");
    expect(service).toContain("Promise.all");
    expect(service).toContain("COUNT(DISTINCT");
    expect(service).toContain("已有用户完成该任务，不能修改任务类型或要求");
    expect(service).toContain("tx.insert(agentLevelTaskRecord)");
    expect(service).toContain("agentLevel: nextAgentLevel");
  });

  it("restores public and dual-admin route surfaces with distribution ACL", () => {
    const publicRoutes = readFileSync("src/routes/v1/index.ts", "utf8");
    const adminRoutes = readFileSync("src/routes/adminapi.ts", "utf8");
    expect(publicRoutes).toContain('/agent/level_list"');
    expect(publicRoutes).toContain('/agent/level_task_list"');
    for (const routes of [adminRoutes, publicRoutes]) {
      expect(routes).toContain("/agent/level_task");
      expect(routes).toContain("/agent/level_task/create");
      expect(routes).toContain("/agent/level_task/:id/edit");
      expect(routes).toContain("/agent/level_task/set_status/:id/:status");
    }
    expect(requiredAdminPermission("GET", "/adminapi/agent/level_task"))
      .toBe("distribution.view");
    expect(requiredAdminPermission("POST", "/api/admin/agent/level_task"))
      .toBe("distribution.manage");
  });
});
