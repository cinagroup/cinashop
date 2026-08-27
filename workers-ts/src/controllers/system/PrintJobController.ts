import type { Context } from "hono";
import type { AppVariables, Env } from "@/env";
import {
  ReceiptPrintJobService,
  type PrintJobActor,
} from "@/services/printing/ReceiptPrintJobService";
import { ValidateException } from "@/utils/errors";
import { jsonOk } from "@/utils/json";

type C = Context<{ Bindings: Env; Variables: AppVariables }>;

function service(c: C) {
  return new ReceiptPrintJobService(c.get("container"), c.env);
}

function adminActor(c: C): PrintJobActor {
  const actorId = c.get("adminId");
  if (!Number.isSafeInteger(actorId) || !actorId || actorId <= 0) throw new Error("admin auth context missing");
  return { supplierId: 0, actorType: "admin", actorId };
}

function supplierActor(c: C): PrintJobActor {
  const supplierId = c.get("supplierId");
  const actorId = c.get("supplierAdminId");
  if (!Number.isSafeInteger(supplierId) || !supplierId || supplierId <= 0) {
    throw new Error("supplier auth context missing");
  }
  if (!Number.isSafeInteger(actorId) || !actorId || actorId <= 0) {
    throw new Error("supplier admin auth context missing");
  }
  return { supplierId, actorType: "supplier", actorId };
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
    providerReference: value.provider_reference ?? value.providerReference,
  };
}

async function manual(c: C, actor: PrintJobActor) {
  const value = await body(c);
  return jsonOk(c, await service(c).createManualJobs(c.req.param("id"), actor, {
    requestKey: value.request_key ?? value.requestKey,
    printerId: value.printer_id ?? value.printerId,
  }), "打印任务已受理");
}

async function jobs(c: C, actor: PrintJobActor) {
  const query = c.req.query();
  return jsonOk(c, await service(c).listJobs(actor, {
    status: query.status,
    trigger: query.trigger,
    orderId: query.order_id ? Number(query.order_id) : undefined,
    afterId: query.after_id ? Number(query.after_id) : undefined,
    limit: query.limit ? Number(query.limit) : undefined,
  }));
}

async function actions(c: C, actor: PrintJobActor) {
  return jsonOk(c, await service(c).listActions(c.req.param("id"), actor));
}

async function confirmSent(c: C, actor: PrintJobActor) {
  return jsonOk(c, await service(c).confirmSent(
    c.req.param("id"), actor, operationInput(await body(c)),
  ), "已确认打印成功");
}

async function confirmRetry(c: C, actor: PrintJobActor) {
  return jsonOk(c, await service(c).confirmRetry(
    c.req.param("id"), actor, operationInput(await body(c)),
  ), "已确认重新打印");
}

async function close(c: C, actor: PrintJobActor) {
  return jsonOk(c, await service(c).closeWithoutRetry(
    c.req.param("id"), actor, operationInput(await body(c)),
  ), "已关闭且不会自动重打");
}

export const adminManual = (c: C) => manual(c, adminActor(c));
export const adminJobs = (c: C) => jobs(c, adminActor(c));
export const adminActions = (c: C) => actions(c, adminActor(c));
export const adminConfirmSent = (c: C) => confirmSent(c, adminActor(c));
export const adminConfirmRetry = (c: C) => confirmRetry(c, adminActor(c));
export const adminClose = (c: C) => close(c, adminActor(c));

export const supplierManual = (c: C) => manual(c, supplierActor(c));
export const supplierJobs = (c: C) => jobs(c, supplierActor(c));
export const supplierActions = (c: C) => actions(c, supplierActor(c));
export const supplierConfirmSent = (c: C) => confirmSent(c, supplierActor(c));
export const supplierConfirmRetry = (c: C) => confirmRetry(c, supplierActor(c));
export const supplierClose = (c: C) => close(c, supplierActor(c));
