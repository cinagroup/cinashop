import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  adminMobileOrderDeliveryKeep,
  adminMobileOrderExportTemp,
  adminMobileOrderSplitDelivery,
  adminMobileOrderVerificationLookup,
} from "@/controllers/api/v1/AdminController";
import {
  AdminMobileFulfillmentService,
  isAdminElectronicWaybillInput,
  projectAdminWaybillTemplateCatalog,
} from "@/services/admin/AdminMobileFulfillmentService";
import { requiredAdminPermission } from "@/services/admin/AdminPermissionService";
import { StoreOrderWriteoffService } from "@/services/order/StoreOrderWriteoffService";
import { SupplierFulfillmentService } from "@/services/supplier/SupplierFulfillmentService";
import { OrderWaybillJobService } from "@/services/waybill/OrderWaybillJobService";

afterEach(() => vi.restoreAllMocks());

function orderDb(order = { id: 41, supplierId: 7 }) {
  const chain: Record<string, ReturnType<typeof vi.fn>> = {};
  chain.select = vi.fn(() => chain);
  chain.from = vi.fn(() => chain);
  chain.where = vi.fn(() => chain);
  chain.limit = vi.fn(async () => [order]);
  return chain;
}

function deliveryPersonTx(person = { uid: 29, nickname: "平台骑手", phone: "13900000029" }) {
  const chain: Record<string, ReturnType<typeof vi.fn>> = {};
  chain.select = vi.fn(() => chain);
  chain.from = vi.fn(() => chain);
  chain.innerJoin = vi.fn(() => chain);
  chain.where = vi.fn(() => chain);
  chain.orderBy = vi.fn(() => chain);
  chain.limit = vi.fn(() => chain);
  chain.for = vi.fn(async () => [person]);
  return chain;
}

function context(options: {
  method?: "GET" | "POST" | "PUT";
  body?: Record<string, unknown>;
  params?: Record<string, string>;
  query?: Record<string, string>;
  adminId?: number;
} = {}) {
  const method = options.method ?? "POST";
  const header = vi.fn();
  const raw = new Request("https://example.test/api/admin/order/action", {
    method,
    headers: { "content-type": "application/json" },
    body: method === "GET" ? undefined : JSON.stringify(options.body ?? {}),
  });
  return {
    header,
    value: {
      req: {
        raw,
        param: (name: string) => options.params?.[name] ?? "",
        query: () => options.query ?? {},
      },
      env: {},
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

describe("embedded admin mobile fulfillment migration", () => {
  it("strictly separates manual fulfillment from electronic waybill jobs", () => {
    expect(isAdminElectronicWaybillInput({ type: 1, express_record_type: 2 })).toBe(true);
    expect(isAdminElectronicWaybillInput({ type: "1", express_record_type: "1" })).toBe(false);
    expect(isAdminElectronicWaybillInput({ type: 2, express_record_type: 2 })).toBe(false);
    expect(() => isAdminElectronicWaybillInput({ type: 4 })).toThrow("发货类型错误");
    expect(() => isAdminElectronicWaybillInput({ type: 1, express_record_type: "2.0" })).toThrow("发货记录类型错误");
  });

  it("allowlists and bounds the provider template response", () => {
    expect(projectAdminWaybillTemplateCatalog({
      data: [{
        title: "顺丰标准模板",
        temp_id: "SF-1",
        pic: "https://img.example/sf.png",
        access_token: "must-not-leak",
      }],
      credentials: "must-not-leak",
    })).toEqual({
      data: [{ title: "顺丰标准模板", temp_id: "SF-1", pic: "https://img.example/sf.png" }],
    });
    expect(() => projectAdminWaybillTemplateCatalog({ data: [{ title: "模板", temp_id: "1", pic: "data:text/html,bad" }] }))
      .toThrow("电子面单模板服务返回异常");
    expect(() => projectAdminWaybillTemplateCatalog({ data: [{ title: "模板", temp_id: "1", pic: "http://img.example/bad" }] }))
      .toThrow("电子面单模板服务返回异常");
    expect(() => projectAdminWaybillTemplateCatalog({ data: Array.from({ length: 101 }, () => ({})) }))
      .toThrow("电子面单模板服务返回异常");
    expect(() => projectAdminWaybillTemplateCatalog({ data: [{ title: "", temp_id: "1" }] }))
      .toThrow("电子面单模板服务返回异常");
  });

  it("queues electronic waybills durably and maps only legacy input fields", async () => {
    const create = vi.spyOn(OrderWaybillJobService.prototype, "create").mockResolvedValue({
      duplicate: false,
      job: { id: 71, status: "PENDING" },
    } as never);
    const service = new AdminMobileFulfillmentService({} as never, {} as never);
    await expect(service.deliver(23, "41", {
      type: 1,
      express_record_type: 2,
      request_key: crypto.randomUUID(),
      carrier_id: 9,
      express_temp_id: "SF-T1",
      to_name: "仓库",
      to_tel: "13900000000",
      to_addr: "仓库地址",
      access_token: "untrusted",
    })).resolves.toEqual({ queued: true, duplicate: false, job_id: 71, status: "PENDING" });
    expect(create).toHaveBeenCalledTimes(1);
    const [orderId, actor, input] = create.mock.calls[0];
    expect(orderId).toBe("41");
    expect(actor).toEqual({ actorType: "admin", actorId: 23 });
    expect(input).toMatchObject({
      fulfillment_mode: "whole",
      cart_ids: [],
      carrier_id: 9,
      template_id: "SF-T1",
      sender_name: "仓库",
      sender_phone: "13900000000",
      sender_address: "仓库地址",
    });
    expect(input).not.toHaveProperty("access_token");
  });

  it("reuses the locked fulfillment state machine and overwrites delivery-person claims", async () => {
    const tx = deliveryPersonTx();
    const deliver = vi.spyOn(SupplierFulfillmentService.prototype, "deliver")
      .mockImplementation(async (supplierId, orderId, input, options) => {
        await options?.authorize?.(tx as never, {
          requestedOrderId: orderId,
          rootOrderId: orderId,
          customerUid: 5,
          supplierId,
        });
        expect(input).toMatchObject({
          deliveryType: "send",
          deliveryUid: 29,
          deliveryName: "平台骑手",
          deliveryId: "13900000029",
        });
        return { split: false, order_id: orderId, remaining_order_id: null, idempotent: false };
      });
    const service = new AdminMobileFulfillmentService({ db: orderDb() } as never, {} as never);
    await expect(service.deliver(24, "41", {
      type: 2,
      delivery_type: 1,
      sh_delivery_uid: 29,
      delivery_name: "伪造骑手",
      delivery_id: "伪造电话",
    })).resolves.toMatchObject({ queued: false, order_id: 41 });
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver.mock.calls[0][0]).toBe(7);
    expect(deliver.mock.calls[0][1]).toBe(41);
    expect(deliver.mock.calls[0]?.[3]?.audit).toMatchObject({ changeType: "admin_order_delivery" });
    expect(tx.for).toHaveBeenCalledWith("key share");
  });

  it("normalizes split cart quantities before invoking shared split fulfillment", async () => {
    const split = vi.spyOn(SupplierFulfillmentService.prototype, "splitDelivery").mockResolvedValue({
      split: true,
      order_id: 42,
      remaining_order_id: 41,
      idempotent: false,
    });
    const service = new AdminMobileFulfillmentService({ db: orderDb() } as never, {} as never);
    await expect(service.deliver(25, "41", {
      type: 3,
      fictitious_content: "数字商品已交付",
      cart_ids: [{ cart_id: "91", cart_num: "2" }],
    }, true)).resolves.toMatchObject({ queued: false, split: true });
    expect(split).toHaveBeenCalledWith(
      7,
      41,
      expect.objectContaining({ deliveryType: "fictitious" }),
      [{ cartId: "91", cartNum: 2 }],
      expect.objectContaining({ audit: expect.objectContaining({ changeType: "admin_order_split_delivery" }) }),
    );
  });

  it("uses authenticated Admin authority for read-only writeoff lookup and ignores caller auth", async () => {
    const lookup = vi.spyOn(StoreOrderWriteoffService.prototype, "legacySummarySearch").mockResolvedValue({
      data: [{ product_type: 4 }],
      directOrder: true,
    } as never);
    const service = new AdminMobileFulfillmentService({} as never, {} as never);
    await expect(service.writeoffLookup(31, { code: "123456789012", auth: 999 }))
      .resolves.toEqual({ data: [{ product_type: 4 }], is_order_code: 1, product_type: 4, auth: 0 });
    expect(lookup).toHaveBeenCalledWith({ kind: "admin", adminId: 31 }, "123456789012");
  });

  it("returns private PHP envelopes and derives actors from verified admin context", async () => {
    const deliver = vi.spyOn(AdminMobileFulfillmentService.prototype, "deliver")
      .mockResolvedValue({ queued: false, split: false, order_id: 41, remaining_order_id: null, idempotent: false });
    const templates = vi.spyOn(AdminMobileFulfillmentService.prototype, "waybillTemplates")
      .mockResolvedValue({ data: [{ title: "模板", temp_id: "1", pic: "" }] });
    const lookup = vi.spyOn(AdminMobileFulfillmentService.prototype, "writeoffLookup")
      .mockResolvedValue({ data: [], is_order_code: 0, product_type: 0, auth: 0 });
    const cases = [
      [adminMobileOrderDeliveryKeep, context({ body: { type: 3, fictitious_content: "ok" }, params: { id: "41" }, adminId: 33 })],
      [adminMobileOrderSplitDelivery, context({ method: "PUT", body: { type: 3 }, params: { id: "42" }, adminId: 34 })],
      [adminMobileOrderExportTemp, context({ method: "GET", query: { com: "SF" } })],
      [adminMobileOrderVerificationLookup, context({ body: { code: "123456789012", auth: 999 }, adminId: 35 })],
    ] as const;
    for (const [handler, testContext] of cases) {
      const response = await handler(testContext.value);
      expect((await response.json()) as { status: number }).toMatchObject({ status: 200 });
      expect(testContext.header).toHaveBeenCalledWith("Cache-Control", "private, no-store, max-age=0");
    }
    expect(deliver).toHaveBeenNthCalledWith(1, 33, "41", { type: 3, fictitious_content: "ok" });
    expect(deliver).toHaveBeenNthCalledWith(2, 34, "42", { type: 3 }, true);
    expect(templates).toHaveBeenCalledWith({ com: "SF" });
    expect(lookup).toHaveBeenCalledWith(35, { code: "123456789012", auth: 999 });
  });

  it("mounts the exact routes with least privilege and bounded state-machine dependencies", () => {
    const routes = readFileSync("src/routes/v1/index.ts", "utf8");
    const service = readFileSync("src/services/admin/AdminMobileFulfillmentService.ts", "utf8");
    const fulfillment = readFileSync("src/services/supplier/SupplierFulfillmentService.ts", "utf8");
    const writeoff = readFileSync("src/services/order/StoreOrderWriteoffService.ts", "utf8");
    expect(routes).toContain('post("/admin/order/delivery/keep/:id", adminAuth, AdminController.adminMobileOrderDeliveryKeep)');
    expect(routes).toContain('get("/admin/order/export_temp", adminAuth, AdminController.adminMobileOrderExportTemp)');
    expect(routes).toContain('put("/admin/order/split_delivery/:id", adminAuth, AdminController.adminMobileOrderSplitDelivery)');
    expect(routes).toContain('post("/admin/order/order_verific", adminAuth, AdminController.adminMobileOrderVerificationLookup)');
    expect(requiredAdminPermission("POST", "/api/admin/order/delivery/keep/41")).toBe("order.manage");
    expect(requiredAdminPermission("PUT", "/api/admin/order/split_delivery/41")).toBe("order.manage");
    expect(requiredAdminPermission("GET", "/api/admin/order/export_temp")).toBe("order.view");
    expect(requiredAdminPermission("POST", "/api/admin/order/order_verific")).toBe("order.view");
    expect(service).toContain("new SupplierFulfillmentService");
    expect(service).toContain("new OrderWaybillJobService");
    expect(service).toContain("legacySummarySearch({ kind: \"admin\", adminId }");
    expect(service).not.toContain("fetch(");
    expect(service).not.toContain(".send(");
    expect(fulfillment).toContain("SET LOCAL lock_timeout = '2s'");
    expect(fulfillment).toContain("SET LOCAL statement_timeout = '10s'");
    expect(fulfillment).toContain("lockOrderSettlement");
    expect(fulfillment).toContain('.for("update")');
    expect(writeoff).toContain("MAX_ADMIN_LEGACY_SEARCH_RESULTS = 20");
    expect(writeoff).toContain("MAX_ADMIN_SUMMARY_SNAPSHOT_BYTES = 32 * 1024");
    expect(writeoff).toContain("SET LOCAL statement_timeout = '5s'");
    expect(writeoff).toContain("octet_length");
  });
});
