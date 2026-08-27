import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("订单创建 PostgreSQL 事务迁移", () => {
  it("生产 createOrder 与集成场景共用窄运行时事务核心", () => {
    const source = readFileSync("src/services/order/StoreOrderCreateService.ts", "utf8");
    expect(source).toContain("export interface StoreOrderCreationRuntime extends SystemConfigEnv");
    expect(source).toContain("static async createWithRuntime(");
    expect(source).toContain("return StoreOrderCreateService.createWithRuntime(");
    expect(source).toContain("const orderRow = await withTx(c, async (tx) => {");
  });

  it("同一用户和幂等键在事务内串行并复查已有订单", () => {
    const source = readFileSync("src/services/order/StoreOrderCreateService.ts", "utf8");
    expect(source).toContain("pg_advisory_xact_lock(");
    expect(source).toContain("cinashop:create-order:${uid}:${key}");
    expect(source).toContain("const concurrentExistingRows = await tx");
    expect(source).toContain("if (concurrentExistingRows[0]) return concurrentExistingRows[0];");
  });

  it("保留生产 PostgreSQL 临时 schema 的购物车、库存与活动补偿场景", () => {
    const scenario = readFileSync(
      "test/integration/StoreOrderCreatePostgresScenario.ts",
      "utf8",
    );
    expect(scenario).toContain("codex_create_order_it_");
    expect(scenario).toContain("StoreOrderCreateService.createWithRuntime(container, createRuntime(), params)");
    expect(scenario).toContain("Promise.allSettled([");
    expect(scenario).toContain("same cart was not claimed exactly once");
    expect(scenario).toContain("same key did not return the same order twice");
    expect(scenario).toContain("oversell rollback left order/cart side effects");
    expect(scenario).toContain("seckill cancellation did not restore all stock");
    expect(scenario).toContain("bargain cancellation did not restore all stock");
    expect(scenario).toContain("combination cancellation did not restore all stock");
    expect(scenario).toContain("integral order did not reserve authoritative price, points and inventory");
    expect(scenario).toContain("integral cancellation did not restore all three inventory layers");
    expect(scenario).toContain("DROP SCHEMA ${schemaIdentifier} CASCADE");
    expect(scenario).toContain("public business rows or sequences changed");
  });
});
