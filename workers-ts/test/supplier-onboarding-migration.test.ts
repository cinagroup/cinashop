import { readFileSync } from "node:fs";
import { getTableColumns, getTableName } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { Env, SmsVerificationMessage } from "@/env";
import { smsRecord, systemUserApply } from "@/models/schema";
import { requiredAdminPermission } from "@/services/admin/AdminPermissionService";
import {
  isSmsVerificationMessage,
  sendAliyunSms,
} from "@/services/message/SmsVerificationService";
import { MIGRATION_MANIFEST_VERSION, MIGRATION_TABLES } from "../scripts/data-migration/manifest";

const message: SmsVerificationMessage = {
  action: "sendSmsVerification",
  recordId: 19,
  uid: 86,
  phone: "13800138000",
  code: "042731",
  expiresIn: 300,
  purpose: "supplier_application",
  templateCode: "SMS_123456789",
};

const smsEnv = {
  UPSTASH_REDIS_URL: "https://redis.example.test",
  UPSTASH_REDIS_TOKEN: "redis-token",
  ALIYUN_SMS_ACCESS_KEY_ID: "test-access-id",
  ALIYUN_SMS_ACCESS_KEY_SECRET: "test-access-secret",
  ALIYUN_SMS_SIGN_NAME: "CinaShop",
} as Env;

describe("supplier onboarding migration and security boundary", () => {
  it("preserves both source tables and advances the deterministic manifest", () => {
    expect(getTableName(systemUserApply)).toBe("system_user_apply");
    expect(getTableName(smsRecord)).toBe("sms_record");
    expect(Object.keys(getTableColumns(systemUserApply))).toEqual([
      "id", "type", "relationId", "uid", "phone", "systemName", "name", "images",
      "mark", "status", "failMsg", "isDel", "statusTime", "addTime",
    ]);
    expect(Object.keys(getTableColumns(smsRecord))).toEqual([
      "id", "uid", "phone", "content", "addTime", "addIp", "template", "resultcode", "recordId",
    ]);
    expect(MIGRATION_TABLES.find((entry) => entry.table === "system_user_apply")?.key).toEqual(["id"]);
    expect(MIGRATION_TABLES.find((entry) => entry.table === "sms_record")?.key).toEqual(["id"]);
    expect(MIGRATION_MANIFEST_VERSION).toBe("2026-08-11.57");
  });

  it("keeps external and Worker-embedded SQL identical without invented constraints", () => {
    const migration = readFileSync("migrations/0066_supplier_onboarding.sql", "utf8").trim();
    const service = readFileSync("src/services/MigrationService.ts", "utf8");
    const embedded = service.match(/private migration_0073\(\): string \{\s*return `([\s\S]*?)`;\s*\}/)?.[1]?.trim();
    expect(embedded).toBe(migration);
    expect(migration).not.toMatch(/CREATE UNIQUE INDEX|FOREIGN KEY\s*\(|REFERENCES\s+"/i);
    expect(migration).toContain('"images" VARCHAR(2000)');
    expect(migration).toContain('"phone" CHAR(11)');
  });

  it("registers authenticated compatibility and modern routes in one permission domain", () => {
    const userRoutes = readFileSync("src/routes/v1/index.ts", "utf8");
    const adminRoutes = readFileSync("src/routes/adminapi.ts", "utf8");
    for (const route of [
      "/user/apply/record", "/user/apply/:id", "/user/apply/supplier/code",
      "/user/apply/supplier/:id", "/user/apply/activate/:id",
    ]) expect(userRoutes).toContain(route);
    for (const route of [
      "/supplier/apply/list", "/supplier/apply/info/:id", "/supplier/apply/verify/:id",
      "/supplier/apply/mark/:id", "/supplier/apply/del/:id",
    ]) expect(adminRoutes).toContain(route);
    expect(requiredAdminPermission("GET", "/adminapi/supplier/apply/list"))
      .toBe("supplier_application.view");
    expect(requiredAdminPermission("POST", "/api/admin/supplier/applications/:id/review"))
      .toBe("supplier_application.manage");
  });

  it("makes ownership and SMS activation explicit instead of returning predictable passwords", () => {
    const source = readFileSync("src/services/supplier/SupplierApplicationService.ts", "utf8");
    expect(source.match(/eq\(systemUserApply\.uid, uid\)/g)?.length ?? 0).toBeGreaterThanOrEqual(5);
    expect(source).toContain("activation_required");
    expect(source).toContain("status: 0");
    expect(source).toContain('text(input.password, "密码", 12, 72)');
    expect(source).not.toMatch(/substr|slice\(-6\)|phone\.slice/i);
    expect(source).not.toMatch(/password:\s*application\.phone|pwd:\s*application\.phone/);
  });

  it("strictly recognizes verification queue messages", () => {
    expect(isSmsVerificationMessage(message)).toBe(true);
    expect(isSmsVerificationMessage({ ...message, code: "12345" })).toBe(false);
    expect(isSmsVerificationMessage({ ...message, purpose: "password_reset" })).toBe(false);
    expect(isSmsVerificationMessage({ ...message, phone: "+8613800138000" })).toBe(false);
  });

  it("signs a bounded Aliyun RPC request and never exposes the secret in request fields", async () => {
    let requestBody = "";
    const fetcher = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestBody = String(init?.body ?? "");
      return new Response(JSON.stringify({ Code: "OK", BizId: "20260810001", RequestId: "req-1" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    await expect(sendAliyunSms(smsEnv, message, fetcher)).resolves.toEqual({
      bizId: "20260810001",
      requestId: "req-1",
    });
    const params = new URLSearchParams(requestBody);
    expect(params.get("Action")).toBe("SendSms");
    expect(params.get("PhoneNumbers")).toBe(message.phone);
    expect(params.get("TemplateParam")).toBe(JSON.stringify({ code: message.code }));
    expect(params.get("Signature")).toBeTruthy();
    expect(requestBody).not.toContain("test-access-secret");
  });

  it("bounds provider responses and redacts an upstream message from errors", async () => {
    const oversized = (async () => new Response("", {
      status: 200,
      headers: { "content-length": String(65 * 1024) },
    })) as typeof fetch;
    await expect(sendAliyunSms(smsEnv, message, oversized)).rejects.toThrow("exceeded 64 KiB");

    const rejected = (async () => new Response(JSON.stringify({
      Code: "isv.BUSINESS_LIMIT_CONTROL",
      Message: `provider echoed secret code ${message.code}`,
    }), { status: 400 })) as typeof fetch;
    await expect(sendAliyunSms(smsEnv, message, rejected)).rejects.not.toThrow(message.code);
  });
});
