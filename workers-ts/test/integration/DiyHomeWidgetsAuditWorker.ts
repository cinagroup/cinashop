import { sql } from "drizzle-orm";
import postgres from "postgres";
import type { Env } from "../../src/env";
import {
  createContainerFromDb,
  createDbFromConnectionString,
  type DbClient,
} from "../../src/lib/di";
import { USER_CENTER_COMPATIBILITY_INDEX_SQL } from "../../src/migrations/userCenterCompatibility";
import { DiyHomeCompatibilityService } from "../../src/services/content/DiyHomeCompatibilityService";
import {
  createDiyHomeAuditRuntimeEnv,
  DIY_HOME_PUBLIC_TABLES,
  DIY_HOME_SCHEMA_PREFIX,
  DIY_HOME_SUPPORT_TABLES,
  runDiyHomeWidgetsCompatibilityScenario,
} from "./DiyHomeWidgetsCompatibilityScenario";

interface AuditEnv extends Env {
  AUDIT_TOKEN_SHA256: string;
}

export const DIY_HOME_CONFIG_KEYS = [
  "station_open",
  "routine_contact_type",
  "image_thumb_status",
  "image_watermark_status",
  "thumb_big_width",
  "thumb_big_height",
  "thumb_mid_width",
  "thumb_mid_height",
  "thumb_small_width",
  "thumb_small_height",
  "watermark_type",
  "watermark_text",
  "watermark_text_angle",
  "watermark_text_color",
  "watermark_text_size",
  "watermark_position",
  "watermark_image",
  "watermark_opacity",
  "watermark_rotate",
  "watermark_x",
  "watermark_y",
  "upload_type",
  "site_url",
  "video_func_status",
  "site_name",
  "wap_login_logo",
  "newcomer_status",
  "register_integral_status",
  "register_give_integral",
  "register_coupon_status",
  "register_give_coupon",
  "register_price_status",
  "newcomer_limit_status",
  "newcomer_limit_time",
  "member_card_status",
  "svip_price_status",
  "sign_give_point",
  "member_func_status",
  "sign_give_exp",
  "sign_status",
] as const;

interface ProductionAuditResult {
  complete: boolean;
  report: Record<string, unknown>;
}

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`DIY-HOME-WIDGETS production audit failed: ${message}`);
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

function contractShape(value: unknown): Record<string, unknown> {
  if (Array.isArray(value)) {
    const first = value[0];
    return {
      kind: "array",
      length: value.length,
      itemKeys: first !== null && typeof first === "object" && !Array.isArray(first)
        ? Object.keys(first).sort()
        : [],
    };
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const collectionLengths = Object.fromEntries(
      Object.entries(record)
        .filter((entry): entry is [string, unknown[]] => Array.isArray(entry[1]))
        .map(([key, items]) => [key, items.length]),
    );
    return {
      kind: "object",
      keys: Object.keys(record).sort(),
      collectionLengths,
    };
  }
  return { kind: value === null ? "null" : typeof value };
}

async function productionAggregates(connectionString: string): Promise<ProductionAuditResult> {
  const client = postgres(connectionString, {
    max: 1,
    prepare: false,
    connect_timeout: 10,
    idle_timeout: 5,
    connection: { application_name: "cinashop_diy_home_widgets_read_only_audit" },
  });
  try {
    return await client.begin(async (tx) => {
      await tx`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`;
      await tx`SET LOCAL search_path TO public, pg_temp`;
      await tx`SET LOCAL statement_timeout = '45s'`;
      await tx`SET LOCAL lock_timeout = '2s'`;

      const requiredTables = [...DIY_HOME_PUBLIC_TABLES, ...DIY_HOME_SUPPORT_TABLES];
      const catalog = await tx<Array<{ table_name: string }>>`
        SELECT relation.relname AS table_name
        FROM pg_class AS relation
        JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = 'public'
          AND relation.relkind IN ('r', 'p')
          AND relation.relname IN ${tx(requiredTables)}
        ORDER BY relation.relname
      `;
      const present = new Set(catalog.map((row) => row.table_name));
      const missingTables = DIY_HOME_PUBLIC_TABLES.filter((table) => !present.has(table));
      const missingSupportTables = DIY_HOME_SUPPORT_TABLES.filter((table) => !present.has(table));
      const namespaceRows = await tx<Array<{ count: number }>>`
        SELECT count(*)::integer AS count
        FROM pg_namespace
        WHERE starts_with(nspname, ${DIY_HOME_SCHEMA_PREFIX})
      `;
      const catalogState = {
        expectedTableCount: DIY_HOME_PUBLIC_TABLES.length,
        presentTableCount: DIY_HOME_PUBLIC_TABLES.length - missingTables.length,
        missingTables,
        supportTableCount: DIY_HOME_SUPPORT_TABLES.length,
        presentSupportTableCount: DIY_HOME_SUPPORT_TABLES.length - missingSupportTables.length,
        missingSupportTables,
        temporarySchemaCount: Number(namespaceRows[0]?.count ?? -1),
      };
      if (missingTables.length > 0 || missingSupportTables.length > 0) {
        return {
          complete: false,
          report: {
            catalog: catalogState,
            dataAuditSkipped: true,
            guarantees: {
              transaction: "REPEATABLE READ, READ ONLY",
              searchPath: "public, pg_temp (pg_temp last)",
              configurationValuesReturned: false,
              piiReturned: false,
              businessIdsReturned: false,
              mediaReferencesReturned: false,
              dmlOrDdlExecuted: false,
            },
          },
        };
      }

      const resolution = await tx<Array<{
        schema_name: string;
        configured_path: string;
        resolved_schema: string | null;
      }>>`
        SELECT
          current_schema() AS schema_name,
          current_setting('search_path') AS configured_path,
          (
            SELECT namespace.nspname
            FROM pg_class AS relation
            JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
            WHERE relation.oid = to_regclass('system_dise')
          ) AS resolved_schema
      `;
      invariant(
        resolution[0]?.schema_name === "public"
          && resolution[0]?.configured_path === "public, pg_temp"
          && resolution[0]?.resolved_schema === "public",
        "production audit was not pinned to public with pg_temp last",
      );

      const [diyRows, configRows, userRows, couponRows, relationRows] = await Promise.all([
        tx<Array<Record<string, unknown>>>`
          SELECT
            count(*)::integer AS total_rows,
            count(*) FILTER (WHERE status = 1 AND type = 1 AND is_diy = 1)::integer
              AS active_home_candidates,
            count(*) FILTER (
              WHERE status = 1 AND type = 1 AND is_diy = 1 AND template_name = 'default'
            )::integer AS default_home_candidates,
            count(*) FILTER (WHERE type = 3 AND template_name = 'suspended_window')::integer
              AS suspended_candidates,
            (SELECT count(*)::integer FROM (
              SELECT template_name, type
              FROM system_dise
              GROUP BY template_name, type
              HAVING count(*) > 1
            ) AS duplicate_scopes) AS duplicate_template_type_scopes,
            count(*) FILTER (
              WHERE value IS NULL OR NOT (value IS JSON)
            )::integer AS invalid_json_rows,
            count(*) FILTER (
              WHERE value IS JSON AND NOT (value IS JSON ARRAY) AND type = 1
            )::integer AS non_array_home_json_rows,
            count(*) FILTER (WHERE octet_length(COALESCE(value, '')) > 2000000)::integer
              AS oversized_json_rows,
            count(*) FILTER (
              WHERE status = 1 AND type = 1 AND is_diy = 1 AND NULLIF(btrim(version), '') IS NULL
            )::integer AS active_home_blank_versions,
            count(*) FILTER (
              WHERE status = 1 AND type = 1 AND is_diy = 1 AND is_del <> 0
            )::integer AS selectable_soft_deleted_rows
          FROM system_dise
        `,
        tx<Array<{
          menu_name: string;
          rows: number;
          nonempty_rows: number;
          numeric_like_rows: number;
          json_rows: number;
          enabled_rows: number;
          bounded_dimension_rows: number;
        }>>`
          SELECT menu_name,
                 count(*)::integer AS rows,
                 count(*) FILTER (WHERE NULLIF(btrim(value), '') IS NOT NULL)::integer
                   AS nonempty_rows,
                 count(*) FILTER (
                   WHERE btrim(value) ~ '^"?-?[0-9]+([.][0-9]+)?"?$'
                 )::integer AS numeric_like_rows,
                 count(*) FILTER (WHERE value IS JSON)::integer AS json_rows,
                 count(*) FILTER (
                   WHERE lower(btrim(value)) IN ('1', '"1"', 'true', '"true"')
                 )::integer AS enabled_rows,
                 count(*) FILTER (
                   WHERE CASE
                     WHEN btrim(value) ~ '^"?[0-9]+"?$'
                       THEN btrim(value, '"')::numeric BETWEEN 1 AND 2048
                     ELSE false
                   END
                 )::integer AS bounded_dimension_rows
          FROM system_config
          WHERE is_store = 0 AND menu_name IN ${tx(DIY_HOME_CONFIG_KEYS)}
          GROUP BY menu_name
          ORDER BY menu_name
        `,
        tx<Array<Record<string, unknown>>>`
          SELECT
            count(*)::integer AS total_users,
            count(*) FILTER (WHERE is_del = 0 AND delete_time IS NULL AND status = 1)::integer
              AS active_users,
            count(*) FILTER (
              WHERE account.level > 0 AND NOT EXISTS (
                SELECT 1 FROM system_user_level level WHERE level.id = account.level
              )
            )::integer AS missing_level_references,
            count(*) FILTER (
              WHERE account.level > 0 AND EXISTS (
                SELECT 1 FROM system_user_level level
                WHERE level.id = account.level AND (level.is_del <> 0 OR level.is_show <> 1)
              )
            )::integer AS hidden_level_references,
            (SELECT count(*)::integer FROM system_user_level
              WHERE is_del = 0 AND is_show = 1) AS visible_levels,
            (SELECT count(*)::integer FROM (
              SELECT grade FROM system_user_level
              WHERE is_del = 0 AND is_show = 1
              GROUP BY grade HAVING count(*) > 1
            ) AS duplicate_grades) AS duplicate_visible_level_grades,
            (SELECT count(*)::integer FROM (
              SELECT exp_num, lag(exp_num) OVER (ORDER BY grade, id) AS previous_exp
              FROM system_user_level WHERE is_del = 0 AND is_show = 1
            ) AS ordered_levels WHERE previous_exp IS NOT NULL AND exp_num < previous_exp)
              AS nonmonotonic_level_thresholds,
            count(*) FILTER (
              WHERE is_del = 0 AND delete_time IS NULL AND status = 1 AND is_newcomer = 0
            )::integer AS active_newcomer_flag_candidates
          FROM "user" AS account
        `,
        tx<Array<Record<string, unknown>>>`
          SELECT
            count(*)::integer AS user_coupon_rows,
            count(*) FILTER (WHERE status = 0 AND (end_time IS NULL OR end_time >= CURRENT_TIMESTAMP))::integer
              AS usable_coupon_rows,
            count(*) FILTER (WHERE status = 0 AND end_time < CURRENT_TIMESTAMP)::integer
              AS expired_still_usable_rows,
            count(*) FILTER (
              WHERE NOT EXISTS (SELECT 1 FROM "user" account WHERE account.uid = coupon.uid)
            )::integer AS owner_orphans,
            count(*) FILTER (
              WHERE issue_coupon_id > 0 AND NOT EXISTS (
                SELECT 1 FROM store_coupon_issue issue WHERE issue.id = coupon.issue_coupon_id
              )
            )::integer AS issue_orphans,
            (SELECT count(*)::integer FROM store_coupon_issue) AS issue_rows,
            (SELECT count(*) FILTER (
              WHERE status = 1 AND is_del = 0
                AND (start_time IS NULL OR start_time <= CURRENT_TIMESTAMP)
                AND (end_time IS NULL OR end_time >= CURRENT_TIMESTAMP)
            )::integer FROM store_coupon_issue) AS active_issue_rows
          FROM store_coupon_user AS coupon
        `,
        tx<Array<Record<string, unknown>>>`
          SELECT
            count(*)::integer AS relation_rows,
            count(*) FILTER (WHERE type = 'collect' AND category = 'product')::integer
              AS product_collect_rows,
            count(*) FILTER (WHERE type = 'collect' AND category = 'video')::integer
              AS video_collect_rows,
            (SELECT count(*)::integer FROM (
              SELECT uid, relation_id, type, category
              FROM user_relation
              WHERE type <> 'play'
              GROUP BY uid, relation_id, type, category
              HAVING count(*) > 1
            ) AS duplicate_relations) AS duplicate_relation_groups,
            count(*) FILTER (
              WHERE NOT EXISTS (SELECT 1 FROM "user" account WHERE account.uid = relation.uid)
            )::integer AS owner_orphans,
            count(*) FILTER (
              WHERE type = 'collect' AND category = 'product'
                AND NOT EXISTS (SELECT 1 FROM store_product product WHERE product.id = relation.relation_id)
            )::integer AS product_target_orphans,
            count(*) FILTER (
              WHERE type = 'collect' AND category = 'video'
                AND NOT EXISTS (SELECT 1 FROM video item WHERE item.id = relation.relation_id)
            )::integer AS video_target_orphans,
            (SELECT count(*)::integer FROM store_product_log WHERE type = 'visit') AS visit_log_rows,
            (SELECT count(*)::integer FROM (
              SELECT uid, product_id FROM store_product_log
              WHERE type = 'visit' AND delete_time IS NULL
              GROUP BY uid, product_id
            ) AS distinct_visits) AS distinct_visit_owner_products,
            (SELECT count(*)::integer FROM store_product_log
              WHERE type = 'visit' AND delete_time IS NOT NULL) AS soft_deleted_visit_rows,
            (SELECT count(*)::integer FROM store_product_log log
              WHERE type = 'visit' AND NOT EXISTS (
                SELECT 1 FROM "user" account WHERE account.uid = log.uid
              )) AS visit_owner_orphans,
            (SELECT count(*)::integer FROM store_product_log log
              WHERE type = 'visit' AND NOT EXISTS (
                SELECT 1 FROM store_product product WHERE product.id = log.product_id
              )) AS visit_product_orphans
          FROM user_relation AS relation
        `,
      ]);

      const [videoRows, productRows, newcomerRows, signRows, promotionRows, indexRows] = await Promise.all([
        tx<Array<Record<string, unknown>>>`
          WITH collect_counts AS (
            SELECT relation_id, count(*)::integer AS count
            FROM user_relation
            WHERE type = 'collect' AND category = 'video'
            GROUP BY relation_id
          ), play_counts AS (
            SELECT relation_id, count(*)::integer AS count
            FROM user_relation
            WHERE type = 'play' AND category = 'video'
            GROUP BY relation_id
          )
          SELECT
            count(*)::integer AS total_rows,
            count(*) FILTER (WHERE is_show = 1 AND is_del = 0 AND is_verify = 1)::integer
              AS visible_reviewed_rows,
            count(*) FILTER (
              WHERE is_show = 1 AND is_del = 0 AND is_verify = 1 AND is_recommend = 1
            )::integer AS visible_recommended_rows,
            count(*) FILTER (WHERE EXISTS (
              SELECT 1 FROM regexp_split_to_table(item.product_id, ',') AS tokens(token)
              WHERE NULLIF(btrim(token), '') IS NOT NULL AND btrim(token) !~ '^[0-9]+$'
            ))::integer AS invalid_product_token_rows,
            count(*) FILTER (WHERE EXISTS (
              SELECT 1 FROM regexp_split_to_table(item.product_id, ',') AS tokens(token)
              WHERE btrim(token) ~ '^[0-9]+$'
                AND NOT EXISTS (
                  SELECT 1 FROM store_product product
                  WHERE product.id = btrim(token)::integer
                    AND product.is_show = 1 AND product.is_del = 0 AND product.is_verify = 1
                )
            ))::integer AS missing_or_invisible_product_reference_rows,
            count(*) FILTER (WHERE collect_num <> COALESCE(collect_counts.count, 0))::integer
              AS collect_counter_drift_rows,
            count(*) FILTER (WHERE play_num <> COALESCE(play_counts.count, 0))::integer
              AS play_counter_drift_rows,
            count(*) FILTER (WHERE NULLIF(btrim(image), '') IS NULL)::integer AS blank_image_rows,
            count(*) FILTER (WHERE NULLIF(btrim(video_url), '') IS NULL)::integer AS blank_video_rows,
            count(*) FILTER (WHERE image LIKE '/%' OR image LIKE 'https://%')::integer
              AS recognized_image_reference_rows,
            count(*) FILTER (WHERE video_url LIKE '/%' OR video_url LIKE 'https://%')::integer
              AS recognized_video_reference_rows,
            (SELECT count(*)::integer FROM live_room
              WHERE is_show = 1 AND is_del = 0 AND status = 1
                AND live_status IN (101, 105, 106)) AS active_live_room_rows
          FROM video AS item
          LEFT JOIN collect_counts ON collect_counts.relation_id = item.id
          LEFT JOIN play_counts ON play_counts.relation_id = item.id
        `,
        tx<Array<Record<string, unknown>>>`
          WITH product_collect AS (
            SELECT relation_id, count(*)::integer AS count
            FROM user_relation
            WHERE type = 'collect' AND category = 'product'
            GROUP BY relation_id
          )
          SELECT
            count(*)::integer AS total_rows,
            count(*) FILTER (
              WHERE pid = 0 AND is_show = 1 AND is_del = 0 AND is_verify = 1
                AND is_vip_product = 0
            )::integer AS anonymous_rank_eligible_rows,
            count(*) FILTER (
              WHERE pid = 0 AND is_show = 1 AND is_del = 0 AND is_verify = 1
            )::integer AS member_rank_eligible_rows,
            count(*) FILTER (
              WHERE sales < 0 OR ficti < 0 OR collect < 0 OR star < 0
            )::integer AS negative_rank_metric_rows,
            count(*) FILTER (WHERE collect <> COALESCE(product_collect.count, 0))::integer
              AS collect_counter_drift_rows,
            count(*) FILTER (
              WHERE brand_id > 0 AND NOT EXISTS (
                SELECT 1 FROM store_brand brand
                WHERE brand.id = product.brand_id AND brand.is_show = 1 AND brand.is_del = 0
              )
            )::integer AS missing_visible_brand_rows,
            count(*) FILTER (WHERE NULLIF(btrim(COALESCE(store_label_id, '')), '') IS NOT NULL)::integer
              AS label_decorated_product_rows,
            (SELECT count(*)::integer FROM store_coupon_product) AS coupon_product_scope_rows,
            (SELECT count(*)::integer FROM store_seckill WHERE is_show = 1 AND is_del = 0 AND status = 1)
              AS active_seckill_rows,
            (SELECT count(*)::integer FROM store_combination WHERE is_show = 1 AND is_del = 0 AND status = 1)
              AS active_combination_rows,
            (SELECT count(*)::integer FROM store_bargain WHERE is_del = 0 AND status = 1)
              AS active_bargain_rows
          FROM store_product AS product
          LEFT JOIN product_collect ON product_collect.relation_id = product.id
        `,
        tx<Array<Record<string, unknown>>>`
          SELECT
            count(*)::integer AS total_rows,
            count(*) FILTER (WHERE is_del = 0)::integer AS active_rows,
            count(*) FILTER (
              WHERE is_del = 0 AND NOT EXISTS (
                SELECT 1 FROM store_product product WHERE product.id = newcomer.product_id
              )
            )::integer AS product_orphans,
            count(*) FILTER (
              WHERE is_del = 0 AND NOT EXISTS (
                SELECT 1 FROM store_product product
                WHERE product.id = newcomer.product_id
                  AND product.pid = 0 AND product.is_show = 1
                  AND product.is_del = 0 AND product.is_verify = 1
              )
            )::integer AS invisible_product_rows,
            (SELECT count(*)::integer FROM (
              SELECT product_id FROM store_newcomer
              WHERE is_del = 0 GROUP BY product_id HAVING count(*) > 1
            ) AS duplicate_products) AS duplicate_active_product_groups,
            count(*) FILTER (WHERE price < 0 OR sales < 0)::integer AS negative_metric_rows,
            (SELECT count(*)::integer FROM store_order
              WHERE type = 7 AND paid = 1 AND is_del = 0 AND is_system_del = 0)
              AS paid_newcomer_order_rows
          FROM store_newcomer AS newcomer
        `,
        tx<Array<Record<string, unknown>>>`
          SELECT
            count(*)::integer AS sign_rows,
            count(*) FILTER (
              WHERE NOT EXISTS (SELECT 1 FROM "user" account WHERE account.uid = sign.uid)
            )::integer AS sign_owner_orphans,
            (SELECT count(*)::integer FROM (
              SELECT uid, ((add_time::bigint + 28800) / 86400) AS shanghai_day
              FROM user_sign
              GROUP BY uid, ((add_time::bigint + 28800) / 86400)
              HAVING count(*) > 1
            ) AS duplicate_days) AS duplicate_shanghai_day_groups,
            count(*) FILTER (
              WHERE add_time >= extract(epoch FROM (
                date_trunc('week', CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai')
                  AT TIME ZONE 'Asia/Shanghai'
              ))::bigint
              AND add_time < extract(epoch FROM (
                (date_trunc('week', CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai') + interval '7 days')
                  AT TIME ZONE 'Asia/Shanghai'
              ))::bigint
            )::integer AS current_shanghai_week_rows,
            (SELECT count(*)::integer FROM system_sign_reward WHERE type = 0)
              AS continuous_reward_rows,
            (SELECT count(*)::integer FROM (
              SELECT days FROM system_sign_reward WHERE type = 0
              GROUP BY days HAVING count(*) > 1
            ) AS duplicate_rewards) AS duplicate_continuous_reward_days,
            (SELECT count(*)::integer FROM system_sign_reward
              WHERE days <= 0 OR point < 0 OR exp < 0) AS invalid_reward_rows
          FROM user_sign AS sign
        `,
        tx<Array<Record<string, unknown>>>`
          SELECT
            (SELECT count(*)::integer FROM store_promotions) AS promotion_rows,
            (SELECT count(*)::integer FROM store_promotions
              WHERE pid = 0 AND status = 1 AND is_del = 0
                AND start_time <= extract(epoch FROM CURRENT_TIMESTAMP)::integer
                AND stop_time >= extract(epoch FROM CURRENT_TIMESTAMP)::integer
            ) AS active_promotions,
            count(*) FILTER (
              WHERE auxiliary.promotions_id > 0 AND NOT EXISTS (
                SELECT 1 FROM store_promotions promotion
                WHERE promotion.id = auxiliary.promotions_id
              )
            )::integer AS promotion_auxiliary_orphans,
            count(*) FILTER (
              WHERE auxiliary.product_id > 0 AND NOT EXISTS (
                SELECT 1 FROM store_product product WHERE product.id = auxiliary.product_id
              )
            )::integer AS promotion_product_orphans,
            (SELECT count(*)::integer FROM member_right
              WHERE right_type = 'vip_price' AND status = 1) AS active_vip_price_right_rows,
            (SELECT count(*)::integer FROM (
              SELECT right_type FROM member_right WHERE status = 1
              GROUP BY right_type HAVING count(*) > 1
            ) AS duplicate_rights) AS duplicate_active_member_right_types
          FROM store_promotions_auxiliary AS auxiliary
        `,
        tx<Array<Record<string, unknown>>>`
          SELECT
            count(indexname)::integer AS index_count,
            count(DISTINCT tablename)::integer AS tables_with_indexes,
            (SELECT COALESCE(sum(pg_total_relation_size(relation.oid)), 0)::bigint
             FROM pg_class AS relation
             JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
             WHERE namespace.nspname = 'public'
               AND relation.relname IN ${tx(requiredTables)}) AS total_relation_bytes,
            (SELECT count(*)::integer FROM store_product_log
              WHERE type = 'visit' AND delete_time IS NULL) AS visit_index_input_rows,
            (SELECT count(*)::integer FROM system_user_level
              WHERE is_del = 0 AND is_show = 1) AS level_index_input_rows,
            (SELECT count(*)::integer FROM store_newcomer WHERE is_del = 0)
              AS newcomer_index_input_rows,
            (SELECT count(*)::integer FROM store_order WHERE type = 7 AND paid = 1)
              AS newcomer_order_index_input_rows,
            (SELECT count(*)::integer FROM store_product
              WHERE pid = 0 AND is_show = 1 AND is_del = 0 AND is_verify = 1)
              AS rank_index_input_rows
          FROM pg_indexes
          WHERE schemaname = 'public' AND tablename IN ${tx(requiredTables)}
        `,
      ]);

      const configByName = new Map(configRows.map((row) => [row.menu_name, row]));
      const configuration = DIY_HOME_CONFIG_KEYS.map((key) => {
        const row = configByName.get(key);
        const rows = Number(row?.rows ?? 0);
        return {
          key,
          rows,
          missing: rows === 0,
          duplicate: rows > 1,
          nonemptyRows: Number(row?.nonempty_rows ?? 0),
          numericLikeRows: Number(row?.numeric_like_rows ?? 0),
          jsonRows: Number(row?.json_rows ?? 0),
          enabledRows: Number(row?.enabled_rows ?? 0),
          boundedDimensionRows: Number(row?.bounded_dimension_rows ?? 0),
        };
      });
      return {
        complete: true,
        report: {
          catalog: catalogState,
          diy: diyRows[0],
          configuration,
          usersAndLevels: userRows[0],
          coupons: couponRows[0],
          relationsAndVisits: relationRows[0],
          videosAndLive: videoRows[0],
          productsAndRank: productRows[0],
          newcomer: newcomerRows[0],
          signAndRewards: signRows[0],
          promotionsAndMembership: promotionRows[0],
          indexPreconditions: {
            ...indexRows[0],
            ddlRecommendedByThisAudit: false,
            requiresPostImportExplainAnalyze: true,
          },
          guarantees: {
            transaction: "REPEATABLE READ, READ ONLY",
            searchPath: "public, pg_temp (pg_temp last)",
            configurationValuesReturned: false,
            piiReturned: false,
            businessIdsReturned: false,
            mediaReferencesReturned: false,
            dmlOrDdlExecuted: false,
          },
        },
      };
    });
  } finally {
    await client.end({ timeout: 1 });
  }
}

async function withProductionService<T>(
  db: DbClient,
  env: Env,
  action: (service: DiyHomeCompatibilityService) => Promise<T>,
): Promise<T> {
  return db.transaction(async (rawTx) => {
    const tx: DbClient = Object.assign(rawTx, { $client: db.$client });
    await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
    await tx.execute(sql`SET LOCAL search_path TO public, pg_temp`);
    await tx.execute(sql`SET LOCAL statement_timeout = '30s'`);
    await tx.execute(sql`SET LOCAL lock_timeout = '2s'`);
    const current = await tx.execute(sql<{
      schema_name: string;
      configured_path: string;
      resolved_schema: string | null;
    }>`
      SELECT
        current_schema() AS schema_name,
        current_setting('search_path') AS configured_path,
        (
          SELECT namespace.nspname
          FROM pg_class AS relation
          JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
          WHERE relation.oid = to_regclass('system_dise')
        ) AS resolved_schema
    `);
    invariant(
      current[0]?.schema_name === "public"
        && current[0]?.configured_path === "public, pg_temp"
        && current[0]?.resolved_schema === "public",
      "service transaction was not pinned to public with pg_temp last",
    );
    return action(new DiyHomeCompatibilityService(
      createContainerFromDb(tx),
      createDiyHomeAuditRuntimeEnv(env),
    ));
  });
}

/**
 * Invoke every read-only core service contract against production, but return
 * only structural keys and collection lengths. No scalar business value,
 * identifier, PII, configuration value, or media reference crosses the audit
 * response boundary.
 */
async function productionServiceContracts(
  connectionString: string,
  env: Env,
): Promise<Record<string, unknown>> {
  const db = createDbFromConnectionString(connectionString, 2, {
    applicationName: "cinashop_diy_home_widgets_read_only_services",
  });
  try {
    const output: Record<string, unknown> = {};
    output.getDiy = contractShape(await withProductionService(db, env, (service) => service.getDiy(0)));
    output.diyVersion = contractShape(
      await withProductionService(db, env, (service) => service.diyVersion(0)),
    );
    output.userInfo = contractShape(
      await withProductionService(db, env, (service) => service.userInfo(0)),
    );
    output.videoList = contractShape(await withProductionService(
      db,
      env,
      (service) => service.videoList(0, { page: "1", limit: "3" }),
    ));
    output.newcomerList = contractShape(await withProductionService(
      db,
      env,
      (service) => service.newcomerList(0, {
        page: "1",
        limit: "3",
        priceOrder: "",
        salesOrder: "",
      }),
    ));
    output.productRank = contractShape(
      await withProductionService(db, env, (service) => service.productRank(0, 3)),
    );
    output.homeSign = contractShape(
      await withProductionService(db, env, (service) => service.homeSign(0)),
    );
    output.suspended = contractShape(
      await withProductionService(db, env, (service) => service.suspended()),
    );
    return output;
  } finally {
    await db.$client.end({ timeout: 1 });
  }
}

async function runProductionAudit(env: AuditEnv): Promise<Record<string, unknown>> {
  const aggregate = await productionAggregates(env.HYPERDRIVE.connectionString);
  if (!aggregate.complete) return aggregate.report;
  return {
    ...aggregate.report,
    serviceContracts: await productionServiceContracts(env.HYPERDRIVE.connectionString, env),
  };
}

async function applyUserCenterIndexes(connectionString: string): Promise<Record<string, unknown>> {
  const client = postgres(connectionString, {
    max: 1,
    prepare: false,
    connect_timeout: 10,
    idle_timeout: 5,
    connection: { application_name: "cinashop_diy_home_widgets_index_migration" },
  });
  try {
    return await client.begin(async (tx) => {
      await tx`SET LOCAL search_path TO public, pg_temp`;
      await tx`SET LOCAL statement_timeout = '30s'`;
      await tx`SET LOCAL lock_timeout = '5s'`;
      await tx`SELECT pg_advisory_xact_lock(731625, 105)`;

      const resolution = await tx<Array<{
        schema_name: string;
        configured_path: string;
        resolved_schema: string | null;
      }>>`
        SELECT
          current_schema() AS schema_name,
          current_setting('search_path') AS configured_path,
          (
            SELECT namespace.nspname
            FROM pg_class AS relation
            JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
            WHERE relation.oid = to_regclass('user_relation')
          ) AS resolved_schema
      `;
      invariant(
        resolution[0]?.schema_name === "public"
          && resolution[0]?.configured_path === "public, pg_temp"
          && resolution[0]?.resolved_schema === "public",
        "index migration was not pinned to public with pg_temp last",
      );

      const snapshot = async () => {
        const rows = await tx<Array<Record<string, unknown>>>`
          SELECT
            (SELECT count(*)::integer FROM user_address) AS address_rows,
            (SELECT count(*)::integer FROM user_relation) AS relation_rows,
            (SELECT count(*)::integer FROM user_sign) AS sign_rows,
            (SELECT md5(COALESCE(string_agg(
               md5(to_jsonb(address_row)::text), '' ORDER BY address_row.id
             ), '')) FROM user_address AS address_row) AS address_fingerprint,
            (SELECT md5(COALESCE(string_agg(
               md5(to_jsonb(relation_row)::text), '' ORDER BY relation_row.id
             ), '')) FROM user_relation AS relation_row) AS relation_fingerprint,
            (SELECT md5(COALESCE(string_agg(
               md5(to_jsonb(sign_row)::text), '' ORDER BY sign_row.id
             ), '')) FROM user_sign AS sign_row) AS sign_fingerprint
        `;
        invariant(rows[0], "could not fingerprint index input tables");
        return rows[0];
      };

      const duplicateRows = await tx<Array<{
        non_play_relation_groups: number;
        shanghai_sign_day_groups: number;
      }>>`
        SELECT
          (SELECT count(*)::integer FROM (
             SELECT uid, relation_id, type, category
             FROM user_relation
             WHERE type <> 'play'
             GROUP BY uid, relation_id, type, category
             HAVING count(*) > 1
           ) duplicates) AS non_play_relation_groups,
          (SELECT count(*)::integer FROM (
             SELECT uid, ((add_time::bigint + 28800) / 86400) AS shanghai_day
             FROM user_sign
             GROUP BY uid, ((add_time::bigint + 28800) / 86400)
             HAVING count(*) > 1
           ) duplicates) AS shanghai_sign_day_groups
      `;
      invariant(
        Number(duplicateRows[0]?.non_play_relation_groups ?? -1) === 0,
        "duplicate non-play user_relation rows block the partial unique index",
      );
      invariant(
        Number(duplicateRows[0]?.shanghai_sign_day_groups ?? -1) === 0,
        "duplicate Shanghai-day user_sign rows block the unique index",
      );

      const before = await snapshot();
      await tx.unsafe(USER_CENTER_COMPATIBILITY_INDEX_SQL);
      await tx.unsafe(USER_CENTER_COMPATIBILITY_INDEX_SQL);
      const after = await snapshot();
      invariant(JSON.stringify(before) === JSON.stringify(after), "business rows changed while applying indexes");

      const indexes = await tx<Array<{ index_name: string }>>`
        SELECT indexname AS index_name
        FROM pg_indexes
        WHERE schemaname = 'public'
          AND indexname IN (
            'ua_uid_idx', 'ur_uid_rel_type_cat_idx',
            'ur_uid_type_idx', 'ur_collect_category_relation_idx',
            'us_uid_time_idx', 'us_uid_shanghai_day_uq'
          )
        ORDER BY indexname
      `;
      invariant(indexes.length === 6, "user-center index set was not fully installed");
      return {
        applied: true,
        replayed: true,
        inputRowCounts: {
          userAddress: Number(before.address_rows),
          userRelation: Number(before.relation_rows),
          userSign: Number(before.sign_rows),
        },
        verifiedIndexCount: indexes.length,
        guarantees: {
          dmlExecuted: false,
          businessRowsUnchanged: true,
          exactDefinitionsVerifiedByMigration: true,
          migrationReplaySucceeded: true,
          fingerprintsReturned: false,
          businessIdsReturned: false,
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
      || !["/audit", "/apply-user-center-indexes", "/isolated-scenario"].includes(url.pathname)
    ) {
      return Response.json({ error: "not found" }, { status: 404 });
    }
    if (!(await authorized(request, env.AUDIT_TOKEN_SHA256))) {
      return Response.json({ error: "forbidden" }, { status: 403 });
    }
    try {
      const result = url.pathname === "/isolated-scenario"
        ? await runDiyHomeWidgetsCompatibilityScenario(env.HYPERDRIVE.connectionString, env)
        : url.pathname === "/apply-user-center-indexes"
          ? await applyUserCenterIndexes(env.HYPERDRIVE.connectionString)
          : await runProductionAudit(env);
      return Response.json(result, {
        headers: { "Cache-Control": "private, no-store" },
      });
    } catch (error) {
      console.error(JSON.stringify({
        message: "DIY-HOME-WIDGETS audit request failed",
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
