import type { Context } from "hono";
import type { AppVariables, Env } from "@/env";
import {
  OrderWaybillJobService,
  type WaybillActor,
} from "@/services/waybill/OrderWaybillJobService";
import { ValidateException } from "@/utils/errors";
import { jsonOk } from "@/utils/json";

type C = Context<{ Bindings: Env; Variables: AppVariables }>;

function service(c: C) {
  return new OrderWaybillJobService(c.get("container"), c.env);
}

function adminActor(c: C): WaybillActor {
  const actorId = c.get("adminId");
  if (!Number.isSafeInteger(actorId) || !actorId || actorId <= 0) {
    throw new Error("admin auth context missing");
  }
  return { actorType: "admin", actorId };
}

function supplierActor(c: C): WaybillActor {
  const supplierId = c.get("supplierId");
  const actorId = c.get("supplierAdminId");
  if (!Number.isSafeInteger(supplierId) || !supplierId || supplierId <= 0) {
    throw new Error("supplier auth context missing");
  }
  if (!Number.isSafeInteger(actorId) || !actorId || actorId <= 0) {
    throw new Error("supplier admin auth context missing");
  }
  return { actorType: "supplier", actorId, supplierId };
}

async function body(c: C): Promise<Record<string, unknown>> {
  const length = Number(c.req.header("content-length") ?? "0");
  if (Number.isFinite(length) && length > 32 * 1_024) throw new ValidateException("请求不能超过32 KiB");
  const value: unknown = await c.req.json().catch(() => null);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ValidateException("请求数据格式错误");
  }
  if (JSON.stringify(value).length > 32 * 1_024) throw new ValidateException("请求不能超过32 KiB");
  return value as Record<string, unknown>;
}

function operationInput(value: Record<string, unknown>) {
  return {
    requestKey: value.request_key ?? value.requestKey,
    reason: value.reason,
    trackingNumber: value.tracking_number ?? value.trackingNumber,
    labelUrl: value.label_url ?? value.labelUrl,
    providerReference: value.provider_reference ?? value.providerReference,
  };
}

async function create(c: C, actor: WaybillActor) {
  return jsonOk(
    c,
    await service(c).create(c.req.param("id"), actor, await body(c)),
    "电子面单签发任务已受理",
  );
}

async function jobs(c: C, actor: WaybillActor) {
  const query = c.req.query();
  return jsonOk(c, await service(c).listJobs(actor, {
    status: query.status,
    supplierId: query.supplier_id ? Number(query.supplier_id) : undefined,
    orderId: query.order_id ? Number(query.order_id) : undefined,
    afterId: query.after_id ? Number(query.after_id) : undefined,
    limit: query.limit ? Number(query.limit) : undefined,
  }));
}

async function actions(c: C, actor: WaybillActor) {
  return jsonOk(c, await service(c).listActions(c.req.param("id"), actor));
}

async function applyExisting(c: C, actor: WaybillActor) {
  return jsonOk(c, await service(c).applyExisting(
    c.req.param("id"), actor, operationInput(await body(c)),
  ), "已使用既有面单完成发货");
}

async function confirmIssued(c: C, actor: WaybillActor) {
  return jsonOk(c, await service(c).confirmIssued(
    c.req.param("id"), actor, operationInput(await body(c)),
  ), "已确认面单并完成发货");
}

async function confirmRetry(c: C, actor: WaybillActor) {
  return jsonOk(c, await service(c).confirmRetry(
    c.req.param("id"), actor, operationInput(await body(c)),
  ), "已确认重新签发");
}

async function close(c: C, actor: WaybillActor) {
  return jsonOk(c, await service(c).closeWithoutRetry(
    c.req.param("id"), actor, operationInput(await body(c)),
  ), "已关闭且不会自动重签");
}

export const adminCreate = (c: C) => create(c, adminActor(c));
export const adminJobs = (c: C) => jobs(c, adminActor(c));
export const adminActions = (c: C) => actions(c, adminActor(c));
export const adminApplyExisting = (c: C) => applyExisting(c, adminActor(c));
export const adminConfirmIssued = (c: C) => confirmIssued(c, adminActor(c));
export const adminConfirmRetry = (c: C) => confirmRetry(c, adminActor(c));
export const adminClose = (c: C) => close(c, adminActor(c));

export const supplierCreate = (c: C) => create(c, supplierActor(c));
export const supplierJobs = (c: C) => jobs(c, supplierActor(c));
export const supplierActions = (c: C) => actions(c, supplierActor(c));
export const supplierApplyExisting = (c: C) => applyExisting(c, supplierActor(c));
export const supplierConfirmIssued = (c: C) => confirmIssued(c, supplierActor(c));
export const supplierConfirmRetry = (c: C) => confirmRetry(c, supplierActor(c));
export const supplierClose = (c: C) => close(c, supplierActor(c));
