import { createHash } from "node:crypto";
import type { PrintDocument } from "@/models/schema";
import {
  normalizePrintContent,
  type PrintContent,
} from "@/services/system/PrintDocumentManagementService";

const PROVIDER_TIMEOUT_MS = 8_000;
const MAX_PROVIDER_RESPONSE_BYTES = 32 * 1_024;
const MAX_YILIAN_CONTENT_BYTES = 20 * 1_024;
const MAX_FEIE_CONTENT_BYTES = 5_000;

export interface ReceiptOrder {
  id: number;
  orderId: string;
  shippingType: number;
  realName: string;
  userPhone: string;
  userAddress: string;
  mark: string;
  totalPrice: string;
  payPostage: string;
  deductionPrice: string;
  payPrice: string;
  payType: string;
  addTime: number;
  payTime: number;
}

export interface ReceiptCartRow {
  id: number;
  cartNum: number;
  cartInfo: string | null;
}

export interface ReceiptRenderInput {
  order: ReceiptOrder;
  carts: readonly ReceiptCartRow[];
  printer: PrintDocument;
  trigger: "created" | "paid" | "manual";
  siteName: string;
  siteUrl: string;
  printedAt: number;
}

export interface ReceiptProviderResult {
  providerReference: string;
  requestId: string;
  responseCode: string;
}

interface ReceiptLine {
  name: string;
  sku: string;
  code: string;
  unitPrice: string;
  quantity: number;
  totalPrice: string;
}

export class ReceiptPrinterConfigurationError extends Error {}

/** Provider produced a definitive response saying no print was accepted. */
export class ReceiptPrinterRejectedError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly retryable = false,
  ) {
    super(message);
  }
}

/** Failure before the print endpoint was invoked; retrying cannot duplicate paper. */
export class ReceiptPrinterPreflightError extends Error {}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function nested(source: Record<string, unknown> | undefined, key: string) {
  return record(source?.[key]);
}

/** Replace printer control tokens instead of HTML-encoding them for non-HTML printer parsers. */
export function escapePrinterText(value: unknown, maximum = 500): string {
  const input = String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replaceAll("&", "＆")
    .replaceAll("<", "＜")
    .replaceAll(">", "＞")
    .trim();
  return [...input].slice(0, maximum).join("");
}

function money(value: unknown): string {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, parsed).toFixed(2) : "0.00";
}

function moneyDifference(left: unknown, ...right: unknown[]): string {
  const total = Number(left);
  const remainder = right.reduce<number>((sum, value) => {
    const parsed = Number(value);
    return sum + (Number.isFinite(parsed) ? parsed : 0);
  }, 0);
  return Math.max(0, (Number.isFinite(total) ? total : 0) - remainder).toFixed(2);
}

function receiptLine(row: ReceiptCartRow): ReceiptLine {
  let snapshot: Record<string, unknown> = {};
  try {
    snapshot = record(JSON.parse(row.cartInfo || "{}")) ?? {};
  } catch {
    throw new ReceiptPrinterConfigurationError(`订单商品快照 ${row.id} 无法解析`);
  }
  const product = nested(snapshot, "product");
  const sku = nested(snapshot, "sku");
  const legacyProduct = nested(snapshot, "productInfo");
  const legacySku = nested(legacyProduct, "attrInfo");
  const quantity = Number.isSafeInteger(row.cartNum) && row.cartNum > 0 ? row.cartNum : 1;
  const unitPrice = money(
    sku?.price ?? legacySku?.price ?? snapshot.sum_price ?? snapshot.truePrice,
  );
  return {
    name: escapePrinterText(product?.storeName ?? legacyProduct?.store_name ?? "商品", 160),
    sku: escapePrinterText(sku?.suk ?? legacySku?.suk ?? "", 120),
    code: escapePrinterText(sku?.code ?? legacySku?.code ?? "", 120),
    unitPrice,
    quantity,
    totalPrice: (Number(unitPrice) * quantity).toFixed(2),
  };
}

function dateTime(timestamp: number): string {
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0) return "";
  return new Date(timestamp * 1_000).toISOString().replace("T", " ").slice(0, 19);
}

function paymentLabel(payType: string, paid: boolean): string {
  if (!paid) return "暂无";
  return ({
    weixin: "微信支付",
    alipay: "支付宝支付",
    yue: "余额支付",
    offline: "线下支付",
  } as Record<string, string>)[payType] ?? "暂无";
}

function contentConfig(printer: PrintDocument): PrintContent {
  if (!printer.printContent) throw new ReceiptPrinterConfigurationError("打印内容尚未配置");
  try {
    return normalizePrintContent(JSON.parse(printer.printContent));
  } catch (error) {
    throw new ReceiptPrinterConfigurationError(
      `打印内容配置无效: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function qrValue(siteUrl: string, path: string): string {
  if (!path) return "";
  const base = siteUrl.trim().replace(/\/+$/, "");
  if (!/^https:\/\//i.test(base)) return "";
  return escapePrinterText(`${base}${path}`, 1_024);
}

function yilianContent(input: ReceiptRenderInput, config: PrintContent, lines: ReceiptLine[]): string {
  const { order, printer } = input;
  const paid = input.trigger !== "created";
  const separator = "<FH2><FW2>----------------</FW2></FH2>";
  const out: string[] = [`<MN>${printer.times}</MN>`];
  if (config.header) out.push(`<FS2><center>${escapePrinterText(input.siteName || "CinaShop", 120)}</center></FS2>`, separator);
  if (config.delivery) {
    out.push(`配送方式：${order.shippingType === 1 ? "商家配送" : "门店自提"}\r`);
    out.push(`客户姓名：${escapePrinterText(order.realName, 64)}\r`);
    out.push(`客户电话：${escapePrinterText(order.userPhone, 32)}\r`);
    if (order.shippingType === 1) out.push(`收货地址：${escapePrinterText(order.userAddress, 255)}\r`);
    out.push(separator);
  }
  if (config.buyer_remarks) out.push(`买家备注：${escapePrinterText(order.mark, 500)}\r`, separator);
  if (config.goods.includes(0)) {
    out.push("*************商品***************\r", "名称 | 规格　单价　数量　金额\r");
    for (const line of lines) {
      out.push(`${line.name}${line.sku ? ` | ${line.sku}` : ""}\r`);
      out.push(`${line.unitPrice}　${line.quantity}　${line.totalPrice}\r`);
      if (config.goods.includes(1) && line.code) out.push(`规格编码：${line.code}\r`);
    }
    out.push("********************************\r", separator);
  }
  const gross = Number(order.totalPrice) + Number(order.payPostage);
  if (config.freight) out.push(`<RA>邮费：${money(order.payPostage)}元</RA>`, `<RA>合计：${money(gross)}元</RA>`, separator);
  if (config.preferential) {
    out.push(`<RA>优惠：-${moneyDifference(gross, order.deductionPrice, order.payPrice)}元</RA>`);
    out.push(`<RA>抵扣：-${money(order.deductionPrice)}元</RA>`, separator);
  }
  if (config.pay.includes(0)) out.push(`<RA>支付方式：${paymentLabel(order.payType, paid)}</RA>`);
  if (config.pay.includes(1)) out.push(`<RA>实际支付：${money(order.payPrice)}元</RA>`);
  if (config.pay.length) out.push(separator);
  if (config.order.includes(0)) out.push(`订单编号：${escapePrinterText(order.orderId, 32)}\r`);
  if (config.order.includes(1)) out.push(`下单时间：${dateTime(order.addTime)}\r`);
  if (config.order.includes(2)) out.push(`支付时间：${dateTime(order.payTime)}\r`);
  if (config.order.includes(3)) out.push(`打印时间：${dateTime(input.printedAt)}\r`);
  out.push(separator);
  const qr = config.code ? qrValue(input.siteUrl, config.code_url) : "";
  if (qr) out.push(`<QR>${qr}</QR>`, "\r");
  if (config.show_notice && config.notice_content) {
    out.push(`<center>${escapePrinterText(config.notice_content, 500)}</center>`, "\r");
  }
  return out.join("");
}

function feieContent(input: ReceiptRenderInput, config: PrintContent, lines: ReceiptLine[]): string {
  const { order } = input;
  const paid = input.trigger !== "created";
  const separator = "--------------------------------<BR>";
  const out: string[] = [];
  if (config.header) out.push(`<CB>${escapePrinterText(input.siteName || "CinaShop", 120)}</CB><BR>`, separator);
  if (config.delivery) {
    out.push(`配送方式：${order.shippingType === 1 ? "商家配送" : "门店自提"}<BR>`);
    out.push(`客户姓名：${escapePrinterText(order.realName, 64)}<BR>`);
    out.push(`客户电话：${escapePrinterText(order.userPhone, 32)}<BR>`);
    if (order.shippingType === 1) out.push(`收货地址：${escapePrinterText(order.userAddress, 255)}<BR>`);
    out.push(separator);
  }
  if (config.buyer_remarks) out.push(`买家备注：${escapePrinterText(order.mark, 500)}<BR>`, separator);
  if (config.goods.includes(0)) {
    out.push("**************商品**************<BR>", "名称 | 规格　单价　数量　金额<BR>");
    for (const line of lines) {
      out.push(separator, `${line.name}${line.sku ? ` | ${line.sku}` : ""}<BR>`);
      out.push(`${line.unitPrice}　${line.quantity}　${line.totalPrice}<BR>`);
      if (config.goods.includes(1) && line.code) out.push(`规格编码：${line.code}<BR>`);
    }
    out.push("********************************<BR>");
  }
  const gross = Number(order.totalPrice) + Number(order.payPostage);
  if (config.freight) out.push(separator, `<RIGHT>邮费：${money(order.payPostage)}元</RIGHT><BR>`, `<RIGHT>合计：${money(gross)}元</RIGHT><BR>`);
  if (config.preferential) {
    out.push(separator, `<RIGHT>优惠：-${moneyDifference(gross, order.deductionPrice, order.payPrice)}元</RIGHT><BR>`);
    out.push(`<RIGHT>抵扣：-${money(order.deductionPrice)}元</RIGHT><BR>`);
  }
  if (config.pay.includes(0)) out.push(`<RIGHT>支付方式：${paymentLabel(order.payType, paid)}</RIGHT><BR>`);
  if (config.pay.includes(1)) out.push(`<RIGHT>实际支付：${money(order.payPrice)}元</RIGHT><BR>`);
  if (config.pay.length) out.push(separator);
  if (config.order.includes(0)) out.push(`订单编号：${escapePrinterText(order.orderId, 32)}<BR>`);
  if (config.order.includes(1)) out.push(`下单时间：${dateTime(order.addTime)}<BR>`);
  if (config.order.includes(2)) out.push(`支付时间：${dateTime(order.payTime)}<BR>`);
  if (config.order.includes(3)) out.push(`打印时间：${dateTime(input.printedAt)}<BR>`);
  out.push(separator);
  const qr = config.code ? qrValue(input.siteUrl, config.code_url) : "";
  if (qr) out.push(`<QR>${qr}</QR>`);
  if (config.show_notice && config.notice_content) out.push(`<C>${escapePrinterText(config.notice_content, 500)}</C>`);
  return out.join("");
}

export function renderReceipt(input: ReceiptRenderInput): string {
  const config = contentConfig(input.printer);
  const lines = input.carts.map(receiptLine);
  if (!lines.length) throw new ReceiptPrinterConfigurationError("订单没有可打印的商品快照");
  const content = input.printer.type === 1
    ? yilianContent(input, config, lines)
    : input.printer.type === 2
      ? feieContent(input, config, lines)
      : "";
  if (!content) throw new ReceiptPrinterConfigurationError("打印平台类型无效");
  const bytes = new TextEncoder().encode(content).byteLength;
  const maximum = input.printer.type === 2 ? MAX_FEIE_CONTENT_BYTES : MAX_YILIAN_CONTENT_BYTES;
  if (bytes > maximum) {
    throw new ReceiptPrinterConfigurationError(`打印内容超过提供商限制（${bytes}/${maximum}字节）`);
  }
  return content;
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha1Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function responseText(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let overflow = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_PROVIDER_RESPONSE_BYTES) {
        overflow = true;
        throw new Error("provider_response_too_large");
      }
      chunks.push(value);
    }
  } finally {
    if (overflow) await reader.cancel("provider_response_too_large").catch(() => undefined);
    reader.releaseLock();
  }
  const merged = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

async function postForm(
  url: string,
  form: URLSearchParams,
  fetcher: typeof fetch,
): Promise<{ response: Response; text: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);
  try {
    const call = fetcher;
    const response = await call(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8" },
      body: form,
      signal: controller.signal,
    });
    return { response, text: await responseText(response) };
  } finally {
    clearTimeout(timer);
  }
}

function jsonObject(text: string): Record<string, unknown> {
  const parsed = record(JSON.parse(text));
  if (!parsed) throw new Error("provider_response_not_object");
  return parsed;
}

async function sendFeie(
  printer: PrintDocument,
  content: string,
  fetcher: typeof fetch,
): Promise<ReceiptProviderResult> {
  if (!printer.feyUser || !printer.feyUkey || !printer.feySn || printer.times < 1) {
    throw new ReceiptPrinterConfigurationError("飞鹅云打印机配置不完整");
  }
  const stime = String(Math.floor(Date.now() / 1_000));
  const sig = await sha1Hex(`${printer.feyUser}${printer.feyUkey}${stime}`);
  const { response, text } = await postForm(
    "https://api.feieyun.cn/Api/Open/printMsg",
    new URLSearchParams({
      user: printer.feyUser,
      stime,
      sig,
      apiname: "Open_printMsg",
      sn: printer.feySn,
      content,
      times: String(printer.times),
    }),
    fetcher,
  );
  if (!response.ok) throw new Error(`feie_http_${response.status}`);
  const payload = jsonObject(text);
  const ret = Number(payload.ret);
  const message = String(payload.msg ?? "");
  if (ret !== 0 || message.toLowerCase() !== "ok") {
    throw new ReceiptPrinterRejectedError(message || `飞鹅云拒绝请求 ${ret}`, `FEIE_${ret}`);
  }
  return {
    providerReference: String(payload.data ?? "").slice(0, 255),
    requestId: "",
    responseCode: "OK",
  };
}

async function yilianAccessToken(printer: PrintDocument, fetcher: typeof fetch): Promise<string> {
  if (!printer.ylyUserId || !printer.ylyAppId || !printer.ylyAppSecret || !printer.ylySn) {
    throw new ReceiptPrinterConfigurationError("易联云打印机配置不完整");
  }
  try {
    const timestamp = String(Math.floor(Date.now() / 1_000));
    const sign = createHash("md5")
      .update(`${printer.ylyAppId}${timestamp}${printer.ylyAppSecret}`)
      .digest("hex")
      .toLowerCase();
    const { response, text } = await postForm(
      "https://open-api.10ss.net/oauth/oauth",
      new URLSearchParams({
        client_id: printer.ylyAppId,
        grant_type: "client_credentials",
        sign,
        scope: "all",
        id: crypto.randomUUID(),
        timestamp,
      }),
      fetcher,
    );
    if (!response.ok) throw new Error(`yilian_oauth_http_${response.status}`);
    const payload = jsonObject(text);
    if (Number(payload.error ?? 0) !== 0) {
      throw new Error(`yilian_oauth_rejected_${String(payload.error ?? "unknown")}`);
    }
    const token = String(record(payload.body)?.access_token ?? payload.access_token ?? "");
    if (!token) throw new Error("yilian_oauth_missing_token");
    return token;
  } catch (error) {
    if (error instanceof ReceiptPrinterConfigurationError) throw error;
    throw new ReceiptPrinterPreflightError(error instanceof Error ? error.message : String(error));
  }
}

async function sendYilian(
  printer: PrintDocument,
  content: string,
  eventKey: string,
  fetcher: typeof fetch,
): Promise<ReceiptProviderResult> {
  const accessToken = await yilianAccessToken(printer, fetcher);
  const timestamp = String(Math.floor(Date.now() / 1_000));
  const requestId = crypto.randomUUID();
  const originId = `cina${(await sha256Hex(eventKey)).slice(0, 28)}`;
  const sign = createHash("md5")
    .update(`${printer.ylyAppId}${timestamp}${printer.ylyAppSecret}`)
    .digest("hex")
    .toLowerCase();
  const { response, text } = await postForm(
    "https://open-api.10ss.net/print/index",
    new URLSearchParams({
      client_id: printer.ylyAppId,
      access_token: accessToken,
      machine_code: printer.ylySn,
      content,
      origin_id: originId,
      sign,
      id: requestId,
      timestamp,
    }),
    fetcher,
  );
  if (!response.ok) throw new Error(`yilian_print_http_${response.status}`);
  const payload = jsonObject(text);
  const code = Number(payload.error ?? 0);
  if (code !== 0) {
    throw new ReceiptPrinterRejectedError(
      String(payload.error_description ?? `易联云拒绝请求 ${code}`),
      `YILIAN_${code}`,
    );
  }
  const body = record(payload.body);
  return {
    providerReference: String(body?.id ?? payload.body ?? originId).slice(0, 255),
    requestId,
    responseCode: "OK",
  };
}

export async function sendReceiptToProvider(
  printer: PrintDocument,
  content: string,
  eventKey: string,
  fetcher: typeof fetch = fetch,
): Promise<ReceiptProviderResult> {
  if (printer.type === 1) return sendYilian(printer, content, eventKey, fetcher);
  if (printer.type === 2) return sendFeie(printer, content, fetcher);
  throw new ReceiptPrinterConfigurationError("打印平台类型无效");
}
