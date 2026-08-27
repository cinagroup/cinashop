import { readFileSync } from "node:fs";
import { getTableColumns, getTableName } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { outAccount, outApiAudit, outInterface } from "@/models/schema";
import { requiredAdminPermission } from "@/services/admin/AdminPermissionService";
import {
  normalizeOutInvoiceInput,
  normalizeOutInvoiceStatusInput,
  normalizeOutRefundPriceAction,
  normalizeOutRoute,
  parseOutRules,
} from "@/services/out/OutApiService";
import { advanceRateWindows } from "@/services/out/OutRateLimitPolicy";
import { MIGRATION_MANIFEST_VERSION, MIGRATION_TABLES } from "../scripts/data-migration/manifest";

describe("third-party API migration boundary", () => {
  it("preserves both PHP tables and every source-shaped column", () => {
    expect(getTableName(outAccount)).toBe("out_account");
    expect(getTableName(outInterface)).toBe("out_interface");
    expect(Object.keys(getTableColumns(outAccount))).toEqual([
      "id", "appid", "appsecret", "apppwd", "title", "status", "rules", "addTime",
      "lastTime", "ip", "isDel", "pushOpen", "pushAccount", "pushPassword",
      "pushTokenUrl", "userUpdatePush", "orderCreatePush", "orderPayPush",
      "refundCreatePush", "refundCancelPush",
    ]);
    expect(Object.keys(getTableColumns(outInterface))).toEqual([
      "id", "pid", "type", "name", "describe", "method", "url", "requestParams",
      "returnParams", "requestExample", "returnExample", "errorCode", "isDel",
    ]);
    expect(getTableConfig(outAccount).uniqueConstraints).toHaveLength(0);
    expect(getTableConfig(outInterface).uniqueConstraints).toHaveLength(0);
  });

  it("adds deterministic id cursors and advances the manifest", () => {
    expect(MIGRATION_TABLES.find((entry) => entry.table === "out_account")?.key).toEqual(["id"]);
    expect(MIGRATION_TABLES.find((entry) => entry.table === "out_interface")?.key).toEqual(["id"]);
    expect(MIGRATION_MANIFEST_VERSION).toBe("2026-08-11.57");
  });

  it("keeps external 0075 and embedded 0082 SQL exactly equivalent", () => {
    const migration = readFileSync("migrations/0075_external_api.sql", "utf8").trim();
    const service = readFileSync("src/services/MigrationService.ts", "utf8");
    const embedded = service.match(
      /private migration_0082\(\): string \{\s*return `([\s\S]*?)`;\s*\}/,
    )?.[1]?.trim();
    expect(embedded).toBe(migration);
    expect(migration).toContain('"apppwd" VARCHAR(100)');
    expect(migration).toContain('"push_password" VARCHAR(255)');
    expect(migration).not.toMatch(/FOREIGN KEY\s*\(|REFERENCES\s+"|CREATE UNIQUE INDEX/i);
    expect(migration).not.toMatch(/\bINSERT\s+INTO\b/i);
  });

  it("keeps the privacy audit migration and model append-only and free of raw request data", () => {
    const migration = readFileSync("migrations/0083_out_api_audit.sql", "utf8").trim();
    const service = readFileSync("src/services/MigrationService.ts", "utf8");
    const embedded = service.match(
      /private migration_0090\(\): string \{\s*return `([\s\S]*?)`;\s*\}/,
    )?.[1]?.trim();
    expect(embedded).toBe(migration);
    expect(getTableName(outApiAudit)).toBe("out_api_audit");
    expect(Object.keys(getTableColumns(outApiAudit))).toEqual([
      "id", "outAccountId", "appidSnapshot", "method", "routeTemplate", "operation",
      "resourceHash", "queryFields", "ipHash", "userAgentHash", "outcome", "resultCode",
      "durationMs", "addTime",
    ]);
    expect(migration).toContain("out_audit_hashes_ck");
    expect(migration).not.toMatch(/FOREIGN KEY|REFERENCES|\bINSERT\s+INTO\b/i);
    expect(migration).not.toMatch(/"(?:path|resource_id|query_values|ip|user_agent|request_body|response_body)"/i);
  });

  it("normalizes legacy route templates and rejects malformed ACL values", () => {
    expect(normalizeOutRoute(" GET ", "outapi/product/<id> ")).toBe("get /product/{id}");
    expect(normalizeOutRoute("get", "/product/{id}")).toBe("get /product/{id}");
    expect(normalizeOutRoute("get", "/order/:order_id")).toBe("get /order/{order_id}");
    expect(parseOutRules('[3,"4",4,0,-1,"x"]')).toEqual([3, 4]);
    expect(parseOutRules("3,4,4")).toEqual([3, 4]);
    expect(parseOutRules({ rules: [3] })).toEqual([]);
  });

  it("registers 14 bounded reads and exactly eleven audited write routes behind ACL", () => {
    const app = readFileSync("src/app.ts", "utf8");
    const routes = readFileSync("src/routes/outapi.ts", "utf8");
    const middleware = readFileSync("src/middleware/out-auth.ts", "utf8");
    expect(app).toContain('app.route("/outapi", outapiRoutes)');
    expect(routes).toContain('outapiRoutes.post("/get_token"');
    expect(routes).toContain('outapiRoutes.post("/refresh_token"');
    for (const path of [
      "/category/list", "/category/:id", "/product/list", "/product/:id",
      "/order/list", "/order/express_list", "/order/split_cart_info/:order_id",
      "/order/:order_id", "/refund/list", "/refund/:order_id", "/coupon/list",
      "/user_level/list", "/user/list", "/user/info/:uid",
    ]) {
      expect(routes).toContain(path);
    }
    expect(routes.indexOf('"/order/express_list"')).toBeLessThan(routes.indexOf('"/order/:order_id"'));
    expect(routes.indexOf('"/refund/list"')).toBeLessThan(routes.indexOf('"/refund/:order_id"'));
    expect(routes).toContain('outapiRoutes.put(\n  "/order/delivery/:order_id"');
    expect(routes).toContain('outapiRoutes.put(\n  "/order/distribution/:order_id"');
    expect(routes).toContain('outapiRoutes.put(\n  "/order/invoice/:order_id"');
    expect(routes).toContain('outapiRoutes.put(\n  "/order/invoice_status/:order_id"');
    expect(routes).toContain('outapiRoutes.put(\n  "/order/remark/:order_id"');
    expect(routes).toContain('outapiRoutes.put(\n  "/order/receive/:order_id"');
    expect(routes).toContain('outapiRoutes.put(\n  "/order/split_delivery/:order_id"');
    expect(routes).toContain('outapiRoutes.put(\n  "/refund/agree/:order_id"');
    expect(routes).toContain('outapiRoutes.put(\n  "/refund/remark/:order_id"');
    expect(routes).toContain('outapiRoutes.put(\n  "/refund/refuse/:order_id"');
    expect(routes).toContain('outapiRoutes.put(\n  "/refund/:order_id"');
    expect(routes.match(/outapiRoutes\.put\(/g)).toHaveLength(11);
    expect(routes).not.toMatch(/outapiRoutes\.(?:post|delete)\("\/(?:category|product|order|refund|user|coupon)/i);
    expect(routes).toContain("}, 501));");
    expect(middleware).toContain("assertInterfacePermission");
  });

  it("preserves the legacy invoice validation contract within PostgreSQL column bounds", () => {
    expect(normalizeOutInvoiceInput({
      header_type: 1,
      type: 1,
      drawer_phone: "13800000000",
      name: "张三",
    })).toMatchObject({
      headerType: 1,
      type: 1,
      drawerPhone: "13800000000",
      name: "张三",
      dutyNumber: "",
    });
    expect(normalizeOutInvoiceInput({
      header_type: 9,
      type: 2,
      drawer_phone: "13800000000",
      name: "CINA（SHOP）&2026",
      duty_number: "91350100M000100Y43",
      card_number: "123456789012",
    })).toMatchObject({ headerType: 2, type: 2, dutyNumber: "91350100M000100Y43" });
    expect(() => normalizeOutInvoiceInput({ drawer_phone: "12800000000", name: "张三" }))
      .toThrow("手机号格式不正确");
    expect(() => normalizeOutInvoiceInput({ drawer_phone: "13800000000", name: "CINA" }))
      .toThrow("请填写发票抬头");
    expect(() => normalizeOutInvoiceInput({
      header_type: 2,
      drawer_phone: "13800000000",
      name: "CINA SHOP",
      duty_number: "91350100M000100Y43",
    })).toThrow("请填写发票抬头");
    expect(() => normalizeOutInvoiceInput({
      header_type: 2,
      drawer_phone: "13800000000",
      name: "CINA",
    })).toThrow("请填写发票税号");
    expect(() => normalizeOutInvoiceInput({
      header_type: 2,
      drawer_phone: "13800000000",
      name: "CINA",
      duty_number: "lowercase-tax-id",
    })).toThrow("请填写正确的发票税号");
  });

  it("validates invoice processing state and number without retaining raw evidence", () => {
    expect(normalizeOutInvoiceStatusInput({
      is_invoice: "1",
      invoice_number: "00001234",
      remark: "已开具",
    })).toEqual({ isInvoice: 1, invoiceNumber: "00001234", remark: "已开具" });
    expect(normalizeOutInvoiceStatusInput({ is_invoice: -1 })).toEqual({
      isInvoice: -1,
      invoiceNumber: "",
      remark: "",
    });
    expect(() => normalizeOutInvoiceStatusInput({ is_invoice: 1 }))
      .toThrow("请填写开票号");
    expect(() => normalizeOutInvoiceStatusInput({ is_invoice: 2, invoice_number: "12345678" }))
      .toThrow("开票状态参数错误");
    expect(() => normalizeOutInvoiceStatusInput({ is_invoice: 0, invoice_number: "1234" }))
      .toThrow("请填写正确的开票号");

    const source = readFileSync("src/services/out/OutApiService.ts", "utf8");
    for (const methodName of ["updateOrderInvoice", "updateOrderInvoiceStatus"]) {
      const method = source.match(new RegExp(`async ${methodName}\\([^]*?\\n  \\}`))?.[0] ?? "";
      expect(method).toContain("lockPlatformInvoiceOrder");
      expect(method).toContain("lockSingleOrderInvoice");
      expect(method).toContain("findInvoiceReplay");
      expect(method).toContain("recordInvoiceReplay");
      expect(method).toContain("withTx(this.container");
      expect(method).not.toMatch(/changeMessage:\s*(?:input\.|invoiceNumber|remark)/);
    }
    expect(source).toContain("lockOrderSettlement(tx");
    expect(source).toContain('"out_order_invoice"');
    expect(source).toContain('"out_order_invoice_status"');
  });

  it("serializes non-monetary refund decisions and blocks active provider refunds", () => {
    const source = readFileSync("src/services/out/OutApiService.ts", "utf8");
    const methods = [
      source.match(/async agreeRefundReturn\([^]*?\n  \}/)?.[0] ?? "",
      source.match(/private async refuseRefundDecision\([^]*?\n  \}/)?.[0] ?? "",
    ];
    for (const method of methods) {
      expect(method).toContain("withTx(this.container");
      expect(method).toContain("lockPlatformRefundDecision");
      expect(method).toContain("findRefundDecisionReplay");
      expect(method).toContain("recordRefundDecisionReplay");
      expect(method).toContain("assertRefundProviderDecisionAvailable");
      expect(method).not.toMatch(/changeMessage:\s*`[^`]*\$\{(?:reason|refund\.refuseReason)/);
    }
    expect(source).toContain("lockRefundExecution(tx, reference.refundId)");
    expect(source).toContain("lockOrderSettlement(tx, reference.orderPid");
    expect(source).toContain('"out_refund_agree"');
    expect(source).toContain('"out_refund_refuse"');
  });

  it("binds legacy money refunds to one authoritative after-sale amount", () => {
    expect(normalizeOutRefundPriceAction({})).toEqual({ type: 1, refundAmountCents: null });
    expect(normalizeOutRefundPriceAction({ type: "1", refund_price: "12.30" }))
      .toEqual({ type: 1, refundAmountCents: 1230 });
    expect(normalizeOutRefundPriceAction({ type: 2, refuse_reason: "资料不完整" }))
      .toEqual({ type: 2, refuseReason: "资料不完整" });
    expect(() => normalizeOutRefundPriceAction({ type: true, refund_price: 1 }))
      .toThrow("退款操作类型参数错误");
    expect(() => normalizeOutRefundPriceAction({ type: 3, refund_price: 1 }))
      .toThrow("退款操作类型参数错误");
    expect(() => normalizeOutRefundPriceAction({ type: 1, refund_price: "1.001" }))
      .toThrow("退款金额格式错误");
    expect(() => normalizeOutRefundPriceAction({ type: 2, refuse_reason: "" }))
      .toThrow("请输入不退款原因");

    const outSource = readFileSync("src/services/out/OutApiService.ts", "utf8");
    const refundSource = readFileSync("src/services/order/StoreOrderRefundService.ts", "utf8");
    const method = outSource.match(/async refundPrice\([^]*?\n  \}/)?.[0] ?? "";
    expect(method).toContain("lockPlatformRefundDecision");
    expect(method).toContain("退款金额必须等于本售后单可退金额");
    expect(method).toContain("expectedRefundAmountCents: authoritativeCents");
    expect(method).toContain("expectedStoreId: 0");
    expect(method).toContain("requireSystemVisible: true");
    expect(method).toContain("requirePaid: true");
    expect(method).toContain("new StoreOrderRefundService(this.container, this.env)");
    expect(method.indexOf("lockPlatformRefundDecision")).toBeLessThan(method.indexOf(".agreeRefund("));
    expect(refundSource).toContain("assertRefundExecutionScope(refund, order, scope)");
    expect(refundSource).toContain("assertPaymentOrderScope(paymentOrder, scope)");
    expect(refundSource).toContain("expectedRefundAmountCents");
    expect(refundSource).toContain("await lockOrderSettlement(tx, refund.storeOrderId)");
    expect(refundSource).toContain("lockRefundExecutionSnapshot(tx, refundId, scope)");
    expect(refundSource).toContain("Hyperdrive can cache transaction-external reads");
    expect(refundSource).toContain("退款渠道请求与当前订单状态不一致，请重试");

    const scenario = readFileSync(
      "test/integration/OutApiRefundMoneyPostgresScenario.ts",
      "utf8",
    );
    expect(scenario).toContain("codex_out_refund_money_");
    expect(scenario).toContain("duplicate Out balance refund changed balance twice");
    expect(scenario).toContain("partial_same_row_rejected");
    expect(scenario).toContain("inconsistent_completed_replay_rejected");
    expect(scenario).toContain("failed Out refund did not roll back atomically");
    expect(scenario).toContain("DROP SCHEMA ${schemaIdentifier} CASCADE");
    expect(scenario).toContain("public business rows or sequences changed");
  });

  it("reuses the atomic receipt settlement state machine with platform scope and replay handling", () => {
    const outSource = readFileSync("src/services/out/OutApiService.ts", "utf8");
    const settlementSource = readFileSync("src/services/order/OrderBrokerageService.ts", "utf8");
    const receive = outSource.match(/async receiveOrder\([^]*?\n  \}/)?.[0] ?? "";
    expect(receive).toContain("completeOrderReceipt");
    expect(receive).toContain('actor: "user"');
    expect(receive).toContain("expectedStoreId: 0");
    expect(receive).toContain("requireSystemVisible: true");
    expect(receive).toContain("idempotent: true");
    expect(receive).not.toContain(".set({ status: 2 })");
    expect(settlementSource).toContain("pg_advisory_xact_lock");
    expect(settlementSource).toContain("settleCompletedOrderInTx");
  });

  it("reuses the locked fulfillment state machine and persists hash-only replay outcomes", () => {
    const outSource = readFileSync("src/services/out/OutApiService.ts", "utf8");
    const fulfillment = readFileSync(
      "src/services/supplier/SupplierFulfillmentService.ts",
      "utf8",
    );
    for (const methodName of ["deliverOrder", "splitDeliverOrder"]) {
      const method = outSource.match(new RegExp(`async ${methodName}\\([^]*?\\n  \\}`))?.[0] ?? "";
      expect(method).toContain("SupplierFulfillmentService");
      expect(method).toContain("expectedStoreId: 0");
      expect(method).toContain("requestHash");
      expect(method).not.toContain(".set({ status: 1 })");
    }
    expect(outSource).toContain('delivery_type: "express"');
    expect(fulfillment).toContain("findFulfillmentReplay");
    expect(fulfillment).toContain("recordFulfillmentReplay");
    expect(fulfillment).toContain('"out_order_delivery" | "out_order_split_delivery"');
    expect(fulfillment).toContain("lockOrderSettlement(tx, rootId)");
    expect(fulfillment).toContain("withTx(this.container");
    expect(fulfillment).not.toMatch(/changeMessage:\s*(?:input\.deliveryId|input\.fictitiousContent)/);
  });

  it("serializes delivery metadata corrections and keeps assigned couriers authoritative", () => {
    const source = readFileSync("src/services/out/OutApiService.ts", "utf8");
    const method = source.match(/async updateOrderDistribution\([^]*?\n  \}/)?.[0] ?? "";
    expect(method).toContain("withTx(this.container");
    expect(method).toContain("lockOrderSettlement(tx, rootId)");
    expect(method).toContain("eq(storeOrder.storeId, 0)");
    expect(method).toContain("findDistributionReplay");
    expect(method).toContain("recordDistributionReplay");
    expect(method).toContain("deliveryService.uid, order.deliveryUid");
    expect(method).toContain("innerJoin(user, eq(user.uid, deliveryService.uid))");
    expect(method).toContain("eq(user.status, 1)");
    expect(method).toContain("送货人信息必须与当前已分配配送员一致");
    expect(method).toContain('changeType: "distribution"');
    expect(source).toContain('changeType: "out_order_distribution"');
    expect(method).not.toMatch(/changeMessage:\s*`[^`]*\$\{(?:deliveryName|deliveryId|input\.)/);
  });

  it("serializes remark writes, makes replays idempotent and records immutable evidence", () => {
    const source = readFileSync("src/services/out/OutApiService.ts", "utf8");
    const order = source.match(/async updateOrderRemark\([^]*?\n  \}/)?.[0] ?? "";
    const refund = source.match(/async updateRefundRemark\([^]*?\n  \}/)?.[0] ?? "";
    for (const method of [order, refund]) {
      expect(method).toContain("withTx");
      expect(method).toContain('.for("update")');
      expect(method).toContain("idempotent: true");
      expect(method).toContain("storeOrderStatus");
      expect(method).not.toMatch(/changeMessage:\s*remark/);
    }
    expect(order).toContain('changeType: "out_order_remark"');
    expect(refund).toContain('changeType: "out_refund_remark"');
    expect(refund).toContain("eq(storeOrderRefund.storeId, 0)");
  });

  it("enforces fixed-window limits and emits one audit event when a window first denies", () => {
    const first = advanceRateWindows({}, [{ key: "operation:write", limit: 2 }], 1_000, 60);
    expect(first.decision).toMatchObject({ allowed: true, auditEvent: false, remaining: 1 });
    const second = advanceRateWindows(first.windows, [{ key: "operation:write", limit: 2 }], 2_000, 60);
    expect(second.decision).toMatchObject({ allowed: true, auditEvent: false, remaining: 0 });
    const denied = advanceRateWindows(second.windows, [{ key: "operation:write", limit: 2 }], 3_000, 60);
    expect(denied.decision).toMatchObject({ allowed: false, auditEvent: true, remaining: 0 });
    const repeated = advanceRateWindows(denied.windows, [{ key: "operation:write", limit: 2 }], 4_000, 60);
    expect(repeated.decision).toMatchObject({ allowed: false, auditEvent: false });
    const reset = advanceRateWindows(repeated.windows, [{ key: "operation:write", limit: 2 }], 61_001, 60);
    expect(reset.decision).toMatchObject({ allowed: true, remaining: 1 });
    expect(() => advanceRateWindows({}, [{ key: "bad key", limit: 1 }], 0, 60)).toThrow();
  });

  it("rate limits IP and account independently and audits only redacted metadata", () => {
    const middleware = readFileSync("src/middleware/out-auth.ts", "utf8");
    expect(middleware).toContain('`ip:${digest.slice(0, 32)}`');
    expect(middleware).toContain('`account:${account.id}`');
    expect(middleware.indexOf("consumeIpRateLimit(c, operation, ipHash)")).toBeLessThan(
      middleware.indexOf("authenticateToken"),
    );
    expect(middleware).toContain('hmacHex(c.env, "out-api-resource", c.req.path)');
    expect(middleware).toContain("queryFieldNames(c)");
    expect(middleware).not.toMatch(/recordAccessAudit\([^]*?(?:c\.req\.path|outClientIp\(c\)|User-Agent)[^]*?\)/);
    expect(readFileSync("src/middleware/error.ts", "utf8")).toContain('c.header("Retry-After"');
  });

  it("uses explicit safe user projections and disables caching for PII routes", () => {
    const service = readFileSync("src/services/out/OutApiService.ts", "utf8");
    const controller = readFileSync("src/controllers/out/OutApiController.ts", "utf8");
    const safeProjection = service.match(/function safeUser\([\s\S]*?\n\}/)?.[0] ?? "";
    expect(safeProjection).toContain("uid: row.uid");
    expect(safeProjection).toContain("phone: row.phone");
    expect(safeProjection).not.toMatch(/row\.(?:pwd|cardId|addIp|lastIp|barCode|randCode|uniqid)/);
    expect(controller).toContain('c.header("Cache-Control", "private, no-store")');
    for (const handler of ["orderList", "orderInfo", "refundList", "refundInfo", "userList", "userInfo"]) {
      expect(controller).toMatch(new RegExp(`function ${handler}\\([^]*?privateResponse\\(c\\)`));
    }
  });

  it("never reactivates plaintext secrets or arbitrary outbound push URLs", () => {
    const service = readFileSync("src/services/out/OutApiService.ts", "utf8");
    const admin = readFileSync("src/controllers/api/v1/AdminOutApiController.ts", "utf8");
    expect(service).toContain('apppwd: ""');
    expect(service).toContain("BCRYPT_COST = 12");
    expect(service).toContain("crypto.getRandomValues(bytes)");
    expect(service).toContain('Object.hasOwn(input, "appsecret")');
    expect(service).not.toContain("String(input.appsecret");
    expect(service).toContain('push_runtime: "not_migrated"');
    expect(service).not.toMatch(/fetch\s*\(.*pushTokenUrl|fetch\s*\(.*push_token_url/i);
    expect(admin).toContain("not_migrated_security_boundary");
    expect(admin).not.toContain("pushPassword:");
  });

  it("protects Admin compatibility routes with a dedicated permission group", () => {
    expect(requiredAdminPermission("GET", "/adminapi/system_out/index")).toBe("external_api.view");
    expect(requiredAdminPermission("GET", "/adminapi/system_out/audit")).toBe("external_api.view");
    expect(requiredAdminPermission("POST", "/adminapi/system_out/save")).toBe("external_api.manage");
    expect(requiredAdminPermission("POST", "/adminapi/system_out/text_out_url")).toBe("external_api.manage");
  });

  it("wires a responsive Admin account, interface catalog and redacted audit", () => {
    const router = readFileSync("../view/admin-ts/src/router/index.ts", "utf8");
    const layout = readFileSync("../view/admin-ts/src/layouts/AdminLayout.vue", "utf8");
    const page = readFileSync("../view/admin-ts/src/pages/system/ExternalApi.vue", "utf8");
    expect(router).toContain('path: "system/out"');
    expect(layout).toContain('index="/system/out"');
    expect(page).toContain("旧系统明文凭据与任意外部推送不会在 Worker 中执行");
    expect(page).toContain("issuedSecret");
    expect(page).toContain("mobile-list");
    expect(page).toContain("审计记录不保存原始敏感标识");
    expect(page).toContain("apiExternalAudits");
    expect(page).not.toMatch(/(?:row|form|account)\.push_(?:password|token_url)/);
    expect(page).not.toMatch(/push_(?:password|token_url)\s*:/);
  });
});
