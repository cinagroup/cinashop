import postgres from "postgres";
import { parseRechargeQuota } from "@/services/user/UserFinanceService";

type AuditEnv = Pick<WorkerBindings, "HYPERDRIVE"> & {
  AUDIT_TOKEN_SHA256: string;
};

const PAYMENT_CONFIG_NAMES = [
  "ali_pay_status",
  "balance_func_status",
  "offline_pay_status",
  "order_activity_time",
  "order_bargain_time",
  "order_cancel_time",
  "order_pink_time",
  "order_seckill_time",
  "pay_weixin_mchid",
  "pay_weixin_open",
  "pay_weixin_serial_no",
  "rebate_points_orders_time",
  "recharge_attention",
  "site_url",
  "store_user_min_recharge",
  "user_extract_balance_status",
  "wechat_appid",
  "yue_pay_status",
] as const;

function normalizeConfigScalar(value: unknown): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized.startsWith('"') || !normalized.endsWith('"')) return normalized;
  try {
    const parsed: unknown = JSON.parse(normalized);
    return typeof parsed === "string" || typeof parsed === "number" || typeof parsed === "boolean"
      ? String(parsed).trim()
      : normalized;
  } catch {
    return normalized;
  }
}

async function authorize(request: Request, verifier: string): Promise<boolean> {
  const token = request.headers.get("X-Audit-Token") ?? "";
  if (!token || !/^[a-f0-9]{64}$/i.test(verifier ?? "")) return false;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  const actual = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  const encoder = new TextEncoder();
  const [actualHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(actual)),
    crypto.subtle.digest("SHA-256", encoder.encode(verifier)),
  ]);
  return crypto.subtle.timingSafeEqual(actualHash, expectedHash);
}

export default {
  async fetch(request: Request, env: AuditEnv): Promise<Response> {
    if (!(await authorize(request, env.AUDIT_TOKEN_SHA256))) {
      return Response.json({ error: "forbidden" }, { status: 403 });
    }
    if (request.method !== "GET" || new URL(request.url).pathname !== "/readiness") {
      return Response.json({ error: "not found" }, { status: 404 });
    }

    const client = postgres(env.HYPERDRIVE.connectionString, {
      prepare: false,
      max: 1,
      connection: { application_name: "cinashop_payment_readiness" },
    });
    try {
      const [versionRows, tableRows, configRows, rechargeRows, indexRows, quotaRows, brokerageRows] = await Promise.all([
        client<{ server_version: string }[]>`
          SELECT current_setting('server_version') AS server_version
        `,
        client<{ store_order: boolean; user_recharge: boolean; other_order: boolean; wechat_user: boolean }[]>`
          SELECT
            to_regclass('public.store_order') IS NOT NULL AS store_order,
            to_regclass('public.user_recharge') IS NOT NULL AS user_recharge,
            to_regclass('public.other_order') IS NOT NULL AS other_order,
            to_regclass('public.wechat_user') IS NOT NULL AS wechat_user
        `,
        client<{ menu_name: string; value: string }[]>`
          SELECT DISTINCT ON (menu_name) menu_name, value
          FROM system_config
          WHERE is_store = 0 AND menu_name IN ${client(PAYMENT_CONFIG_NAMES)}
          ORDER BY menu_name, sort DESC, id DESC
        `,
        client<{
          total: string;
          unpaid: string;
          paid: string;
          paid_without_trade_no: string;
          duplicate_order_ids: string;
        }[]>`
          SELECT
            count(*)::text AS total,
            count(*) FILTER (WHERE paid = 0)::text AS unpaid,
            count(*) FILTER (WHERE paid = 1)::text AS paid,
            count(*) FILTER (WHERE paid = 1 AND trade_no = '')::text AS paid_without_trade_no,
            (count(*) - count(DISTINCT order_id))::text AS duplicate_order_ids
          FROM user_recharge
        `,
        client<{ has_order_id_index: boolean; has_uid_index: boolean }[]>`
          SELECT
            coalesce(bool_or(indexdef ~* '\\(order_id\\)'), false) AS has_order_id_index,
            coalesce(bool_or(indexdef ~* '\\(uid\\)'), false) AS has_uid_index
          FROM pg_indexes
          WHERE schemaname = 'public' AND tablename = 'user_recharge'
        `,
        client<{ id: number; value: string | null }[]>`
          SELECT d.id, d.value
          FROM system_group_data d
          INNER JOIN system_group g ON g.id = d.gid
          WHERE g.config_name = 'user_recharge_quota' AND d.status = 1
          ORDER BY d.sort DESC, d.id
        `,
        client<{
          active_users: string;
          users_with_brokerage: string;
          total_brokerage: string;
          frozen_brokerage: string;
          withdrawable_brokerage: string;
        }[]>`
          WITH frozen AS (
            SELECT uid, sum(number)::numeric(12,2) AS amount
            FROM user_brokerage
            WHERE pm = 1 AND status = 1
              AND frozen_time > extract(epoch FROM now())::integer
            GROUP BY uid
          )
          SELECT
            count(*)::text AS active_users,
            count(*) FILTER (WHERE u.brokerage_price > 0)::text AS users_with_brokerage,
            coalesce(sum(u.brokerage_price), 0)::text AS total_brokerage,
            coalesce(sum(least(u.brokerage_price, coalesce(f.amount, 0))), 0)::text AS frozen_brokerage,
            coalesce(sum(greatest(u.brokerage_price - coalesce(f.amount, 0), 0)), 0)::text AS withdrawable_brokerage
          FROM "user" u
          LEFT JOIN frozen f ON f.uid = u.uid
          WHERE u.is_del = 0 AND u.status = 1
        `,
      ]);

      const config = new Map(
        configRows.map((row) => [row.menu_name, normalizeConfigScalar(row.value)]),
      );
      const enabled = (name: string, expected = "1") => config.get(name) === expected;
      const present = (name: string) => Boolean(config.get(name));
      const siteUrl = config.get("site_url") ?? "";
      const quotas = quotaRows
        .map((row) => parseRechargeQuota(row.id, row.value))
        .filter((quota) => quota !== null);

      return Response.json({
        server_version: versionRows[0]?.server_version ?? "unknown",
        tables: tableRows[0] ?? {},
        payment_config: {
          wechat_enabled: enabled("pay_weixin_open"),
          wechat_appid_present: present("wechat_appid"),
          wechat_mchid_present: present("pay_weixin_mchid"),
          wechat_serial_present: present("pay_weixin_serial_no"),
          alipay_enabled: enabled("ali_pay_status"),
          balance_enabled: enabled("balance_func_status") && enabled("yue_pay_status"),
          offline_enabled: enabled("offline_pay_status"),
          site_url_is_https: /^https:\/\/[^/]+/i.test(siteUrl),
          min_recharge_present: present("store_user_min_recharge"),
          cancellation_config_present: [
            "order_cancel_time",
            "order_activity_time",
            "order_bargain_time",
            "order_seckill_time",
            "order_pink_time",
            "rebate_points_orders_time",
          ].every((name) => config.has(name)),
        },
        recharge: rechargeRows[0] ?? {},
        recharge_quota: {
          active_rows: quotaRows.length,
          valid_rows: quotas.length,
          malformed_rows: quotaRows.length - quotas.length,
          values: quotas,
        },
        brokerage_to_balance: {
          config_present: config.has("user_extract_balance_status"),
          enabled_with_php_default: (config.get("user_extract_balance_status") ?? "1") === "1",
          recharge_attention_present: present("recharge_attention"),
          aggregate: brokerageRows[0] ?? {},
        },
        indexes: indexRows[0] ?? {},
      });
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : String(error) },
        { status: 500 },
      );
    } finally {
      await client.end({ timeout: 5 });
    }
  },
} satisfies ExportedHandler<AuditEnv>;
