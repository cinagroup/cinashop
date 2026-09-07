import type { Context } from "hono";
import type { AppVariables, Env } from "@/env";
import { jsonOk } from "@/utils/json";
import { couponScopeProductsQuery, CouponScopeProductsService } from "@/services/activity/CouponScopeProductsService";

export async function couponScopeProducts(c: Context<{ Bindings: Env; Variables: AppVariables }>) {
  c.header("Cache-Control", "private, no-store");
  const service = new CouponScopeProductsService(c.get("container"));
  if (c.req.query("view") === "search") return jsonOk(c, await service.search(c.get("uid"), c.req.param("id"), c.req.query()));
  const query = couponScopeProductsQuery(c.req.param("id"), c.req.query());
  const result = c.req.query("view") === "scope" ? await service.describe(c.get("uid"), query) : await service.list(c.get("uid"), query);
  return jsonOk(c, result);
}
