/**
 * 支付宝 RSA2 签名/验签。
 *
 * 签名串规则与支付宝官方 Node SDK 的 checkNotifySignV2 一致：
 * 移除 sign，按参数名排序，以 key=value 用 & 连接，并兼容历史上
 * sign_type 是否参与签名的两种通知格式。
 */

export type AlipayParams = Record<string, string>;

const MAX_NOTIFICATION_FIELDS = 64;
const MAX_NOTIFICATION_VALUE_CHARS = 16 * 1024;
const NOTIFICATION_KEY = /^[A-Za-z0-9_.-]{1,64}$/;
const FORBIDDEN_FORM_CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

/** Parse a bounded raw form after the caller has enforced the byte limit. */
export function parseAlipayNotificationForm(raw: string): AlipayParams {
  const params: AlipayParams = {};
  let count = 0;
  for (const [key, value] of new URLSearchParams(raw)) {
    count += 1;
    if (count > MAX_NOTIFICATION_FIELDS) throw new Error("支付宝回调字段过多");
    if (!NOTIFICATION_KEY.test(key)) throw new Error("支付宝回调字段名无效");
    if (Object.hasOwn(params, key)) throw new Error("支付宝回调字段重复");
    if (value.length > MAX_NOTIFICATION_VALUE_CHARS || FORBIDDEN_FORM_CONTROL.test(value)) {
      throw new Error("支付宝回调字段值无效");
    }
    params[key] = value;
  }
  return params;
}

function pemToArrayBuffer(pem: string, label: "PUBLIC KEY" | "PRIVATE KEY"): ArrayBuffer {
  const begin = `-----BEGIN ${label}-----`;
  const end = `-----END ${label}-----`;
  if (!pem.includes(begin) || !pem.includes(end)) {
    throw new Error(
      label === "PUBLIC KEY"
        ? "支付宝公钥必须是 SPKI PEM (BEGIN PUBLIC KEY)"
        : "支付宝私钥必须是 PKCS#8 PEM (BEGIN PRIVATE KEY)",
    );
  }

  const base64 = pem
    .replace(begin, "")
    .replace(end, "")
    .replace(/\s+/g, "");
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function base64ToArrayBuffer(value: string): ArrayBuffer {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function arrayBufferToBase64(value: ArrayBuffer): string {
  const bytes = new Uint8Array(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function buildAlipaySignContent(
  params: AlipayParams,
  includeSignType = true,
): string {
  return Object.keys(params)
    .filter((key) => key !== "sign" && (includeSignType || key !== "sign_type"))
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join("&");
}

async function verifyContent(
  content: string,
  signature: string,
  publicKeyPem: string,
): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    "spki",
    pemToArrayBuffer(publicKeyPem, "PUBLIC KEY"),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    base64ToArrayBuffer(signature),
    new TextEncoder().encode(content),
  );
}

/**
 * 取支付宝网关 JSON 中被签名的 response 节点原文。
 * 不能先 JSON.parse 再 stringify：转义或数字格式变化都会令合法签名失效。
 */
export function extractAlipayResponseContent(rawBody: string, responseKey: string): string {
  const keyToken = JSON.stringify(responseKey);
  const keyIndex = rawBody.indexOf(keyToken);
  if (keyIndex < 0) throw new Error(`支付宝响应缺少 ${responseKey}`);

  let cursor = keyIndex + keyToken.length;
  while (/\s/.test(rawBody[cursor] ?? "")) cursor += 1;
  if (rawBody[cursor] !== ":") throw new Error("支付宝响应格式错误");
  cursor += 1;
  while (/\s/.test(rawBody[cursor] ?? "")) cursor += 1;
  if (rawBody[cursor] !== "{") throw new Error("支付宝业务响应不是 JSON 对象");

  const start = cursor;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (; cursor < rawBody.length; cursor += 1) {
    const char = rawBody[cursor];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return rawBody.slice(start, cursor + 1);
    }
  }
  throw new Error("支付宝业务响应 JSON 未闭合");
}

export async function parseAndVerifyAlipayApiResponse<T extends object>(
  rawBody: string,
  responseKey: string,
  publicKeyPem: string,
): Promise<T> {
  const parsed = JSON.parse(rawBody) as Record<string, unknown>;
  const signature = parsed.sign;
  if (typeof signature !== "string" || !signature) {
    throw new Error("支付宝响应缺少签名");
  }
  const content = extractAlipayResponseContent(rawBody, responseKey);
  if (!(await verifyContent(content, signature, publicKeyPem))) {
    throw new Error("支付宝响应验签失败");
  }
  const value = parsed[responseKey];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`支付宝响应缺少 ${responseKey}`);
  }
  return value as T;
}

export function formatAlipayTimestamp(date: Date): string {
  const chinaTime = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  return chinaTime.toISOString().slice(0, 19).replace("T", " ");
}

export async function verifyAlipayNotification(
  params: AlipayParams,
  publicKeyPem: string,
): Promise<boolean> {
  const signature = params.sign;
  if (!signature || (params.sign_type && params.sign_type !== "RSA2")) return false;

  if (await verifyContent(buildAlipaySignContent(params, true), signature, publicKeyPem)) {
    return true;
  }
  return verifyContent(buildAlipaySignContent(params, false), signature, publicKeyPem);
}

export async function signAlipayParams(
  params: AlipayParams,
  privateKeyPem: string,
): Promise<string> {
  return signAlipayContent(buildAlipaySignContent(params, true), privateKeyPem);
}

export async function signAlipayContent(
  content: string,
  privateKeyPem: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToArrayBuffer(privateKeyPem, "PRIVATE KEY"),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(content),
  );
  return arrayBufferToBase64(signature);
}
