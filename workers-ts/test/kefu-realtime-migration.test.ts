import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  parseChatEnvelope,
  parseChatSessionRequest,
} from "../src/services/kefu/KefuSocketProtocol";
import { sanitizeRealtimeMessage } from "../src/services/kefu/KefuRealtimeService";
import { chatPrincipalName } from "../src/services/kefu/KefuSocketGateway";

const VALID_SESSION_HEADERS = {
  "X-Chat-Principal-Uid": "2001",
  "X-Chat-Role": "1",
  "X-Chat-To-Uid": "1001",
  "X-Chat-Auth-Id": "2001",
  "X-Chat-Token-Key": "0123456789abcdef0123456789abcdef",
  "X-Chat-Token-Exp": "1999999999",
  "X-Chat-Auth-Version": "password-version",
};

describe("customer-service realtime migration", () => {
  it("partitions Durable Objects by authenticated role and principal", () => {
    expect(chatPrincipalName(1, 42)).toBe("user:42");
    expect(chatPrincipalName(2, 42)).toBe("kefu:42");
    expect(() => chatPrincipalName(1, 0)).toThrow("聊天身份无效");
  });

  it("accepts only bounded, known WebSocket envelopes", () => {
    expect(parseChatEnvelope(JSON.stringify({ type: "ping" }))).toEqual({
      type: "ping",
      data: {},
    });
    expect(parseChatEnvelope(JSON.stringify({
      type: "chat",
      data: { to_uid: 1001, msn: "你好", msn_type: 1 },
    })).type).toBe("chat");
    expect(() => parseChatEnvelope("not-json")).toThrow();
    expect(() => parseChatEnvelope(JSON.stringify({ type: "login" }))).toThrow("unsupported chat event");
    expect(() => parseChatEnvelope("x".repeat(8 * 1024 + 1))).toThrow("invalid chat frame size");
  });

  it("constructs socket sessions only from trusted gateway metadata", () => {
    const session = parseChatSessionRequest(new Request("https://chat.internal/connect", {
      headers: VALID_SESSION_HEADERS,
    }));
    expect(session).toMatchObject({
      principalUid: 2001,
      role: 1,
      toUid: 1001,
      authId: 2001,
      tokenKey: VALID_SESSION_HEADERS["X-Chat-Token-Key"],
    });
    expect(() => parseChatSessionRequest(new Request("https://chat.internal/connect", {
      headers: { ...VALID_SESSION_HEADERS, "X-Chat-To-Uid": "2001" },
    }))).toThrow("invalid chat session");
    expect(() => parseChatSessionRequest(new Request("https://chat.internal/connect", {
      headers: { ...VALID_SESSION_HEADERS, "X-Chat-Token-Key": "raw-jwt" },
    }))).toThrow("invalid chat session");
  });

  it("sanitizes text and enforces the PHP-compatible realtime bounds", () => {
    expect(sanitizeRealtimeMessage("  <b>你\u0000好</b>  ")).toBe("你好");
    expect(() => sanitizeRealtimeMessage("<b></b>")).toThrow("消息内容无效");
    expect(() => sanitizeRealtimeMessage("x".repeat(2_001))).toThrow("消息内容无效");
  });

  it("persists before cross-object delivery and keeps raw JWTs out of the DO", () => {
    const durableObject = readFileSync("src/do/ChatRoomDO.ts", "utf8");
    const gateway = readFileSync("src/services/kefu/KefuSocketGateway.ts", "utf8");
    const routes = readFileSync("src/routes/v1/index.ts", "utf8");
    const admin = readFileSync("src/controllers/api/v1/AdminController.ts", "utf8");
    const kefuRoutes = readFileSync("src/routes/kefuapi.ts", "utf8");

    expect(durableObject.indexOf("persistMessage(session")).toBeLessThan(
      durableObject.indexOf("recipient.deliver(persisted)"),
    );
    expect(durableObject).toContain("A delivery outage must not invite a duplicate retry");
    expect(durableObject.indexOf('structuredError("chat_recipient_delivery_failed"')).toBeLessThan(
      durableObject.indexOf('senderWs.send(JSON.stringify({ type: "chat"'),
    );
    expect(durableObject).toContain("acceptWebSocket");
    expect(durableObject).toContain("serializeAttachment");
    expect(durableObject).not.toContain("global-v2");
    expect(durableObject).not.toContain("INTERNAL_API_URL");
    expect(durableObject).not.toContain("/internal/chat_save");
    expect(gateway).toContain("Do not forward cinashop-auth.<raw JWT>");
    expect(routes).not.toContain("/internal/chat_save");
    expect(routes).toContain('"/ws/kefu"');
    expect(admin).toContain("管理员不能充当客服身份");
    expect(admin).toContain("管理员不能发送客服消息");
    expect(kefuRoutes.indexOf('use("*", kefuAuthMiddleware)')).toBeLessThan(
      kefuRoutes.indexOf('get("/ws", KefuController.websocket)'),
    );
  });

  it("stores canonical image references, checks attachment ownership, and signs presentation URLs", () => {
    const realtime = readFileSync("src/services/kefu/KefuRealtimeService.ts", "utf8");
    const core = readFileSync("src/services/kefu/KefuCoreService.ts", "utf8");
    expect(realtime).toContain("parseCanonicalAttachmentId(value)");
    expect(realtime).toContain("eq(systemAttachment.relationId, expectedRelationId)");
    expect(realtime).toContain("eq(systemAttachment.moduleType, expectedModuleType)");
    expect(realtime).toContain("eq(systemAttachment.imageType, R2_IMAGE_TYPE)");
    expect(realtime.indexOf("assertOwnedImageAttachment(tx")).toBeLessThan(
      realtime.indexOf(".insert(storeServiceLog)"),
    );
    expect(realtime).toContain("signAttachmentReferences(appKey, [message.msn], 60 * 60)");
    expect(realtime).toContain("async userConversationList(");
    expect(realtime).toContain("eq(storeServiceRecord.userId, userUid)");
    expect(realtime).toContain("eq(storeServiceRecord.isTourist, 0)");
    expect(realtime).toContain("parseCanonicalAttachmentId(row.message)");
    expect(core).toContain("return signImageMessages(rows.reverse().map(formatMessage), this.env?.APP_KEY)");
  });

  it("uses the selected service and never REST-plus-WebSocket double-writes", () => {
    const client = readFileSync("../view/uniapp-ts/src/pages/user/kefu.vue", "utf8");
    expect(client).toContain('http.get<ServiceRecord>("/user/service/record"');
    expect(client).toContain("to_uid: serviceUid.value");
    expect(client).not.toContain("to_uid: 0");
    expect(client).not.toContain("wss://cinashop-api.cinagroup.workers.dev");
    expect(client).toContain("if (socketReady)");
    expect(client).toContain("await sendOverSocket(text)");
    expect(client).toContain("await sendOverSocket(attachment.url, 3)");
    expect(client).toContain('msn_type: 3');
  });

  it("keeps the external and embedded realtime index migrations byte-equivalent", () => {
    const migration = readFileSync("migrations/0093_kefu_realtime_indexes.sql", "utf8").trim();
    const embedded = readFileSync("src/services/MigrationService.ts", "utf8")
      .match(/private migration_0100\(\): string \{\s*return `([\s\S]*?)`;\s*\}/)?.[1]
      ?.trim();
    expect(embedded).toBe(migration);
    for (const index of [
      "ss_active_uid",
      "ssr_kefu_inbox",
      "ssr_direction",
      "ssl_unread_direction",
    ]) {
      expect(migration).toContain(`\"${index}\"`);
    }
  });
});
