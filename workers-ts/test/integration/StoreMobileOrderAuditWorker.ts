import postgres from "postgres";
import {
  runStoreMobileOrderCompatibilityScenario,
  STORE_MOBILE_ORDER_SCHEMA_PREFIX,
  STORE_MOBILE_ORDER_TABLES,
} from "./StoreMobileOrderCompatibilityScenario";

interface AuditEnv {
  HYPERDRIVE: Hyperdrive;
  AUDIT_READ_TOKEN_SHA256: string;
  AUDIT_ISOLATED_TOKEN_SHA256: string;
}

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`STORE-B production audit failed: ${message}`);
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

async function productionAggregates(connectionString: string) {
  const client = postgres(connectionString, {
    max: 1,
    prepare: false,
    connect_timeout: 10,
    idle_timeout: 5,
    connection: { application_name: "cinashop_store_mobile_order_read_only_audit" },
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
          AND relation.relname IN ${tx(STORE_MOBILE_ORDER_TABLES)}
        ORDER BY relation.relname
      `;
      const present = new Set(catalogRows.map((row) => row.table_name));
      const missingTables = STORE_MOBILE_ORDER_TABLES.filter((table) => !present.has(table));
      const tempRows = await tx<Array<{ count: number }>>`
        SELECT count(*)::integer AS count FROM pg_namespace
        WHERE starts_with(nspname, ${STORE_MOBILE_ORDER_SCHEMA_PREFIX})
      `;
      const catalog = {
        expected_table_count: STORE_MOBILE_ORDER_TABLES.length,
        present_table_count: STORE_MOBILE_ORDER_TABLES.length - missingTables.length,
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
            WHERE relation.oid = to_regclass('store_order')) AS resolved_schema
      `;
      const resolution = resolutionRows[0];
      invariant(
        resolution?.schema_name === "public"
          && resolution.configured_path === "public, pg_temp"
          && resolution.resolved_schema === "public",
        "read-only audit was not pinned to public, pg_temp",
      );

      const staffRows = await tx<Array<Record<string, unknown>>>`
        WITH duplicate_staff AS (
          SELECT uid FROM system_store_staff
          WHERE status = 1 AND verify_status = 1 AND is_del = 0
          GROUP BY uid HAVING count(*) > 1
        )
        SELECT count(*)::int AS total_rows,
          count(*) FILTER (WHERE staff.status = 1 AND staff.verify_status = 1 AND staff.is_del = 0)::int
            AS active_verified_rows,
          count(*) FILTER (WHERE staff.status = 1 AND staff.verify_status = 1 AND staff.is_del = 0
            AND owner.status = 1 AND owner.is_del = 0
            AND store.is_store = 1 AND store.is_show = 1 AND store.is_del = 0)::int
            AS authorizable_rows,
          count(*) FILTER (WHERE owner.uid IS NULL)::int AS owner_orphan_rows,
          count(*) FILTER (WHERE store.id IS NULL)::int AS store_orphan_rows,
          (SELECT count(*)::int FROM duplicate_staff) AS duplicate_active_uid_groups
        FROM system_store_staff AS staff
        LEFT JOIN "user" AS owner ON owner.uid = staff.uid
        LEFT JOIN system_store AS store ON store.id = staff.store_id
      `;
      const orderRows = await tx<Array<Record<string, unknown>>>`
        WITH duplicate_verify AS (
          SELECT verify_code FROM store_order
          WHERE verify_code <> '' AND paid = 1 AND status IN (0, 1, 5)
            AND refund_status IN (0, 3) AND is_del = 0 AND is_system_del = 0
          GROUP BY verify_code HAVING count(*) > 1
        ), duplicate_public_id AS (
          SELECT order_id FROM store_order GROUP BY order_id HAVING count(*) > 1
        )
        SELECT count(*) FILTER (WHERE store_id > 0 AND is_system_del = 0)::int AS store_scoped_rows,
          count(*) FILTER (WHERE store_id > 0 AND paid = 1 AND status = 0
            AND shipping_type <> 2 AND refund_status IN (0, 3)
            AND is_del = 0 AND is_system_del = 0)::int AS store_deliverable_rows,
          count(*) FILTER (WHERE paid = 1 AND status IN (0, 1, 5)
            AND (shipping_type = 2 OR delivery_type = 'send')
            AND refund_status IN (0, 3) AND is_del = 0 AND is_system_del = 0)::int
            AS active_writeoff_rows,
          (SELECT count(*)::int FROM duplicate_verify) AS duplicate_active_verify_code_groups,
          (SELECT count(*)::int FROM duplicate_public_id) AS duplicate_order_id_groups
        FROM store_order
      `;
      const refundRows = await tx<Array<Record<string, unknown>>>`
        SELECT count(*)::int AS total_rows,
          count(*) FILTER (WHERE refund.is_cancel = 0 AND refund.is_del = 0)::int AS active_rows,
          count(*) FILTER (WHERE orders.id IS NULL)::int AS order_orphan_rows,
          count(*) FILTER (WHERE orders.id IS NOT NULL AND (
            refund.store_id <> orders.store_id OR refund.uid <> orders.uid
          ))::int AS ownership_mismatch_rows
        FROM store_order_refund AS refund
        LEFT JOIN store_order AS orders ON orders.id = refund.store_order_id
      `;
      const identityRows = await tx<Array<Record<string, unknown>>>`
        WITH duplicate_kefu AS (
          SELECT uid FROM store_service
          WHERE status = 1 AND account_status = 1 AND customer = 1 AND is_del = 0
          GROUP BY uid HAVING count(*) > 1
        ), duplicate_delivery AS (
          SELECT uid, relation_id FROM delivery_service
          WHERE type = 1 AND status = 1 AND is_del = 0
          GROUP BY uid, relation_id HAVING count(*) > 1
        ), duplicate_barcode AS (
          SELECT bar_code FROM "user"
          WHERE bar_code <> '' AND status = 1 AND is_del = 0
          GROUP BY bar_code HAVING count(*) > 1
        ), duplicate_config AS (
          SELECT relation_id, key_name FROM store_config
          WHERE type = 1 GROUP BY relation_id, key_name HAVING count(*) > 1
        )
        SELECT
          (SELECT count(*)::int FROM store_service
            WHERE status = 1 AND account_status = 1 AND customer = 1 AND is_del = 0)
            AS active_mobile_kefu_rows,
          (SELECT count(*)::int FROM duplicate_kefu) AS duplicate_mobile_kefu_uid_groups,
          (SELECT count(*)::int FROM delivery_service
            WHERE type = 1 AND status = 1 AND is_del = 0) AS active_store_delivery_rows,
          (SELECT count(*)::int FROM duplicate_delivery) AS duplicate_store_delivery_scope_groups,
          (SELECT count(*)::int FROM duplicate_barcode) AS duplicate_active_user_barcode_groups,
          (SELECT count(*)::int FROM store_config WHERE type = 1) AS store_config_rows,
          (SELECT count(*)::int FROM duplicate_config) AS duplicate_store_config_groups
      `;
      const indexRows = await tx<Array<Record<string, unknown>>>`
        SELECT
          EXISTS (SELECT 1 FROM pg_index AS indexed
            JOIN pg_class AS relation ON relation.oid = indexed.indrelid
            JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
            WHERE namespace.nspname = 'public' AND relation.relname = 'system_store_staff'
              AND indexed.indisvalid AND indexed.indisready
              AND pg_get_indexdef(indexed.indexrelid, 1, true) = 'uid') AS staff_uid_index_ready,
          EXISTS (SELECT 1 FROM pg_index AS indexed
            JOIN pg_class AS relation ON relation.oid = indexed.indrelid
            JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
            WHERE namespace.nspname = 'public' AND relation.relname = 'store_order'
              AND indexed.indisvalid AND indexed.indisready
              AND pg_get_indexdef(indexed.indexrelid, 1, true) = 'order_id') AS order_number_index_ready,
          EXISTS (SELECT 1 FROM pg_index AS indexed
            JOIN pg_class AS relation ON relation.oid = indexed.indrelid
            JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
            WHERE namespace.nspname = 'public' AND relation.relname = 'store_order_cart_info'
              AND indexed.indisvalid AND indexed.indisready
              AND pg_get_indexdef(indexed.indexrelid, 1, true) = 'oid') AS cart_order_index_ready,
          EXISTS (SELECT 1 FROM pg_index AS indexed
            JOIN pg_class AS relation ON relation.oid = indexed.indrelid
            JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
            WHERE namespace.nspname = 'public' AND relation.relname = 'store_order_refund'
              AND indexed.indisvalid AND indexed.indisready
              AND pg_get_indexdef(indexed.indexrelid, 1, true) = 'store_order_id') AS refund_order_index_ready,
          (SELECT count(*)::int FROM pg_indexes
            WHERE schemaname = 'public' AND tablename = 'store_order_refund') AS refund_index_count,
          EXISTS (SELECT 1 FROM pg_index AS indexed
            JOIN pg_class AS relation ON relation.oid = indexed.indrelid
            JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
            WHERE namespace.nspname = 'public' AND relation.relname = 'store_service'
              AND indexed.indisvalid AND indexed.indisready
              AND pg_get_indexdef(indexed.indexrelid, 1, true) = 'uid') AS kefu_uid_index_ready,
          EXISTS (SELECT 1 FROM pg_index AS indexed
            JOIN pg_class AS relation ON relation.oid = indexed.indrelid
            JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
            WHERE namespace.nspname = 'public' AND relation.relname = 'delivery_service'
              AND indexed.indisvalid AND indexed.indisready
              AND pg_get_indexdef(indexed.indexrelid, 1, true) = 'uid') AS delivery_uid_index_ready,
          EXISTS (SELECT 1 FROM pg_index AS indexed
            JOIN pg_class AS relation ON relation.oid = indexed.indrelid
            JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
            WHERE namespace.nspname = 'public' AND relation.relname = 'store_config'
              AND indexed.indisvalid AND indexed.indisready
              AND pg_get_indexdef(indexed.indexrelid, 1, true) = 'type') AS store_config_scope_index_ready
      `;
      return {
        complete: true,
        server_version: resolution.server_version,
        catalog,
        store_staff: staffRows[0] ?? {},
        orders: orderRows[0] ?? {},
        refunds: refundRows[0] ?? {},
        identities_and_config: identityRows[0] ?? {},
        index_readiness: indexRows[0] ?? {},
        guarantees: {
          transaction: "REPEATABLE READ, READ ONLY",
          search_path: "public, pg_temp (pg_temp last)",
          names_phones_addresses_barcodes_codes_or_snapshots_returned: false,
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
    const hashes = [env.AUDIT_READ_TOKEN_SHA256 ?? "", env.AUDIT_ISOLATED_TOKEN_SHA256 ?? ""];
    if (request.method !== "POST" || !["/audit", "/isolated-scenario"].includes(url.pathname)) {
      return Response.json({ error: "not found" }, { status: 404 });
    }
    if (hashes.some((value) => !decodeSha256(value))
      || new Set(hashes.map((value) => value.toLowerCase())).size !== 2) {
      return Response.json(
        { error: "audit unavailable" },
        { status: 503, headers: { "Cache-Control": "private, no-store" } },
      );
    }
    const expectedHash = url.pathname === "/audit" ? hashes[0] : hashes[1];
    if (!(await authorized(request, expectedHash))) {
      return Response.json({ error: "forbidden" }, { status: 403 });
    }
    try {
      const result = url.pathname === "/audit"
        ? await productionAggregates(env.HYPERDRIVE.connectionString)
        : await runStoreMobileOrderCompatibilityScenario(env.HYPERDRIVE.connectionString);
      return Response.json(result, { headers: { "Cache-Control": "private, no-store" } });
    } catch (error) {
      console.error(JSON.stringify({
        event: "store_mobile_order_audit_failed",
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
