import type { MiddlewareHandler } from "hono";
import type { AppVariables, Env } from "@/env";
import { SupplierPermissionService } from "@/services/supplier/SupplierPermissionService";

/** Enforce a default-deny capability on every authenticated Supplier route. */
export const supplierPermissionMiddleware: MiddlewareHandler<{
  Bindings: Env;
  Variables: AppVariables;
}> = async (c, next) => {
  const supplierId = c.get("supplierId");
  const principal = c.get("supplierAdminInfo");
  if (!supplierId || !principal) throw new Error("supplier auth context missing");
  const granted = await new SupplierPermissionService(c.get("container").db).assertAuthorized(
    principal,
    supplierId,
    c.req.method,
    c.req.path,
  );
  c.set("supplierPermissions", [...granted]);
  await next();
};
