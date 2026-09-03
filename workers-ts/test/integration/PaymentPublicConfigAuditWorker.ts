import postgres from "postgres";

type AuditEnv = Pick<WorkerBindings, "HYPERDRIVE"> & {
  AUDIT_TOKEN_SHA256: string;
};

const PUBLIC_CONFIG_NAMES = [
  "pay_weixin_open",
  "pay_weixin_mchid",
  "pay_weixin_serial_no",
  "wechat_appid",
  "routine_appId",
  "wechat_app_appid",
  "site_url",
  "pay_wechat_type",
  "pay_routine_open",
  "pay_routine_mchid",
] as const;

const RETIRED_SECRET_CONFIG_NAMES = [
  "pay_weixin_key",
  "v3_pay_weixin_key",
  "pay_weixin_client_cert",
  "pay_weixin_client_key",
  "alipay_public_key",
  "alipay_merchant_private_key",
] as const;

interface PublicConfigRow {
  menu_name: string;
  row_count: number;
  distinct_value_count: number;
  present: boolean;
  value_length: number;
  format_valid: boolean;
}

interface SecretConfigRow {
  menu_name: string;
  row_count: number;
  populated_rows: number;
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
    if (request.method !== "GET" || new URL(request.url).pathname !== "/audit") {
      return Response.json({ error: "not found" }, { status: 404 });
    }

    const client = postgres(env.HYPERDRIVE.connectionString, {
      prepare: false,
      max: 1,
      connection: { application_name: "cinashop_payment_public_config_audit" },
    });
    try {
      const report = await client.begin("read only", async (tx) => {
        await tx`SET LOCAL lock_timeout = '2s'`;
        await tx`SET LOCAL statement_timeout = '10s'`;
        await tx`SET LOCAL idle_in_transaction_session_timeout = '15s'`;

        const versionRows = await tx<{ server_version: string }[]>`
          SELECT current_setting('server_version') AS server_version
        `;
        const tableRows = await tx<{
          system_config: boolean;
          store_order: boolean;
          payment_reconciliation_case: boolean;
          store_order_refund_payment: boolean;
        }[]>`
          SELECT
            to_regclass('public.system_config') IS NOT NULL AS system_config,
            to_regclass('public.store_order') IS NOT NULL AS store_order,
            to_regclass('public.payment_reconciliation_case') IS NOT NULL AS payment_reconciliation_case,
            to_regclass('public.store_order_refund_payment') IS NOT NULL AS store_order_refund_payment
        `;
        const tables = tableRows[0] ?? {
          system_config: false,
          store_order: false,
          payment_reconciliation_case: false,
          store_order_refund_payment: false,
        };
        if (!tables.system_config) throw new Error("system_config relation is missing");

        const publicRows = await tx<PublicConfigRow[]>`
          WITH normalized AS (
            SELECT
              menu_name,
              sort,
              id,
              CASE
                WHEN left(btrim(value), 1) = '"' AND right(btrim(value), 1) = '"'
                  THEN substring(btrim(value) FROM 2 FOR greatest(char_length(btrim(value)) - 2, 0))
                ELSE btrim(value)
              END AS normalized_value
            FROM system_config
            WHERE is_store = 0 AND menu_name IN ${tx(PUBLIC_CONFIG_NAMES)}
          ), stats AS (
            SELECT
              menu_name,
              count(*)::integer AS row_count,
              count(DISTINCT normalized_value)::integer AS distinct_value_count
            FROM normalized
            GROUP BY menu_name
          ), latest AS (
            SELECT DISTINCT ON (menu_name) menu_name, normalized_value
            FROM normalized
            ORDER BY menu_name, sort DESC, id DESC
          )
          SELECT
            latest.menu_name,
            stats.row_count,
            stats.distinct_value_count,
            latest.normalized_value <> '' AS present,
            char_length(latest.normalized_value)::integer AS value_length,
            CASE
              WHEN latest.menu_name IN ('pay_weixin_open', 'pay_routine_open')
                THEN latest.normalized_value IN ('0', '1')
              WHEN latest.menu_name IN ('pay_weixin_mchid', 'pay_routine_mchid')
                THEN latest.normalized_value ~ '^\\d{1,32}$'
              WHEN latest.menu_name = 'pay_weixin_serial_no'
                THEN latest.normalized_value ~* '^[A-F0-9]{1,64}$'
              WHEN latest.menu_name IN ('wechat_appid', 'routine_appId', 'wechat_app_appid')
                THEN char_length(latest.normalized_value) BETWEEN 1 AND 32
              WHEN latest.menu_name = 'site_url'
                THEN latest.normalized_value ~* '^https://[^/[:space:]]+'
              ELSE latest.normalized_value <> ''
            END AS format_valid
          FROM latest
          INNER JOIN stats USING (menu_name)
          ORDER BY latest.menu_name
        `;
        const publicByName = new Map(publicRows.map((row) => [row.menu_name, row]));
        const publicConfig = PUBLIC_CONFIG_NAMES.map((name) => publicByName.get(name) ?? {
          menu_name: name,
          row_count: 0,
          distinct_value_count: 0,
          present: false,
          value_length: 0,
          format_valid: false,
        });

        const secretRows = await tx<SecretConfigRow[]>`
          SELECT
            menu_name,
            count(*)::integer AS row_count,
            count(*) FILTER (WHERE btrim(value) NOT IN ('', '""'))::integer AS populated_rows
          FROM system_config
          WHERE is_store = 0 AND menu_name IN ${tx(RETIRED_SECRET_CONFIG_NAMES)}
          GROUP BY menu_name
          ORDER BY menu_name
        `;
        const secretByName = new Map(secretRows.map((row) => [row.menu_name, row]));
        const retiredDatabaseSecrets = RETIRED_SECRET_CONFIG_NAMES.map((name) => secretByName.get(name) ?? {
          menu_name: name,
          row_count: 0,
          populated_rows: 0,
        });

        const orderProfiles = tables.store_order
          ? await tx<{ profile: string; paid_orders: number }[]>`
              SELECT
                CASE
                  WHEN lower(channel_type) = 'routine' OR is_channel = 1 THEN 'routine'
                  WHEN lower(channel_type) = 'app' THEN 'app'
                  WHEN lower(channel_type) IN ('wechat', 'weixin', 'h5', 'weixinh5', 'pc', '')
                    THEN 'wechat_or_legacy_blank'
                  ELSE 'unknown'
                END AS profile,
                count(*)::integer AS paid_orders
              FROM store_order
              WHERE paid = 1 AND lower(pay_type) IN ('wechat', 'weixin')
              GROUP BY 1
              ORDER BY 1
            `
          : [];
        const reconciliationProfiles = tables.payment_reconciliation_case
          ? await tx<{ profile: string; status: string; cases: number }[]>`
              SELECT profile, status, count(*)::integer AS cases
              FROM payment_reconciliation_case
              WHERE provider = 'wechat'
              GROUP BY profile, status
              ORDER BY profile, status
            `
          : [];
        const refundProviders = tables.store_order_refund_payment
          ? await tx<{ provider: string; payments: number }[]>`
              SELECT provider, count(*)::integer AS payments
              FROM store_order_refund_payment
              GROUP BY provider
              ORDER BY provider
            `
          : [];

        return {
          server_version: versionRows[0]?.server_version ?? "unknown",
          transaction_mode: "read only",
          tables,
          public_config: publicConfig,
          retired_database_secret_rows: retiredDatabaseSecrets,
          paid_wechat_orders_by_profile_hint: orderProfiles,
          reconciliation_cases_by_profile: reconciliationProfiles,
          refund_payments_by_provider: refundProviders,
        };
      });
      return Response.json(report, {
        headers: {
          "Cache-Control": "private, no-store",
          "X-Content-Type-Options": "nosniff",
        },
      });
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : String(error) },
        { status: 500, headers: { "Cache-Control": "private, no-store" } },
      );
    } finally {
      await client.end({ timeout: 5 });
    }
  },
} satisfies ExportedHandler<AuditEnv>;
