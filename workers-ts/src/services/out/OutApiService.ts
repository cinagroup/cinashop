import { compare, hash } from "bcryptjs";
import {
  and,
  count,
  desc,
  eq,
  gte,
  ilike,
  inArray,
  isNull,
  lte,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import type { Env } from "@/env";
import { withTx, type Container, type DbClient } from "@/lib/di";
import {
  expressCompany,
  outApiAudit,
  outAccount,
  outInterface,
  storeCouponIssue,
  deliveryService,
  storeOrder,
  storeOrderCartInfo,
  storeOrderInvoice,
  storeOrderRefund,
  storeOrderRefundPayment,
  storeOrderStatus,
  storeProductCategory,
  systemUserLevel,
  user,
} from "@/models/schema";
import {
  completeOrderReceipt,
  lockOrderSettlement,
} from "@/services/order/OrderBrokerageService";
import {
  lockRefundExecution,
  StoreOrderRefundService,
  type RefundExecutionScope,
} from "@/services/order/StoreOrderRefundService";
import { amountToCents } from "@/services/payment/RefundGateway";
import { StoreProductService, type GoodsListParams } from "@/services/product/StoreProductService";
import {
  normalizeSupplierDeliveryInput,
  normalizeSupplierSplitCartInput,
  SupplierFulfillmentService,
  type SupplierDeliveryInput,
  type SupplierSplitCartInput,
} from "@/services/supplier/SupplierFulfillmentService";
import { enqueueOrderRefundRefusedNoticeEvent } from "@/services/order/OrderNotificationOutboxService";
import { clearToken, getTokenBucket, setTokenBucket } from "@/utils/cache";
import { AuthException, NotFoundException, ValidateException } from "@/utils/errors";
import { createToken, md5, verifyToken } from "@/utils/jwt";

const MAX_PAGE_SIZE = 100;
const MAX_PAGE_NUMBER = 100_000;
const MAX_RULES = 512;
const BCRYPT_COST = 12;
const DUMMY_BCRYPT_HASH = "$2b$12$aoFQ1UDRKVgYmPxVsvZp1eGrp07dDT0KroIStvxFZyrf1b1EIylqS";
const SUPPORTED_READ_ROUTES = new Set([
  "get /category/list",
  "get /category/{id}",
  "get /product/list",
  "get /product/{id}",
  "get /order/list",
  "get /order/{order_id}",
  "get /order/express_list",
  "get /order/split_cart_info/{order_id}",
  "get /refund/list",
  "get /refund/{order_id}",
  "get /coupon/list",
  "get /user_level/list",
  "get /user/list",
  "get /user/info/{uid}",
]);
const SUPPORTED_WRITE_ROUTES = new Set([
  "put /order/delivery/{order_id}",
  "put /order/distribution/{order_id}",
  "put /order/invoice/{order_id}",
  "put /order/invoice_status/{order_id}",
  "put /order/remark/{order_id}",
  "put /order/receive/{order_id}",
  "put /order/split_delivery/{order_id}",
  "put /refund/agree/{order_id}",
  "put /refund/remark/{order_id}",
  "put /refund/refuse/{order_id}",
  "put /refund/{order_id}",
]);

const MAX_FILTER_TEXT = 100;
const MAX_JSON_SNAPSHOT_BYTES = 1024 * 1024;
const MAX_ID_FILTERS = 100;

type OrderRow = typeof storeOrder.$inferSelect;
type CartRow = typeof storeOrderCartInfo.$inferSelect;
type RefundRow = typeof storeOrderRefund.$inferSelect;
type UserRow = typeof user.$inferSelect;

export interface AuthenticatedOutAccount {
  id: number;
  appid: string;
  title: string;
  rules: number[];
}

export interface OutApiAuditInput {
  account: AuthenticatedOutAccount;
  method: string;
  routeTemplate: string;
  operation: "read" | "write";
  resourceHash: string;
  queryFields: string;
  ipHash: string;
  userAgentHash: string;
  outcome: "success" | "denied" | "rate_limited" | "error";
  resultCode: number;
  durationMs: number;
}

function positiveInteger(value: unknown, fallback = 0): number {
  const parsed = Number(value ?? fallback);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function pageValues(query: Record<string, unknown>): { page: number; limit: number } {
  const page = positiveInteger(query.page, 1);
  if (page > MAX_PAGE_NUMBER) throw new ValidateException("页码超限");
  const limit = Math.min(positiveInteger(query.limit, 20), MAX_PAGE_SIZE);
  return { page, limit };
}

function normalizeBcryptHash(value: string): string {
  return value.replace(/^\$2[by]\$/, "$2a$");
}

export function parseOutRules(value: unknown): number[] {
  let parsed = value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return [];
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      parsed = trimmed.split(",");
    }
  }
  if (!Array.isArray(parsed)) return [];
  return [...new Set(parsed.map(Number).filter((item) => Number.isSafeInteger(item) && item > 0))]
    .slice(0, MAX_RULES);
}

export function normalizeOutRoute(method: string, route: string): string {
  const normalizedRoute = route
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/^\/?outapi/, "")
    .replace(/<([^>]+)>/g, "{$1}")
    .replace(/:([a-z0-9_]+)/g, "{$1}")
    .replace(/\/+/g, "/");
  const withLeadingSlash = normalizedRoute.startsWith("/") ? normalizedRoute : `/${normalizedRoute}`;
  return `${method.trim().toLowerCase()} ${withLeadingSlash.replace(/\/$/, "") || "/"}`;
}

function filterText(value: unknown, name: string): string {
  const text = String(value ?? "").trim();
  if (text.length > MAX_FILTER_TEXT) throw new ValidateException(`${name}过长`);
  return text;
}

function optionalInteger(value: unknown, name: string): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new ValidateException(`${name}参数错误`);
  return parsed;
}

function normalizeOutDeliveryInput(input: Record<string, unknown>): SupplierDeliveryInput {
  return normalizeSupplierDeliveryInput({
    ...input,
    type: 1,
    delivery_type: "express",
    fictitious_content: "",
    delivery_uid: 0,
  });
}

interface OutDistributionInput {
  deliveryName: string;
  deliveryCode: string;
  deliveryId: string;
}

interface OutDistributionReplay {
  orderId: number;
  deliveryType: "express" | "send" | "fictitious";
}

export interface OutInvoiceInput {
  headerType: 1 | 2;
  type: number;
  drawerPhone: string;
  email: string;
  name: string;
  dutyNumber: string;
  tell: string;
  address: string;
  bank: string;
  cardNumber: string;
}

export interface OutInvoiceStatusInput {
  isInvoice: -1 | 0 | 1;
  invoiceNumber: string;
  remark: string;
}

type OutInvoiceChangeType = "out_order_invoice" | "out_order_invoice_status";

interface OutInvoiceReplay {
  orderId: number;
  invoiceId: number;
  isInvoice: -1 | 0 | 1;
}

type OutRefundDecisionChangeType = "out_refund_agree" | "out_refund_refuse";

interface OutRefundDecisionReplay {
  orderId: number;
  refundId: number;
  refundType: 3 | 4;
}

export type OutRefundPriceAction =
  | { type: 1; refundAmountCents: number | null }
  | { type: 2; refuseReason: string };

function strictOutText(
  input: Record<string, unknown>,
  key: string,
  label: string,
  maxLength: number,
): string {
  const value = input[key];
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw new ValidateException(`${label}格式错误`);
  const normalized = value.trim();
  if (normalized.length > maxLength) throw new ValidateException(`${label}过长`);
  return normalized;
}

/**
 * Parse the legacy Out refund body without accepting JavaScript coercions.
 * A missing amount remains distinguishable because zero-value refund records
 * legitimately do not require refund_price in the PHP contract.
 */
export function normalizeOutRefundPriceAction(
  input: Record<string, unknown>,
): OutRefundPriceAction {
  const rawType = input.type;
  const typeText = rawType === undefined || rawType === null || rawType === ""
    ? "1"
    : typeof rawType === "number" || typeof rawType === "string"
      ? String(rawType).trim()
      : "";
  if (!/^[12]$/.test(typeText)) throw new ValidateException("退款操作类型参数错误");
  if (typeText === "2") {
    const refuseReason = strictOutText(input, "refuse_reason", "不退款原因", 255);
    if (!refuseReason) throw new ValidateException("请输入不退款原因");
    return { type: 2, refuseReason };
  }

  const rawAmount = input.refund_price;
  if (rawAmount === undefined || rawAmount === null || rawAmount === "") {
    return { type: 1, refundAmountCents: null };
  }
  if (typeof rawAmount !== "string" && typeof rawAmount !== "number") {
    throw new ValidateException("退款金额格式错误");
  }
  const amountText = String(rawAmount).trim();
  const cents = amountToCents(amountText);
  if (cents === null || cents > 999_999_999_999) {
    throw new ValidateException("退款金额格式错误");
  }
  return { type: 1, refundAmountCents: cents };
}

function normalizeOutDistributionInput(input: Record<string, unknown>): OutDistributionInput {
  return {
    deliveryName: strictOutText(input, "delivery_name", "配送名称", 64),
    deliveryCode: strictOutText(input, "delivery_code", "配送编码", 50),
    deliveryId: strictOutText(input, "delivery_id", "配送单号或电话", 64),
  };
}

function strictInvoiceInteger(
  input: Record<string, unknown>,
  key: string,
  fallback: number,
  label: string,
): number {
  const value = input[key];
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < -32_768 || parsed > 32_767) {
    throw new ValidateException(`${label}格式错误`);
  }
  return parsed;
}

function invoiceText(
  input: Record<string, unknown>,
  key: string,
  label: string,
  maxLength: number,
): string {
  const value = input[key];
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw new ValidateException(`${label}格式错误`);
  const normalized = value.trim();
  if ([...normalized].length > maxLength) throw new ValidateException(`${label}过长`);
  return normalized;
}

function invoiceScalarText(
  input: Record<string, unknown>,
  key: string,
  label: string,
  maxLength: number,
): string {
  const value = input[key];
  if (value === undefined || value === null || value === "" || value === 0) return "";
  if (typeof value !== "string" && typeof value !== "number") {
    throw new ValidateException(`${label}格式错误`);
  }
  const normalized = String(value).trim();
  if ([...normalized].length > maxLength) throw new ValidateException(`${label}过长`);
  return normalized;
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function normalizeOutInvoiceInput(input: Record<string, unknown>): OutInvoiceInput {
  const drawerPhone = invoiceText(input, "drawer_phone", "开票手机号", 30);
  if (!drawerPhone) throw new ValidateException("请填写开票手机号");
  if (!/^1[3456789]\d{9}$/.test(drawerPhone)) {
    throw new ValidateException("手机号格式不正确");
  }

  const name = invoiceText(input, "name", "发票抬头", 100);
  if (!name) throw new ValidateException("请填写发票抬头（开具发票企业名称）");
  const dutyNumber = invoiceText(input, "duty_number", "发票税号", 50);
  const requestedHeaderType = strictInvoiceInteger(input, "header_type", 1, "抬头类型");
  const headerType = (requestedHeaderType === 1 || requestedHeaderType === 2
    ? requestedHeaderType
    : dutyNumber ? 2 : 1) as 1 | 2;
  const nameBytes = utf8Length(name);
  if (
    headerType === 1
    && (!/^[^\x00-\x7F]+$/u.test(name) || nameBytes < 2 || nameBytes > 60)
  ) {
    throw new ValidateException("请填写发票抬头（开具发票企业名称）");
  }
  if (
    headerType === 2
    && (!/^[0-9A-Za-z&()（）\u0080-\u{10FFFF}]+$/u.test(name)
      || nameBytes < 2
      || nameBytes > 150)
  ) {
    throw new ValidateException("请填写发票抬头（开具发票企业名称）");
  }
  if (headerType === 2 && !dutyNumber) throw new ValidateException("请填写发票税号");
  if (headerType === 2 && !/^(?:[A-Z0-9]{15}|[A-Z0-9]{17}|[A-Z0-9]{18}|[A-Z0-9]{20})$/.test(dutyNumber)) {
    throw new ValidateException("请填写正确的发票税号");
  }

  const cardNumber = invoiceText(input, "card_number", "银行卡号", 50);
  if (cardNumber && !/^[1-9]\d{11,19}$/.test(cardNumber)) {
    throw new ValidateException("请填写正确的银行卡号");
  }
  return {
    headerType,
    type: strictInvoiceInteger(input, "type", 1, "发票类型"),
    drawerPhone,
    email: invoiceText(input, "email", "邮箱", 100),
    name,
    dutyNumber,
    tell: invoiceText(input, "tell", "企业电话", 30),
    address: invoiceText(input, "address", "企业地址", 255),
    bank: invoiceText(input, "bank", "开户行", 50),
    cardNumber,
  };
}

export function normalizeOutInvoiceStatusInput(
  input: Record<string, unknown>,
): OutInvoiceStatusInput {
  const state = strictInvoiceInteger(input, "is_invoice", 0, "开票状态");
  if (state !== -1 && state !== 0 && state !== 1) {
    throw new ValidateException("开票状态参数错误");
  }
  const invoiceNumber = invoiceScalarText(input, "invoice_number", "开票号", 50);
  if (state === 1 && !invoiceNumber) throw new ValidateException("请填写开票号");
  if (invoiceNumber && !/^\d{8,20}$/.test(invoiceNumber)) {
    throw new ValidateException("请填写正确的开票号");
  }
  return {
    isInvoice: state,
    invoiceNumber,
    remark: invoiceText(input, "remark", "开票备注", 255),
  };
}

async function sha256Json(value: unknown): Promise<string> {
  const material = JSON.stringify(value);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(material));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function fulfillmentRequestHash(input: {
  accountId: number;
  route: string;
  orderId: string;
  delivery: SupplierDeliveryInput;
  carts?: SupplierSplitCartInput[];
}): Promise<string> {
  const carts = input.carts
    ? [...input.carts].sort((a, b) => a.cartId.localeCompare(b.cartId))
    : undefined;
  return sha256Json({
    account_id: input.accountId,
    route: input.route,
    order_id: input.orderId,
    delivery: input.delivery,
    carts,
  });
}

function distributionReplayPrefix(accountId: number, requestHash: string): string {
  if (!Number.isSafeInteger(accountId) || accountId <= 0 || !/^[0-9a-f]{64}$/.test(requestHash)) {
    throw new ValidateException("外部配送修改请求摘要无效");
  }
  return `{"v":1,"account":${accountId},"request":"${requestHash}",`;
}

function parseDistributionReplay(
  message: string,
  accountId: number,
  requestHash: string,
): OutDistributionReplay | null {
  try {
    const parsed = JSON.parse(message) as Record<string, unknown>;
    if (
      parsed.v !== 1
      || parsed.account !== accountId
      || parsed.request !== requestHash
      || !Number.isSafeInteger(parsed.order_id)
      || Number(parsed.order_id) <= 0
      || !["express", "send", "fictitious"].includes(String(parsed.delivery_type))
    ) return null;
    return {
      orderId: Number(parsed.order_id),
      deliveryType: parsed.delivery_type as OutDistributionReplay["deliveryType"],
    };
  } catch {
    return null;
  }
}

async function findDistributionReplay(
  tx: DbClient,
  orderId: number,
  accountId: number,
  requestHash: string,
): Promise<OutDistributionReplay | null> {
  const prefix = distributionReplayPrefix(accountId, requestHash);
  const rows = await tx.select({ changeMessage: storeOrderStatus.changeMessage })
    .from(storeOrderStatus)
    .where(and(
      eq(storeOrderStatus.oid, orderId),
      eq(storeOrderStatus.changeType, "out_order_distribution"),
      sql`${storeOrderStatus.changeMessage} LIKE ${`${prefix}%`}`,
    ))
    .orderBy(desc(storeOrderStatus.id))
    .limit(2);
  const parsed = rows
    .map((row) => parseDistributionReplay(row.changeMessage, accountId, requestHash))
    .filter((row): row is OutDistributionReplay => row !== null);
  if (parsed.length > 1 && JSON.stringify(parsed[0]) !== JSON.stringify(parsed[1])) {
    throw new ValidateException("外部配送修改重放证据冲突，请先完成数据核对");
  }
  return parsed[0] ?? null;
}

async function recordDistributionReplay(
  tx: DbClient,
  orderId: number,
  accountId: number,
  requestHash: string,
  deliveryType: OutDistributionReplay["deliveryType"],
): Promise<void> {
  distributionReplayPrefix(accountId, requestHash);
  const changeMessage = JSON.stringify({
    v: 1,
    account: accountId,
    request: requestHash,
    order_id: orderId,
    delivery_type: deliveryType,
  });
  if (changeMessage.length > 256) throw new ValidateException("外部配送修改重放证据过长");
  await tx.insert(storeOrderStatus).values({
    oid: orderId,
    changeType: "out_order_distribution",
    changeMessage,
    changeTime: Math.floor(Date.now() / 1_000),
  });
}

function invoiceReplayPrefix(accountId: number, requestHash: string): string {
  if (!Number.isSafeInteger(accountId) || accountId <= 0 || !/^[0-9a-f]{64}$/.test(requestHash)) {
    throw new ValidateException("外部发票修改请求摘要无效");
  }
  return `{"v":1,"account":${accountId},"request":"${requestHash}",`;
}

function parseInvoiceReplay(
  message: string,
  accountId: number,
  requestHash: string,
): OutInvoiceReplay | null {
  try {
    const parsed = JSON.parse(message) as Record<string, unknown>;
    if (
      parsed.v !== 1
      || parsed.account !== accountId
      || parsed.request !== requestHash
      || !Number.isSafeInteger(parsed.order_id)
      || Number(parsed.order_id) <= 0
      || !Number.isSafeInteger(parsed.invoice_id)
      || Number(parsed.invoice_id) <= 0
      || ![-1, 0, 1].includes(Number(parsed.is_invoice))
    ) return null;
    return {
      orderId: Number(parsed.order_id),
      invoiceId: Number(parsed.invoice_id),
      isInvoice: Number(parsed.is_invoice) as OutInvoiceReplay["isInvoice"],
    };
  } catch {
    return null;
  }
}

async function findInvoiceReplay(
  tx: DbClient,
  orderId: number,
  accountId: number,
  requestHash: string,
  changeType: OutInvoiceChangeType,
): Promise<OutInvoiceReplay | null> {
  const prefix = invoiceReplayPrefix(accountId, requestHash);
  const rows = await tx.select({ changeMessage: storeOrderStatus.changeMessage })
    .from(storeOrderStatus)
    .where(and(
      eq(storeOrderStatus.oid, orderId),
      eq(storeOrderStatus.changeType, changeType),
      sql`${storeOrderStatus.changeMessage} LIKE ${`${prefix}%`}`,
    ))
    .orderBy(desc(storeOrderStatus.id))
    .limit(2);
  const parsed = rows
    .map((row) => parseInvoiceReplay(row.changeMessage, accountId, requestHash))
    .filter((row): row is OutInvoiceReplay => row !== null);
  if (parsed.length > 1 && JSON.stringify(parsed[0]) !== JSON.stringify(parsed[1])) {
    throw new ValidateException("外部发票修改重放证据冲突，请先完成数据核对");
  }
  return parsed[0] ?? null;
}

async function recordInvoiceReplay(
  tx: DbClient,
  orderId: number,
  accountId: number,
  requestHash: string,
  changeType: OutInvoiceChangeType,
  invoiceId: number,
  isInvoice: OutInvoiceReplay["isInvoice"],
): Promise<void> {
  invoiceReplayPrefix(accountId, requestHash);
  const changeMessage = JSON.stringify({
    v: 1,
    account: accountId,
    request: requestHash,
    order_id: orderId,
    invoice_id: invoiceId,
    is_invoice: isInvoice,
  });
  if (changeMessage.length > 256) throw new ValidateException("外部发票修改重放证据过长");
  await tx.insert(storeOrderStatus).values({
    oid: orderId,
    changeType,
    changeMessage,
    changeTime: Math.floor(Date.now() / 1_000),
  });
}

async function lockPlatformInvoiceOrder(tx: DbClient, orderId: string) {
  const references = await tx.select({ id: storeOrder.id, pid: storeOrder.pid })
    .from(storeOrder)
    .where(and(
      eq(storeOrder.orderId, orderId),
      eq(storeOrder.storeId, 0),
      eq(storeOrder.isSystemDel, 0),
      eq(storeOrder.isDel, 0),
    ))
    .limit(1);
  const reference = references[0];
  if (!reference) throw new NotFoundException("订单不存在");
  await lockOrderSettlement(tx, reference.pid > 0 ? reference.pid : reference.id);
  const rows = await tx.select({
    id: storeOrder.id,
    orderId: storeOrder.orderId,
    uid: storeOrder.uid,
  }).from(storeOrder).where(and(
    eq(storeOrder.id, reference.id),
    eq(storeOrder.orderId, orderId),
    eq(storeOrder.storeId, 0),
    eq(storeOrder.isSystemDel, 0),
    eq(storeOrder.isDel, 0),
  )).limit(1).for("update");
  if (!rows[0]) throw new NotFoundException("订单不存在");
  return rows[0];
}

async function lockSingleOrderInvoice(tx: DbClient, orderId: number, uid: number) {
  const rows = await tx.select().from(storeOrderInvoice).where(and(
    eq(storeOrderInvoice.orderId, orderId),
    eq(storeOrderInvoice.isDel, 0),
  )).orderBy(desc(storeOrderInvoice.id)).limit(2).for("update");
  if (rows.length === 0) throw new ValidateException("订单未提交开票申请");
  if (rows.length > 1) throw new ValidateException("订单存在重复开票申请，请先完成数据核对");
  const invoice = rows[0];
  if (invoice.uid !== uid || invoice.category !== "order") {
    throw new ValidateException("订单开票申请关联异常，请先完成数据核对");
  }
  return invoice;
}

function refundDecisionReplayPrefix(accountId: number, requestHash: string): string {
  if (!Number.isSafeInteger(accountId) || accountId <= 0 || !/^[0-9a-f]{64}$/.test(requestHash)) {
    throw new ValidateException("外部售后决策请求摘要无效");
  }
  return `{"v":1,"account":${accountId},"request":"${requestHash}",`;
}

function parseRefundDecisionReplay(
  message: string,
  accountId: number,
  requestHash: string,
): OutRefundDecisionReplay | null {
  try {
    const parsed = JSON.parse(message) as Record<string, unknown>;
    if (
      parsed.v !== 1
      || parsed.account !== accountId
      || parsed.request !== requestHash
      || !Number.isSafeInteger(parsed.order_id)
      || Number(parsed.order_id) <= 0
      || !Number.isSafeInteger(parsed.refund_id)
      || Number(parsed.refund_id) <= 0
      || ![3, 4].includes(Number(parsed.refund_type))
    ) return null;
    return {
      orderId: Number(parsed.order_id),
      refundId: Number(parsed.refund_id),
      refundType: Number(parsed.refund_type) as OutRefundDecisionReplay["refundType"],
    };
  } catch {
    return null;
  }
}

async function findRefundDecisionReplay(
  tx: DbClient,
  orderId: number,
  accountId: number,
  requestHash: string,
  changeType: OutRefundDecisionChangeType,
): Promise<OutRefundDecisionReplay | null> {
  const prefix = refundDecisionReplayPrefix(accountId, requestHash);
  const rows = await tx.select({ changeMessage: storeOrderStatus.changeMessage })
    .from(storeOrderStatus)
    .where(and(
      eq(storeOrderStatus.oid, orderId),
      eq(storeOrderStatus.changeType, changeType),
      sql`${storeOrderStatus.changeMessage} LIKE ${`${prefix}%`}`,
    ))
    .orderBy(desc(storeOrderStatus.id))
    .limit(2);
  const parsed = rows
    .map((row) => parseRefundDecisionReplay(row.changeMessage, accountId, requestHash))
    .filter((row): row is OutRefundDecisionReplay => row !== null);
  if (parsed.length > 1 && JSON.stringify(parsed[0]) !== JSON.stringify(parsed[1])) {
    throw new ValidateException("外部售后决策重放证据冲突，请先完成数据核对");
  }
  return parsed[0] ?? null;
}

async function recordRefundDecisionReplay(
  tx: DbClient,
  orderId: number,
  accountId: number,
  requestHash: string,
  changeType: OutRefundDecisionChangeType,
  refundId: number,
  refundType: OutRefundDecisionReplay["refundType"],
): Promise<void> {
  refundDecisionReplayPrefix(accountId, requestHash);
  const changeMessage = JSON.stringify({
    v: 1,
    account: accountId,
    request: requestHash,
    order_id: orderId,
    refund_id: refundId,
    refund_type: refundType,
  });
  if (changeMessage.length > 256) throw new ValidateException("外部售后决策重放证据过长");
  await tx.insert(storeOrderStatus).values({
    oid: orderId,
    changeType,
    changeMessage,
    changeTime: Math.floor(Date.now() / 1_000),
  });
}

async function lockPlatformRefundDecision(tx: DbClient, refundOrderId: string) {
  const references = await tx.select({
    refundId: storeOrderRefund.id,
    orderId: storeOrder.id,
    orderPid: storeOrder.pid,
  }).from(storeOrderRefund)
    .innerJoin(storeOrder, eq(storeOrder.id, storeOrderRefund.storeOrderId))
    .where(and(
      eq(storeOrderRefund.orderId, refundOrderId),
      eq(storeOrderRefund.storeId, 0),
      eq(storeOrderRefund.isCancel, 0),
      eq(storeOrderRefund.isDel, 0),
      eq(storeOrder.storeId, 0),
      eq(storeOrder.isSystemDel, 0),
      eq(storeOrder.isDel, 0),
    ))
    .orderBy(desc(storeOrderRefund.id))
    .limit(2);
  if (references.length === 0) throw new NotFoundException("售后订单不存在");
  if (references.length > 1) throw new ValidateException("售后单号存在重复记录，请先完成数据核对");
  const reference = references[0];
  await lockRefundExecution(tx, reference.refundId);
  await lockOrderSettlement(tx, reference.orderPid > 0 ? reference.orderPid : reference.orderId);

  const rows = await tx.select({
    refund: storeOrderRefund,
    order: storeOrder,
  }).from(storeOrderRefund)
    .innerJoin(storeOrder, eq(storeOrder.id, storeOrderRefund.storeOrderId))
    .where(and(
      eq(storeOrderRefund.id, reference.refundId),
      eq(storeOrderRefund.orderId, refundOrderId),
      eq(storeOrderRefund.storeId, 0),
      eq(storeOrderRefund.isCancel, 0),
      eq(storeOrderRefund.isDel, 0),
      eq(storeOrder.id, reference.orderId),
      eq(storeOrder.storeId, 0),
      eq(storeOrder.isSystemDel, 0),
      eq(storeOrder.isDel, 0),
    ))
    .limit(1)
    .for("update");
  if (!rows[0]) throw new NotFoundException("售后订单不存在");
  if (rows[0].refund.supplierId !== rows[0].order.supplierId) {
    throw new ValidateException("售后订单供应商关联异常，请先完成数据核对");
  }
  return rows[0];
}

async function assertRefundProviderDecisionAvailable(tx: DbClient, refundId: number): Promise<void> {
  const rows = await tx.select({ providerStatus: storeOrderRefundPayment.providerStatus })
    .from(storeOrderRefundPayment)
    .where(eq(storeOrderRefundPayment.refundId, refundId))
    .orderBy(desc(storeOrderRefundPayment.id))
    .limit(2)
    .for("update");
  if (rows.length > 1) throw new ValidateException("退款渠道状态存在重复记录，请先完成数据核对");
  if (rows[0] && !["CREATED", "FAILED", "CLOSED"].includes(rows[0].providerStatus)) {
    throw new ValidateException("渠道退款已发起或结果待确认，不能修改售后决策");
  }
}

function binaryFilter(value: unknown, name: string): number | undefined {
  const parsed = optionalInteger(value, name);
  if (parsed !== undefined && parsed !== 0 && parsed !== 1) {
    throw new ValidateException(`${name}参数错误`);
  }
  return parsed;
}

function idList(value: unknown): number[] {
  if (value === undefined || value === null || value === "") return [];
  const raw = Array.isArray(value) ? value : String(value).split(",");
  if (raw.length > MAX_ID_FILTERS) throw new ValidateException("uid数量超限");
  const ids = [...new Set(raw.map(Number))];
  if (ids.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
    throw new ValidateException("uid参数错误");
  }
  return ids;
}

function datePartEpoch(value: string, endOfDay: boolean): number | undefined {
  const text = value.trim();
  if (!text) return undefined;
  if (/^\d{10,13}$/.test(text)) {
    const numeric = Number(text);
    return text.length === 13 ? Math.floor(numeric / 1000) : numeric;
  }
  const day = text.match(/^(\d{4}-\d{2}-\d{2})$/)?.[1];
  const parsed = Date.parse(day
    ? `${day}T${endOfDay ? "23:59:59" : "00:00:00"}+08:00`
    : text);
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : undefined;
}

function dateRange(query: Record<string, unknown>): { start?: number; end?: number } {
  const directStart = query.start_time ?? query.start;
  const directEnd = query.end_time ?? query.end;
  if (directStart !== undefined || directEnd !== undefined) {
    const startText = filterText(directStart, "开始时间");
    const endText = filterText(directEnd, "结束时间");
    const start = datePartEpoch(startText, false);
    const end = datePartEpoch(endText, true);
    if ((startText && start === undefined) || (endText && end === undefined) ||
      (start !== undefined && end !== undefined && start > end)) {
      throw new ValidateException("时间范围参数错误");
    }
    return { start, end };
  }
  const source = filterText(query.data ?? query.time, "时间范围");
  if (!source) return {};
  const parts = source.split(/\s+(?:-|~|至)\s+|,/).map((item) => item.trim()).filter(Boolean);
  if (parts.length < 1 || parts.length > 2) throw new ValidateException("时间范围参数错误");
  const start = datePartEpoch(parts[0], false);
  const end = datePartEpoch(parts[1] ?? parts[0], true);
  if (start === undefined || end === undefined || start > end) {
    throw new ValidateException("时间范围参数错误");
  }
  return { start, end };
}

function parseSnapshot(value: string | null): unknown {
  if (!value || value.length > MAX_JSON_SNAPSHOT_BYTES) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function cartItem(row: CartRow) {
  const snapshot = record(parseSnapshot(row.cartInfo));
  const product = record(snapshot?.product);
  const productInfo = record(snapshot?.productInfo);
  const sku = record(snapshot?.sku);
  const attrInfo = record(productInfo?.attrInfo);
  return {
    cart_id: row.cartId,
    store_name: String(product?.storeName ?? product?.store_name ?? productInfo?.store_name ?? "商品快照"),
    suk: String(sku?.suk ?? attrInfo?.suk ?? row.skuUnique),
    image: String(product?.image ?? productInfo?.image ?? attrInfo?.image ?? ""),
    price: String(sku?.price ?? attrInfo?.price ?? snapshot?.truePrice ?? "0.00"),
    cart_num: row.cartNum,
    surplus_num: row.surplusNum,
    refund_num: row.refundNum,
  };
}

function orderStatusName(row: OrderRow): string {
  if (row.paid !== 1) return "待付款";
  if (row.refundStatus === 1 || [1, 2, 4, 5].includes(row.refundType)) return "申请退款中";
  if (row.refundStatus === 2 || row.refundType === 6) return "已退款";
  if (row.type === 3 && row.pinkId > 0 && row.status === 0) return "拼团中";
  if (row.status === 0) return row.shippingType === 2 ? "待核销" : "未发货";
  if (row.status === 1 || row.status === 4) return "待收货";
  if (row.status === 2) return "待评价";
  if (row.status === 3) return "交易完成";
  if (row.status === 5) return "部分核销";
  return "处理中";
}

function payTypeName(value: string): string {
  return ({
    yue: "余额支付",
    weixin: "微信支付",
    alipay: "支付宝支付",
    offline: "线下支付",
    zero: "零元支付",
    friend: "好友代付",
  } as Record<string, string>)[value] ?? value;
}

function refundTypeName(value: number): string {
  return ({
    0: "未处理",
    1: "仅退款",
    2: "退货退款",
    3: "已拒绝",
    4: "同意退货",
    5: "已退货",
    6: "已退款",
  } as Record<number, string>)[value] ?? "处理中";
}

function orderPublic(row: OrderRow, items: ReturnType<typeof cartItem>[]) {
  return {
    id: row.id,
    pid: row.pid,
    order_id: row.orderId,
    trade_no: row.tradeNo,
    uid: row.uid,
    freight_price: row.freightPrice,
    real_name: row.realName,
    user_phone: row.userPhone,
    user_address: row.userAddress,
    total_num: row.totalNum,
    total_price: row.totalPrice,
    total_postage: row.totalPostage,
    pay_price: row.payPrice,
    coupon_price: row.couponPrice,
    deduction_price: row.deductionPrice,
    paid: row.paid,
    pay_time: row.payTime,
    pay_type: row.payType,
    pay_type_name: payTypeName(row.payType),
    add_time: row.addTime,
    shipping_type: row.shippingType,
    status: row.status,
    status_name: orderStatusName(row),
    refund_status: row.refundStatus,
    refund_type: row.refundType,
    delivery_type: row.deliveryType,
    delivery_name: row.deliveryName,
    delivery_code: row.deliveryCode,
    delivery_id: row.deliveryId,
    type: row.type,
    pink_id: row.pinkId,
    use_integral: row.useIntegral,
    back_integral: row.backIntegral,
    items,
  };
}

function refundSelectedCartIds(value: string | null): Set<string> {
  const parsed = parseSnapshot(value);
  const selected = new Set<string>();
  const collect = (item: unknown) => {
    if (typeof item === "number" || typeof item === "string") selected.add(String(item));
    const entry = record(item);
    const id = entry?.cart_id ?? entry?.cartId ?? entry?.id;
    if (id !== undefined && id !== null && id !== "") selected.add(String(id));
  };
  if (Array.isArray(parsed)) parsed.forEach(collect);
  else {
    const data = record(parsed);
    const cartIds = data?.cartIds ?? data?.cart_ids;
    if (Array.isArray(cartIds)) cartIds.forEach(collect);
  }
  return selected;
}

function refundPublic(row: RefundRow, carts: CartRow[]) {
  const selected = refundSelectedCartIds(row.cartInfo);
  const eligible = selected.size
    ? carts.filter((cart) => selected.has(String(cart.id)) || selected.has(cart.cartId))
    : carts;
  return {
    id: row.id,
    store_order_id: row.storeOrderId,
    store_id: row.storeId,
    uid: row.uid,
    order_id: row.orderId,
    supplier_id: row.supplierId,
    apply_type: row.applyType,
    apply_price: row.applyPrice,
    refund_type: row.refundType,
    refund_type_name: refundTypeName(row.refundType),
    refund_num: row.refundNum,
    refund_price: row.refundPrice,
    pay_price: row.refundPrice,
    refunded_price: row.refundedPrice,
    refund_reason: row.refundReason,
    refund_goods_type: row.refundGoodsType,
    refund_phone: row.refundPhone,
    refund_express: row.refundExpress,
    refund_express_name: row.refundExpressName,
    refund_explain: row.refundExplain,
    refund_img: row.refundImg,
    refund_goods_explain: row.refundGoodsExplain,
    refund_goods_img: row.refundGoodsImg,
    refuse_reason: row.refuseReason,
    remark: row.remark,
    refunded_time: row.refundedTime,
    is_cancel: row.isCancel,
    is_del: row.isDel,
    add_time: row.addTime,
    items: eligible.map(cartItem),
  };
}

function safeUser(row: UserRow) {
  return {
    uid: row.uid,
    account: row.account,
    real_name: row.realName,
    birthday: row.birthday,
    mark: row.mark,
    group_id: row.groupId,
    nickname: row.nickname,
    avatar: row.avatar,
    phone: row.phone,
    add_time: row.addTime,
    last_time: row.lastTime,
    now_money: row.nowMoney,
    brokerage_price: row.brokeragePrice,
    integral: row.integral,
    exp: row.exp,
    status: row.status,
    status_name: row.status === 1 ? "正常" : "禁用",
    level: row.level,
    agent_level: row.agentLevel,
    spread_open: row.spreadOpen,
    spread_uid: row.spreadUid,
    spread_time: row.spreadTime,
    user_type: row.userType,
    is_promoter: row.isPromoter,
    pay_count: row.payCount,
    spread_count: row.spreadCount,
    addres: row.addres,
    is_money_level: row.isMoneyLevel,
    is_ever_level: row.isEverLevel,
    overdue_time: row.overdueTime,
    sex: row.sex,
    sex_name: row.sex === 1 ? "男" : row.sex === 2 ? "女" : "其他",
    provincials: row.provincials,
    province: row.province,
    city: row.city,
    area: row.area,
    street: row.street,
    is_first_order: row.isFirstOrder,
    is_newcomer: row.isNewcomer,
    division_name: row.divisionName,
    division_type: row.divisionType,
    division_status: row.divisionStatus,
    division_id: row.divisionId,
    agent_id: row.agentId,
    staff_id: row.staffId,
    division_percent: row.divisionPercent,
    division_end_time: row.divisionEndTime,
  };
}

function parseJsonDocument(value: string | null): unknown {
  if (value === null || value.trim() === "") return null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function issueSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function toSnakeKey(value: string): string {
  return value.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

function toSnakeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(toSnakeValue);
  if (!value || typeof value !== "object" || value instanceof Date) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, child]) => [
      toSnakeKey(key),
      toSnakeValue(child),
    ]),
  );
}

function outRuntimeStatus(method: string, url: string): "available_read" | "available_write" | "not_migrated" {
  const route = normalizeOutRoute(method, url);
  if (SUPPORTED_READ_ROUTES.has(route)) return "available_read";
  if (SUPPORTED_WRITE_ROUTES.has(route)) return "available_write";
  return "not_migrated";
}

function safeAccount(row: typeof outAccount.$inferSelect) {
  const rules = parseOutRules(row.rules);
  const hasBcryptVerifier = /^\$2[aby]\$/.test(row.appsecret);
  const legacyPlaintextPresent = row.apppwd.length > 0;
  const pushConfigured = Boolean(
    row.pushOpen || row.pushAccount || row.pushPassword || row.pushTokenUrl ||
      row.userUpdatePush || row.orderCreatePush || row.orderPayPush ||
      row.refundCreatePush || row.refundCancelPush,
  );
  return {
    id: row.id,
    appid: row.appid,
    title: row.title,
    status: row.status,
    rules,
    add_time: row.addTime,
    last_time: row.lastTime,
    is_del: row.isDel,
    credential_state: hasBcryptVerifier ? "hashed" : "invalid_or_missing_hash",
    legacy_plaintext_present: legacyPlaintextPresent,
    push_configured: pushConfigured,
    push_runtime: "not_migrated",
  };
}

export class OutApiService {
  constructor(
    private readonly container: Container,
    private readonly env: Env,
  ) {}

  async login(appidInput: string, appsecret: string, ip: string) {
    const appid = appidInput.trim();
    if (!appid || !appsecret || appid.length > 50 || appsecret.length > 128) {
      throw new ValidateException("appid或appsecret错误");
    }
    const rows = await this.container.db
      .select()
      .from(outAccount)
      .where(and(eq(outAccount.appid, appid), eq(outAccount.isDel, 0)))
      .orderBy(outAccount.id)
      .limit(2);
    const account = rows.length === 1 ? rows[0] : undefined;
    const verifier = account?.appsecret || DUMMY_BCRYPT_HASH;
    const valid = await compare(appsecret, normalizeBcryptHash(verifier)).catch(() => false);
    if (!account || !valid) throw new ValidateException("appid或appsecret错误");
    if (account.status !== 1) throw new ValidateException("账号已被禁用");

    const issued = await this.issueToken(account);
    await this.container.db
      .update(outAccount)
      .set({ lastTime: Math.floor(Date.now() / 1000), ip: ip.slice(0, 30) })
      .where(eq(outAccount.id, account.id));
    const authInfo = { id: account.id, appid: account.appid, title: account.title };
    return {
      token: issued.token,
      access_token: issued.token,
      exp_time: issued.exp,
      autInfo: authInfo,
      auth_info: authInfo,
    };
  }

  async refresh(token: string, ip: string) {
    const account = await this.authenticateToken(token);
    await clearToken(md5(token), this.env);
    const row = await this.accountRow(account.id);
    const issued = await this.issueToken(row);
    await this.container.db
      .update(outAccount)
      .set({ lastTime: Math.floor(Date.now() / 1000), ip: ip.slice(0, 30) })
      .where(eq(outAccount.id, row.id));
    return { token: issued.token, access_token: issued.token, exp_time: issued.exp };
  }

  async authenticateToken(token: string): Promise<AuthenticatedOutAccount> {
    if (!token || token === "undefined" || token === "null") {
      throw new AuthException("请登录");
    }
    const key = md5(token);
    if (this.env.UPSTASH_REDIS_URL && this.env.UPSTASH_REDIS_TOKEN) {
      const bucket = await getTokenBucket(key, this.env);
      if (!bucket || bucket.type !== "out" || bucket.token !== token) {
        throw new AuthException("登录已过期");
      }
    }
    let payload: Awaited<ReturnType<typeof verifyToken>>;
    try {
      payload = await verifyToken(token, this.env.APP_KEY);
    } catch {
      await clearToken(key, this.env).catch(() => undefined);
      throw new AuthException("登录已过期");
    }
    if (payload.type !== "out") throw new AuthException("暂无对外接口权限");
    const account = await this.accountRow(payload.id).catch(async (error: unknown) => {
      await clearToken(key, this.env).catch(() => undefined);
      throw error;
    });
    if (payload.auth !== md5(account.appsecret)) {
      await clearToken(key, this.env).catch(() => undefined);
      throw new AuthException("登录已过期");
    }
    return {
      id: account.id,
      appid: account.appid,
      title: account.title,
      rules: parseOutRules(account.rules),
    };
  }

  async assertInterfacePermission(
    account: AuthenticatedOutAccount,
    method: string,
    routeTemplate: string,
  ): Promise<void> {
    if (!account.rules.length) throw new AuthException("暂无对应接口权限");
    const rows = await this.container.db
      .select({ id: outInterface.id, method: outInterface.method, url: outInterface.url })
      .from(outInterface)
      .where(and(
        inArray(outInterface.id, account.rules),
        eq(outInterface.type, 1),
        eq(outInterface.isDel, 0),
      ));
    const expected = normalizeOutRoute(method, routeTemplate);
    if (!rows.some((row) => normalizeOutRoute(row.method, row.url) === expected)) {
      throw new AuthException("暂无对应接口权限");
    }
  }

  async categoryList(query: Record<string, unknown>) {
    const { page, limit } = pageValues(query);
    const filters = [eq(storeProductCategory.type, 0), eq(storeProductCategory.relationId, 0)];
    if (query.is_show !== undefined && query.is_show !== "") {
      filters.push(eq(storeProductCategory.isShow, Number(query.is_show)));
    }
    if (query.pid !== undefined && query.pid !== "") {
      filters.push(eq(storeProductCategory.pid, Number(query.pid)));
    }
    const keyword = String(query.cate_name ?? "").trim();
    if (keyword) filters.push(ilike(storeProductCategory.cateName, `%${keyword}%`));
    const where = and(...filters);
    const [rows, total] = await Promise.all([
      this.container.db.select().from(storeProductCategory).where(where)
        .orderBy(desc(storeProductCategory.sort), desc(storeProductCategory.id))
        .limit(limit).offset((page - 1) * limit),
      this.container.db.select({ count: count() }).from(storeProductCategory).where(where),
    ]);
    return { list: toSnakeValue(rows), count: Number(total[0]?.count ?? 0) };
  }

  async categoryInfo(idInput: unknown) {
    const id = positiveInteger(idInput);
    if (!id) throw new ValidateException("参数错误");
    const rows = await this.container.db.select().from(storeProductCategory)
      .where(and(
        eq(storeProductCategory.id, id),
        eq(storeProductCategory.type, 0),
        eq(storeProductCategory.relationId, 0),
      )).limit(1);
    if (!rows[0]) throw new NotFoundException("分类不存在");
    return toSnakeValue(rows[0]);
  }

  async productList(query: Record<string, unknown>) {
    const params: GoodsListParams = {
      store_name: String(query.store_name ?? "").trim() || undefined,
      cate_id: query.cate_id === undefined ? undefined : String(query.cate_id),
      news: query.is_new === undefined || query.is_new === "" ? undefined : Number(query.is_new),
      brand_id: query.brand_id === undefined ? undefined : String(query.brand_id),
      page: positiveInteger(query.page, 1),
      limit: Math.min(positiveInteger(query.limit, 20), MAX_PAGE_SIZE),
    };
    const result = await new StoreProductService(this.container, this.env).getGoodsList(params, 0);
    const list = result.list.map((row) => ({
      ...row,
      pages_url: `/pages/goods_details/index?id=${row.id}`,
    }));
    return { ...result, list, pages_url: "/pages/goods/goods_list/index" };
  }

  async productInfo(idInput: unknown) {
    const id = positiveInteger(idInput);
    if (!id) throw new ValidateException("参数错误");
    const product = await this.container.storeProductDao.getById(id);
    if (!product || product.isDel) throw new NotFoundException("商品不存在");
    return {
      ...(toSnakeValue(product) as Record<string, unknown>),
      pages_url: `/pages/goods_details/index?id=${id}`,
    };
  }

  async orderList(query: Record<string, unknown>) {
    const { page, limit } = pageValues(query);
    const filters: SQL[] = [
      eq(storeOrder.isSystemDel, 0),
      eq(storeOrder.storeId, 0),
    ];
    const isDel = binaryFilter(query.is_del, "删除状态") ?? 0;
    filters.push(eq(storeOrder.isDel, isDel));
    const paid = binaryFilter(query.paid, "支付状态");
    if (paid !== undefined) filters.push(eq(storeOrder.paid, paid));
    const status = optionalInteger(query.status, "订单状态");
    if (status !== undefined) filters.push(eq(storeOrder.status, status));
    const type = optionalInteger(query.type, "订单类型");
    if (type !== undefined) filters.push(eq(storeOrder.type, type));
    const supplierId = optionalInteger(query.supplier_id, "供应商");
    if (supplierId !== undefined) filters.push(eq(storeOrder.supplierId, supplierId));
    const payType = filterText(query.pay_type, "支付方式");
    if (payType) filters.push(eq(storeOrder.payType, payType));
    const keyword = filterText(query.real_name ?? query.field_key ?? query.keyword, "搜索词");
    if (keyword) {
      const search = or(
        ilike(storeOrder.orderId, `%${keyword}%`),
        ilike(storeOrder.tradeNo, `%${keyword}%`),
        ilike(storeOrder.realName, `%${keyword}%`),
        ilike(storeOrder.userPhone, `%${keyword}%`),
      );
      if (search) filters.push(search);
    }
    const range = dateRange(query);
    if (range.start !== undefined) filters.push(gte(storeOrder.addTime, range.start));
    if (range.end !== undefined) filters.push(lte(storeOrder.addTime, range.end));
    const where = and(...filters);
    const [rows, total] = await Promise.all([
      this.container.db.select().from(storeOrder).where(where)
        .orderBy(desc(storeOrder.addTime), desc(storeOrder.id))
        .limit(limit).offset((page - 1) * limit),
      this.container.db.select({ count: count() }).from(storeOrder).where(where),
    ]);
    const carts = await this.cartRowsByOrder(rows.map((row) => row.id));
    return {
      list: rows.map((row) => orderPublic(row, (carts.get(row.id) ?? []).map(cartItem))),
      count: Number(total[0]?.count ?? 0),
    };
  }

  async orderInfo(orderIdInput: unknown) {
    const orderId = filterText(orderIdInput, "订单号");
    if (!orderId) throw new ValidateException("参数错误");
    const rows = await this.container.db.select().from(storeOrder).where(and(
      eq(storeOrder.orderId, orderId),
      eq(storeOrder.storeId, 0),
      eq(storeOrder.isSystemDel, 0),
    )).limit(1);
    const row = rows[0];
    if (!row) throw new NotFoundException("订单不存在");
    const [carts, invoices] = await Promise.all([
      this.container.db.select().from(storeOrderCartInfo)
        .where(eq(storeOrderCartInfo.oid, row.id)).orderBy(storeOrderCartInfo.id),
      this.container.db.select({
        invoice_id: storeOrderInvoice.invoiceId,
        header_type: storeOrderInvoice.headerType,
        type: storeOrderInvoice.type,
        name: storeOrderInvoice.name,
        duty_number: storeOrderInvoice.dutyNumber,
        drawer_phone: storeOrderInvoice.drawerPhone,
        email: storeOrderInvoice.email,
        tell: storeOrderInvoice.tell,
        address: storeOrderInvoice.address,
        bank: storeOrderInvoice.bank,
        card_number: storeOrderInvoice.cardNumber,
        is_pay: storeOrderInvoice.isPay,
        is_refund: storeOrderInvoice.isRefund,
        is_invoice: storeOrderInvoice.isInvoice,
        invoice_number: storeOrderInvoice.invoiceNumber,
        invoice_amount: storeOrderInvoice.invoiceAmount,
        remark: storeOrderInvoice.remark,
        invoice_time: storeOrderInvoice.invoiceTime,
      }).from(storeOrderInvoice).where(and(
        eq(storeOrderInvoice.orderId, row.id),
        eq(storeOrderInvoice.isDel, 0),
      )).orderBy(desc(storeOrderInvoice.id)).limit(1),
    ]);
    return {
      ...orderPublic(row, carts.map(cartItem)),
      invoice: invoices[0] ?? null,
    };
  }

  async expressList() {
    const rows = await this.container.db.select({
      id: expressCompany.id,
      code: expressCompany.code,
      name: expressCompany.name,
      sort: expressCompany.sort,
    }).from(expressCompany).where(and(
      eq(expressCompany.isShow, 1),
      eq(expressCompany.status, 1),
    )).orderBy(desc(expressCompany.sort), expressCompany.id);
    return rows;
  }

  async splitCartInfo(orderIdInput: unknown) {
    const orderId = filterText(orderIdInput, "订单号");
    if (!orderId) throw new ValidateException("参数错误");
    const orders = await this.container.db.select({ id: storeOrder.id }).from(storeOrder).where(and(
      eq(storeOrder.orderId, orderId),
      eq(storeOrder.storeId, 0),
      eq(storeOrder.isSystemDel, 0),
    )).limit(1);
    if (!orders[0]) throw new NotFoundException("订单不存在");
    const rows = await this.container.db.select().from(storeOrderCartInfo)
      .where(eq(storeOrderCartInfo.oid, orders[0].id)).orderBy(storeOrderCartInfo.id);
    return rows.map((row) => ({
      ...cartItem(row),
      id: row.id,
      old_cart_id: row.oldCartId,
      split_surplus_num: row.splitSurplusNum,
      split_status: row.splitStatus,
    }));
  }

  async refundList(query: Record<string, unknown>) {
    const { page, limit } = pageValues(query);
    const filters: SQL[] = [
      eq(storeOrderRefund.storeId, 0),
      eq(storeOrderRefund.isCancel, 0),
      eq(storeOrderRefund.isDel, 0),
    ];
    const refundType = optionalInteger(query.refund_type, "退款状态");
    if (refundType !== undefined) filters.push(eq(storeOrderRefund.refundType, refundType));
    const keyword = filterText(query.order_id ?? query.keyword, "退款单号");
    if (keyword) filters.push(ilike(storeOrderRefund.orderId, `%${keyword}%`));
    const range = dateRange(query);
    if (range.start !== undefined) filters.push(gte(storeOrderRefund.addTime, range.start));
    if (range.end !== undefined) filters.push(lte(storeOrderRefund.addTime, range.end));
    const where = and(...filters);
    const [rows, total] = await Promise.all([
      this.container.db.select().from(storeOrderRefund).where(where)
        .orderBy(desc(storeOrderRefund.addTime), desc(storeOrderRefund.id))
        .limit(limit).offset((page - 1) * limit),
      this.container.db.select({ count: count() }).from(storeOrderRefund).where(where),
    ]);
    const carts = await this.cartRowsByOrder(rows.map((row) => row.storeOrderId));
    return {
      list: rows.map((row) => refundPublic(row, carts.get(row.storeOrderId) ?? [])),
      count: Number(total[0]?.count ?? 0),
    };
  }

  async refundInfo(orderIdInput: unknown) {
    const orderId = filterText(orderIdInput, "退款单号");
    if (!orderId) throw new ValidateException("参数错误");
    const rows = await this.container.db.select().from(storeOrderRefund).where(and(
      eq(storeOrderRefund.orderId, orderId),
      eq(storeOrderRefund.storeId, 0),
      eq(storeOrderRefund.isCancel, 0),
      eq(storeOrderRefund.isDel, 0),
    )).limit(1);
    const row = rows[0];
    if (!row) throw new NotFoundException("退款单不存在");
    const carts = await this.container.db.select().from(storeOrderCartInfo)
      .where(eq(storeOrderCartInfo.oid, row.storeOrderId)).orderBy(storeOrderCartInfo.id);
    return refundPublic(row, carts);
  }

  async couponList(query: Record<string, unknown>) {
    const { page, limit } = pageValues(query);
    const filters: SQL[] = [eq(storeCouponIssue.isDel, 0)];
    const status = optionalInteger(query.status, "优惠券状态") ?? 1;
    filters.push(eq(storeCouponIssue.status, status));
    const receiveType = optionalInteger(query.receive_type, "领取方式");
    if (receiveType !== undefined) filters.push(eq(storeCouponIssue.receiveType, receiveType));
    const couponType = optionalInteger(query.coupon_type, "适用类型");
    if (couponType !== undefined) filters.push(eq(storeCouponIssue.couponType, couponType));
    const type = optionalInteger(query.type, "优惠类型");
    if (type !== undefined) filters.push(eq(storeCouponIssue.type, type));
    const keyword = filterText(query.coupon_title ?? query.keyword, "优惠券名称");
    if (keyword) filters.push(ilike(storeCouponIssue.couponTitle, `%${keyword}%`));
    const where = and(...filters);
    const [rows, total] = await Promise.all([
      this.container.db.select().from(storeCouponIssue).where(where)
        .orderBy(desc(storeCouponIssue.sort), desc(storeCouponIssue.id))
        .limit(limit).offset((page - 1) * limit),
      this.container.db.select({ count: count() }).from(storeCouponIssue).where(where),
    ]);
    return {
      list: rows.map((row) => ({
        ...(toSnakeValue(row) as Record<string, unknown>),
        coupon_time: row.day > 0 ? `${row.day}天` : "固定有效期",
      })),
      count: Number(total[0]?.count ?? 0),
      pages_url: "/pages/activity/coupon/index",
    };
  }

  async userLevelList(query: Record<string, unknown>) {
    const { page, limit } = pageValues(query);
    const filters: SQL[] = [eq(systemUserLevel.isDel, 0)];
    const isShow = binaryFilter(query.is_show, "显示状态");
    if (isShow !== undefined) filters.push(eq(systemUserLevel.isShow, isShow));
    const keyword = filterText(query.title ?? query.name ?? query.keyword, "等级名称");
    if (keyword) filters.push(ilike(systemUserLevel.name, `%${keyword}%`));
    const where = and(...filters);
    const [rows, total] = await Promise.all([
      this.container.db.select().from(systemUserLevel).where(where)
        .orderBy(systemUserLevel.grade, systemUserLevel.id)
        .limit(limit).offset((page - 1) * limit),
      this.container.db.select({ count: count() }).from(systemUserLevel).where(where),
    ]);
    return { list: toSnakeValue(rows), count: Number(total[0]?.count ?? 0) };
  }

  async userList(query: Record<string, unknown>) {
    const { page, limit } = pageValues(query);
    const filters: SQL[] = [eq(user.isDel, 0), isNull(user.deleteTime)];
    const ids = idList(query.uid);
    if (ids.length) filters.push(inArray(user.uid, ids));
    const status = binaryFilter(query.status, "用户状态");
    if (status !== undefined) filters.push(eq(user.status, status));
    const level = optionalInteger(query.level, "用户等级");
    if (level !== undefined) filters.push(eq(user.level, level));
    const keyword = filterText(query.keyword, "搜索词");
    if (keyword) {
      const search = or(
        ilike(user.account, `%${keyword}%`),
        ilike(user.realName, `%${keyword}%`),
        ilike(user.nickname, `%${keyword}%`),
        ilike(user.phone, `%${keyword}%`),
      );
      if (search) filters.push(search);
    }
    const where = and(...filters);
    const [rows, total] = await Promise.all([
      this.container.db.select().from(user).where(where)
        .orderBy(desc(user.uid)).limit(limit).offset((page - 1) * limit),
      this.container.db.select({ count: count() }).from(user).where(where),
    ]);
    return { list: rows.map(safeUser), count: Number(total[0]?.count ?? 0) };
  }

  async userInfo(uidInput: unknown) {
    const uid = positiveInteger(uidInput);
    if (!uid) throw new ValidateException("参数错误");
    const rows = await this.container.db.select().from(user).where(and(
      eq(user.uid, uid),
      eq(user.isDel, 0),
      isNull(user.deleteTime),
    )).limit(1);
    if (!rows[0]) throw new NotFoundException("用户不存在");
    return { data: safeUser(rows[0]) };
  }

  async updateOrderRemark(
    account: AuthenticatedOutAccount,
    orderIdInput: unknown,
    remarkInput: unknown,
  ) {
    const orderId = filterText(orderIdInput, "订单号");
    const remark = String(remarkInput ?? "").trim();
    if (!orderId) throw new ValidateException("参数错误");
    if (!remark) throw new ValidateException("请输入要备注的内容");
    if (remark.length > 512) throw new ValidateException("备注不能超过512个字符");
    const now = Math.floor(Date.now() / 1000);
    return withTx(this.container, async (tx) => {
      const rows = await tx.select({
        id: storeOrder.id,
        orderId: storeOrder.orderId,
        remark: storeOrder.remark,
      }).from(storeOrder).where(and(
        eq(storeOrder.orderId, orderId),
        eq(storeOrder.storeId, 0),
        eq(storeOrder.isSystemDel, 0),
        eq(storeOrder.isDel, 0),
      )).limit(1).for("update");
      const order = rows[0];
      if (!order) throw new NotFoundException("修改的订单不存在");
      if (order.remark === remark) {
        return { id: order.id, order_id: order.orderId, idempotent: true };
      }
      await tx.update(storeOrder).set({ remark }).where(eq(storeOrder.id, order.id));
      await tx.insert(storeOrderStatus).values({
        oid: order.id,
        changeType: "out_order_remark",
        changeMessage: `Out API account ${account.id} updated order remark`,
        changeTime: now,
      });
      return { id: order.id, order_id: order.orderId, idempotent: false };
    });
  }

  private async platformFulfillmentOrder(orderIdInput: unknown) {
    const orderId = filterText(orderIdInput, "订单号");
    if (!orderId) throw new ValidateException("参数错误");
    const rows = await withTx(this.container, async (tx) => tx.select({
      id: storeOrder.id,
      orderId: storeOrder.orderId,
      supplierId: storeOrder.supplierId,
    }).from(storeOrder).where(and(
      eq(storeOrder.orderId, orderId),
      eq(storeOrder.storeId, 0),
      eq(storeOrder.isSystemDel, 0),
      eq(storeOrder.isDel, 0),
    )).limit(1));
    if (!rows[0]) throw new NotFoundException("订单不存在");
    return rows[0];
  }

  async deliverOrder(
    account: AuthenticatedOutAccount,
    orderIdInput: unknown,
    body: Record<string, unknown>,
  ) {
    const order = await this.platformFulfillmentOrder(orderIdInput);
    const delivery = normalizeOutDeliveryInput(body);
    const requestHash = await fulfillmentRequestHash({
      accountId: account.id,
      route: "/order/delivery/{order_id}",
      orderId: order.orderId,
      delivery,
    });
    const result = await new SupplierFulfillmentService(this.container, this.env).deliver(
      order.supplierId,
      order.id,
      delivery,
      {
        expectedStoreId: 0,
        replay: { accountId: account.id, requestHash, changeType: "out_order_delivery" },
      },
    );
    return {
      id: order.id,
      order_id: order.orderId,
      delivery_order_id: result.order_id,
      split: result.split,
      remaining_order_id: result.remaining_order_id,
      idempotent: result.idempotent,
    };
  }

  async splitDeliverOrder(
    account: AuthenticatedOutAccount,
    orderIdInput: unknown,
    body: Record<string, unknown>,
  ) {
    const order = await this.platformFulfillmentOrder(orderIdInput);
    const delivery = normalizeOutDeliveryInput(body);
    const carts = normalizeSupplierSplitCartInput(body)
      .sort((a, b) => a.cartId.localeCompare(b.cartId));
    const requestHash = await fulfillmentRequestHash({
      accountId: account.id,
      route: "/order/split_delivery/{order_id}",
      orderId: order.orderId,
      delivery,
      carts,
    });
    const result = await new SupplierFulfillmentService(this.container, this.env).splitDelivery(
      order.supplierId,
      order.id,
      delivery,
      carts,
      {
        expectedStoreId: 0,
        replay: { accountId: account.id, requestHash, changeType: "out_order_split_delivery" },
      },
    );
    return {
      id: order.id,
      order_id: order.orderId,
      delivery_order_id: result.order_id,
      split: result.split,
      remaining_order_id: result.remaining_order_id,
      idempotent: result.idempotent,
    };
  }

  async updateOrderDistribution(
    account: AuthenticatedOutAccount,
    orderIdInput: unknown,
    body: Record<string, unknown>,
  ) {
    const orderId = filterText(orderIdInput, "订单号");
    if (!orderId) throw new ValidateException("参数错误");
    const input = normalizeOutDistributionInput(body);
    const requestHash = await sha256Json({
      account_id: account.id,
      route: "/order/distribution/{order_id}",
      order_id: orderId,
      distribution: input,
    });

    return withTx(this.container, async (tx) => {
      const references = await tx.select({ id: storeOrder.id, pid: storeOrder.pid })
        .from(storeOrder)
        .where(and(
          eq(storeOrder.orderId, orderId),
          eq(storeOrder.storeId, 0),
          eq(storeOrder.isSystemDel, 0),
          eq(storeOrder.isDel, 0),
        ))
        .limit(1);
      const reference = references[0];
      if (!reference) throw new NotFoundException("订单不存在");
      const rootId = reference.pid > 0 ? reference.pid : reference.id;
      await lockOrderSettlement(tx, rootId);

      const rows = await tx.select({
        id: storeOrder.id,
        orderId: storeOrder.orderId,
        paid: storeOrder.paid,
        status: storeOrder.status,
        deliveryType: storeOrder.deliveryType,
        deliveryName: storeOrder.deliveryName,
        deliveryCode: storeOrder.deliveryCode,
        deliveryId: storeOrder.deliveryId,
        deliveryUid: storeOrder.deliveryUid,
      }).from(storeOrder).where(and(
        eq(storeOrder.id, reference.id),
        eq(storeOrder.orderId, orderId),
        eq(storeOrder.storeId, 0),
        eq(storeOrder.isSystemDel, 0),
        eq(storeOrder.isDel, 0),
      )).limit(1).for("update");
      const order = rows[0];
      if (!order) throw new NotFoundException("订单不存在");

      const replay = await findDistributionReplay(tx, order.id, account.id, requestHash);
      if (replay) {
        if (replay.orderId !== order.id) {
          throw new ValidateException("外部配送修改重放证据冲突，请先完成数据核对");
        }
        return {
          id: replay.orderId,
          order_id: order.orderId,
          delivery_type: replay.deliveryType,
          idempotent: true,
        };
      }
      if (order.paid !== 1 || order.status <= 0) {
        throw new ValidateException("未发货，请先发货再修改配送信息");
      }
      if (!["express", "send", "fictitious"].includes(order.deliveryType)) {
        throw new ValidateException("未发货，请先发货再修改配送信息");
      }
      const deliveryType = order.deliveryType as OutDistributionReplay["deliveryType"];
      let deliveryName = input.deliveryName;
      let deliveryId = input.deliveryId;
      if (deliveryType === "express") {
        if (!deliveryName) throw new ValidateException("请选择快递公司");
        if (!deliveryId) throw new ValidateException("请输入快递单号");
      } else if (deliveryType === "send") {
        if (!deliveryName) throw new ValidateException("请输入送货人姓名");
        if (!deliveryId) throw new ValidateException("请输入送货人电话号码");
        if (order.deliveryUid <= 0) throw new ValidateException("订单缺少已分配配送员");
        const identities = await tx.select({
          id: deliveryService.id,
          nickname: deliveryService.nickname,
          phone: deliveryService.phone,
        }).from(deliveryService)
          .innerJoin(user, eq(user.uid, deliveryService.uid))
          .where(and(
          eq(deliveryService.uid, order.deliveryUid),
          eq(deliveryService.type, 0),
          eq(deliveryService.relationId, 0),
          eq(deliveryService.status, 1),
          eq(deliveryService.isDel, 0),
          eq(user.status, 1),
          eq(user.isDel, 0),
          isNull(user.deleteTime),
        )).orderBy(desc(deliveryService.id)).limit(2).for("key share");
        if (identities.length !== 1) {
          throw new ValidateException("已分配配送员无效或身份存在重复");
        }
        const authoritativeName = identities[0].nickname.trim();
        const authoritativePhone = identities[0].phone.trim();
        if (deliveryName !== authoritativeName || deliveryId !== authoritativePhone) {
          throw new ValidateException("送货人信息必须与当前已分配配送员一致");
        }
        deliveryName = authoritativeName;
        deliveryId = authoritativePhone;
      }

      const unchanged = order.deliveryName === deliveryName
        && order.deliveryCode === input.deliveryCode
        && order.deliveryId === deliveryId;
      if (!unchanged) {
        const updated = await tx.update(storeOrder).set({
          deliveryName,
          deliveryCode: input.deliveryCode,
          deliveryId,
        }).where(and(
          eq(storeOrder.id, order.id),
          eq(storeOrder.storeId, 0),
          eq(storeOrder.isSystemDel, 0),
          eq(storeOrder.isDel, 0),
          eq(storeOrder.paid, 1),
          eq(storeOrder.deliveryType, deliveryType),
          sql`${storeOrder.status} > 0`,
        )).returning({ id: storeOrder.id });
        if (!updated[0]) throw new ValidateException("订单配送信息已被处理，请刷新后重试");
        await tx.insert(storeOrderStatus).values({
          oid: order.id,
          changeType: "distribution",
          changeMessage: `Out API account ${account.id} updated ${deliveryType} delivery metadata`,
          changeTime: Math.floor(Date.now() / 1_000),
        });
      }
      await recordDistributionReplay(tx, order.id, account.id, requestHash, deliveryType);
      return {
        id: order.id,
        order_id: order.orderId,
        delivery_type: deliveryType,
        idempotent: unchanged,
      };
    });
  }

  async updateOrderInvoice(
    account: AuthenticatedOutAccount,
    orderIdInput: unknown,
    body: Record<string, unknown>,
  ) {
    const orderId = filterText(orderIdInput, "订单号");
    if (!orderId) throw new ValidateException("参数错误");
    const input = normalizeOutInvoiceInput(body);
    const requestHash = await sha256Json({
      account_id: account.id,
      route: "/order/invoice/{order_id}",
      order_id: orderId,
      invoice: input,
    });

    return withTx(this.container, async (tx) => {
      const order = await lockPlatformInvoiceOrder(tx, orderId);
      const replay = await findInvoiceReplay(
        tx,
        order.id,
        account.id,
        requestHash,
        "out_order_invoice",
      );
      if (replay) {
        if (replay.orderId !== order.id) {
          throw new ValidateException("外部发票修改重放证据冲突，请先完成数据核对");
        }
        return {
          id: replay.orderId,
          order_id: order.orderId,
          invoice_id: replay.invoiceId,
          is_invoice: replay.isInvoice,
          idempotent: true,
        };
      }

      const invoice = await lockSingleOrderInvoice(tx, order.id, order.uid);
      if (![-1, 0, 1].includes(invoice.isInvoice)) {
        throw new ValidateException("订单开票状态异常，请先完成数据核对");
      }
      const unchanged = invoice.headerType === input.headerType
        && invoice.type === input.type
        && invoice.drawerPhone === input.drawerPhone
        && invoice.email === input.email
        && invoice.name === input.name
        && invoice.dutyNumber === input.dutyNumber
        && invoice.tell === input.tell
        && invoice.address === input.address
        && invoice.bank === input.bank
        && invoice.cardNumber === input.cardNumber;
      if (!unchanged) {
        const updated = await tx.update(storeOrderInvoice).set({
          headerType: input.headerType,
          type: input.type,
          drawerPhone: input.drawerPhone,
          email: input.email,
          name: input.name,
          dutyNumber: input.dutyNumber,
          tell: input.tell,
          address: input.address,
          bank: input.bank,
          cardNumber: input.cardNumber,
          invoiceTime: Math.floor(Date.now() / 1_000),
        }).where(and(
          eq(storeOrderInvoice.id, invoice.id),
          eq(storeOrderInvoice.orderId, order.id),
          eq(storeOrderInvoice.uid, order.uid),
          eq(storeOrderInvoice.category, "order"),
          eq(storeOrderInvoice.isDel, 0),
        )).returning({ id: storeOrderInvoice.id });
        if (!updated[0]) throw new ValidateException("订单开票申请已被处理，请刷新后重试");
        await tx.insert(storeOrderStatus).values({
          oid: order.id,
          changeType: "invoice",
          changeMessage: `Out API account ${account.id} updated invoice applicant metadata`,
          changeTime: Math.floor(Date.now() / 1_000),
        });
      }
      const isInvoice = invoice.isInvoice as OutInvoiceReplay["isInvoice"];
      await recordInvoiceReplay(
        tx,
        order.id,
        account.id,
        requestHash,
        "out_order_invoice",
        invoice.id,
        isInvoice,
      );
      return {
        id: order.id,
        order_id: order.orderId,
        invoice_id: invoice.id,
        is_invoice: isInvoice,
        idempotent: unchanged,
      };
    });
  }

  async updateOrderInvoiceStatus(
    account: AuthenticatedOutAccount,
    orderIdInput: unknown,
    body: Record<string, unknown>,
  ) {
    const orderId = filterText(orderIdInput, "订单号");
    if (!orderId) throw new ValidateException("参数错误");
    const input = normalizeOutInvoiceStatusInput(body);
    const requestHash = await sha256Json({
      account_id: account.id,
      route: "/order/invoice_status/{order_id}",
      order_id: orderId,
      invoice_status: input,
    });

    return withTx(this.container, async (tx) => {
      const order = await lockPlatformInvoiceOrder(tx, orderId);
      const replay = await findInvoiceReplay(
        tx,
        order.id,
        account.id,
        requestHash,
        "out_order_invoice_status",
      );
      if (replay) {
        if (replay.orderId !== order.id) {
          throw new ValidateException("外部发票修改重放证据冲突，请先完成数据核对");
        }
        return {
          id: replay.orderId,
          order_id: order.orderId,
          invoice_id: replay.invoiceId,
          is_invoice: replay.isInvoice,
          idempotent: true,
        };
      }

      const invoice = await lockSingleOrderInvoice(tx, order.id, order.uid);
      const unchanged = invoice.isInvoice === input.isInvoice
        && invoice.invoiceNumber === input.invoiceNumber
        && invoice.remark === input.remark;
      if (!unchanged) {
        const updated = await tx.update(storeOrderInvoice).set({
          isInvoice: input.isInvoice,
          invoiceNumber: input.invoiceNumber,
          remark: input.remark,
          invoiceTime: Math.floor(Date.now() / 1_000),
        }).where(and(
          eq(storeOrderInvoice.id, invoice.id),
          eq(storeOrderInvoice.orderId, order.id),
          eq(storeOrderInvoice.uid, order.uid),
          eq(storeOrderInvoice.category, "order"),
          eq(storeOrderInvoice.isDel, 0),
        )).returning({ id: storeOrderInvoice.id });
        if (!updated[0]) throw new ValidateException("订单开票申请已被处理，请刷新后重试");
        await tx.insert(storeOrderStatus).values({
          oid: order.id,
          changeType: "invoice_status",
          changeMessage: `Out API account ${account.id} updated invoice processing state to ${input.isInvoice}`,
          changeTime: Math.floor(Date.now() / 1_000),
        });
      }
      await recordInvoiceReplay(
        tx,
        order.id,
        account.id,
        requestHash,
        "out_order_invoice_status",
        invoice.id,
        input.isInvoice,
      );
      return {
        id: order.id,
        order_id: order.orderId,
        invoice_id: invoice.id,
        is_invoice: input.isInvoice,
        idempotent: unchanged,
      };
    });
  }

  async receiveOrder(
    account: AuthenticatedOutAccount,
    orderIdInput: unknown,
  ) {
    const orderId = filterText(orderIdInput, "订单号");
    if (!orderId) throw new ValidateException("参数错误");
    const rows = await withTx(this.container, async (tx) => tx.select({
      id: storeOrder.id,
      orderId: storeOrder.orderId,
      uid: storeOrder.uid,
      paid: storeOrder.paid,
      status: storeOrder.status,
      pid: storeOrder.pid,
      supplierAllocationStatus: storeOrder.supplierAllocationStatus,
      shippingType: storeOrder.shippingType,
      deliveryType: storeOrder.deliveryType,
      refundStatus: storeOrder.refundStatus,
    }).from(storeOrder).where(and(
      eq(storeOrder.orderId, orderId),
      eq(storeOrder.storeId, 0),
      eq(storeOrder.isSystemDel, 0),
      eq(storeOrder.isDel, 0),
    )).limit(1));
    const order = rows[0];
    if (!order) throw new NotFoundException("订单不存在");
    if (order.status >= 2) {
      return { id: order.id, order_id: order.orderId, idempotent: true };
    }
    if (order.pid === -1 || order.supplierAllocationStatus === 1) {
      throw new ValidateException("请从拆分后的履约订单确认收货");
    }
    if (order.paid !== 1) throw new ValidateException("订单未支付");
    if (order.shippingType === 2 || order.deliveryType === "send") {
      throw new ValidateException("该订单必须使用核销码完成履约");
    }
    if (order.status !== 1) throw new ValidateException("订单状态不允许收货");
    if (![0, 3].includes(order.refundStatus)) {
      throw new ValidateException("订单退款状态不允许收货");
    }

    const completed = await completeOrderReceipt(this.container, this.env, {
      orderId: order.id,
      actor: "user",
      actorId: order.uid,
      expectedStoreId: 0,
      requireSystemVisible: true,
      message: `Out API account ${account.id} confirmed order receipt`,
    });
    if (completed) {
      return { id: order.id, order_id: order.orderId, idempotent: false };
    }

    const latest = await withTx(this.container, async (tx) => tx.select({
      status: storeOrder.status,
    }).from(storeOrder).where(and(
      eq(storeOrder.id, order.id),
      eq(storeOrder.storeId, 0),
      eq(storeOrder.isSystemDel, 0),
      eq(storeOrder.isDel, 0),
    )).limit(1));
    if ((latest[0]?.status ?? -1) >= 2) {
      return { id: order.id, order_id: order.orderId, idempotent: true };
    }
    throw new ValidateException("订单已被处理");
  }

  async updateRefundRemark(
    account: AuthenticatedOutAccount,
    refundOrderIdInput: unknown,
    remarkInput: unknown,
  ) {
    const refundOrderId = filterText(refundOrderIdInput, "退款单号");
    const remark = String(remarkInput ?? "").trim();
    if (!refundOrderId) throw new ValidateException("参数错误");
    if (!remark) throw new ValidateException("请输入要备注的内容");
    if (remark.length > 255) throw new ValidateException("备注不能超过255个字符");
    const now = Math.floor(Date.now() / 1000);
    return withTx(this.container, async (tx) => {
      const rows = await tx.select({
        id: storeOrderRefund.id,
        storeOrderId: storeOrderRefund.storeOrderId,
        orderId: storeOrderRefund.orderId,
        remark: storeOrderRefund.remark,
      }).from(storeOrderRefund).where(and(
        eq(storeOrderRefund.orderId, refundOrderId),
        eq(storeOrderRefund.storeId, 0),
        eq(storeOrderRefund.isCancel, 0),
        eq(storeOrderRefund.isDel, 0),
      )).limit(1).for("update");
      const refund = rows[0];
      if (!refund) throw new NotFoundException("修改的售后订单不存在");
      if (refund.remark === remark) {
        return { id: refund.id, order_id: refund.orderId, idempotent: true };
      }
      await tx.update(storeOrderRefund).set({ remark }).where(eq(storeOrderRefund.id, refund.id));
      await tx.insert(storeOrderStatus).values({
        oid: refund.storeOrderId,
        changeType: "out_refund_remark",
        changeMessage: `Out API account ${account.id} updated refund remark`,
        changeTime: now,
      });
      return { id: refund.id, order_id: refund.orderId, idempotent: false };
    });
  }

  async agreeRefundReturn(
    account: AuthenticatedOutAccount,
    refundOrderIdInput: unknown,
  ) {
    const refundOrderId = filterText(refundOrderIdInput, "退款单号");
    if (!refundOrderId) throw new ValidateException("参数错误");
    const requestHash = await sha256Json({
      account_id: account.id,
      route: "/refund/agree/{order_id}",
      refund_order_id: refundOrderId,
    });
    return withTx(this.container, async (tx) => {
      const { refund, order } = await lockPlatformRefundDecision(tx, refundOrderId);
      const replay = await findRefundDecisionReplay(
        tx,
        order.id,
        account.id,
        requestHash,
        "out_refund_agree",
      );
      if (replay) {
        if (replay.orderId !== order.id || replay.refundId !== refund.id) {
          throw new ValidateException("外部售后决策重放证据冲突，请先完成数据核对");
        }
        return {
          id: replay.refundId,
          order_id: refund.orderId,
          refund_type: replay.refundType,
          idempotent: true,
        };
      }
      if (![2, 3].includes(refund.applyType)) {
        throw new ValidateException("该售后类型不需要退货");
      }
      if (refund.refundType === 4) {
        await recordRefundDecisionReplay(
          tx,
          order.id,
          account.id,
          requestHash,
          "out_refund_agree",
          refund.id,
          4,
        );
        return { id: refund.id, order_id: refund.orderId, refund_type: 4, idempotent: true };
      }
      if (![0, 1, 2].includes(refund.refundType)) {
        throw new ValidateException("售后状态不允许同意退货");
      }
      await assertRefundProviderDecisionAvailable(tx, refund.id);
      const updated = await tx.update(storeOrderRefund).set({ refundType: 4 }).where(and(
        eq(storeOrderRefund.id, refund.id),
        eq(storeOrderRefund.storeOrderId, order.id),
        eq(storeOrderRefund.storeId, 0),
        eq(storeOrderRefund.refundType, refund.refundType),
        eq(storeOrderRefund.isCancel, 0),
        eq(storeOrderRefund.isDel, 0),
      )).returning({ id: storeOrderRefund.id });
      if (!updated[0]) throw new ValidateException("售后记录已被处理");
      const orderUpdated = await tx.update(storeOrder).set({
        refundStatus: 1,
        refundType: 4,
      }).where(and(
        eq(storeOrder.id, order.id),
        eq(storeOrder.storeId, 0),
        eq(storeOrder.isSystemDel, 0),
        eq(storeOrder.isDel, 0),
      )).returning({ id: storeOrder.id });
      if (!orderUpdated[0]) throw new ValidateException("订单已被处理");
      await tx.insert(storeOrderStatus).values({
        oid: order.id,
        changeType: "agree_refund_return",
        changeMessage: `Out API account ${account.id} approved return shipment`,
        changeTime: Math.floor(Date.now() / 1_000),
      });
      await recordRefundDecisionReplay(
        tx,
        order.id,
        account.id,
        requestHash,
        "out_refund_agree",
        refund.id,
        4,
      );
      return { id: refund.id, order_id: refund.orderId, refund_type: 4, idempotent: false };
    });
  }

  async refuseRefund(
    account: AuthenticatedOutAccount,
    refundOrderIdInput: unknown,
    body: Record<string, unknown>,
  ) {
    const refundOrderId = filterText(refundOrderIdInput, "退款单号");
    if (!refundOrderId) throw new ValidateException("参数错误");
    const reason = strictOutText(body, "refund_reason", "不退款原因", 255);
    if (!reason) throw new ValidateException("请输入不退款原因");
    return this.refuseRefundDecision(
      account,
      refundOrderId,
      reason,
      "/refund/refuse/{order_id}",
    );
  }

  /**
   * Legacy PUT /refund/{order_id}.
   *
   * The PHP controller exposed cumulative partial refunds on one after-sale
   * row, but the same request immediately changed that row to refund_type=6
   * and performed all completion side effects, making a second installment
   * unreachable and unsafe.  The migrated contract therefore requires the
   * request amount to equal the immutable amount of this refund row; genuine
   * partial refunds remain represented by distinct after-sale rows.
   */
  async refundPrice(
    account: AuthenticatedOutAccount,
    refundOrderIdInput: unknown,
    body: Record<string, unknown>,
  ) {
    const refundOrderId = filterText(refundOrderIdInput, "退款单号");
    if (!refundOrderId) throw new ValidateException("参数错误");
    const action = normalizeOutRefundPriceAction(body);
    if (action.type === 2) {
      const refused = await this.refuseRefundDecision(
        account,
        refundOrderId,
        action.refuseReason,
        "/refund/{order_id}",
      );
      return { ...refused, completed: true, refund_status: "REFUSED" as const };
    }

    // Authorization and mutable identity are captured under the same short
    // lock order used by the non-monetary refund decisions. No provider call
    // is made while this transaction is open.
    const snapshot = await withTx(this.container, async (tx) =>
      lockPlatformRefundDecision(tx, refundOrderId));
    const { refund, order } = snapshot;
    if (
      refund.refundType !== 6 &&
      ![0, 1, 2, 5].includes(refund.refundType) &&
      !(refund.refundType === 4 && refund.applyType === 3)
    ) {
      throw new ValidateException("售后订单状态不支持该操作");
    }
    if (refund.uid !== order.uid || refund.supplierId !== order.supplierId) {
      throw new ValidateException("售后记录与订单归属不一致，请先完成数据核对");
    }

    const authoritativeCents = amountToCents(refund.refundPrice);
    if (authoritativeCents === null) throw new ValidateException("售后单退款金额无效");
    const requestedCents = action.refundAmountCents ?? (authoritativeCents === 0 ? 0 : null);
    if (requestedCents === null) throw new ValidateException("请输入退款金额");
    if (requestedCents !== authoritativeCents) {
      throw new ValidateException("退款金额必须等于本售后单可退金额；部分退款请拆分为独立售后单");
    }
    if (
      refund.refundType === 6 &&
      amountToCents(refund.refundedPrice) !== authoritativeCents
    ) {
      throw new ValidateException("历史已退款金额与售后单金额不一致，请先人工核对");
    }

    const scope: RefundExecutionScope = {
      expectedStoreId: 0,
      expectedSupplierId: refund.supplierId,
      expectedUid: refund.uid,
      expectedRefundOrderId: refund.orderId,
      expectedStoreOrderId: order.id,
      expectedRefundAmountCents: authoritativeCents,
      requireSystemVisible: true,
      requirePaid: true,
    };
    const result = await new StoreOrderRefundService(this.container, this.env)
      .agreeRefund(refund.id, scope);
    return {
      id: refund.id,
      order_id: refund.orderId,
      refund_type: result.completed ? 6 : refund.refundType,
      completed: result.completed,
      refund_status: result.status,
      idempotent: refund.refundType === 6,
    };
  }

  private async refuseRefundDecision(
    account: AuthenticatedOutAccount,
    refundOrderId: string,
    reason: string,
    route: "/refund/refuse/{order_id}" | "/refund/{order_id}",
  ) {
    const requestHash = await sha256Json({
      account_id: account.id,
      route,
      refund_order_id: refundOrderId,
      refund_reason: reason,
    });
    return withTx(this.container, async (tx) => {
      const { refund, order } = await lockPlatformRefundDecision(tx, refundOrderId);
      const replay = await findRefundDecisionReplay(
        tx,
        order.id,
        account.id,
        requestHash,
        "out_refund_refuse",
      );
      if (replay) {
        if (replay.orderId !== order.id || replay.refundId !== refund.id) {
          throw new ValidateException("外部售后决策重放证据冲突，请先完成数据核对");
        }
        return {
          id: replay.refundId,
          order_id: refund.orderId,
          refund_type: replay.refundType,
          idempotent: true,
        };
      }
      if (refund.refundType === 3) {
        if (refund.refuseReason !== reason) {
          throw new ValidateException("售后已按其他原因拒绝，不能覆盖原决策");
        }
        await recordRefundDecisionReplay(
          tx,
          order.id,
          account.id,
          requestHash,
          "out_refund_refuse",
          refund.id,
          3,
        );
        return { id: refund.id, order_id: refund.orderId, refund_type: 3, idempotent: true };
      }
      if (![0, 1, 2, 4, 5].includes(refund.refundType)) {
        throw new ValidateException("售后状态不允许拒绝");
      }
      await assertRefundProviderDecisionAvailable(tx, refund.id);
      const now = Math.floor(Date.now() / 1_000);
      const updated = await tx.update(storeOrderRefund).set({
        refundType: 3,
        refuseReason: reason,
        refundedTime: now,
      }).where(and(
        eq(storeOrderRefund.id, refund.id),
        eq(storeOrderRefund.storeOrderId, order.id),
        eq(storeOrderRefund.storeId, 0),
        eq(storeOrderRefund.refundType, refund.refundType),
        eq(storeOrderRefund.isCancel, 0),
        eq(storeOrderRefund.isDel, 0),
      )).returning({ id: storeOrderRefund.id });
      if (!updated[0]) throw new ValidateException("售后记录已被处理");
      const orderUpdated = await tx.update(storeOrder).set({
        refundStatus: 0,
        refundType: 3,
      }).where(and(
        eq(storeOrder.id, order.id),
        eq(storeOrder.storeId, 0),
        eq(storeOrder.isSystemDel, 0),
        eq(storeOrder.isDel, 0),
      )).returning({ id: storeOrder.id });
      if (!orderUpdated[0]) throw new ValidateException("订单已被处理");
      await tx.insert(storeOrderStatus).values({
        oid: order.id,
        changeType: "refund_n",
        changeMessage: `Out API account ${account.id} refused after-sale application`,
        changeTime: now,
      });
      await enqueueOrderRefundRefusedNoticeEvent(tx, {
        orderId: order.id,
        orderNo: order.orderId,
        refundId: refund.id,
        userId: order.uid,
        payPrice: order.payPrice,
      }, now);
      await recordRefundDecisionReplay(
        tx,
        order.id,
        account.id,
        requestHash,
        "out_refund_refuse",
        refund.id,
        3,
      );
      return { id: refund.id, order_id: refund.orderId, refund_type: 3, idempotent: false };
    });
  }

  async recordAccessAudit(input: OutApiAuditInput): Promise<void> {
    const hashes = [input.resourceHash, input.ipHash, input.userAgentHash];
    if (hashes.some((value) => value !== "" && !/^[0-9a-f]{64}$/.test(value))) {
      throw new Error("invalid Out API audit digest");
    }
    await this.container.db.insert(outApiAudit).values({
      outAccountId: input.account.id,
      appidSnapshot: input.account.appid.slice(0, 50),
      method: input.method.trim().toUpperCase().slice(0, 12),
      routeTemplate: input.routeTemplate.trim().slice(0, 128),
      operation: input.operation,
      resourceHash: input.resourceHash,
      queryFields: input.queryFields.slice(0, 255),
      ipHash: input.ipHash,
      userAgentHash: input.userAgentHash,
      outcome: input.outcome,
      resultCode: Math.max(0, Math.min(999_999, Math.trunc(input.resultCode))),
      durationMs: Math.max(0, Math.min(3_600_000, Math.trunc(input.durationMs))),
      addTime: Math.floor(Date.now() / 1000),
    });
  }

  async adminAuditList(query: Record<string, unknown>) {
    const { page, limit } = pageValues(query);
    const filters: SQL[] = [];
    const accountId = positiveInteger(query.out_account_id ?? query.account_id);
    if (accountId) filters.push(eq(outApiAudit.outAccountId, accountId));
    const method = filterText(query.method, "请求方法").toUpperCase();
    if (method) filters.push(eq(outApiAudit.method, method));
    const operation = filterText(query.operation, "操作类型");
    if (operation) {
      if (!new Set(["read", "write"]).has(operation)) throw new ValidateException("操作类型参数错误");
      filters.push(eq(outApiAudit.operation, operation));
    }
    const outcome = filterText(query.outcome, "结果");
    if (outcome) {
      if (!new Set(["success", "denied", "rate_limited", "error"]).has(outcome)) {
        throw new ValidateException("结果参数错误");
      }
      filters.push(eq(outApiAudit.outcome, outcome));
    }
    const route = filterText(query.route, "路由");
    if (route) filters.push(ilike(outApiAudit.routeTemplate, `%${route}%`));
    const range = dateRange(query);
    if (range.start !== undefined) filters.push(gte(outApiAudit.addTime, range.start));
    if (range.end !== undefined) filters.push(lte(outApiAudit.addTime, range.end));
    const where = filters.length ? and(...filters) : undefined;
    const [rows, total] = await Promise.all([
      this.container.db.select().from(outApiAudit).where(where)
        .orderBy(desc(outApiAudit.id)).limit(limit).offset((page - 1) * limit),
      this.container.db.select({ count: count() }).from(outApiAudit).where(where),
    ]);
    return {
      list: rows.map((row) => ({
        id: row.id,
        out_account_id: row.outAccountId,
        appid: row.appidSnapshot,
        method: row.method,
        route_template: row.routeTemplate,
        operation: row.operation,
        resource_hash: row.resourceHash.slice(0, 16),
        query_fields: row.queryFields,
        ip_hash: row.ipHash.slice(0, 16),
        user_agent_hash: row.userAgentHash.slice(0, 16),
        outcome: row.outcome,
        result_code: row.resultCode,
        duration_ms: row.durationMs,
        add_time: row.addTime,
      })),
      count: Number(total[0]?.count ?? 0),
    };
  }

  async adminAccounts(query: Record<string, unknown>) {
    const { page, limit } = pageValues(query);
    const filters = [eq(outAccount.isDel, 0)];
    const keyword = String(query.name ?? query.keyword ?? "").trim();
    if (keyword) {
      const search = or(
        ilike(outAccount.appid, `%${keyword}%`),
        ilike(outAccount.title, `%${keyword}%`),
      );
      if (search) filters.push(search);
    }
    if (query.status !== undefined && query.status !== "") {
      filters.push(eq(outAccount.status, Number(query.status)));
    }
    const where = and(...filters);
    const [rows, total] = await Promise.all([
      this.container.db.select().from(outAccount).where(where)
        .orderBy(desc(outAccount.id)).limit(limit).offset((page - 1) * limit),
      this.container.db.select({ count: count() }).from(outAccount).where(where),
    ]);
    return { list: rows.map(safeAccount), count: Number(total[0]?.count ?? 0) };
  }

  async adminAccountInfo(idInput: unknown) {
    const row = await this.accountRow(positiveInteger(idInput), false);
    return safeAccount(row);
  }

  async adminInterfaces() {
    const rows = await this.container.db.select().from(outInterface)
      .where(eq(outInterface.isDel, 0))
      .orderBy(outInterface.pid, outInterface.id);
    const items = rows.map((row) => ({
      id: row.id,
      pid: row.pid,
      type: row.type,
      name: row.name,
      title: row.name,
      method: row.method,
      url: row.url,
      runtime_status: row.type === 1 ? outRuntimeStatus(row.method, row.url) : "group",
    }));
    return items.filter((item) => item.pid === 0).map((root) => ({
      ...root,
      children: items.filter((item) => item.pid === root.id),
    }));
  }

  async adminInterfaceInfo(idInput: unknown) {
    const id = positiveInteger(idInput);
    const rows = id
      ? await this.container.db.select().from(outInterface).where(eq(outInterface.id, id)).limit(1)
      : [];
    const row = rows[0];
    if (!row || row.isDel) throw new NotFoundException("接口不存在");
    return {
      id: row.id,
      pid: row.pid,
      type: row.type,
      name: row.name,
      describe: row.describe,
      method: row.method,
      url: row.url,
      request_params: parseJsonDocument(row.requestParams),
      return_params: parseJsonDocument(row.returnParams),
      request_example: parseJsonDocument(row.requestExample),
      return_example: parseJsonDocument(row.returnExample),
      error_code: parseJsonDocument(row.errorCode),
      runtime_status: outRuntimeStatus(row.method, row.url),
    };
  }

  async saveAdminAccount(idInput: unknown, input: Record<string, unknown>) {
    const id = positiveInteger(idInput);
    const existing = id ? await this.accountRow(id, false) : null;
    const appid = String(input.appid ?? existing?.appid ?? "").trim();
    const title = String(input.title ?? existing?.title ?? "").trim();
    const status = Number(input.status ?? existing?.status ?? 1);
    if (!/^[A-Za-z0-9._:-]{3,50}$/.test(appid)) {
      throw new ValidateException("appid须为3-50位字母、数字或._:-");
    }
    if (title.length > 200) throw new ValidateException("描述不能超过200个字符");
    if (![1, 2].includes(status)) throw new ValidateException("状态只能为1或2");
    const rules = input.rules === undefined ? parseOutRules(existing?.rules) : parseOutRules(input.rules);
    await this.validateRuleIds(rules);

    if (Object.hasOwn(input, "appsecret")) {
      throw new ValidateException("不接受自定义appsecret，请使用服务端生成或轮换");
    }
    const rotate = input.rotate_secret === true || input.rotate_secret === 1 || input.rotate_secret === "1";
    const issuedSecret = !existing || rotate ? issueSecret() : "";
    const verifier = issuedSecret ? await hash(issuedSecret, BCRYPT_COST) : existing?.appsecret;
    if (!verifier) throw new ValidateException("缺少appsecret");
    const now = Math.floor(Date.now() / 1000);

    const savedId = await withTx(this.container, async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`out_account:${appid.toLowerCase()}`}))`);
      const duplicates = await tx.select({ id: outAccount.id }).from(outAccount)
        .where(and(
          sql`lower(${outAccount.appid}) = lower(${appid})`,
          eq(outAccount.isDel, 0),
          id ? sql`${outAccount.id} <> ${id}` : sql`true`,
        )).limit(1);
      if (duplicates.length) throw new ValidateException("appid已存在");
      if (existing) {
        await tx.update(outAccount).set({
          appid,
          appsecret: verifier,
          apppwd: "",
          title,
          status,
          rules: JSON.stringify(rules),
        }).where(eq(outAccount.id, existing.id));
        return existing.id;
      }
      const inserted = await tx.insert(outAccount).values({
        appid,
        appsecret: verifier,
        apppwd: "",
        title,
        status,
        rules: JSON.stringify(rules),
        addTime: now,
      }).returning({ id: outAccount.id });
      return inserted[0].id;
    });
    return {
      id: savedId,
      issued_secret: issuedSecret || undefined,
      secret_display: issuedSecret ? "once" : "unchanged",
    };
  }

  async setAdminAccountStatus(idInput: unknown, statusInput: unknown) {
    const id = positiveInteger(idInput);
    const status = Number(statusInput);
    if (!id || ![1, 2].includes(status)) throw new ValidateException("参数错误");
    await this.accountRow(id, false);
    await this.container.db.update(outAccount).set({ status }).where(eq(outAccount.id, id));
    return { id, status };
  }

  async deleteAdminAccount(idInput: unknown) {
    const id = positiveInteger(idInput);
    if (!id) throw new ValidateException("参数错误");
    await this.accountRow(id, false);
    await this.container.db.update(outAccount).set({ isDel: 1, status: 2, apppwd: "" })
      .where(eq(outAccount.id, id));
  }

  private async issueToken(account: typeof outAccount.$inferSelect) {
    const issued = await createToken(account.id, "out", md5(account.appsecret), this.env.APP_KEY);
    const saved = await setTokenBucket(md5(issued.token), {
      uid: account.id,
      type: "out",
      token: issued.token,
      exp: issued.exp - Math.floor(Date.now() / 1000) + 60,
    }, this.env);
    if (!saved) throw new Error("token保存失败");
    return issued;
  }

  private async cartRowsByOrder(orderIds: number[]): Promise<Map<number, CartRow[]>> {
    const uniqueIds = [...new Set(orderIds.filter((id) => Number.isSafeInteger(id) && id > 0))];
    if (!uniqueIds.length) return new Map();
    const rows = await this.container.db.select().from(storeOrderCartInfo)
      .where(inArray(storeOrderCartInfo.oid, uniqueIds)).orderBy(storeOrderCartInfo.oid, storeOrderCartInfo.id);
    const grouped = new Map<number, CartRow[]>();
    for (const row of rows) {
      const group = grouped.get(row.oid) ?? [];
      group.push(row);
      grouped.set(row.oid, group);
    }
    return grouped;
  }

  private async accountRow(id: number, activeOnly = true) {
    if (!id) throw new NotFoundException("对外账号不存在");
    const filters = [eq(outAccount.id, id), eq(outAccount.isDel, 0)];
    if (activeOnly) filters.push(eq(outAccount.status, 1));
    const rows = await this.container.db.select().from(outAccount).where(and(...filters)).limit(1);
    if (!rows[0]) throw new NotFoundException(activeOnly ? "对外账号不存在或已禁用" : "对外账号不存在");
    return rows[0];
  }

  private async validateRuleIds(rules: number[]): Promise<void> {
    if (rules.length > MAX_RULES) throw new ValidateException("接口权限数量超限");
    if (!rules.length) return;
    const rows = await this.container.db.select({ id: outInterface.id }).from(outInterface)
      .where(and(inArray(outInterface.id, rules), eq(outInterface.type, 1), eq(outInterface.isDel, 0)));
    const found = new Set(rows.map((row) => row.id));
    const missing = rules.filter((id) => !found.has(id));
    if (missing.length) throw new ValidateException(`接口权限不存在: ${missing.join(",")}`);
  }
}
