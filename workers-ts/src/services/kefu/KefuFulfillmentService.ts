import { and, asc, desc, eq, sql } from "drizzle-orm";
import { createContainerFromDb, withTx, type Container, type DbClient } from "@/lib/di";
import {
  deliveryService,
  expressCompany,
  storeOrder,
  storeOrderCartInfo,
  user,
} from "@/models/schema";
import {
  lockKefuConversationOwnership,
  ownedKefuConversation,
} from "@/services/kefu/KefuOwnership";
import {
  StoreOrderWriteoffService,
  type WriteoffActor,
  type WriteoffLineInput,
} from "@/services/order/StoreOrderWriteoffService";
import { StoreOperationsService } from "@/services/store/StoreOperationsService";
import { SystemConfigService } from "@/services/system/SystemConfigService";
import type { SystemConfigEnv } from "@/services/system/SystemConfigService";
import {
  normalizeSupplierSplitCartInput,
  SupplierFulfillmentService,
  type FulfillmentAuthorizationScope,
  type SupplierDeliveryInput,
} from "@/services/supplier/SupplierFulfillmentService";
import { NotFoundException, ValidateException } from "@/utils/errors";

const MAX_ORDER_ID_LENGTH = 50;

function positiveInteger(value: unknown, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > 2_147_483_647) {
    throw new ValidateException(`${label}错误`);
  }
  return parsed;
}

function boundedString(
  value: unknown,
  label: string,
  maxLength: number,
  required = false,
): string {
  if (value === undefined || value === null) {
    if (required) throw new ValidateException(`${label}不能为空`);
    return "";
  }
  if (typeof value !== "string") throw new ValidateException(`${label}格式错误`);
  const normalized = value.trim();
  if (required && !normalized) throw new ValidateException(`${label}不能为空`);
  if (normalized.length > maxLength) throw new ValidateException(`${label}不能超过${maxLength}个字符`);
  return normalized;
}

export interface KefuDeliveryInput extends SupplierDeliveryInput {
  expressRecordType: 1;
}

export function normalizeKefuDeliveryInput(body: Record<string, unknown>): KefuDeliveryInput {
  const type = Number(body.type ?? 1);
  if (!Number.isInteger(type) || ![1, 2, 3].includes(type)) {
    throw new ValidateException("发货类型错误");
  }
  if (type === 1) {
    const expressRecordType = Number(body.express_record_type ?? 1);
    if (expressRecordType !== 1) {
      throw new ValidateException("电子面单发货必须通过可重试面单任务提交");
    }
    return {
      deliveryType: "express",
      deliveryName: boundedString(body.delivery_name, "快递公司", 64, true),
      deliveryCode: boundedString(body.delivery_code, "快递公司编码", 50),
      deliveryId: boundedString(body.delivery_id, "快递单号", 64, true),
      fictitiousContent: "",
      deliveryUid: 0,
      expressRecordType: 1,
    };
  }
  if (type === 2) {
    const deliveryMode = Number(body.delivery_type ?? 1);
    if (deliveryMode !== 1) throw new ValidateException("第三方同城配送尚未接入客服履约链路");
    return {
      deliveryType: "send",
      deliveryName: "",
      deliveryCode: "",
      deliveryId: "",
      fictitiousContent: "",
      deliveryUid: positiveInteger(body.sh_delivery_uid ?? body.delivery_uid, "配送员ID"),
      expressRecordType: 1,
    };
  }
  return {
    deliveryType: "fictitious",
    deliveryName: "",
    deliveryCode: "",
    deliveryId: "",
    fictitiousContent: boundedString(body.fictitious_content, "虚拟发货内容", 500, true),
    deliveryUid: 0,
    expressRecordType: 1,
  };
}

function parseSnapshot(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function nestedRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function cartProjection(row: typeof storeOrderCartInfo.$inferSelect) {
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

function assertPreviewDeliverable(order: typeof storeOrder.$inferSelect): void {
  if (order.paid !== 1) throw new ValidateException("订单未支付");
  if (order.isDel || order.isSystemDel) throw new ValidateException("订单已删除，不能发货");
  if (order.shippingType === 2) throw new ValidateException("核销订单不能发货");
  if (order.status !== 0) throw new ValidateException("订单状态不允许发货");
  if (![0, 3].includes(order.refundStatus)) throw new ValidateException("订单售后状态不允许发货");
}

function parseWriteoffItems(body: Record<string, unknown>): WriteoffLineInput[] | undefined {
  const source = body.cart_ids ?? body.items ?? body.cartIds;
  if (source === undefined || source === null || source === "") return undefined;
  if (!Array.isArray(source)) throw new ValidateException("核销商品格式错误");
  return source.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new ValidateException("核销商品格式错误");
    }
    const row = value as Record<string, unknown>;
    const cartId = boundedString(row.cart_id ?? row.cartId, "核销商品标识", 50, true);
    return {
      cartId,
      quantity: Number(row.cart_num ?? row.cartNum ?? row.quantity),
    };
  });
}

export class KefuFulfillmentService {
  constructor(
    private readonly container: Container,
    private readonly env: SystemConfigEnv,
  ) {}

  private actor(
    kefuIdValue: unknown,
    kefuUidValue: unknown,
  ): Extract<WriteoffActor, { kind: "kefu" }> {
    return {
      kind: "kefu",
      kefuId: positiveInteger(kefuIdValue, "客服账号身份"),
      kefuUid: positiveInteger(kefuUidValue, "客服身份"),
    };
  }

  private async visibleOrderByIdUsing(db: DbClient, kefuUid: number, idValue: unknown) {
    const id = positiveInteger(idValue, "订单ID");
    const rows = await db
      .select()
      .from(storeOrder)
      .where(and(
        eq(storeOrder.id, id),
        eq(storeOrder.isDel, 0),
        eq(storeOrder.isSystemDel, 0),
        ownedKefuConversation(db, kefuUid, storeOrder.uid),
      ))
      .limit(1);
    if (!rows[0]) throw new NotFoundException("订单不存在或不属于当前会话");
    return rows[0];
  }

  private visibleOrderById(kefuUid: number, idValue: unknown) {
    return withTx(this.container, (tx) => this.visibleOrderByIdUsing(tx, kefuUid, idValue));
  }

  private async visibleOrderByPublicIdUsing(db: DbClient, kefuUid: number, orderIdValue: unknown) {
    const orderId = boundedString(orderIdValue, "订单编号", MAX_ORDER_ID_LENGTH, true);
    const rows = await db
      .select()
      .from(storeOrder)
      .where(and(
        eq(storeOrder.orderId, orderId),
        eq(storeOrder.isDel, 0),
        eq(storeOrder.isSystemDel, 0),
        ownedKefuConversation(db, kefuUid, storeOrder.uid),
      ))
      .limit(2);
    if (rows.length !== 1) throw new NotFoundException("订单不存在、编号不唯一或不属于当前会话");
    return rows[0];
  }

  private visibleOrderByPublicId(kefuUid: number, orderIdValue: unknown) {
    return withTx(this.container, (tx) => this.visibleOrderByPublicIdUsing(tx, kefuUid, orderIdValue));
  }

  private fulfillmentAuthorization(kefuUid: number, input: KefuDeliveryInput) {
    return async (tx: DbClient, scope: FulfillmentAuthorizationScope): Promise<void> => {
      await lockKefuConversationOwnership(tx, kefuUid, scope.customerUid);
      if (input.deliveryType !== "send") return;
      const rows = await tx
        .select({
          uid: deliveryService.uid,
          nickname: deliveryService.nickname,
          phone: deliveryService.phone,
        })
        .from(deliveryService)
        .innerJoin(user, eq(user.uid, deliveryService.uid))
        .where(and(
          eq(deliveryService.uid, input.deliveryUid),
          eq(deliveryService.type, 0),
          eq(deliveryService.relationId, 0),
          eq(deliveryService.status, 1),
          eq(deliveryService.isDel, 0),
          eq(user.status, 1),
          eq(user.isDel, 0),
        ))
        .orderBy(asc(deliveryService.id))
        .limit(2)
        .for("key share");
      if (rows.length !== 1) throw new ValidateException("配送员不存在、已停用或身份重复");
      input.deliveryName = rows[0].nickname;
      input.deliveryId = rows[0].phone;
    };
  }

  async expressList(query: Record<string, string>) {
    const statusRaw = query.status?.trim() ?? "";
    if (statusRaw && statusRaw !== "0" && statusRaw !== "1") {
      throw new ValidateException("快递公司状态错误");
    }
    return withTx(this.container, (tx) => tx
        .select({ id: expressCompany.id, value: expressCompany.name, code: expressCompany.code })
        .from(expressCompany)
        .where(and(
          eq(expressCompany.isShow, 1),
          statusRaw ? eq(expressCompany.status, Number(statusRaw)) : undefined,
        ))
        .orderBy(desc(expressCompany.sort), asc(expressCompany.id)));
  }

  async deliveryAgents(query: Record<string, string>) {
    return withTx(this.container, async (tx) => {
      const result = await new StoreOperationsService(createContainerFromDb(tx)).deliveryList(query, true);
      return result.list;
    });
  }

  async deliveryConfig() {
    const values = await new SystemConfigService(this.container, this.env).getMany([
      "config_export_temp_id",
      "config_export_to_name",
      "config_export_id",
      "config_export_to_tel",
      "config_export_to_address",
    ]);
    return {
      express_temp_id: values.config_export_temp_id ?? "",
      to_name: values.config_export_to_name ?? "",
      id: values.config_export_id ?? "",
      to_tel: values.config_export_to_tel ?? "",
      to_add: values.config_export_to_address ?? "",
    };
  }

  async deliver(
    kefuUidValue: unknown,
    orderIdValue: unknown,
    body: Record<string, unknown>,
  ) {
    const kefuUid = positiveInteger(kefuUidValue, "客服身份");
    const order = await this.visibleOrderById(kefuUid, orderIdValue);
    const input = normalizeKefuDeliveryInput(body);
    return new SupplierFulfillmentService(this.container, this.env).deliver(
      order.supplierId,
      order.id,
      input,
      {
        authorize: this.fulfillmentAuthorization(kefuUid, input),
        audit: {
          changeType: "kefu_order_delivery",
          changeMessage: `客服 ${kefuUid} 提交订单发货`,
        },
      },
    );
  }

  async splitCartInfo(kefuUidValue: unknown, orderIdValue: unknown) {
    const kefuUid = positiveInteger(kefuUidValue, "客服身份");
    return withTx(this.container, async (tx) => {
      const reference = await this.visibleOrderByIdUsing(tx, kefuUid, orderIdValue);
      const rootId = reference.pid > 0 ? reference.pid : reference.id;
      let active = reference;
      if (reference.pid === -1) {
        const pending = await tx
        .select()
        .from(storeOrder)
        .where(and(
          eq(storeOrder.pid, rootId),
          eq(storeOrder.supplierId, reference.supplierId),
          eq(storeOrder.uid, reference.uid),
          eq(storeOrder.status, 0),
          eq(storeOrder.isDel, 0),
          eq(storeOrder.isSystemDel, 0),
          ownedKefuConversation(tx, kefuUid, storeOrder.uid),
        ))
        .orderBy(asc(storeOrder.id))
        .limit(2);
        if (pending.length !== 1) {
          if (!pending.length) return [];
          throw new ValidateException("订单存在多个待发货子单，请先完成数据核对");
        }
        active = pending[0];
      }
      assertPreviewDeliverable(active);
      const rows = await tx
        .select({ cart: storeOrderCartInfo })
        .from(storeOrderCartInfo)
        .innerJoin(storeOrder, eq(storeOrder.id, storeOrderCartInfo.oid))
        .where(and(
          eq(storeOrderCartInfo.oid, active.id),
          sql`${storeOrderCartInfo.splitStatus} IN (0, 1)`,
          sql`${storeOrderCartInfo.splitSurplusNum} > 0`,
          eq(storeOrder.uid, reference.uid),
          ownedKefuConversation(tx, kefuUid, storeOrder.uid),
        ))
        .orderBy(asc(storeOrderCartInfo.id));
      return rows.map((row) => cartProjection(row.cart));
    });
  }

  async splitDelivery(
    kefuUidValue: unknown,
    orderIdValue: unknown,
    body: Record<string, unknown>,
  ) {
    const kefuUid = positiveInteger(kefuUidValue, "客服身份");
    const order = await this.visibleOrderById(kefuUid, orderIdValue);
    const input = normalizeKefuDeliveryInput(body);
    const selected = normalizeSupplierSplitCartInput(body);
    return new SupplierFulfillmentService(this.container, this.env).splitDelivery(
      order.supplierId,
      order.id,
      input,
      selected,
      {
        authorize: this.fulfillmentAuthorization(kefuUid, input),
        audit: {
          changeType: "kefu_order_split_delivery",
          changeMessage: `客服 ${kefuUid} 提交拆单发货`,
        },
      },
    );
  }

  async writeoffCartInfo(
    kefuIdValue: unknown,
    kefuUidValue: unknown,
    orderIdValue: unknown,
  ) {
    const actor = this.actor(kefuIdValue, kefuUidValue);
    const order = await this.visibleOrderById(actor.kefuUid, orderIdValue);
    if (!order.verifyCode) throw new ValidateException("订单缺少核销码");
    return new StoreOrderWriteoffService(this.container, this.env).info(actor, order.verifyCode);
  }

  async writeoffById(
    kefuIdValue: unknown,
    kefuUidValue: unknown,
    orderIdValue: unknown,
  ) {
    const actor = this.actor(kefuIdValue, kefuUidValue);
    const order = await this.visibleOrderById(actor.kefuUid, orderIdValue);
    if (!order.verifyCode) throw new ValidateException("订单缺少核销码");
    return new StoreOrderWriteoffService(this.container, this.env).execute(actor, {
      code: order.verifyCode,
    });
  }

  async writeoffByPublicId(
    kefuIdValue: unknown,
    kefuUidValue: unknown,
    orderIdValue: unknown,
    body: Record<string, unknown>,
  ) {
    const actor = this.actor(kefuIdValue, kefuUidValue);
    const order = await this.visibleOrderByPublicId(actor.kefuUid, orderIdValue);
    if (!order.verifyCode) throw new ValidateException("订单缺少核销码");
    return new StoreOrderWriteoffService(this.container, this.env).execute(actor, {
      code: order.verifyCode,
      items: parseWriteoffItems(body),
    });
  }
}
