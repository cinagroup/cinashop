import type { Context } from "hono";
import type { AppVariables, Env } from "@/env";
import { StoreOrderWriteoffService, type WriteoffLineInput } from "@/services/order/StoreOrderWriteoffService";
import { StoreOperationsService } from "@/services/store/StoreOperationsService";
import { ValidateException } from "@/utils/errors";
import { jsonOk } from "@/utils/json";

type C = Context<{ Bindings: Env; Variables: AppVariables }>;

async function requestBody(c: C): Promise<Record<string, unknown>> {
  const body: unknown = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ValidateException("请求数据格式错误");
  }
  return body as Record<string, unknown>;
}

function codeFrom(body: Record<string, unknown>): unknown {
  return body.code ?? body.verify_code ?? body.verifyCode;
}

function parseItems(body: Record<string, unknown>): WriteoffLineInput[] | undefined {
  const source = body.items ?? body.cart_ids ?? body.cartIds;
  if (source === undefined || source === null || source === "") return undefined;
  if (!Array.isArray(source)) throw new ValidateException("核销商品格式错误");
  return source.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new ValidateException("核销商品格式错误");
    }
    const row = value as Record<string, unknown>;
    const orderCartRaw = row.order_cart_id ?? row.orderCartId ?? row.id;
    const legacyCartRaw = row.cart_id ?? row.cartId;
    const quantityRaw = row.quantity ?? row.cart_num ?? row.cartNum;
    const quantity = Number(quantityRaw);
    const item: WriteoffLineInput = { quantity };
    if (orderCartRaw !== undefined && orderCartRaw !== null && orderCartRaw !== "") {
      item.orderCartId = Number(orderCartRaw);
    } else if (legacyCartRaw !== undefined && legacyCartRaw !== null && legacyCartRaw !== "") {
      item.cartId = String(legacyCartRaw);
    }
    return item;
  });
}

function service(c: C) {
  return new StoreOrderWriteoffService(c.get("container"), c.env);
}

export async function publicPickupStores(c: C) {
  const rows = await new StoreOperationsService(c.get("container")).publicPickupStores();
  return jsonOk(c, rows);
}

export async function operatorProfile(c: C) {
  return jsonOk(c, await service(c).operatorProfile(Number(c.get("uid") ?? 0)));
}

export async function staffInfo(c: C) {
  const body = await requestBody(c);
  return jsonOk(c, await service(c).info({ kind: "staff", uid: Number(c.get("uid") ?? 0) }, codeFrom(body)));
}

export async function staffExecute(c: C) {
  const body = await requestBody(c);
  const result = await service(c).execute(
    { kind: "staff", uid: Number(c.get("uid") ?? 0) },
    { code: String(codeFrom(body) ?? ""), items: parseItems(body) },
  );
  return jsonOk(c, result, result.completed ? "核销完成" : "部分核销成功");
}

export async function deliveryInfo(c: C) {
  const body = await requestBody(c);
  return jsonOk(c, await service(c).info({ kind: "delivery", uid: Number(c.get("uid") ?? 0) }, codeFrom(body)));
}

export async function deliveryExecute(c: C) {
  const body = await requestBody(c);
  const result = await service(c).execute(
    { kind: "delivery", uid: Number(c.get("uid") ?? 0) },
    { code: String(codeFrom(body) ?? ""), items: parseItems(body) },
  );
  return jsonOk(c, result, result.completed ? "送达核销完成" : "部分送达核销成功");
}

export async function adminInfo(c: C) {
  const body = await requestBody(c);
  return jsonOk(c, await service(c).info({ kind: "admin", adminId: Number(c.get("adminId") ?? 0) }, codeFrom(body)));
}

export async function adminExecute(c: C) {
  const body = await requestBody(c);
  const result = await service(c).execute(
    { kind: "admin", adminId: Number(c.get("adminId") ?? 0) },
    { code: String(codeFrom(body) ?? ""), items: parseItems(body) },
  );
  return jsonOk(c, result, result.completed ? "核销完成" : "部分核销成功");
}
