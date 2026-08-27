import type { Context } from "hono";
import type { AppVariables, Env } from "@/env";
import {
  OrderNotificationAdminService,
  type NotificationTemplateSaveInput,
  type OrderNotificationConfigSaveInput,
} from "@/services/order/OrderNotificationAdminService";
import { ValidateException } from "@/utils/errors";
import { jsonOk } from "@/utils/json";

type C = Context<{ Bindings: Env; Variables: AppVariables }>;
const MAX_BODY_BYTES = 32 * 1024;

function service(c: C) {
  return new OrderNotificationAdminService(c.get("container"), c.env);
}

function adminId(c: C): number {
  const value = Number(c.get("adminId"));
  if (!Number.isSafeInteger(value) || value <= 0) throw new ValidateException("管理员身份无效");
  return value;
}

function optionalPositiveInt(value: string | undefined, label: string): number | undefined {
  if (value === undefined || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new ValidateException(`${label}无效`);
  return parsed;
}

async function operationBody(c: C): Promise<Record<string, unknown>> {
  const declared = Number(c.req.header("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw new ValidateException("请求正文不能超过32 KiB");
  }
  const stream = c.req.raw.body;
  if (!stream) throw new ValidateException("缺少请求正文");
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new ValidateException("请求正文不能超过32 KiB");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Normalized below.
  }
  throw new ValidateException("请求正文格式错误");
}

export async function templateList(c: C) {
  return jsonOk(c, await service(c).listTemplates());
}

export async function templateSave(c: C) {
  const row = await service(c).saveTemplate(await operationBody(c) as NotificationTemplateSaveInput);
  return jsonOk(c, row, row?.id ? "模板已保存" : "模板保存成功");
}

export async function orderConfigList(c: C) {
  return jsonOk(c, await service(c).listOrderConfigs());
}

export async function orderConfigSave(c: C) {
  const row = await service(c).saveOrderConfig(
    c.req.param("mark"),
    await operationBody(c) as OrderNotificationConfigSaveInput,
  );
  return jsonOk(c, row, "通知渠道配置已保存");
}

export async function shippingConfigSave(c: C) {
  const body = await operationBody(c);
  return jsonOk(c, await service(c).saveShippingEnabled(body.enabled), "微信发货上报开关已保存");
}

export async function readiness(c: C) {
  return jsonOk(c, await service(c).readiness());
}

export async function deliveryList(c: C) {
  const query = c.req.query();
  return jsonOk(c, await service(c).listDeliveries({
    status: query.status,
    channel: query.channel,
    eventKey: query.event_key,
    afterId: optionalPositiveInt(query.after_id, "游标"),
    limit: optionalPositiveInt(query.limit, "每页数量"),
  }));
}

export async function deliveryActions(c: C) {
  return jsonOk(c, await service(c).listDeliveryActions(c.req.param("id")));
}

export async function deliveryConfirmSent(c: C) {
  const body = await operationBody(c);
  if (body.confirm !== "CONFIRM_NOTIFICATION_SENT") {
    throw new ValidateException("缺少已发送确认短语");
  }
  return jsonOk(c, await service(c).confirmSent(c.req.param("id"), adminId(c), {
    requestKey: body.request_key,
    reason: body.reason,
    providerReference: body.provider_reference,
  }), "投递已人工确认为发送成功");
}

export async function deliveryConfirmRetry(c: C) {
  const body = await operationBody(c);
  if (body.confirm !== "CONFIRM_NOTIFICATION_RETRY_WITH_DUPLICATE_RISK") {
    throw new ValidateException("缺少承担重复发送风险的确认短语");
  }
  return jsonOk(c, await service(c).confirmRetry(c.req.param("id"), adminId(c), {
    requestKey: body.request_key,
    reason: body.reason,
    providerReference: body.provider_reference,
  }), "投递已进入人工确认重发队列");
}

export async function deliveryClose(c: C) {
  const body = await operationBody(c);
  if (body.confirm !== "CLOSE_NOTIFICATION_WITHOUT_RETRY") {
    throw new ValidateException("缺少关闭且不重发确认短语");
  }
  return jsonOk(c, await service(c).closeWithoutRetry(c.req.param("id"), adminId(c), {
    requestKey: body.request_key,
    reason: body.reason,
    providerReference: body.provider_reference,
  }), "投递已关闭且不会重发");
}

/** Legacy endpoint retained as a non-secret readiness view. */
export async function smsConfig(c: C) {
  const status = await service(c).readiness();
  return jsonOk(c, {
    ...status.sms,
    secretPolicy: status.secretPolicy,
  });
}

/** Credentials must never be persisted to system_config or returned by Admin APIs. */
export async function smsConfigSave(_c: C) {
  throw new ValidateException("短信凭据只能通过 Cloudflare Worker secrets 配置，后台禁止保存或回显");
}
