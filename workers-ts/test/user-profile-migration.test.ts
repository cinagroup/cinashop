import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { UserProfileService, type PaymentCodeStore } from "../src/services/user/UserProfileService";

describe("PHP user-profile migration", () => {
  it("registers every audited user-centre route with the PHP auth boundary", () => {
    const routes = readFileSync("src/routes/v1/index.ts", "utf8");
    expect(routes).toContain('get("/user/activity", authMiddleware({ force: false })');
    for (const fragment of [
      'get("/user/code", authMiddleware({ force: true })',
      'post("/user/code", authMiddleware({ force: true })',
      'get("/user", authMiddleware({ force: true })',
      'get("/userinfo", authMiddleware({ force: true })',
      'get("/user/rand_code", authMiddleware({ force: true })',
      'post("/user/share", authMiddleware({ force: true })',
      'get("/user/share/words", authMiddleware({ force: true })',
      'get("/user/routine_code", authMiddleware({ force: true })',
      'get("/user/spread_info", authMiddleware({ force: true })',
    ]) {
      expect(routes).toContain(fragment);
    }
    expect(routes).toContain('"/user/record",\n  authMiddleware({ force: true }),\n  UserMessageController.customerServiceConversationList');
    expect(routes).not.toContain('get("/user/record", authMiddleware({ force: true }), UserMessageController.customerServiceRecord)');
  });

  it("replaces the weak PHP QR cache handshake with authenticated inspect/approve", () => {
    const routes = readFileSync("src/routes/v1/index.ts", "utf8");
    const controller = readFileSync("src/controllers/api/v1/UserProfileController.ts", "utf8");
    expect(routes).toContain('UserProfileController.inspectLoginCode');
    expect(routes).toContain('UserProfileController.approveLoginCode');
    expect(routes).not.toContain("userCodeUnavailable");
    expect(controller).toContain("new ScanLoginService");
    expect(controller).toContain(".inspect(scanCode(c), uid(c), clientIp(c))");
    expect(controller).toContain("const key = payload.code ?? payload.key ?? scanCode(c)");
    expect(controller).toContain('if (action === "reject") return login.reject(key, uid(c), clientIp(c))');
    expect(controller).toContain("return login.approve(key, uid(c), clientIp(c))");
    expect(controller).toContain("readBoundedJsonObject(c.req.raw, 4 * 1024)");
  });

  it("projects the self profile without credential or IP columns", () => {
    const service = readFileSync("src/services/user/UserProfileService.ts", "utf8");
    const projection = service.slice(service.indexOf("private async safeAccount"));
    expect(projection).not.toContain("userTable.pwd");
    expect(projection).not.toContain("userTable.account");
    expect(projection).not.toContain("userTable.uniqid");
    expect(projection).not.toContain("userTable.randCode");
    expect(projection).not.toContain("userTable.addIp");
    expect(projection).not.toContain("userTable.lastIp");
    expect(projection).not.toContain("userTable.cleanTime");
  });

  it("serializes share cooldown writes and stores immutable evidence", () => {
    const service = readFileSync("src/services/user/UserProfileService.ts", "utf8");
    expect(service).toContain('.for("update")');
    expect(service).toContain("SHARE_COOLDOWN_SECONDS");
    expect(service).toContain('eventKey: "user_share"');
    expect(service).toContain('category: "share"');
  });

  it("uses a cryptographically generated fixed-width payment code with atomic TTL reuse", async () => {
    const service = readFileSync("src/services/user/UserProfileService.ts", "utf8");
    expect(service).toContain("crypto.getRandomValues");
    expect(service).toContain("PAYMENT_CODE_TTL_SECONDS");
    expect(service).toContain("cacheSetIfAbsent(key, value, env, ttlSeconds)");
    expect(service).toContain("const winner = await this.paymentCodes.get(key)");
    expect(service).toContain("付款码服务未配置");
    expect(service).not.toContain("Math.random");

    const values = new Map<string, string>();
    const store: PaymentCodeStore = {
      get: async (key) => values.get(key) ?? null,
      putIfAbsent: async (key, value) => {
        if (values.has(key)) return false;
        values.set(key, value);
        return true;
      },
    };
    const profile = new UserProfileService({} as never, {} as never, store);
    const codes = await Promise.all(Array.from({ length: 8 }, () => profile.paymentCode(7)));
    expect(new Set(codes).size).toBe(1);
    expect(codes[0]).toMatch(/^\d{6}$/);
  });
});
