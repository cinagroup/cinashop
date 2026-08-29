import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { ScanLoginService } from "../src/services/auth/ScanLoginService";

describe("PC and customer-service scan/OAuth migration", () => {
  it("separates the displayed QR key from the browser-only poll secret", async () => {
    let stored: Record<string, unknown> | null = null;
    const challengeStub = {
      createScanLoginChallenge: vi.fn(async (state: Record<string, unknown>) => {
        stored = state;
        return true;
      }),
    };
    const rateStub = {
      consumeRateLimit: vi.fn(async () => ({
        allowed: true,
        auditEvent: false,
        limit: 20,
        remaining: 19,
        resetAt: Date.now() + 60_000,
      })),
    };
    const getByName = vi.fn((name: string) => name.startsWith("scan-login-rate:")
      ? rateStub
      : challengeStub);
    const service = new ScanLoginService(
      {} as never,
      { APP_KEY: "scan-login-unit-key", TOKEN_BUCKET: { getByName } } as never,
    );

    const result = await service.create("pc_user", {
      origin: "https://cinashop-pc.pages.dev",
      device: "Windows · Chrome",
      target: "CinaShop PC 商城",
    }, "203.0.113.7");
    expect(result.key).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.poll_token).toMatch(/^[a-f0-9]{64}$/);
    expect(result.poll_token).not.toBe(result.key);
    expect(stored).toMatchObject({
      audience: "pc_user",
      stage: "pending",
      version: 1,
      clientOrigin: "https://cinashop-pc.pages.dev",
      clientDevice: "Windows · Chrome",
      target: "CinaShop PC 商城",
    });
    expect(stored).not.toHaveProperty("pollToken", result.poll_token);
    const storedState = stored as unknown as Record<string, unknown>;
    expect(String(storedState.pollTokenHash)).toMatch(/^[a-f0-9]{64}$/);
    expect(String(storedState.pollTokenHash)).not.toBe(result.poll_token);
    expect(getByName.mock.calls[0]?.[0]).toMatch(/^scan-login-rate:[a-f0-9]{32}$/);
  });

  it("keeps route audiences distinct and requires a non-URL poll header", () => {
    const pcRoutes = readFileSync("src/routes/v1/index.ts", "utf8");
    const kefuRoutes = readFileSync("src/routes/kefuapi.ts", "utf8");
    const pcController = readFileSync("src/controllers/api/v1/PcCompatibilityController.ts", "utf8");
    const kefuController = readFileSync("src/controllers/kefu/KefuController.ts", "utf8");
    const scan = readFileSync("src/services/auth/ScanLoginService.ts", "utf8");
    const cors = readFileSync("src/middleware/cors.ts", "utf8");

    expect(pcRoutes).toContain('get("/pc/key", PcCompatibilityController.key)');
    expect(pcRoutes).toContain('post("/pc/oauth_state", PcCompatibilityController.oauthState)');
    expect(kefuRoutes).toContain('get("/key", KefuController.loginKey)');
    expect(kefuRoutes).toContain('get("/scan/:key", KefuController.scanLogin)');
    expect(kefuRoutes).toContain('post("/oauth_state", KefuController.oauthState)');
    expect(kefuRoutes).toContain('get("/wechat", KefuController.wechatLogin)');
    expect(pcController).toContain('c.req.header("X-Scan-Poll-Token")');
    expect(kefuController).toContain('c.req.header("X-Scan-Poll-Token")');
    expect(cors).toContain('"X-Scan-Poll-Token"');
    expect(scan).not.toContain("userTable.uniqid");
    expect(scan).not.toContain("storeService.uniqid");
  });

  it("uses one-time audience-bound OAuth state and bounded provider reads", () => {
    const oauth = readFileSync("src/services/wechat/WechatOpenWebAuthService.ts", "utf8");
    expect(oauth).toContain('purpose: "open_web_oauth_login"');
    expect(oauth).toContain("record.audience !== audience");
    expect(oauth).toContain("verifierHash");
    expect(oauth).toContain("clientOrigin");
    expect(oauth).toContain("cacheTake<OpenWebOauthState>");
    expect(oauth).toContain("cacheSetIfAbsent(");
    expect(oauth).toContain("PROVIDER_CODE_TTL_SECONDS");
    expect(oauth).toContain("RESPONSE_MAX_BYTES");
    expect(oauth).toContain("FETCH_TIMEOUT_MS");
    expect(oauth).toContain("WECHAT_OPEN_APP_SECRET");
    expect(oauth).not.toContain('"wechat_open_app_secret"');
    expect(oauth).toContain("systemConfigDao.getValues");
    expect(oauth).toContain("|| !unionid || unionid.length > 30");
    expect(oauth).not.toContain("new SystemConfigService");
  });

  it("closes the PC/Kefu/mobile frontend loop without putting the poll secret in QR URLs", () => {
    const pc = readFileSync("../view/pc-ts/src/pages/auth/Login.vue", "utf8");
    const pcApi = readFileSync("../view/pc-ts/src/api/auth.ts", "utf8");
    const kefu = readFileSync("../view/kefu-ts/src/pages/LoginPage.vue", "utf8");
    const kefuApi = readFileSync("../view/kefu-ts/src/api/kefu.ts", "utf8");
    const mobile = readFileSync("../view/uniapp-ts/src/pages/auth/scanLogin.vue", "utf8");
    const mobileApi = readFileSync("../view/uniapp-ts/src/api/auth.ts", "utf8");
    const profileController = readFileSync("src/controllers/api/v1/UserProfileController.ts", "utf8");
    const durable = readFileSync("src/do/TokenBucketDO.ts", "utf8");

    expect(pcApi).toContain('request.post<ScanLoginChallenge>("/pc/key")');
    expect(pc).toContain("QRCode.toDataURL(scanApprovalUrl(challenge.key)");
    expect(pc).toContain("scanPollToken = challenge.poll_token");
    expect(pc).toContain("apiCreatePcOauthState");
    expect(pc).toContain("apiPcWechatAuth(code, state)");
    expect(pc).toContain("delete cleanQuery.code");
    expect(kefuApi).toContain('apiRequest<KefuScanChallenge>("/kefuapi/key"');
    expect(kefu).toContain("QRCode.toDataURL(scanApprovalUrl(challenge.key)");
    expect(kefu).toContain("auth.applyLogin(await kefuApi.wechatLogin(code, state))");
    expect(mobileApi).toContain('http.get<ScanLoginApproval>("/user/code", { key })');
    expect(mobileApi).toContain('{ key, action: "approve" }');
    expect(mobileApi).toContain('{ key, action: "reject" }');
    expect(mobile).toContain("challenge.target.origin");
    expect(mobile).toContain("challenge.target.device");
    expect(mobile).toContain("apiRejectLoginCode(key.value)");
    expect(profileController).toContain('if (action === "reject")');
    expect(durable).toContain("rejectScanLoginChallenge");
    expect(durable).toContain("this.ctx.storage.delete(SCAN_LOGIN_KEY)");
    expect(pc).not.toContain("scanApprovalUrl(challenge.poll_token");
    expect(kefu).not.toContain("scanApprovalUrl(challenge.poll_token");
  });

  it("keeps the audited system-config lookup index source and embedded DDL equivalent", () => {
    const migration = readFileSync("migrations/0103_system_config_lookup.sql", "utf8").trim();
    const embedded = readFileSync("src/services/MigrationService.ts", "utf8")
      .match(/private migration_0110\(\): string \{\s*return `([\s\S]*?)`;\s*\}/)?.[1]
      ?.trim();
    const schema = readFileSync("src/models/schema/system.ts", "utf8");
    expect(embedded).toBe(migration);
    expect(schema).toContain('index("system_config_lookup")');
    expect(migration).toContain('("is_store", "menu_name", "sort" DESC, "id" DESC)');
  });
});
