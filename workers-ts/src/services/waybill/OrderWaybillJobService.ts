import {
  and,
  asc,
  desc,
  eq,
  inArray,
  lt,
  lte,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import type { Env, OrderMessage, OrderWaybillJobMessage } from "@/env";
import type { Container, DbClient } from "@/lib/di";
import { withTx } from "@/lib/di";
import {
  expressCompany,
  orderWaybillJob,
  orderWaybillJobAction,
  storeConfig,
  storeOrder,
  storeOrderCartInfo,
  systemConfig,
  type OrderWaybillJobActionType,
  type OrderWaybillJobStatus,
} from "@/models/schema";
import {
  normalizeSupplierSplitCartInput,
  SupplierFulfillmentService,
  type SupplierSplitCartInput,
} from "@/services/supplier/SupplierFulfillmentService";
import {
  issueCrmebOnePassWaybill,
  WaybillConfigurationError,
  WaybillPreflightError,
  WaybillRejectedError,
  type WaybillCarrierSnapshot,
  type WaybillIssueInput,
  type WaybillIssueResult,
} from "@/services/waybill/CrmebOnePassWaybillProvider";
import { normalizeConfigScalar } from "@/utils/config";
import { NotFoundException, ValidateException } from "@/utils/errors";

const QUEUE_LEASE_SECONDS = 5 * 60;
const PROVIDER_LEASE_SECONDS = 2 * 60;
const MAX_PROVIDER_ATTEMPTS = 5;
const MAX_MANUAL_REPLAYS = 20;
const STORE_CONFIG_SCOPE_TYPE = 2;
const REQUEST_KEY_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACTIVE_STATUSES: OrderWaybillJobStatus[] = [
  "PENDING", "ENQUEUING", "ENQUEUED", "PROCESSING", "RETRYABLE",
];
const BLOCKING_STATUSES: OrderWaybillJobStatus[] = [...ACTIVE_STATUSES, "UNKNOWN", "DEAD"];
const JOB_STATUSES = new Set<OrderWaybillJobStatus>([
  ...ACTIVE_STATUSES, "SENT", "UNKNOWN", "DEAD", "CLOSED",
]);

const PLATFORM_CONFIG_KEYS = [
  "config_export_open",
  "config_export_id",
  "config_export_temp_id",
  "config_export_to_name",
  "config_export_to_tel",
  "config_export_to_address",
  "config_export_siid",
] as const;

const SUPPLIER_CONFIG_KEYS = [
  "store_config_export_open",
  "store_config_export_id",
  "store_config_export_temp_id",
  "store_config_export_to_name",
  "store_config_export_to_tel",
  "store_config_export_to_address",
  "store_config_export_siid",
] as const;

export type WaybillActor =
  | { actorType: "admin"; actorId: number }
  | { actorType: "supplier"; actorId: number; supplierId: number };

export interface CreateWaybillInput extends Record<string, unknown> {
  request_key?: unknown;
  requestKey?: unknown;
}

export interface WaybillJobListQuery {
  status?: string;
  supplierId?: number;
  orderId?: number;
  afterId?: number;
  limit?: number;
}

export interface WaybillOperationInput {
  requestKey: unknown;
  reason: unknown;
  trackingNumber?: unknown;
  labelUrl?: unknown;
  providerReference?: unknown;
}

interface ClaimedWaybillJob {
  id: number;
  eventKey: string;
  attemptCount: number;
  leaseToken: string;
}

type ProcessingResult =
  | "sent"
  | "retry-scheduled"
  | "unknown"
  | "dead"
  | "closed"
  | "already-sent"
  | "busy";

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 1_000);
}

function positiveInt(value: unknown, label: string, maximum = 2_147_483_647): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > maximum) {
    throw new ValidateException(`${label}无效`);
  }
  return parsed;
}

function optionalPositiveInt(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return positiveInt(value, label);
}

function uuid4(value: unknown, label = "请求键"): string {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!REQUEST_KEY_PATTERN.test(normalized)) throw new ValidateException(`${label}必须是 UUIDv4`);
  return normalized;
}

function boundedText(
  value: unknown,
  label: string,
  maximum: number,
  minimum = 0,
): string {
  if (typeof value !== "string" && typeof value !== "number") {
    throw new ValidateException(`${label}格式错误`);
  }
  const normalized = String(value).trim();
  const length = [...normalized].length;
  if (
    length < minimum || length > maximum ||
    /[\u0000-\u001f\u007f]/.test(normalized)
  ) throw new ValidateException(`${label}长度必须为${minimum}到${maximum}个可见字符`);
  return normalized;
}

function optionalText(value: unknown, label: string, maximum: number): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return boundedText(value, label, maximum, 1);
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function retryDelaySeconds(attemptCount: number): number {
  return Math.min(60 * 2 ** Math.max(attemptCount - 1, 0), 30 * 60);
}

function scalar(value: string | undefined): string {
  return normalizeConfigScalar(value).trim();
}

function enabled(value: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes(scalar(value).toLowerCase());
}

function projection(row: typeof orderWaybillJob.$inferSelect) {
  return {
    id: row.id,
    event_key: row.eventKey,
    order_id: row.orderId,
    order_no: row.orderNo,
    root_order_id: row.rootOrderId,
    supplier_id: row.supplierId,
    actor_type: row.actorType,
    actor_id: row.actorId,
    fulfillment_mode: row.fulfillmentMode,
    carrier_id: row.carrierId,
    carrier_code: row.carrierCode,
    carrier_name: row.carrierName,
    template_id: row.templateId,
    has_cloud_printer: !!row.cloudPrinterId,
    status: row.status,
    dispatch_count: row.dispatchCount,
    attempt_count: row.attemptCount,
    replay_count: row.replayCount,
    available_time: row.availableTime,
    lease_until: row.leaseUntil,
    provider_reference: row.providerReference,
    response_code: row.responseCode,
    tracking_number: row.trackingNumber,
    label_url: row.labelUrl,
    payload_hash: row.payloadHash,
    fulfilled_order_id: row.fulfilledOrderId,
    remaining_order_id: row.remainingOrderId || null,
    last_error: row.lastError,
    sent_time: row.sentTime,
    add_time: row.addTime,
    update_time: row.updateTime,
  };
}

function assertActor(actor: WaybillActor): void {
  if (!Number.isSafeInteger(actor.actorId) || actor.actorId <= 0) throw new Error("waybill actor missing");
  if (actor.actorType === "supplier" && (
    !Number.isSafeInteger(actor.supplierId) || actor.supplierId <= 0
  )) throw new Error("waybill supplier missing");
}

function actorCanAccess(actor: WaybillActor, supplierId: number): boolean {
  return actor.actorType === "admin" || actor.supplierId === supplierId;
}

function normalizeCartSelection(input: Record<string, unknown>): SupplierSplitCartInput[] {
  const mode = String(input.fulfillment_mode ?? input.fulfillmentMode ?? "whole").trim().toLowerCase();
  if (!['whole', 'split'].includes(mode)) throw new ValidateException("电子面单发货范围无效");
  if (mode === "whole") {
    if (Array.isArray(input.cart_ids) && input.cart_ids.length) {
      throw new ValidateException("整单签发不能同时提交拆分商品");
    }
    return [];
  }
  return normalizeSupplierSplitCartInput(input)
    .sort((left, right) => left.cartId.localeCompare(right.cartId));
}

function canonicalRequest(orderReference: string, input: Record<string, unknown>) {
  const carts = normalizeCartSelection(input);
  return {
    order_reference: orderReference,
    fulfillment_mode: carts.length ? "split" : "whole",
    cart_ids: carts,
    carrier_id: input.carrier_id ?? input.carrierId ?? null,
    template_id: input.template_id ?? input.templateId ?? null,
    sender_name: input.sender_name ?? input.senderName ?? null,
    sender_phone: input.sender_phone ?? input.senderPhone ?? null,
    sender_address: input.sender_address ?? input.senderAddress ?? null,
    cloud_printer_id: input.cloud_printer_id ?? input.cloudPrinterId ?? null,
  };
}

async function platformConfig(tx: DbClient): Promise<Record<string, string>> {
  const rows = await tx.select({
    key: systemConfig.menuName,
    value: systemConfig.value,
  }).from(systemConfig).where(and(
    eq(systemConfig.isStore, 0),
    inArray(systemConfig.menuName, [...PLATFORM_CONFIG_KEYS]),
  )).orderBy(asc(systemConfig.sort), asc(systemConfig.id));
  const values: Record<string, string> = {};
  for (const row of rows) values[row.key] = scalar(row.value);
  return values;
}

async function supplierConfig(tx: DbClient, supplierId: number): Promise<Record<string, string>> {
  const rows = await tx.select({ key: storeConfig.keyName, value: storeConfig.value })
    .from(storeConfig).where(and(
      eq(storeConfig.type, STORE_CONFIG_SCOPE_TYPE),
      eq(storeConfig.relationId, supplierId),
      inArray(storeConfig.keyName, [...SUPPLIER_CONFIG_KEYS]),
    )).orderBy(asc(storeConfig.id));
  const values: Record<string, string> = {};
  for (const row of rows) {
    if (Object.prototype.hasOwnProperty.call(values, row.key)) {
      throw new ValidateException(`配置 ${row.key} 存在重复历史记录，请先清理`);
    }
    values[row.key] = scalar(row.value);
  }
  return values;
}

function configValue(
  values: Record<string, string>,
  actor: WaybillActor,
  suffix: "open" | "id" | "temp_id" | "to_name" | "to_tel" | "to_address" | "siid",
): string {
  return values[actor.actorType === "supplier"
    ? `store_config_export_${suffix}`
    : `config_export_${suffix}`] ?? "";
}

function carrierSnapshot(row: typeof expressCompany.$inferSelect): WaybillCarrierSnapshot {
  const snapshot = {
    partnerId: row.partnerId === 1,
    partnerKey: row.partnerKey === 1,
    net: row.net === 1,
    checkMan: row.checkMan === 1,
    partnerName: row.partnerName === 1,
    isCode: row.isCode === 1,
    account: row.account.trim(),
    key: row.key.trim(),
    netName: row.netName.trim(),
    courierName: row.courierName.trim(),
    customerName: row.customerName.trim(),
    codeName: row.codeName.trim(),
  };
  const required: Array<[boolean, string, string]> = [
    [snapshot.partnerId, snapshot.account, "快递公司月结账号"],
    [snapshot.partnerKey, snapshot.key, "快递公司月结密钥"],
    [snapshot.net, snapshot.netName, "快递网点"],
    [snapshot.checkMan, snapshot.courierName, "揽件员"],
    [snapshot.partnerName, snapshot.customerName, "客户名称"],
    [snapshot.isCode, snapshot.codeName, "业务编码"],
  ];
  for (const [needed, value, label] of required) {
    if (needed && !value) throw new ValidateException(`${label}尚未配置`);
  }
  return snapshot;
}

function parseCarrierSnapshot(value: string): WaybillCarrierSnapshot {
  let parsed: Record<string, unknown> | undefined;
  try {
    parsed = record(JSON.parse(value));
  } catch {
    parsed = undefined;
  }
  if (!parsed) throw new WaybillConfigurationError("电子面单快递参数快照损坏");
  const booleanKeys = ["partnerId", "partnerKey", "net", "checkMan", "partnerName", "isCode"] as const;
  const textKeys = ["account", "key", "netName", "courierName", "customerName", "codeName"] as const;
  for (const key of booleanKeys) {
    if (typeof parsed[key] !== "boolean") throw new WaybillConfigurationError("电子面单快递参数快照无效");
  }
  for (const key of textKeys) {
    if (typeof parsed[key] !== "string") throw new WaybillConfigurationError("电子面单快递参数快照无效");
  }
  return parsed as unknown as WaybillCarrierSnapshot;
}

function orderConditions(actor: WaybillActor, reference: string): SQL[] {
  const parsed = Number(reference);
  const identity = Number.isSafeInteger(parsed) && parsed > 0
    ? or(eq(storeOrder.id, parsed), eq(storeOrder.orderId, reference))!
    : eq(storeOrder.orderId, reference);
  const conditions: SQL[] = [identity, eq(storeOrder.isSystemDel, 0)];
  if (actor.actorType === "supplier") {
    conditions.push(eq(storeOrder.supplierId, actor.supplierId), eq(storeOrder.isDel, 0));
  }
  return conditions;
}

async function resolveActiveOrder(
  tx: DbClient,
  actor: WaybillActor,
  reference: string,
) {
  const references = await tx.select().from(storeOrder)
    .where(and(...orderConditions(actor, reference))).orderBy(asc(storeOrder.id)).limit(2).for("update");
  if (!references[0]) throw new NotFoundException("订单不存在或无权签发电子面单");
  if (references.length > 1) throw new ValidateException("订单标识不唯一，请改用订单主键");
  const selected = references[0];
  const rootId = selected.pid > 0 ? selected.pid : selected.id;
  const roots = selected.id === rootId
    ? [selected]
    : await tx.select().from(storeOrder).where(eq(storeOrder.id, rootId)).limit(1).for("update");
  const root = roots[0];
  if (!root) throw new NotFoundException("电子面单主订单不存在");
  let active = selected;
  if (selected.id === root.id && root.pid === -1) {
    const pending = await tx.select().from(storeOrder).where(and(
      eq(storeOrder.pid, root.id),
      eq(storeOrder.supplierId, root.supplierId),
      eq(storeOrder.status, 0),
      eq(storeOrder.isDel, 0),
      eq(storeOrder.isSystemDel, 0),
    )).orderBy(asc(storeOrder.id)).limit(2).for("update");
    if (!pending[0]) throw new ValidateException("订单已全部发货");
    if (pending.length > 1) throw new ValidateException("订单存在多个待发货子单，请先完成数据核对");
    active = pending[0];
  }
  if (actor.actorType === "supplier" && active.supplierId !== actor.supplierId) {
    throw new NotFoundException("订单不存在或无权签发电子面单");
  }
  if (active.paid !== 1) throw new ValidateException("订单未支付");
  if (active.status !== 0) throw new ValidateException("订单状态不允许签发电子面单");
  if (active.shippingType !== 1) throw new ValidateException("只有快递配送订单可签发电子面单");
  if (active.isDel || active.isSystemDel) throw new ValidateException("订单已删除");
  if (![0, 3].includes(active.refundStatus)) throw new ValidateException("订单售后状态不允许签发电子面单");
  return { root, active };
}

function isVisibleLabel(value: string): boolean {
  return !/[\u0000-\u001f\u007f]/.test(value) && [...value].length <= 255;
}

function snapshotRecord(value: string | null): Record<string, unknown> {
  try {
    return record(JSON.parse(value || "{}")) ?? {};
  } catch {
    throw new WaybillConfigurationError("订单商品快照无法解析");
  }
}

function nested(value: Record<string, unknown>, key: string): Record<string, unknown> {
  return record(value[key]) ?? {};
}

function productName(snapshot: Record<string, unknown>): string {
  const product = nested(snapshot, "product");
  const legacy = nested(snapshot, "productInfo");
  return boundedText(product.storeName ?? legacy.store_name ?? "商品", "商品名称", 160, 1);
}

function unitWeight(snapshot: Record<string, unknown>): number {
  const sku = nested(snapshot, "sku");
  const legacy = nested(snapshot, "productInfo");
  const legacySku = nested(legacy, "attrInfo");
  const parsed = Number(sku.weight ?? legacySku.weight ?? snapshot.weight ?? 0);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function parseSelection(value: string): SupplierSplitCartInput[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) throw new Error("not_array");
    return parsed.map((item) => {
      const row = record(item);
      if (!row) throw new Error("bad_row");
      const cartId = String(row.cartId ?? "").trim();
      const cartNum = Number(row.cartNum);
      if (!cartId || cartId.length > 50 || !Number.isSafeInteger(cartNum) || cartNum <= 0) {
        throw new Error("bad_selection");
      }
      return { cartId, cartNum };
    });
  } catch {
    throw new WaybillConfigurationError("电子面单拆分商品快照损坏");
  }
}

async function loadIssueInput(tx: DbClient, job: typeof orderWaybillJob.$inferSelect): Promise<WaybillIssueInput> {
  const orders = await tx.select().from(storeOrder).where(and(
    eq(storeOrder.id, job.orderId),
    eq(storeOrder.supplierId, job.supplierId),
    eq(storeOrder.isSystemDel, 0),
  )).limit(1);
  const order = orders[0];
  if (!order) throw new WaybillConfigurationError("电子面单订单已不存在或越过供应商边界");
  if (order.paid !== 1 || order.status !== 0 || order.shippingType !== 1 || order.isDel) {
    throw new WaybillConfigurationError("电子面单订单已不处于可发货状态");
  }
  const carts = await tx.select({
    cartId: storeOrderCartInfo.cartId,
    cartNum: storeOrderCartInfo.cartNum,
    splitSurplusNum: storeOrderCartInfo.splitSurplusNum,
    splitStatus: storeOrderCartInfo.splitStatus,
    cartInfo: storeOrderCartInfo.cartInfo,
  }).from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid, order.id))
    .orderBy(asc(storeOrderCartInfo.id)).limit(500);
  const selected = parseSelection(job.cartSelection);
  const selectedById = new Map(selected.map((item) => [item.cartId, item.cartNum]));
  const names: string[] = [];
  let count = 0;
  let weight = 0;
  for (const cart of carts) {
    const available = cart.splitStatus < 2
      ? (cart.splitSurplusNum > 0 ? cart.splitSurplusNum : cart.cartNum)
      : 0;
    const quantity = job.fulfillmentMode === "split"
      ? selectedById.get(cart.cartId) ?? 0
      : available;
    if (quantity <= 0) continue;
    if (quantity > available) throw new WaybillConfigurationError("电子面单所选商品数量已变化");
    selectedById.delete(cart.cartId);
    const snapshot = snapshotRecord(cart.cartInfo);
    names.push(productName(snapshot));
    count += quantity;
    weight += unitWeight(snapshot) * quantity;
  }
  if (selectedById.size) throw new WaybillConfigurationError("电子面单所选商品已拆分或不存在");
  if (!count) throw new WaybillConfigurationError("电子面单订单没有可发货商品");
  const cargo = [...new Set(names)].join("、");
  return {
    carrierCode: job.carrierCode,
    recipientName: boundedText(order.realName, "收件人", 128, 1),
    recipientPhone: boundedText(order.userPhone, "收件电话", 32, 5),
    recipientAddress: boundedText(order.userAddress, "收件地址", 255, 1),
    senderName: job.senderName,
    senderPhone: job.senderPhone,
    senderAddress: job.senderAddress,
    templateId: job.templateId,
    cloudPrinterId: job.cloudPrinterId,
    count,
    cargo: [...cargo].slice(0, 500).join(""),
    weight: Math.max(0, weight).toFixed(2),
    orderNo: order.orderId,
    carrier: parseCarrierSnapshot(job.carrierConfig),
  };
}

export function isOrderWaybillJobMessage(value: unknown): value is OrderWaybillJobMessage {
  const message = record(value);
  return !!message && message.action === "processOrderWaybillJob"
    && Number.isSafeInteger(message.waybillJobId) && Number(message.waybillJobId) > 0
    && typeof message.eventKey === "string"
    && /^order\.waybill:[0-9a-f-]{36}$/.test(message.eventKey);
}

export class OrderWaybillJobService {
  constructor(
    private readonly container: Container,
    private readonly env: Env,
  ) {}

  async create(orderReferenceValue: unknown, actor: WaybillActor, input: CreateWaybillInput) {
    assertActor(actor);
    const orderReference = boundedText(orderReferenceValue, "订单标识", 32, 1);
    const key = uuid4(input.request_key ?? input.requestKey);
    const canonical = canonicalRequest(orderReference, input);
    const requestHash = await sha256(JSON.stringify(canonical));
    const cartSelection = canonical.cart_ids as SupplierSplitCartInput[];
    const now = Math.floor(Date.now() / 1_000);
    const result = await withTx(this.container, async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`waybill-request:${key}`}))`);
      const prior = await tx.select().from(orderWaybillJob)
        .where(eq(orderWaybillJob.requestKey, key)).limit(1);
      if (prior[0]) {
        if (
          prior[0].requestHash !== requestHash || prior[0].actorType !== actor.actorType ||
          prior[0].actorId !== actor.actorId || !actorCanAccess(actor, prior[0].supplierId)
        ) throw new ValidateException("请求键已被不同的电子面单内容使用");
        return { duplicate: true, job: projection(prior[0]) };
      }

      const { root, active } = await resolveActiveOrder(tx, actor, orderReference);
      const activeJobs = await tx.select({ id: orderWaybillJob.id })
        .from(orderWaybillJob).where(and(
          eq(orderWaybillJob.rootOrderId, root.id),
          inArray(orderWaybillJob.status, BLOCKING_STATUSES),
        )).limit(1).for("key share");
      if (activeJobs[0]) throw new ValidateException("订单已有进行中的电子面单任务");

      const values = actor.actorType === "supplier"
        ? await supplierConfig(tx, actor.supplierId)
        : await platformConfig(tx);
      if (!enabled(configValue(values, actor, "open"))) {
        throw new ValidateException("电子面单尚未启用");
      }
      const defaultCarrier = configValue(values, actor, "id");
      const carrierId = positiveInt(
        input.carrier_id ?? input.carrierId ?? defaultCarrier,
        "快递公司ID",
      );
      const carriers = await tx.select().from(expressCompany).where(and(
        eq(expressCompany.id, carrierId),
        eq(expressCompany.isShow, 1),
        eq(expressCompany.status, 1),
      )).limit(1);
      const carrier = carriers[0];
      if (!carrier || !carrier.code.trim() || !carrier.name.trim()) {
        throw new ValidateException("快递公司不存在、已停用或缺少编码");
      }
      const snapshot = carrierSnapshot(carrier);
      const templateId = optionalText(input.template_id ?? input.templateId, "电子面单模板ID", 255)
        ?? configValue(values, actor, "temp_id");
      const senderName = optionalText(input.sender_name ?? input.senderName, "发件人", 128)
        ?? configValue(values, actor, "to_name");
      const senderPhone = optionalText(input.sender_phone ?? input.senderPhone, "发件电话", 32)
        ?? configValue(values, actor, "to_tel");
      const senderAddress = optionalText(input.sender_address ?? input.senderAddress, "发件地址", 255)
        ?? configValue(values, actor, "to_address");
      const cloudPrinterId = optionalText(
        input.cloud_printer_id ?? input.cloudPrinterId,
        "云打印机编号",
        50,
      ) ?? configValue(values, actor, "siid");
      boundedText(templateId, "电子面单模板ID", 255, 1);
      boundedText(senderName, "发件人", 128, 1);
      boundedText(senderPhone, "发件电话", 32, 5);
      boundedText(senderAddress, "发件地址", 255, 1);
      if (cloudPrinterId && !/^[A-Za-z0-9]{10,50}$/.test(cloudPrinterId)) {
        throw new ValidateException("云打印机编号必须为10到50位数字或字母");
      }
      const selectionJson = JSON.stringify(cartSelection);
      if (selectionJson.length > 16_000) throw new ValidateException("拆分商品内容过长");
      const carrierJson = JSON.stringify(snapshot);
      if (carrierJson.length > 2_000) throw new ValidateException("快递公司参数过长");
      const inserted = await tx.insert(orderWaybillJob).values({
        eventKey: `order.waybill:${key}`,
        requestKey: key,
        requestHash,
        rootOrderId: root.id,
        orderId: active.id,
        orderNo: active.orderId,
        supplierId: active.supplierId,
        storeId: active.storeId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        fulfillmentMode: cartSelection.length ? "split" : "whole",
        cartSelection: selectionJson,
        carrierId: carrier.id,
        carrierCode: carrier.code.trim(),
        carrierName: carrier.name.trim(),
        carrierConfig: carrierJson,
        templateId,
        cloudPrinterId,
        senderName,
        senderPhone,
        senderAddress,
        status: "PENDING",
        availableTime: now,
        addTime: now,
        updateTime: now,
      }).returning();
      return { duplicate: false, job: projection(inserted[0]) };
    });
    try {
      await this.dispatchPending(1, result.job.event_key, [result.job.id]);
    } catch {
      // Durable row is authoritative; scheduled dispatch will retry.
    }
    return result;
  }

  async dispatchPending(
    limit = 20,
    eventKey?: string,
    jobIds?: readonly number[],
  ): Promise<{ claimed: number; enqueued: number; unknown: number }> {
    const boundedLimit = Math.max(1, Math.min(Math.trunc(limit), 100));
    const now = Math.floor(Date.now() / 1_000);
    const leaseToken = crypto.randomUUID();
    const unknown = await this.markExpiredProviderCallsUnknown(now, eventKey, jobIds);
    const eligible = or(
      and(inArray(orderWaybillJob.status, ["PENDING", "RETRYABLE"]), lte(orderWaybillJob.availableTime, now)),
      and(inArray(orderWaybillJob.status, ["ENQUEUING", "ENQUEUED"]), lte(orderWaybillJob.leaseUntil, now)),
    )!;
    const claimed = await withTx(this.container, async (tx) => {
      const conditions: SQL[] = [eligible];
      if (eventKey) conditions.push(eq(orderWaybillJob.eventKey, eventKey));
      if (jobIds?.length) conditions.push(inArray(orderWaybillJob.id, [...jobIds]));
      const rows = await tx.select({ id: orderWaybillJob.id, eventKey: orderWaybillJob.eventKey })
        .from(orderWaybillJob).where(and(...conditions)).orderBy(asc(orderWaybillJob.id))
        .limit(boundedLimit).for("update", { skipLocked: true });
      if (!rows.length) return rows;
      await tx.update(orderWaybillJob).set({
        status: "ENQUEUING",
        dispatchCount: sql`${orderWaybillJob.dispatchCount} + 1`,
        leaseToken,
        leaseUntil: now + QUEUE_LEASE_SECONDS,
        updateTime: now,
      }).where(inArray(orderWaybillJob.id, rows.map((row) => row.id)));
      return rows;
    });
    if (!claimed.length) return { claimed: 0, enqueued: 0, unknown };
    try {
      await this.env.ORDER_QUEUE.sendBatch(claimed.map((job) => ({
        body: {
          action: "processOrderWaybillJob" as const,
          waybillJobId: job.id,
          eventKey: job.eventKey,
        },
        contentType: "json" as const,
      })));
      const transitioned = await withTx(this.container, (tx) => tx.update(orderWaybillJob).set({
        status: "ENQUEUED",
        leaseToken: "",
        leaseUntil: now + QUEUE_LEASE_SECONDS,
        lastError: "",
        updateTime: now,
      }).where(and(
        inArray(orderWaybillJob.id, claimed.map((job) => job.id)),
        eq(orderWaybillJob.status, "ENQUEUING"),
        eq(orderWaybillJob.leaseToken, leaseToken),
      )).returning({ id: orderWaybillJob.id }));
      if (transitioned.length !== claimed.length) throw new Error("电子面单 Queue 投递状态迁移不完整");
      return { claimed: claimed.length, enqueued: claimed.length, unknown };
    } catch (error) {
      await withTx(this.container, (tx) => tx.update(orderWaybillJob).set({
        status: "RETRYABLE",
        availableTime: now + 60,
        leaseToken: "",
        leaseUntil: 0,
        lastError: `Queue delivery failed: ${errorText(error)}`,
        updateTime: now,
      }).where(and(
        inArray(orderWaybillJob.id, claimed.map((job) => job.id)),
        eq(orderWaybillJob.status, "ENQUEUING"),
        eq(orderWaybillJob.leaseToken, leaseToken),
      )));
      throw error;
    }
  }

  async processMessage(
    message: OrderWaybillJobMessage,
    fetcher: typeof fetch = fetch,
  ): Promise<ProcessingResult> {
    const claim = await this.claim(message);
    if (typeof claim === "string") return claim;
    const now = Math.floor(Date.now() / 1_000);
    let payloadHash = "";
    let loaded: {
      job: typeof orderWaybillJob.$inferSelect;
      input: WaybillIssueInput;
    };
    try {
      loaded = await withTx(this.container, async (tx) => {
        const jobs = await tx.select().from(orderWaybillJob)
          .where(eq(orderWaybillJob.id, claim.id)).limit(1);
        if (!jobs[0]) throw new WaybillConfigurationError("电子面单任务不存在");
        return { job: jobs[0], input: await loadIssueInput(tx, jobs[0]) };
      });
      payloadHash = await sha256(JSON.stringify(loaded.input));
    } catch (error) {
      const retryable = !(error instanceof WaybillConfigurationError || error instanceof ValidateException)
        && claim.attemptCount < MAX_PROVIDER_ATTEMPTS;
      await this.finalize(
        claim,
        retryable ? "RETRYABLE" : "DEAD",
        undefined,
        `pre_issue:${errorText(error)}`,
        payloadHash,
        now,
        undefined,
        retryable ? now + retryDelaySeconds(claim.attemptCount) : 0,
      );
      return retryable ? "retry-scheduled" : "dead";
    }
    let result: WaybillIssueResult | undefined;
    try {
      result = await issueCrmebOnePassWaybill({
        accessKey: this.env.CRMEB_ONEPASS_ACCESS_KEY,
        secretKey: this.env.CRMEB_ONEPASS_SECRET_KEY,
      }, loaded.input, fetcher);
      await this.recordProviderSuccess(claim, result, payloadHash, now);
      const fulfillment = await this.applyFulfillment(loaded.job, result.trackingNumber, result.labelUrl);
      await this.finalize(claim, "SENT", result, "", payloadHash, now, {
        fulfilledOrderId: fulfillment.order_id,
        remainingOrderId: fulfillment.remaining_order_id ?? 0,
      });
      return "sent";
    } catch (error) {
      if (error instanceof WaybillPreflightError) {
        const retryable = claim.attemptCount < MAX_PROVIDER_ATTEMPTS;
        await this.finalize(
          claim,
          retryable ? "RETRYABLE" : "DEAD",
          undefined,
          errorText(error),
          payloadHash,
          now,
          undefined,
          retryable ? now + retryDelaySeconds(claim.attemptCount) : 0,
        );
        return retryable ? "retry-scheduled" : "dead";
      }
      if (error instanceof WaybillConfigurationError) {
        await this.finalize(claim, "DEAD", undefined, errorText(error), payloadHash, now);
        return "dead";
      }
      if (error instanceof WaybillRejectedError) {
        await this.finalize(claim, "DEAD", {
          trackingNumber: "",
          labelUrl: "",
          providerReference: "",
          responseCode: error.code,
        }, errorText(error), payloadHash, now);
        return "dead";
      }
      // Once the issue endpoint was invoked, transport/malformed outcomes and
      // local fulfillment failures must never cause a blind second allocation.
      await this.finalize(claim, "UNKNOWN", result, errorText(error), payloadHash, now);
      return "unknown";
    }
  }

  async listJobs(actor: WaybillActor, query: WaybillJobListQuery = {}) {
    assertActor(actor);
    const status = query.status?.trim().toUpperCase();
    if (status && !JOB_STATUSES.has(status as OrderWaybillJobStatus)) {
      throw new ValidateException("电子面单任务状态无效");
    }
    const supplierId = optionalPositiveInt(query.supplierId, "供应商ID");
    if (actor.actorType === "supplier" && supplierId && supplierId !== actor.supplierId) {
      throw new ValidateException("不能查看其他供应商电子面单");
    }
    const orderId = optionalPositiveInt(query.orderId, "订单ID");
    const afterId = optionalPositiveInt(query.afterId, "游标");
    const limit = query.limit === undefined ? 20 : positiveInt(query.limit, "每页数量", 100);
    const conditions: SQL[] = [];
    if (actor.actorType === "supplier") conditions.push(eq(orderWaybillJob.supplierId, actor.supplierId));
    else if (supplierId) conditions.push(eq(orderWaybillJob.supplierId, supplierId));
    if (status) conditions.push(eq(orderWaybillJob.status, status as OrderWaybillJobStatus));
    if (orderId) conditions.push(eq(orderWaybillJob.orderId, orderId));
    if (afterId) conditions.push(lt(orderWaybillJob.id, afterId));
    return withTx(this.container, async (tx) => {
      const base = tx.select().from(orderWaybillJob);
      const rows = conditions.length
        ? await base.where(and(...conditions)).orderBy(desc(orderWaybillJob.id)).limit(limit)
        : await base.orderBy(desc(orderWaybillJob.id)).limit(limit);
      return {
        list: rows.map(projection),
        next_cursor: rows.length === limit ? rows.at(-1)?.id ?? null : null,
        summary: await this.summary(actor, supplierId, tx),
      };
    });
  }

  async listActions(jobIdValue: unknown, actor: WaybillActor) {
    const jobId = positiveInt(jobIdValue, "电子面单任务ID");
    assertActor(actor);
    return withTx(this.container, async (tx) => {
      const jobs = await tx.select({ supplierId: orderWaybillJob.supplierId })
        .from(orderWaybillJob).where(eq(orderWaybillJob.id, jobId)).limit(1);
      if (!jobs[0] || !actorCanAccess(actor, jobs[0].supplierId)) {
        throw new NotFoundException("电子面单任务不存在");
      }
      return tx.select({
        id: orderWaybillJobAction.id,
        job_id: orderWaybillJobAction.jobId,
        request_key: orderWaybillJobAction.requestKey,
        action: orderWaybillJobAction.action,
        previous_status: orderWaybillJobAction.previousStatus,
        next_status: orderWaybillJobAction.nextStatus,
        actor_type: orderWaybillJobAction.actorType,
        actor_id: orderWaybillJobAction.actorId,
        supplier_id: orderWaybillJobAction.supplierId,
        reason: orderWaybillJobAction.reason,
        provider_reference: orderWaybillJobAction.providerReference,
        tracking_number: orderWaybillJobAction.trackingNumber,
        add_time: orderWaybillJobAction.addTime,
      }).from(orderWaybillJobAction).where(eq(orderWaybillJobAction.jobId, jobId))
        .orderBy(desc(orderWaybillJobAction.id)).limit(100);
    });
  }

  applyExisting(id: unknown, actor: WaybillActor, input: WaybillOperationInput) {
    return this.applyOperatorDecision(id, actor, "APPLY_EXISTING", input);
  }

  confirmIssued(id: unknown, actor: WaybillActor, input: WaybillOperationInput) {
    return this.applyOperatorDecision(id, actor, "CONFIRM_ISSUED", input);
  }

  confirmRetry(id: unknown, actor: WaybillActor, input: WaybillOperationInput) {
    return this.transitionDecision(id, actor, "CONFIRM_RETRY", input);
  }

  closeWithoutRetry(id: unknown, actor: WaybillActor, input: WaybillOperationInput) {
    return this.transitionDecision(id, actor, "CLOSE_NO_RETRY", input);
  }

  private async claim(message: OrderWaybillJobMessage): Promise<ClaimedWaybillJob | ProcessingResult> {
    const now = Math.floor(Date.now() / 1_000);
    const leaseToken = crypto.randomUUID();
    return withTx(this.container, async (tx) => {
      const rows = await tx.select().from(orderWaybillJob)
        .where(eq(orderWaybillJob.id, message.waybillJobId)).limit(1).for("update");
      const row = rows[0];
      if (!row) throw new NotFoundException("电子面单任务不存在");
      if (row.eventKey !== message.eventKey) throw new ValidateException("Queue 消息与电子面单账本不匹配");
      if (row.status === "SENT") return "already-sent";
      if (row.status === "UNKNOWN") return "unknown";
      if (row.status === "DEAD") return "dead";
      if (row.status === "CLOSED") return "closed";
      if (row.status === "PROCESSING") {
        if (row.leaseUntil > now) return "busy";
        await tx.update(orderWaybillJob).set({
          status: "UNKNOWN",
          leaseToken: "",
          leaseUntil: 0,
          lastError: "provider_result_unknown_after_expired_lease",
          updateTime: now,
        }).where(eq(orderWaybillJob.id, row.id));
        return "unknown";
      }
      if (row.status !== "ENQUEUED") return "busy";
      const attemptCount = row.attemptCount + 1;
      await tx.update(orderWaybillJob).set({
        status: "PROCESSING",
        attemptCount,
        leaseToken,
        leaseUntil: now + PROVIDER_LEASE_SECONDS,
        updateTime: now,
      }).where(eq(orderWaybillJob.id, row.id));
      return { id: row.id, eventKey: row.eventKey, attemptCount, leaseToken };
    });
  }

  private async recordProviderSuccess(
    claim: ClaimedWaybillJob,
    result: WaybillIssueResult,
    payloadHash: string,
    now: number,
  ): Promise<void> {
    const updated = await withTx(this.container, (tx) => tx.update(orderWaybillJob).set({
      providerReference: result.providerReference,
      responseCode: result.responseCode,
      trackingNumber: result.trackingNumber,
      labelUrl: result.labelUrl,
      payloadHash,
      lastError: "",
      updateTime: now,
    }).where(and(
      eq(orderWaybillJob.id, claim.id),
      eq(orderWaybillJob.status, "PROCESSING"),
      eq(orderWaybillJob.leaseToken, claim.leaseToken),
    )).returning({ id: orderWaybillJob.id }));
    if (!updated[0]) throw new Error("电子面单提供商租约已失效");
  }

  private async applyFulfillment(
    job: typeof orderWaybillJob.$inferSelect,
    trackingNumber: string,
    labelUrl: string,
  ) {
    if (!trackingNumber) throw new ValidateException("电子面单缺少快递单号");
    if (trackingNumber.length > 64 || /[\u0000-\u001f\u007f]/.test(trackingNumber)) {
      throw new ValidateException("电子面单快递单号无效");
    }
    if (!isVisibleLabel(labelUrl)) throw new ValidateException("电子面单图片地址无效");
    const fulfillment = new SupplierFulfillmentService(this.container, this.env);
    const delivery = {
      deliveryType: "express" as const,
      deliveryName: job.carrierName,
      deliveryCode: job.carrierCode,
      deliveryId: trackingNumber,
      fictitiousContent: "",
      deliveryUid: 0,
    };
    const options = {
      replay: {
        accountId: job.id,
        requestHash: job.requestHash,
        changeType: "waybill_delivery" as const,
      },
      waybillJobId: job.id,
      waybillMetadata: {
        expressDump: JSON.stringify({
          com: job.carrierCode,
          from_name: job.senderName,
          from_tel: job.senderPhone,
          from_addr: job.senderAddress,
          temp_id: job.templateId,
          waybill_job_id: job.id,
        }),
        labelUrl,
      },
    };
    return job.fulfillmentMode === "split"
      ? fulfillment.splitDelivery(
        job.supplierId,
        job.orderId,
        delivery,
        parseSelection(job.cartSelection),
        options,
      )
      : fulfillment.deliver(job.supplierId, job.orderId, delivery, options);
  }

  private async finalize(
    claim: ClaimedWaybillJob,
    status: "SENT" | "RETRYABLE" | "UNKNOWN" | "DEAD",
    result: WaybillIssueResult | undefined,
    lastError: string,
    payloadHash: string,
    now: number,
    fulfillment?: { fulfilledOrderId: number; remainingOrderId: number },
    availableTime = 0,
  ): Promise<void> {
    const values: Partial<typeof orderWaybillJob.$inferInsert> = {
      status,
      availableTime,
      leaseToken: "",
      leaseUntil: 0,
      lastError: lastError.slice(0, 1_000),
      sentTime: status === "SENT" ? now : 0,
      updateTime: now,
    };
    if (payloadHash) values.payloadHash = payloadHash;
    if (result) {
      values.providerReference = result.providerReference;
      values.responseCode = result.responseCode;
      values.trackingNumber = result.trackingNumber;
      values.labelUrl = result.labelUrl;
    }
    if (fulfillment) {
      values.fulfilledOrderId = fulfillment.fulfilledOrderId;
      values.remainingOrderId = fulfillment.remainingOrderId;
    }
    const updated = await withTx(this.container, (tx) => tx.update(orderWaybillJob).set(values)
      .where(and(
        eq(orderWaybillJob.id, claim.id),
        eq(orderWaybillJob.status, "PROCESSING"),
        eq(orderWaybillJob.leaseToken, claim.leaseToken),
      )).returning({ id: orderWaybillJob.id }));
    if (!updated[0]) throw new Error("电子面单提供商租约已失效");
  }

  private async markExpiredProviderCallsUnknown(
    now: number,
    eventKey?: string,
    jobIds?: readonly number[],
  ): Promise<number> {
    const conditions: SQL[] = [
      eq(orderWaybillJob.status, "PROCESSING"),
      lte(orderWaybillJob.leaseUntil, now),
    ];
    if (eventKey) conditions.push(eq(orderWaybillJob.eventKey, eventKey));
    if (jobIds?.length) conditions.push(inArray(orderWaybillJob.id, [...jobIds]));
    const rows = await withTx(this.container, (tx) => tx.update(orderWaybillJob).set({
      status: "UNKNOWN",
      leaseToken: "",
      leaseUntil: 0,
      lastError: "provider_result_unknown_after_expired_lease",
      updateTime: now,
    }).where(and(...conditions)).returning({ id: orderWaybillJob.id }));
    return rows.length;
  }

  private async summary(actor: WaybillActor, supplierId: number | undefined, db: DbClient) {
    const condition = actor.actorType === "supplier"
      ? eq(orderWaybillJob.supplierId, actor.supplierId)
      : supplierId ? eq(orderWaybillJob.supplierId, supplierId) : undefined;
    const base = db.select({
      pending: sql<number>`count(*) FILTER (WHERE ${orderWaybillJob.status} IN ('PENDING', 'ENQUEUING', 'ENQUEUED', 'PROCESSING', 'RETRYABLE'))::int`,
      sent: sql<number>`count(*) FILTER (WHERE ${orderWaybillJob.status} = 'SENT')::int`,
      unknown: sql<number>`count(*) FILTER (WHERE ${orderWaybillJob.status} = 'UNKNOWN')::int`,
      dead: sql<number>`count(*) FILTER (WHERE ${orderWaybillJob.status} = 'DEAD')::int`,
      closed: sql<number>`count(*) FILTER (WHERE ${orderWaybillJob.status} = 'CLOSED')::int`,
    }).from(orderWaybillJob);
    const rows = condition ? await base.where(condition) : await base;
    return rows[0] ?? { pending: 0, sent: 0, unknown: 0, dead: 0, closed: 0 };
  }

  private async applyOperatorDecision(
    idValue: unknown,
    actor: WaybillActor,
    action: Extract<OrderWaybillJobActionType, "APPLY_EXISTING" | "CONFIRM_ISSUED">,
    input: WaybillOperationInput,
    now = Math.floor(Date.now() / 1_000),
  ) {
    const id = positiveInt(idValue, "电子面单任务ID");
    assertActor(actor);
    const key = uuid4(input.requestKey, "操作请求键");
    const reason = boundedText(input.reason, "操作原因", 500, 8);
    const requestedTracking = action === "CONFIRM_ISSUED"
      ? boundedText(input.trackingNumber, "快递单号", 64, 1)
      : "";
    const requestedLabel = input.labelUrl === undefined
      ? ""
      : boundedText(input.labelUrl, "面单图片地址", 255);
    const requestedReference = input.providerReference === undefined
      ? ""
      : boundedText(input.providerReference, "提供商引用", 255);
    const prepared = await withTx(this.container, async (tx) => {
      const prior = await tx.select().from(orderWaybillJobAction)
        .where(eq(orderWaybillJobAction.requestKey, key)).limit(1);
      const jobs = await tx.select().from(orderWaybillJob)
        .where(eq(orderWaybillJob.id, id)).limit(1);
      const job = jobs[0];
      if (!job || !actorCanAccess(actor, job.supplierId)) throw new NotFoundException("电子面单任务不存在");
      const tracking = requestedTracking || job.trackingNumber;
      const label = requestedLabel || job.labelUrl;
      const reference = requestedReference || job.providerReference;
      if (prior[0]) {
        if (
          prior[0].jobId !== id || prior[0].action !== action ||
          prior[0].actorType !== actor.actorType || prior[0].actorId !== actor.actorId ||
          prior[0].reason !== reason || prior[0].trackingNumber !== tracking ||
          prior[0].providerReference !== reference
        ) throw new ValidateException("操作请求键已被不同内容使用");
        return { duplicate: true, job, tracking, label, reference };
      }
      if (job.status !== "UNKNOWN") throw new ValidateException("只有结果未知的电子面单可人工确认并发货");
      if (!tracking) throw new ValidateException("请提供已签发的快递单号");
      if (action === "APPLY_EXISTING" && requestedTracking) {
        throw new ValidateException("应用已有面单不能改写快递单号");
      }
      return { duplicate: false, job, tracking, label, reference };
    });
    if (prepared.duplicate) return { duplicate: true, job: projection(prepared.job) };
    const fulfillment = await this.applyFulfillment(prepared.job, prepared.tracking, prepared.label);
    return withTx(this.container, async (tx) => {
      const rows = await tx.select().from(orderWaybillJob).where(eq(orderWaybillJob.id, id))
        .limit(1).for("update");
      const row = rows[0];
      if (!row || !actorCanAccess(actor, row.supplierId)) throw new NotFoundException("电子面单任务不存在");
      if (row.status === "SENT") {
        const prior = await tx.select().from(orderWaybillJobAction)
          .where(eq(orderWaybillJobAction.requestKey, key)).limit(1);
        if (prior[0]) return { duplicate: true, job: projection(row) };
      }
      if (row.status !== "UNKNOWN") throw new ValidateException("电子面单任务状态已变化");
      const updated = await tx.update(orderWaybillJob).set({
        status: "SENT",
        trackingNumber: prepared.tracking,
        labelUrl: prepared.label,
        providerReference: prepared.reference,
        responseCode: action === "APPLY_EXISTING" ? "OPERATOR_APPLIED_EXISTING" : "OPERATOR_CONFIRMED_ISSUED",
        fulfilledOrderId: fulfillment.order_id,
        remainingOrderId: fulfillment.remaining_order_id ?? 0,
        availableTime: 0,
        leaseUntil: 0,
        leaseToken: "",
        lastError: "",
        sentTime: now,
        updateTime: now,
      }).where(and(eq(orderWaybillJob.id, id), eq(orderWaybillJob.status, "UNKNOWN"))).returning();
      if (!updated[0]) throw new Error("电子面单任务状态已变化");
      await tx.insert(orderWaybillJobAction).values({
        jobId: id,
        requestKey: key,
        action,
        previousStatus: "UNKNOWN",
        nextStatus: "SENT",
        actorType: actor.actorType,
        actorId: actor.actorId,
        supplierId: row.supplierId,
        reason,
        providerReference: prepared.reference,
        trackingNumber: prepared.tracking,
        addTime: now,
      });
      return { duplicate: false, job: projection(updated[0]) };
    });
  }

  private async transitionDecision(
    idValue: unknown,
    actor: WaybillActor,
    action: Extract<OrderWaybillJobActionType, "CONFIRM_RETRY" | "CLOSE_NO_RETRY">,
    input: WaybillOperationInput,
    now = Math.floor(Date.now() / 1_000),
  ) {
    const id = positiveInt(idValue, "电子面单任务ID");
    assertActor(actor);
    const key = uuid4(input.requestKey, "操作请求键");
    const reason = boundedText(input.reason, "操作原因", 500, 8);
    const result = await withTx(this.container, async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`waybill-operation:${key}`}))`);
      const prior = await tx.select().from(orderWaybillJobAction)
        .where(eq(orderWaybillJobAction.requestKey, key)).limit(1);
      const rows = await tx.select().from(orderWaybillJob).where(eq(orderWaybillJob.id, id))
        .limit(1).for("update");
      const row = rows[0];
      if (!row || !actorCanAccess(actor, row.supplierId)) throw new NotFoundException("电子面单任务不存在");
      if (prior[0]) {
        if (
          prior[0].jobId !== id || prior[0].action !== action ||
          prior[0].actorType !== actor.actorType || prior[0].actorId !== actor.actorId ||
          prior[0].reason !== reason
        ) throw new ValidateException("操作请求键已被不同内容使用");
        return { duplicate: true, job: projection(row) };
      }
      if (!["UNKNOWN", "DEAD"].includes(row.status)) {
        throw new ValidateException("只有结果未知或明确失败的电子面单可执行此操作");
      }
      if (action === "CONFIRM_RETRY" && row.trackingNumber) {
        throw new ValidateException("任务已有快递单号，请应用已有面单，不能再次签发");
      }
      if (action === "CONFIRM_RETRY" && row.replayCount >= MAX_MANUAL_REPLAYS) {
        throw new ValidateException("已达到最大人工重签次数");
      }
      const nextStatus: OrderWaybillJobStatus = action === "CONFIRM_RETRY" ? "RETRYABLE" : "CLOSED";
      const updated = await tx.update(orderWaybillJob).set({
        status: nextStatus,
        replayCount: action === "CONFIRM_RETRY" ? row.replayCount + 1 : row.replayCount,
        availableTime: action === "CONFIRM_RETRY" ? now : 0,
        leaseUntil: 0,
        leaseToken: "",
        responseCode: action === "CONFIRM_RETRY" ? "OPERATOR_CONFIRMED_RETRY" : "OPERATOR_CLOSED_NO_RETRY",
        lastError: action === "CONFIRM_RETRY" ? "operator_confirmed_retry" : "operator_closed_without_retry",
        updateTime: now,
      }).where(and(eq(orderWaybillJob.id, id), eq(orderWaybillJob.status, row.status))).returning();
      if (!updated[0]) throw new Error("电子面单任务状态已变化");
      await tx.insert(orderWaybillJobAction).values({
        jobId: id,
        requestKey: key,
        action,
        previousStatus: row.status,
        nextStatus,
        actorType: actor.actorType,
        actorId: actor.actorId,
        supplierId: row.supplierId,
        reason,
        providerReference: row.providerReference,
        trackingNumber: row.trackingNumber,
        addTime: now,
      });
      return { duplicate: false, job: projection(updated[0]) };
    });
    if (action === "CONFIRM_RETRY" && !result.duplicate) {
      try {
        await this.dispatchPending(1, result.job.event_key);
      } catch {
        // Scheduled dispatch remains authoritative.
      }
    }
    return result;
  }
}

export async function consumeOrderWaybillJobMessage(
  message: Pick<Message<OrderMessage>, "body" | "attempts" | "ack" | "retry">,
  service: OrderWaybillJobService,
): Promise<void> {
  if (!isOrderWaybillJobMessage(message.body)) throw new Error("Queue message is not a waybill job");
  const body = message.body;
  try {
    const result = await service.processMessage(body);
    if (result === "busy") {
      message.retry({ delaySeconds: Math.min(30 * 2 ** Math.max(message.attempts - 1, 0), 300) });
      return;
    }
    console.log(JSON.stringify({
      event: "order_waybill_job_consumed",
      waybillJobId: body.waybillJobId,
      result,
      queueAttempt: message.attempts,
    }));
    message.ack();
  } catch (error) {
    console.error(JSON.stringify({
      event: "order_waybill_job_failed",
      waybillJobId: body.waybillJobId,
      queueAttempt: message.attempts,
      error: errorText(error),
    }));
    message.retry({ delaySeconds: Math.min(30 * 2 ** Math.max(message.attempts - 1, 0), 300) });
  }
}
