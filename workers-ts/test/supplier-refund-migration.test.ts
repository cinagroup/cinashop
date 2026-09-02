import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  normalizeSupplierRefundDecisionInput,
  parseSupplierRefundReasons,
} from "@/services/supplier/SupplierAfterSaleService";
import { requiredSupplierPermissions } from "@/services/supplier/SupplierPermissionService";

describe("supplier refund compatibility migration", () => {
  it("normalizes the legacy reason configuration into a bounded exact-filter catalog", () => {
    expect(parseSupplierRefundReasons(" 商品破损\r\n发错商品\r不想要了\n\n"))
      .toEqual(["商品破损", "发错商品", "不想要了"]);
    expect(parseSupplierRefundReasons(Array.from({ length: 120 }, (_, index) => `原因${index}`).join("\n")))
      .toHaveLength(100);
    expect(parseSupplierRefundReasons(` ${"x".repeat(300)} `)[0]).toHaveLength(255);
  });

  it("requires an exact, bounded amount and rejects the legacy mixed approve/refuse contract", () => {
    expect(normalizeSupplierRefundDecisionInput({ refund_price: "44.91" })).toEqual({
      type: 1,
      refundPriceCents: 4491,
    });
    expect(normalizeSupplierRefundDecisionInput({ type: "1", refund_price: 0 })).toEqual({
      type: 1,
      refundPriceCents: 0,
    });
    expect(() => normalizeSupplierRefundDecisionInput({ type: 2, refund_price: "44.91" }))
      .toThrow("仅接受同意操作");
    expect(() => normalizeSupplierRefundDecisionInput({ refund_price: "44.911" }))
      .toThrow("退款金额格式错误");
    expect(() => normalizeSupplierRefundDecisionInput({})).toThrow("请输入退款金额");
  });

  it("mounts both active legacy GET contracts behind refund-view permission", () => {
    const routes = readFileSync("src/routes/supplierapi.ts", "utf8");
    expect(routes).toContain('get("/refund/refund/:id", SupplierController.refundForm)');
    expect(routes).toContain('get("/refund/reason", SupplierController.refundReasons)');
    expect(routes).not.toContain('get("/refund/agree/:');
    expect(requiredSupplierPermissions("GET", "/supplierapi/refund/refund/7"))
      .toEqual(["supplier.refund.view"]);
    expect(requiredSupplierPermissions("GET", "/supplierapi/refund/reason"))
      .toEqual(["supplier.refund.view"]);
    expect(requiredSupplierPermissions("PUT", "/supplierapi/refund/refund/7"))
      .toEqual(["supplier.refund.manage"]);
  });

  it("rebinds the submitted amount and tenant identity inside the locked refund state machine", () => {
    const service = readFileSync("src/services/supplier/SupplierAfterSaleService.ts", "utf8");
    const controller = readFileSync("src/controllers/supplier/SupplierController.ts", "utf8");
    const frontend = readFileSync("../view/supplier-ts/src/api/supplier.ts", "utf8");
    expect(service).toContain("const rows = await withTx(this.container");
    expect(service).toContain('.for("update")');
    expect(service).toContain("expectedSupplierId: supplierId");
    expect(service).toContain("expectedRefundAmountCents: authorizedCents");
    expect(service).toContain("expectedRefundedAmountCents: completedReplay ? authorizedCents : 0");
    expect(service).toContain("部分退款请拆分为独立售后单");
    expect(service).toContain('changeType: "supplier_refund_execute"');
    expect(controller).toContain("normalizeSupplierRefundDecisionInput(await readJsonObject(c))");
    expect(frontend).toContain("data: { type: 1, refund_price: refundPrice }");
  });

  it("records the unsafe legacy GET mutation as an evidence-backed retirement", () => {
    const decisions = JSON.parse(readFileSync("audit/legacy-route-decisions.json", "utf8"));
    expect(decisions.decisions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        surface: "supplier",
        method: "GET",
        path: "/supplierapi/refund/agree/:order_id",
        status: "retired",
      }),
    ]));
  });
});
