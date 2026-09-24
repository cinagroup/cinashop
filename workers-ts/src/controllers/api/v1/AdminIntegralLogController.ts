import type { Context } from "hono";
import type { AppVariables, Env } from "@/env";
import { AdminIntegralLogService, parseAdminIntegralLogQuery } from "@/services/admin/AdminIntegralLogService";
import { jsonOk } from "@/utils/json";

type C = Context<{ Bindings: Env; Variables: AppVariables }>;

function privateNoStore(c: C): void {
  c.header("Cache-Control", "private, no-store, max-age=0");
  c.header("Pragma", "no-cache");
}

/** GET /adminapi/marketing/user-point/logs — scoped integral ledger, read-only. */
export async function list(c: C) {
  privateNoStore(c);
  const query = parseAdminIntegralLogQuery(c.req.query());
  return jsonOk(c, await new AdminIntegralLogService(c.get("container")).list(query));
}

/** GET /adminapi/marketing/user-point/statistics — four legacy integral badges. */
export async function statistics(c: C) {
  privateNoStore(c);
  const query = parseAdminIntegralLogQuery(c.req.query());
  return jsonOk(c, await new AdminIntegralLogService(c.get("container")).statistics(query));
}
