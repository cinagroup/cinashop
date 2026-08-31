import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  adminRefundOrderDetail,
  adminRefundOrderList,
  adminRefundOrderRemark,
} from "@/controllers/api/v1/AdminCrudController";
import {
  AdminMobileRefundService,
  parseAdminRefundListQuery,
  parseAdminRefundRemark,
  parseAdminRefundSelector,
  refundTypesForFilter,
} from "@/services/admin/AdminMobileRefundService";
import { requiredAdminPermission } from "@/services/admin/AdminPermissionService";

afterEach(() => vi.restoreAllMocks());

function responseContext(options: {
  query?: Record<string, string>;
  param?: string;
  body?: unknown;
  adminId?: number;
} = {}) {
  const header = vi.fn();
  const context = {
    req: {
      query: () => options.query ?? {},
      param: () => options.param ?? "",
      json: vi.fn().mockResolvedValue(options.body),
    },
    get: (key: string) => {
      if (key === "container") return {};
      if (key === "adminId") return options.adminId;
      return undefined;
    },
    header,
    json: (body: unknown) => Response.json(body),
  } as never;
  return { context, header };
}

describe("embedded admin mobile refund migration", () => {
  it("parses and bounds the PHP list filters", () => {
    const parsed = parseAdminRefundListQuery({
      page: "2",
      limit: "10",
      order_id: " refund-1 ",
      refundTypes: "5",
      apply_type: "2",
      time: "2026-08-01 - 2026-08-31",
    });
    expect(parsed).toEqual({
      page: 2,
      limit: 10,
      keyword: "refund-1",
      refundTypes: 5,
      applyType: 2,
      startTime: Math.floor(Date.parse("2026-08-01T00:00:00+08:00") / 1000),
      endTime: Math.floor(Date.parse("2026-08-31T23:59:59+08:00") / 1000),
    });
    expect(() => parseAdminRefundListQuery({ limit: "101" })).toThrow("每页数量错误");
    expect(() => parseAdminRefundListQuery({ refundTypes: "7" })).toThrow("售后状态错误");
    expect(() => parseAdminRefundListQuery({ apply_type: "5" })).toThrow("售后类型错误");
  });

  it("preserves the PHP grouped refundTypes semantics", () => {
    expect(refundTypesForFilter(null)).toBeNull();
    expect(refundTypesForFilter(0)).toEqual([0]);
    expect(refundTypesForFilter(1)).toEqual([1, 2]);
    expect(refundTypesForFilter(2)).toEqual([4, 5]);
    expect(refundTypesForFilter(3)).toEqual([5]);
    expect(refundTypesForFilter(4)).toEqual([6]);
    expect(refundTypesForFilter(5)).toEqual([0, 1, 2, 4, 5]);
    expect(refundTypesForFilter(6)).toEqual([3, 6]);
  });

  it("accepts a refund primary key or public refund number without coercing text", () => {
    expect(parseAdminRefundSelector(" 42 ")).toEqual({ value: "42", id: 42 });
    expect(parseAdminRefundSelector("refund-20260831")).toEqual({ value: "refund-20260831" });
    expect(() => parseAdminRefundSelector(" ")).toThrow("参数错误");
    expect(() => parseAdminRefundSelector("x".repeat(51))).toThrow("退款单号不能超过50个字符");
  });

  it("requires a bounded non-empty remark", () => {
    expect(parseAdminRefundRemark("  已核对凭证  ")).toBe("已核对凭证");
    expect(() => parseAdminRefundRemark(" ")).toThrow("请输入要备注的内容");
    expect(() => parseAdminRefundRemark("x".repeat(256))).toThrow("备注不能超过255个字符");
  });

  it("returns private PHP envelopes for list and detail", async () => {
    vi.spyOn(AdminMobileRefundService.prototype, "list").mockResolvedValue([{ id: 1 }] as never);
    vi.spyOn(AdminMobileRefundService.prototype, "detail").mockResolvedValue({ id: 1 } as never);
    const list = responseContext({ query: { page: "1" } });
    const detail = responseContext({ param: "refund-1" });

    expect(await (await adminRefundOrderList(list.context)).json()).toEqual({
      status: 200,
      msg: "ok",
      data: [{ id: 1 }],
    });
    expect(await (await adminRefundOrderDetail(detail.context)).json()).toEqual({
      status: 200,
      msg: "ok",
      data: { id: 1 },
    });
    expect(list.header).toHaveBeenCalledWith("Cache-Control", "private, no-store, max-age=0");
    expect(detail.header).toHaveBeenCalledWith("Cache-Control", "private, no-store, max-age=0");
  });

  it("derives the remark actor only from verified admin context", async () => {
    const update = vi.spyOn(AdminMobileRefundService.prototype, "updateRemark")
      .mockResolvedValue({ changed: true });
    const { context, header } = responseContext({
      adminId: 17,
      body: { order_id: "refund-1", remark: "已核对" },
    });

    expect(await (await adminRefundOrderRemark(context)).json()).toEqual({
      status: 200,
      msg: "备注成功",
      data: { changed: true },
    });
    expect(update).toHaveBeenCalledWith(17, { order_id: "refund-1", remark: "已核对" });
    expect(header).toHaveBeenCalledWith("Cache-Control", "private, no-store, max-age=0");
  });

  it("mounts all exact PHP routes behind view/manage ACL and transactional audit", () => {
    const routes = readFileSync("src/routes/v1/index.ts", "utf8");
    const service = readFileSync("src/services/admin/AdminMobileRefundService.ts", "utf8");
    expect(routes).toContain(
      'v1Routes.get("/admin/refund_order/list", adminAuth, AdminCrud.adminRefundOrderList)',
    );
    expect(routes).toContain(
      'v1Routes.get("/admin/refund_order/detail/:uni", adminAuth, AdminCrud.adminRefundOrderDetail)',
    );
    expect(routes).toContain(
      'v1Routes.post("/admin/refund_order/remark", adminAuth, AdminCrud.adminRefundOrderRemark)',
    );
    expect(requiredAdminPermission("GET", "/api/admin/refund_order/list")).toBe("refund.view");
    expect(requiredAdminPermission("GET", "/api/admin/refund_order/detail/:uni")).toBe("refund.view");
    expect(requiredAdminPermission("POST", "/api/admin/refund_order/remark")).toBe("refund.manage");
    expect(service).toContain('eq(storeOrderRefund.isCancel, 0)');
    expect(service).toContain('eq(storeOrderRefund.isDel, 0)');
    expect(service).toContain('.for("update").limit(1)');
    expect(service).toContain('changeType: "admin_refund_remark"');
    expect(service).toContain('changeMessage: `管理员 ${adminId} 更新售后备注`');
  });
});
