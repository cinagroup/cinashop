import { sql } from "drizzle-orm";
import type { AppVariables } from "@/env";
import { createContainerFromDb, withTx, type Container } from "@/lib/di";
import { AuthException, ApiErrorCode } from "@/utils/errors";
import { AdminPermissionService } from "@/services/admin/AdminPermissionService";

export interface AdminPendingCounts {
  ordernum: number;
  inventory: number;
  commentnum: number;
  reflectnum: number;
  msgcount: number;
  sampled_at: number;
}

/** Pending work, not unread messages. Reading this snapshot never acknowledges an event. */
export class AdminNewPushService {
  constructor(private readonly container: Container) {}

  async snapshot(actor: AppVariables["adminInfo"]): Promise<AdminPendingCounts> {
    if (!actor || !Number.isSafeInteger(actor.id) || actor.id <= 0) {
      throw new AuthException("请登录", ApiErrorCode.ERR_LOGIN);
    }
    return withTx(this.container, async (tx) => {
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
      await tx.execute(sql`SET LOCAL statement_timeout = '5s'`);
      const permissions = await new AdminPermissionService(createContainerFromDb(tx)).resolveAdminPermissionKeys(actor);
      const allowed = (domain: string) => permissions.has(`${domain}.view`);
      // One snapshot: each count is independently permission-scoped. CURRENT_TIMESTAMP
      // is a real freshness label, not a comment used as a Hyperdrive cache-control trick.
      const rows = await tx.execute<Record<string, unknown>>(sql`
        SELECT
          CASE WHEN ${allowed("order")} THEN (
            SELECT count(*) FROM store_order WHERE paid = 1 AND status IN (0, 4)
              AND refund_status IN (0, 3) AND shipping_type = 1
              AND is_del = 0 AND is_system_del = 0 AND pid <> -1
          ) ELSE 0 END AS ordernum,
          CASE WHEN ${allowed("product")} THEN (
            SELECT count(*) FROM store_product WHERE is_show = 1 AND is_del = 0
              AND is_verify = 1 AND is_police = 1 AND stock > 0
          ) ELSE 0 END AS inventory,
          CASE WHEN ${allowed("reply")} THEN (
            SELECT count(*) FROM store_product_reply WHERE is_reply = 0 AND is_del = 0
          ) ELSE 0 END AS commentnum,
          CASE WHEN ${allowed("extract")} THEN (
            SELECT count(*) FROM user_extract WHERE status = 0
          ) ELSE 0 END AS reflectnum,
          floor(extract(epoch FROM CURRENT_TIMESTAMP))::text AS sampled_at
      `);
      const result: unknown = rows;
      const records: unknown = Array.isArray(result) ? result : result && typeof result === "object" ? Reflect.get(result, "rows") : undefined;
      const row: unknown = Array.isArray(records) ? records[0] : undefined;
      const number = (key: string): number => {
        const raw: unknown = row && typeof row === "object" ? Reflect.get(row, key) : undefined;
        const numeric = (typeof raw === "string" && /^\d+$/.test(raw)) || typeof raw === "number";
        const value = numeric ? Number(raw) : NaN;
        if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid pending-count snapshot");
        return value;
      };
      const counts = { ordernum: number("ordernum"), inventory: number("inventory"), commentnum: number("commentnum"), reflectnum: number("reflectnum") };
      const msgcount = Object.values(counts).reduce((sum, value) => sum + value, 0);
      if (!Number.isSafeInteger(msgcount)) throw new Error("Invalid pending-count total");
      return { ...counts, msgcount, sampled_at: number("sampled_at") };
    });
  }
}
