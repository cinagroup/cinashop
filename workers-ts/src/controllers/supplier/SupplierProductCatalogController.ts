import type { Context, MiddlewareHandler } from "hono";
import type { AppVariables, Env } from "@/env";
import { SupplierProductCatalogService, supplierBrandCatalogType } from "@/services/supplier/SupplierProductCatalogService";
import { jsonOk } from "@/utils/json";

type SupplierApp = { Bindings: Env; Variables: AppVariables };
type C = Context<SupplierApp>;

export const privateResponse: MiddlewareHandler<SupplierApp> = async (c, next) => {
  c.header("Cache-Control", "private, no-store, max-age=0");
  c.header("Pragma", "no-cache");
  await next();
};

function identity(c: C) {
  const supplierId = c.get("supplierId");
  if (!supplierId) throw new Error("supplier auth context missing");
  return supplierId;
}

export async function labels(c: C) {
  return jsonOk(c, await new SupplierProductCatalogService(c.get("container")).labels(identity(c)));
}

export async function brands(c: C) {
  return jsonOk(c, await new SupplierProductCatalogService(c.get("container"))
    .brands(identity(c), supplierBrandCatalogType(c.req.param("type"))));
}
