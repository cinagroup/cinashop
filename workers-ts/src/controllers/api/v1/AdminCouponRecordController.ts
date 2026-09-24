import type { Context } from "hono";
import type { AppVariables, Env } from "@/env";
import { AdminCouponRecordService, parseAdminCouponRecordQuery } from "@/services/admin/AdminCouponRecordService";
import { jsonOk } from "@/utils/json";

type C = Context<{ Bindings: Env; Variables: AppVariables }>;

/** GET /adminapi/marketing/coupon-records/list — private claim history, never a coupon grant. */
export async function list(c: C) {
  c.header("Cache-Control", "private, no-store, max-age=0");
  c.header("Pragma", "no-cache");
  return jsonOk(c, await new AdminCouponRecordService(c.get("container")).list(
    parseAdminCouponRecordQuery(c.req.query()),
  ));
}
