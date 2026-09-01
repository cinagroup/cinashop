import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  adminMobileOrderOffline,
  adminMobileOrderOpenRefund,
  adminMobileOrderRefund,
  adminMobileOrderRefundAgree,
} from "@/controllers/api/v1/AdminController";
import {
  AdminMobileRefundOperationService,
  parseAdminRefundCartSelections,
} from "@/services/admin/AdminMobileRefundOperationService";
import { requiredAdminPermission } from "@/services/admin/AdminPermissionService";

afterEach(() => vi.restoreAllMocks());

function context(options: {
  body?: unknown;
  id?: string;
  adminId?: number;
} = {}) {
  const header = vi.fn();
  const raw = new Request("https://shop.example/api/admin/order/test", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(options.body ?? {}),
  });
  const c = {
    req: {
      raw,
      param: (name: string) => name === "id" ? options.id ?? "" : "",
    },
    env: {},
    get: (key: string) => {
      if (key === "container") return {};
      if (key === "adminInfo") return { id: options.adminId ?? 17 };
      return undefined;
    },
    header,
    json: (body: unknown) => Response.json(body),
  } as never;
  return { c, header };
}

async function message(response: Response): Promise<unknown> {
  return (await response.json() as { msg?: unknown }).msg;
}

describe("embedded admin refund/offline write migration", () => {
  it("strictly normalizes split cart quantities", () => {
    expect(parseAdminRefundCartSelections([
      { cart_id: "9", cart_num: "2" },
      { cartId: 3, cartNum: 1 },
    ])).toEqual([
      { cartId: 3, cartNum: 1 },
      { cartId: 9, cartNum: 2 },
    ]);
    expect(() => parseAdminRefundCartSelections([])).toThrow("请选择商品");
    expect(() => parseAdminRefundCartSelections([
      { cart_id: 1, cart_num: 1 },
      { cart_id: 1, cart_num: 1 },
    ])).toThrow("退款商品不能重复选择");
    expect(() => parseAdminRefundCartSelections([{ cart_id: 1, cart_num: 0 }]))
      .toThrow("请重新选择商品，或件数");
  });

  it("derives all privileged actors from the authenticated admin context", async () => {
    const offline = vi.spyOn(AdminMobileRefundOperationService.prototype, "offline")
      .mockResolvedValue({ paid: true, idempotent: false });
    const refund = vi.spyOn(AdminMobileRefundOperationService.prototype, "refund")
      .mockResolvedValue({ completed: true, status: "BALANCE_SUCCESS" });
    const agree = vi.spyOn(AdminMobileRefundOperationService.prototype, "agreeReturn")
      .mockResolvedValue({ changed: true });
    const open = vi.spyOn(AdminMobileRefundOperationService.prototype, "openRefund")
      .mockResolvedValue({
        order_id: "O-1",
        refund_order_id: "A1-test",
        completed: false,
        status: "PROCESSING",
      });

    const offlineContext = context({ body: { order_id: "O-1", uid: 999 } });
    const refundContext = context({ body: { order_id: "R-1", type: 1, price: "8.00" } });
    const agreeContext = context({ id: "42" });
    const openContext = context({ id: "7", body: { refund_price: "8.00", type: 1 } });

    expect(await message(await adminMobileOrderOffline(offlineContext.c))).toBe("修改成功!");
    expect(await message(await adminMobileOrderRefund(refundContext.c))).toBe("审核成功");
    expect(await message(await adminMobileOrderRefundAgree(agreeContext.c))).toBe("操作成功");
    expect(await message(await adminMobileOrderOpenRefund(openContext.c)))
      .toBe("退款已受理，等待渠道确认");

    expect(offline).toHaveBeenCalledWith(17, { order_id: "O-1", uid: 999 });
    expect(refund).toHaveBeenCalledWith(17, { order_id: "R-1", type: 1, price: "8.00" });
    expect(agree).toHaveBeenCalledWith(17, "42");
    expect(open).toHaveBeenCalledWith(17, "7", { refund_price: "8.00", type: 1 });
    for (const item of [offlineContext, refundContext, agreeContext, openContext]) {
      expect(item.header).toHaveBeenCalledWith("Cache-Control", "private, no-store, max-age=0");
    }
  });

  it("mounts exact PHP routes with the intended permission split", () => {
    const routes = readFileSync("src/routes/v1/index.ts", "utf8");
    expect(routes).toContain(
      'v1Routes.post("/admin/order/offline", adminAuth, AdminController.adminMobileOrderOffline)',
    );
    expect(routes).toContain(
      'v1Routes.post("/admin/order/refund", adminAuth, AdminController.adminMobileOrderRefund)',
    );
    expect(routes).toContain(
      'v1Routes.post("/admin/order/refund_agree/:id", adminAuth, AdminController.adminMobileOrderRefundAgree)',
    );
    expect(routes).toContain(
      'v1Routes.post("/admin/order/open/refund/:id", adminAuth, AdminController.adminMobileOrderOpenRefund)',
    );
    expect(requiredAdminPermission("POST", "/api/admin/order/offline")).toBe("order.manage");
    expect(requiredAdminPermission("POST", "/api/admin/order/refund")).toBe("refund.manage");
    expect(requiredAdminPermission("POST", "/api/admin/order/refund_agree/:id"))
      .toBe("refund.manage");
    expect(requiredAdminPermission("POST", "/api/admin/order/open/refund/:id"))
      .toBe("refund.manage");
  });

  it("keeps money, return approval, audit and replay on shared state-machine boundaries", () => {
    const admin = readFileSync("src/services/admin/AdminMobileRefundOperationService.ts", "utf8");
    const refund = readFileSync("src/services/order/StoreOrderRefundService.ts", "utf8");
    const payment = readFileSync("src/services/order/StoreOrderPayService.ts", "utf8");
    expect(admin).toContain("expectedRefundAmountCents: requestedCents");
    expect(admin).toContain("applicationOrderId");
    expect(admin).toContain("approveStoreOrderReturn");
    expect(admin).toContain("StoreOrderRefundService(this.container, this.env).agreeRefund");
    expect(refund).toContain("退款申请幂等参数与首次请求不一致");
    expect(refund).toContain("recordRefundExecutionAuditOnce");
    expect(payment).toContain("authorizeBeforePayment");
    expect(payment).toContain('changeType: params.audit.changeType');
  });

  it("defines a production Hyperdrive audit that is structurally read-only", () => {
    const audit = readFileSync("test/integration/AdminMobileRefundReadOnlyAuditWorker.ts", "utf8");
    const config = readFileSync(
      "test/integration/admin-mobile-refund-read-only-audit.wrangler.jsonc",
      "utf8",
    );
    expect(audit).toContain("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
    expect(audit).toContain("SET LOCAL search_path TO public, pg_temp");
    expect(audit).toContain('transaction_read_only !== "on"');
    expect(audit).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|ALTER|CREATE|DROP)\b/);
    expect(config).toContain('"id": "9748c294e21c49a99579c9cef70102e0"');
  });
});
