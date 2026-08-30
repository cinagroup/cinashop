import postgres from "postgres";
import {
  PUBLIC_ARTICLE_SCHEMA_PREFIX,
  PUBLIC_ARTICLE_TABLES,
  runPublicArticleCompatibilityScenario,
} from "./PublicArticleCompatibilityScenario";

interface AuditEnv {
  HYPERDRIVE: Hyperdrive;
  AUDIT_READ_TOKEN_SHA256: string;
  AUDIT_ISOLATED_TOKEN_SHA256: string;
}

const REQUIRED_TABLES = [...PUBLIC_ARTICLE_TABLES, "user"] as const;

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`PUBLIC-ARTICLE production audit failed: ${message}`);
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
    connection: { application_name: "cinashop_public_article_read_only_audit" },
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
          AND relation.relname IN ${tx(REQUIRED_TABLES)}
        ORDER BY relation.relname
      `;
      const present = new Set(catalogRows.map((row) => row.table_name));
      const missingTables = REQUIRED_TABLES.filter((table) => !present.has(table));
      const tempRows = await tx<Array<{ count: number }>>`
        SELECT count(*)::integer AS count
        FROM pg_namespace
        WHERE starts_with(nspname, ${PUBLIC_ARTICLE_SCHEMA_PREFIX})
      `;
      const catalog = {
        expected_table_count: REQUIRED_TABLES.length,
        present_table_count: REQUIRED_TABLES.length - missingTables.length,
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
            titles_or_bodies_returned: false,
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
          (SELECT namespace.nspname
             FROM pg_class AS relation
             JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
            WHERE relation.oid = to_regclass('system_article')) AS resolved_schema
      `;
      const resolution = resolutionRows[0];
      invariant(
        resolution?.schema_name === "public"
          && resolution.configured_path === "public, pg_temp"
          && resolution.resolved_schema === "public",
        "read-only audit was not pinned to public, pg_temp",
      );

      const articleRows = await tx<Array<Record<string, unknown>>>`
        WITH relation_counts AS (
          SELECT relation_id, count(*)::integer AS count
          FROM user_relation
          WHERE type = 'like' AND category = 'article'
          GROUP BY relation_id
        )
        SELECT
          count(*)::integer AS total_rows,
          count(*) FILTER (WHERE article.status = 1 AND article.hide = 0 AND article.is_del = 0)::integer
            AS public_visible_rows,
          count(*) FILTER (WHERE article.status <> 1)::integer AS inactive_rows,
          count(*) FILTER (WHERE article.hide <> 0)::integer AS hidden_rows,
          count(*) FILTER (WHERE article.is_del <> 0)::integer AS soft_deleted_rows,
          count(*) FILTER (
            WHERE article.status = 1 AND article.hide = 0 AND article.is_del = 0 AND article.is_hot = 1
          )::integer AS public_hot_rows,
          count(*) FILTER (
            WHERE article.status = 1 AND article.hide = 0 AND article.is_del = 0 AND article.is_banner = 1
          )::integer AS public_banner_rows,
          count(*) FILTER (WHERE article.visit < 0)::integer AS negative_visit_rows,
          count(*) FILTER (WHERE article.likes < 0)::integer AS negative_like_rows,
          count(*) FILTER (
            WHERE article.status = 1 AND article.hide = 0 AND article.is_del = 0
              AND NULLIF(COALESCE(NULLIF(article.content, ''), body.content, ''), '') IS NULL
          )::integer AS public_missing_body_rows,
          count(*) FILTER (
            WHERE article.cid > 0 AND category.id IS NULL
          )::integer AS category_orphan_rows,
          count(*) FILTER (
            WHERE article.product_id > 0 AND product.id IS NULL
          )::integer AS product_orphan_rows,
          count(*) FILTER (
            WHERE article.likes <> COALESCE(relation_counts.count, 0)
          )::integer AS like_counter_drift_rows
        FROM system_article AS article
        LEFT JOIN article_content AS body ON body.nid = article.id
        LEFT JOIN article_category AS category ON category.id = article.cid
        LEFT JOIN store_product AS product ON product.id = article.product_id
        LEFT JOIN relation_counts ON relation_counts.relation_id = article.id
      `;

      const categoryRows = await tx<Array<Record<string, unknown>>>`
        SELECT
          count(*)::integer AS total_rows,
          count(*) FILTER (WHERE status = 1 AND hidden = 0 AND is_del = 0)::integer AS public_visible_rows,
          count(*) FILTER (WHERE status <> 1)::integer AS inactive_rows,
          count(*) FILTER (WHERE hidden <> 0)::integer AS hidden_rows,
          count(*) FILTER (WHERE is_del <> 0)::integer AS soft_deleted_rows,
          (SELECT count(*)::integer FROM (
            SELECT sort FROM article_category
            WHERE status = 1 AND hidden = 0 AND is_del = 0
            GROUP BY sort HAVING count(*) > 1
          ) AS duplicate_sort_groups) AS duplicate_public_sort_groups
        FROM article_category
      `;

      const contentRows = await tx<Array<Record<string, unknown>>>`
        SELECT
          count(*)::integer AS total_rows,
          count(*) FILTER (WHERE article.id IS NULL)::integer AS orphan_rows,
          count(*) FILTER (WHERE NULLIF(btrim(COALESCE(body.content, '')), '') IS NULL)::integer AS blank_rows,
          (SELECT count(*)::integer FROM system_article AS article
            WHERE NOT EXISTS (SELECT 1 FROM article_content AS content WHERE content.nid = article.id))
            AS articles_without_body_row
        FROM article_content AS body
        LEFT JOIN system_article AS article ON article.id = body.nid
      `;

      const newsRows = await tx<Array<Record<string, unknown>>>`
        WITH tokens AS (
          SELECT news.id AS bundle_key, btrim(token.value) AS value
          FROM wechat_news_category AS news
          CROSS JOIN LATERAL regexp_split_to_table(news.new_id, ',') AS token(value)
        ), normalized AS (
          SELECT bundle_key, value,
            CASE WHEN value ~ '^[0-9]+$'
              THEN COALESCE(NULLIF(ltrim(value, '0'), ''), '0')
              ELSE NULL
            END AS normalized_value
          FROM tokens
        )
        SELECT
          (SELECT count(*)::integer FROM wechat_news_category) AS bundle_rows,
          (SELECT count(*)::integer FROM wechat_news_category WHERE new_id LIKE '%,%') AS multi_id_rows,
          (SELECT count(*)::integer FROM wechat_news_category WHERE NULLIF(btrim(new_id), '') IS NULL)
            AS blank_reference_rows,
          count(*) FILTER (WHERE value <> '')::integer AS nonblank_tokens,
          count(*) FILTER (WHERE normalized_value IS NOT NULL AND normalized_value <> '0')::integer
            AS numeric_positive_tokens,
          count(*) FILTER (WHERE value <> '' AND (normalized_value IS NULL OR normalized_value = '0'))::integer
            AS invalid_or_zero_tokens,
          count(*) FILTER (
            WHERE normalized_value IS NOT NULL AND normalized_value <> '0' AND article.id IS NULL
          )::integer AS missing_article_tokens
        FROM normalized
        LEFT JOIN system_article AS article ON article.id::text = normalized.normalized_value
      `;

      const relationRows = await tx<Array<Record<string, unknown>>>`
        SELECT
          count(*) FILTER (WHERE relation.type = 'like' AND relation.category = 'article')::integer
            AS article_like_rows,
          count(*) FILTER (
            WHERE relation.type = 'like' AND relation.category = 'article' AND relation.uid = 0
          )::integer AS anonymous_like_rows,
          count(*) FILTER (
            WHERE relation.type = 'like' AND relation.category = 'article' AND account.uid IS NULL
          )::integer AS owner_orphan_rows,
          count(*) FILTER (
            WHERE relation.type = 'like' AND relation.category = 'article' AND article.id IS NULL
          )::integer AS target_orphan_rows,
          (SELECT count(*)::integer FROM (
            SELECT uid, relation_id, type, category
            FROM user_relation
            WHERE type = 'like' AND category = 'article'
            GROUP BY uid, relation_id, type, category HAVING count(*) > 1
          ) AS duplicate_groups) AS duplicate_relation_groups
        FROM user_relation AS relation
        LEFT JOIN "user" AS account ON account.uid = relation.uid
        LEFT JOIN system_article AS article ON article.id = relation.relation_id
      `;

      const mediaRows = await tx<Array<Record<string, unknown>>>`
        SELECT
          count(*) FILTER (WHERE NULLIF(btrim(article.image_input), '') IS NULL)::integer
            AS blank_cover_rows,
          count(*) FILTER (WHERE article.image_input LIKE '%,%')::integer AS multi_cover_rows,
          count(*) FILTER (WHERE article.image_input LIKE 'https://%')::integer AS https_cover_rows,
          count(*) FILTER (WHERE article.image_input LIKE 'http://%')::integer AS http_cover_rows,
          count(*) FILTER (WHERE article.image_input LIKE '/%')::integer AS root_relative_cover_rows,
          count(*) FILTER (WHERE article.image_input LIKE '%/api/assets/%')::integer AS asset_proxy_cover_rows,
          count(*) FILTER (
            WHERE NULLIF(btrim(article.image_input), '') IS NOT NULL
              AND article.image_input NOT LIKE 'https://%'
              AND article.image_input NOT LIKE 'http://%'
              AND article.image_input NOT LIKE '/%'
          )::integer AS other_cover_rows,
          (SELECT count(*)::integer FROM system_article AS source
            CROSS JOIN LATERAL regexp_split_to_table(source.image_input, ',') AS token(value))
            AS cover_tokens,
          (SELECT count(*)::integer FROM system_article AS source
            CROSS JOIN LATERAL regexp_split_to_table(source.image_input, ',') AS token(value)
            WHERE NULLIF(btrim(token.value), '') IS NULL) AS blank_cover_tokens,
          (SELECT count(*)::integer FROM system_article AS source
            CROSS JOIN LATERAL regexp_split_to_table(source.image_input, ',') AS token(value)
            WHERE btrim(token.value) LIKE 'https://%') AS https_cover_tokens,
          (SELECT count(*)::integer FROM system_article AS source
            CROSS JOIN LATERAL regexp_split_to_table(source.image_input, ',') AS token(value)
            WHERE btrim(token.value) LIKE 'http://%') AS http_cover_tokens,
          (SELECT count(*)::integer FROM system_article AS source
            CROSS JOIN LATERAL regexp_split_to_table(source.image_input, ',') AS token(value)
            WHERE btrim(token.value) LIKE '/%') AS root_relative_cover_tokens,
          (SELECT count(*)::integer FROM system_article AS source
            CROSS JOIN LATERAL regexp_split_to_table(source.image_input, ',') AS token(value)
            WHERE btrim(token.value) LIKE '%/api/assets/%') AS asset_proxy_cover_tokens,
          (SELECT count(*)::integer FROM system_article AS source
            CROSS JOIN LATERAL regexp_split_to_table(source.image_input, ',') AS token(value)
            WHERE NULLIF(btrim(token.value), '') IS NOT NULL
              AND btrim(token.value) NOT LIKE 'https://%'
              AND btrim(token.value) NOT LIKE 'http://%'
              AND btrim(token.value) NOT LIKE '/%') AS other_cover_tokens,
          count(*) FILTER (
            WHERE body.html ~* '<[[:space:]]*(script|iframe|embed|object|form|svg|math|meta|base|link|style|template)'
          )::integer
            AS dangerous_tag_rows,
          count(*) FILTER (WHERE body.html ~* '[[:space:]]on[a-z]+[[:space:]]*=')::integer
            AS inline_event_rows,
          count(*) FILTER (WHERE body.html ~* '[[:space:]]srcdoc[[:space:]]*=')::integer
            AS srcdoc_rows,
          count(*) FILTER (WHERE body.html ~* '[[:space:]]style[[:space:]]*=')::integer
            AS style_attribute_rows,
          count(*) FILTER (WHERE body.html ~* '(javascript:|data:[[:space:]]*text/html)')::integer
            AS dangerous_scheme_rows,
          count(*) FILTER (
            WHERE body.html ~* '(href|src)[[:space:]]*=[^>]*(&#[xX]?[0-9a-fA-F]+;?|&colon;)'
          )::integer AS encoded_url_entity_rows,
          count(*) FILTER (WHERE body.html LIKE '%/api/assets/%')::integer AS asset_proxy_body_rows,
          count(*) FILTER (WHERE body.html ~* '<[[:space:]]*(img|video|source|a)[[:space:]>]')::integer
            AS body_media_or_link_rows
        FROM system_article AS article
        CROSS JOIN LATERAL (
          SELECT COALESCE(NULLIF(article.content, ''), content.content, '') AS html
          FROM (SELECT 1) AS singleton
          LEFT JOIN article_content AS content ON content.nid = article.id
        ) AS body
      `;

      const indexRows = await tx<Array<Record<string, unknown>>>`
        SELECT tablename,
          count(*)::integer AS index_count,
          count(*) FILTER (WHERE indexdef ILIKE '%add_time%')::integer AS add_time_index_count,
          count(*) FILTER (WHERE indexdef ILIKE '%is_hot%')::integer AS hot_index_count,
          count(*) FILTER (WHERE indexdef ILIKE '%is_banner%')::integer AS banner_index_count
        FROM pg_indexes
        WHERE schemaname = 'public'
          AND tablename IN ('system_article', 'article_category', 'article_content', 'user_relation')
        GROUP BY tablename
        ORDER BY tablename
      `;

      const relationIndexRows = await tx<Array<{
        candidate_count: number;
        article_like_partial_unique_ready: boolean;
      }>>`
        WITH candidate AS (
          SELECT index_relation.relkind = 'i' AS is_index,
            indexed.indisunique,
            indexed.indisvalid,
            indexed.indisready,
            indexed.indimmediate,
            indexed.indisprimary,
            indexed.indisexclusion,
            indexed.indisclustered,
            indexed.indisreplident,
            indexed.indislive,
            indexed.indcheckxmin,
            indexed.indnullsnotdistinct,
            indexed.indnatts = indexed.indnkeyatts AS has_only_key_columns,
            indexed.indexprs IS NULL AS has_no_expressions,
            index_relation.reloptions IS NULL AS has_default_options,
            NOT EXISTS (
              SELECT 1 FROM pg_constraint AS attached
              WHERE attached.conindid = indexed.indexrelid
            ) AS is_unconstrained,
            access_method.amname AS access_method,
            ARRAY(
              SELECT pg_get_indexdef(indexed.indexrelid, position, true)
              FROM generate_series(1, indexed.indnkeyatts) AS position
              ORDER BY position
            ) AS key_columns,
            replace(replace(replace(replace(
              COALESCE(pg_get_expr(indexed.indpred, indexed.indrelid, true), ''),
              '(', ''), ')', ''), ' ', ''), '"', '') AS predicate_sql
          FROM pg_index AS indexed
          JOIN pg_class AS index_relation ON index_relation.oid = indexed.indexrelid
          JOIN pg_namespace AS index_namespace ON index_namespace.oid = index_relation.relnamespace
          JOIN pg_class AS table_relation ON table_relation.oid = indexed.indrelid
          JOIN pg_namespace AS table_namespace ON table_namespace.oid = table_relation.relnamespace
          JOIN pg_am AS access_method ON access_method.oid = index_relation.relam
          WHERE index_namespace.nspname = 'public'
            AND table_namespace.nspname = 'public'
            AND table_relation.relname = 'user_relation'
            AND index_relation.relname = 'ur_uid_rel_type_cat_idx'
        )
        SELECT count(*)::integer AS candidate_count,
          COALESCE(bool_and(
            is_index AND indisunique AND indisvalid AND indisready AND indimmediate
            AND NOT indisprimary AND NOT indisexclusion
            AND NOT indisclustered AND NOT indisreplident AND indislive
            AND NOT indcheckxmin AND NOT indnullsnotdistinct
            AND has_only_key_columns AND has_no_expressions AND has_default_options
            AND is_unconstrained AND access_method = 'btree'
            AND key_columns = ARRAY['uid', 'relation_id', 'type', 'category']::text[]
            AND predicate_sql = 'type::text<>''play''::text'
          ), false) AND count(*) = 1 AS article_like_partial_unique_ready
        FROM candidate
      `;

      const visibleRows = Number(articleRows[0]?.public_visible_rows ?? 0);
      const relationIndex = relationIndexRows[0];
      const articleLikeIndexReady = relationIndex?.article_like_partial_unique_ready === true;
      return {
        complete: true,
        server_version: resolution.server_version,
        catalog,
        articles: articleRows[0] ?? {},
        categories: categoryRows[0] ?? {},
        bodies: contentRows[0] ?? {},
        news_references: newsRows[0] ?? {},
        article_like_relations: relationRows[0] ?? {},
        html_and_media: mediaRows[0] ?? {},
        index_aggregates: indexRows,
        index_assessment: {
          public_visible_rows: visibleRows,
          forward_latest_indexes_recommended: visibleRows > 1_000,
          article_like_partial_unique_candidate_count: Number(relationIndex?.candidate_count ?? 0),
          article_like_partial_unique_ready: articleLikeIndexReady,
          correctness_requires_new_index: !articleLikeIndexReady,
        },
        guarantees: {
          transaction: "REPEATABLE READ, READ ONLY",
          search_path: "public, pg_temp (pg_temp last)",
          titles_or_bodies_returned: false,
          urls_or_user_ids_returned: false,
          business_ids_returned: false,
          configuration_values_returned: false,
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
    if (
      request.method !== "POST"
      || !["/audit", "/isolated-scenario"].includes(url.pathname)
    ) {
      return Response.json({ error: "not found" }, { status: 404 });
    }
    const readHash = env.AUDIT_READ_TOKEN_SHA256 ?? "";
    const isolatedHash = env.AUDIT_ISOLATED_TOKEN_SHA256 ?? "";
    if (
      !decodeSha256(readHash)
      || !decodeSha256(isolatedHash)
      || readHash.toLowerCase() === isolatedHash.toLowerCase()
    ) {
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
        ? await runPublicArticleCompatibilityScenario(env.HYPERDRIVE.connectionString)
        : await productionAggregates(env.HYPERDRIVE.connectionString);
      return Response.json(result, {
        headers: { "Cache-Control": "private, no-store" },
      });
    } catch (error) {
      console.error(JSON.stringify({
        event: "public_article_audit_failed",
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
