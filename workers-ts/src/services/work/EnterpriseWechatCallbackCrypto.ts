import { createDecipheriv } from "node:crypto";
import type { WorkCallbackPayload } from "@/models/schema";

const encoder = new TextEncoder();
const fatalDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
const MAX_XML_BYTES = 64 * 1024;
const MAX_FIELD_BYTES = 2 * 1024;

const STORED_FIELDS = [
  "ToUserName",
  "FromUserName",
  "CreateTime",
  "MsgType",
  "MsgId",
  "AgentID",
  "Event",
  "ChangeType",
  "UserID",
  "NewUserID",
  "ExternalUserID",
  "ChatId",
  "Id",
  "TagType",
  "UpdateDetail",
  "JoinScene",
  "QuitScene",
  "MemChangeCnt",
  "State",
  "WelcomeCode",
  "JobType",
  "JobId",
] as const;

const INTEGER_FIELDS = new Set<string>([
  "CreateTime",
  "AgentID",
  "JoinScene",
  "QuitScene",
  "MemChangeCnt",
]);

export interface CallbackQuery {
  signature: string;
  timestamp: string;
  nonce: string;
}

export interface NormalizedWorkCallback {
  payload: WorkCallbackPayload;
  corpId: string;
  msgType: string;
  eventType: string;
  changeType: string;
  eventTime: number;
  sequenceRank: number;
  subjectKey: string;
  recognized: boolean;
}

function byteLength(value: string): number {
  return encoder.encode(value).byteLength;
}

function decodeBase64(value: string): Uint8Array {
  let decoded: string;
  try {
    decoded = atob(value);
  } catch {
    throw new Error("callback_cipher_invalid");
  }
  return Uint8Array.from(decoded, (char) => char.charCodeAt(0));
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  let mismatch = leftBytes.byteLength ^ rightBytes.byteLength;
  const max = Math.max(leftBytes.byteLength, rightBytes.byteLength);
  for (let index = 0; index < max; index += 1) {
    mismatch |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return mismatch === 0;
}

export async function shaHex(
  algorithm: "SHA-1" | "SHA-256",
  value: string,
): Promise<string> {
  const digest = await crypto.subtle.digest(algorithm, encoder.encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function validateCallbackSecret(token: string, encodingAesKey: string): void {
  if (!token || token.length > 512 || /[\u0000-\u001f\u007f]/.test(token)) {
    throw new Error("callback_token_invalid");
  }
  if (!/^[A-Za-z0-9]{43}$/.test(encodingAesKey)) {
    throw new Error("callback_aes_key_invalid");
  }
  if (decodeBase64(`${encodingAesKey}=`).byteLength !== 32) {
    throw new Error("callback_aes_key_invalid");
  }
}

export function validateCallbackQuery(query: CallbackQuery): void {
  if (!/^[0-9a-f]{40}$/i.test(query.signature)) throw new Error("callback_signature_invalid");
  if (!/^\d{1,16}$/.test(query.timestamp)) throw new Error("callback_timestamp_invalid");
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(query.nonce)) throw new Error("callback_nonce_invalid");
}

export async function verifyCallbackSignature(
  query: CallbackQuery,
  encrypted: string,
  token: string,
): Promise<void> {
  validateCallbackQuery(query);
  if (!encrypted || encrypted.length > MAX_XML_BYTES || /\s/.test(encrypted)) {
    throw new Error("callback_cipher_invalid");
  }
  const expected = await shaHex(
    "SHA-1",
    [token, query.timestamp, query.nonce, encrypted].sort().join(""),
  );
  if (!constantTimeEqual(expected, query.signature.toLowerCase())) {
    throw new Error("callback_signature_invalid");
  }
}

/** AES-256-CBC with the protocol's non-standard PKCS#7 block size of 32. */
export function decryptCallbackCipher(
  encrypted: string,
  encodingAesKey: string,
  expectedReceiveId: string,
): string {
  const key = decodeBase64(`${encodingAesKey}=`);
  const cipher = decodeBase64(encrypted);
  if (cipher.byteLength === 0 || cipher.byteLength % 16 !== 0) {
    throw new Error("callback_cipher_invalid");
  }

  let decrypted: Uint8Array;
  try {
    const decipher = createDecipheriv("aes-256-cbc", key, key.subarray(0, 16));
    decipher.setAutoPadding(false);
    const first = decipher.update(cipher);
    const last = decipher.final();
    decrypted = new Uint8Array(first.byteLength + last.byteLength);
    decrypted.set(first, 0);
    decrypted.set(last, first.byteLength);
  } catch {
    throw new Error("callback_cipher_invalid");
  }

  const padding = decrypted.at(-1) ?? 0;
  if (padding < 1 || padding > 32 || padding > decrypted.byteLength) {
    throw new Error("callback_padding_invalid");
  }
  for (let index = decrypted.byteLength - padding; index < decrypted.byteLength; index += 1) {
    if (decrypted[index] !== padding) throw new Error("callback_padding_invalid");
  }
  const plain = decrypted.subarray(0, decrypted.byteLength - padding);
  if (plain.byteLength < 20) throw new Error("callback_plaintext_invalid");
  const view = new DataView(plain.buffer, plain.byteOffset, plain.byteLength);
  const messageLength = view.getUint32(16, false);
  if (messageLength > MAX_XML_BYTES || 20 + messageLength > plain.byteLength) {
    throw new Error("callback_plaintext_invalid");
  }

  let message: string;
  let receiveId: string;
  try {
    message = fatalDecoder.decode(plain.subarray(20, 20 + messageLength));
    receiveId = fatalDecoder.decode(plain.subarray(20 + messageLength));
  } catch {
    throw new Error("callback_plaintext_invalid");
  }
  if (!constantTimeEqual(receiveId, expectedReceiveId)) {
    throw new Error("callback_receive_id_mismatch");
  }
  return message;
}

function decodeXmlEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_full, entity: string) => {
    const normalized = entity.toLowerCase();
    if (normalized === "amp") return "&";
    if (normalized === "lt") return "<";
    if (normalized === "gt") return ">";
    if (normalized === "quot") return '"';
    if (normalized === "apos") return "'";
    const codePoint = normalized.startsWith("#x")
      ? Number.parseInt(normalized.slice(2), 16)
      : Number.parseInt(normalized.slice(1), 10);
    if (!Number.isSafeInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) {
      throw new Error("callback_xml_invalid");
    }
    return String.fromCodePoint(codePoint);
  }).replace(/&[A-Za-z#][A-Za-z0-9#]*;/g, () => {
    throw new Error("callback_xml_invalid");
  });
}

export function xmlText(xml: string, tag: string): string | null {
  if (
    byteLength(xml) > MAX_XML_BYTES
    || /<!DOCTYPE|<!ENTITY|<\?xml-stylesheet/i.test(xml)
    || !/^<xml(?:\s[^>]*)?>[\s\S]*<\/xml>\s*$/.test(xml.trim())
  ) throw new Error("callback_xml_invalid");
  const match = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`));
  if (!match) return null;
  const raw = match[1].trim();
  const cdata = raw.match(/^<!\[CDATA\[([\s\S]*)\]\]>$/);
  const value = cdata ? cdata[1] : decodeXmlEntities(raw);
  if (byteLength(value) > MAX_FIELD_BYTES || /[\u0000]/.test(value)) {
    throw new Error("callback_xml_invalid");
  }
  return value;
}

export function encryptedXmlValue(xml: string): string {
  const value = xmlText(xml, "Encrypt");
  if (!value) throw new Error("callback_xml_invalid");
  return value;
}

function storedPayload(xml: string): WorkCallbackPayload {
  const payload: WorkCallbackPayload = {};
  for (const field of STORED_FIELDS) {
    const value = xmlText(xml, field);
    if (value === null || value === "") continue;
    if (INTEGER_FIELDS.has(field)) {
      if (!/^\d{1,10}$/.test(value)) throw new Error("callback_field_invalid");
      const parsed = Number(value);
      if (!Number.isSafeInteger(parsed) || parsed > 2_147_483_647) {
        throw new Error("callback_field_invalid");
      }
      payload[field] = parsed;
    } else {
      payload[field] = value;
    }
  }
  return payload;
}

function stringField(payload: WorkCallbackPayload, field: string): string {
  return typeof payload[field] === "string" ? payload[field] as string : "";
}

function numberField(payload: WorkCallbackPayload, field: string): number {
  return typeof payload[field] === "number" ? payload[field] as number : 0;
}

function identifierField(payload: WorkCallbackPayload, field: string, maximumBytes = 64): string {
  const value = stringField(payload, field);
  return value
    && byteLength(value) <= maximumBytes
    && !/[\u0000-\u001f\u007f]/.test(value)
    ? value
    : "";
}

function normalizedSubject(payload: WorkCallbackPayload): {
  subject: string;
  recognized: boolean;
  sequenceRank: number;
} {
  const msgType = stringField(payload, "MsgType").toLowerCase();
  const event = stringField(payload, "Event").toLowerCase();
  const change = stringField(payload, "ChangeType").toLowerCase();
  const destructive = new Set(["delete_user", "delete_party", "delete", "dismiss", "del_external_contact", "del_follow_user"]);
  const sequenceRank = destructive.has(change) ? 100 : change.includes("update") || change.includes("edit") ? 50 : 10;
  if (msgType !== "event") {
    return { subject: `message:${msgType}:${stringField(payload, "MsgId") || numberField(payload, "CreateTime")}`, recognized: false, sequenceRank: 0 };
  }
  if (event === "change_contact") {
    if (change.endsWith("_user")) {
      const userId = stringField(payload, "UserID");
      return { subject: userId ? `member:${userId}` : "", recognized: true, sequenceRank };
    }
    if (change.endsWith("_party")) {
      const departmentId = stringField(payload, "Id");
      if (!/^\d{1,10}$/.test(departmentId)) {
        return { subject: "", recognized: true, sequenceRank };
      }
      return { subject: `department:${departmentId}`, recognized: true, sequenceRank };
    }
  }
  if (event === "change_external_contact") {
    const externalUserId = identifierField(payload, "ExternalUserID");
    const userid = identifierField(payload, "UserID");
    const recognized = [
      "add_external_contact",
      "edit_external_contact",
      "del_external_contact",
      "del_follow_user",
    ].includes(change);
    let subject = "";
    if (recognized && externalUserId && userid) {
      subject = `external-contact:${externalUserId}:follow:${userid}`;
    } else if (!recognized && externalUserId) {
      subject = `external-contact:${externalUserId}`;
    }
    return {
      subject,
      recognized,
      sequenceRank,
    };
  }
  if (event === "change_external_chat") {
    const chatId = stringField(payload, "ChatId");
    return {
      subject: chatId ? `external-chat:${chatId}` : "",
      recognized: ["create", "update", "dismiss"].includes(change),
      sequenceRank,
    };
  }
  if (event === "change_external_tag") {
    const tagType = stringField(payload, "TagType");
    const id = stringField(payload, "Id");
    return {
      subject: tagType && id ? `external-tag:${tagType}:${id}` : "",
      recognized: ["create", "update", "delete"].includes(change),
      sequenceRank,
    };
  }
  if (event === "batch_job_result") {
    const jobType = stringField(payload, "JobType");
    const jobId = stringField(payload, "JobId");
    return {
      subject: jobType && jobId
        ? `batch:${jobType}:${jobId}`
        : `batch:${jobType}:${numberField(payload, "CreateTime")}`,
      recognized: false,
      sequenceRank: 10,
    };
  }
  return { subject: `event:${event}:${change}:${numberField(payload, "CreateTime")}`, recognized: false, sequenceRank: 0 };
}

export function normalizeDecryptedCallback(xml: string, expectedCorpId: string): NormalizedWorkCallback {
  const payload = storedPayload(xml);
  const corpId = stringField(payload, "ToUserName");
  const eventTime = numberField(payload, "CreateTime");
  const msgType = stringField(payload, "MsgType").toLowerCase();
  const eventType = stringField(payload, "Event").toLowerCase();
  const changeType = stringField(payload, "ChangeType").toLowerCase();
  if (corpId !== expectedCorpId) throw new Error("callback_corp_mismatch");
  if (!msgType || eventTime <= 0) throw new Error("callback_field_invalid");
  const normalized = normalizedSubject(payload);
  if (!normalized.subject) {
    throw new Error("callback_field_invalid");
  }
  return {
    payload,
    corpId,
    msgType,
    eventType,
    changeType,
    eventTime,
    sequenceRank: normalized.sequenceRank,
    subjectKey: normalized.subject,
    recognized: normalized.recognized,
  };
}
