import { and, asc, eq } from "drizzle-orm";
import type { Env } from "@/env";
import type { Container, DbClient } from "@/lib/di";
import { deliveryService, expressCompany, storeOrder, user } from "@/models/schema";
import { KefuFulfillmentService, normalizeKefuDeliveryInput } from "@/services/kefu/KefuFulfillmentService";
import { StoreOrderWriteoffService } from "@/services/order/StoreOrderWriteoffService";
import {
  normalizeSupplierSplitCartInput,
  SupplierFulfillmentService,
  type FulfillmentAuthorizationScope,
  type SupplierDeliveryInput,
} from "@/services/supplier/SupplierFulfillmentService";
import { OrderWaybillJobService } from "@/services/waybill/OrderWaybillJobService";
import { parseAdminOrderPrimaryId } from "@/services/admin/AdminMobileOrderReadService";
import { ApiException, NotFoundException, ValidateException } from "@/utils/errors";

const MAX_TEMPLATE_COUNT = 100;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function visibleString(value: unknown, label: string, maximum: number, required = false): string {
  if (value === undefined || value === null) {
    if (required) throw new ValidateException(`${label}不能为空`);
    return "";
  }
  if (typeof value !== "string" && typeof value !== "number") {
    throw new ValidateException(`${label}格式错误`);
  }
  const normalized = String(value).trim();
  if (required && !normalized) throw new ValidateException(`${label}不能为空`);
  if ([...normalized].length > maximum || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new ValidateException(`${label}格式错误`);
  }
  return normalized;
}

function enumNumber(value: unknown, fallback: number, allowed: readonly number[], label: string): number {
  const raw = value === undefined || value === null || value === "" ? fallback : value;
  const normalized = typeof raw === "number" || typeof raw === "string" ? String(raw).trim() : "";
  if (!/^\d+$/.test(normalized)) throw new ValidateException(`${label}错误`);
  const parsed = Number(normalized);
  if (!allowed.includes(parsed)) throw new ValidateException(`${label}错误`);
  return parsed;
}

export function isAdminElectronicWaybillInput(body: Record<string, unknown>): boolean {
  const deliveryType = enumNumber(body.type, 1, [1, 2, 3], "发货类型");
  if (deliveryType !== 1) return false;
  return enumNumber(body.express_record_type, 1, [1, 2], "发货记录类型") === 2;
}

export function projectAdminWaybillTemplateCatalog(value: unknown) {
  const envelope = record(value);
  const source = Array.isArray(value)
    ? value
    : Array.isArray(envelope?.data)
      ? envelope.data
      : null;
  if (!source || source.length > MAX_TEMPLATE_COUNT) {
    throw new ApiException("电子面单模板服务返回异常", 502);
  }
  const data = source.map((raw) => {
    const row = record(raw);
    if (!row) throw new ApiException("电子面单模板服务返回异常", 502);
    const providerText = (field: unknown, label: string, maximum: number, required = false) => {
      try {
        return visibleString(field, label, maximum, required);
      } catch {
        throw new ApiException("电子面单模板服务返回异常", 502);
      }
    };
    const pic = providerText(row.pic, "模板预览", 512);
    if (pic && !/^https:\/\//i.test(pic)) {
      throw new ApiException("电子面单模板服务返回异常", 502);
    }
    return {
      title: providerText(row.title, "模板名称", 128, true),
      temp_id: providerText(row.temp_id ?? row.tempId, "模板ID", 255, true),
      pic,
    };
  });
  return { data };
}

function validateAdminId(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new ValidateException("管理员身份不存在");
  return value;
}

function legacyRequestKey(value: unknown): string {
  if (value === undefined || value === null || value === "") return crypto.randomUUID();
  return visibleString(value, "请求键", 36, true);
}

/** Exact `/api/admin/order/*` fulfillment compatibility over the shared state machines. */
export class AdminMobileFulfillmentService {
  constructor(
    private readonly container: Container,
    private readonly env: Env,
  ) {}

  private async orderReference(idValue: unknown) {
    const id = parseAdminOrderPrimaryId(idValue);
    const rows = await this.container.db
      .select({ id: storeOrder.id, supplierId: storeOrder.supplierId })
      .from(storeOrder)
      .where(and(
        eq(storeOrder.id, id),
        eq(storeOrder.isDel, 0),
        eq(storeOrder.isSystemDel, 0),
      ))
      .limit(1);
    if (!rows[0]) throw new NotFoundException("订单不存在");
    return rows[0];
  }

  private fulfillmentAuthorization(input: SupplierDeliveryInput) {
    return async (tx: DbClient, _scope: FulfillmentAuthorizationScope): Promise<void> => {
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

  private async carrierId(body: Record<string, unknown>): Promise<unknown> {
    if (body.carrier_id !== undefined || body.carrierId !== undefined) {
      return body.carrier_id ?? body.carrierId;
    }
    const code = visibleString(body.delivery_code, "快递公司编码", 50);
    if (!code) return undefined;
    const rows = await this.container.db
      .select({ id: expressCompany.id })
      .from(expressCompany)
      .where(and(
        eq(expressCompany.code, code),
        eq(expressCompany.isShow, 1),
        eq(expressCompany.status, 1),
      ))
      .orderBy(asc(expressCompany.id))
      .limit(2);
    if (rows.length !== 1) throw new ValidateException("快递公司不存在、已停用或编码不唯一");
    return rows[0].id;
  }

  private async queueWaybill(
    adminId: number,
    idValue: unknown,
    body: Record<string, unknown>,
    split: boolean,
  ) {
    const id = parseAdminOrderPrimaryId(idValue);
    const cartIds = split ? normalizeSupplierSplitCartInput(body) : [];
    const result = await new OrderWaybillJobService(this.container, this.env).create(
      String(id),
      { actorType: "admin", actorId: adminId },
      {
        request_key: legacyRequestKey(body.request_key ?? body.requestKey),
        fulfillment_mode: split ? "split" : "whole",
        cart_ids: cartIds.map((item) => ({ cart_id: item.cartId, cart_num: item.cartNum })),
        carrier_id: await this.carrierId(body),
        template_id: body.express_temp_id ?? body.template_id ?? body.templateId,
        sender_name: body.to_name ?? body.sender_name ?? body.senderName,
        sender_phone: body.to_tel ?? body.sender_phone ?? body.senderPhone,
        sender_address: body.to_addr ?? body.sender_address ?? body.senderAddress,
      },
    );
    return {
      queued: true as const,
      duplicate: result.duplicate,
      job_id: result.job.id,
      status: result.job.status,
    };
  }

  async deliver(
    adminIdValue: number,
    idValue: unknown,
    body: Record<string, unknown>,
    split = false,
  ) {
    const adminId = validateAdminId(adminIdValue);
    if (isAdminElectronicWaybillInput(body)) {
      return this.queueWaybill(adminId, idValue, body, split);
    }
    const reference = await this.orderReference(idValue);
    const input = normalizeKefuDeliveryInput(body);
    const options = {
      authorize: this.fulfillmentAuthorization(input),
      audit: {
        changeType: split ? "admin_order_split_delivery" : "admin_order_delivery",
        changeMessage: `管理员 ${adminId} 提交${split ? "拆单" : "订单"}发货`,
      },
    };
    const fulfillment = new SupplierFulfillmentService(this.container, this.env);
    const result = split
      ? await fulfillment.splitDelivery(
          reference.supplierId,
          reference.id,
          input,
          normalizeSupplierSplitCartInput(body),
          options,
        )
      : await fulfillment.deliver(reference.supplierId, reference.id, input, options);
    return { queued: false as const, ...result };
  }

  async waybillTemplates(query: Record<string, string>) {
    const raw = await new KefuFulfillmentService(this.container, this.env).waybillTemplates(query);
    return projectAdminWaybillTemplateCatalog(raw);
  }

  async writeoffLookup(adminIdValue: number, body: Record<string, unknown>) {
    const adminId = validateAdminId(adminIdValue);
    const code = visibleString(body.code, "核销码或用户码", 32, true);
    const result = await new StoreOrderWriteoffService(this.container, this.env)
      .legacySummarySearch({ kind: "admin", adminId }, code);
    const data = result.data;
    return {
      data,
      is_order_code: result.directOrder || data.length === 1 ? 1 : 0,
      product_type: data.length === 1 ? data[0].product_type : 0,
      // The authenticated route is always an administrator lookup; caller auth is ignored.
      auth: 0,
    };
  }
}
