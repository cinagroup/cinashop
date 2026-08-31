import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { CustomerServiceCatalogService } from "../src/services/message/CustomerServiceCatalogService";
import { KefuTouristService } from "../src/services/kefu/KefuTouristService";

describe("customer-service tourist compatibility migration", () => {
  it("retires the registered PHP ticket target because its controller method is absent", () => {
    const routePath = "../../cinashop-php/route/kefu.php";
    const controllerPath = "../../cinashop-php/app/controller/kefu/Login.php";
    const decisions = JSON.parse(readFileSync("audit/legacy-route-decisions.json", "utf8")) as {
      decisions: Array<{ method: string; path: string; status: string }>;
    };
    if (
      existsSync(routePath) &&
      existsSync(controllerPath) &&
      process.env.CINASHOP_TEST_FORCE_SNAPSHOT !== "1"
    ) {
      expect(readFileSync(routePath, "utf8"))
        .toContain("Route::any('ticket/[:appid]', 'Login/ticket')");
      expect(readFileSync(controllerPath, "utf8")).not.toMatch(/function\s+ticket\s*\(/);
    } else {
      const authority = JSON.parse(
        readFileSync("audit/legacy-route-authority.json", "utf8"),
      ) as {
        files: Record<string, { lineCount: number; sha256: string }>;
        surfaces: Record<string, Array<{ method: string; path: string; target: string }>>;
      };
      expect(authority.surfaces.kefu).toContainEqual(expect.objectContaining({
        method: "ANY",
        path: "/kefuapi/ticket/[:appid]",
        target: "Login/ticket",
      }));
      expect(authority.files["cinashop-php/app/controller/kefu/Login.php"]).toEqual({
        lineCount: 112,
        sha256: "bdf404dc2d984b4ef1b6110894700efb5f5035b2eb0c40463b5cae4d16135236",
      });
    }
    expect(decisions.decisions).toContainEqual(expect.objectContaining({
      method: "ANY",
      path: "/kefuapi/ticket/[:appid]",
      status: "retired",
    }));
  });

  it("registers identity-bearing tourist contracts behind purpose-specific authentication", () => {
    const routes = readFileSync("src/routes/kefuapi.ts", "utf8");
    for (const contract of [
      'get("/tourist/adv", KefuController.touristAdvertisement)',
      'get("/tourist/feedback", KefuController.touristFeedbackInfo)',
      'post("/tourist/feedback", KefuController.touristSubmitFeedback)',
      'get("/tourist/product/:id", KefuController.touristProduct)',
    ]) expect(routes).toContain(contract);
    expect(routes).toContain('get("/tourist/user", KefuController.touristUser)');
    expect(routes).toContain('get("/tourist/chat", visitorAuthMiddleware, KefuController.touristChat)');
    expect(routes).toContain('get("/tourist/order/:order_id", authMiddleware({ force: true }), KefuController.touristOrder)');
    expect(routes).toContain('get("/tourist/ws", visitorAuthMiddleware, KefuController.touristWebsocket)');
    expect(routes).toContain('post("/tourist/upload", visitorAuthMiddleware, AttachmentController.visitorUploadImage)');
    expect(routes.indexOf('get("/tourist/user"')).toBeLessThan(
      routes.indexOf('use("*", kefuAuthMiddleware)'),
    );
  });

  it("uses signed, revocable, non-PII visitor sessions and isolated attachment ownership", () => {
    const service = readFileSync("src/services/kefu/KefuVisitorSessionService.ts", "utf8");
    const middleware = readFileSync("src/middleware/visitor-auth.ts", "utf8");
    const cors = readFileSync("src/middleware/cors.ts", "utf8");
    const attachments = readFileSync("src/services/system/AttachmentService.ts", "utf8");
    expect(service).toContain('const VISITOR_ISSUER = "cinashop-kefu-visitor"');
    expect(service).toContain('.setAudience(VISITOR_AUDIENCE)');
    expect(service).toContain('tokenHash = await sha256Hex(token)');
    expect(service).not.toContain('ip: ip');
    expect(service).not.toContain('rawToken');
    expect(middleware).toContain('c.set("socketAuthVersion", identity.tokenHash)');
    expect(cors).toContain('"Form-type"');
    expect(cors).toContain('"X-Visitor-Token"');
    expect(attachments).toContain('moduleType: 4');
    expect(attachments).toContain('return "visitor"');
  });

  it("stores anonymous feedback as uid zero with PHP-compatible escaping", async () => {
    let inserted: Record<string, unknown> | null = null;
    const returning = vi.fn(async () => [{ id: 17 }]);
    const values = vi.fn((value: Record<string, unknown>) => {
      inserted = value;
      return { returning };
    });
    const insert = vi.fn(() => ({ values }));
    const service = new CustomerServiceCatalogService({ db: { insert } } as never);
    await expect(service.submitAnonymousFeedback({
      rela_name: "访客",
      phone: "13800000000",
      content: "<b>需要帮助</b>",
    })).resolves.toEqual({ id: 17 });
    expect(inserted).toMatchObject({
      uid: 0,
      relaName: "访客",
      phone: "13800000000",
      content: "&lt;b&gt;需要帮助&lt;/b&gt;",
    });
  });

  it("rate-limits anonymous feedback by an HMAC-only source key", async () => {
    let inserted: Record<string, unknown> | null = null;
    const db = {
      insert: vi.fn(() => ({
        values: vi.fn((value: Record<string, unknown>) => {
          inserted = value;
          return { returning: vi.fn(async () => [{ id: 19 }]) };
        }),
      })),
    };
    const consumeRateLimit = vi.fn(async () => ({
      allowed: true,
      auditEvent: false,
      limit: 5,
      remaining: 4,
      resetAt: Date.now() + 3_600_000,
    }));
    const getByName = vi.fn((_name: string) => ({ consumeRateLimit }));
    const service = new KefuTouristService(
      { db } as never,
      {
        APP_KEY: "tourist-unit-hmac-key",
        TOKEN_BUCKET: { getByName },
      } as never,
    );
    await service.submitFeedback({
      rela_name: "访客",
      phone: "13800000000",
      content: "问题描述",
    }, "203.0.113.9");
    expect(inserted).toMatchObject({ uid: 0 });
    expect(getByName).toHaveBeenCalledWith(expect.stringMatching(
      /^kefu-tourist-feedback:[a-f0-9]{32}$/,
    ));
    expect(String(getByName.mock.calls[0]?.[0])).not.toContain("203.0.113.9");
    expect(getByName).toHaveBeenCalledWith("kefu-tourist-feedback:global");
    expect(consumeRateLimit).toHaveBeenCalledWith([{ key: "ip", limit: 5 }], 3_600);
    expect(consumeRateLimit).toHaveBeenCalledWith([{ key: "global", limit: 300 }], 3_600);
  });

  it("adds explicit public-product visibility gates", () => {
    const source = readFileSync("src/services/kefu/KefuProductService.ts", "utf8");
    expect(source).toContain("if (publicOnly)");
    expect(source).toContain("eq(storeProduct.isDel, 0)");
    expect(source).toContain("eq(storeProduct.isShow, 1)");
    expect(source).toContain("eq(storeProduct.isVerify, 1)");
  });

  it("keeps the production audit read-only and omits feedback/config values", () => {
    const worker = readFileSync("test/integration/KefuTouristAuditWorker.ts", "utf8");
    const config = readFileSync("test/integration/kefu-tourist-audit.wrangler.jsonc", "utf8");
    expect(worker).toContain("REPEATABLE READ, READ ONLY");
    expect(worker).toContain("pii_returned: false");
    expect(worker).toContain("config_values_returned: false");
    expect(worker).not.toContain("SELECT rela_name");
    expect(worker).not.toContain("SELECT phone");
    expect(config).toContain('"id": "9748c294e21c49a99579c9cef70102e0"');
  });
});
