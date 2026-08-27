import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  allocateSplitOrderAmounts,
  normalizeSupplierSplitCartInput,
  reserveChildOrderIds,
} from "@/services/supplier/SupplierFulfillmentService";

function splitAmountSource() {
  return {
    freightPrice: "12.00",
    totalPrice: "100.01",
    totalPostage: "12.00",
    payPrice: "90.01",
    payPostage: "8.00",
    deductionPrice: "1.00",
    couponPrice: "9.00",
    promotionsPrice: "0.00",
    firstOrderPrice: "0.00",
    changePrice: "0.00",
    gainIntegral: "10.00",
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

describe("supplier split fulfillment input", () => {
  it("normalizes PHP-compatible cart_ids and rejects ambiguous quantities", () => {
    expect(
      normalizeSupplierSplitCartInput({
        cart_ids: [
          { cart_id: "CART-A", cart_num: 2 },
          { cart_id: 91, cart_num: "1" },
        ],
      }),
    ).toEqual([
      { cartId: "CART-A", cartNum: 2 },
      { cartId: "91", cartNum: 1 },
    ]);
    expect(() => normalizeSupplierSplitCartInput({ cart_ids: [] })).toThrow("请选择发货商品");
    expect(() =>
      normalizeSupplierSplitCartInput({
        cart_ids: [
          { cart_id: "CART-A", cart_num: 1 },
          { cart_id: "CART-A", cart_num: 1 },
        ],
      }),
    ).toThrow("同一商品不能重复选择");
    expect(() =>
      normalizeSupplierSplitCartInput({ cart_ids: [{ cart_id: "CART-A", cart_num: 1.5 }] }),
    ).toThrow("发货件数必须是正整数");
  });

  it("allocates every order amount conservatively and leaves rounding remainder pending", () => {
    const source = splitAmountSource();
    const result = allocateSplitOrderAmounts(source, 1n, 3n);
    for (const key of Object.keys(source)) {
      if (key === "payIntegral") continue;
      const field = key as keyof typeof source;
      expect(Number(result.selected[field]) + Number(result.remaining[field])).toBeCloseTo(
        Number(source[field]),
        2,
      );
    }
    expect(result.selected.payPrice).toBe("30.00");
    expect(result.remaining.payPrice).toBe("60.01");
    expect(result.selected.payIntegral).toBe(2);
    expect(result.remaining.payIntegral).toBe(5);
  });

  it("reserves bounded child order IDs without reusing an existing suffix", () => {
    const ids = reserveChildOrderIds(
      "CS202608090012345678901234567890",
      ["CS2026080900123456789012345678_2"],
      2,
    );
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    expect(ids.every((id) => id.length <= 32)).toBe(true);
    expect(ids).not.toContain("CS2026080900123456789012345678_2");
  });
});

describe("supplier split fulfillment migration contracts", () => {
  it("registers all PHP-compatible split routes", () => {
    const source = readFileSync("src/routes/supplierapi.ts", "utf8");
    expect(source).toContain('"/order/split_cart_info/:id"');
    expect(source).toContain('"/order/split_delivery/:id"');
    expect(source).toContain('"/order/split_order/:id"');
  });

  it("keeps the file migration and embedded Worker migration byte-equivalent after trimming", () => {
    const migration = readFileSync("migrations/0017_supplier_split_fulfillment.sql", "utf8").trim();
    const service = readFileSync("src/services/MigrationService.ts", "utf8");
    const embedded = service.match(/private migration_0024\(\): string \{\s*return `([\s\S]*?)`;\s*\}/)?.[1]?.trim();
    expect(embedded).toBe(migration);
  });

  it("locks the logical order and initializes new cart snapshots for future splits", () => {
    const fulfillment = readFileSync(
      "src/services/supplier/SupplierFulfillmentService.ts",
      "utf8",
    );
    const orderCreate = readFileSync("src/services/order/StoreOrderCreateService.ts", "utf8");
    expect(fulfillment).toContain("lockOrderSettlement(tx, rootId)");
    expect(fulfillment).toContain('.for("update")');
    expect(orderCreate).toContain("splitSurplusNum: cart.cartNum");
  });
});
