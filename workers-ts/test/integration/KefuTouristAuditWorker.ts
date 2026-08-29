import postgres from "postgres";

interface AuditEnv {
  HYPERDRIVE: Hyperdrive;
  AUDIT_TOKEN_SHA256: string;
}

async function authorize(request: Request, expected: string): Promise<boolean> {
  const supplied = request.headers.get("Authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (!supplied || !/^[a-f0-9]{64}$/i.test(expected)) return false;
  const encoder = new TextEncoder();
  const [actual, configured] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(supplied)),
    Promise.resolve(expected),
  ]);
  const actualHex = Array.from(
    new Uint8Array(actual),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  const [left, right] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(actualHex)),
    crypto.subtle.digest("SHA-256", encoder.encode(configured)),
  ]);
  return crypto.subtle.timingSafeEqual(left, right);
}

async function audit(connectionString: string) {
  const client = postgres(connectionString, {
    max: 1,
    prepare: false,
    connect_timeout: 10,
    idle_timeout: 5,
    connection: { application_name: "cinashop_kefu_tourist_read_only_audit" },
  });
  try {
    return await client.begin(async (tx) => {
      await tx`SET LOCAL search_path TO public`;
      await tx`SET LOCAL statement_timeout = '30s'`;
      await tx`SET LOCAL lock_timeout = '2s'`;
      await tx`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`;
      const state = await tx<Array<Record<string, unknown>>>`
        SELECT
          current_setting('server_version') AS server_version,
          current_setting('transaction_read_only') AS transaction_read_only,
          (SELECT count(*)::integer FROM store_service) AS kefu_rows,
          (SELECT count(*)::integer FROM store_service
            WHERE is_del = 0 AND status = 1 AND account_status = 1) AS active_kefu_rows,
          (SELECT count(*)::integer FROM store_service
            WHERE is_del = 0 AND status = 1 AND account_status = 1 AND online = 1) AS online_kefu_rows,
          (SELECT count(*)::integer FROM store_product) AS product_rows,
          (SELECT count(*)::integer FROM store_product
            WHERE is_del = 0 AND is_show = 1 AND is_verify = 1) AS public_product_rows,
          (SELECT count(*)::integer FROM store_service_feedback) AS feedback_rows,
          (SELECT count(*)::integer FROM store_service_feedback WHERE uid = 0) AS anonymous_feedback_rows,
          (SELECT count(*)::integer FROM store_service_feedback WHERE status = 0) AS pending_feedback_rows,
          (SELECT count(*)::integer FROM store_service_record) AS service_record_rows,
          (SELECT count(*)::integer FROM store_service_record WHERE is_tourist = 1) AS tourist_record_rows,
          (SELECT count(*)::integer FROM store_service_log) AS service_log_rows,
          (SELECT count(*)::integer FROM store_service_log WHERE is_tourist = 1) AS tourist_log_rows,
          (SELECT md5(COALESCE(string_agg(
            id::text || ':' || uid::text || ':' || status::text || ':' || length(content)::text,
            '|' ORDER BY id
          ), '')) FROM store_service_feedback) AS feedback_structural_fingerprint,
          (SELECT md5(COALESCE(string_agg(
            id::text || ':' || user_id::text || ':' || to_uid::text || ':' || is_tourist::text,
            '|' ORDER BY id
          ), '')) FROM store_service_record) AS record_structural_fingerprint,
          (SELECT md5(COALESCE(string_agg(
            id::text || ':' || uid::text || ':' || to_uid::text || ':' || is_tourist::text
              || ':' || msn_type::text,
            '|' ORDER BY id
          ), '')) FROM store_service_log) AS log_structural_fingerprint
      `;
      const configs = await tx<Array<Record<string, unknown>>>`
        WITH requested(menu_name) AS (
          VALUES
            ('kf_adv'), ('service_feedback'), ('tourist_avatar'),
            ('config_export_open'), ('config_export_id'), ('config_export_temp_id'),
            ('config_export_siid'), ('config_export_to_name'), ('config_export_to_tel'),
            ('config_export_to_address')
        )
        SELECT requested.menu_name,
               count(config.id)::integer AS rows,
               count(config.id) FILTER (
                 WHERE NULLIF(btrim(config.value), '') IS NOT NULL
               )::integer AS nonempty_rows,
               COALESCE((array_agg(
                 (NULLIF(btrim(config.value), '') IS NOT NULL)
                 ORDER BY config.sort DESC, config.id DESC
               ) FILTER (WHERE config.id IS NOT NULL))[1], false) AS selected_value_present
        FROM requested
        LEFT JOIN system_config config
          ON config.is_store = 0 AND config.menu_name = requested.menu_name
        GROUP BY requested.menu_name
        ORDER BY requested.menu_name
      `;
      const indexes = await tx<Array<Record<string, unknown>>>`
        SELECT tablename, indexname, indexdef
        FROM pg_indexes
        WHERE schemaname = 'public'
          AND tablename IN ('store_product', 'store_service', 'store_service_feedback',
            'store_service_record', 'store_service_log')
        ORDER BY tablename, indexname
      `;
      return {
        state: state[0],
        config_presence: configs,
        relevant_indexes: indexes,
        guarantees: {
          transaction: "REPEATABLE READ, READ ONLY",
          pii_returned: false,
          config_values_returned: false,
          dml_or_ddl_executed: false,
        },
      };
    });
  } finally {
    await client.end({ timeout: 1 });
  }
}

export default {
  async fetch(request: Request, env: AuditEnv): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/audit") {
      return Response.json({ error: "not found" }, { status: 404 });
    }
    if (!(await authorize(request, env.AUDIT_TOKEN_SHA256))) {
      return Response.json({ error: "forbidden" }, { status: 403 });
    }
    try {
      return Response.json(await audit(env.HYPERDRIVE.connectionString), {
        headers: { "Cache-Control": "no-store" },
      });
    } catch (error) {
      console.error(JSON.stringify({
        event: "kefu_tourist_audit_failed",
        message: error instanceof Error ? error.message : String(error),
      }));
      return Response.json({ error: "audit failed" }, { status: 500 });
    }
  },
} satisfies ExportedHandler<AuditEnv>;
