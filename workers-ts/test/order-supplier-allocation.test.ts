import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { allocateSplitOrderAmounts } from "@/services/supplier/SupplierFulfillmentService";
import { buildSupplierAllocationPlan } from "@/services/order/OrderSupplierAllocationService";

function amountSource() {
  return {
    freightPrice: "6.01",
    totalPrice: "100.01",
    totalPostage: "6.01",
    payPrice: "93.01",
    payPostage: "6.01",
    deductionPrice: "1.00",
    couponPrice: "6.00",
    promotionsPrice: "0.00",
    firstOrderPrice: "0.00",
    changePrice: "0.00",
    gainIntegral: "9.00",
    useIntegral: "3.00",
    backIntegral: "0.00",
    oneBrokerage: "5.01",
    twoBrokerage: "2.00",
    divisionBrokerage: "1.00",
    divisionAgentBrokerage: "0.50",
    divisionStaffBrokerage: "0.25",
    payIntegral: 7,
  };
}

describe("支付后 Supplier 自动分配", () => {
  it("按有效 Supplier 分组，并把失效 Supplier 与平台商品留给平台履约", () => {
    const plan = buildSupplierAllocationPlan(
      [
        { id: 1, type: 0, relationId: 0, cartNum: 1, weight: 100n },
        { id: 2, type: 2, relationId: 9, cartNum: 2, weight: 250n },
        { id: 3, type: 2, relationId: 7, cartNum: 1, weight: 300n },
        { id: 4, type: 2, relationId: 99, cartNum: 1, weight: 400n },
      ],
      new Set([7, 9]),
    );
    expect(plan).toEqual([
      { supplierId: 9, cartIds: [2], quantity: 2, weight: 500n },
      { supplierId: 7, cartIds: [3], quantity: 1, weight: 300n },
      { supplierId: 0, cartIds: [1, 4], quantity: 2, weight: 500n },
    ]);
  });

  it("旧快照没有归属元数据时沿用仍有效的订单 Supplier", () => {
    expect(
      buildSupplierAllocationPlan(
        [{ id: 1, type: 0, relationId: 0, cartNum: 2, weight: 80n }],
        new Set([5]),
        5,
      ),
    ).toEqual([{ supplierId: 5, cartIds: [1], quantity: 2, weight: 160n }]);
    expect(
      buildSupplierAllocationPlan(
        [{ id: 1, type: 0, relationId: 0, cartNum: 2, weight: 80n }],
        new Set(),
        5,
      ),
    ).toEqual([{ supplierId: 0, cartIds: [1], quantity: 2, weight: 160n }]);
  });

  it("连续分配三个经营主体后所有金额与积分仍严格守恒", () => {
    const source = amountSource();
    let remaining = { ...source };
    const weights = [2n, 3n, 5n];
    let remainingWeight = 10n;
    const allocations = weights.map((weight) => {
      const result = allocateSplitOrderAmounts(remaining, weight, remainingWeight);
      remaining = { ...remaining, ...result.remaining };
      remainingWeight -= weight;
      return result.selected;
    });
    for (const key of Object.keys(source)) {
      const field = key as keyof typeof source;
      const total = allocations.reduce((sum, allocation) => sum + Number(allocation[field]), 0);
      expect(total).toBeCloseTo(Number(source[field]), 2);
    }
    expect(allocations.map((allocation) => allocation.payPrice)).toEqual([
      "18.60",
      "27.90",
      "46.51",
    ]);
    expect(allocations.map((allocation) => allocation.payIntegral)).toEqual([1, 2, 4]);
  });

  it("把分配放在支付 outbox 事务内，并在子单生成后逐单记 Supplier 流水", () => {
    const outbox = readFileSync("src/services/order/OrderOutboxService.ts", "utf8");
    const allocation = readFileSync(
      "src/services/order/OrderSupplierAllocationService.ts",
      "utf8",
    );
    expect(outbox).toContain("allocatePaidOrderBySupplier");
    expect(outbox).toContain("for (const fulfillmentOrder of allocation.fulfillmentOrders)");
    expect(outbox).toContain("recordSupplierPayment(tx, fulfillmentOrder, now)");
    expect(allocation).toContain("pg_advisory_xact_lock");
    expect(allocation).toContain('.for("update")');
    expect(allocation).toContain('changeType: "supplier_order_split"');
  });

  it("下单保存经营主体快照且不再拒绝混合 Supplier", () => {
    const source = readFileSync("src/services/order/StoreOrderCreateService.ts", "utf8");
    expect(source).not.toContain("暂不支持跨供应商合并下单");
    expect(source).toContain("supplierAllocationStatus: requiresSupplierAllocation ? 1 : 0");
    expect(source).toContain("type: product.type");
    expect(source).toContain("relationId: product.relationId");
  });

  it("保持物理迁移与 Worker 内嵌迁移一致", () => {
    const migration = readFileSync(
      "migrations/0018_supplier_order_allocation.sql",
      "utf8",
    ).trim();
    const service = readFileSync("src/services/MigrationService.ts", "utf8");
    const embedded = service
      .match(/private migration_0025\(\): string \{\s*return `([\s\S]*?)`;\s*\}/)?.[1]
      ?.trim();
    expect(embedded).toBe(migration);
  });
});
