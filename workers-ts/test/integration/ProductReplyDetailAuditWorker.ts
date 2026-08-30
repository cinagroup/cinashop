import postgres from "postgres";
import {
  PRODUCT_REPLY_SCHEMA_PREFIX,
  PRODUCT_REPLY_TABLES,
  runProductReplyDetailCompatibilityScenario,
} from "./ProductReplyDetailCompatibilityScenario";

interface AuditEnv {
  HYPERDRIVE: Hyperdrive;
  AUDIT_READ_TOKEN_SHA256: string;
  AUDIT_ISOLATED_TOKEN_SHA256: string;
}

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`PRODUCT-REPLY production audit failed: ${message}`);
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
    connection: { application_name: "cinashop_product_reply_read_only_audit" },
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
          AND relation.relname IN ${tx(PRODUCT_REPLY_TABLES)}
        ORDER BY relation.relname
      `;
      const present = new Set(catalogRows.map((row) => row.table_name));
      const missingTables = PRODUCT_REPLY_TABLES.filter((table) => !present.has(table));
      const tempRows = await tx<Array<{ count: number }>>`
        SELECT count(*)::integer AS count FROM pg_namespace
        WHERE starts_with(nspname, ${PRODUCT_REPLY_SCHEMA_PREFIX})
      `;
      const catalog = {
        expected_table_count: PRODUCT_REPLY_TABLES.length,
        present_table_count: PRODUCT_REPLY_TABLES.length - missingTables.length,
        missing_tables: missingTables,
        temporary_schema_count: Number(tempRows[0]?.count ?? -1),
      };
      if (missingTables.length > 0) {
        return {
          complete: false,
          catalog,
          data_audit_skipped: true,
          guarantees: {
            transaction: "REPEATABLE READ, READ ONLY",
            search_path: "public, pg_temp (pg_temp last)",
            comments_or_names_returned: false,
            urls_or_user_ids_returned: false,
            business_ids_returned: false,
            dml_or_ddl_executed: false,
          },
        };
      }

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
            WHERE relation.oid = to_regclass('store_product_reply')) AS resolved_schema
      `;
      const resolution = resolutionRows[0];
      invariant(
        resolution?.schema_name === "public"
          && resolution.configured_path === "public, pg_temp"
          && resolution.resolved_schema === "public",
        "read-only audit was not pinned to public, pg_temp",
      );

      const reviewRows = await tx<Array<Record<string, unknown>>>`
        WITH relation_counts AS (
          SELECT relation_id, count(*)::integer AS count
          FROM user_relation WHERE type = 'like' AND category = 'reply'
          GROUP BY relation_id
        )
        SELECT count(*)::integer AS total_rows,
          count(*) FILTER (WHERE reply.status = 1 AND reply.is_del = 0)::integer AS visible_rows,
          count(*) FILTER (WHERE reply.status <> 1 AND reply.is_del = 0)::integer AS unapproved_rows,
          count(*) FILTER (WHERE reply.is_del <> 0)::integer AS soft_deleted_rows,
          count(*) FILTER (WHERE reply.praise < 0)::integer AS negative_praise_rows,
          count(*) FILTER (WHERE reply.views_num < 0)::integer AS negative_view_rows,
          count(*) FILTER (WHERE product.id IS NULL)::integer AS product_orphan_rows,
          count(*) FILTER (WHERE reply.uid > 0 AND owner.uid IS NULL)::integer AS owner_orphan_rows,
          count(*) FILTER (WHERE reply.praise <> COALESCE(relation_counts.count, 0))::integer
            AS praise_counter_drift_rows
        FROM store_product_reply AS reply
        LEFT JOIN store_product AS product ON product.id = reply.product_id
        LEFT JOIN "user" AS owner ON owner.uid = reply.uid
        LEFT JOIN relation_counts ON relation_counts.relation_id = reply.id
      `;

      const commentRows = await tx<Array<Record<string, unknown>>>`
        WITH relation_counts AS (
          SELECT relation_id, count(*)::integer AS count
          FROM user_relation WHERE type = 'like' AND category = 'comment'
          GROUP BY relation_id
        )
        SELECT count(*)::integer AS total_rows,
          count(*) FILTER (WHERE comment.is_del = 0)::integer AS active_rows,
          count(*) FILTER (WHERE comment.is_del = 0 AND comment.pid = 0)::integer AS active_root_rows,
          count(*) FILTER (WHERE comment.is_del = 0 AND comment.pid > 0)::integer AS active_child_rows,
          count(*) FILTER (WHERE comment.is_del <> 0)::integer AS soft_deleted_rows,
          count(*) FILTER (WHERE comment.praise < 0)::integer AS negative_praise_rows,
          count(*) FILTER (WHERE parent.id IS NULL)::integer AS parent_orphan_rows,
          count(*) FILTER (WHERE comment.uid > 0 AND owner.uid IS NULL)::integer AS owner_orphan_rows,
          count(*) FILTER (
            WHERE comment.is_del = 0 AND parent.id IS NOT NULL
              AND (parent.status <> 1 OR parent.is_del <> 0)
          )::integer AS active_rows_with_hidden_parent,
          count(*) FILTER (WHERE comment.praise <> COALESCE(relation_counts.count, 0))::integer
            AS praise_counter_drift_rows
        FROM store_product_reply_comment AS comment
        LEFT JOIN store_product_reply AS parent ON parent.id = comment.reply_id
        LEFT JOIN "user" AS owner ON owner.uid = comment.uid
        LEFT JOIN relation_counts ON relation_counts.relation_id = comment.id
      `;

      const relationRows = await tx<Array<Record<string, unknown>>>`
        SELECT count(*) FILTER (WHERE relation.type = 'like' AND relation.category = 'reply')::integer
            AS review_like_rows,
          count(*) FILTER (WHERE relation.type = 'like' AND relation.category = 'comment')::integer
            AS comment_like_rows,
          count(*) FILTER (
            WHERE relation.type = 'like' AND relation.category IN ('reply', 'comment')
              AND owner.uid IS NULL
          )::integer AS owner_orphan_rows,
          count(*) FILTER (
            WHERE relation.type = 'like' AND relation.category = 'reply' AND reply.id IS NULL
          )::integer AS review_target_orphan_rows,
          count(*) FILTER (
            WHERE relation.type = 'like' AND relation.category = 'comment' AND comment.id IS NULL
          )::integer AS comment_target_orphan_rows,
          (SELECT count(*)::integer FROM (
            SELECT uid, relation_id, type, category FROM user_relation
            WHERE type <> 'play' GROUP BY uid, relation_id, type, category HAVING count(*) > 1
          ) AS duplicate_relations) AS duplicate_non_play_groups
        FROM user_relation AS relation
        LEFT JOIN "user" AS owner ON owner.uid = relation.uid
        LEFT JOIN store_product_reply AS reply
          ON relation.category = 'reply' AND reply.id = relation.relation_id
        LEFT JOIN store_product_reply_comment AS comment
          ON relation.category = 'comment' AND comment.id = relation.relation_id
        WHERE relation.type = 'like' AND relation.category IN ('reply', 'comment')
      `;

      const configRows = await tx<Array<Record<string, unknown>>>`
        SELECT count(DISTINCT menu_name)::integer AS required_keys_present,
          count(*)::integer AS matching_rows,
          count(*) FILTER (WHERE value = '')::integer AS blank_value_rows,
          (4 - count(DISTINCT menu_name))::integer AS required_keys_missing
        FROM system_config
        WHERE is_store = 0
          AND menu_name IN ('site_name', 'site_logo_square', 'member_func_status', 'member_card_status')
      `;

      const indexRows = await tx<Array<Record<string, unknown>>>`
        SELECT count(*) FILTER (WHERE table_relation.relname = 'user_relation')::integer
            AS user_relation_index_count,
          count(*) FILTER (WHERE table_relation.relname = 'store_product_reply_comment')::integer
            AS reply_comment_index_count,
          count(*) FILTER (
            WHERE table_relation.relname = 'user_relation'
              AND index_relation.relname = 'ur_uid_rel_type_cat_idx'
              AND catalog.indisunique AND catalog.indisvalid AND catalog.indisready
          )::integer AS non_play_unique_index_ready
        FROM pg_index AS catalog
        JOIN pg_class AS table_relation ON table_relation.oid = catalog.indrelid
        JOIN pg_namespace AS namespace ON namespace.oid = table_relation.relnamespace
        JOIN pg_class AS index_relation ON index_relation.oid = catalog.indexrelid
        WHERE namespace.nspname = 'public'
          AND table_relation.relname IN ('user_relation', 'store_product_reply_comment')
      `;

      return {
        complete: true,
        server_version: resolution.server_version,
        catalog,
        product_reviews: reviewRows[0] ?? {},
        review_comments: commentRows[0] ?? {},
        like_relations: relationRows[0] ?? {},
        required_configuration: configRows[0] ?? {},
        index_aggregates: indexRows[0] ?? {},
        guarantees: {
          transaction: "REPEATABLE READ, READ ONLY",
          search_path: "public, pg_temp (pg_temp last)",
          comments_or_names_returned: false,
          configuration_values_returned: false,
          urls_or_user_ids_returned: false,
          business_ids_returned: false,
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
    if (request.method !== "POST" || !["/audit", "/isolated-scenario"].includes(url.pathname)) {
      return Response.json({ error: "not found" }, { status: 404 });
    }
    const readHash = env.AUDIT_READ_TOKEN_SHA256 ?? "";
    const isolatedHash = env.AUDIT_ISOLATED_TOKEN_SHA256 ?? "";
    if (!decodeSha256(readHash) || !decodeSha256(isolatedHash)
      || readHash.toLowerCase() === isolatedHash.toLowerCase()) {
      return Response.json(
        { error: "audit unavailable" },
        { status: 503, headers: { "Cache-Control": "private, no-store" } },
      );
    }
    const expectedHash = url.pathname === "/audit" ? readHash : isolatedHash;
    if (!(await authorized(request, expectedHash))) {
      return Response.json({ error: "forbidden" }, { status: 403 });
    }
    try {
      const result = url.pathname === "/isolated-scenario"
        ? await runProductReplyDetailCompatibilityScenario(env.HYPERDRIVE.connectionString)
        : await productionAggregates(env.HYPERDRIVE.connectionString);
      return Response.json(result, { headers: { "Cache-Control": "private, no-store" } });
    } catch (error) {
      console.error(JSON.stringify({
        event: "product_reply_detail_audit_failed",
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
