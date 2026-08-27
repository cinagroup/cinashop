import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { OrderMessage } from "@/env";
import type { PrintDocument } from "@/models/schema";
import {
  consumeOrderPrintJobMessage,
  isOrderPrintJobMessage,
  type ReceiptPrintJobService,
} from "@/services/printing/ReceiptPrintJobService";
import {
  escapePrinterText,
  renderReceipt,
  sendReceiptToProvider,
} from "@/services/printing/ReceiptPrintProvider";
import { requiredAdminPermission } from "@/services/admin/AdminPermissionService";

function printer(overrides: Partial<PrintDocument> = {}): PrintDocument {
  return {
    id: 7,
    type: 2,
    supplierId: 0,
    printName: "前台",
    ylyUserId: "partner",
    ylyAppId: "app-id",
    ylyAppSecret: "app-secret",
    ylySn: "yly-sn",
    feyUser: "feie-user",
    feyUkey: "feie-secret",
    feySn: "feie-sn",
    times: 1,
    printType: 1,
    printContent: JSON.stringify({
      header: 1,
      delivery: 1,
      buyer_remarks: 1,
      goods: [0, 1],
      freight: 1,
      preferential: 1,
      pay: [0, 1],
      custom: 0,
      order: [0, 1, 2, 3],
      code: 1,
      code_url: "/order/7",
      show_notice: 1,
      notice_content: "请核对商品",
    }),
    addTime: 1,
    status: 1,
    isDel: 0,
    ...overrides,
  };
}

function renderInput(overrides: Record<string, unknown> = {}) {
  return {
    order: {
      id: 9,
      orderId: "ORDER-9",
      shippingType: 1,
      realName: "张<CB>三",
      userPhone: "13800000000",
      userAddress: "测试路<QR>evil</QR>",
      mark: "不要辣<BR>",
      totalPrice: "20.00",
      payPostage: "2.00",
      deductionPrice: "1.00",
      payPrice: "19.00",
      payType: "weixin",
      addTime: 1_700_000_000,
      payTime: 1_700_000_100,
    },
    carts: [{
      id: 1,
      cartNum: 2,
      cartInfo: JSON.stringify({
        product: { storeName: "商品<CB>注入" },
        sku: { suk: "红色<BR>", code: "SKU<QR>", price: "10.00" },
      }),
    }],
    printer: printer(),
    trigger: "paid" as const,
    siteName: "商城<CB>注入",
    siteUrl: "https://shop.example",
    printedAt: 1_700_000_200,
    ...overrides,
  };
}

function queueMessage() {
  return {
    action: "processOrderPrintJob" as const,
    printJobId: 17,
    eventKey: "order.print.paid:9:7",
  };
}

describe("小票打印持久 outbox", () => {
  it("外部和 Worker 内嵌迁移完全一致，且审计表不复制订单隐私或凭据", () => {
    const migration = readFileSync("migrations/0090_print_job_outbox.sql", "utf8").trim();
    const service = readFileSync("src/services/MigrationService.ts", "utf8");
    const embedded = service.match(
      /private migration_0097\(\): string \{\s*return `([\s\S]*?)`;\s*\}/,
    )?.[1]?.trim();
    expect(embedded).toBe(migration);
    expect(migration).toContain('"opj_event_key_uq"');
    expect(migration).toContain('"opj_expired_provider_lease"');
    expect(migration).toContain("'UNKNOWN'");
    const actionTable = migration.slice(migration.indexOf('CREATE TABLE IF NOT EXISTS "order_print_job_action"'));
    expect(actionTable).not.toMatch(/user_phone|user_address|content_hash|app_secret|fey_ukey/);
  });

  it("Queue 消息只携带账本引用，并在忙碌与终态间正确选择 retry/ack", async () => {
    expect(isOrderPrintJobMessage(queueMessage())).toBe(true);
    expect(isOrderPrintJobMessage({ ...queueMessage(), printJobId: 0 })).toBe(false);
    expect(isOrderPrintJobMessage({ ...queueMessage(), eventKey: "order.print.other:9:7" })).toBe(false);
    expect(queueMessage()).not.toHaveProperty("content");
    expect(queueMessage()).not.toHaveProperty("credentials");

    const ack = vi.fn();
    const retry = vi.fn();
    const busy = { processMessage: vi.fn().mockResolvedValue("busy") } as unknown as ReceiptPrintJobService;
    await consumeOrderPrintJobMessage({ body: queueMessage() as OrderMessage, attempts: 2, ack, retry }, busy);
    expect(retry).toHaveBeenCalledWith({ delaySeconds: 60 });
    expect(ack).not.toHaveBeenCalled();

    const terminal = { processMessage: vi.fn().mockResolvedValue("unknown") } as unknown as ReceiptPrintJobService;
    await consumeOrderPrintJobMessage({ body: queueMessage() as OrderMessage, attempts: 3, ack, retry }, terminal);
    expect(ack).toHaveBeenCalledTimes(1);
  });

  it("下单和支付都只在事务里写入幂等任务，调度器负责 Queue", () => {
    const create = readFileSync("src/services/order/StoreOrderCreateService.ts", "utf8");
    const paid = readFileSync("src/services/order/OrderOutboxService.ts", "utf8");
    const scheduled = readFileSync("src/services/order/ScheduledMaintenanceService.ts", "utf8");
    expect(create).toContain('enqueueAutomaticReceiptPrintJobs(tx, [order], "created", now)');
    expect(paid).toContain('enqueueAutomaticReceiptPrintJobs(tx, allocation.fulfillmentOrders, "paid", now)');
    expect(scheduled).toContain('"print_job_dispatch"');
    expect(create).not.toMatch(/sendReceiptToProvider|open-api\.10ss|api\.feieyun/);
    expect(paid).not.toMatch(/sendReceiptToProvider|open-api\.10ss|api\.feieyun/);
  });

  it("转义所有订单快照字段，无法注入提供商控制标记", () => {
    expect(escapePrinterText("a<QR>x</QR>&b")).toBe("a＜QR＞x＜/QR＞＆b");
    const content = renderReceipt(renderInput());
    expect(content).toContain("张＜CB＞三");
    expect(content).toContain("商品＜CB＞注入");
    expect(content).toContain("红色＜BR＞");
    expect(content).not.toContain("<CB>注入");
    expect(content).not.toContain("<QR>evil");
    expect(content).toContain("<QR>https://shop.example/order/7</QR>");
  });

  it("飞鹅云只使用官方 HTTPS printMsg 端点且密钥不进入请求体", async () => {
    const fetchMock = vi.fn(async (_input: URL | RequestInfo, _init?: RequestInit) =>
      Response.json({ ret: 0, msg: "ok", data: "feie-order" }));
    await expect(sendReceiptToProvider(
      printer(), renderReceipt(renderInput()), "order.print.paid:9:7", fetchMock as unknown as typeof fetch,
    )).resolves.toMatchObject({ providerReference: "feie-order", responseCode: "OK" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://api.feieyun.cn/Api/Open/printMsg");
    const body = String(fetchMock.mock.calls[0]?.[1]?.body);
    expect(body).toContain("apiname=Open_printMsg");
    expect(body).not.toContain("feie-secret");
  });

  it("易联云 token 和打印调用使用稳定 origin_id，密钥不进入请求体", async () => {
    const calls: Array<{ url: string; body: string }> = [];
    const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      calls.push({ url: String(input), body: String(init?.body) });
      if (String(input).endsWith("/oauth/oauth")) {
        return Response.json({ error: 0, error_description: "success", body: { access_token: "token" } });
      }
      return Response.json({ error: 0, body: { id: "print-order" } });
    });
    const yilian = printer({ type: 1 });
    await expect(sendReceiptToProvider(
      yilian, renderReceipt(renderInput({ printer: yilian })), "order.print.paid:9:7",
      fetchMock as unknown as typeof fetch,
    )).resolves.toMatchObject({ providerReference: "print-order", responseCode: "OK" });
    expect(calls.map((call) => call.url)).toEqual([
      "https://open-api.10ss.net/oauth/oauth",
      "https://open-api.10ss.net/print/index",
    ]);
    expect(calls.every((call) => !call.body.includes("app-secret"))).toBe(true);
    const printBody = new URLSearchParams(calls[1].body);
    expect(printBody.get("origin_id")).toMatch(/^cina[0-9a-f]{28}$/);
    expect(printBody.get("content")).toBeTruthy();
  });

  it("管理员与供应商管理路由有明确读写边界", () => {
    const adminRoutes = readFileSync("src/routes/adminapi.ts", "utf8");
    const supplierRoutes = readFileSync("src/routes/supplierapi.ts", "utf8");
    expect(adminRoutes).toContain('post("/order/print/:id"');
    expect(adminRoutes).toContain('get("/print/jobs"');
    expect(supplierRoutes).toContain('post("/order/print/:id"');
    expect(supplierRoutes).toContain('post("/print/jobs/:id/confirm-retry"');
    expect(requiredAdminPermission("GET", "/adminapi/print/jobs")).toBe("print.view");
    expect(requiredAdminPermission("POST", "/adminapi/print/jobs/:id/confirm-retry")).toBe("print.manage");
    expect(requiredAdminPermission("POST", "/adminapi/order/print/:id")).toBe("order.manage");
  });
});
