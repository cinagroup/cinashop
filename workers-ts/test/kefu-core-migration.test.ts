import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  enforceKefuLoginRateLimit,
  enforceKefuUploadRateLimit,
} from "../src/middleware/kefu-rate-limit";
import { RateLimitException } from "../src/utils/errors";
import { publicKefuIdentity } from "../src/services/kefu/KefuAuthService";
import {
  parseKefuPageLimit,
  parseKefuSessionCursor,
} from "../src/services/kefu/KefuCoreService";

describe("dedicated customer-service migration", () => {
  it("rate-limits a HMAC-pseudonymized source before credentials are parsed", async () => {
    const rawIp = "203.0.113.45";
    const consumeRateLimit = vi.fn().mockResolvedValue({
      allowed: true,
      auditEvent: false,
      limit: 10,
      remaining: 9,
      resetAt: Date.now() + 60_000,
    });
    const getByName = vi.fn((_name: string) => ({ consumeRateLimit }));
    const header = vi.fn();
    const context = {
      env: {
        APP_KEY: "unit-test-kefu-rate-limit-key",
        TOKEN_BUCKET: { getByName },
      },
      req: {
        header: (name: string) => name === "CF-Connecting-IP" ? rawIp : undefined,
      },
      header,
    } as never;

    await enforceKefuLoginRateLimit(context);

    const subject = getByName.mock.calls[0]?.[0] ?? "";
    expect(subject).toMatch(/^kefu-login:[0-9a-f]{32}$/);
    expect(subject).not.toContain(rawIp);
    expect(consumeRateLimit).toHaveBeenCalledWith([{ key: "login", limit: 10 }], 60);
    expect(header).toHaveBeenCalledWith("X-RateLimit-Remaining", "9");

    const controller = readFileSync("src/controllers/kefu/KefuController.ts", "utf8");
    expect(controller.indexOf("await enforceKefuLoginRateLimit(c)")).toBeLessThan(
      controller.indexOf("await body(c)"),
    );
  });

  it("rejects exhausted customer-service login buckets with retry metadata", async () => {
    const resetAt = Date.now() + 30_000;
    const context = {
      env: {
        APP_KEY: "unit-test-kefu-rate-limit-key",
        TOKEN_BUCKET: {
          getByName: () => ({
            consumeRateLimit: async () => ({
              allowed: false,
              auditEvent: true,
              limit: 10,
              remaining: 0,
              resetAt,
            }),
          }),
        },
      },
      req: { header: () => "203.0.113.45" },
      header: vi.fn(),
    } as never;

    await expect(enforceKefuLoginRateLimit(context)).rejects.toMatchObject({
      name: "RateLimitException",
      code: 429,
      recordAudit: false,
    } satisfies Partial<RateLimitException>);
  });

  it("keeps the PHP 100-per-day upload boundary in an agent-scoped Durable Object", async () => {
    const consumeRateLimit = vi.fn().mockResolvedValue({
      allowed: true,
      auditEvent: false,
      limit: 100,
      remaining: 99,
      resetAt: Date.now() + 86_400_000,
    });
    const getByName = vi.fn(() => ({ consumeRateLimit }));
    const context = {
      env: { TOKEN_BUCKET: { getByName } },
      get: (key: string) => key === "kefuId" ? 17 : undefined,
      header: vi.fn(),
    } as never;

    await enforceKefuUploadRateLimit(context);
    expect(getByName).toHaveBeenCalledWith("kefu-upload:17");
    expect(consumeRateLimit).toHaveBeenCalledWith([{ key: "upload", limit: 100 }], 86_400);
  });

  it("keeps the public service identity free of password and internal flags", () => {
    const identity = publicKefuIdentity({
      id: 7,
      merId: 0,
      uid: 42,
      online: 1,
      account: "support",
      password: "$2y$10$secret",
      avatar: "/avatar.png",
      nickname: "客服",
      phone: "13800138000",
      addTime: 1,
      accountStatus: 1,
      status: 1,
      notify: 1,
      customer: 0,
      uniqid: "scan-key",
      isDel: 0,
    });
    expect(identity).toEqual({
      id: 7,
      uid: 42,
      account: "support",
      avatar: "/avatar.png",
      nickname: "客服",
      phone: "13800138000",
      online: 1,
    });
    expect(identity).not.toHaveProperty("password");
    expect(identity).not.toHaveProperty("uniqid");
  });

  it("uses bounded keyset pagination inputs", () => {
    expect(parseKefuPageLimit(undefined)).toBe(20);
    expect(parseKefuPageLimit("100")).toBe(100);
    expect(() => parseKefuPageLimit("101")).toThrow("每页数量错误");
    expect(parseKefuSessionCursor("1710000000:91")).toEqual({
      updateTime: 1_710_000_000,
      id: 91,
    });
    expect(parseKefuSessionCursor("")).toBeNull();
    expect(() => parseKefuSessionCursor("91")).toThrow("会话游标错误");
  });

  it("mounts PHP-compatible HTTP routes, secure login replacements, WebSocket, and a signed asset alias", () => {
    const routes = readFileSync("src/routes/kefuapi.ts", "utf8");
    const app = readFileSync("src/app.ts", "utf8");
    const middleware = readFileSync("src/middleware/kefu-auth.ts", "utf8");
    const authService = readFileSync("src/services/kefu/KefuAuthService.ts", "utf8");
    const realtime = readFileSync("src/services/kefu/KefuRealtimeService.ts", "utf8");
    const registrations = routes.match(/kefuapiRoutes\.(?:get|post|put|delete)\(/g) ?? [];
    expect(registrations).toHaveLength(69);
    for (const route of ['get("/messages",', 'get("/messages/:id",', 'post("/messages/:id/read",']) {
      expect(routes.indexOf(route)).toBeGreaterThan(routes.indexOf('use("*", kefuAuthMiddleware)'));
    }
    expect(routes.indexOf('post("/login"')).toBeLessThan(
      routes.indexOf('use("*", kefuAuthMiddleware)'),
    );
    expect(routes).not.toContain("/ticket/");
    expect(routes).toContain('get("/wechat", KefuController.wechatLogin)');
    expect(routes).toContain('post("/key", KefuController.loginKey)');
    expect(routes).toContain('post("/oauth_state", KefuController.oauthState)');
    expect(routes).toContain('get("/service/list", KefuController.serviceChat)');
    expect(routes.indexOf('get("/assets/:id", AttachmentController.asset)')).toBeLessThan(
      routes.indexOf('use("*", kefuAuthMiddleware)'),
    );
    expect(routes.indexOf('post("/upload", AttachmentController.kefuUploadImage)')).toBeGreaterThan(
      routes.indexOf('use("*", kefuAuthMiddleware)'),
    );
    expect(routes).toContain('get("/service/transfer_list", KefuController.serviceList)');
    expect(routes).toContain('post("/service/transfer", KefuController.transfer)');
    expect(routes).not.toContain('"/service/chat"');
    expect(routes).toContain('get("/ws", KefuController.websocket)');
    expect(routes).toContain('get("/product/hot/:uid", KefuController.hotProducts)');
    expect(routes).toContain('get("/product/visit/:uid", KefuController.visitedProducts)');
    expect(routes).toContain('get("/product/cart/:uid", KefuController.purchasedProducts)');
    expect(routes).toContain('get("/product/info/:id", KefuController.productInfo)');
    expect(routes).toContain('get("/order/list/:uid", KefuController.customerOrders)');
    expect(routes).toContain('get("/order/info/:id", KefuController.orderInfo)');
    expect(routes).toContain('get("/order/refund/detail/:id", KefuController.refundDetail)');
    expect(routes).toContain('get("/order/edit/:id", KefuController.orderEditForm)');
    expect(routes).toContain('put("/order/update/:id", KefuController.updateOrder)');
    expect(routes).toContain('post("/order/remark", KefuController.updateOrderRemark)');
    expect(routes).toContain('get("/order/refund_form/:id", KefuController.orderRefundForm)');
    expect(routes).toContain('get("/refund/list", KefuController.refundList)');
    expect(routes).toContain('post("/refund/remark/:id", KefuController.updateRefundRemark)');
    expect(routes).toContain('get("/refund/refund/:id", KefuController.refundForm)');
    expect(routes).toContain('put("/refund/agree/:id", KefuController.agreeRefundReturn)');
    expect(routes).toContain('put("/refund/refund/:id", KefuController.refundOrder)');
    expect(routes).not.toContain('get("/refund/agree/:');
    expect(routes).not.toContain('post("/order/refund"');
    expect(routes).toContain('post("/order/delivery/:id", KefuController.deliverOrder)');
    expect(routes).toContain('get("/order/temp", KefuController.waybillTemplates)');
    expect(routes).toContain('put("/order/split_delivery/:id", KefuController.splitDelivery)');
    expect(routes).toContain('put("/order/write_update/:order_id", KefuController.writeoffByPublicId)');
    expect(app).toContain('app.route("/kefuapi", kefuapiRoutes)');
    expect(middleware).toContain('payload.type !== "kefu"');
    expect(middleware).toContain("bucket.token !== token");
    expect(middleware).toContain("payload.auth !== md5(kefu.password)");
    expect(middleware).toContain('userDao.findForAuth(kefu.uid)');
    expect(authService).toContain('userDao.findForAuth(kefu.uid)');
    expect(realtime).toContain('.innerJoin(userTable, eq(userTable.uid, storeService.uid))');
    expect(realtime).toContain('eq(userTable.status, 1)');
    expect(middleware).not.toContain("adminAuthMiddleware");
  });

  it("keeps the external and Worker-embedded customer-service indexes byte-equivalent", () => {
    const migration = readFileSync("migrations/0092_kefu_core_indexes.sql", "utf8").trim();
    const embedded = readFileSync("src/services/MigrationService.ts", "utf8")
      .match(/private migration_0099\(\): string \{\s*return `([\s\S]*?)`;\s*\}/)?.[1]
      ?.trim();
    expect(embedded).toBe(migration);
    for (const index of [
      "ss_active_online",
      "ssl_chat_history",
      "ssr_kefu_recent",
      "category_kefu_speechcraft",
    ]) {
      expect(migration).toContain(`\"${index}\"`);
    }
  });

  it("enforces conversation and owner scopes in the runtime services", () => {
    const core = readFileSync("src/services/kefu/KefuCoreService.ts", "utf8");
    const catalog = readFileSync("src/services/message/CustomerServiceCatalogService.ts", "utf8");
    const segmentation = readFileSync("src/services/user/UserSegmentationService.ts", "utf8");
    expect(core).toContain("eq(storeServiceRecord.userId, kefuUid)");
    expect(core).toContain("eq(storeServiceRecord.toUid, peerUid)");
    expect(core).toContain("await this.assertConversation(kefuUid, uid, 0)");
    expect(core).toContain("Historical messages are not an ownership grant");
    expect(core).toContain(".userLabelOptions(uid)");
    expect(segmentation).toContain("disabled: selectedIds.has(label.id)");
    expect(segmentation).toContain("eq(legacyCategory.group, 0)");
    expect(catalog).toContain("eq(legacyCategory.ownerId, kefuId)");
    expect(catalog).toContain("该分类仍有话术，不能删除");
  });
});
