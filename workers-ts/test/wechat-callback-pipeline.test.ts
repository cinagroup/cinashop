import { readFileSync } from "node:fs";
import { createCipheriv, createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { MigrationService } from "@/services/MigrationService";
import { prepareOrderQueueDeadLetter } from "@/services/order/OrderQueueDeadLetterService";
import {
  consumeWechatCallbackMessage,
  isWechatCallbackDispatchMessage,
  isWechatCallbackOutboxMessage,
} from "@/services/wechat/WechatCallbackService";
import {
  decryptWechatCallback,
  encryptWechatReply,
  normalizeWechatCallback,
  verifyWechatEncryptedSignature,
  verifyWechatPlainChallenge,
  wechatEncryptedXmlValue,
} from "@/services/wechat/WechatCallbackCrypto";

const key = Buffer.from(Array.from({ length: 32 }, (_, index) => index + 1));
const aesKey = key.toString("base64").slice(0, -1);
const appId = "wx-callback-test";
const token = "callback-token";

function encryptedMessage(message: string, receiveId = appId): string {
  const messageBytes = Buffer.from(message);
  const receiveBytes = Buffer.from(receiveId);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(messageBytes.byteLength);
  const unpadded = Buffer.concat([Buffer.alloc(16, 7), length, messageBytes, receiveBytes]);
  const remainder = unpadded.byteLength % 32;
  const padding = remainder === 0 ? 32 : 32 - remainder;
  const padded = Buffer.concat([unpadded, Buffer.alloc(padding, padding)]);
  const cipher = createCipheriv("aes-256-cbc", key, key.subarray(0, 16));
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(padded), cipher.final()]).toString("base64");
}

function signature(timestamp: string, nonce: string, encrypted = ""): string {
  return createHash("sha1")
    .update([token, timestamp, nonce, ...(encrypted ? [encrypted] : [])].sort().join(""))
    .digest("hex");
}

describe("CORE-001-D WeChat callback protocol", () => {
  it("verifies URL challenges and encrypted POST messages", async () => {
    const timestamp = "1788048001";
    const nonce = "nonce-1";
    const echo = "verified-echo";
    await expect(verifyWechatPlainChallenge({
      signature: signature(timestamp, nonce),
      msgSignature: "",
      timestamp,
      nonce,
    }, echo, token)).resolves.toBeUndefined();

    const xml = `<xml><ToUserName>gh-test</ToUserName><FromUserName>openid-test</FromUserName><CreateTime>1788048000</CreateTime><MsgType>event</MsgType><Event>subscribe</Event></xml>`;
    const encrypted = encryptedMessage(xml);
    await expect(verifyWechatEncryptedSignature({
      signature: "",
      msgSignature: signature(timestamp, nonce, encrypted),
      timestamp,
      nonce,
    }, encrypted, token)).resolves.toBeUndefined();
    expect(decryptWechatCallback(encrypted, aesKey, appId)).toBe(xml);
    expect(() => decryptWechatCallback(encrypted, aesKey, "another-app"))
      .toThrow("wechat_callback_app_id_mismatch");
  });

  it("encrypts passive replies with 32-byte protocol padding", async () => {
    const reply = "<xml><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[ok]]></Content></xml>";
    const outer = await encryptWechatReply(reply, token, aesKey, appId, "1788048002", "nonce-2");
    const encrypted = wechatEncryptedXmlValue(outer);
    expect(decryptWechatCallback(encrypted, aesKey, appId)).toBe(reply);
    expect(outer).toContain("<MsgSignature>");
  });

  it("allowlists normalized fields without persisting user message text", async () => {
    const xml = "<xml><ToUserName>gh-test</ToUserName><FromUserName>openid-test</FromUserName><CreateTime>1788048000</CreateTime><MsgType>text</MsgType><MsgId>9988</MsgId><Content><![CDATA[must-not-persist]]></Content></xml>";
    const normalized = await normalizeWechatCallback(xml, "official", appId);
    expect(normalized.replyLookupKey).toBe("must-not-persist");
    expect(normalized.payload.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(normalized.payload)).not.toContain("must-not-persist");
    expect(normalized.subjectKey).toContain("message:official:");
  });

  it("normalizes payment and settlement evidence and rejects unsafe XML", async () => {
    const payment = await normalizeWechatCallback(
      `<xml><ToUserName>gh-test</ToUserName><FromUserName>openid-test</FromUserName><CreateTime>1788048000</CreateTime><MsgType>event</MsgType><Event>funds_order_pay</Event><order_info><![CDATA[{"trade_no":"wx12345","transaction_id":"tx12345"}]]></order_info></xml>`,
      "official",
      appId,
    );
    expect(payment.payload).toMatchObject({ orderNo: "wx12345", transactionId: "tx12345" });
    expect(payment.subjectKey).toBe("payment:wx12345");

    await expect(normalizeWechatCallback(
      "<!DOCTYPE xml><xml><ToUserName>x</ToUserName></xml>",
      "official",
      appId,
    )).rejects.toThrow("wechat_callback_xml_invalid");
  });
});

describe("CORE-001-D durable callback pipeline", () => {
  const body = {
    action: "processWechatCallbackOutbox" as const,
    outboxId: 7,
    eventId: 11,
    replayKey: "00000000-0000-4000-8000-000000000001",
  };

  it("accepts only opaque Queue contracts and makes them replayable from DLQ", () => {
    expect(isWechatCallbackOutboxMessage(body)).toBe(true);
    expect(isWechatCallbackOutboxMessage({ ...body, openid: "secret" })).toBe(false);
    expect(isWechatCallbackOutboxMessage({ ...body, replayKey: "bad" })).toBe(false);
    const dispatch = { action: "dispatchWechatCallbackOutbox" as const, scheduledAt: 1788048000 };
    expect(isWechatCallbackDispatchMessage(dispatch)).toBe(true);
    expect(isWechatCallbackDispatchMessage({ ...dispatch, cursor: 1 })).toBe(false);
    expect(prepareOrderQueueDeadLetter(body)).toMatchObject({
      messageType: body.action,
      replayPolicy: "ALLOW",
      replayMessage: body,
    });
  });

  it("acks terminal outcomes and retries leases, deferrals and failures", async () => {
    for (const result of ["completed", "already-completed", "dead"] as const) {
      const ack = vi.fn();
      const retry = vi.fn();
      await consumeWechatCallbackMessage(
        { body, attempts: 1, ack, retry },
        { processMessage: vi.fn().mockResolvedValue(result) },
      );
      expect(ack).toHaveBeenCalledOnce();
      expect(retry).not.toHaveBeenCalled();
    }
    const retryBusy = vi.fn();
    await consumeWechatCallbackMessage(
      { body, attempts: 1, ack: vi.fn(), retry: retryBusy },
      { processMessage: vi.fn().mockResolvedValue("busy") },
    );
    expect(retryBusy).toHaveBeenCalledWith({ delaySeconds: 30 });
    const retryDeferred = vi.fn();
    await consumeWechatCallbackMessage(
      { body, attempts: 1, ack: vi.fn(), retry: retryDeferred },
      { processMessage: vi.fn().mockResolvedValue({ kind: "deferred", delaySeconds: 77 }) },
    );
    expect(retryDeferred).toHaveBeenCalledWith({ delaySeconds: 77 });
  });

  it("keeps external and embedded fail-closed DDL byte-for-byte identical", () => {
    const external = readFileSync("migrations/0122_wechat_callback_pipeline.sql", "utf8");
    expect(new MigrationService({} as never).wechatCallbackPipelineMigrationSqlForVerification())
      .toBe(external);
    expect(external.match(/^CREATE TABLE IF NOT EXISTS/gm)).toHaveLength(3);
    expect(external).toContain("ON DELETE RESTRICT");
    expect(external).toContain('WHERE "status" IN (\'PENDING\', \'FAILED\')');
    expect(external).not.toContain("FOR EACH");
    expect(external).not.toMatch(/^\s*(?:DROP|TRUNCATE|DELETE|UPDATE|INSERT)\b/im);
  });

  it("wires both compatibility routes, Queue recovery and the shared payment ledger", () => {
    const routes = readFileSync("src/routes/v1/index.ts", "utf8");
    const controller = readFileSync("src/controllers/api/v1/WechatController.ts", "utf8");
    const service = readFileSync("src/services/wechat/WechatCallbackService.ts", "utf8");
    const entry = readFileSync("src/index.ts", "utf8");
    expect(routes).toContain('v1Routes.all("/wechat/serve"');
    expect(routes).toContain('v1Routes.all("/wechat/miniServe"');
    expect(controller).toContain("receiveEncrypted");
    expect(controller).toContain("callback rejected");
    expect(service).toContain('.for("update", { skipLocked: true })');
    expect(service).toContain("new PaymentCallbackEventService");
    expect(service).toContain("completeOrderReceipt");
    expect(entry).toContain('action: "dispatchWechatCallbackOutbox"');
  });

  it("keeps the production-engine audit gated, isolated and bound to the exact Hyperdrive", () => {
    const worker = readFileSync("test/integration/WechatCallbackPipelineAuditWorker.ts", "utf8");
    const config = readFileSync(
      "test/integration/wechat-callback-pipeline-audit.wrangler.jsonc",
      "utf8",
    );
    expect(config).toContain('"id": "9748c294e21c49a99579c9cef70102e0"');
    expect(worker).toContain("AUDIT_READ_TOKEN_SHA256");
    expect(worker).toContain("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
    expect(worker).toContain("DROP SCHEMA IF EXISTS");
    expect(worker).toContain("temporary_schema_removed");
    expect(worker).toContain("follow_out_of_order_does_not_regress");
    expect(worker).toContain("payment_enters_shared_ledger");
    expect(worker).toContain("listener_failure_is_not_acknowledged_and_exhausts");
  });
});
