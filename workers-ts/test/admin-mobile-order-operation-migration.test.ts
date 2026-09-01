import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  adminMobileOrderPrice,
  adminMobileOrderRemark,
  adminMobileOrderWriteoffRecords,
} from "@/controllers/api/v1/AdminController";
import {
  AdminMobileOrderOperationService,
  computeAdminOrderPrice,
  parseAdminOrderPriceInput,
  parseAdminOrderRemarkInput,
  parseAdminWriteoffRecordsInput,
  projectAdminWriteoffRecord,
} from "@/services/admin/AdminMobileOrderOperationService";
import { requiredAdminPermission } from "@/services/admin/AdminPermissionService";

afterEach(() => vi.restoreAllMocks());

function context(options: {
  body?: Record<string, unknown>;
  params?: Record<string, string>;
  adminId?: number;
} = {}) {
  const header = vi.fn();
  const raw = new Request("https://example.test/api/admin/order/action", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(options.body ?? {}),
  });
  return {
    header,
    value: {
      req: {
        raw,
        param: (name: string) => options.params?.[name] ?? "",
      },
      get: (key: string) => {
        if (key === "container") return {};
        if (key === "adminInfo") return { id: options.adminId ?? 17 };
        return undefined;
      },
      header,
      json: (body: unknown) => Response.json(body),
    } as never,
  };
}

describe("embedded admin mobile order operation migration", () => {
  it("strictly validates absolute prices without binary-float rounding", () => {
    expect(parseAdminOrderPriceInput({ order_id: "wx_1", price: "12.30" })).toEqual({
      orderId: "wx_1",
      priceCents: 1_230,
    });
    expect(parseAdminOrderPriceInput({ order_id: "wx_1", price: 0 })).toMatchObject({ priceCents: 0 });
    expect(() => parseAdminOrderPriceInput({ order_id: "wx_1", price: "-1" })).toThrow("格式错误");
    expect(() => parseAdminOrderPriceInput({ order_id: "wx_1", price: "1e3" })).toThrow("格式错误");
    expect(() => parseAdminOrderPriceInput({ order_id: "wx_1", price: "1.001" })).toThrow("格式错误");
    expect(() => parseAdminOrderPriceInput({ order_id: "wx_1", price: 1.005 })).toThrow("最多保留两位");
    expect(() => parseAdminOrderPriceInput({
      order_id: "wx_1",
      price: "10000000000.00",
    })).toThrow("超出允许范围");
  });

  it("preserves the original amount across repeated price changes", () => {
    expect(computeAdminOrderPrice("100.00", "0.00", 8_000)).toEqual({
      payPrice: "80.00",
      changePrice: "20.00",
      changed: true,
    });
    expect(computeAdminOrderPrice("80.00", "20.00", 9_000)).toEqual({
      payPrice: "90.00",
      changePrice: "10.00",
      changed: true,
    });
    expect(computeAdminOrderPrice("80.00", "20.00", 8_000).changed).toBe(false);
    expect(() => computeAdminOrderPrice("1000000.00", "0.00", 0)).toThrow("改价差额超出");
  });

  it("trims and bounds remarks", () => {
    expect(parseAdminOrderRemarkInput({ order_id: "wx-2", remark: "  已联系客户  " })).toEqual({
      orderId: "wx-2",
      remark: "已联系客户",
    });
    expect(() => parseAdminOrderRemarkInput({ order_id: "wx-2", remark: "  " })).toThrow("请填写备注内容");
    expect(() => parseAdminOrderRemarkInput({ order_id: "wx-2", remark: "a".repeat(513) })).toThrow("512");
  });

  it("accepts only bounded writeoff record filters", () => {
    expect(parseAdminWriteoffRecordsInput({})).toEqual({ productType: 0, page: 1, limit: 10 });
    expect(parseAdminWriteoffRecordsInput({ product_type: "4", page: "2", limit: "100" })).toEqual({
      productType: 4,
      page: 2,
      limit: 100,
    });
    expect(() => parseAdminWriteoffRecordsInput({ product_type: [] })).toThrow("商品类型错误");
    expect(() => parseAdminWriteoffRecordsInput({ product_type: "4.0" })).toThrow("商品类型错误");
    expect(() => parseAdminWriteoffRecordsInput({ page: "1e2" })).toThrow("页码错误");
    expect(() => parseAdminWriteoffRecordsInput({ limit: 101 })).toThrow("每页数量错误");
  });

  it("projects only UI-required writeoff and bounded cart snapshot fields", () => {
    const result = projectAdminWriteoffRecord({
      id: 9,
      orderCartId: 8,
      productId: 7,
      productType: 0,
      writeoffNum: 2,
      writeoffPrice: "19.90",
      formattedTime: "2026-09-01 12:34",
      cartInfo: JSON.stringify({
        productInfo: {
          store_name: "😀一二三四五六七八九十十一",
          image: "/product.png",
          price: "9.95",
          attrInfo: { image: "/sku.png", secret: "drop" },
          secret: "drop",
        },
        token: "drop",
      }),
    }, true) as Record<string, unknown>;
    expect(result).toMatchObject({
      id: 9,
      order_cart_id: 8,
      product_id: 7,
      writeoff_num: 2,
      add_time: "2026-09-01 12:34",
      cartInfo: {
        productInfo: {
          store_name: "😀一二三四五六七八九",
          image: "/product.png",
          price: "9.95",
          attrInfo: { image: "/sku.png" },
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(JSON.stringify(result)).not.toContain("token");
    expect(projectAdminWriteoffRecord({
      id: 1,
      orderCartId: 1,
      productId: 1,
      productType: 0,
      writeoffNum: 1,
      writeoffPrice: "1.00",
      formattedTime: "",
      cartInfo: "{broken",
    }, true)).toMatchObject({ cartInfo: { productInfo: { store_name: "" } } });
  });

  it("returns private PHP envelopes and derives the actor from verified admin context", async () => {
    const price = vi.spyOn(AdminMobileOrderOperationService.prototype, "changePrice").mockResolvedValue({ changed: true });
    const remark = vi.spyOn(AdminMobileOrderOperationService.prototype, "updateRemark").mockResolvedValue({ changed: true });
    const records = vi.spyOn(AdminMobileOrderOperationService.prototype, "writeoffRecords").mockResolvedValue({
      count: 0,
      list: [],
      time: [],
    });
    const calls = [
      [adminMobileOrderPrice, context({ body: { order_id: "wx1", price: "1.00" }, adminId: 23 })],
      [adminMobileOrderRemark, context({ body: { remark: "note" }, params: { orderId: "wx2" }, adminId: 24 })],
      [adminMobileOrderWriteoffRecords, context({ body: { product_type: 0 }, params: { id: "3" } })],
    ] as const;
    for (const [handler, testContext] of calls) {
      const response = await handler(testContext.value);
      expect((await response.json()) as { status: number }).toMatchObject({ status: 200 });
      expect(testContext.header).toHaveBeenCalledWith("Cache-Control", "private, no-store, max-age=0");
    }
    expect(price).toHaveBeenCalledWith(23, { order_id: "wx1", price: "1.00" });
    expect(remark).toHaveBeenCalledWith(24, { remark: "note", order_id: "wx2" });
    expect(records).toHaveBeenCalledWith("3", { product_type: 0 });
  });

  it("mounts exact routes with least privilege and hardened PostgreSQL operations", () => {
    const routes = readFileSync("src/routes/v1/index.ts", "utf8");
    const service = readFileSync("src/services/admin/AdminMobileOrderOperationService.ts", "utf8");
    expect(routes).toContain('post("/admin/order/price", adminAuth, AdminController.adminMobileOrderPrice)');
    expect(routes).toContain('post("/admin/order/remark", adminAuth, AdminController.adminMobileOrderRemark)');
    expect(routes).toContain('post("/admin/order/wirteoff/records/:id", adminAuth, AdminController.adminMobileOrderWriteoffRecords)');
    expect(requiredAdminPermission("POST", "/api/admin/order/price")).toBe("order.manage");
    expect(requiredAdminPermission("POST", "/api/admin/order/remark")).toBe("order.manage");
    expect(requiredAdminPermission("POST", "/api/admin/order/wirteoff/records/3")).toBe("order.view");
    expect(service).toContain("SET LOCAL lock_timeout = '2s'");
    expect(service).toContain("SET LOCAL statement_timeout = '5s'");
    expect(service).toContain("lockOrderSettlement(tx, rootId)");
    expect(service).toContain('.for("update")');
    expect(service).toContain("eq(storeOrder.isDel, 0)");
    expect(service).toContain("eq(storeOrder.isSystemDel, 0)");
    expect(service).toContain("eq(storeOrderCartInfo.oid, orderId)");
    expect(service).toContain("octet_length");
    expect(service).not.toContain("storeOrderWriteoff.writeoffCode");
    expect(service).not.toContain("input.remark}`");
    expect(service).not.toContain("fetch(");
    expect(service).not.toContain(".send(");
  });
});
