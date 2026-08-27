import { and, eq, exists, inArray, sql } from "drizzle-orm";
import type { Container, DbClient } from "@/lib/di";
import { withTx } from "@/lib/di";
import {
  storeOrder,
  storeOrderRefund,
  storeOrderStatus,
  storeServiceRecord,
} from "@/models/schema";
import {
  KEFU_ORDER_LOCK_NAMESPACE,
  lockKefuConversationOwnership,
  ownedKefuConversation,
} from "@/services/kefu/KefuOwnership";
import { centsToDecimal, decimalToCents } from "@/services/order/OrderBrokerageService";
import { lockOrderSettlement } from "@/services/order/OrderBrokerageService";
import {
  lockRefundExecution,
  StoreOrderRefundService,
} from "@/services/order/StoreOrderRefundService";
import type { Env } from "@/env";
import { NotFoundException, ValidateException } from "@/utils/errors";

const MAX_ORDER_ID_LENGTH = 50;
const MAX_ORDER_REMARK_LENGTH = 512;
const MAX_REFUND_REMARK_LENGTH = 255;
const MAX_MONEY_CENTS = 999_999_999_999;
const MAX_CHANGE_PRICE_CENTS = 99_999_999;
const MAX_GAIN_INTEGRAL = 9_999_999_999;
const REFUND_FORM_BLOCKING_TYPES = [1, 2, 4, 5, 6] as const;

type OrderRow = typeof storeOrder.$inferSelect;
type RefundRow = typeof storeOrderRefund.$inferSelect;

export interface KefuOrderEditInput {
  orderId: string;
  payPriceCents: number;
  gainIntegral: number;
  readonlyValues: {
    totalPriceCents?: number;
    totalPostageCents?: number;
    payPostageCents?: number;
  };
}

export interface KefuManagementFormField {
  field: string;
  label: string;
  type: "input" | "number";
  value: string;
  disabled?: boolean;
  min?: number;
  precision?: number;
  required?: boolean;
}

export interface KefuManagementForm {
  title: string;
  action: string;
  method: "PUT";
  fields: KefuManagementFormField[];
}

export interface KefuRefundDecisionInput {
  type: 1;
  refundPriceCents: number;
}

function positiveInteger(value: unknown, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > 2_147_483_647) {
    throw new ValidateException(`${label}错误`);
  }
  return parsed;
}

function normalizedText(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== "string") throw new ValidateException(`${label}格式错误`);
  const normalized = value.trim();
  if (!normalized) throw new ValidateException(`请填写${label}`);
  if (normalized.length > maxLength) throw new ValidateException(`${label}不能超过${maxLength}个字符`);
  return normalized;
}

function parseMoneyCents(value: unknown, label: string): number {
  let normalized: string;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) throw new ValidateException(`${label}格式错误`);
    const cents = Math.round(value * 100);
    if (!Number.isSafeInteger(cents) || Math.abs(value * 100 - cents) > 1e-7) {
      throw new ValidateException(`${label}最多保留两位小数`);
    }
    normalized = value.toFixed(2);
  } else if (typeof value === "string") {
    normalized = value.trim();
  } else {
    throw new ValidateException(`${label}格式错误`);
  }
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) throw new ValidateException(`${label}格式错误`);
  let cents: number;
  try {
    cents = decimalToCents(normalized);
  } catch {
    throw new ValidateException(`${label}超出允许范围`);
  }
  if (cents > MAX_MONEY_CENTS) throw new ValidateException(`${label}超出允许范围`);
  return cents;
}

function optionalMoneyCents(value: unknown, label: string): number | undefined {
  return value === undefined ? undefined : parseMoneyCents(value, label);
}

export function parseKefuRefundDecisionInput(
  input: Record<string, unknown>,
): KefuRefundDecisionInput {
  const type = input.type === undefined ? 1 : Number(input.type);
  if (type !== 1) {
    throw new ValidateException("客服资金退款仅接受同意操作，拒绝退款请使用独立审核入口");
  }
  if (input.refund_price === undefined) throw new ValidateException("请输入退款金额");
  return { type: 1, refundPriceCents: parseMoneyCents(input.refund_price, "退款金额") };
}

function parseGainIntegral(value: unknown): number {
  const normalized = typeof value === "number" ? String(value) : typeof value === "string" ? value.trim() : "";
  if (!/^\d+$/.test(normalized)) throw new ValidateException("赠送积分必须是非负整数");
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed) || parsed > MAX_GAIN_INTEGRAL) {
    throw new ValidateException("赠送积分超出允许范围");
  }
  return parsed;
}

export function parseKefuOrderEditInput(input: Record<string, unknown>): KefuOrderEditInput {
  const orderId = normalizedText(input.order_id, "订单编号", 32);
  if (!/^[A-Za-z0-9]+$/.test(orderId)) throw new ValidateException("订单编号格式错误");
  if (input.pay_price === undefined) throw new ValidateException("请输入实际支付金额");
  if (input.gain_integral === undefined) throw new ValidateException("请输入赠送积分");
  return {
    orderId,
    payPriceCents: parseMoneyCents(input.pay_price, "实际支付金额"),
    gainIntegral: parseGainIntegral(input.gain_integral),
    readonlyValues: {
      totalPriceCents: optionalMoneyCents(input.total_price, "商品总价"),
      totalPostageCents: optionalMoneyCents(input.total_postage, "原始邮费"),
      payPostageCents: optionalMoneyCents(input.pay_postage, "实际支付邮费"),
    },
  };
}

function signedCentsToDecimal(cents: number): string {
  if (!Number.isSafeInteger(cents) || Math.abs(cents) > MAX_CHANGE_PRICE_CENTS) {
    throw new ValidateException("改价差额超出允许范围");
  }
  return cents < 0 ? `-${centsToDecimal(Math.abs(cents))}` : centsToDecimal(cents);
}

function signedDecimalToCents(value: string): number {
  const normalized = value.trim();
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(normalized);
  if (!match) throw new ValidateException("历史改价数据异常，请先人工核对");
  const cents = Number(match[2]) * 100 + Number((match[3] ?? "").padEnd(2, "0"));
  const signed = match[1] ? -cents : cents;
  if (!Number.isSafeInteger(signed)) throw new ValidateException("历史改价数据异常，请先人工核对");
  return signed;
}

function moneyEquals(value: string, cents: number): boolean {
  try {
    return decimalToCents(value) === cents;
  } catch {
    return false;
  }
}

function assertReadonlyOrderValues(order: OrderRow, input: KefuOrderEditInput): void {
  if (
    (input.readonlyValues.totalPriceCents !== undefined && !moneyEquals(order.totalPrice, input.readonlyValues.totalPriceCents)) ||
    (input.readonlyValues.totalPostageCents !== undefined && !moneyEquals(order.totalPostage, input.readonlyValues.totalPostageCents)) ||
    (input.readonlyValues.payPostageCents !== undefined && !moneyEquals(order.payPostage, input.readonlyValues.payPostageCents))
  ) {
    throw new ValidateException("订单只读金额已变化，请刷新后重试");
  }
}

function ownedOrderConversation(db: DbClient, kefuUid: number) {
  return exists(db
    .select({ id: storeServiceRecord.id })
    .from(storeServiceRecord)
    .where(and(
      eq(storeServiceRecord.userId, kefuUid),
      eq(storeServiceRecord.toUid, storeOrder.uid),
      eq(storeServiceRecord.isTourist, 0),
    )));
}

function ownedRefundConversation(db: DbClient, kefuUid: number) {
  return exists(db
    .select({ id: storeServiceRecord.id })
    .from(storeServiceRecord)
    .where(and(
      eq(storeServiceRecord.userId, kefuUid),
      eq(storeServiceRecord.toUid, storeOrderRefund.uid),
      eq(storeServiceRecord.isTourist, 0),
    )));
}

async function lockOwnedOrder(
  db: DbClient,
  kefuUid: number,
  id: number,
  preliminaryUid: number,
): Promise<OrderRow> {
  await lockKefuConversationOwnership(db, kefuUid, preliminaryUid);
  await db.execute(sql`SELECT pg_advisory_xact_lock(${KEFU_ORDER_LOCK_NAMESPACE}, ${id})`);
  const rows = await db.select().from(storeOrder).where(and(
    eq(storeOrder.id, id),
    eq(storeOrder.uid, preliminaryUid),
    eq(storeOrder.isDel, 0),
    eq(storeOrder.isSystemDel, 0),
    ownedKefuConversation(db, kefuUid, preliminaryUid),
  )).limit(1).for("update");
  if (!rows[0]) throw new NotFoundException("订单不存在或不属于当前会话");
  return rows[0];
}

async function selectOwnedRefundForUpdate(
  db: DbClient,
  kefuUid: number,
  id: number,
  preliminaryUid: number,
): Promise<RefundRow> {
  const rows = await db.select().from(storeOrderRefund).where(and(
    eq(storeOrderRefund.id, id),
    eq(storeOrderRefund.uid, preliminaryUid),
    eq(storeOrderRefund.isCancel, 0),
    eq(storeOrderRefund.isDel, 0),
    ownedKefuConversation(db, kefuUid, preliminaryUid),
  )).limit(1).for("update");
  if (!rows[0]) throw new NotFoundException("售后订单不存在或不属于当前会话");
  const order = (await db.select({ id: storeOrder.id }).from(storeOrder).where(and(
    eq(storeOrder.id, rows[0].storeOrderId),
    eq(storeOrder.uid, preliminaryUid),
    eq(storeOrder.isDel, 0),
    eq(storeOrder.isSystemDel, 0),
  )).limit(1))[0];
  if (!order) throw new NotFoundException("售后订单关联的原订单不存在");
  return rows[0];
}

async function lockOwnedRefund(
  db: DbClient,
  kefuUid: number,
  id: number,
  preliminaryUid: number,
): Promise<RefundRow> {
  await lockKefuConversationOwnership(db, kefuUid, preliminaryUid);
  return selectOwnedRefundForUpdate(db, kefuUid, id, preliminaryUid);
}

function orderEditForm(row: OrderRow): KefuManagementForm {
  return {
    title: "修改订单",
    action: `/order/update/${row.id}`,
    method: "PUT",
    fields: [
      { field: "order_id", label: "订单编号", type: "input", value: row.orderId, disabled: true },
      { field: "total_price", label: "商品总价", type: "number", value: row.totalPrice, min: 0, disabled: true },
      { field: "total_postage", label: "原始邮费", type: "number", value: row.totalPostage, min: 0, disabled: true },
      { field: "pay_postage", label: "实际支付邮费", type: "number", value: row.payPostage, disabled: true },
      { field: "pay_price", label: "实际支付金额", type: "number", value: row.payPrice, min: 0, precision: 2, required: true },
      { field: "gain_integral", label: "赠送积分", type: "number", value: String(Math.trunc(Number(row.gainIntegral))), min: 0, precision: 0, required: true },
    ],
  };
}

function refundForm(title: string, action: string, orderId: string, remainingCents: number): KefuManagementForm {
  return {
    title,
    action,
    method: "PUT",
    fields: [
      { field: "order_id", label: "退款单号", type: "input", value: orderId, disabled: true },
      { field: "refund_price", label: "退款金额", type: "number", value: centsToDecimal(remainingCents), min: 0, precision: 2, required: true },
    ],
  };
}

export class KefuOrderManagementService {
  constructor(
    private readonly container: Container,
    private readonly env?: Env,
  ) {}

  private async visibleOrder(kefuUid: number, idValue: unknown): Promise<OrderRow> {
    const id = positiveInteger(idValue, "订单ID");
    const row = (await this.container.db.select().from(storeOrder).where(and(
      eq(storeOrder.id, id),
      eq(storeOrder.isDel, 0),
      eq(storeOrder.isSystemDel, 0),
      ownedOrderConversation(this.container.db, kefuUid),
    )).limit(1))[0];
    if (!row) throw new NotFoundException("订单不存在或不属于当前会话");
    return row;
  }

  private async visibleRefund(
    kefuUid: number,
    idValue: unknown,
    db: DbClient = this.container.db,
  ): Promise<RefundRow> {
    const id = positiveInteger(idValue, "退款ID");
    const row = (await db.select().from(storeOrderRefund).where(and(
      eq(storeOrderRefund.id, id),
      eq(storeOrderRefund.isCancel, 0),
      eq(storeOrderRefund.isDel, 0),
      ownedRefundConversation(db, kefuUid),
    )).limit(1))[0];
    if (!row) throw new NotFoundException("售后订单不存在或不属于当前会话");
    const order = (await db.select({ id: storeOrder.id }).from(storeOrder).where(and(
      eq(storeOrder.id, row.storeOrderId),
      eq(storeOrder.uid, row.uid),
      eq(storeOrder.isDel, 0),
      eq(storeOrder.isSystemDel, 0),
    )).limit(1))[0];
    if (!order) throw new NotFoundException("售后订单关联的原订单不存在");
    return row;
  }

  async editForm(kefuUidValue: unknown, idValue: unknown): Promise<KefuManagementForm> {
    const kefuUid = positiveInteger(kefuUidValue, "客服身份");
    return orderEditForm(await this.visibleOrder(kefuUid, idValue));
  }

  async updateOrder(
    kefuUidValue: unknown,
    idValue: unknown,
    body: Record<string, unknown>,
  ) {
    const kefuUid = positiveInteger(kefuUidValue, "客服身份");
    const id = positiveInteger(idValue, "订单ID");
    const input = parseKefuOrderEditInput(body);
    return withTx(this.container, async (tx) => {
      await tx.execute(sql.raw("SET LOCAL lock_timeout = '2s'"));
      await tx.execute(sql.raw("SET LOCAL statement_timeout = '5s'"));
      const preliminary = (await tx.select({ uid: storeOrder.uid }).from(storeOrder).where(and(
        eq(storeOrder.id, id),
        eq(storeOrder.isDel, 0),
        eq(storeOrder.isSystemDel, 0),
      )).limit(1))[0];
      if (!preliminary) throw new NotFoundException("订单不存在或不属于当前会话");
      const order = await lockOwnedOrder(tx, kefuUid, id, preliminary.uid);
      if (order.orderId !== input.orderId) throw new ValidateException("订单编号与当前订单不一致");
      if (order.paid !== 0) throw new ValidateException("订单已支付，不能修改金额");
      assertReadonlyOrderValues(order, input);

      const priorBaseCents = decimalToCents(order.payPrice) + signedDecimalToCents(order.changePrice);
      if (!Number.isSafeInteger(priorBaseCents) || priorBaseCents < 0) {
        throw new ValidateException("历史改价数据异常，请先人工核对");
      }
      const changePrice = signedCentsToDecimal(priorBaseCents - input.payPriceCents);
      const payPrice = centsToDecimal(input.payPriceCents);
      const gainIntegral = `${input.gainIntegral}.00`;
      const changed = order.payPrice !== payPrice || order.changePrice !== changePrice || order.gainIntegral !== gainIntegral;
      if (!changed) return { id, order_id: order.orderId, pay_price: payPrice, gain_integral: gainIntegral, changed: false };

      await tx.update(storeOrder).set({ payPrice, changePrice, gainIntegral }).where(eq(storeOrder.id, id));
      await tx.insert(storeOrderStatus).values({
        oid: id,
        changeType: "order_edit",
        changeMessage: `商品总价为：${order.payPrice} 修改实际支付金额为：${payPrice}`,
        changeTime: Math.floor(Date.now() / 1000),
      });
      return { id, order_id: order.orderId, pay_price: payPrice, gain_integral: gainIntegral, changed: true };
    });
  }

  async updateRemark(kefuUidValue: unknown, body: Record<string, unknown>) {
    const kefuUid = positiveInteger(kefuUidValue, "客服身份");
    const publicOrderId = normalizedText(body.order_id, "订单编号", MAX_ORDER_ID_LENGTH);
    const remark = normalizedText(body.remark, "备注内容", MAX_ORDER_REMARK_LENGTH);
    return withTx(this.container, async (tx) => {
      await tx.execute(sql.raw("SET LOCAL lock_timeout = '2s'"));
      await tx.execute(sql.raw("SET LOCAL statement_timeout = '5s'"));
      const order = (await tx.select({ id: storeOrder.id, uid: storeOrder.uid }).from(storeOrder).where(and(
        eq(storeOrder.orderId, publicOrderId),
        eq(storeOrder.isDel, 0),
        eq(storeOrder.isSystemDel, 0),
      )).limit(1))[0];
      if (order) {
        const locked = await lockOwnedOrder(tx, kefuUid, order.id, order.uid);
        const changed = locked.remark !== remark;
        if (changed) {
          await tx.update(storeOrder).set({ remark }).where(eq(storeOrder.id, locked.id));
          await tx.insert(storeOrderStatus).values({
            oid: locked.id,
            changeType: "kefu_order_remark",
            changeMessage: `客服 ${kefuUid} 更新订单备注`,
            changeTime: Math.floor(Date.now() / 1000),
          });
        }
        return { kind: "order" as const, id: locked.id, order_id: locked.orderId, remark, changed };
      }

      const refund = (await tx.select({ id: storeOrderRefund.id, uid: storeOrderRefund.uid }).from(storeOrderRefund).where(and(
        eq(storeOrderRefund.orderId, publicOrderId),
        eq(storeOrderRefund.isCancel, 0),
        eq(storeOrderRefund.isDel, 0),
      )).limit(1))[0];
      if (!refund) throw new NotFoundException("订单不存在或不属于当前会话");
      if (remark.length > MAX_REFUND_REMARK_LENGTH) throw new ValidateException(`售后备注不能超过${MAX_REFUND_REMARK_LENGTH}个字符`);
      const locked = await lockOwnedRefund(tx, kefuUid, refund.id, refund.uid);
      const changed = locked.remark !== remark;
      if (changed) {
        await tx.update(storeOrderRefund).set({ remark }).where(eq(storeOrderRefund.id, locked.id));
        await tx.insert(storeOrderStatus).values({
          oid: locked.storeOrderId,
          changeType: "kefu_refund_remark",
          changeMessage: `客服 ${kefuUid} 更新售后备注`,
          changeTime: Math.floor(Date.now() / 1000),
        });
      }
      return { kind: "refund" as const, id: locked.id, order_id: locked.orderId, remark, changed };
    });
  }

  async updateRefundRemark(
    kefuUidValue: unknown,
    idValue: unknown,
    body: Record<string, unknown>,
  ) {
    const kefuUid = positiveInteger(kefuUidValue, "客服身份");
    const id = positiveInteger(idValue, "退款ID");
    const remark = normalizedText(body.remark, "售后备注", MAX_REFUND_REMARK_LENGTH);
    return withTx(this.container, async (tx) => {
      await tx.execute(sql.raw("SET LOCAL lock_timeout = '2s'"));
      await tx.execute(sql.raw("SET LOCAL statement_timeout = '5s'"));
      const preliminary = (await tx.select({ uid: storeOrderRefund.uid }).from(storeOrderRefund).where(and(
        eq(storeOrderRefund.id, id),
        eq(storeOrderRefund.isCancel, 0),
        eq(storeOrderRefund.isDel, 0),
      )).limit(1))[0];
      if (!preliminary) throw new NotFoundException("售后订单不存在或不属于当前会话");
      const refund = await lockOwnedRefund(tx, kefuUid, id, preliminary.uid);
      const changed = refund.remark !== remark;
      if (changed) {
        await tx.update(storeOrderRefund).set({ remark }).where(eq(storeOrderRefund.id, id));
        await tx.insert(storeOrderStatus).values({
          oid: refund.storeOrderId,
          changeType: "kefu_refund_remark",
          changeMessage: `客服 ${kefuUid} 更新售后备注`,
          changeTime: Math.floor(Date.now() / 1000),
        });
      }
      return { kind: "refund" as const, id, order_id: refund.orderId, remark, changed };
    });
  }

  async orderRefundForm(kefuUidValue: unknown, idValue: unknown): Promise<KefuManagementForm> {
    const kefuUid = positiveInteger(kefuUidValue, "客服身份");
    const order = await this.visibleOrder(kefuUid, idValue);
    if (order.paid !== 1) throw new ValidateException("未支付无法退款");
    if (order.pid < 0) throw new ValidateException("主订单已拆分发货，暂不支持整单主动退款");
    const payPriceCents = decimalToCents(order.payPrice);
    const refundedCents = decimalToCents(order.refundPrice);
    if (refundedCents > payPriceCents) throw new ValidateException("订单退款金额异常，请先人工核对");
    if (payPriceCents > 0 && [0, 1].includes(order.refundStatus) && refundedCents >= payPriceCents) {
      throw new ValidateException("订单已退款");
    }
    const blocking = await this.container.db.select({ id: storeOrderRefund.id }).from(storeOrderRefund).where(and(
      eq(storeOrderRefund.storeOrderId, order.id),
      inArray(storeOrderRefund.refundType, [...REFUND_FORM_BLOCKING_TYPES]),
      eq(storeOrderRefund.isCancel, 0),
      eq(storeOrderRefund.isDel, 0),
    )).limit(1);
    if (blocking[0]) throw new ValidateException("请到售后订单列表处理");
    return refundForm("退款处理", `/order/refund/${order.id}`, order.orderId, payPriceCents - refundedCents);
  }

  async refundForm(kefuUidValue: unknown, idValue: unknown): Promise<KefuManagementForm> {
    const kefuUid = positiveInteger(kefuUidValue, "客服身份");
    const refund = await this.visibleRefund(kefuUid, idValue);
    const order = (await this.container.db.select().from(storeOrder).where(and(
      eq(storeOrder.id, refund.storeOrderId),
      eq(storeOrder.uid, refund.uid),
      eq(storeOrder.isDel, 0),
      eq(storeOrder.isSystemDel, 0),
    )).limit(1))[0];
    if (!order) throw new NotFoundException("售后订单关联的原订单不存在");
    if (order.paid !== 1) throw new ValidateException("未支付无法退款");
    const allowedCents = decimalToCents(refund.refundPrice);
    const refundedCents = decimalToCents(refund.refundedPrice);
    if (refundedCents > allowedCents) throw new ValidateException("售后退款金额异常，请先人工核对");
    if (allowedCents > 0 && [1, 5].includes(refund.refundType) && refundedCents >= allowedCents) {
      throw new ValidateException("订单已退款");
    }
    return refundForm("退款处理", `/refund/refund/${refund.id}`, refund.orderId, allowedCents - refundedCents);
  }

  async agreeReturn(kefuUidValue: unknown, idValue: unknown) {
    const kefuUid = positiveInteger(kefuUidValue, "客服身份");
    const id = positiveInteger(idValue, "退款ID");
    return withTx(this.container, async (tx) => {
      await tx.execute(sql.raw("SET LOCAL lock_timeout = '2s'"));
      await tx.execute(sql.raw("SET LOCAL statement_timeout = '5s'"));
      const preliminary = (await tx.select({
        uid: storeOrderRefund.uid,
        storeOrderId: storeOrderRefund.storeOrderId,
      }).from(storeOrderRefund).where(and(
        eq(storeOrderRefund.id, id),
        eq(storeOrderRefund.isCancel, 0),
        eq(storeOrderRefund.isDel, 0),
      )).limit(1))[0];
      if (!preliminary) throw new NotFoundException("售后订单不存在或不属于当前会话");

      await lockKefuConversationOwnership(tx, kefuUid, preliminary.uid);
      await lockRefundExecution(tx, id);
      await lockOrderSettlement(tx, preliminary.storeOrderId);
      const refund = await selectOwnedRefundForUpdate(tx, kefuUid, id, preliminary.uid);
      const order = (await tx.select().from(storeOrder).where(and(
        eq(storeOrder.id, refund.storeOrderId),
        eq(storeOrder.uid, refund.uid),
        eq(storeOrder.isDel, 0),
        eq(storeOrder.isSystemDel, 0),
      )).limit(1).for("update"))[0];
      if (!order) throw new NotFoundException("售后订单关联的原订单不存在");
      if (![2, 3].includes(refund.applyType)) throw new ValidateException("该售后类型不需要退货");
      if (refund.refundType === 4) {
        if (order.refundStatus !== 1 || order.refundType !== 4) {
          throw new ValidateException("售后与原订单退货状态不一致，请先人工核对");
        }
        return { id, order_id: refund.orderId, changed: false };
      }
      if (![0, 1, 2].includes(refund.refundType)) throw new ValidateException("售后状态不允许同意退货");

      const updated = await tx.update(storeOrderRefund).set({ refundType: 4 }).where(and(
        eq(storeOrderRefund.id, id),
        eq(storeOrderRefund.uid, refund.uid),
        eq(storeOrderRefund.refundType, refund.refundType),
        eq(storeOrderRefund.isCancel, 0),
        eq(storeOrderRefund.isDel, 0),
      )).returning({ id: storeOrderRefund.id });
      if (!updated[0]) throw new ValidateException("售后记录已被处理");
      const orderUpdated = await tx.update(storeOrder).set({ refundStatus: 1, refundType: 4 }).where(and(
        eq(storeOrder.id, order.id),
        eq(storeOrder.uid, refund.uid),
      )).returning({ id: storeOrder.id });
      if (!orderUpdated[0]) throw new ValidateException("原订单退货状态更新失败");
      await tx.insert(storeOrderStatus).values({
        oid: order.id,
        changeType: "kefu_refund_return",
        changeMessage: `客服 ${kefuUid} 同意退货，等待用户寄回`,
        changeTime: Math.floor(Date.now() / 1000),
      });
      return { id, order_id: refund.orderId, changed: true };
    });
  }

  async refundOrder(
    kefuUidValue: unknown,
    idValue: unknown,
    body: Record<string, unknown>,
  ) {
    if (!this.env) throw new Error("客服退款服务缺少运行环境");
    const kefuUid = positiveInteger(kefuUidValue, "客服身份");
    const id = positiveInteger(idValue, "退款ID");
    const input = parseKefuRefundDecisionInput(body);
    // Hyperdrive may serve transaction-external reads from cache. The
    // authorization snapshot must be a fresh transaction before its exact
    // values are bound into the locked refund state machine.
    const refund = await withTx(this.container, (tx) => this.visibleRefund(kefuUid, id, tx));
    const authorizedCents = decimalToCents(refund.refundPrice);
    const refundedCents = decimalToCents(refund.refundedPrice);
    const completedReplay = refund.refundType === 6 && refundedCents === authorizedCents;
    if (!completedReplay && refundedCents !== 0) {
      throw new ValidateException("该售后存在历史部分退款，请先人工核对后处理");
    }
    if (input.refundPriceCents !== authorizedCents) {
      throw new ValidateException("退款金额与售后单权威金额不一致");
    }

    return new StoreOrderRefundService(this.container, this.env).agreeRefund(id, {
      expectedStoreId: refund.storeId,
      expectedSupplierId: refund.supplierId,
      expectedUid: refund.uid,
      expectedRefundOrderId: refund.orderId,
      expectedStoreOrderId: refund.storeOrderId,
      expectedRefundAmountCents: authorizedCents,
      expectedRefundedAmountCents: completedReplay ? authorizedCents : 0,
      requireSystemVisible: true,
      requirePaid: true,
      authorizeBeforeRefundLock: async (tx, current) => {
        await lockKefuConversationOwnership(tx, kefuUid, current.uid);
      },
    });
  }
}
