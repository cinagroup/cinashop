/**
 * 微信加密工具库 (M6 核心)
 *
 * 基于 Workers 原生 WebCrypto API (SubtleCrypto) + node:crypto。
 * 对应 PHP:
 *   - util/AES.php (AES-128-CBC 手机数据解密)
 *   - v3pay/BaseClient.php (RSA-SHA256 签名 + AES-256-GCM 回调解密)
 *   - OfficialAccount/JsApiTicket.php (SHA1 JS-SDK 签名)
 *   - util/Helper.php (MD5 v2 签名)
 *
 * 加密算法映射表 (经探针验证):
 *   | 操作 | 算法 | 密钥 |
 *   |------|------|------|
 *   | 手机数据解密 | AES-128-CBC PKCS7 | session_key |
 *   | V3 请求签名 | RSA-2048 SHA256 | 商户私钥 |
 *   | V3 回调验签 | RSA SHA256 | 平台公钥 |
 *   | V3 回调解密 | AES-256-GCM tag=16 | APIv3 key |
 *   | JSAPI 支付签名 | RSA SHA256 | 商户私钥 |
 *   | JS-SDK config | SHA1 | jsapi_ticket |
 *   | v2 签名/验签 | MD5 大写 | API v2 key |
 */

// ─── Base64 辅助 ─────────────────────────────────────────────
const b64ToBuf = (b64: string): ArrayBuffer => {
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
};

const bufToB64 = (buf: ArrayBuffer | Uint8Array): string => {
  const arr = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
  return btoa(bin);
};

const strToBuf = (s: string): ArrayBuffer =>
  new TextEncoder().encode(s).buffer as ArrayBuffer;

// ─── AES-128-CBC (小程序手机号/用户数据解密) ──────────────

/**
 * 解密小程序 encryptedData (对应 PHP util/AES.php + AuthClient::decryptData)
 *
 * 算法: AES-128-CBC, PKCS7 padding
 * 输入都是 base64: encryptedData, sessionKey, iv
 *
 * @returns 解密后的 JSON 对象 (含 purePhoneNumber / phoneNumber 等)
 */
export async function decryptMiniProgramData(
  encryptedData: string,
  sessionKey: string,
  iv: string,
): Promise<Record<string, unknown>> {
  const keyBuf = b64ToBuf(sessionKey);
  const ivBuf = b64ToBuf(iv);
  const ctBuf = b64ToBuf(encryptedData);

  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyBuf,
    { name: "AES-CBC" },
    false,
    ["decrypt"],
  );

  try {
    const decrypted = await crypto.subtle.decrypt(
      { name: "AES-CBC", iv: ivBuf },
      cryptoKey,
      ctBuf,
    );
    const json = new TextDecoder().decode(decrypted);
    return JSON.parse(json);
  } catch {
    throw new Error("解密失败: session_key 不正确或数据已损坏 (微信错误码 -41003)");
  }
}

// ─── RSA-SHA256 (V3 支付签名 + JSAPI 支付签名) ─────────────

/**
 * 用商户私钥 (PEM 格式 PKCS#8) 对消息做 RSA-SHA256 签名。
 * 对应 PHP openssl_sign($message, $sign, $privateKey, 'sha256WithRSAEncryption')
 *
 * @returns base64 签名
 */
export async function rsaSign(privateKeyPem: string, message: string): Promise<string> {
  // 去掉 PEM header/footer, 转 base64 → ArrayBuffer
  const pemBody = privateKeyPem
    .replace(/-----BEGIN PRIVATE KEY-----/g, "")
    .replace(/-----END PRIVATE KEY-----/g, "")
    .replace(/-----BEGIN RSA PRIVATE KEY-----/g, "")
    .replace(/-----END RSA PRIVATE KEY-----/g, "")
    .replace(/\s+/g, "");

  const keyData = b64ToBuf(pemBody);

  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8",
    keyData,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    cryptoKey,
    strToBuf(message),
  );
  return bufToB64(sig);
}

/**
 * 用平台公钥验签 V3 回调。
 * 对应 PHP openssl_verify($message, $signature, $publicKey, OPENSSL_ALGO_SHA256)
 *
 * @param publicKeyPem 平台证书公钥 PEM
 * @param message 验签消息 (timestamp\nnonce\nbody\n)
 * @param signatureBase64 base64 签名 (Wechatpay-Signature header)
 */
export async function rsaVerify(
  publicKeyPem: string,
  message: string,
  signatureBase64: string,
): Promise<boolean> {
  const pemBody = publicKeyPem
    .replace(/-----BEGIN CERTIFICATE-----/g, "")
    .replace(/-----END CERTIFICATE-----/g, "")
    .replace(/-----BEGIN PUBLIC KEY-----/g, "")
    .replace(/-----END PUBLIC KEY-----/g, "")
    .replace(/\s+/g, "");

  const keyData = b64ToBuf(pemBody);

  let cryptoKey: CryptoKey;
  try {
    // 尝试作为证书导入
    cryptoKey = await crypto.subtle.importKey(
      "spki",
      keyData,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
  } catch {
    // spki 失败, 尝试 x509 cert (Workers 可能不支持, 降级)
    throw new Error("平台证书格式不支持, 请提取公钥后传入 spki 格式");
  }

  return crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    cryptoKey,
    b64ToBuf(signatureBase64),
    strToBuf(message),
  );
}

// ─── AES-256-GCM (V3 回调 resource 解密 + 平台证书解密) ────

/**
 * AES-256-GCM 解密 (对应 PHP v3pay/BaseClient.php::decrypt)
 *
 * 微信 V3 规范: ciphertext base64 编码, 最后 16 字节是 auth tag。
 * key = APIv3 key (32 字节), nonce + associated_data 来自 resource 对象。
 *
 * @param ciphertextBase64 base64 密文 (含末尾 16 字节 tag)
 * @param key APIv3 key (字符串, 32 字节)
 * @param nonce 12 字节 nonce
 * @param associatedData 附加数据
 * @returns 解密后的明文字符串 (JSON)
 */
export async function aesGcmDecrypt(
  ciphertextBase64: string,
  key: string,
  nonce: string,
  associatedData: string,
): Promise<string> {
  const fullCt = new Uint8Array(b64ToBuf(ciphertextBase64));
  // 最后 16 字节是 tag
  const tagLen = 16;
  const ctLen = fullCt.length - tagLen;
  const ciphertext = fullCt.slice(0, ctLen);
  const tag = fullCt.slice(ctLen);

  const keyBuf = strToBuf(key);
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyBuf,
    { name: "AES-GCM" },
    false,
    ["decrypt"],
  );

  // Workers AES-GCM: ciphertext + tag 拼接传入
  const combined = new Uint8Array(ctLen + tagLen);
  combined.set(ciphertext, 0);
  combined.set(tag, ctLen);

  const decrypted = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: strToBuf(nonce),
      additionalData: strToBuf(associatedData),
      tagLength: 128,
    },
    cryptoKey,
    combined,
  );
  return new TextDecoder().decode(decrypted);
}

// ─── SHA1 (JS-SDK wx.config 签名) ───────────────────────────

/**
 * JS-SDK config 签名 (对应 PHP JsApiTicket::configSignature)
 *
 * 算法: plain SHA1 (非 HMAC)
 * 签名串: jsapi_ticket={ticket}&noncestr={nonce}&timestamp={ts}&url={url}
 * 注意: 参数顺序固定, noncestr 全小写
 */
export async function jsSdkSignature(
  ticket: string,
  nonceStr: string,
  timestamp: number,
  url: string,
): Promise<string> {
  const str = `jsapi_ticket=${ticket}&noncestr=${nonceStr}&timestamp=${timestamp}&url=${url}`;
  const hash = await crypto.subtle.digest("SHA-1", strToBuf(str));
  // SHA1 → 40 位十六进制
  const arr = new Uint8Array(hash);
  let hex = "";
  for (let i = 0; i < arr.length; i++) {
    hex += arr[i].toString(16).padStart(2, "0");
  }
  return hex;
}

// ─── MD5 (v2 支付签名 + 回调验签) ───────────────────────────

/**
 * 微信 v2 支付签名 (对应 PHP Helper::generateSign)
 *
 * 算法: MD5 大写
 * 规则: 参数按 key 升序排列, 拼成 k1=v1&k2=v2..., 末尾追加 &key=mch_key, MD5 后转大写
 *
 * Workers 无内置 MD5 (crypto.subtle 不支持), 用 node:crypto (nodejs_compat)。
 */
import { createHash } from "node:crypto";

export function md5Hex(input: string): string {
  return createHash("md5").update(input).digest("hex");
}

/**
 * v2 签名: 排序 + 拼 key + MD5 大写
 */
export function generateV2Sign(params: Record<string, string>, apiKey: string): string {
  const sorted = Object.keys(params)
    .filter((k) => params[k] !== "" && k !== "sign")
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join("&");
  return md5Hex(`${sorted}&key=${apiKey}`).toUpperCase();
}

// ─── V3 请求授权头构建 ──────────────────────────────────────

/**
 * 构建 V3 请求 Authorization 头 (对应 PHP BaseClient::getAuthorization)
 *
 * 格式: WECHATPAY2-SHA256-RSA2048 mchid="...",nonce_str="...",timestamp="...",serial_no="...",signature="..."
 * 签名消息: METHOD\n/url\ntimestamp\nnonce_str\nbody\n (5 行, 每行 \n 结尾)
 *
 * @param privateKeyPem 商户私钥 PEM
 * @param method HTTP 方法 (大写)
 * @param url 路径 (不含域名, 以 / 开头)
 * @param body 请求体 JSON 字符串 (GET 为空)
 * @param mchId 商户号
 * @param serialNo 商户证书序列号
 */
export async function buildV3Authorization(
  privateKeyPem: string,
  method: string,
  url: string,
  body: string,
  mchId: string,
  serialNo: string,
): Promise<string> {
  const timestamp = Math.floor(Date.now() / 1000);
  const nonceStr = generateNonceStr();
  const message = `${method}\n${url}\n${timestamp}\n${nonceStr}\n${body}\n`;
  const signature = await rsaSign(privateKeyPem, message);
  return `WECHATPAY2-SHA256-RSA2048 mchid="${mchId}",nonce_str="${nonceStr}",timestamp="${timestamp}",serial_no="${serialNo}",signature="${signature}"`;
}

// ─── JSAPI 支付签名 (客户端调起支付) ───────────────────────

/**
 * JSAPI 支付签名 (对应 PHP PayClient::configForPayment)
 *
 * 签名消息: appId\ntimeStamp\nnonceStr\npackage\n (4 行)
 * 用商户私钥 RSA-SHA256 签名, base64 输出。
 */
export async function buildJsapiPaySign(
  privateKeyPem: string,
  appId: string,
  prepayId: string,
): Promise<{ timeStamp: string; nonceStr: string; package: string; signType: string; paySign: string }> {
  const timeStamp = String(Math.floor(Date.now() / 1000));
  const nonceStr = generateNonceStr();
  const pkg = `prepay_id=${prepayId}`;
  const message = `${appId}\n${timeStamp}\n${nonceStr}\n${pkg}\n`;
  const paySign = await rsaSign(privateKeyPem, message);
  return { timeStamp, nonceStr, package: pkg, signType: "RSA", paySign };
}

// ─── 辅助 ────────────────────────────────────────────────────

/** 生成随机字符串 (对应 PHP uniqid) */
export function generateNonceStr(length = 32): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  const randomValues = new Uint8Array(length);
  crypto.getRandomValues(randomValues);
  for (let i = 0; i < length; i++) {
    result += chars[randomValues[i] % chars.length];
  }
  return result;
}
