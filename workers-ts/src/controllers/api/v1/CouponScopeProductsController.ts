import type { Context } from "hono";
import type { AppVariables, Env } from "@/env";
import { jsonOk } from "@/utils/json";
import { couponScopeProductsQuery, CouponScopeProductsService } from "@/services/activity/CouponScopeProductsService";

export async function couponScopeProducts(c: Context<{ Bindings: Env; Variables: AppVariables }>) {
  c.header("Cache-Control", "private, no-store");
  const result = await new CouponScopeProductsService(c.get("container"))
    .list(c.get("uid"), couponScopeProductsQuery(c.req.param("id"), c.req.query()));
  return jsonOk(c, result);
}
