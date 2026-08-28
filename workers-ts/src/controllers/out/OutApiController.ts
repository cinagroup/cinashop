import type { Context } from "hono";
import type { AppVariables, Env } from "@/env";
import { enforceOutAnonymousRateLimit, outClientIp } from "@/middleware/out-auth";
import { OutApiService } from "@/services/out/OutApiService";
import { ValidateException } from "@/utils/errors";
import { jsonOk } from "@/utils/json";

type C = Context<{ Bindings: Env; Variables: AppVariables }>;
const MAX_TOKEN_BODY_BYTES = 4 * 1024;

async function readJsonObject(c: C, maxBytes = MAX_TOKEN_BODY_BYTES): Promise<Record<string, unknown>> {
  const declared = Number(c.req.header("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new ValidateException("请求体过大");
  }
  const stream = c.req.raw.body;
  if (!stream) return {};
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    total += next.value.byteLength;
    if (total > maxBytes) {
      await reader.cancel("request body too large");
      throw new ValidateException("请求体过大");
    }
    chunks.push(next.value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const parsed = JSON.parse(new TextDecoder().decode(merged)) as unknown;
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
      throw new Error("not object");
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new ValidateException("JSON请求体无效");
  }
}

function service(c: C) {
  return new OutApiService(c.get("container"), c.env);
}

function privateResponse(c: C) {
  c.header("Cache-Control", "private, no-store");
  c.header("Pragma", "no-cache");
  c.header("X-Content-Type-Options", "nosniff");
}

export async function getToken(c: C) {
  await enforceOutAnonymousRateLimit(c, "login");
  const body = await readJsonObject(c);
  return jsonOk(
    c,
    await service(c).login(String(body.appid ?? ""), String(body.appsecret ?? ""), outClientIp(c)),
    "获取成功",
  );
}

export async function refreshToken(c: C) {
  await enforceOutAnonymousRateLimit(c, "refresh");
  const body = await readJsonObject(c);
  return jsonOk(
    c,
    await service(c).refresh(String(body.access_token ?? body.token ?? ""), outClientIp(c)),
    "操作成功",
  );
}

export async function categoryList(c: C) {
  return jsonOk(c, await service(c).categoryList(c.req.query()));
}

export async function categoryInfo(c: C) {
  return jsonOk(c, await service(c).categoryInfo(c.req.param("id")));
}

export async function categoryCreate(c: C) {
  privateResponse(c);
  const body = await readJsonObject(c, 8 * 1024);
  return jsonOk(
    c,
    await service(c).createCategory(c.get("outInfo")!, body),
    "添加成功",
  );
}

export async function categoryUpdate(c: C) {
  privateResponse(c);
  const body = await readJsonObject(c, 8 * 1024);
  return jsonOk(
    c,
    await service(c).updateCategory(c.get("outInfo")!, c.req.param("id"), body),
    "修改成功",
  );
}

export async function categoryDelete(c: C) {
  privateResponse(c);
  return jsonOk(
    c,
    await service(c).deleteCategory(c.get("outInfo")!, c.req.param("id")),
    "删除成功",
  );
}

export async function categorySetShow(c: C) {
  privateResponse(c);
  return jsonOk(
    c,
    await service(c).setCategoryShow(
      c.get("outInfo")!,
      c.req.param("id"),
      c.req.param("is_show"),
    ),
    "设置成功",
  );
}

export async function productList(c: C) {
  return jsonOk(c, await service(c).productList(c.req.query()));
}

export async function productInfo(c: C) {
  return jsonOk(c, await service(c).productInfo(c.req.param("id")));
}

export async function orderList(c: C) {
  privateResponse(c);
  return jsonOk(c, await service(c).orderList(c.req.query()));
}

export async function orderInfo(c: C) {
  privateResponse(c);
  return jsonOk(c, await service(c).orderInfo(c.req.param("order_id")));
}

export async function orderRemark(c: C) {
  privateResponse(c);
  const body = await readJsonObject(c, 2 * 1024);
  return jsonOk(
    c,
    await service(c).updateOrderRemark(c.get("outInfo")!, c.req.param("order_id"), body.remark),
    "操作成功",
  );
}

export async function orderDelivery(c: C) {
  privateResponse(c);
  const body = await readJsonObject(c, 16 * 1024);
  return jsonOk(
    c,
    await service(c).deliverOrder(c.get("outInfo")!, c.req.param("order_id"), body),
    "发货成功",
  );
}

export async function orderDistribution(c: C) {
  privateResponse(c);
  const body = await readJsonObject(c, 16 * 1024);
  return jsonOk(
    c,
    await service(c).updateOrderDistribution(c.get("outInfo")!, c.req.param("order_id"), body),
    "修改成功",
  );
}

export async function orderInvoice(c: C) {
  privateResponse(c);
  const body = await readJsonObject(c, 8 * 1024);
  return jsonOk(
    c,
    await service(c).updateOrderInvoice(c.get("outInfo")!, c.req.param("order_id"), body),
    "修改成功",
  );
}

export async function orderInvoiceStatus(c: C) {
  privateResponse(c);
  const body = await readJsonObject(c, 4 * 1024);
  return jsonOk(
    c,
    await service(c).updateOrderInvoiceStatus(c.get("outInfo")!, c.req.param("order_id"), body),
    "修改成功",
  );
}

export async function orderSplitDelivery(c: C) {
  privateResponse(c);
  const body = await readJsonObject(c, 64 * 1024);
  return jsonOk(
    c,
    await service(c).splitDeliverOrder(c.get("outInfo")!, c.req.param("order_id"), body),
    "发货成功",
  );
}

export async function orderReceive(c: C) {
  privateResponse(c);
  return jsonOk(
    c,
    await service(c).receiveOrder(c.get("outInfo")!, c.req.param("order_id")),
    "操作成功",
  );
}

export async function expressList(c: C) {
  return jsonOk(c, await service(c).expressList());
}

export async function splitCartInfo(c: C) {
  privateResponse(c);
  return jsonOk(c, await service(c).splitCartInfo(c.req.param("order_id")));
}

export async function refundList(c: C) {
  privateResponse(c);
  return jsonOk(c, await service(c).refundList(c.req.query()));
}

export async function refundInfo(c: C) {
  privateResponse(c);
  return jsonOk(c, await service(c).refundInfo(c.req.param("order_id")));
}

export async function refundRemark(c: C) {
  privateResponse(c);
  const body = await readJsonObject(c, 2 * 1024);
  return jsonOk(
    c,
    await service(c).updateRefundRemark(c.get("outInfo")!, c.req.param("order_id"), body.remark),
    "操作成功",
  );
}

export async function refundAgree(c: C) {
  privateResponse(c);
  return jsonOk(
    c,
    await service(c).agreeRefundReturn(c.get("outInfo")!, c.req.param("order_id")),
    "操作成功",
  );
}

export async function refundRefuse(c: C) {
  privateResponse(c);
  const body = await readJsonObject(c, 2 * 1024);
  return jsonOk(
    c,
    await service(c).refuseRefund(c.get("outInfo")!, c.req.param("order_id"), body),
    "修改成功",
  );
}

export async function refundPrice(c: C) {
  privateResponse(c);
  const body = await readJsonObject(c, 2 * 1024);
  const result = await service(c).refundPrice(
    c.get("outInfo")!,
    c.req.param("order_id"),
    body,
  );
  return jsonOk(
    c,
    result,
    result.refund_status === "PROCESSING"
      ? "退款处理中"
      : result.refund_status === "REFUSED"
        ? "修改退款状态成功"
        : "退款成功",
  );
}

export async function couponList(c: C) {
  return jsonOk(c, await service(c).couponList(c.req.query()));
}

export async function userLevelList(c: C) {
  return jsonOk(c, await service(c).userLevelList(c.req.query()));
}

export async function userList(c: C) {
  privateResponse(c);
  return jsonOk(c, await service(c).userList(c.req.query()));
}

export async function userInfo(c: C) {
  privateResponse(c);
  return jsonOk(c, await service(c).userInfo(c.req.param("uid")));
}
