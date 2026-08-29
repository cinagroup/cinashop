import postgres from "postgres";
import type { Env } from "../../src/env";
import { USER_CENTER_COMPATIBILITY_INDEX_SQL } from "../../src/migrations/userCenterCompatibility";
import { runUserCenterCompatibilityScenario } from "./UserCenterCompatibilityScenario";

interface AuditEnv extends Env {
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
    connection: { application_name: "cinashop_user_center_read_only_audit" },
  });
  try {
    return await client.begin(async (tx) => {
      await tx`SET LOCAL search_path TO public`;
      await tx`SET LOCAL statement_timeout = '30s'`;
      await tx`SET LOCAL lock_timeout = '2s'`;
      await tx`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`;

      const state = await tx<Array<Record<string, unknown>>>`
        WITH product_collect AS (
          SELECT relation_id AS product_id, count(*)::integer AS actual
          FROM user_relation
          WHERE type = 'collect' AND category = 'product'
          GROUP BY relation_id
        ), orphan_owners AS (
          SELECT address.uid, 'address'::text AS scope
          FROM user_address address
          WHERE address.is_del = 0 AND NOT EXISTS (
            SELECT 1 FROM "user" account
            WHERE account.uid = address.uid AND account.is_del = 0
          )
          UNION ALL
          SELECT relation.uid, 'relation'::text
          FROM user_relation relation
          WHERE NOT EXISTS (
            SELECT 1 FROM "user" account
            WHERE account.uid = relation.uid AND account.is_del = 0
          )
          UNION ALL
          SELECT sign.uid, 'sign'::text
          FROM user_sign sign
          WHERE NOT EXISTS (
            SELECT 1 FROM "user" account
            WHERE account.uid = sign.uid AND account.is_del = 0
          )
        )
        SELECT
          current_setting('server_version') AS server_version,
          current_setting('transaction_isolation') AS transaction_isolation,
          current_setting('transaction_read_only') AS transaction_read_only,

          (SELECT count(*)::integer FROM user_address) AS address_rows,
          (SELECT count(*)::integer FROM user_address WHERE is_del = 0) AS active_address_rows,
          (SELECT count(DISTINCT uid)::integer FROM user_address WHERE is_del = 0)
            AS active_address_owner_count,
          (SELECT count(*)::integer FROM user_address WHERE is_del = 0 AND is_default = 1)
            AS active_default_address_rows,
          (SELECT count(*)::integer FROM (
             SELECT uid FROM user_address WHERE is_del = 0
             GROUP BY uid HAVING count(*) FILTER (WHERE is_default = 1) > 1
           ) duplicate_defaults) AS users_with_multiple_active_defaults,
          (SELECT COALESCE(sum(defaults - 1), 0)::integer FROM (
             SELECT count(*) FILTER (WHERE is_default = 1)::integer AS defaults
             FROM user_address WHERE is_del = 0 GROUP BY uid
           ) grouped WHERE defaults > 1) AS excess_active_default_rows,
          (SELECT count(*)::integer FROM (
             SELECT uid FROM user_address WHERE is_del = 0
             GROUP BY uid HAVING count(*) FILTER (WHERE is_default = 1) = 0
           ) missing_defaults) AS users_with_addresses_but_no_default,
          (SELECT count(*)::integer FROM user_address address
             WHERE address.is_del = 0 AND NOT EXISTS (
               SELECT 1 FROM "user" account
               WHERE account.uid = address.uid AND account.is_del = 0
             )) AS active_address_owner_orphans,
          (SELECT count(DISTINCT address.uid)::integer FROM user_address address
             WHERE address.is_del = 0 AND NOT EXISTS (
               SELECT 1 FROM "user" account
               WHERE account.uid = address.uid AND account.is_del = 0
             )) AS distinct_orphan_address_owners,
          (SELECT count(*)::integer FROM user_address
             WHERE is_del = 0 AND (
               NULLIF(btrim(real_name), '') IS NULL
               OR NULLIF(btrim(phone), '') IS NULL
               OR NULLIF(btrim(province), '') IS NULL
               OR NULLIF(btrim(city), '') IS NULL
               OR NULLIF(btrim(district), '') IS NULL
               OR NULLIF(btrim(detail), '') IS NULL
             )) AS active_addresses_missing_required_fields,
          (SELECT count(*)::integer FROM user_address
             WHERE is_del = 0
               AND phone !~ '^(1[3-9][0-9]{9}|([0-9]{3,4}-)?[0-9]{7,8})$')
            AS active_addresses_with_invalid_phone_shape,
          (SELECT count(*)::integer FROM user_address
             WHERE is_del = 0 AND city_id <= 0) AS active_addresses_with_zero_city_id,
          (SELECT count(*)::integer FROM user_address address
             WHERE address.is_del = 0 AND address.city_id > 0
               AND NOT EXISTS (
                 SELECT 1 FROM city_area area WHERE area.id = address.city_id
               )) AS active_addresses_with_unknown_city_id,
          (SELECT count(*)::integer FROM user_address
             WHERE is_del = 0 AND (
               (NULLIF(btrim(longitude), '') IS NULL)
                 <> (NULLIF(btrim(latitude), '') IS NULL)
               OR CASE
                 WHEN NULLIF(btrim(longitude), '') IS NOT NULL
                   AND NULLIF(btrim(latitude), '') IS NOT NULL
                 THEN longitude !~ '^-?([0-9]+)([.][0-9]+)?$'
                   OR latitude !~ '^-?([0-9]+)([.][0-9]+)?$'
                 ELSE false
               END
             )) AS active_addresses_with_malformed_coordinates,

          (SELECT count(*)::integer FROM user_relation) AS relation_rows,
          (SELECT count(*)::integer FROM user_relation WHERE type = 'collect') AS collect_relation_rows,
          (SELECT count(*)::integer FROM user_relation
             WHERE type = 'collect' AND category = 'product') AS product_collect_relation_rows,
          (SELECT count(*)::integer FROM (
             SELECT uid, relation_id, type, category
             FROM user_relation
             GROUP BY uid, relation_id, type, category
             HAVING count(*) > 1
           ) duplicate_relations) AS duplicate_relation_groups,
          (SELECT COALESCE(sum(rows - 1), 0)::integer FROM (
             SELECT count(*)::integer AS rows
             FROM user_relation
             GROUP BY uid, relation_id, type, category
             HAVING count(*) > 1
           ) duplicate_relations) AS excess_relation_rows,
          (SELECT count(*)::integer FROM user_relation relation
             WHERE NOT EXISTS (
               SELECT 1 FROM "user" account
               WHERE account.uid = relation.uid AND account.is_del = 0
             )) AS relation_owner_orphans,
          (SELECT count(DISTINCT relation.uid)::integer FROM user_relation relation
             WHERE NOT EXISTS (
               SELECT 1 FROM "user" account
               WHERE account.uid = relation.uid AND account.is_del = 0
             )) AS distinct_orphan_relation_owners,
          (SELECT count(*)::integer FROM user_relation relation
             WHERE relation.type = 'collect' AND relation.category = 'product'
               AND NOT EXISTS (
                 SELECT 1 FROM store_product product WHERE product.id = relation.relation_id
               )) AS product_collect_relation_orphans,
          (SELECT count(*)::integer FROM user_relation relation
             WHERE relation.type = 'collect' AND relation.category = 'product'
               AND NOT EXISTS (
                 SELECT 1 FROM store_product_log log
                 WHERE log.type = 'collect'
                   AND log.uid = relation.uid
                   AND log.product_id = relation.relation_id
                   AND log.collect_num > 0
               )) AS current_product_collects_without_log,

          (SELECT count(*)::integer FROM user_sign) AS sign_rows,
          (SELECT count(*)::integer FROM (
             SELECT uid, ((add_time::bigint + 28800) / 86400) AS shanghai_day
             FROM user_sign
             GROUP BY uid, ((add_time::bigint + 28800) / 86400)
             HAVING count(*) > 1
           ) duplicate_signs) AS duplicate_shanghai_sign_day_groups,
          (SELECT COALESCE(sum(rows - 1), 0)::integer FROM (
             SELECT count(*)::integer AS rows
             FROM user_sign
             GROUP BY uid, ((add_time::bigint + 28800) / 86400)
             HAVING count(*) > 1
           ) duplicate_signs) AS excess_shanghai_sign_rows,
          (SELECT count(*)::integer FROM user_sign sign
             WHERE NOT EXISTS (
               SELECT 1 FROM "user" account
               WHERE account.uid = sign.uid AND account.is_del = 0
             )) AS sign_owner_orphans,
          (SELECT count(DISTINCT sign.uid)::integer FROM user_sign sign
             WHERE NOT EXISTS (
               SELECT 1 FROM "user" account
               WHERE account.uid = sign.uid AND account.is_del = 0
             )) AS distinct_orphan_sign_owners,
          (SELECT count(*)::integer FROM user_sign
             WHERE add_time <= 0 OR add_time > extract(epoch FROM now() + interval '1 day')::bigint)
            AS implausible_sign_timestamps,

          (SELECT count(*)::integer FROM store_product) AS product_rows,
          (SELECT count(*)::integer FROM store_product product
             LEFT JOIN product_collect actual ON actual.product_id = product.id
             WHERE product.collect <> COALESCE(actual.actual, 0)) AS product_collect_counter_drift_rows,
          (SELECT COALESCE(sum(collect), 0)::bigint FROM store_product)
            AS stored_product_collect_total,
          (SELECT count(*)::bigint FROM user_relation
             WHERE type = 'collect' AND category = 'product') AS actual_product_collect_total,
          (SELECT COALESCE(max(abs(product.collect - COALESCE(actual.actual, 0))), 0)::integer
             FROM store_product product
             LEFT JOIN product_collect actual ON actual.product_id = product.id)
            AS max_product_collect_counter_delta,
          (SELECT count(*)::integer FROM store_product_log WHERE type = 'collect') AS product_collect_log_rows,

          (SELECT count(*)::integer FROM city_area) AS city_area_rows,
          (SELECT count(*)::integer FROM city_area WHERE parent_id = 0) AS city_area_root_rows,
          (SELECT count(*)::integer FROM system_city) AS system_city_rows,
          (SELECT count(DISTINCT uid)::integer FROM orphan_owners) AS distinct_orphan_user_center_owners,
          (SELECT count(*)::integer FROM (
             SELECT uid FROM orphan_owners
             GROUP BY uid HAVING count(DISTINCT scope) = 3
           ) shared) AS orphan_owners_shared_by_address_relation_and_sign,

          (SELECT count(*)::integer FROM pg_namespace
             WHERE nspname LIKE 'codex\\_%' ESCAPE '\\'
                OR nspname LIKE 'audit\\_%' ESCAPE '\\') AS temporary_audit_schemas
      `;

      const config = await tx<Array<Record<string, unknown>>>`
        WITH requested(menu_name) AS (
          VALUES
            ('sign_mode'), ('sign_give_point'), ('sign_give_exp'),
            ('member_func_status'), ('member_card_status'), ('sign_remind'),
            ('sign_status'), ('sign_in_switch'), ('sign_in_integral'),
            ('sign_in_exp'), ('integral_effective_status'),
            ('integral_effective_time'), ('store_brokerage_statu')
        )
        SELECT requested.menu_name,
               count(config.id)::integer AS rows,
               count(config.id) FILTER (
                 WHERE NULLIF(btrim(config.value), '') IS NOT NULL
               )::integer AS nonempty_rows,
               (array_agg(config.value ORDER BY config.sort DESC, config.id DESC)
                 FILTER (WHERE config.id IS NOT NULL))[1] AS selected_value
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
          AND tablename IN (
            'user_address', 'user_relation', 'user_sign',
            'store_product', 'store_product_log', 'system_config'
          )
        ORDER BY tablename, indexname
      `;

      const constraints = await tx<Array<Record<string, unknown>>>`
        SELECT relation.relname AS table_name,
               database_constraint.conname AS constraint_name,
               database_constraint.contype AS constraint_type,
               pg_get_constraintdef(database_constraint.oid) AS definition
        FROM pg_constraint database_constraint
        JOIN pg_class relation ON relation.oid = database_constraint.conrelid
        JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = 'public'
          AND relation.relname IN ('user_address', 'user_relation', 'user_sign')
        ORDER BY relation.relname, database_constraint.conname
      `;

      return {
        state: state[0],
        sign_config: config,
        relevant_indexes: indexes,
        relevant_constraints: constraints,
        guarantees: {
          transaction: "REPEATABLE READ, READ ONLY",
          search_path: "public",
          pii_returned: false,
          secret_values_returned: false,
          dml_or_ddl_executed: false,
        },
      };
    });
  } finally {
    await client.end({ timeout: 1 });
  }
}

async function applyCompatibilityIndexes(connectionString: string) {
  const client = postgres(connectionString, {
    max: 1,
    prepare: false,
    connect_timeout: 10,
    idle_timeout: 5,
    connection: { application_name: "cinashop_user_center_index_migration" },
  });
  try {
    return await client.begin(async (tx) => {
      await tx`SET LOCAL search_path TO public`;
      await tx`SET LOCAL statement_timeout = '30s'`;
      await tx`SET LOCAL lock_timeout = '5s'`;
      await tx`SELECT pg_advisory_xact_lock(731625, 105)`;

      const before = await tx<Array<Record<string, unknown>>>`
        SELECT
          (SELECT count(*)::integer FROM user_address) AS address_rows,
          (SELECT count(*)::integer FROM user_relation) AS relation_rows,
          (SELECT count(*)::integer FROM user_sign) AS sign_rows,
          (SELECT md5(COALESCE(string_agg(
             id::text || ':' || uid::text || ':' || is_default::text || ':' || is_del::text,
             '|' ORDER BY id
           ), '')) FROM user_address) AS address_structural_fingerprint,
          (SELECT md5(COALESCE(string_agg(
             id::text || ':' || uid::text || ':' || relation_id::text || ':' || type || ':' || category,
             '|' ORDER BY id
           ), '')) FROM user_relation) AS relation_structural_fingerprint,
          (SELECT md5(COALESCE(string_agg(
             id::text || ':' || uid::text || ':' || add_time::text,
             '|' ORDER BY id
           ), '')) FROM user_sign) AS sign_structural_fingerprint,
          (SELECT count(*)::integer FROM (
             SELECT uid, relation_id, type, category
             FROM user_relation
             GROUP BY uid, relation_id, type, category
             HAVING count(*) > 1
           ) duplicates) AS duplicate_relation_groups
          ,(SELECT count(*)::integer FROM (
             SELECT uid, ((add_time::bigint + 28800) / 86400) AS shanghai_day
             FROM user_sign
             GROUP BY uid, ((add_time::bigint + 28800) / 86400)
             HAVING count(*) > 1
           ) duplicates) AS duplicate_sign_day_groups
      `;
      if (Number(before[0]?.duplicate_relation_groups ?? -1) !== 0) {
        throw new Error("duplicate user_relation rows block the unique index");
      }
      if (Number(before[0]?.duplicate_sign_day_groups ?? -1) !== 0) {
        throw new Error("duplicate Shanghai-day user_sign rows block the unique index");
      }

      await tx.unsafe(USER_CENTER_COMPATIBILITY_INDEX_SQL);

      const after = await tx<Array<Record<string, unknown>>>`
        SELECT
          (SELECT count(*)::integer FROM user_address) AS address_rows,
          (SELECT count(*)::integer FROM user_relation) AS relation_rows,
          (SELECT count(*)::integer FROM user_sign) AS sign_rows,
          (SELECT md5(COALESCE(string_agg(
             id::text || ':' || uid::text || ':' || is_default::text || ':' || is_del::text,
             '|' ORDER BY id
           ), '')) FROM user_address) AS address_structural_fingerprint,
          (SELECT md5(COALESCE(string_agg(
             id::text || ':' || uid::text || ':' || relation_id::text || ':' || type || ':' || category,
             '|' ORDER BY id
           ), '')) FROM user_relation) AS relation_structural_fingerprint,
          (SELECT md5(COALESCE(string_agg(
             id::text || ':' || uid::text || ':' || add_time::text,
             '|' ORDER BY id
           ), '')) FROM user_sign) AS sign_structural_fingerprint
      `;
      const indexes = await tx<Array<Record<string, unknown>>>`
        SELECT tablename, indexname, indexdef
        FROM pg_indexes
        WHERE schemaname = 'public'
          AND indexname IN (
            'ua_uid_idx', 'ur_uid_rel_type_cat_idx',
            'ur_uid_type_idx', 'ur_collect_category_relation_idx',
            'us_uid_time_idx', 'us_uid_shanghai_day_uq'
          )
        ORDER BY indexname
      `;
      if (JSON.stringify(before[0], Object.keys(before[0] ?? {}).filter(
        (key) => !key.startsWith("duplicate_"),
      ).sort()) !== JSON.stringify(after[0], Object.keys(after[0] ?? {}).sort())) {
        throw new Error("user-center rows changed while applying indexes");
      }
      if (indexes.length !== 6) throw new Error("user-center index verification failed");
      return {
        applied: true,
        before: before[0],
        after: after[0],
        indexes,
        guarantees: { dml_executed: false, business_rows_unchanged: true },
      };
    });
  } finally {
    await client.end({ timeout: 1 });
  }
}

export default {
  async fetch(request: Request, env: AuditEnv): Promise<Response> {
    const url = new URL(request.url);
    if (
      request.method !== "POST"
      || ![
        "/audit",
        "/apply-user-center-indexes",
        "/isolated-user-center",
      ].includes(url.pathname)
    ) {
      return Response.json({ error: "not found" }, { status: 404 });
    }
    if (!(await authorize(request, env.AUDIT_TOKEN_SHA256))) {
      return Response.json({ error: "forbidden" }, { status: 403 });
    }
    try {
      const result = url.pathname === "/apply-user-center-indexes"
        ? await applyCompatibilityIndexes(env.HYPERDRIVE.connectionString)
        : url.pathname === "/isolated-user-center"
          ? await runUserCenterCompatibilityScenario(env.HYPERDRIVE.connectionString, env)
          : await audit(env.HYPERDRIVE.connectionString);
      return Response.json(result, {
        headers: { "Cache-Control": "no-store" },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(JSON.stringify({
        event: "user_center_read_only_audit_failed",
        message: message.slice(0, 500),
      }));
      return Response.json({ error: "audit failed" }, { status: 500 });
    }
  },
} satisfies ExportedHandler<AuditEnv>;
