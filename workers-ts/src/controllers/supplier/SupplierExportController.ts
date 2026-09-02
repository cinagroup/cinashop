import type { Context } from "hono";
import type { AppVariables, Env } from "@/env";
import { SupplierExportService } from "@/services/supplier/SupplierExportService";
import { jsonOk } from "@/utils/json";

type C = Context<{ Bindings: Env; Variables: AppVariables }>;

function supplierId(c: C): number {
  const value = c.get("supplierId");
  if (!Number.isSafeInteger(value) || !value || value <= 0) throw new Error("supplier auth context missing");
  return value;
}

function service(c: C): SupplierExportService {
  return new SupplierExportService(c.get("container"));
}

export async function storeOrder(c: C) {
  return jsonOk(c, await service(c).storeOrder(supplierId(c), c.req.query()));
}

export async function expressList(c: C) {
  return jsonOk(c, await service(c).expressList(supplierId(c)));
}

export async function batchOrderDelivery(c: C) {
  return jsonOk(c, await service(c).batchOrderDelivery(
    supplierId(c),
    c.req.param("id"),
    c.req.param("queueType"),
    c.req.param("cacheType"),
  ));
}

export async function financeRecord(c: C) {
  return jsonOk(c, await service(c).financeRecord(supplierId(c), c.req.query()));
}
