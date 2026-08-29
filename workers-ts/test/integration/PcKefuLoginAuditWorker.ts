import postgres from "postgres";

interface AuditEnv {
  HYPERDRIVE: Hyperdrive;
  AUDIT_TOKEN_SHA256: string;
}

async function authorize(request: Request, expected: string): Promise<boolean> {
  const supplied = request.headers.get("Authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (!supplied || !/^[a-f0-9]{64}$/i.test(expected)) return false;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(supplied));
  const actual = Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
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
    connection: { application_name: "cinashop_pc_kefu_login_read_only_audit" },
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
          (SELECT count(*)::integer FROM "user" WHERE is_del = 0 AND status = 1) AS active_user_rows,
          (SELECT count(*)::integer FROM "user" WHERE is_del = 0 AND NULLIF(btrim(uniqid), '') IS NOT NULL)
            AS users_with_legacy_scan_key,
          (SELECT count(*)::integer FROM wechat_user) AS wechat_identity_rows,
          (SELECT count(*)::integer FROM wechat_user WHERE is_del = 0) AS active_wechat_identity_rows,
          (SELECT count(*)::integer FROM wechat_user
             WHERE is_del = 0 AND NULLIF(btrim(unionid), '') IS NOT NULL) AS active_unionid_rows,
          (SELECT count(*)::integer FROM wechat_user WHERE is_del = 0 AND user_type = 'pc') AS active_pc_identity_rows,
          (SELECT count(*)::integer FROM wechat_user identity
             WHERE identity.is_del = 0
               AND NOT EXISTS (SELECT 1 FROM "user" account WHERE account.uid = identity.uid AND account.is_del = 0))
            AS orphan_active_wechat_identities,
          (SELECT count(*)::integer FROM (
             SELECT unionid FROM wechat_user
             WHERE is_del = 0 AND NULLIF(btrim(unionid), '') IS NOT NULL
             GROUP BY unionid HAVING count(DISTINCT uid) > 1
           ) split) AS unionids_linked_to_multiple_users,
          (SELECT count(*)::integer FROM store_service) AS kefu_rows,
          (SELECT count(*)::integer FROM store_service
             WHERE is_del = 0 AND status = 1 AND account_status = 1) AS active_kefu_rows,
          (SELECT count(*)::integer FROM store_service
             WHERE is_del = 0 AND status = 1 AND account_status = 1 AND uid <= 0) AS active_kefu_without_uid,
          (SELECT count(*)::integer FROM store_service service
             WHERE service.is_del = 0 AND service.status = 1 AND service.account_status = 1
               AND NOT EXISTS (SELECT 1 FROM "user" account
                 WHERE account.uid = service.uid AND account.is_del = 0 AND account.status = 1))
            AS active_kefu_without_active_user,
          (SELECT count(*)::integer FROM store_service
             WHERE is_del = 0 AND NULLIF(btrim(uniqid), '') IS NOT NULL) AS kefu_with_legacy_scan_key,
          (SELECT count(*)::integer FROM (
             SELECT uid FROM store_service
             WHERE is_del = 0 AND status = 1 AND account_status = 1 AND uid > 0
             GROUP BY uid HAVING count(*) > 1
           ) duplicate) AS users_linked_to_multiple_active_kefu,
          (SELECT count(*)::integer FROM store_service service
             WHERE service.is_del = 0 AND service.status = 1 AND service.account_status = 1
               AND EXISTS (SELECT 1 FROM wechat_user identity
                 WHERE identity.uid = service.uid AND identity.is_del = 0
                   AND NULLIF(btrim(identity.unionid), '') IS NOT NULL))
            AS active_kefu_with_unionid,
          (SELECT count(*)::integer FROM (
             SELECT identity.unionid
             FROM wechat_user identity
             JOIN store_service service ON service.uid = identity.uid
               AND service.is_del = 0 AND service.status = 1 AND service.account_status = 1
             WHERE identity.is_del = 0 AND NULLIF(btrim(identity.unionid), '') IS NOT NULL
             GROUP BY identity.unionid HAVING count(DISTINCT service.id) > 1
           ) ambiguous) AS unionids_linked_to_multiple_active_kefu,
          (SELECT count(*)::integer FROM pg_namespace WHERE nspname LIKE 'codex_%') AS temporary_schemas,
          (SELECT md5(COALESCE(string_agg(
             uid::text || ':' || status::text || ':' || is_del::text || ':'
               || (NULLIF(btrim(uniqid), '') IS NOT NULL)::text,
             '|' ORDER BY uid
           ), '')) FROM "user") AS user_fingerprint,
          (SELECT md5(COALESCE(string_agg(
             id::text || ':' || uid::text || ':' || user_type || ':' || is_del::text || ':'
               || (NULLIF(btrim(unionid), '') IS NOT NULL)::text,
             '|' ORDER BY id
           ), '')) FROM wechat_user) AS wechat_fingerprint,
          (SELECT md5(COALESCE(string_agg(
             id::text || ':' || uid::text || ':' || status::text || ':' || account_status::text || ':'
               || is_del::text || ':' || (NULLIF(btrim(uniqid), '') IS NOT NULL)::text,
             '|' ORDER BY id
           ), '')) FROM store_service) AS kefu_fingerprint
      `;

      const configs = await tx<Array<Record<string, unknown>>>`
        WITH requested(menu_name) AS (
          VALUES ('wechat_open_app_id'), ('wechat_open_app_secret'), ('site_name')
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

      const channels = await tx<Array<Record<string, unknown>>>`
        SELECT user_type, count(*)::integer AS rows,
               count(*) FILTER (WHERE is_del = 0)::integer AS active_rows,
               count(*) FILTER (
                 WHERE is_del = 0 AND NULLIF(btrim(unionid), '') IS NOT NULL
               )::integer AS active_unionid_rows
        FROM wechat_user
        GROUP BY user_type
        ORDER BY user_type
      `;

      const indexes = await tx<Array<Record<string, unknown>>>`
        SELECT tablename, indexname, indexdef
        FROM pg_indexes
        WHERE schemaname = 'public'
          AND tablename IN ('user', 'wechat_user', 'store_service', 'system_config')
        ORDER BY tablename, indexname
      `;

      return {
        state: state[0],
        config_presence: configs,
        wechat_channels: channels,
        relevant_indexes: indexes,
        guarantees: {
          transaction: "REPEATABLE READ, READ ONLY",
          secret_values_returned: false,
          pii_returned: false,
          dml_or_ddl_executed: false,
        },
      };
    });
  } finally {
    await client.end({ timeout: 1 });
  }
}

async function applySystemConfigIndex(connectionString: string) {
  const client = postgres(connectionString, {
    max: 1,
    prepare: false,
    connect_timeout: 10,
    idle_timeout: 5,
    connection: { application_name: "cinashop_pc_kefu_login_index_apply" },
  });
  try {
    return await client.begin(async (tx) => {
      await tx`SET LOCAL search_path TO public`;
      await tx`SET LOCAL statement_timeout = '30s'`;
      await tx`SET LOCAL lock_timeout = '5s'`;
      const before = await tx<Array<Record<string, unknown>>>`
        SELECT count(*)::integer AS rows,
               md5(COALESCE(string_agg(
                 id::text || ':' || is_store::text || ':' || menu_name || ':' || sort::text || ':'
                   || status::text || ':' || length(value)::text,
                 '|' ORDER BY id
               ), '')) AS structural_fingerprint
        FROM system_config
      `;
      await tx.unsafe(`CREATE INDEX IF NOT EXISTS "system_config_lookup"
        ON public."system_config" ("is_store", "menu_name", "sort" DESC, "id" DESC)`);
      const after = await tx<Array<Record<string, unknown>>>`
        SELECT count(*)::integer AS rows,
               md5(COALESCE(string_agg(
                 id::text || ':' || is_store::text || ':' || menu_name || ':' || sort::text || ':'
                   || status::text || ':' || length(value)::text,
                 '|' ORDER BY id
               ), '')) AS structural_fingerprint
        FROM system_config
      `;
      const indexes = await tx<Array<Record<string, unknown>>>`
        SELECT indexname, indexdef
        FROM pg_indexes
        WHERE schemaname = 'public' AND tablename = 'system_config'
          AND indexname = 'system_config_lookup'
      `;
      if (
        !before[0]
        || !after[0]
        || before[0].rows !== after[0].rows
        || before[0].structural_fingerprint !== after[0].structural_fingerprint
        || indexes.length !== 1
      ) throw new Error("system_config index verification failed");
      return {
        applied: true,
        before: before[0],
        after: after[0],
        index: indexes[0],
        guarantees: { dml_executed: false, row_values_returned: false },
      };
    });
  } finally {
    await client.end({ timeout: 1 });
  }
}

export default {
  async fetch(request: Request, env: AuditEnv): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "POST" || !["/audit", "/apply-system-config-index"].includes(url.pathname)) {
      return Response.json({ error: "not found" }, { status: 404 });
    }
    if (!(await authorize(request, env.AUDIT_TOKEN_SHA256))) {
      return Response.json({ error: "forbidden" }, { status: 403 });
    }
    try {
      const result = url.pathname === "/apply-system-config-index"
        ? await applySystemConfigIndex(env.HYPERDRIVE.connectionString)
        : await audit(env.HYPERDRIVE.connectionString);
      return Response.json(result, {
        headers: { "Cache-Control": "no-store" },
      });
    } catch (error) {
      console.error(JSON.stringify({
        event: "pc_kefu_login_audit_failed",
        message: error instanceof Error ? error.message : String(error),
      }));
      return Response.json({ error: "audit failed" }, { status: 500 });
    }
  },
} satisfies ExportedHandler<AuditEnv>;
