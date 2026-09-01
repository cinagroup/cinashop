import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export type WechatCallbackSource = "official" | "mini";

const encoder = new TextEncoder();
const fatalDecoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
export const MAX_WECHAT_CALLBACK_BYTES = 64 * 1024;
const MAX_XML_FIELD_BYTES = 4 * 1024;

export interface WechatCallbackQuery {
  signature: string;
  msgSignature: string;
  timestamp: string;
  nonce: string;
}

export interface WechatCallbackPayload {
  toUser: string;
  fromUser: string;
  msgId?: string;
  eventKey?: string;
  ticket?: string;
  cardId?: string;
  cardCode?: string;
  outerId?: number;
  orderNo?: string;
  transactionId?: string;
  confirmReceiveMethod?: string;
  contentHash?: string;
}

export interface NormalizedWechatCallback {
  source: WechatCallbackSource;
  appId: string;
  msgType: string;
  eventType: string;
  eventTime: number;
  sequenceRank: number;
  subjectKey: string;
  recognized: boolean;
  payload: WechatCallbackPayload;
  /** Used only to select a synchronous reply; never persisted. */
  replyLookupKey: string;
}

function byteLength(value: string): number {
  return encoder.encode(value).byteLength;
}

function decodeBase64(value: string): Uint8Array {
  try {
    return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
  } catch {
    throw new Error("wechat_callback_cipher_invalid");
  }
}

function constantTimeEqual(left: string, right: string): boolean {
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  let mismatch = a.byteLength ^ b.byteLength;
  const maximum = Math.max(a.byteLength, b.byteLength);
  for (let index = 0; index < maximum; index += 1) {
    mismatch |= (a[index] ?? 0) ^ (b[index] ?? 0);
  }
  return mismatch === 0;
}

export async function wechatCallbackSha(
  algorithm: "SHA-1" | "SHA-256",
  value: string,
): Promise<string> {
  const digest = await crypto.subtle.digest(algorithm, encoder.encode(value));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function validateWechatCallbackSecret(token: string, encodingAesKey: string): void {
  if (!token || token.length > 512 || /[\u0000-\u001f\u007f]/.test(token)) {
    throw new Error("wechat_callback_token_invalid");
  }
  if (!/^[A-Za-z0-9]{43}$/.test(encodingAesKey)) {
    throw new Error("wechat_callback_aes_key_invalid");
  }
  if (decodeBase64(`${encodingAesKey}=`).byteLength !== 32) {
    throw new Error("wechat_callback_aes_key_invalid");
  }
}

export function validateWechatCallbackQuery(query: WechatCallbackQuery): void {
  if (!/^\d{1,16}$/.test(query.timestamp)) {
    throw new Error("wechat_callback_timestamp_invalid");
  }
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(query.nonce)) {
    throw new Error("wechat_callback_nonce_invalid");
  }
}

export async function verifyWechatEncryptedSignature(
  query: WechatCallbackQuery,
  encrypted: string,
  token: string,
): Promise<void> {
  validateWechatCallbackQuery(query);
  if (!/^[0-9a-f]{40}$/i.test(query.msgSignature)) {
    throw new Error("wechat_callback_signature_invalid");
  }
  if (!encrypted || encrypted.length > MAX_WECHAT_CALLBACK_BYTES || /\s/.test(encrypted)) {
    throw new Error("wechat_callback_cipher_invalid");
  }
  const expected = await wechatCallbackSha(
    "SHA-1",
    [token, query.timestamp, query.nonce, encrypted].sort().join(""),
  );
  if (!constantTimeEqual(expected, query.msgSignature.toLowerCase())) {
    throw new Error("wechat_callback_signature_invalid");
  }
}

export async function verifyWechatPlainChallenge(
  query: WechatCallbackQuery,
  echo: string,
  token: string,
): Promise<void> {
  validateWechatCallbackQuery(query);
  if (!/^[0-9a-f]{40}$/i.test(query.signature)) {
    throw new Error("wechat_callback_signature_invalid");
  }
  if (!echo || byteLength(echo) > 512 || /[\u0000-\u001f\u007f]/.test(echo)) {
    throw new Error("wechat_callback_echo_invalid");
  }
  const expected = await wechatCallbackSha(
    "SHA-1",
    [token, query.timestamp, query.nonce].sort().join(""),
  );
  if (!constantTimeEqual(expected, query.signature.toLowerCase())) {
    throw new Error("wechat_callback_signature_invalid");
  }
}

/** AES-256-CBC with the WeChat protocol's 32-byte PKCS#7 block. */
export function decryptWechatCallback(
  encrypted: string,
  encodingAesKey: string,
  expectedAppId: string,
): string {
  const key = decodeBase64(`${encodingAesKey}=`);
  const cipher = decodeBase64(encrypted);
  if (cipher.byteLength === 0 || cipher.byteLength % 16 !== 0) {
    throw new Error("wechat_callback_cipher_invalid");
  }
  let decrypted: Uint8Array;
  try {
    const decipher = createDecipheriv("aes-256-cbc", key, key.subarray(0, 16));
    decipher.setAutoPadding(false);
    const head = decipher.update(cipher);
    const tail = decipher.final();
    decrypted = new Uint8Array(head.byteLength + tail.byteLength);
    decrypted.set(head, 0);
    decrypted.set(tail, head.byteLength);
  } catch {
    throw new Error("wechat_callback_cipher_invalid");
  }
  const padding = decrypted.at(-1) ?? 0;
  if (padding < 1 || padding > 32 || padding > decrypted.byteLength) {
    throw new Error("wechat_callback_padding_invalid");
  }
  for (let index = decrypted.byteLength - padding; index < decrypted.byteLength; index += 1) {
    if (decrypted[index] !== padding) throw new Error("wechat_callback_padding_invalid");
  }
  const plaintext = decrypted.subarray(0, decrypted.byteLength - padding);
  if (plaintext.byteLength < 20) throw new Error("wechat_callback_plaintext_invalid");
  const view = new DataView(plaintext.buffer, plaintext.byteOffset, plaintext.byteLength);
  const messageLength = view.getUint32(16, false);
  if (messageLength > MAX_WECHAT_CALLBACK_BYTES || 20 + messageLength > plaintext.byteLength) {
    throw new Error("wechat_callback_plaintext_invalid");
  }
  let message: string;
  let appId: string;
  try {
    message = fatalDecoder.decode(plaintext.subarray(20, 20 + messageLength));
    appId = fatalDecoder.decode(plaintext.subarray(20 + messageLength));
  } catch {
    throw new Error("wechat_callback_plaintext_invalid");
  }
  if (!constantTimeEqual(appId, expectedAppId)) {
    throw new Error("wechat_callback_app_id_mismatch");
  }
  return message;
}

function xmlEntities(value: string): string {
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
      throw new Error("wechat_callback_xml_invalid");
    }
    return String.fromCodePoint(codePoint);
  }).replace(/&[A-Za-z#][A-Za-z0-9#]*;/g, () => {
    throw new Error("wechat_callback_xml_invalid");
  });
}

export function wechatXmlText(xml: string, tag: string): string | null {
  if (
    byteLength(xml) > MAX_WECHAT_CALLBACK_BYTES
    || /<!DOCTYPE|<!ENTITY|<\?xml-stylesheet/i.test(xml)
    || !/^<xml(?:\s[^>]*)?>[\s\S]*<\/xml>\s*$/.test(xml.trim())
  ) throw new Error("wechat_callback_xml_invalid");
  const escapedTag = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = xml.match(new RegExp(`<${escapedTag}>([\\s\\S]*?)<\\/${escapedTag}>`, "i"));
  if (!match) return null;
  const raw = match[1].trim();
  const cdata = raw.match(/^<!\[CDATA\[([\s\S]*)\]\]>$/);
  const value = cdata ? cdata[1] : xmlEntities(raw);
  if (byteLength(value) > MAX_XML_FIELD_BYTES || /\u0000/.test(value)) {
    throw new Error("wechat_callback_field_invalid");
  }
  return value;
}

export function wechatEncryptedXmlValue(xml: string): string {
  const value = wechatXmlText(xml, "Encrypt");
  if (!value) throw new Error("wechat_callback_xml_invalid");
  return value;
}

function boundedIdentifier(value: string | null, maximum: number): string {
  if (!value || byteLength(value) > maximum || /[\u0000-\u001f\u007f]/.test(value)) return "";
  return value;
}

function positiveInteger(value: string | null, maximum = 2_147_483_647): number {
  if (!value || !/^\d{1,10}$/.test(value)) return 0;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= maximum ? parsed : 0;
}

function normalizedOrderInfo(xml: string): { orderNo: string; transactionId: string } {
  const raw = wechatXmlText(xml, "order_info") ?? wechatXmlText(xml, "OrderInfo") ?? "";
  let record: Record<string, unknown> = {};
  if (raw.startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        record = parsed as Record<string, unknown>;
      }
    } catch {
      throw new Error("wechat_callback_order_info_invalid");
    }
  }
  const orderNo = boundedIdentifier(
    String(record.trade_no ?? record.out_trade_no ?? wechatXmlText(xml, "trade_no") ?? ""),
    64,
  );
  const transactionId = boundedIdentifier(
    String(record.transaction_id ?? wechatXmlText(xml, "transaction_id") ?? ""),
    100,
  );
  return { orderNo, transactionId };
}

function recognizedSubject(
  source: WechatCallbackSource,
  msgType: string,
  eventType: string,
  payload: WechatCallbackPayload,
): { recognized: boolean; subjectKey: string; sequenceRank: number } {
  if (msgType !== "event") {
    return {
      recognized: source === "official" && ["text", "image", "voice", "video", "location", "link"].includes(msgType),
      subjectKey: `message:${source}:${payload.fromUser}:${payload.msgId ?? payload.contentHash ?? "unknown"}`,
      sequenceRank: 0,
    };
  }
  if (eventType === "subscribe" || eventType === "unsubscribe") {
    return {
      recognized: source === "official",
      subjectKey: `follow:${payload.fromUser}`,
      sequenceRank: eventType === "unsubscribe" ? 100 : 10,
    };
  }
  if (eventType === "scan") {
    return { recognized: source === "official", subjectKey: `scan:${payload.ticket ?? payload.eventKey ?? ""}`, sequenceRank: 10 };
  }
  if (["user_get_card", "submit_membercard_user_info", "user_del_card"].includes(eventType)) {
    const ranks: Record<string, number> = {
      user_get_card: 10,
      submit_membercard_user_info: 50,
      user_del_card: 100,
    };
    return {
      recognized: source === "official",
      subjectKey: `card:${payload.fromUser}:${payload.cardId ?? ""}`,
      sequenceRank: ranks[eventType] ?? 0,
    };
  }
  if (eventType === "funds_order_pay") {
    return { recognized: true, subjectKey: `payment:${payload.orderNo ?? ""}`, sequenceRank: 100 };
  }
  if (eventType === "trade_manage_order_settlement") {
    return { recognized: true, subjectKey: `receipt:${payload.orderNo ?? ""}`, sequenceRank: 100 };
  }
  if (eventType === "click" || eventType === "view") {
    return { recognized: source === "official", subjectKey: `menu:${payload.fromUser}:${eventType}`, sequenceRank: 0 };
  }
  return {
    recognized: false,
    subjectKey: `event:${source}:${payload.fromUser}:${eventType}:${payload.msgId ?? ""}`,
    sequenceRank: 0,
  };
}

export async function normalizeWechatCallback(
  xml: string,
  source: WechatCallbackSource,
  expectedAppId: string,
): Promise<NormalizedWechatCallback> {
  const toUser = boundedIdentifier(wechatXmlText(xml, "ToUserName"), 128);
  const fromUser = boundedIdentifier(wechatXmlText(xml, "FromUserName"), 128);
  const msgType = boundedIdentifier(wechatXmlText(xml, "MsgType"), 32).toLowerCase();
  const eventType = boundedIdentifier(wechatXmlText(xml, "Event"), 64).toLowerCase();
  const eventTime = positiveInteger(wechatXmlText(xml, "CreateTime"));
  const msgId = boundedIdentifier(wechatXmlText(xml, "MsgId"), 64);
  const eventKey = boundedIdentifier(wechatXmlText(xml, "EventKey"), 256);
  const ticket = boundedIdentifier(wechatXmlText(xml, "Ticket"), 255);
  const cardId = boundedIdentifier(wechatXmlText(xml, "CardId"), 50);
  const cardCode = boundedIdentifier(wechatXmlText(xml, "UserCardCode"), 50);
  const content = wechatXmlText(xml, "Content") ?? "";
  const order = normalizedOrderInfo(xml);
  const merchantOrderNo = boundedIdentifier(
    wechatXmlText(xml, "merchant_trade_no") ?? wechatXmlText(xml, "MerchantTradeNo"),
    64,
  );
  const confirmReceiveMethod = boundedIdentifier(
    wechatXmlText(xml, "confirm_receive_method") ?? wechatXmlText(xml, "ConfirmReceiveMethod"),
    64,
  );
  const payload: WechatCallbackPayload = {
    toUser,
    fromUser,
    ...(msgId ? { msgId } : {}),
    ...(eventKey ? { eventKey } : {}),
    ...(ticket ? { ticket } : {}),
    ...(cardId ? { cardId } : {}),
    ...(cardCode ? { cardCode } : {}),
    ...(positiveInteger(wechatXmlText(xml, "OuterId"))
      ? { outerId: positiveInteger(wechatXmlText(xml, "OuterId")) }
      : {}),
    ...(order.orderNo || merchantOrderNo ? { orderNo: order.orderNo || merchantOrderNo } : {}),
    ...(order.transactionId ? { transactionId: order.transactionId } : {}),
    ...(confirmReceiveMethod ? { confirmReceiveMethod } : {}),
    ...(content ? { contentHash: await wechatCallbackSha("SHA-256", content) } : {}),
  };
  if (!expectedAppId || !toUser || !fromUser || !msgType || !eventTime) {
    throw new Error("wechat_callback_field_invalid");
  }
  const normalized = recognizedSubject(source, msgType, eventType, payload);
  if (!normalized.subjectKey || normalized.subjectKey.endsWith(":")) {
    throw new Error("wechat_callback_field_invalid");
  }
  if (normalized.recognized) {
    if (eventType === "funds_order_pay" && (!payload.orderNo || !payload.transactionId)) {
      throw new Error("wechat_callback_payment_evidence_invalid");
    }
    if (eventType === "trade_manage_order_settlement" && (!payload.orderNo || !payload.confirmReceiveMethod)) {
      throw new Error("wechat_callback_settlement_evidence_invalid");
    }
    if (["user_get_card", "submit_membercard_user_info", "user_del_card"].includes(eventType)
      && (!payload.cardId || (eventType !== "user_del_card" && !payload.cardCode))) {
      throw new Error("wechat_callback_card_evidence_invalid");
    }
  }
  const replyLookupKey = source !== "official"
    ? ""
    : msgType === "text"
      ? content.slice(0, 64)
      : eventType === "click"
        ? eventKey.slice(0, 64)
        : eventType === "subscribe" || eventType === "scan"
          ? "subscribe"
          : "";
  return {
    source,
    appId: expectedAppId,
    msgType,
    eventType,
    eventTime,
    sequenceRank: normalized.sequenceRank,
    subjectKey: normalized.subjectKey,
    recognized: normalized.recognized,
    payload,
    replyLookupKey,
  };
}

function xmlCdata(value: string): string {
  return `<![CDATA[${value.replaceAll("]]>", "]]]]><![CDATA[>")}]]>`;
}

export function buildWechatReplyXml(input: {
  toUser: string;
  fromUser: string;
  createTime: number;
  reply: Record<string, unknown>;
}): string {
  const type = String(input.reply.type ?? "none");
  if (type === "none") return "";
  const base = `<ToUserName>${xmlCdata(input.toUser)}</ToUserName><FromUserName>${xmlCdata(input.fromUser)}</FromUserName><CreateTime>${input.createTime}</CreateTime>`;
  if (type === "text") {
    return `<xml>${base}<MsgType><![CDATA[text]]></MsgType><Content>${xmlCdata(String(input.reply.content ?? ""))}</Content></xml>`;
  }
  if (type === "image" || type === "voice") {
    const tag = type === "image" ? "Image" : "Voice";
    return `<xml>${base}<MsgType><![CDATA[${type}]]></MsgType><${tag}><MediaId>${xmlCdata(String(input.reply.mediaId ?? ""))}</MediaId></${tag}></xml>`;
  }
  if (type === "news") {
    return `<xml>${base}<MsgType><![CDATA[news]]></MsgType><ArticleCount>1</ArticleCount><Articles><item><Title>${xmlCdata(String(input.reply.title ?? ""))}</Title><Description>${xmlCdata(String(input.reply.description ?? ""))}</Description><PicUrl>${xmlCdata(String(input.reply.image ?? ""))}</PicUrl><Url>${xmlCdata(String(input.reply.url ?? ""))}</Url></item></Articles></xml>`;
  }
  if (type === "transfer") {
    return `<xml>${base}<MsgType><![CDATA[transfer_customer_service]]></MsgType></xml>`;
  }
  throw new Error("wechat_callback_reply_invalid");
}

export async function encryptWechatReply(
  plaintext: string,
  token: string,
  encodingAesKey: string,
  appId: string,
  timestamp = String(Math.floor(Date.now() / 1000)),
  nonce = Buffer.from(randomBytes(12)).toString("hex"),
): Promise<string> {
  validateWechatCallbackSecret(token, encodingAesKey);
  if (!plaintext || byteLength(plaintext) > MAX_WECHAT_CALLBACK_BYTES) {
    throw new Error("wechat_callback_reply_invalid");
  }
  const key = decodeBase64(`${encodingAesKey}=`);
  const message = encoder.encode(plaintext);
  const app = encoder.encode(appId);
  const length = new Uint8Array(4);
  new DataView(length.buffer).setUint32(0, message.byteLength, false);
  const unpadded = new Uint8Array(16 + 4 + message.byteLength + app.byteLength);
  unpadded.set(randomBytes(16), 0);
  unpadded.set(length, 16);
  unpadded.set(message, 20);
  unpadded.set(app, 20 + message.byteLength);
  const remainder = unpadded.byteLength % 32;
  const paddingLength = remainder === 0 ? 32 : 32 - remainder;
  const padded = new Uint8Array(unpadded.byteLength + paddingLength);
  padded.set(unpadded, 0);
  padded.fill(paddingLength, unpadded.byteLength);
  const cipher = createCipheriv("aes-256-cbc", key, key.subarray(0, 16));
  cipher.setAutoPadding(false);
  const encrypted = Buffer.concat([cipher.update(padded), cipher.final()]).toString("base64");
  const signature = await wechatCallbackSha(
    "SHA-1",
    [token, timestamp, nonce, encrypted].sort().join(""),
  );
  return `<xml><Encrypt>${xmlCdata(encrypted)}</Encrypt><MsgSignature>${xmlCdata(signature)}</MsgSignature><TimeStamp>${timestamp}</TimeStamp><Nonce>${xmlCdata(nonce)}</Nonce></xml>`;
}
