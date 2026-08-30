import postgres from "postgres";
import { createDbFromConnectionString, type DbClient } from "@/lib/di";
import {
  runStoreMobileDeliveryCompatibilityScenario,
  STORE_MOBILE_DELIVERY_SCHEMA_PREFIX,
  STORE_MOBILE_DELIVERY_TABLES,
} from "./StoreMobileDeliveryCompatibilityScenario";

interface AuditEnv {
  HYPERDRIVE: Hyperdrive;
  AUDIT_READ_TOKEN_SHA256: string;
  AUDIT_INDEX_TOKEN_SHA256: string;
  AUDIT_ISOLATED_TOKEN_SHA256: string;
}

const TARGET_INDEX_DDL = `CREATE INDEX IF NOT EXISTS "so_delivery_mobile_active"
  ON public."store_order" ("delivery_uid", "status", "add_time" DESC, "id" DESC)
  WHERE "delivery_uid" > 0 AND "paid" = 1 AND "is_del" = 0
    AND "is_system_del" = 0 AND "refund_status" IN (0, 3)`;

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`STORE-A production audit failed: ${message}`);
}

function decodeSha256(value: string): Uint8Array | null {
  if (!/^[a-f0-9]{64}$/i.test(value)) return null;
  const bytes = new Uint8Array(32);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

async function authorized(request: Request, expectedHex: string): Promise<boolean> {
  const expected = decodeSha256(expectedHex);
  if (!expected) return false;
  const supplied = request.headers.get("Authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const actual = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(supplied));
  return crypto.subtle.timingSafeEqual(actual, expected);
}

async function indexState(db: DbClient) {
  const rows = await db.$client<Array<{
    target_index_exists: boolean;
    target_index_valid: boolean;
    delivery_service_index_count: number;
    store_staff_index_count: number;
    store_order_index_count: number;
    cart_order_index_ready: boolean;
  }>>`
    SELECT
      EXISTS (
        SELECT 1 FROM pg_class AS index_relation
        JOIN pg_namespace AS namespace ON namespace.oid = index_relation.relnamespace
        WHERE namespace.nspname = 'public'
          AND index_relation.relname = 'so_delivery_mobile_active'
      ) AS target_index_exists,
      EXISTS (
        SELECT 1
        FROM pg_index AS indexed
        JOIN pg_class AS index_relation ON index_relation.oid = indexed.indexrelid
        JOIN pg_class AS table_relation ON table_relation.oid = indexed.indrelid
        JOIN pg_namespace AS namespace ON namespace.oid = table_relation.relnamespace
        JOIN pg_am AS access_method ON access_method.oid = index_relation.relam
        WHERE namespace.nspname = 'public'
          AND table_relation.relname = 'store_order'
          AND index_relation.relname = 'so_delivery_mobile_active'
          AND index_relation.relkind = 'i'
          AND NOT indexed.indisunique
          AND NOT indexed.indisprimary
          AND NOT indexed.indisexclusion
          AND indexed.indimmediate
          AND NOT indexed.indisclustered
          AND NOT indexed.indisreplident
          AND indexed.indisvalid AND indexed.indisready AND indexed.indislive
          AND NOT indexed.indcheckxmin
          AND NOT indexed.indnullsnotdistinct
          AND access_method.amname = 'btree'
          AND indexed.indnatts = indexed.indnkeyatts
          AND indexed.indexprs IS NULL
          AND index_relation.reloptions IS NULL
          AND NOT EXISTS (SELECT 1 FROM pg_constraint attached WHERE attached.conindid = indexed.indexrelid)
          AND ARRAY(
            SELECT pg_get_indexdef(indexed.indexrelid, position, true)
            FROM generate_series(1, indexed.indnkeyatts) AS position ORDER BY position
          ) = ARRAY['delivery_uid', 'status', 'add_time', 'id']::text[]
          AND ARRAY(
            SELECT indexed.indoption[position]
            FROM generate_series(0, indexed.indnkeyatts - 1) AS position ORDER BY position
          )::smallint[] = ARRAY[0, 0, 3, 3]::smallint[]
          AND replace(replace(replace(replace(
            COALESCE(pg_get_expr(indexed.indpred, indexed.indrelid, true), ''),
            '(', ''), ')', ''), ' ', ''), '"', '')
            = 'delivery_uid>0ANDpaid=1ANDis_del=0ANDis_system_del=0ANDrefund_status=ANYARRAY[0,3]'
      ) AS target_index_valid,
      (SELECT count(*)::int FROM pg_indexes WHERE schemaname = 'public'
        AND tablename = 'delivery_service') AS delivery_service_index_count,
      (SELECT count(*)::int FROM pg_indexes WHERE schemaname = 'public'
        AND tablename = 'system_store_staff') AS store_staff_index_count,
      (SELECT count(*)::int FROM pg_indexes WHERE schemaname = 'public'
        AND tablename = 'store_order') AS store_order_index_count,
      EXISTS (
        SELECT 1 FROM pg_index AS indexed
        JOIN pg_class AS table_relation ON table_relation.oid = indexed.indrelid
        JOIN pg_namespace AS namespace ON namespace.oid = table_relation.relnamespace
        WHERE namespace.nspname = 'public'
          AND table_relation.relname = 'store_order_cart_info'
          AND indexed.indisvalid AND indexed.indisready
          AND pg_get_indexdef(indexed.indexrelid, 1, true) = 'oid'
      ) AS cart_order_index_ready
  `;
  invariant(rows[0], "index state query returned no row");
  return rows[0];
}

async function businessFingerprint(db: DbClient) {
  const rows = await db.$client<Array<Record<string, string | null>>>`
    SELECT
      (SELECT count(*)::text FROM public.store_order) AS order_count,
      (SELECT max(id)::text FROM public.store_order) AS order_max_id,
      (SELECT md5(COALESCE(sum(hashtextextended(to_jsonb(source)::text, 0)::numeric)::text, ''))
        FROM public.store_order AS source) AS order_digest,
      (SELECT count(*)::text FROM public.delivery_service) AS delivery_count,
      (SELECT max(id)::text FROM public.delivery_service) AS delivery_max_id,
      (SELECT count(*)::text FROM public.system_store_staff) AS staff_count,
      (SELECT max(id)::text FROM public.system_store_staff) AS staff_max_id,
      (SELECT last_value::text FROM public.store_order_id_seq) AS order_sequence
  `;
  invariant(rows[0], "business fingerprint returned no row");
  return rows[0];
}

async function applyIndex(connectionString: string) {
  const db = createDbFromConnectionString(connectionString, 1, {
    applicationName: "cinashop_store_mobile_delivery_index_upgrade",
  });
  try {
    const before = await indexState(db);
    if (before.target_index_exists && !before.target_index_valid) {
      throw new Error("conflicting so_delivery_mobile_active definition exists");
    }
    const businessBefore = await businessFingerprint(db);
    await db.$client.begin(async (tx) => {
      await tx`SET LOCAL search_path TO public, pg_temp`;
      await tx`SET LOCAL lock_timeout = '5s'`;
      await tx`SET LOCAL statement_timeout = '45s'`;
      await tx.unsafe(TARGET_INDEX_DDL);
    });
    const [after, businessAfter] = await Promise.all([indexState(db), businessFingerprint(db)]);
    invariant(after.target_index_valid, "target delivery index verification failed");
    const unchanged = JSON.stringify(businessBefore) === JSON.stringify(businessAfter);
    invariant(unchanged, "business rows or sequence changed while applying delivery index");
    return {
      before,
      after,
      business_rows_and_sequence_unchanged: unchanged,
      guarantees: {
        only_target_index_ddl_executed: true,
        business_dml_executed: false,
        fingerprints_returned: false,
        business_ids_returned: false,
      },
    };
  } finally {
    await db.$client.end({ timeout: 2 });
  }
}

async function productionAggregates(connectionString: string) {
  const client = postgres(connectionString, {
    max: 1,
    prepare: false,
    connect_timeout: 10,
    idle_timeout: 5,
    connection: { application_name: "cinashop_store_mobile_delivery_read_only_audit" },
  });
  try {
    return await client.begin(async (tx) => {
      await tx`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`;
      await tx`SET LOCAL search_path TO public, pg_temp`;
      await tx`SET LOCAL statement_timeout = '45s'`;
      await tx`SET LOCAL lock_timeout = '2s'`;
      const catalogRows = await tx<Array<{ table_name: string }>>`
        SELECT relation.relname AS table_name
        FROM pg_class AS relation
        JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = 'public'
          AND relation.relkind IN ('r', 'p')
          AND relation.relname IN ${tx(STORE_MOBILE_DELIVERY_TABLES)}
        ORDER BY relation.relname
      `;
      const present = new Set(catalogRows.map((row) => row.table_name));
      const missingTables = STORE_MOBILE_DELIVERY_TABLES.filter((table) => !present.has(table));
      const tempRows = await tx<Array<{ count: number }>>`
        SELECT count(*)::integer AS count FROM pg_namespace
        WHERE starts_with(nspname, ${STORE_MOBILE_DELIVERY_SCHEMA_PREFIX})
      `;
      const catalog = {
        expected_table_count: STORE_MOBILE_DELIVERY_TABLES.length,
        present_table_count: STORE_MOBILE_DELIVERY_TABLES.length - missingTables.length,
        missing_tables: missingTables,
        temporary_schema_count: Number(tempRows[0]?.count ?? -1),
      };
      if (missingTables.length) return { complete: false, catalog, data_audit_skipped: true };

      const resolutionRows = await tx<Array<{
        schema_name: string;
        configured_path: string;
        resolved_schema: string | null;
        server_version: string;
      }>>`
        SELECT current_schema() AS schema_name,
          current_setting('search_path') AS configured_path,
          current_setting('server_version') AS server_version,
          (SELECT namespace.nspname FROM pg_class AS relation
            JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
            WHERE relation.oid = to_regclass('delivery_service')) AS resolved_schema
      `;
      const resolution = resolutionRows[0];
      invariant(
        resolution?.schema_name === "public"
          && resolution.configured_path === "public, pg_temp"
          && resolution.resolved_schema === "public",
        "read-only audit was not pinned to public, pg_temp",
      );

      const deliveryRows = await tx<Array<Record<string, unknown>>>`
        WITH duplicate_platform AS (
          SELECT uid FROM delivery_service
          WHERE type = 0 AND relation_id = 0 AND status = 1 AND is_del = 0
          GROUP BY uid HAVING count(*) > 1
        ), duplicate_store_scope AS (
          SELECT uid, relation_id FROM delivery_service
          WHERE type = 1 AND status = 1 AND is_del = 0
          GROUP BY uid, relation_id HAVING count(*) > 1
        )
        SELECT count(*)::int AS total_rows,
          count(*) FILTER (WHERE delivery.status = 1 AND delivery.is_del = 0)::int AS active_rows,
          count(*) FILTER (WHERE delivery.type = 0 AND delivery.relation_id = 0
            AND delivery.status = 1 AND delivery.is_del = 0)::int AS active_platform_rows,
          count(*) FILTER (WHERE delivery.type = 1 AND delivery.status = 1 AND delivery.is_del = 0)::int
            AS active_store_rows,
          count(*) FILTER (WHERE owner.uid IS NULL)::int AS owner_orphan_rows,
          count(*) FILTER (WHERE delivery.type = 1 AND store.id IS NULL)::int AS store_orphan_rows,
          (SELECT count(*)::int FROM duplicate_platform) AS duplicate_active_platform_groups,
          (SELECT count(*)::int FROM duplicate_store_scope) AS duplicate_active_store_scope_groups
        FROM delivery_service AS delivery
        LEFT JOIN "user" AS owner ON owner.uid = delivery.uid
        LEFT JOIN system_store AS store ON delivery.type = 1 AND store.id = delivery.relation_id
      `;
      const staffRows = await tx<Array<Record<string, unknown>>>`
        WITH duplicate_staff AS (
          SELECT uid FROM system_store_staff WHERE status = 1 AND is_del = 0
          GROUP BY uid HAVING count(*) > 1
        )
        SELECT count(*)::int AS total_rows,
          count(*) FILTER (WHERE staff.status = 1 AND staff.is_del = 0)::int AS active_rows,
          count(*) FILTER (WHERE owner.uid IS NULL)::int AS owner_orphan_rows,
          count(*) FILTER (WHERE store.id IS NULL)::int AS store_orphan_rows,
          count(*) FILTER (WHERE staff.status = 1 AND staff.is_del = 0
            AND owner.status = 1 AND owner.is_del = 0
            AND store.is_show = 1 AND store.is_del = 0)::int AS active_authorizable_rows,
          (SELECT count(*)::int FROM duplicate_staff) AS duplicate_active_uid_groups
        FROM system_store_staff AS staff
        LEFT JOIN "user" AS owner ON owner.uid = staff.uid
        LEFT JOIN system_store AS store ON store.id = staff.store_id
      `;
      const orderRows = await tx<Array<Record<string, unknown>>>`
        SELECT count(*) FILTER (WHERE orders.delivery_uid > 0)::int AS assigned_rows,
          count(*) FILTER (WHERE orders.delivery_uid > 0 AND orders.paid = 1
            AND orders.is_del = 0 AND orders.is_system_del = 0
            AND orders.refund_status IN (0, 3))::int AS active_assigned_rows,
          count(*) FILTER (WHERE orders.delivery_uid > 0 AND orders.paid = 1
            AND orders.is_del = 0 AND orders.is_system_del = 0
            AND orders.refund_status IN (0, 3) AND orders.status = 2)::int AS unsent_rows,
          count(*) FILTER (WHERE orders.delivery_uid > 0 AND orders.paid = 1
            AND orders.is_del = 0 AND orders.is_system_del = 0
            AND orders.refund_status IN (0, 3) AND orders.status = 9)::int AS sent_rows,
          count(*) FILTER (WHERE orders.delivery_uid > 0 AND NOT EXISTS (
            SELECT 1 FROM delivery_service AS delivery
            WHERE delivery.uid = orders.delivery_uid AND delivery.status = 1 AND delivery.is_del = 0
          ))::int AS active_delivery_orphan_rows
        FROM store_order AS orders
      `;
      const indexRows = await tx<Array<Record<string, unknown>>>`
        SELECT
          (SELECT count(*)::int FROM pg_indexes WHERE schemaname = 'public'
            AND tablename = 'delivery_service') AS delivery_service_index_count,
          (SELECT count(*)::int FROM pg_indexes WHERE schemaname = 'public'
            AND tablename = 'system_store_staff') AS store_staff_index_count,
          (SELECT count(*)::int FROM pg_indexes WHERE schemaname = 'public'
            AND tablename = 'store_order') AS store_order_index_count,
          EXISTS (
            SELECT 1 FROM pg_index AS indexed
            JOIN pg_class AS table_relation ON table_relation.oid = indexed.indrelid
            JOIN pg_namespace AS namespace ON namespace.oid = table_relation.relnamespace
            WHERE namespace.nspname = 'public'
              AND table_relation.relname = 'store_order_cart_info'
              AND indexed.indisvalid AND indexed.indisready
              AND pg_get_indexdef(indexed.indexrelid, 1, true) = 'oid'
          ) AS cart_order_index_ready,
          EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public'
            AND tablename = 'store_order' AND indexname = 'so_delivery_mobile_active') AS target_index_exists
      `;
      return {
        complete: true,
        server_version: resolution.server_version,
        catalog,
        delivery_identities: deliveryRows[0] ?? {},
        store_staff: staffRows[0] ?? {},
        assigned_orders: orderRows[0] ?? {},
        index_aggregates: indexRows[0] ?? {},
        guarantees: {
          transaction: "REPEATABLE READ, READ ONLY",
          search_path: "public, pg_temp (pg_temp last)",
          names_phones_addresses_or_snapshots_returned: false,
          user_or_business_ids_returned: false,
          fingerprints_returned: false,
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
    const hashes = [
      env.AUDIT_READ_TOKEN_SHA256 ?? "",
      env.AUDIT_INDEX_TOKEN_SHA256 ?? "",
      env.AUDIT_ISOLATED_TOKEN_SHA256 ?? "",
    ];
    if (request.method !== "POST"
      || !["/audit", "/apply-index", "/isolated-scenario"].includes(url.pathname)) {
      return Response.json({ error: "not found" }, { status: 404 });
    }
    if (hashes.some((value) => !decodeSha256(value)) || new Set(hashes.map((value) => value.toLowerCase())).size !== 3) {
      return Response.json(
        { error: "audit unavailable" },
        { status: 503, headers: { "Cache-Control": "private, no-store" } },
      );
    }
    const expectedHash = url.pathname === "/audit"
      ? hashes[0]
      : url.pathname === "/apply-index" ? hashes[1] : hashes[2];
    if (!(await authorized(request, expectedHash))) {
      return Response.json({ error: "forbidden" }, { status: 403 });
    }
    try {
      const result = url.pathname === "/audit"
        ? await productionAggregates(env.HYPERDRIVE.connectionString)
        : url.pathname === "/apply-index"
          ? await applyIndex(env.HYPERDRIVE.connectionString)
          : await runStoreMobileDeliveryCompatibilityScenario(env.HYPERDRIVE.connectionString);
      return Response.json(result, { headers: { "Cache-Control": "private, no-store" } });
    } catch (error) {
      console.error(JSON.stringify({
        event: "store_mobile_delivery_audit_failed",
        path: url.pathname,
        error: error instanceof Error ? error.message : String(error),
      }));
      return Response.json(
        { error: "audit failed" },
        { status: 500, headers: { "Cache-Control": "private, no-store" } },
      );
    }
  },
} satisfies ExportedHandler<AuditEnv>;
