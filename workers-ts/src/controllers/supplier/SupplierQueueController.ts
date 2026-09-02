import type { Context } from "hono";
import type { AppVariables, Env } from "@/env";
import { SupplierQueueHistoryService } from "@/services/supplier/SupplierQueueHistoryService";
import { jsonOk } from "@/utils/json";

type C = Context<{ Bindings: Env; Variables: AppVariables }>;

function service(c: C) {
  return new SupplierQueueHistoryService(c.get("container"));
}

function supplierId(c: C): number {
  const value = c.get("supplierId");
  if (!Number.isSafeInteger(value) || !value || value <= 0) {
    throw new Error("supplier auth context missing");
  }
  return value;
}

export async function queueList(c: C) {
  return jsonOk(c, await service(c).list(supplierId(c), c.req.query()));
}

export async function deliveryLog(c: C) {
  return jsonOk(c, await service(c).deliveryLog(
    supplierId(c),
    c.req.param("id"),
    c.req.param("type"),
    c.req.query(),
  ));
}
