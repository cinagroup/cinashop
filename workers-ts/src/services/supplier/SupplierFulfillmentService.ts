import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { withTx, type Container, type DbClient } from "@/lib/di";
import type { SystemConfigEnv } from "@/services/system/SystemConfigService";
import {
  expressCompany,
  orderWaybillJob,
  storeOrder,
  storeOrderCartInfo,
  storeOrderRefund,
  storeOrderStatus,
  storePink,
} from "@/models/schema";
import {
  completeOrderReceipt,
  lockOrderSettlement,
} from "@/services/order/OrderBrokerageService";
import { enqueueOrderDeliveryNoticeEvent } from "@/services/order/OrderNotificationOutboxService";
import { generatePickupVerifyCode } from "@/services/order/StoreOrderWriteoffService";
import { NotFoundException, ValidateException } from "@/utils/errors";

export type SupplierDeliveryType = "express" | "send" | "fictitious";

export interface SupplierDeliveryInput {
  deliveryType: SupplierDeliveryType;
  deliveryName: string;
  deliveryCode: string;
  deliveryId: string;
  fictitiousContent: string;
  deliveryUid: number;
}

export interface SupplierSplitCartInput {
  cartId: string;
  cartNum: number;
}

export interface FulfillmentReplayOptions {
  accountId: number;
  requestHash: string;
  changeType:
    | "out_order_delivery"
    | "out_order_split_delivery"
    | "waybill_delivery"
    | "merchant_shipment_delivery";
}

export interface FulfillmentWaybillMetadata {
  expressDump: string;
  labelUrl: string;
}

export interface FulfillmentExecutionOptions {
  expectedStoreId?: number;
  replay?: FulfillmentReplayOptions;
  /** The matching active job is allowed through; every other active job blocks manual fulfillment. */
  waybillJobId?: number;
  waybillMetadata?: FulfillmentWaybillMetadata;
  /** Runs before settlement/order locks; callers may take their own ownership locks here. */
  authorize?: (tx: DbClient, scope: FulfillmentAuthorizationScope) => Promise<void>;
  /** Immutable actor audit written in the same transaction as fulfillment. */
  audit?: FulfillmentAuditStatus;
}

export interface FulfillmentAuthorizationScope {
  requestedOrderId: number;
  rootOrderId: number;
  customerUid: number;
  supplierId: number;
}

export interface FulfillmentAuditStatus {
  changeType: string;
  changeMessage: string;
}

export interface FulfillmentExecutionResult {
  split: boolean;
  order_id: number;
  remaining_order_id: number | null;
  idempotent: boolean;
}

type SupplierTx = DbClient;
type OrderRow = typeof storeOrder.$inferSelect;
type CartRow = typeof storeOrderCartInfo.$inferSelect;
type OrderInsert = typeof storeOrder.$inferInsert;
type CartInsert = typeof storeOrderCartInfo.$inferInsert;

const DECIMAL_ORDER_FIELDS = [
  "freightPrice",
  "totalPrice",
  "totalPostage",
  "payPrice",
  "payPostage",
  "deductionPrice",
  "couponPrice",
  "promotionsPrice",
  "firstOrderPrice",
  "changePrice",
  "gainIntegral",
  "useIntegral",
  "backIntegral",
  "oneBrokerage",
  "twoBrokerage",
  "divisionBrokerage",
  "divisionAgentBrokerage",
  "divisionStaffBrokerage",
] as const satisfies readonly (keyof OrderRow)[];

const SNAPSHOT_ALLOCATED_FIELDS = [
  "coupon_price",
  "integral_price",
  "postage_price",
  "use_integral",
  "one_brokerage",
  "two_brokerage",
  "sum_true_price",
  "first_order_price",
  "division_staff_brokerage",
  "division_agent_brokerage",
  "division_brokerage",
] as const;

function requiredString(
  input: Record<string, unknown>,
  key: string,
  maxLength: number,
  required = false,
): string {
  const value = input[key];
  if (value === undefined || value === null) {
    if (required) throw new ValidateException(`${key}不能为空`);
    return "";
  }
  if (typeof value !== "string") throw new ValidateException(`${key}格式错误`);
  const normalized = value.trim();
  if (required && !normalized) throw new ValidateException(`${key}不能为空`);
  if (normalized.length > maxLength) throw new ValidateException(`${key}长度不能超过 ${maxLength}`);
  return normalized;
}

export function normalizeSupplierDeliveryInput(
  input: Record<string, unknown>,
): SupplierDeliveryInput {
  const legacyType = Number(input.type ?? 0);
  const rawType =
    typeof input.delivery_type === "string" && input.delivery_type.trim()
      ? input.delivery_type.trim()
      : legacyType === 2
        ? "send"
        : legacyType === 3
          ? "fictitious"
          : "express";
  if (!["express", "send", "fictitious"].includes(rawType)) {
    throw new ValidateException("发货类型错误");
  }
  const deliveryType = rawType as SupplierDeliveryType;
  if (deliveryType === "send") {
    throw new ValidateException(
      "供应商同城配送尚未接入实名配送员与核销链路，请使用快递或虚拟交付",
    );
  }
  const deliveryName = requiredString(
    input,
    "delivery_name",
    64,
    deliveryType !== "fictitious",
  );
  const deliveryCode = requiredString(input, "delivery_code", 50);
  const deliveryId = requiredString(
    input,
    "delivery_id",
    64,
    deliveryType !== "fictitious",
  );
  const fictitiousContent = requiredString(
    input,
    "fictitious_content",
    500,
    deliveryType === "fictitious",
  );
  const deliveryUid = Number(input.delivery_uid ?? input.sh_delivery_uid ?? 0);
  if (!Number.isInteger(deliveryUid) || deliveryUid < 0) {
    throw new ValidateException("配送员ID格式错误");
  }
  return {
    deliveryType,
    deliveryName,
    deliveryCode,
    deliveryId,
    fictitiousContent,
    deliveryUid,
  };
}

export function normalizeSupplierSplitCartInput(
  input: Record<string, unknown>,
): SupplierSplitCartInput[] {
  if (!Array.isArray(input.cart_ids) || input.cart_ids.length === 0) {
    throw new ValidateException("请选择发货商品");
  }
  if (input.cart_ids.length > 200) throw new ValidateException("单次发货商品不能超过200项");
  const seen = new Set<string>();
  return input.cart_ids.map((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new ValidateException("发货商品格式错误");
    }
    const row = raw as Record<string, unknown>;
    const cartId = String(row.cart_id ?? "").trim();
    const cartNum = Number(row.cart_num);
    if (!cartId || cartId.length > 50) throw new ValidateException("商品快照ID格式错误");
    if (!Number.isInteger(cartNum) || cartNum <= 0) {
      throw new ValidateException("发货件数必须是正整数");
    }
    if (seen.has(cartId)) throw new ValidateException("同一商品不能重复选择");
    seen.add(cartId);
    return { cartId, cartNum };
  });
}

function decimalToMinor(value: unknown): bigint {
  const normalized = String(value ?? "0").trim();
  if (!/^-?\d+(?:\.\d{1,2})?$/.test(normalized)) return 0n;
  const negative = normalized.startsWith("-");
  const unsigned = negative ? normalized.slice(1) : normalized;
  const [whole, fraction = ""] = unsigned.split(".");
  const minor = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
  return negative ? -minor : minor;
}

function minorToDecimal(value: bigint): string {
  const negative = value < 0n;
  const unsigned = negative ? -value : value;
  return `${negative ? "-" : ""}${unsigned / 100n}.${String(unsigned % 100n).padStart(2, "0")}`;
}

function allocateMinor(total: bigint, numerator: bigint, denominator: bigint): [bigint, bigint] {
  if (denominator <= 0n || numerator <= 0n) return [0n, total];
  if (numerator >= denominator) return [total, 0n];
  const selected = (total * numerator) / denominator;
  return [selected, total - selected];
}

export function allocateSplitOrderAmounts(
  order: Pick<OrderRow, (typeof DECIMAL_ORDER_FIELDS)[number] | "payIntegral">,
  selectedWeight: bigint,
  totalWeight: bigint,
): { selected: Partial<OrderInsert>; remaining: Partial<OrderInsert> } {
  const selected: Partial<OrderInsert> = {};
  const remaining: Partial<OrderInsert> = {};
  for (const field of DECIMAL_ORDER_FIELDS) {
    const [selectedMinor, remainingMinor] = allocateMinor(
      decimalToMinor(order[field]),
      selectedWeight,
      totalWeight,
    );
    selected[field] = minorToDecimal(selectedMinor);
    remaining[field] = minorToDecimal(remainingMinor);
  }
  const [selectedIntegral, remainingIntegral] = allocateMinor(
    BigInt(order.payIntegral),
    selectedWeight,
    totalWeight,
  );
  selected.payIntegral = Number(selectedIntegral);
  remaining.payIntegral = Number(remainingIntegral);
  return { selected, remaining };
}

function randomKey(): string {
  return crypto.randomUUID().replaceAll("-", "");
}

function childOrderId(parentOrderId: string, sequence: number): string {
  const suffix = `_${sequence}`;
  return `${parentOrderId.slice(0, Math.max(1, 32 - suffix.length))}${suffix}`;
}

export function reserveChildOrderIds(
  parentOrderId: string,
  existingOrderIds: Iterable<string>,
  count: number,
): string[] {
  const existing = new Set(existingOrderIds);
  const result: string[] = [];
  let sequence = existing.size + 1;
  while (result.length < count) {
    const candidate = childOrderId(parentOrderId, sequence++);
    if (existing.has(candidate)) continue;
    existing.add(candidate);
    result.push(candidate);
  }
  return result;
}

function parseSnapshot(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function nestedRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function orderCartUnitWeight(row: CartRow): bigint {
  const snapshot = parseSnapshot(row.cartInfo);
  const productInfo = nestedRecord(snapshot?.productInfo);
  const attrInfo = nestedRecord(productInfo?.attrInfo);
  const sku = nestedRecord(snapshot?.sku);
  for (const value of [snapshot?.truePrice, attrInfo?.price, sku?.price, row.settlePrice]) {
    const minor = decimalToMinor(value);
    if (minor > 0n) return minor;
  }
  return 1n;
}

function splitSnapshot(
  value: string | null,
  selectedQty: number,
  totalQty: number,
): [string | null, string | null] {
  const parsed = parseSnapshot(value);
  if (!parsed || totalQty <= 0) return [value, value];
  const selected = structuredClone(parsed);
  const remaining = structuredClone(parsed);
  selected.cart_num = selectedQty;
  remaining.cart_num = totalQty - selectedQty;
  for (const field of SNAPSHOT_ALLOCATED_FIELDS) {
    if (!(field in parsed)) continue;
    const [selectedMinor, remainingMinor] = allocateMinor(
      decimalToMinor(parsed[field]),
      BigInt(selectedQty),
      BigInt(totalQty),
    );
    selected[field] = minorToDecimal(selectedMinor);
    remaining[field] = minorToDecimal(remainingMinor);
  }
  return [JSON.stringify(selected), JSON.stringify(remaining)];
}

function cartDisplay(row: CartRow) {
  const snapshot = parseSnapshot(row.cartInfo);
  const product = nestedRecord(snapshot?.product);
  const productInfo = nestedRecord(snapshot?.productInfo);
  const sku = nestedRecord(snapshot?.sku);
  const attrInfo = nestedRecord(productInfo?.attrInfo);
  return {
    id: row.id,
    cart_id: row.cartId,
    product_id: row.productId,
    sku_unique: row.skuUnique,
    cart_num: row.cartNum,
    refund_num: row.refundNum,
    surplus_num: row.splitSurplusNum,
    product_name: String(product?.storeName ?? productInfo?.store_name ?? "商品快照"),
    image: String(product?.image ?? productInfo?.image ?? ""),
    sku: String(sku?.suk ?? attrInfo?.suk ?? row.skuUnique),
    cart_info: snapshot,
  };
}

function cloneCart(
  row: CartRow,
  oid: number,
  cartId: string,
  cartNum: number,
  cartInfo: string | null,
  delivered: boolean,
): CartInsert {
  const { id: _id, ...base } = row;
  return {
    ...base,
    oid,
    cartId,
    oldCartId: row.oldCartId || row.cartId,
    cartNum,
    refundNum: 0,
    surplusNum: cartNum,
    splitSurplusNum: delivered ? 0 : cartNum,
    splitStatus: delivered ? 2 : 0,
    cartInfo,
    unique: randomKey(),
  };
}

async function assertNoOpenRefund(tx: SupplierTx, supplierId: number, orderId: number) {
  const openRefund = await tx
    .select({ id: storeOrderRefund.id })
    .from(storeOrderRefund)
    .where(
      and(
        eq(storeOrderRefund.storeOrderId, orderId),
        eq(storeOrderRefund.supplierId, supplierId),
        eq(storeOrderRefund.isCancel, 0),
        eq(storeOrderRefund.isDel, 0),
        sql`${storeOrderRefund.refundType} IN (0, 1, 2, 4, 5)`,
      ),
    )
    .limit(1);
  if (openRefund[0]) throw new ValidateException("订单存在进行中的售后，不能发货");
}

async function assertNoConflictingWaybillJob(
  tx: SupplierTx,
  rootOrderId: number,
  allowedJobId?: number,
): Promise<void> {
  const rows = await tx
    .select({ id: orderWaybillJob.id })
    .from(orderWaybillJob)
    .where(and(
      eq(orderWaybillJob.rootOrderId, rootOrderId),
      sql`${orderWaybillJob.status} IN (
        'PENDING', 'ENQUEUING', 'ENQUEUED', 'PROCESSING', 'RETRYABLE', 'UNKNOWN', 'DEAD'
      )`,
    ))
    .limit(2)
    .for("key share");
  if (rows.some((row) => row.id !== allowedJobId)) {
    throw new ValidateException("订单存在进行中的电子面单任务，请先在面单账本中处理");
  }
}

function assertDeliverable(order: OrderRow) {
  if (order.paid !== 1) throw new ValidateException("订单未支付");
  if (order.isDel || order.isSystemDel) throw new ValidateException("订单已删除，不能发货");
  if (order.shippingType === 2) throw new ValidateException("核销订单不能发货");
  if (order.status !== 0) throw new ValidateException("订单状态不允许发货");
  if (![0, 3].includes(order.refundStatus)) throw new ValidateException("订单售后状态不允许发货");
}

function storeScope(expectedStoreId: number | undefined) {
  return expectedStoreId === undefined ? undefined : eq(storeOrder.storeId, expectedStoreId);
}

function replayPrefix(options: FulfillmentReplayOptions): string {
  if (!Number.isSafeInteger(options.accountId) || options.accountId <= 0) {
    throw new ValidateException("外部账户ID无效");
  }
  if (!/^[0-9a-f]{64}$/.test(options.requestHash)) {
    throw new ValidateException("外部发货请求摘要无效");
  }
  return `{"v":1,"account":${options.accountId},"request":"${options.requestHash}",`;
}

function parseReplayMessage(
  message: string,
  options: FulfillmentReplayOptions,
): FulfillmentExecutionResult | null {
  try {
    const parsed = JSON.parse(message) as Record<string, unknown>;
    if (
      parsed.v !== 1
      || parsed.account !== options.accountId
      || parsed.request !== options.requestHash
      || typeof parsed.split !== "boolean"
      || !Number.isSafeInteger(parsed.order_id)
      || Number(parsed.order_id) <= 0
      || !(parsed.remaining_order_id === null
        || (Number.isSafeInteger(parsed.remaining_order_id) && Number(parsed.remaining_order_id) > 0))
    ) {
      return null;
    }
    return {
      split: parsed.split,
      order_id: Number(parsed.order_id),
      remaining_order_id: parsed.remaining_order_id === null
        ? null
        : Number(parsed.remaining_order_id),
      idempotent: true,
    };
  } catch {
    return null;
  }
}

async function findFulfillmentReplay(
  tx: SupplierTx,
  rootId: number,
  options: FulfillmentReplayOptions | undefined,
): Promise<FulfillmentExecutionResult | null> {
  if (!options) return null;
  const prefix = replayPrefix(options);
  const rows = await tx
    .select({ changeMessage: storeOrderStatus.changeMessage })
    .from(storeOrderStatus)
    .where(and(
      eq(storeOrderStatus.oid, rootId),
      eq(storeOrderStatus.changeType, options.changeType),
      sql`${storeOrderStatus.changeMessage} LIKE ${`${prefix}%`}`,
    ))
    .orderBy(desc(storeOrderStatus.id))
    .limit(2);
  const parsed = rows
    .map((row) => parseReplayMessage(row.changeMessage, options))
    .filter((row): row is FulfillmentExecutionResult => row !== null);
  if (parsed.length > 1 && JSON.stringify(parsed[0]) !== JSON.stringify(parsed[1])) {
    throw new ValidateException("外部发货重放证据冲突，请先完成数据核对");
  }
  return parsed[0] ?? null;
}

async function recordFulfillmentReplay(
  tx: SupplierTx,
  rootId: number,
  options: FulfillmentReplayOptions | undefined,
  result: Omit<FulfillmentExecutionResult, "idempotent">,
): Promise<void> {
  if (!options) return;
  replayPrefix(options);
  const message = JSON.stringify({
    v: 1,
    account: options.accountId,
    request: options.requestHash,
    split: result.split,
    order_id: result.order_id,
    remaining_order_id: result.remaining_order_id,
  });
  if (message.length > 256) throw new ValidateException("外部发货重放证据过长");
  await tx.insert(storeOrderStatus).values({
    oid: rootId,
    changeType: options.changeType,
    changeMessage: message,
    changeTime: Math.floor(Date.now() / 1000),
  });
}

async function recordFulfillmentAudit(
  tx: SupplierTx,
  rootId: number,
  audit: FulfillmentAuditStatus | undefined,
): Promise<void> {
  if (!audit) return;
  if (!/^[a-z][a-z0-9_]{0,31}$/.test(audit.changeType)) {
    throw new ValidateException("发货审计类型错误");
  }
  const message = audit.changeMessage.trim();
  if (!message || message.length > 255) throw new ValidateException("发货审计内容错误");
  await tx.insert(storeOrderStatus).values({
    oid: rootId,
    changeType: audit.changeType,
    changeMessage: message,
    changeTime: Math.floor(Date.now() / 1_000),
  });
}

async function assertPinkCompleted(tx: SupplierTx, order: OrderRow): Promise<void> {
  if (order.type !== 3) return;
  const rows = await tx
    .select({ status: storePink.status })
    .from(storePink)
    .where(eq(storePink.id, order.pinkId))
    .limit(1)
    .for("key share");
  if (!rows[0] || rows[0].status !== 2) {
    throw new ValidateException("拼团尚未成功，不能发货");
  }
}

async function assertPresaleEnded(tx: SupplierTx, order: OrderRow): Promise<void> {
  if (order.type !== 6) return;
  const rows = await tx
    .select({ cartInfo: storeOrderCartInfo.cartInfo })
    .from(storeOrderCartInfo)
    .where(eq(storeOrderCartInfo.oid, order.id))
    .orderBy(asc(storeOrderCartInfo.id))
    .for("key share");
  const now = Math.floor(Date.now() / 1_000);
  for (const row of rows) {
    const snapshot = parseSnapshot(row.cartInfo);
    const productInfo = nestedRecord(snapshot?.productInfo);
    const endTime = Number(productInfo?.presale_end_time ?? 0);
    if (Number.isFinite(endTime) && endTime > now) {
      throw new ValidateException("预售活动尚未结束，不能发货");
    }
  }
}

async function resolveLockedOrder(
  tx: SupplierTx,
  supplierId: number,
  requestedOrderId: number,
  expectedStoreId?: number,
  authorize?: FulfillmentExecutionOptions["authorize"],
): Promise<{ root: OrderRow; active: OrderRow | null }> {
  const references = await tx
    .select({
      id: storeOrder.id,
      pid: storeOrder.pid,
      uid: storeOrder.uid,
      supplierId: storeOrder.supplierId,
    })
    .from(storeOrder)
    .where(
      and(
        eq(storeOrder.id, requestedOrderId),
        eq(storeOrder.supplierId, supplierId),
        eq(storeOrder.isSystemDel, 0),
        storeScope(expectedStoreId),
      ),
    )
    .limit(1);
  const reference = references[0];
  if (!reference) throw new NotFoundException("订单不存在或不属于当前供应商");
  const rootId = reference.pid > 0 ? reference.pid : reference.id;

  await authorize?.(tx, {
    requestedOrderId: reference.id,
    rootOrderId: rootId,
    customerUid: reference.uid,
    supplierId: reference.supplierId,
  });

  await lockOrderSettlement(tx, rootId);
  const roots = await tx
    .select()
    .from(storeOrder)
    .where(
      and(
        eq(storeOrder.id, rootId),
        eq(storeOrder.supplierId, supplierId),
        eq(storeOrder.isSystemDel, 0),
        storeScope(expectedStoreId),
      ),
    )
    .limit(1)
    .for("update");
  const root = roots[0];
  if (!root) throw new NotFoundException("订单不存在或不属于当前供应商");
  if (reference.id !== root.id) {
    const requested = await tx
      .select()
      .from(storeOrder)
      .where(
        and(
          eq(storeOrder.id, reference.id),
          eq(storeOrder.pid, root.id),
          eq(storeOrder.supplierId, supplierId),
          eq(storeOrder.isSystemDel, 0),
          storeScope(expectedStoreId),
        ),
      )
      .limit(1)
      .for("update");
    if (!requested[0]) throw new NotFoundException("拆分子单不存在或不属于当前供应商");
    return { root, active: requested[0] };
  }
  if (root.pid !== -1) return { root, active: root };

  const pending = await tx
    .select()
    .from(storeOrder)
    .where(
      and(
        eq(storeOrder.pid, root.id),
        eq(storeOrder.supplierId, supplierId),
        eq(storeOrder.status, 0),
        eq(storeOrder.isDel, 0),
        eq(storeOrder.isSystemDel, 0),
        storeScope(expectedStoreId),
      ),
    )
    .orderBy(asc(storeOrder.id))
    .limit(2)
    .for("update");
  if (pending.length === 0) return { root, active: null };
  if (pending.length > 1) throw new ValidateException("订单存在多个待发货子单，请先完成数据核对");
  return { root, active: pending[0] };
}

async function applyDelivery(
  tx: SupplierTx,
  supplierId: number,
  order: OrderRow,
  input: SupplierDeliveryInput,
  expectedStoreId?: number,
  waybillMetadata?: FulfillmentWaybillMetadata,
) {
  const now = Math.floor(Date.now() / 1_000);
  assertDeliverable(order);
  await assertPinkCompleted(tx, order);
  await assertPresaleEnded(tx, order);
  await assertNoOpenRefund(tx, supplierId, order.id);
  if (input.deliveryType === "send") {
    if (!input.deliveryUid || !input.deliveryName || !input.deliveryId) {
      throw new ValidateException("配送员信息不完整");
    }
  }
  const verifyCode = input.deliveryType === "send"
    ? await generatePickupVerifyCode(tx, order.id)
    : undefined;
  const updated = await tx
    .update(storeOrder)
    .set({
      status: 1,
      deliveryType: input.deliveryType,
      deliveryName: input.deliveryName,
      deliveryCode: input.deliveryCode,
      deliveryId: input.deliveryId,
      fictitiousContent: input.fictitiousContent,
      deliveryUid: input.deliveryUid,
      ...(verifyCode ? { verifyCode } : {}),
      ...(waybillMetadata ? {
        expressDump: waybillMetadata.expressDump,
        kuaidiLabel: waybillMetadata.labelUrl,
        isStockUp: 1,
      } : {}),
    })
    .where(
      and(
        eq(storeOrder.id, order.id),
        eq(storeOrder.supplierId, supplierId),
        eq(storeOrder.paid, 1),
        eq(storeOrder.status, 0),
        eq(storeOrder.isDel, 0),
        eq(storeOrder.isSystemDel, 0),
        storeScope(expectedStoreId),
      ),
    )
    .returning({ id: storeOrder.id });
  if (!updated[0]) throw new ValidateException("订单已被处理，请刷新后重试");

  const description =
    input.deliveryType === "fictitious"
      ? `虚拟发货：${input.fictitiousContent}`
      : input.deliveryType === "send"
        ? `已配送：${input.deliveryName} ${input.deliveryId}`
      : `已发货：${input.deliveryName} ${input.deliveryId}`;
  await tx.insert(storeOrderStatus).values({
    oid: order.id,
    changeType: input.deliveryType === "fictitious"
      ? "delivery_fictitious"
      : input.deliveryType === "send"
        ? "delivery"
        : "delivery_goods",
    changeMessage: description,
    changeTime: now,
  });
  await enqueueOrderDeliveryNoticeEvent(tx, {
    orderId: order.id,
    orderNo: order.orderId,
    userId: order.uid,
    userAddress: order.userAddress,
    deliveryType: input.deliveryType,
    deliveryName: input.deliveryName,
    deliveryId: input.deliveryId,
  }, now);
}

async function readableOrder(
  container: Container,
  supplierId: number,
  requestedOrderId: number,
): Promise<{ root: OrderRow; active: OrderRow | null }> {
  const references = await container.db
    .select()
    .from(storeOrder)
    .where(
      and(
        eq(storeOrder.id, requestedOrderId),
        eq(storeOrder.supplierId, supplierId),
        eq(storeOrder.isSystemDel, 0),
      ),
    )
    .limit(1);
  const reference = references[0];
  if (!reference) throw new NotFoundException("订单不存在或不属于当前供应商");
  const rootId = reference.pid > 0 ? reference.pid : reference.id;
  const roots =
    rootId === reference.id
      ? [reference]
      : await container.db
          .select()
          .from(storeOrder)
          .where(
            and(
              eq(storeOrder.id, rootId),
              eq(storeOrder.supplierId, supplierId),
              eq(storeOrder.isSystemDel, 0),
            ),
          )
          .limit(1);
  const root = roots[0];
  if (!root) throw new NotFoundException("主订单不存在或不属于当前供应商");
  if (reference.id !== root.id) {
    return { root, active: reference.status === 0 ? reference : null };
  }
  if (root.pid !== -1) return { root, active: root.status === 0 ? root : null };
  const pending = await container.db
    .select()
    .from(storeOrder)
    .where(
      and(
        eq(storeOrder.pid, root.id),
        eq(storeOrder.supplierId, supplierId),
        eq(storeOrder.status, 0),
        eq(storeOrder.isDel, 0),
        eq(storeOrder.isSystemDel, 0),
      ),
    )
    .orderBy(asc(storeOrder.id))
    .limit(2);
  if (pending.length > 1) throw new ValidateException("订单存在多个待发货子单，请先完成数据核对");
  return { root, active: pending[0] ?? null };
}

export class SupplierFulfillmentService {
  constructor(
    private readonly container: Container,
    private readonly env: SystemConfigEnv,
  ) {}

  async expressList() {
    return this.container.db
      .select({ id: expressCompany.id, code: expressCompany.code, name: expressCompany.name })
      .from(expressCompany)
      .where(and(eq(expressCompany.isShow, 1), eq(expressCompany.status, 1)))
      .orderBy(desc(expressCompany.sort), expressCompany.id);
  }

  async deliver(
    supplierId: number,
    orderId: number,
    input: SupplierDeliveryInput,
    options: FulfillmentExecutionOptions = {},
  ): Promise<FulfillmentExecutionResult> {
    return withTx(this.container, async (tx) => {
      await tx.execute(sql.raw("SET LOCAL lock_timeout = '2s'"));
      await tx.execute(sql.raw("SET LOCAL statement_timeout = '10s'"));
      const { root, active } = await resolveLockedOrder(
        tx,
        supplierId,
        orderId,
        options.expectedStoreId,
        options.authorize,
      );
      const replay = await findFulfillmentReplay(tx, root.id, options.replay);
      if (replay) return replay;
      await assertNoConflictingWaybillJob(tx, root.id, options.waybillJobId);
      if (!active) throw new ValidateException("该订单已全部发货");
      await applyDelivery(
        tx,
        supplierId,
        active,
        input,
        options.expectedStoreId,
        options.waybillMetadata,
      );
      if (root.id !== active.id) {
        await tx.insert(storeOrderStatus).values({
          oid: root.id,
          changeType: "delivery_split",
          changeMessage: "已拆分发货完成",
          changeTime: Math.floor(Date.now() / 1000),
        });
      }
      const result = {
        split: false,
        order_id: active.id,
        remaining_order_id: null,
      };
      await recordFulfillmentAudit(tx, root.id, options.audit);
      await recordFulfillmentReplay(tx, root.id, options.replay, result);
      return { ...result, idempotent: false };
    });
  }

  async splitCartInfo(supplierId: number, orderId: number) {
    const { active } = await readableOrder(this.container, supplierId, orderId);
    if (!active) return [];
    assertDeliverable(active);
    const rows = await this.container.db
      .select()
      .from(storeOrderCartInfo)
      .where(
        and(
          eq(storeOrderCartInfo.oid, active.id),
          sql`${storeOrderCartInfo.splitStatus} IN (0, 1)`,
          sql`${storeOrderCartInfo.splitSurplusNum} > 0`,
        ),
      )
      .orderBy(asc(storeOrderCartInfo.id));
    return rows.map(cartDisplay);
  }

  async splitOrders(supplierId: number, orderId: number) {
    const { root } = await readableOrder(this.container, supplierId, orderId);
    const children = await this.container.db
      .select()
      .from(storeOrder)
      .where(
        and(
          eq(storeOrder.pid, root.id),
          eq(storeOrder.supplierId, supplierId),
          eq(storeOrder.isSystemDel, 0),
        ),
      )
      .orderBy(asc(storeOrder.id));
    const orders = children.length > 0 ? children : [root];
    const cartRows = await this.container.db
      .select()
      .from(storeOrderCartInfo)
      .where(inArray(storeOrderCartInfo.oid, orders.map((order) => order.id)))
      .orderBy(asc(storeOrderCartInfo.id));
    const cartsByOrder = new Map<number, ReturnType<typeof cartDisplay>[]>();
    for (const cart of cartRows) {
      const list = cartsByOrder.get(cart.oid) ?? [];
      list.push(cartDisplay(cart));
      cartsByOrder.set(cart.oid, list);
    }
    return orders.map((order) => ({
      id: order.id,
      pid: order.pid,
      order_id: order.orderId,
      total_num: order.totalNum,
      pay_price: order.payPrice,
      paid: order.paid,
      status: order.status,
      refund_status: order.refundStatus,
      delivery_type: order.deliveryType,
      delivery_name: order.deliveryName,
      delivery_code: order.deliveryCode,
      delivery_id: order.deliveryId,
      fictitious_content: order.fictitiousContent,
      cart_info: cartsByOrder.get(order.id) ?? [],
    }));
  }

  async splitDelivery(
    supplierId: number,
    orderId: number,
    input: SupplierDeliveryInput,
    selectedCarts: SupplierSplitCartInput[],
    options: FulfillmentExecutionOptions = {},
  ): Promise<FulfillmentExecutionResult> {
    return withTx(this.container, async (tx) => {
      await tx.execute(sql.raw("SET LOCAL lock_timeout = '2s'"));
      await tx.execute(sql.raw("SET LOCAL statement_timeout = '10s'"));
      const { root, active } = await resolveLockedOrder(
        tx,
        supplierId,
        orderId,
        options.expectedStoreId,
        options.authorize,
      );
      const replay = await findFulfillmentReplay(tx, root.id, options.replay);
      if (replay) return replay;
      await assertNoConflictingWaybillJob(tx, root.id, options.waybillJobId);
      if (!active) throw new ValidateException("该订单已全部发货");
      assertDeliverable(active);
      await assertPinkCompleted(tx, active);
      await assertPresaleEnded(tx, active);
      await assertNoOpenRefund(tx, supplierId, active.id);

      const cartRows = await tx
        .select()
        .from(storeOrderCartInfo)
        .where(eq(storeOrderCartInfo.oid, active.id))
        .orderBy(asc(storeOrderCartInfo.id))
        .for("update");
      const available = cartRows.filter(
        (cart) => cart.splitStatus < 2 && cart.splitSurplusNum > 0,
      );
      if (available.length === 0) throw new ValidateException("该订单已发货完成");

      const availableByCartId = new Map<string, CartRow>();
      for (const cart of available) {
        if (availableByCartId.has(cart.cartId)) {
          throw new ValidateException("订单商品快照ID重复，请先完成数据核对");
        }
        availableByCartId.set(cart.cartId, cart);
      }
      const selectedByCartId = new Map(selectedCarts.map((cart) => [cart.cartId, cart.cartNum]));
      for (const selected of selectedCarts) {
        const cart = availableByCartId.get(selected.cartId);
        if (!cart) throw new ValidateException("所选商品已拆分，请刷新后重试");
        if (selected.cartNum > cart.splitSurplusNum) {
          throw new ValidateException("发货件数大于商品可发货数量");
        }
      }

      const totalQuantity = available.reduce((sum, cart) => sum + cart.splitSurplusNum, 0);
      const selectedQuantity = selectedCarts.reduce((sum, cart) => sum + cart.cartNum, 0);
      if (selectedQuantity >= totalQuantity) {
        await applyDelivery(
          tx,
          supplierId,
          active,
          input,
          options.expectedStoreId,
          options.waybillMetadata,
        );
        if (root.id !== active.id) {
          await tx.insert(storeOrderStatus).values({
            oid: root.id,
            changeType: "delivery_split",
            changeMessage: "已拆分发货完成",
            changeTime: Math.floor(Date.now() / 1000),
          });
        }
        const result = { split: false, order_id: active.id, remaining_order_id: null };
        await recordFulfillmentAudit(tx, root.id, options.audit);
        await recordFulfillmentReplay(tx, root.id, options.replay, result);
        return { ...result, idempotent: false };
      }

      let totalWeight = 0n;
      let selectedWeight = 0n;
      for (const cart of available) {
        const weight = orderCartUnitWeight(cart);
        totalWeight += weight * BigInt(cart.splitSurplusNum);
        selectedWeight += weight * BigInt(selectedByCartId.get(cart.cartId) ?? 0);
      }
      const amounts = allocateSplitOrderAmounts(active, selectedWeight, totalWeight);

      const existingChildren = await tx
        .select({ id: storeOrder.id, orderId: storeOrder.orderId })
        .from(storeOrder)
        .where(eq(storeOrder.pid, root.id))
        .orderBy(asc(storeOrder.id))
        .for("update");
      const firstSplit = root.id === active.id && root.pid === 0;
      const [selectedOrderId, remainingOrderId] = reserveChildOrderIds(
        root.orderId,
        existingChildren.map((child) => child.orderId),
        firstSplit ? 2 : 1,
      );

      const { id: _activeId, ...activeBase } = active;
      const selectedVerifyCode = input.deliveryType === "send"
        ? await generatePickupVerifyCode(tx)
        : active.verifyCode;
      const selectedCartIds = new Map<string, string>();
      const selectedCartRows: Array<{
        source: CartRow;
        cartId: string;
        quantity: number;
        cartInfo: string | null;
      }> = [];
      const remainingCartRows: Array<{
        source: CartRow;
        cartId: string;
        quantity: number;
        cartInfo: string | null;
      }> = [];
      for (const cart of available) {
        const selected = selectedByCartId.get(cart.cartId) ?? 0;
        const remaining = cart.splitSurplusNum - selected;
        const [selectedSnapshot, remainingSnapshot] = splitSnapshot(
          cart.cartInfo,
          selected,
          cart.splitSurplusNum,
        );
        if (selected > 0) {
          const cartId = randomKey();
          selectedCartIds.set(cart.cartId, cartId);
          selectedCartRows.push({
            source: cart,
            cartId,
            quantity: selected,
            cartInfo: selectedSnapshot,
          });
        }
        if (remaining > 0) {
          remainingCartRows.push({
            source: cart,
            cartId: firstSplit ? randomKey() : cart.cartId,
            quantity: remaining,
            cartInfo: remainingSnapshot,
          });
        }
      }

      const selectedOrder = await tx
        .insert(storeOrder)
        .values({
          ...activeBase,
          ...amounts.selected,
          pid: root.id,
          orderId: selectedOrderId,
          unique: randomKey(),
          cartId: [...selectedCartIds.values()].join(","),
          totalNum: selectedQuantity,
          status: 1,
          deliveryType: input.deliveryType,
          deliveryName: input.deliveryName,
          deliveryCode: input.deliveryCode,
          deliveryId: input.deliveryId,
          fictitiousContent: input.fictitiousContent,
          deliveryUid: input.deliveryUid,
          verifyCode: selectedVerifyCode,
          ...(options.waybillMetadata ? {
            expressDump: options.waybillMetadata.expressDump,
            kuaidiLabel: options.waybillMetadata.labelUrl,
            isStockUp: 1,
          } : {}),
        })
        .returning({ id: storeOrder.id });
      const selectedOrderPk = selectedOrder[0]?.id;
      if (!selectedOrderPk) throw new ValidateException("生成拆分发货子单失败");
      await tx.insert(storeOrderCartInfo).values(
        selectedCartRows.map((cart) =>
          cloneCart(
            cart.source,
            selectedOrderPk,
            cart.cartId,
            cart.quantity,
            cart.cartInfo,
            true,
          ),
        ),
      );

      let remainingOrderPk: number;
      if (firstSplit) {
        const remainingOrder = await tx
          .insert(storeOrder)
          .values({
            ...activeBase,
            ...amounts.remaining,
            pid: root.id,
            orderId: remainingOrderId,
            unique: randomKey(),
            cartId: remainingCartRows.map((cart) => cart.cartId).join(","),
            totalNum: totalQuantity - selectedQuantity,
            status: 0,
            deliveryType: "",
            deliveryName: "",
            deliveryCode: "",
            deliveryId: "",
            fictitiousContent: "",
            deliveryUid: 0,
            verifyCode: "",
          })
          .returning({ id: storeOrder.id });
        remainingOrderPk = remainingOrder[0]?.id ?? 0;
        if (!remainingOrderPk) throw new ValidateException("生成待发货子单失败");
        await tx.insert(storeOrderCartInfo).values(
          remainingCartRows.map((cart) =>
            cloneCart(
              cart.source,
              remainingOrderPk,
              cart.cartId,
              cart.quantity,
              cart.cartInfo,
              false,
            ),
          ),
        );
        await tx
          .update(storeOrderCartInfo)
          .set({ splitStatus: 2, splitSurplusNum: 0 })
          .where(eq(storeOrderCartInfo.oid, root.id));
        await tx.update(storeOrder).set({ pid: -1 }).where(eq(storeOrder.id, root.id));
      } else {
        remainingOrderPk = active.id;
        await tx
          .update(storeOrder)
          .set({
            ...amounts.remaining,
            cartId: remainingCartRows.map((cart) => cart.cartId).join(","),
            totalNum: totalQuantity - selectedQuantity,
            status: 0,
            deliveryType: "",
            deliveryName: "",
            deliveryCode: "",
            deliveryId: "",
            fictitiousContent: "",
            deliveryUid: 0,
            verifyCode: "",
          })
          .where(eq(storeOrder.id, active.id));
        await tx.delete(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid, active.id));
        await tx.insert(storeOrderCartInfo).values(
          remainingCartRows.map((cart) =>
            cloneCart(
              cart.source,
              active.id,
              cart.cartId,
              cart.quantity,
              cart.cartInfo,
              false,
            ),
          ),
        );
      }

      const now = Math.floor(Date.now() / 1000);
      const description =
        input.deliveryType === "fictitious"
          ? `虚拟发货：${input.fictitiousContent}`
          : input.deliveryType === "send"
            ? `已配送：${input.deliveryName} ${input.deliveryId}`
          : `已发货：${input.deliveryName} ${input.deliveryId}`;
      await tx.insert(storeOrderStatus).values([
        {
          oid: selectedOrderPk,
          changeType: "split_create_order",
          changeMessage: "发货拆分生成订单",
          changeTime: now,
        },
        {
          oid: selectedOrderPk,
          changeType: input.deliveryType === "fictitious"
            ? "delivery_fictitious"
            : input.deliveryType === "send"
              ? "delivery"
              : "delivery_goods",
          changeMessage: description,
          changeTime: now,
        },
        {
          oid: root.id,
          changeType: "delivery_part_split",
          changeMessage: "已拆分部分发货",
          changeTime: now,
        },
      ]);
      if (firstSplit) {
        await tx.insert(storeOrderStatus).values({
          oid: remainingOrderPk,
          changeType: "split_create_order",
          changeMessage: "发货拆分生成订单",
          changeTime: now,
        });
      }
      await enqueueOrderDeliveryNoticeEvent(tx, {
        orderId: selectedOrderPk,
        orderNo: selectedOrderId,
        userId: activeBase.uid,
        userAddress: activeBase.userAddress,
        deliveryType: input.deliveryType,
        deliveryName: input.deliveryName,
        deliveryId: input.deliveryId,
      }, now);
      const result = {
        split: true,
        order_id: selectedOrderPk,
        remaining_order_id: remainingOrderPk,
      };
      await recordFulfillmentAudit(tx, root.id, options.audit);
      await recordFulfillmentReplay(tx, root.id, options.replay, result);
      return { ...result, idempotent: false };
    });
  }

  async statusLogs(supplierId: number, orderId: number) {
    const scoped = await this.container.db
      .select({ id: storeOrder.id })
      .from(storeOrder)
      .where(
        and(
          eq(storeOrder.id, orderId),
          eq(storeOrder.supplierId, supplierId),
          eq(storeOrder.isSystemDel, 0),
        ),
      )
      .limit(1);
    if (!scoped[0]) throw new NotFoundException("订单不存在或不属于当前供应商");
    return this.container.db
      .select()
      .from(storeOrderStatus)
      .where(eq(storeOrderStatus.oid, orderId))
      .orderBy(desc(storeOrderStatus.changeTime), desc(storeOrderStatus.id));
  }

  async confirmTake(supplierId: number, orderId: number) {
    const completed = await completeOrderReceipt(this.container, this.env, {
      orderId,
      actor: "supplier",
      actorId: supplierId,
      message: "供应商确认收货",
    });
    if (!completed) throw new ValidateException("订单不存在或状态不允许确认收货");
  }
}
