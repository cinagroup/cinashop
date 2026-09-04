import postgres from "postgres";
import { PRODUCT_SKU_RETIREMENT_SQL } from "@/migrations/productSkuRetirement";

type AuditEnv = Pick<WorkerBindings, "HYPERDRIVE"> & {
  AUDIT_TOKEN_SHA256: string;
};

const RELATIONS = [
  "store_product",
  "store_product_attr_value",
  "store_product_sku_retirement_log",
  "store_cart",
  "store_order",
  "store_order_cart_info",
  "store_product_reply",
  "store_product_stock_record",
  "store_product_virtual",
  "store_promotions",
  "store_promotions_auxiliary",
  "luck_prize",
  "store_branch_product_attr_value",
] as const;

const RETIREMENT_COLUMNS = ["is_retired", "retired_at", "retired_by", "retire_reason"] as const;

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
    const path = new URL(request.url).pathname;
    const isAudit = request.method === "GET" && path === "/audit";
    const isMigration = request.method === "POST" && path === "/migrate";
    if (!isAudit && !isMigration) {
      return Response.json({ error: "not found" }, { status: 404 });
    }

    const client = postgres(env.HYPERDRIVE.connectionString, {
      prepare: false,
      max: 1,
      connection: { application_name: "cinashop_product_sku_retirement_audit" },
    });
    try {
      if (isMigration) {
        const migration = await client.begin(async (tx) => {
          await tx`SET LOCAL lock_timeout = '2s'`;
          await tx`SET LOCAL statement_timeout = '15s'`;
          await tx`SET LOCAL idle_in_transaction_session_timeout = '20s'`;
          await tx`SELECT pg_advisory_xact_lock(770426, 126)`;
          await tx.unsafe('LOCK TABLE "store_product_attr_value" IN ACCESS EXCLUSIVE MODE');

          const preflight = (await tx<{
            sku_rows: number;
            sku_relation_bytes: string;
            duplicate_unique_groups: number;
            duplicate_product_suk_groups: number;
            empty_unique: number;
            empty_suk: number;
            negative_stock: number;
            orphan_base_skus: number;
          }[]>`
            WITH base AS (
              SELECT v.product_id, btrim(v."unique") AS unique_value, btrim(v.suk) AS suk_value, v.stock, p.id AS owner_id
              FROM store_product_attr_value v
              LEFT JOIN store_product p ON p.id = v.product_id
              WHERE v.type = 0
            ), duplicate_unique AS (
              SELECT 1 FROM base WHERE unique_value <> '' GROUP BY unique_value HAVING count(*) > 1
            ), duplicate_product_suk AS (
              SELECT 1 FROM base WHERE suk_value <> '' GROUP BY product_id, suk_value HAVING count(*) > 1
            )
            SELECT
              (SELECT count(*)::integer FROM store_product_attr_value) AS sku_rows,
              pg_total_relation_size('public.store_product_attr_value')::text AS sku_relation_bytes,
              (SELECT count(*)::integer FROM duplicate_unique) AS duplicate_unique_groups,
              (SELECT count(*)::integer FROM duplicate_product_suk) AS duplicate_product_suk_groups,
              count(*) FILTER (WHERE unique_value = '')::integer AS empty_unique,
              count(*) FILTER (WHERE suk_value = '')::integer AS empty_suk,
              count(*) FILTER (WHERE stock < 0)::integer AS negative_stock,
              count(*) FILTER (WHERE owner_id IS NULL)::integer AS orphan_base_skus
            FROM base
          `)[0];
          if (!preflight) throw new Error("SKU migration preflight returned no row");
          if (preflight.sku_rows > 100_000 || Number(preflight.sku_relation_bytes) > 64 * 1024 * 1024) {
            throw new Error("SKU migration exceeds the approved production bound");
          }
          if (
            preflight.duplicate_unique_groups !== 0
            || preflight.duplicate_product_suk_groups !== 0
            || preflight.empty_unique !== 0
            || preflight.empty_suk !== 0
            || preflight.negative_stock !== 0
            || preflight.orphan_base_skus !== 0
          ) throw new Error("SKU migration identity preconditions failed");

          const readBusinessSnapshot = async () => (await tx<{
            sku_rows: number;
            legacy_digest: string;
            stock_total: string;
            sales_total: string;
            sum_stock_total: string;
          }[]>`
            SELECT
              count(*)::integer AS sku_rows,
              md5(COALESCE(string_agg(
                (to_jsonb(v) - 'is_retired' - 'retired_at' - 'retired_by' - 'retire_reason')::text,
                '|' ORDER BY v.id
              ), '')) AS legacy_digest,
              COALESCE(sum(v.stock), 0)::text AS stock_total,
              COALESCE(sum(v.sales), 0)::text AS sales_total,
              COALESCE(sum(v.sum_stock), 0)::text AS sum_stock_total
            FROM store_product_attr_value v
          `)[0];

          const readCatalog = async () => (await tx<{
            object_count: number;
            columns_ready: boolean;
            log_table_ready: boolean;
            log_sequence_ready: boolean;
            constraint_ready: boolean;
            indexes_ready: boolean;
            guard_function_ready: boolean;
            trigger_ready: boolean;
            definition_digest: string;
          }[]>`
            WITH target_columns AS (
              SELECT
                a.attname,
                format_type(a.atttypid, a.atttypmod) AS data_type,
                a.attnotnull,
                pg_get_expr(d.adbin, d.adrelid) AS default_expression
              FROM pg_attribute a
              LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
              WHERE a.attrelid = 'public.store_product_attr_value'::regclass
                AND a.attnum > 0
                AND NOT a.attisdropped
                AND a.attname IN ${tx(RETIREMENT_COLUMNS)}
            ), target_constraint AS (
              SELECT conname, convalidated, pg_get_constraintdef(oid, true) AS definition
              FROM pg_constraint
              WHERE conrelid = 'public.store_product_attr_value'::regclass
                AND conname = 'spav_is_retired_ck'
            ), target_indexes AS (
              SELECT c.relname, i.indisvalid, i.indisready, pg_get_indexdef(i.indexrelid) AS definition
              FROM pg_index i
              INNER JOIN pg_class c ON c.oid = i.indexrelid
              INNER JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname = 'public'
                AND i.indrelid IN (
                  'public.store_product_attr_value'::regclass,
                  to_regclass('public.store_product_sku_retirement_log')
                )
                AND c.relname IN ('spav_product_active', 'spsrl_product_time', 'spsrl_sku_time')
            ), target_trigger AS (
              SELECT tgname, tgenabled, pg_get_triggerdef(oid, true) AS definition
              FROM pg_trigger
              WHERE tgrelid = 'public.store_product_attr_value'::regclass
                AND NOT tgisinternal
                AND tgname = 'store_product_attr_value_retired_guard'
            ), object_definitions AS (
              SELECT 'column:' || attname || ':' || data_type || ':' || attnotnull::text || ':'
                || COALESCE(default_expression, '') AS definition FROM target_columns
              UNION ALL SELECT 'constraint:' || conname || ':' || definition FROM target_constraint
              UNION ALL SELECT 'index:' || relname || ':' || definition FROM target_indexes
              UNION ALL SELECT 'trigger:' || tgname || ':' || definition FROM target_trigger
              UNION ALL SELECT 'function:' || pg_get_functiondef(to_regprocedure('public.guard_retired_product_sku()'))
                WHERE to_regprocedure('public.guard_retired_product_sku()') IS NOT NULL
            )
            SELECT
              (
                (SELECT count(*) FROM target_columns)
                + (SELECT count(*) FROM target_constraint)
                + (SELECT count(*) FROM target_indexes)
                + (SELECT count(*) FROM target_trigger)
                + CASE WHEN to_regprocedure('public.guard_retired_product_sku()') IS NULL THEN 0 ELSE 1 END
                + CASE WHEN to_regclass('public.store_product_sku_retirement_log') IS NULL THEN 0 ELSE 1 END
                + CASE WHEN to_regclass('public.store_product_sku_retirement_log_id_seq') IS NULL THEN 0 ELSE 1 END
              )::integer AS object_count,
              (
                SELECT count(*) = 4
                  AND bool_and(attnotnull)
                  AND bool_and(default_expression IS NOT NULL)
                  AND count(*) FILTER (WHERE attname = 'is_retired' AND data_type = 'smallint') = 1
                  AND count(*) FILTER (WHERE attname IN ('retired_at', 'retired_by') AND data_type = 'integer') = 2
                  AND count(*) FILTER (WHERE attname = 'retire_reason' AND data_type = 'character varying(255)') = 1
                FROM target_columns
              ) AS columns_ready,
              to_regclass('public.store_product_sku_retirement_log') IS NOT NULL AS log_table_ready,
              to_regclass('public.store_product_sku_retirement_log_id_seq') IS NOT NULL AS log_sequence_ready,
              (SELECT count(*) = 1 AND bool_and(definition ILIKE '%is_retired%') FROM target_constraint) AS constraint_ready,
              (SELECT count(*) = 3 AND bool_and(indisvalid AND indisready) FROM target_indexes) AS indexes_ready,
              to_regprocedure('public.guard_retired_product_sku()') IS NOT NULL AS guard_function_ready,
              (SELECT count(*) = 1 AND bool_and(tgenabled = 'O') FROM target_trigger) AS trigger_ready,
              md5(COALESCE((SELECT string_agg(definition, '|' ORDER BY definition) FROM object_definitions), '')) AS definition_digest
          `)[0];

          const readRetirementData = async () => (await tx<{
            retired_skus: number;
            malformed_default_rows: number;
            log_rows: number;
          }[]>`
            SELECT
              count(*) FILTER (WHERE is_retired = 1)::integer AS retired_skus,
              count(*) FILTER (
                WHERE is_retired <> 0 OR retired_at <> 0 OR retired_by <> 0 OR retire_reason <> ''
              )::integer AS malformed_default_rows,
              (SELECT count(*)::integer FROM store_product_sku_retirement_log) AS log_rows
            FROM store_product_attr_value
          `)[0];

          const beforeBusiness = await readBusinessSnapshot();
          const beforeCatalog = await readCatalog();
          if (!beforeBusiness || !beforeCatalog) throw new Error("SKU migration baseline is incomplete");
          const beforeReady = beforeCatalog.columns_ready
            && beforeCatalog.log_table_ready
            && beforeCatalog.log_sequence_ready
            && beforeCatalog.constraint_ready
            && beforeCatalog.indexes_ready
            && beforeCatalog.guard_function_ready
            && beforeCatalog.trigger_ready;
          if (beforeCatalog.object_count !== 0 && !beforeReady) {
            throw new Error("SKU migration found a partial pre-existing object set");
          }

          await tx.unsafe(PRODUCT_SKU_RETIREMENT_SQL);
          const afterFirstBusiness = await readBusinessSnapshot();
          const afterFirstCatalog = await readCatalog();
          const afterFirstData = await readRetirementData();
          await tx.unsafe(PRODUCT_SKU_RETIREMENT_SQL);
          const afterSecondBusiness = await readBusinessSnapshot();
          const afterSecondCatalog = await readCatalog();
          const afterSecondData = await readRetirementData();
          if (
            !afterFirstBusiness || !afterFirstCatalog || !afterFirstData
            || !afterSecondBusiness || !afterSecondCatalog || !afterSecondData
          ) {
            throw new Error("SKU migration verification returned no row");
          }

          const businessRowsUnchanged = JSON.stringify(beforeBusiness) === JSON.stringify(afterFirstBusiness)
            && JSON.stringify(afterFirstBusiness) === JSON.stringify(afterSecondBusiness);
          const firstReady = afterFirstCatalog.columns_ready
            && afterFirstCatalog.log_table_ready
            && afterFirstCatalog.log_sequence_ready
            && afterFirstCatalog.constraint_ready
            && afterFirstCatalog.indexes_ready
            && afterFirstCatalog.guard_function_ready
            && afterFirstCatalog.trigger_ready
            && afterFirstData.retired_skus === 0
            && afterFirstData.malformed_default_rows === 0
            && afterFirstData.log_rows === 0;
          const idempotentSecondPass = firstReady
            && afterSecondCatalog.definition_digest === afterFirstCatalog.definition_digest
            && afterSecondCatalog.object_count === afterFirstCatalog.object_count
            && JSON.stringify(afterSecondData) === JSON.stringify(afterFirstData);
          if (!businessRowsUnchanged || !firstReady || !idempotentSecondPass) {
            throw new Error("SKU migration verification failed and was rolled back");
          }

          return {
            preflight,
            already_ready: beforeReady,
            business_before: beforeBusiness,
            business_after_first: afterFirstBusiness,
            business_after_second: afterSecondBusiness,
            catalog_after_first: afterFirstCatalog,
            catalog_after_second: afterSecondCatalog,
            retirement_data_after_first: afterFirstData,
            retirement_data_after_second: afterSecondData,
            business_rows_unchanged: businessRowsUnchanged,
            idempotent_second_pass: idempotentSecondPass,
          };
        });
        return Response.json(migration, {
          headers: {
            "Cache-Control": "private, no-store",
            "X-Content-Type-Options": "nosniff",
          },
        });
      }

      const report = await client.begin("read only", async (tx) => {
        await tx`SET LOCAL lock_timeout = '2s'`;
        await tx`SET LOCAL statement_timeout = '15s'`;
        await tx`SET LOCAL idle_in_transaction_session_timeout = '20s'`;

        const version = await tx<{ server_version: string }[]>`
          SELECT current_setting('server_version') AS server_version
        `;
        const relationRows = await tx<{ relation_name: string }[]>`
          SELECT c.relname AS relation_name
          FROM pg_class c
          INNER JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public'
            AND c.relkind IN ('r', 'p')
            AND c.relname IN ${tx(RELATIONS)}
          ORDER BY c.relname
        `;
        const presentRelations = new Set(relationRows.map((row) => row.relation_name));
        const relations = Object.fromEntries(RELATIONS.map((name) => [name, presentRelations.has(name)]));
        if (!relations.store_product || !relations.store_product_attr_value) {
          throw new Error("required product relations are missing");
        }

        const columns = await tx<{
          column_name: string;
          data_type: string;
          nullable: boolean;
          default_expression: string | null;
        }[]>`
          SELECT
            a.attname AS column_name,
            format_type(a.atttypid, a.atttypmod) AS data_type,
            NOT a.attnotnull AS nullable,
            pg_get_expr(d.adbin, d.adrelid) AS default_expression
          FROM pg_attribute a
          LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
          WHERE a.attrelid = 'public.store_product_attr_value'::regclass
            AND a.attnum > 0
            AND NOT a.attisdropped
            AND a.attname IN ${tx(RETIREMENT_COLUMNS)}
          ORDER BY a.attname
        `;
        const columnNames = new Set(columns.map((row) => row.column_name));
        const retirementColumnsReady = RETIREMENT_COLUMNS.every((name) => columnNames.has(name));

        const [
          sizes,
          skuSummary,
          ownerDistribution,
          productOwnerDistribution,
          identityAnomalies,
          productShape,
        ] = await Promise.all([
          tx<{
            sku_rows: number;
            sku_relation_bytes: string;
            product_rows: number;
            product_relation_bytes: string;
          }[]>`
            SELECT
              (SELECT count(*)::integer FROM store_product_attr_value) AS sku_rows,
              pg_total_relation_size('public.store_product_attr_value')::text AS sku_relation_bytes,
              (SELECT count(*)::integer FROM store_product) AS product_rows,
              pg_total_relation_size('public.store_product')::text AS product_relation_bytes
          `,
          tx<{
            total_skus: number;
            base_skus: number;
            activity_skus: number;
            empty_unique: number;
            empty_suk: number;
            negative_stock: number;
            orphan_base_skus: number;
          }[]>`
            SELECT
              count(*)::integer AS total_skus,
              count(*) FILTER (WHERE v.type = 0)::integer AS base_skus,
              count(*) FILTER (WHERE v.type <> 0)::integer AS activity_skus,
              count(*) FILTER (WHERE v.type = 0 AND btrim(v."unique") = '')::integer AS empty_unique,
              count(*) FILTER (WHERE v.type = 0 AND btrim(v.suk) = '')::integer AS empty_suk,
              count(*) FILTER (WHERE v.stock < 0)::integer AS negative_stock,
              count(*) FILTER (WHERE v.type = 0 AND p.id IS NULL)::integer AS orphan_base_skus
            FROM store_product_attr_value v
            LEFT JOIN store_product p ON p.id = v.product_id
          `,
          tx<{
            owner_type: number;
            relation_zero: boolean;
            product_type: number;
            deleted: boolean;
            products: number;
            skus: number;
          }[]>`
            SELECT
              COALESCE(p.type, -1)::integer AS owner_type,
              COALESCE(p.relation_id, -1) = 0 AS relation_zero,
              COALESCE(p.product_type, -1)::integer AS product_type,
              COALESCE(p.is_del, -1) <> 0 AS deleted,
              count(DISTINCT p.id)::integer AS products,
              count(v.id)::integer AS skus
            FROM store_product_attr_value v
            LEFT JOIN store_product p ON p.id = v.product_id
            WHERE v.type = 0
            GROUP BY 1, 2, 3, 4
            ORDER BY 1, 2, 3, 4
          `,
          tx<{
            owner_type: number;
            relation_zero: boolean;
            product_type: number;
            deleted: boolean;
            owners: number;
            products: number;
            products_with_base_skus: number;
          }[]>`
            SELECT
              p.type::integer AS owner_type,
              p.relation_id = 0 AS relation_zero,
              p.product_type::integer AS product_type,
              p.is_del <> 0 AS deleted,
              count(DISTINCT p.relation_id) FILTER (WHERE p.relation_id > 0)::integer AS owners,
              count(*)::integer AS products,
              count(*) FILTER (WHERE EXISTS (
                SELECT 1
                FROM store_product_attr_value v
                WHERE v.product_id = p.id AND v.type = 0
              ))::integer AS products_with_base_skus
            FROM store_product p
            GROUP BY 1, 2, 3, 4
            ORDER BY 1, 2, 3, 4
          `,
          tx<{
            duplicate_unique_groups: number;
            duplicate_unique_excess_rows: number;
            duplicate_product_suk_groups: number;
            duplicate_product_suk_excess_rows: number;
          }[]>`
            WITH base AS (
              SELECT product_id, btrim("unique") AS unique_value, btrim(suk) AS suk_value
              FROM store_product_attr_value
              WHERE type = 0
            ), duplicate_unique AS (
              SELECT count(*) AS rows
              FROM base
              WHERE unique_value <> ''
              GROUP BY unique_value
              HAVING count(*) > 1
            ), duplicate_product_suk AS (
              SELECT count(*) AS rows
              FROM base
              WHERE suk_value <> ''
              GROUP BY product_id, suk_value
              HAVING count(*) > 1
            )
            SELECT
              (SELECT count(*)::integer FROM duplicate_unique) AS duplicate_unique_groups,
              (SELECT COALESCE(sum(rows - 1), 0)::integer FROM duplicate_unique) AS duplicate_unique_excess_rows,
              (SELECT count(*)::integer FROM duplicate_product_suk) AS duplicate_product_suk_groups,
              (SELECT COALESCE(sum(rows - 1), 0)::integer FROM duplicate_product_suk) AS duplicate_product_suk_excess_rows
          `,
          tx<{
            products_with_base_skus: number;
            single_sku_products: number;
            multi_sku_products: number;
            maximum_skus_per_product: number;
            spec_type_mismatches: number;
          }[]>`
            WITH per_product AS (
              SELECT
                p.id,
                p.spec_type,
                count(v.id)::integer AS sku_count
              FROM store_product p
              INNER JOIN store_product_attr_value v ON v.product_id = p.id AND v.type = 0
              GROUP BY p.id, p.spec_type
            )
            SELECT
              count(*)::integer AS products_with_base_skus,
              count(*) FILTER (WHERE sku_count = 1)::integer AS single_sku_products,
              count(*) FILTER (WHERE sku_count > 1)::integer AS multi_sku_products,
              COALESCE(max(sku_count), 0)::integer AS maximum_skus_per_product,
              count(*) FILTER (
                WHERE (spec_type = 0 AND sku_count <> 1) OR (spec_type = 1 AND sku_count < 1)
              )::integer AS spec_type_mismatches
            FROM per_product
          `,
        ]);

        const [constraintRows, indexRows, triggerRows, functionRows] = await Promise.all([
          tx<{ name: string; validated: boolean; definition: string }[]>`
            SELECT conname AS name, convalidated AS validated, pg_get_constraintdef(oid, true) AS definition
            FROM pg_constraint
            WHERE conrelid = 'public.store_product_attr_value'::regclass
              AND conname = 'spav_is_retired_ck'
          `,
          tx<{ name: string; valid: boolean; ready: boolean; definition: string }[]>`
            SELECT c.relname AS name, i.indisvalid AS valid, i.indisready AS ready, pg_get_indexdef(i.indexrelid) AS definition
            FROM pg_index i
            INNER JOIN pg_class c ON c.oid = i.indexrelid
            WHERE i.indrelid IN (
              'public.store_product_attr_value'::regclass,
              to_regclass('public.store_product_sku_retirement_log')
            )
              AND c.relname IN ('spav_product_active', 'spsrl_product_time', 'spsrl_sku_time')
            ORDER BY c.relname
          `,
          tx<{ name: string; enabled: string; definition: string }[]>`
            SELECT tgname AS name, tgenabled AS enabled, pg_get_triggerdef(oid, true) AS definition
            FROM pg_trigger
            WHERE tgrelid = 'public.store_product_attr_value'::regclass
              AND NOT tgisinternal
              AND tgname = 'store_product_attr_value_retired_guard'
          `,
          tx<{ present: boolean }[]>`
            SELECT to_regprocedure('public.guard_retired_product_sku()') IS NOT NULL AS present
          `,
        ]);

        const references: Record<string, number | null> = {};
        references.open_carts = relations.store_cart
          ? Number((await tx<{ value: number }[]>`
              SELECT count(*)::integer AS value
              FROM store_cart c
              INNER JOIN store_product_attr_value v
                ON v.product_id = c.product_id AND v.type = 0 AND v."unique" = c.product_attr_unique
              WHERE c.is_pay = 0 AND c.is_del = 0
            `)[0]?.value ?? 0)
          : null;
        references.open_orders = relations.store_order && relations.store_order_cart_info
          ? Number((await tx<{ value: number }[]>`
              SELECT count(*)::integer AS value
              FROM store_order_cart_info ci
              INNER JOIN store_order o ON o.id = ci.oid
              INNER JOIN store_product_attr_value v
                ON v.product_id = ci.product_id AND v.type = 0 AND v."unique" = ci.sku_unique
              WHERE o.paid = 0 AND o.status = 0 AND o.is_del = 0
            `)[0]?.value ?? 0)
          : null;
        references.order_history = relations.store_order_cart_info
          ? Number((await tx<{ value: number }[]>`
              SELECT count(*)::integer AS value
              FROM store_order_cart_info ci
              INNER JOIN store_product_attr_value v
                ON v.product_id = ci.product_id AND v.type = 0 AND v."unique" = ci.sku_unique
            `)[0]?.value ?? 0)
          : null;
        references.review_history = relations.store_product_reply
          ? Number((await tx<{ value: number }[]>`
              SELECT count(*)::integer AS value
              FROM store_product_reply r
              INNER JOIN store_product_attr_value v
                ON v.product_id = r.product_id AND v.type = 0 AND v."unique" = r.sku_unique
            `)[0]?.value ?? 0)
          : null;
        references.stock_history = relations.store_product_stock_record
          ? Number((await tx<{ value: number }[]>`
              SELECT count(*)::integer AS value
              FROM store_product_stock_record r
              INNER JOIN store_product_attr_value v
                ON v.product_id = r.product_id AND v.type = 0 AND v."unique" = r."unique"
            `)[0]?.value ?? 0)
          : null;
        references.virtual_inventory = relations.store_product_virtual
          ? Number((await tx<{ value: number }[]>`
              SELECT count(*)::integer AS value
              FROM store_product_virtual vi
              INNER JOIN store_product_attr_value v
                ON v.product_id = vi.product_id AND v.type = 0 AND v."unique" = vi.attr_unique
            `)[0]?.value ?? 0)
          : null;
        references.branch_skus = relations.store_branch_product_attr_value
          ? Number((await tx<{ value: number }[]>`
              SELECT count(*)::integer AS value
              FROM store_branch_product_attr_value b
              INNER JOIN store_product_attr_value v
                ON v.product_id = b.product_id AND v.type = 0 AND v."unique" = b."unique"
            `)[0]?.value ?? 0)
          : null;
        references.promotion_relations = relations.store_promotions_auxiliary
          ? Number((await tx<{ value: number }[]>`
              SELECT count(*)::integer AS value
              FROM store_promotions_auxiliary a
              INNER JOIN store_product_attr_value v
                ON v.product_id = a.product_id AND v.type = 0 AND v."unique" = a."unique"
            `)[0]?.value ?? 0)
          : null;
        references.lottery_prizes = relations.luck_prize
          ? Number((await tx<{ value: number }[]>`
              SELECT count(*)::integer AS value
              FROM luck_prize l
              INNER JOIN store_product_attr_value v
                ON v.product_id = l.product_id AND v.type = 0 AND v."unique" = l."unique"
              WHERE l.is_del = 0
            `)[0]?.value ?? 0)
          : null;

        const retiredRows = retirementColumnsReady
          ? await tx<{ retired_skus: number; malformed_retirement_rows: number }[]>`
              SELECT
                count(*) FILTER (WHERE is_retired = 1)::integer AS retired_skus,
                count(*) FILTER (
                  WHERE (is_retired = 0 AND (retired_at <> 0 OR retired_by <> 0 OR retire_reason <> ''))
                    OR (is_retired = 1 AND (retired_at <= 0 OR btrim(retire_reason) = ''))
                )::integer AS malformed_retirement_rows
              FROM store_product_attr_value
            `
          : [];

        const skuRows = Number(sizes[0]?.sku_rows ?? 0);
        const skuBytes = Number(sizes[0]?.sku_relation_bytes ?? 0);
        return {
          server_version: version[0]?.server_version ?? "unknown",
          transaction_mode: "read only",
          relations,
          migration_state: {
            columns,
            retirement_columns_ready: retirementColumnsReady,
            log_table_present: Boolean(relations.store_product_sku_retirement_log),
            constraints: constraintRows,
            indexes: indexRows,
            triggers: triggerRows,
            guard_function_present: Boolean(functionRows[0]?.present),
            retired_rows: retiredRows[0] ?? null,
          },
          size: sizes[0] ?? null,
          sku_summary: skuSummary[0] ?? null,
          owner_distribution: ownerDistribution,
          product_owner_distribution: productOwnerDistribution,
          identity_anomalies: identityAnomalies[0] ?? null,
          product_shape: productShape[0] ?? null,
          reference_aggregates: references,
          bounded_migration_preconditions: {
            sku_rows_at_most_100000: skuRows <= 100_000,
            sku_relation_at_most_64_mib: skuBytes <= 64 * 1024 * 1024,
            required_relations_present: Boolean(relations.store_product && relations.store_product_attr_value),
          },
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
