import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  adminMobileOrderDeliveryAgents,
  adminMobileOrderDeliveryGain,
  adminMobileOrderDeliveryInfo,
  adminMobileOrderExpressList,
  adminMobileOrderSplitCartInfo,
} from "@/controllers/api/v1/AdminController";
import {
  AdminMobileOrderReadService,
  parseAdminDeliveryQuery,
  parseAdminOrderNumber,
  parseAdminOrderPrimaryId,
  projectAdminSplitCart,
} from "@/services/admin/AdminMobileOrderReadService";
import { requiredAdminPermission } from "@/services/admin/AdminPermissionService";

afterEach(() => vi.restoreAllMocks());

function context(options: {
  query?: Record<string, string>;
  params?: Record<string, string>;
} = {}) {
  const header = vi.fn();
  return {
    header,
    value: {
      req: {
        query: () => options.query ?? {},
        param: (name: string) => options.params?.[name] ?? "",
      },
      get: (key: string) => key === "container" ? {} : undefined,
      header,
      json: (body: unknown) => Response.json(body),
    } as never,
  };
}

describe("embedded admin mobile order read migration", () => {
  it("strictly validates public order numbers and PostgreSQL ids", () => {
    expect(parseAdminOrderNumber(" wx_20260831-1 ")).toBe("wx_20260831-1");
    expect(parseAdminOrderPrimaryId("2147483647")).toBe(2_147_483_647);
    expect(() => parseAdminOrderNumber("../order")).toThrow("订单号错误");
    expect(() => parseAdminOrderNumber("x".repeat(33))).toThrow("订单号错误");
    expect(() => parseAdminOrderPrimaryId("1e3")).toThrow("订单ID错误");
    expect(() => parseAdminOrderPrimaryId("2147483648")).toThrow("订单ID错误");
    expect(parseAdminDeliveryQuery({})).toEqual({ page: 1, limit: 20 });
    expect(parseAdminDeliveryQuery({ page: "2", limit: "100" })).toEqual({ page: 2, limit: 100 });
    expect(() => parseAdminDeliveryQuery({ page: "10001" })).toThrow("页码错误");
    expect(() => parseAdminDeliveryQuery({ limit: "1e2" })).toThrow("每页数量错误");
  });

  it("projects bounded split-cart fields and tolerates legacy snapshots", () => {
    expect(projectAdminSplitCart({
      id: 8,
      cartId: "cart-8",
      productId: 9,
      skuUnique: "sku-9",
      cartNum: 0,
      refundNum: 1,
      splitSurplusNum: 2,
      cartInfo: JSON.stringify({
        cart_num: 3,
        productInfo: { store_name: "商品九", image: "/nine.png", attrInfo: { suk: "红色" } },
      }),
    } as never)).toMatchObject({
      id: 8,
      cart_id: "cart-8",
      product_id: 9,
      cart_num: 3,
      refund_num: 1,
      surplus_num: 2,
      product_name: "商品九",
      image: "/nine.png",
      sku: "红色",
    });
    expect(projectAdminSplitCart({
      id: 1,
      cartId: "1",
      productId: 1,
      skuUnique: "u1",
      cartNum: 1,
      refundNum: 0,
      splitSurplusNum: 1,
      cartInfo: "{broken",
    } as never).cart_info).toBeNull();
  });

  it("maps paid delivery data and reads the export switch directly", async () => {
    const builder: Record<string, ReturnType<typeof vi.fn>> = {};
    builder.from = vi.fn(() => builder);
    builder.leftJoin = vi.fn(() => builder);
    builder.where = vi.fn(() => builder);
    builder.limit = vi.fn().mockResolvedValue([{
      id: 12,
      order_id: "wx12",
      real_name: "收件人",
      user_phone: "13800000000",
      user_address: "测试地址",
      paid: 1,
      nickname: "会员",
    }]);
    const getValues = vi.fn().mockResolvedValue({ config_export_open: '"1"' });
    const service = new AdminMobileOrderReadService({
      db: { select: vi.fn(() => builder) },
      systemConfigDao: { getValues },
    } as never);
    await expect(service.deliveryGain("wx12")).resolves.toEqual({
      id: 12,
      order_id: "wx12",
      real_name: "收件人",
      user_phone: "13800000000",
      user_address: "测试地址",
      nickname: "会员",
      config_export_open: 1,
    });
    expect(getValues).toHaveBeenCalledWith(["config_export_open"]);
  });

  it("normalizes direct database sender configuration", async () => {
    const getValues = vi.fn().mockResolvedValue({
      config_export_temp_id: '"temp-1"',
      config_export_to_name: '"发件人"',
      config_export_id: "7",
      config_export_to_tel: '"13800000000"',
      config_export_to_address: '"发件地址"',
    });
    const service = new AdminMobileOrderReadService({ systemConfigDao: { getValues } } as never);
    await expect(service.deliveryConfig()).resolves.toEqual({
      express_temp_id: "temp-1",
      to_name: "发件人",
      id: "7",
      to_tel: "13800000000",
      to_add: "发件地址",
    });
  });

  it("returns private PHP envelopes from all five handlers", async () => {
    vi.spyOn(AdminMobileOrderReadService.prototype, "deliveryGain").mockResolvedValue({} as never);
    vi.spyOn(AdminMobileOrderReadService.prototype, "deliveryAgents").mockResolvedValue([]);
    vi.spyOn(AdminMobileOrderReadService.prototype, "deliveryConfig").mockResolvedValue({} as never);
    vi.spyOn(AdminMobileOrderReadService.prototype, "expressList").mockResolvedValue([] as never);
    vi.spyOn(AdminMobileOrderReadService.prototype, "splitCartInfo").mockResolvedValue([]);
    const calls = [
      [adminMobileOrderDeliveryGain, context({ params: { orderId: "wx1" } })],
      [adminMobileOrderDeliveryAgents, context()],
      [adminMobileOrderDeliveryInfo, context()],
      [adminMobileOrderExpressList, context()],
      [adminMobileOrderSplitCartInfo, context({ params: { id: "1" } })],
    ] as const;
    for (const [handler, testContext] of calls) {
      const response = await handler(testContext.value);
      expect((await response.json()) as { status: number }).toMatchObject({ status: 200 });
      expect(testContext.header).toHaveBeenCalledWith("Cache-Control", "private, no-store, max-age=0");
    }
  });

  it("mounts exact routes with order.view and never returns carrier credentials", () => {
    const routes = readFileSync("src/routes/v1/index.ts", "utf8");
    const service = readFileSync("src/services/admin/AdminMobileOrderReadService.ts", "utf8");
    const paths = [
      "delivery/gain/:orderId",
      "delivery",
      "delivery_info",
      "export_all",
      "split_cart_info/:id",
    ];
    for (const path of paths) {
      expect(routes).toContain(`get("/admin/order/${path}", adminAuth, AdminController.`);
      expect(requiredAdminPermission("GET", `/api/admin/order/${path}`)).toBe("order.view");
    }
    expect(service).toContain("eq(storeOrder.isDel, 0)");
    expect(service).toContain("eq(storeOrder.isSystemDel, 0)");
    expect(service).toContain("eq(expressCompany.status, 1)");
    expect(service).not.toContain("expressCompany.partnerKey");
    expect(service).not.toContain("expressCompany.account");
    expect(service).not.toContain("expressCompany.key");
    expect(service).not.toMatch(/\.(?:insert|update|delete)\(/);
  });
});
