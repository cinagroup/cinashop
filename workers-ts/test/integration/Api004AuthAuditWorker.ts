import postgres from "postgres";

interface AuditEnv {
  HYPERDRIVE: Hyperdrive;
  AUDIT_TOKEN_SHA256: string;
}

async function authorize(request: Request, expected: string): Promise<boolean> {
  const supplied = request.headers.get("Authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (!supplied || !/^[a-f0-9]{64}$/i.test(expected)) return false;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(supplied));
  const actual = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  const [left, right] = await Promise.all([
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(actual)),
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(expected)),
  ]);
  return crypto.subtle.timingSafeEqual(left, right);
}

async function audit(connectionString: string) {
  const client = postgres(connectionString, {
    max: 1,
    prepare: false,
    connect_timeout: 10,
    idle_timeout: 5,
    connection: { application_name: "cinashop_api004_auth_read_only_audit" },
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
          (SELECT count(*)::integer FROM "user") AS user_rows,
          (SELECT count(*)::integer FROM "user" WHERE status = 1 AND is_del = 0) AS active_user_rows,
          (SELECT count(*)::integer FROM "user" WHERE status = 1 AND is_del = 0 AND phone = '') AS active_users_without_phone,
          (SELECT count(*)::integer FROM wechat_user) AS wechat_identity_rows,
          (SELECT count(*)::integer FROM wechat_user WHERE is_del = 0) AS active_wechat_identity_rows,
          (SELECT count(*)::integer FROM wechat_user WHERE is_del = 0 AND openid = '') AS active_blank_openids,
          (SELECT count(*)::integer FROM wechat_user identity
             WHERE NOT EXISTS (SELECT 1 FROM "user" account WHERE account.uid = identity.uid)) AS orphan_wechat_identities,
          (SELECT count(*)::integer FROM (
             SELECT openid FROM wechat_user WHERE is_del = 0 AND openid <> ''
             GROUP BY openid HAVING count(*) > 1
           ) duplicate_openids) AS duplicate_active_openids,
          (SELECT count(*)::integer FROM (
             SELECT unionid FROM wechat_user WHERE is_del = 0 AND unionid <> ''
             GROUP BY unionid HAVING count(DISTINCT uid) > 1
           ) split_unionids) AS unionids_linked_to_multiple_users,
          (SELECT count(*)::integer FROM sms_record) AS sms_record_rows,
          (SELECT count(*)::integer FROM sms_record WHERE resultcode = 100) AS successful_sms_rows,
          (SELECT count(*)::integer FROM pg_namespace WHERE nspname LIKE 'codex_api004_auth_%') AS temporary_schemas,
          (SELECT md5(COALESCE(string_agg(
             uid::text || ':' || status::text || ':' || is_del::text || ':' || md5(COALESCE(phone, '')),
             '|' ORDER BY uid
           ), '')) FROM "user") AS user_fingerprint,
          (SELECT md5(COALESCE(string_agg(
             id::text || ':' || uid::text || ':' || user_type || ':' || is_del::text || ':' || md5(openid),
             '|' ORDER BY id
           ), '')) FROM wechat_user) AS wechat_fingerprint,
          (SELECT md5(COALESCE(string_agg(
             id::text || ':' || uid || ':' || resultcode::text || ':' || add_time::text,
             '|' ORDER BY id
           ), '')) FROM sms_record) AS sms_fingerprint
      `;

      const channels = await tx<Array<Record<string, unknown>>>`
        SELECT user_type, count(*)::integer AS rows,
               count(*) FILTER (WHERE is_del = 0)::integer AS active_rows
        FROM wechat_user
        GROUP BY user_type
        ORDER BY user_type
      `;

      const configs = await tx<Array<Record<string, unknown>>>`
        WITH requested(menu_name) AS (
          VALUES
            ('routine_appId'), ('routine_appsecret'),
            ('wechat_appid'), ('wechat_appsecret'),
            ('store_user_mobile'), ('store_user_avatar'),
            ('verify_expire_time')
        )
        SELECT requested.menu_name,
               count(config.id)::integer AS rows,
               count(config.id) FILTER (WHERE NULLIF(btrim(config.value), '') IS NOT NULL)::integer AS nonempty_rows,
               COALESCE((array_agg(
                 (NULLIF(btrim(config.value), '') IS NOT NULL)
                 ORDER BY config.sort DESC, config.id DESC
               ) FILTER (WHERE config.id IS NOT NULL))[1], false) AS selected_value_present,
               count(DISTINCT config.value) FILTER (WHERE NULLIF(btrim(config.value), '') IS NOT NULL)::integer
                 AS distinct_nonempty_values
        FROM requested
        LEFT JOIN system_config config
          ON config.is_store = 0 AND config.menu_name = requested.menu_name
        GROUP BY requested.menu_name
        ORDER BY requested.menu_name
      `;

      const configCandidates = await tx<Array<Record<string, unknown>>>`
        SELECT menu_name, count(*)::integer AS rows,
               bool_or(NULLIF(btrim(value), '') IS NOT NULL) AS any_value_present
        FROM system_config
        WHERE is_store = 0 AND (
          lower(menu_name) LIKE '%routine%appid%'
          OR lower(menu_name) LIKE '%routine%secret%'
          OR lower(menu_name) LIKE '%wechat%appid%'
          OR lower(menu_name) LIKE '%wechat%secret%'
          OR lower(menu_name) LIKE '%sms%'
          OR lower(menu_name) LIKE '%turnstile%'
        )
        GROUP BY menu_name
        ORDER BY menu_name
      `;

      const notification = await tx<Array<Record<string, unknown>>>`
        SELECT count(*)::integer AS rows,
               bool_or(is_sms = 1 AND NULLIF(btrim(sms_id), '') IS NOT NULL) AS usable_template_present
        FROM system_notification
        WHERE mark = 'VERIFICATION_CODE_TIME'
      `;

      const indexes = await tx<Array<Record<string, unknown>>>`
        SELECT indexname, indexdef
        FROM pg_indexes
        WHERE schemaname = 'public' AND tablename IN ('wechat_user', 'sms_record')
        ORDER BY tablename, indexname
      `;

      return {
        state: state[0],
        wechat_channels: channels,
        config_presence: configs,
        auth_config_candidate_names: configCandidates,
        sms_template: notification[0],
        relevant_indexes: indexes,
        guarantees: {
          transaction: "REPEATABLE READ, READ ONLY",
          secret_values_returned: false,
          pii_returned: false,
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
        event: "api004_auth_audit_failed",
        message: error instanceof Error ? error.message : String(error),
      }));
      return Response.json({ error: "audit failed" }, { status: 500 });
    }
  },
} satisfies ExportedHandler<AuditEnv>;
