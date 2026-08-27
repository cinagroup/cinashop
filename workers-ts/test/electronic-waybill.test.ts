import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { OrderMessage } from "@/env";
import {
  issueCrmebOnePassWaybill,
  WaybillConfigurationError,
  WaybillPreflightError,
  WaybillRejectedError,
  type WaybillIssueInput,
} from "@/services/waybill/CrmebOnePassWaybillProvider";
import {
  consumeOrderWaybillJobMessage,
  isOrderWaybillJobMessage,
  type OrderWaybillJobService,
} from "@/services/waybill/OrderWaybillJobService";

function issueInput(overrides: Partial<WaybillIssueInput> = {}): WaybillIssueInput {
  return {
    carrierCode: "SF",
    recipientName: "收件人",
    recipientPhone: "13800000000",
    recipientAddress: "收件地址",
    senderName: "发件人",
    senderPhone: "13900000000",
    senderAddress: "发件地址",
    templateId: "SF-TEMPLATE",
    cloudPrinterId: "PRINTER1234",
    count: 2,
    cargo: "测试商品",
    weight: "1.50",
    orderNo: "ORDER-17",
    carrier: {
      partnerId: true,
      partnerKey: true,
      net: true,
      checkMan: true,
      partnerName: true,
      isCode: true,
      account: "monthly-account",
      key: "monthly-secret",
      netName: "网点",
      courierName: "揽件员",
      customerName: "客户",
      codeName: "业务编码",
    },
    ...overrides,
  };
}

function queueMessage() {
  return {
    action: "processOrderWaybillJob" as const,
    waybillJobId: 17,
    eventKey: "order.waybill:123e4567-e89b-42d3-a456-426614174000",
  };
}

describe("电子面单持久签发账本", () => {
  it("文件迁移与 Worker 内嵌迁移一致，UNKNOWN/DEAD 未处置前阻止第二次签发", () => {
    const migration = readFileSync("migrations/0091_electronic_waybill_outbox.sql", "utf8").trim();
    const service = readFileSync("src/services/MigrationService.ts", "utf8");
    const embedded = service.match(
      /private migration_0098\(\): string \{\s*return `([\s\S]*?)`;\s*\}/,
    )?.[1]?.trim();
    expect(embedded).toBe(migration);
    expect(migration).toContain('"owj_active_root_uq"');
    expect(migration).toContain("'UNKNOWN', 'DEAD'");
    expect(migration).toContain('"owj_expired_provider_lease"');
    const actions = migration.slice(migration.indexOf('CREATE TABLE IF NOT EXISTS "order_waybill_job_action"'));
    expect(actions).not.toMatch(/sender_|recipient_|carrier_config|secret_key|user_phone|user_address/);
  });

  it("Queue 只携带任务引用，忙碌时 retry、终态时 ack", async () => {
    expect(isOrderWaybillJobMessage(queueMessage())).toBe(true);
    expect(isOrderWaybillJobMessage({ ...queueMessage(), waybillJobId: 0 })).toBe(false);
    expect(isOrderWaybillJobMessage({ ...queueMessage(), eventKey: "order.waybill:bad" })).toBe(false);
    expect(queueMessage()).not.toHaveProperty("recipientPhone");
    expect(queueMessage()).not.toHaveProperty("credentials");

    const ack = vi.fn();
    const retry = vi.fn();
    const busy = { processMessage: vi.fn().mockResolvedValue("busy") } as unknown as OrderWaybillJobService;
    await consumeOrderWaybillJobMessage({ body: queueMessage() as OrderMessage, attempts: 2, ack, retry }, busy);
    expect(retry).toHaveBeenCalledWith({ delaySeconds: 60 });
    expect(ack).not.toHaveBeenCalled();

    const terminal = { processMessage: vi.fn().mockResolvedValue("unknown") } as unknown as OrderWaybillJobService;
    await consumeOrderWaybillJobMessage({ body: queueMessage() as OrderMessage, attempts: 3, ack, retry }, terminal);
    expect(ack).toHaveBeenCalledTimes(1);
  });

  it("一号通认证和签发都只使用 HTTPS，并保留 PHP 的实际字段方向", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      if (String(input).endsWith("/v2/user/login")) {
        return Response.json({ status: 200, data: { access_token: "token-17" } });
      }
      return Response.json({
        status: 200,
        data: { kuaidinum: "SF100017", label: "https://labels.example/17.png", task_id: "task-17" },
      });
    });
    await expect(issueCrmebOnePassWaybill(
      { accessKey: "access-17", secretKey: "secret-17" },
      issueInput(),
      fetchMock as unknown as typeof fetch,
    )).resolves.toEqual({
      trackingNumber: "SF100017",
      labelUrl: "https://labels.example/17.png",
      providerReference: "task-17",
      responseCode: "200",
    });
    expect(calls.map((call) => call.url)).toEqual([
      "https://sms.crmeb.net/api/v2/user/login",
      "https://sms.crmeb.net/api/v2/expr/dump",
    ]);
    const issue = calls[1];
    expect(new Headers(issue.init?.headers).get("Authorization")).toBe("Bearer-token-17");
    const form = issue.init?.body as FormData;
    expect(form.get("to_name")).toBe("收件人");
    expect(form.get("from_name")).toBe("发件人");
    expect(form.get("partner_id")).toBe("monthly-account");
    expect(form.get("partner_key")).toBe("monthly-secret");
    expect(form.get("order_id")).toBe("ORDER-17");
    expect(form.get("access_key")).toBeNull();
    expect(form.get("secret_key")).toBeNull();
  });

  it("无云打印机时请求 IMAGE，并发送 v1.1 协议头", async () => {
    const calls: RequestInit[] = [];
    const fetchMock = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      calls.push(init ?? {});
      if (String(input).endsWith("/v2/user/login")) {
        return Response.json({ status: 200, data: { access_token: "token-image" } });
      }
      return Response.json({ status: 200, data: { kuaidinum: "IMG-1", label: "https://labels.example/1" } });
    });
    await issueCrmebOnePassWaybill(
      { accessKey: "access-image", secretKey: "secret-image" },
      issueInput({ cloudPrinterId: "" }),
      fetchMock as unknown as typeof fetch,
    );
    const issue = calls[1];
    expect(new Headers(issue.headers).get("version")).toBe("v1.1");
    expect((issue.body as FormData).get("print_type")).toBe("IMAGE");
  });

  it("签发前认证失败可安全重试，明确拒绝与缺少 Secret 可区分", async () => {
    const loginFailure = vi.fn(async () => Response.json({ status: 403, msg: "账号无效" }));
    await expect(issueCrmebOnePassWaybill(
      { accessKey: "access-fail", secretKey: "secret-fail" },
      issueInput(),
      loginFailure as unknown as typeof fetch,
    )).rejects.toBeInstanceOf(WaybillPreflightError);

    const rejected = vi.fn(async (input: URL | RequestInfo) =>
      String(input).endsWith("/v2/user/login")
        ? Response.json({ status: 200, data: { access_token: "token-reject" } })
        : Response.json({ status: 422, msg: "模板不匹配" }));
    await expect(issueCrmebOnePassWaybill(
      { accessKey: "access-reject", secretKey: "secret-reject" },
      issueInput(),
      rejected as unknown as typeof fetch,
    )).rejects.toBeInstanceOf(WaybillRejectedError);

    await expect(issueCrmebOnePassWaybill({}, issueInput(), vi.fn() as unknown as typeof fetch))
      .rejects.toBeInstanceOf(WaybillConfigurationError);
  });

  it("HTTP 发货接口只建账本，实际 provider 调用只存在于 Queue service", () => {
    const controller = readFileSync("src/controllers/system/WaybillJobController.ts", "utf8");
    const provider = readFileSync("src/services/waybill/CrmebOnePassWaybillProvider.ts", "utf8");
    const routes = `${readFileSync("src/routes/adminapi.ts", "utf8")}\n${readFileSync("src/routes/supplierapi.ts", "utf8")}`;
    expect(controller).not.toContain("issueCrmebOnePassWaybill");
    expect(provider).toContain('const API_ROOT = "https://sms.crmeb.net/api/"');
    expect(provider).not.toContain('http://sms.crmeb.net');
    expect(routes).toContain('post("/order/waybill/:id"');
    expect(routes).toContain('post("/waybill/jobs/:id/apply-existing"');
    expect(routes).toContain('post("/waybill/jobs/:id/confirm-retry"');
  });
});
