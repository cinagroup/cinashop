import type { Context } from "hono";
import type { AppVariables, Env } from "@/env";
import { AdminUserMoneyLedgerService, parseAdminUserMoneyLedgerQuery } from "@/services/admin/AdminUserMoneyLedgerService";
import { AdminUserMoneyLedgerExportService } from "@/services/admin/AdminUserMoneyLedgerExportService";
import { ValidateException } from "@/utils/errors";
import { jsonOk } from "@/utils/json";

type C = Context<{ Bindings: Env; Variables: AppVariables }>;

function privateNoStore(c: C): void {
  c.header("Cache-Control", "private, no-store, max-age=0");
  c.header("Pragma", "no-cache");
}

/** GET /adminapi/finance/user-money-ledger — cash ledger, never user_bill points. */
export async function list(c: C) {
  privateNoStore(c);
  const query = parseAdminUserMoneyLedgerQuery(new URL(c.req.url).searchParams);
  return jsonOk(c, await new AdminUserMoneyLedgerService(c.get("container")).list(query));
}

/** GET /adminapi/finance/user-money-ledger/types — old distinct type directory. */
export async function types(c: C) {
  privateNoStore(c);
  if (new URL(c.req.url).searchParams.size) throw new ValidateException("资金流水类型目录不接受筛选参数");
  return jsonOk(c, await new AdminUserMoneyLedgerService(c.get("container")).types());
}

/** GET /adminapi/finance/user-money-ledger/export — bounded full CSV manifest. */
export async function exportManifest(c: C) {
  privateNoStore(c);
  return jsonOk(c, await new AdminUserMoneyLedgerExportService(c.get("container")).manifest(new URL(c.req.url).searchParams));
}
