import { readFileSync } from "node:fs";
import { createCipheriv, createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  decryptCallbackCipher,
  encryptedXmlValue,
  normalizeDecryptedCallback,
  verifyCallbackSignature,
} from "../src/services/work/EnterpriseWechatCallbackCrypto";
import {
  isWorkCallbackDispatchMessage,
  isWorkCallbackOutboxMessage,
} from "../src/services/work/EnterpriseWechatCallbackService";

const key = Buffer.from(Array.from({ length: 32 }, (_, index) => index + 1));
const encodingAesKey = key.toString("base64").slice(0, -1);
const corpId = "ww-callback-test";
const token = "callback-token";

function encryptedMessage(message: string, receiveId = corpId): string {
  const messageBytes = Buffer.from(message);
  const receiveBytes = Buffer.from(receiveId);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(messageBytes.byteLength);
  const plain = Buffer.concat([Buffer.alloc(16, 7), length, messageBytes, receiveBytes]);
  const padding = 32 - (plain.byteLength % 32);
  const padded = Buffer.concat([plain, Buffer.alloc(padding, padding)]);
  const cipher = createCipheriv("aes-256-cbc", key, key.subarray(0, 16));
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(padded), cipher.final()]).toString("base64");
}

function signature(timestamp: string, nonce: string, encrypted: string): string {
  return createHash("sha1")
    .update([token, timestamp, nonce, encrypted].sort().join(""))
    .digest("hex");
}

describe("Enterprise WeChat callback protocol", () => {
  it("verifies SHA-1 and decrypts protocol padding up to 32 bytes", async () => {
    const xml = `<xml><ToUserName><![CDATA[${corpId}]]></ToUserName><FromUserName><![CDATA[sys]]></FromUserName><CreateTime>1788048000</CreateTime><MsgType><![CDATA[event]]></MsgType><Event><![CDATA[change_external_chat]]></Event><ChangeType><![CDATA[update]]></ChangeType><ChatId><![CDATA[wr-chat-1]]></ChatId><UpdateDetail><![CDATA[add_member]]></UpdateDetail></xml>`;
    const encrypted = encryptedMessage(xml);
    const query = { timestamp: "1788048001", nonce: "nonce-1", signature: "" };
    query.signature = signature(query.timestamp, query.nonce, encrypted);
    await expect(verifyCallbackSignature(query, encrypted, token)).resolves.toBeUndefined();
    expect(decryptCallbackCipher(encrypted, encodingAesKey, corpId)).toBe(xml);

    const normalized = normalizeDecryptedCallback(xml, corpId);
    expect(normalized).toMatchObject({
      corpId,
      msgType: "event",
      eventType: "change_external_chat",
      changeType: "update",
      eventTime: 1788048000,
      subjectKey: "external-chat:wr-chat-1",
      sequenceRank: 50,
      recognized: true,
    });
  });

  it("rejects forged signatures and receive-id confusion", async () => {
    const encrypted = encryptedMessage("<xml><MsgType>event</MsgType></xml>");
    await expect(verifyCallbackSignature({
      timestamp: "1788048001",
      nonce: "nonce-2",
      signature: "0".repeat(40),
    }, encrypted, token)).rejects.toThrow("callback_signature_invalid");
    expect(() => decryptCallbackCipher(encrypted, encodingAesKey, "another-corp"))
      .toThrow("callback_receive_id_mismatch");
  });

  it("stores only allowlisted fields and keeps external tag ids as strings", () => {
    const xml = `<xml><ToUserName>${corpId}</ToUserName><FromUserName>sys</FromUserName><CreateTime>1788048000</CreateTime><MsgType>event</MsgType><Event>change_external_tag</Event><ChangeType>delete</ChangeType><Id><![CDATA[etXXXXXXXXXXXX]]></Id><TagType>tag</TagType><Content>must-not-persist</Content></xml>`;
    const normalized = normalizeDecryptedCallback(xml, corpId);
    expect(normalized.subjectKey).toBe("external-tag:tag:etXXXXXXXXXXXX");
    expect(normalized.sequenceRank).toBe(100);
    expect(normalized.payload.Id).toBe("etXXXXXXXXXXXX");
    expect(normalized.payload).not.toHaveProperty("Content");
  });

  it("rejects XML entities/DOCTYPE and malformed wrappers", () => {
    expect(() => encryptedXmlValue("<!DOCTYPE xml><xml><Encrypt>x</Encrypt></xml>"))
      .toThrow("callback_xml_invalid");
    expect(() => encryptedXmlValue("<xml><Encrypt>&unknown;</Encrypt></xml>"))
      .toThrow("callback_xml_invalid");
    expect(() => encryptedXmlValue("<Encrypt>x</Encrypt>"))
      .toThrow("callback_xml_invalid");
  });
});

describe("Enterprise WeChat callback durable pipeline", () => {
  it("accepts only opaque callback queue messages", () => {
    const valid = {
      action: "processWorkCallbackOutbox",
      outboxId: 7,
      eventId: 11,
      eventKey: "a".repeat(64),
    };
    expect(isWorkCallbackOutboxMessage(valid)).toBe(true);
    expect(isWorkCallbackOutboxMessage({ ...valid, corpId })).toBe(false);
    expect(isWorkCallbackOutboxMessage({ ...valid, eventKey: "external-user-id" })).toBe(false);
    expect(isWorkCallbackOutboxMessage({ ...valid, eventId: 0 })).toBe(false);
  });

  it("accepts only the exact scheduled dispatch message shape", () => {
    const valid = {
      action: "dispatchWorkCallbackOutbox",
      scheduledAt: 1788048000,
    };
    expect(isWorkCallbackDispatchMessage(valid)).toBe(true);
    expect(isWorkCallbackDispatchMessage({ ...valid, eventKey: "a".repeat(64) })).toBe(false);
    expect(isWorkCallbackDispatchMessage({ ...valid, scheduledAt: 0 })).toBe(false);
    expect(isWorkCallbackDispatchMessage({ action: "processWorkCallbackOutbox", scheduledAt: 1788048000 })).toBe(false);
  });

  it("does not classify legacy empty-handler event variants as restored", () => {
    const variants = [
      ["change_contact", "update_tag", "<Id>1</Id>"],
      ["change_external_contact", "add_half_external_contact", "<ExternalUserID>wo-half</ExternalUserID>"],
      ["change_external_contact", "transfer_fail", "<ExternalUserID>wo-transfer</ExternalUserID>"],
      ["change_external_tag", "shuffle", "<TagType>tag</TagType><Id>et-tag</Id>"],
      ["batch_job_result", "", "<JobType>sync_user</JobType><JobId>job-1</JobId>"],
    ];
    for (const [event, change, fields] of variants) {
      const xml = `<xml><ToUserName>${corpId}</ToUserName><CreateTime>1788048000</CreateTime><MsgType>event</MsgType><Event>${event}</Event><ChangeType>${change}</ChangeType>${fields}</xml>`;
      expect(normalizeDecryptedCallback(xml, corpId).recognized).toBe(false);
    }
  });

  it("keeps external and embedded migration SQL identical", () => {
    const external = readFileSync("migrations/0109_work_callback_pipeline.sql", "utf8").trim();
    const service = readFileSync("src/services/MigrationService.ts", "utf8");
    const embedded = service.match(
      /private migration_0115\(\): string \{\s*return `([\s\S]*?)`;\s*\}/,
    )?.[1]?.trim();
    expect(embedded).toBe(external);
    expect(service).toContain("this.migration_0115()");
  });

  it("does not make provider calls in the HTTP callback controller", () => {
    const controller = readFileSync("src/controllers/api/v1/EnterpriseWechatController.ts", "utf8");
    const receive = controller.slice(
      controller.indexOf("export async function callbackReceive"),
      controller.indexOf("/** GET /api/work/config"),
    );
    expect(receive).not.toMatch(/qyapi\.weixin\.qq\.com|fetch\s*\(/);
    expect(receive).toContain("dispatchById(received.outboxId)");
    expect(receive).not.toContain("received.eventKey");
  });

  it("maps CorpID storage failures separately from secret configuration failures", () => {
    const service = readFileSync("src/services/work/EnterpriseWechatCallbackService.ts", "utf8");
    const configMethod = service.slice(
      service.indexOf("private async config()"),
      service.indexOf("private protocolError"),
    );
    expect(configMethod).toContain('EnterpriseWechatCallbackError(errorCode(error), "storage")');
    expect(configMethod).toContain('EnterpriseWechatCallbackError("callback_corp_id_unconfigured", "configuration")');
  });
});
