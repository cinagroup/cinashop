import { createContainerFromDb, createDbFromConnectionString } from "@/lib/di";
import { runStoreOrderCreatePostgresScenario } from "./StoreOrderCreatePostgresScenario";
import { runStoreOrderPaymentCancelPostgresScenario } from "./StoreOrderPaymentCancelPostgresScenario";
import { runStoreOrderRefundPostgresScenario } from "./StoreOrderRefundPostgresScenario";
import { MigrationService } from "@/services/MigrationService";

type AuditEnv = Pick<WorkerBindings, "HYPERDRIVE"> & {
  AUDIT_TOKEN_SHA256: string;
};

const BUSINESS_FINGERPRINT_SQL = `
  SELECT jsonb_build_object(
    'user', (SELECT jsonb_build_object('rows', count(*)::text,
      'digest', md5(coalesce(sum(hashtextextended(to_jsonb(t)::text, 0)::numeric)::text, '')))
      FROM public."user" t),
    'store_order', (SELECT jsonb_build_object('rows', count(*)::text,
      'digest', md5(coalesce(sum(hashtextextended(to_jsonb(t)::text, 0)::numeric)::text, '')))
      FROM public.store_order t),
    'store_order_cart_info', (SELECT jsonb_build_object('rows', count(*)::text,
      'digest', md5(coalesce(sum(hashtextextended(to_jsonb(t)::text, 0)::numeric)::text, '')))
      FROM public.store_order_cart_info t),
    'store_cart', (SELECT jsonb_build_object('rows', count(*)::text,
      'digest', md5(coalesce(sum(hashtextextended(to_jsonb(t)::text, 0)::numeric)::text, '')))
      FROM public.store_cart t),
    'store_product', (SELECT jsonb_build_object('rows', count(*)::text,
      'digest', md5(coalesce(sum(hashtextextended(to_jsonb(t)::text, 0)::numeric)::text, '')))
      FROM public.store_product t),
    'store_product_attr_value', (SELECT jsonb_build_object('rows', count(*)::text,
      'digest', md5(coalesce(sum(hashtextextended(to_jsonb(t)::text, 0)::numeric)::text, '')))
      FROM public.store_product_attr_value t),
    'store_seckill', (SELECT jsonb_build_object('rows', count(*)::text,
      'digest', md5(coalesce(sum(hashtextextended(to_jsonb(t)::text, 0)::numeric)::text, '')))
      FROM public.store_seckill t),
    'store_bargain', (SELECT jsonb_build_object('rows', count(*)::text,
      'digest', md5(coalesce(sum(hashtextextended(to_jsonb(t)::text, 0)::numeric)::text, '')))
      FROM public.store_bargain t),
    'store_bargain_user', (SELECT jsonb_build_object('rows', count(*)::text,
      'digest', md5(coalesce(sum(hashtextextended(to_jsonb(t)::text, 0)::numeric)::text, '')))
      FROM public.store_bargain_user t),
    'store_combination', (SELECT jsonb_build_object('rows', count(*)::text,
      'digest', md5(coalesce(sum(hashtextextended(to_jsonb(t)::text, 0)::numeric)::text, '')))
      FROM public.store_combination t),
    'store_pink', (SELECT jsonb_build_object('rows', count(*)::text,
      'digest', md5(coalesce(sum(hashtextextended(to_jsonb(t)::text, 0)::numeric)::text, '')))
      FROM public.store_pink t),
    'store_integral', (SELECT jsonb_build_object('rows', count(*)::text,
      'digest', md5(coalesce(sum(hashtextextended(to_jsonb(t)::text, 0)::numeric)::text, '')))
      FROM public.store_integral t),
    'store_coupon_issue', (SELECT jsonb_build_object('rows', count(*)::text,
      'digest', md5(coalesce(sum(hashtextextended(to_jsonb(t)::text, 0)::numeric)::text, '')))
      FROM public.store_coupon_issue t),
    'store_coupon_user', (SELECT jsonb_build_object('rows', count(*)::text,
      'digest', md5(coalesce(sum(hashtextextended(to_jsonb(t)::text, 0)::numeric)::text, '')))
      FROM public.store_coupon_user t),
    'store_order_refund', (SELECT jsonb_build_object('rows', count(*)::text,
      'digest', md5(coalesce(sum(hashtextextended(to_jsonb(t)::text, 0)::numeric)::text, '')))
      FROM public.store_order_refund t),
    'system_config', (SELECT jsonb_build_object('rows', count(*)::text,
      'digest', md5(coalesce(sum(hashtextextended(to_jsonb(t)::text, 0)::numeric)::text, '')))
      FROM public.system_config t),
    'sequences', (SELECT coalesce(jsonb_object_agg(sequencename, last_value ORDER BY sequencename), '{}'::jsonb)
      FROM pg_sequences WHERE schemaname = 'public'
        AND sequencename <> 'store_order_product_coupon_reward_id_seq')
  )::text AS fingerprint
`;

async function rewardMigrationState(connectionString: string) {
  const db = createDbFromConnectionString(connectionString, 1, {
    applicationName: "cinashop_api002_reward_migration_state",
  });
  try {
    return await db.$client.begin(async (tx) => {
      await tx`SET LOCAL search_path TO public`;
      await tx`SET TRANSACTION READ ONLY`;
      const catalog = await tx<Array<Record<string, unknown>>>`
        SELECT
          (SELECT count(*)::int FROM information_schema.tables
            WHERE table_schema = 'public' AND table_type = 'BASE TABLE') AS tables,
          (SELECT count(*)::int FROM information_schema.columns
            WHERE table_schema = 'public') AS columns,
          (SELECT count(*)::int FROM pg_indexes WHERE schemaname = 'public') AS indexes,
          (SELECT count(*)::int FROM pg_constraint
            WHERE contype = 'p' AND connamespace = 'public'::regnamespace) AS primary_keys
      `;
      const target = await tx<Array<Record<string, unknown>>>`
        SELECT
          to_regclass('public.store_order_product_coupon_reward') IS NOT NULL AS exists,
          (SELECT count(*)::int FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'store_order_product_coupon_reward') AS columns,
          (SELECT count(*)::int FROM pg_indexes
            WHERE schemaname = 'public' AND tablename = 'store_order_product_coupon_reward') AS indexes,
          (SELECT count(*)::int FROM pg_constraint
            WHERE conrelid = to_regclass('public.store_order_product_coupon_reward')) AS constraints
      `;
      const targetState = target[0] ?? {};
      if (targetState.exists === true) {
        const rows = await tx<Array<{ exact_rows: number }>>`
          SELECT count(*)::int AS exact_rows FROM public.store_order_product_coupon_reward
        `;
        targetState.exact_rows = rows[0]?.exact_rows ?? -1;
      } else {
        targetState.exact_rows = null;
      }
      const fingerprint = await tx.unsafe<Array<{ fingerprint: string }>>(BUSINESS_FINGERPRINT_SQL);
      return {
        catalog: catalog[0] ?? {},
        target: targetState,
        business_fingerprint: fingerprint[0]?.fingerprint ?? "",
      };
    });
  } finally {
    await db.$client.end({ timeout: 1 });
  }
}

async function applyRewardMigration(connectionString: string) {
  const before = await rewardMigrationState(connectionString);
  const db = createDbFromConnectionString(connectionString, 1, {
    applicationName: "cinashop_api002_reward_migration",
  });
  const service = new MigrationService(createContainerFromDb(db));
  const migration = service.orderProductCouponRewardMigrationSqlForVerification();
  const applications: Array<{ business_fingerprint_unchanged: boolean }> = [];
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      applications.push(await db.$client.begin(async (tx) => {
        await tx`SET LOCAL search_path TO public`;
        await tx`SET LOCAL lock_timeout = '3s'`;
        await tx`SET LOCAL statement_timeout = '30s'`;
        await tx`SELECT pg_advisory_xact_lock(hashtext('cinashop-api002-reward-migration'))`;
        const fingerprintBefore = await tx.unsafe<Array<{ fingerprint: string }>>(BUSINESS_FINGERPRINT_SQL);
        await tx.unsafe(migration);
        const fingerprintAfter = await tx.unsafe<Array<{ fingerprint: string }>>(BUSINESS_FINGERPRINT_SQL);
        if (!fingerprintBefore[0] || fingerprintBefore[0].fingerprint !== fingerprintAfter[0]?.fingerprint) {
          throw new Error("business fingerprint changed inside reward DDL transaction");
        }
        return { business_fingerprint_unchanged: true };
      }));
    }
  } finally {
    await db.$client.end({ timeout: 1 });
  }
  const after = await rewardMigrationState(connectionString);
  if (before.business_fingerprint !== after.business_fingerprint) {
    throw new Error("public business fingerprint changed across reward migration");
  }
  return { before, applications, after, business_fingerprint_unchanged: true };
}

async function authorize(request: Request, verifier: string): Promise<boolean> {
  if (!verifier) return false;
  const encoder = new TextEncoder();
  const token = request.headers.get("X-Audit-Token") ?? "";
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(token));
  const actual = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  const [actualHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(actual)),
    crypto.subtle.digest("SHA-256", encoder.encode(verifier)),
  ]);
  return crypto.subtle.timingSafeEqual(actualHash, expectedHash);
}

async function readState(connectionString: string) {
  const db = createDbFromConnectionString(connectionString, 1, {
    applicationName: "cinashop_api002_read_audit",
  });
  try {
    return await db.$client.begin(async (tx) => {
      await tx`SET LOCAL search_path TO public`;
      await tx`SET LOCAL statement_timeout = '20s'`;
      await tx`SET TRANSACTION READ ONLY`;
      const state = await tx<Array<Record<string, unknown>>>`
        SELECT
          current_setting('server_version') AS server_version,
          (SELECT count(*)::integer FROM store_order) AS orders,
          (SELECT count(*)::integer FROM store_order WHERE is_del = 0 AND is_system_del = 0) AS visible_orders,
          (SELECT count(*)::integer FROM store_order WHERE paid = 0 AND is_del = 0 AND is_system_del = 0) AS unpaid_orders,
          (SELECT count(*)::integer FROM store_order WHERE paid = 1 AND is_del = 0 AND is_system_del = 0) AS paid_orders,
          (SELECT COALESCE(jsonb_object_agg(status::text, total), '{}'::jsonb)
            FROM (SELECT status, count(*)::integer AS total FROM store_order GROUP BY status ORDER BY status) d) AS order_status_distribution,
          (SELECT COALESCE(jsonb_object_agg(COALESCE(NULLIF(pay_type, ''), '<empty>'), total), '{}'::jsonb)
            FROM (SELECT pay_type, count(*)::integer AS total FROM store_order GROUP BY pay_type ORDER BY pay_type) d) AS pay_type_distribution,
          (SELECT COALESCE(jsonb_object_agg(shipping_type::text, total), '{}'::jsonb)
            FROM (SELECT shipping_type, count(*)::integer AS total FROM store_order GROUP BY shipping_type ORDER BY shipping_type) d) AS shipping_type_distribution,
          (SELECT COALESCE(jsonb_object_agg(COALESCE(NULLIF(delivery_type, ''), '<empty>'), total), '{}'::jsonb)
            FROM (SELECT delivery_type, count(*)::integer AS total FROM store_order GROUP BY delivery_type ORDER BY delivery_type) d) AS delivery_type_distribution,
          (SELECT COALESCE(jsonb_object_agg(refund_status::text, total), '{}'::jsonb)
            FROM (SELECT refund_status, count(*)::integer AS total FROM store_order GROUP BY refund_status ORDER BY refund_status) d) AS order_refund_status_distribution,
          (SELECT count(*)::integer FROM store_order_cart_info) AS order_cart_rows,
          (SELECT count(*)::integer FROM store_order_cart_info WHERE is_support_refund = 1) AS refundable_cart_rows,
          (SELECT count(*)::integer FROM store_order_cart_info ci LEFT JOIN store_order o ON o.id = ci.oid WHERE o.id IS NULL) AS orphan_order_cart_rows,
          (SELECT count(*)::integer FROM store_order_refund) AS refunds,
          (SELECT COALESCE(jsonb_object_agg(refund_type::text, total), '{}'::jsonb)
            FROM (SELECT refund_type, count(*)::integer AS total FROM store_order_refund GROUP BY refund_type ORDER BY refund_type) d) AS refund_type_distribution,
          (SELECT count(*)::integer FROM store_order_refund r LEFT JOIN store_order o ON o.id = r.store_order_id WHERE o.id IS NULL) AS orphan_refunds,
          (SELECT count(*)::integer FROM store_order_refund r JOIN store_order o ON o.id = r.store_order_id WHERE r.uid <> o.uid OR r.supplier_id <> o.supplier_id) AS refund_scope_mismatches,
          (SELECT count(*)::integer FROM store_order_refund_payment) AS refund_payment_rows,
          (SELECT count(*)::integer FROM store_order_invoice) AS order_invoices,
          (SELECT count(*)::integer FROM user_invoice) AS user_invoices,
          (SELECT count(*)::integer FROM store_order_writeoff) AS writeoff_rows,
          (SELECT count(*)::integer FROM store_order_status) AS order_status_rows,
          (SELECT count(*)::integer FROM store_delivery_order) AS delivery_order_rows,
          (SELECT count(*)::integer FROM store_product_coupon) AS product_coupon_relations,
          (SELECT count(*)::integer FROM store_coupon_user) AS user_coupons,
          (SELECT count(*)::integer FROM system_config WHERE menu_name = 'stor_reason' AND is_store = 0) AS refund_reason_config_rows,
          (SELECT count(*)::integer FROM shipping_templates) AS shipping_templates,
          (SELECT count(*)::integer FROM system_store WHERE is_del = 0) AS active_stores,
          (SELECT count(*)::integer FROM store_cart WHERE is_pay = 0 AND is_del = 0 AND status = 1) AS active_cart_rows,
          (SELECT count(*)::integer FROM pg_namespace WHERE nspname LIKE 'codex_%') AS temporary_schemas,
          (SELECT count(*)::integer FROM pg_indexes WHERE schemaname = 'public' AND tablename IN (
            'store_order', 'store_order_cart_info', 'store_order_refund',
            'store_order_refund_payment', 'store_order_invoice', 'store_order_writeoff',
            'store_order_status', 'store_delivery_order', 'store_cart'
          )) AS relevant_indexes
      `;
      const integrity = await tx<Array<Record<string, unknown>>>`
        SELECT
          count(*) FILTER (WHERE o.paid = 1 AND o.pay_type = '')::integer AS paid_without_pay_type,
          count(*) FILTER (WHERE o.status = 1 AND (o.delivery_type = '' OR o.delivery_id = ''))::integer AS shipped_without_tracking,
          count(*) FILTER (WHERE o.refund_status = 2 AND NOT EXISTS (
            SELECT 1 FROM store_order_refund r
            WHERE r.store_order_id = o.id AND r.refund_type = 6 AND r.is_cancel = 0 AND r.is_del = 0
          ))::integer AS fully_refunded_without_completed_refund,
          count(*) FILTER (WHERE o.total_num <> COALESCE(c.cart_num, 0))::integer AS total_num_snapshot_mismatches
        FROM store_order o
        LEFT JOIN (
          SELECT oid, sum(cart_num)::integer AS cart_num
          FROM store_order_cart_info GROUP BY oid
        ) c ON c.oid = o.id
      `;
      const checkout = await tx<Array<Record<string, unknown>>>`
        SELECT
          (SELECT COALESCE(jsonb_object_agg(type::text, total), '{}'::jsonb)
            FROM (SELECT type, count(*)::integer AS total FROM store_cart
              GROUP BY type ORDER BY type) d) AS cart_type_distribution,
          (SELECT count(*)::integer FROM store_cart
            WHERE type IN (1, 2, 3) AND is_pay = 0 AND is_del = 0 AND status = 1)
            AS active_legacy_activity_carts,
          (SELECT COALESCE(jsonb_object_agg(type::text, total), '{}'::jsonb)
            FROM (SELECT type, count(*)::integer AS total FROM store_order
              GROUP BY type ORDER BY type) d) AS order_type_distribution,
          (SELECT COALESCE(jsonb_object_agg(type::text, total), '{}'::jsonb)
            FROM (SELECT type, count(*)::integer AS total FROM store_product_attr_value
              GROUP BY type ORDER BY type) d) AS sku_type_distribution,
          (SELECT jsonb_build_object(
            'seckill', (SELECT count(*)::integer FROM store_seckill),
            'bargain', (SELECT count(*)::integer FROM store_bargain),
            'bargain_user', (SELECT count(*)::integer FROM store_bargain_user),
            'combination', (SELECT count(*)::integer FROM store_combination),
            'pink', (SELECT count(*)::integer FROM store_pink),
            'integral', (SELECT count(*)::integer FROM store_integral)
          )) AS activity_rows,
          (SELECT count(*)::integer
            FROM store_product_attr_value av
            WHERE av.type IN (1, 2, 3) AND NOT EXISTS (
              SELECT 1 FROM store_seckill s WHERE av.type = 1 AND s.id = av.product_id
              UNION ALL
              SELECT 1 FROM store_bargain b WHERE av.type = 2 AND b.id = av.product_id
              UNION ALL
              SELECT 1 FROM store_combination c WHERE av.type = 3 AND c.id = av.product_id
            )) AS orphan_legacy_activity_skus,
          (SELECT count(*)::integer
            FROM store_product_attr_value av
            LEFT JOIN store_seckill s ON av.type = 1 AND s.id = av.product_id
            LEFT JOIN store_bargain b ON av.type = 2 AND b.id = av.product_id
            LEFT JOIN store_combination c ON av.type = 3 AND c.id = av.product_id
            WHERE av.type IN (1, 2, 3)
              AND COALESCE(s.product_id, b.product_id, c.product_id) IS NOT NULL
              AND NOT EXISTS (
                SELECT 1 FROM store_product_attr_value base
                WHERE base.type = 0
                  AND base.product_id = COALESCE(s.product_id, b.product_id, c.product_id)
                  AND base.suk = av.suk
              )) AS activity_skus_without_base_match,
          (SELECT count(*)::integer FROM store_seckill
            WHERE status = 1 AND is_show = 1 AND is_del = 0 AND (once_num <= 0 OR num <= 0))
            AS active_seckill_invalid_limits,
          (SELECT count(*)::integer FROM store_combination
            WHERE status = 1 AND is_show = 1 AND is_del = 0 AND (once_num <= 0 OR num <= 0))
            AS active_combination_invalid_limits,
          (SELECT count(*)::integer
            FROM store_order o JOIN store_order_cart_info ci ON ci.oid = o.id
            WHERE o.type IN (1, 2, 3) AND ci.cart_info NOT LIKE '%"activitySku"%')
            AS legacy_activity_order_snapshots_without_activity_sku,
          (SELECT count(*)::integer FROM store_order
            WHERE type IN (1, 2, 3) AND paid = 0 AND status = 0 AND is_del = 0)
            AS unpaid_visible_activity_orders,
          (SELECT count(*)::integer
            FROM store_order o JOIN store_order_cart_info ci ON ci.oid = o.id
            WHERE o.type IN (1, 2, 3) AND o.paid = 0 AND o.status = 0 AND o.is_del = 0
              AND ci.cart_info NOT LIKE '%"activitySku"%')
            AS unpaid_activity_snapshots_without_activity_sku,
          (SELECT COALESCE(jsonb_agg(row_to_json(d) ORDER BY d.kind, d.id), '[]'::jsonb)
            FROM (
              SELECT 'seckill'::text AS kind, id, once_num, num, stock, quota, status, is_show, is_del
              FROM store_seckill
              UNION ALL
              SELECT 'combination'::text AS kind, id, once_num, num, stock, quota, status, is_show, is_del
              FROM store_combination
            ) d) AS limited_activity_configuration,
          (SELECT COALESCE(jsonb_object_agg(key, total), '{}'::jsonb)
            FROM (
              SELECT concat(type, ':paid=', paid, ':status=', status, ':del=', is_del) AS key,
                count(*)::integer AS total
              FROM store_order WHERE type IN (1, 2, 3)
              GROUP BY type, paid, status, is_del ORDER BY type, paid, status, is_del
            ) d) AS activity_order_lifecycle_distribution
      `;
      const plans = await tx<Array<{ "QUERY PLAN": unknown }>>`
        EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
        SELECT id, order_id, paid, status, refund_status, add_time
        FROM store_order
        WHERE uid = -2147483648 AND is_del = 0 AND is_system_del = 0
        ORDER BY add_time DESC, id DESC
        LIMIT 10
      `;
      const fingerprint = await tx.unsafe<Array<{ fingerprint: string }>>(BUSINESS_FINGERPRINT_SQL);
      return {
        state: state[0] ?? {},
        integrity: integrity[0] ?? {},
        checkout: checkout[0] ?? {},
        business_fingerprint: fingerprint[0]?.fingerprint ?? "",
        user_order_list_plan: plans[0]?.["QUERY PLAN"] ?? null,
      };
    });
  } finally {
    await db.$client.end({ timeout: 1 });
  }
}

/**
 * Read only the non-PII evidence needed to decide whether legacy activity SKU
 * rows and purchase limits can be reconstructed.  Order/user identifiers and
 * free-form snapshot fields deliberately never leave PostgreSQL.
 */
async function readCheckoutRecoveryEvidence(connectionString: string) {
  const db = createDbFromConnectionString(connectionString, 1, {
    applicationName: "cinashop_api006_checkout_recovery_audit",
  });
  try {
    return await db.$client.begin(async (tx) => {
      await tx`SET LOCAL search_path TO public`;
      await tx`SET LOCAL statement_timeout = '20s'`;
      await tx`SET LOCAL lock_timeout = '2s'`;
      await tx`SET TRANSACTION READ ONLY`;

      const activityConfiguration = await tx<Array<Record<string, unknown>>>`
        SELECT kind, activity_type, activity_id, product_id, price, min_price, cost,
          once_num, num, stock, quota, sales, status, is_show, is_del,
          start_time, stop_time
        FROM (
          SELECT 'seckill'::text AS kind, 1::smallint AS activity_type,
            id AS activity_id, product_id, price::text, NULL::text AS min_price,
            cost::text, once_num, num, stock, quota, sales, status, is_show,
            is_del, start_time, stop_time
          FROM store_seckill
          UNION ALL
          SELECT 'bargain'::text AS kind, 2::smallint AS activity_type,
            id AS activity_id, product_id, price::text, min_price::text,
            cost::text, NULL::integer AS once_num, num, stock, quota, sales,
            status, NULL::smallint AS is_show, is_del, start_time, stop_time
          FROM store_bargain
          UNION ALL
          SELECT 'combination'::text AS kind, 3::smallint AS activity_type,
            id AS activity_id, product_id, price::text, NULL::text AS min_price,
            cost::text, once_num, num, stock, quota, sales, status, is_show,
            is_del, start_time, stop_time
          FROM store_combination
        ) activity
        ORDER BY activity_type, activity_id
      `;

      const baseSkuCandidates = await tx<Array<Record<string, unknown>>>`
        WITH activity_products AS (
          SELECT 1::smallint AS activity_type, id AS activity_id, product_id FROM store_seckill
          UNION ALL
          SELECT 2::smallint, id, product_id FROM store_bargain
          UNION ALL
          SELECT 3::smallint, id, product_id FROM store_combination
        )
        SELECT activity.activity_type, activity.activity_id, activity.product_id,
          row_number() OVER (
            PARTITION BY activity.activity_type, activity.activity_id
            ORDER BY sku.id
          )::integer AS candidate_ordinal,
          sku.suk, sku.unique, sku.price::text, sku.cost::text,
          sku.stock, sku.quota, sku.sales
        FROM activity_products activity
        JOIN store_product_attr_value sku
          ON sku.type = 0 AND sku.product_id = activity.product_id
        ORDER BY activity.activity_type, activity.activity_id, sku.id
      `;

      const orderSnapshots = await tx<Array<Record<string, unknown>>>`
        WITH parsed AS (
          SELECT row_number() OVER (ORDER BY o.add_time, o.id, ci.id)::integer AS order_line_ordinal,
            o.uid, o.type, o.activity_id, o.paid, o.status, o.is_del,
            o.is_system_del, o.pid, o.total_num, o.total_price::text,
            o.pay_price::text, o.coupon_price::text, o.deduction_price::text,
            o.promotions_price::text,
            count(*) OVER (PARTITION BY o.id)::integer AS order_line_count,
            ci.product_id, ci.cart_num,
            ci.sku_unique,
            ci.cart_info IS JSON AS json_valid,
            CASE WHEN ci.cart_info IS JSON THEN ci.cart_info::jsonb ELSE '{}'::jsonb END AS snapshot
          FROM store_order o
          JOIN store_order_cart_info ci ON ci.oid = o.id
          WHERE o.type IN (1, 2, 3)
        ), normalized AS (
          SELECT parsed.*,
            COALESCE(
              NULLIF(snapshot #>> '{productInfo,attrInfo,suk}', ''),
              NULLIF(snapshot #>> '{activitySku,suk}', ''),
              NULLIF(snapshot #>> '{sku,suk}', '')
            ) AS snapshot_suk,
            COALESCE(
              NULLIF(snapshot #>> '{productInfo,attrInfo,unique}', ''),
              NULLIF(snapshot #>> '{activitySku,unique}', ''),
              NULLIF(snapshot #>> '{sku,unique}', ''),
              NULLIF(snapshot #>> '{product_attr_unique}', ''),
              NULLIF(sku_unique, '')
            ) AS snapshot_unique,
            COALESCE(
              NULLIF(snapshot #>> '{productInfo,attrInfo,price}', ''),
              NULLIF(snapshot #>> '{activitySku,price}', ''),
              NULLIF(snapshot #>> '{sku,price}', ''),
              NULLIF(snapshot #>> '{truePrice}', '')
            ) AS snapshot_price,
            COALESCE(
              NULLIF(snapshot #>> '{productInfo,attrInfo,cost}', ''),
              NULLIF(snapshot #>> '{costPrice}', '')
            ) AS snapshot_cost,
            snapshot ? 'activitySku' AS has_worker_activity_sku
          FROM parsed
        )
        SELECT order_line_ordinal, type, activity_id, product_id, paid, status,
          is_del, is_system_del, pid, total_num, total_price, pay_price,
          coupon_price, deduction_price, promotions_price, order_line_count,
          cart_num, json_valid,
          has_worker_activity_sku, snapshot_suk, snapshot_unique,
          snapshot_price, snapshot_cost,
          (SELECT count(*)::integer FROM store_product_attr_value base
            WHERE base.type = 0 AND base.product_id = normalized.product_id
              AND base.suk = normalized.snapshot_suk) AS base_suk_match_count,
          (SELECT count(*)::integer FROM store_product_attr_value activity_sku
            WHERE activity_sku.type = normalized.type
              AND activity_sku.product_id = normalized.activity_id
              AND activity_sku.unique = normalized.snapshot_unique)
            AS existing_activity_unique_match_count
        FROM normalized
        ORDER BY order_line_ordinal
      `;

      const bargainOrderResolution = await tx<Array<Record<string, unknown>>>`
        WITH bargain_orders AS (
          SELECT row_number() OVER (ORDER BY o.add_time, o.id)::integer AS order_ordinal,
            o.uid, o.activity_id, o.paid, o.status, o.is_del, o.is_system_del
          FROM store_order o
          WHERE o.type = 2
        )
        SELECT orders.order_ordinal, orders.activity_id, orders.paid,
          orders.status, orders.is_del, orders.is_system_del,
          count(participant.id)::integer AS matching_participants,
          coalesce(jsonb_agg(jsonb_build_object(
            'participant_id', participant.id,
            'bargain_id', participant.bargain_id,
            'status', participant.status,
            'is_del', participant.is_del,
            'bargain_price', participant.bargain_price::text,
            'cut_price', participant.price::text,
            'minimum_price', participant.bargain_price_min::text
          ) ORDER BY participant.id) FILTER (WHERE participant.id IS NOT NULL), '[]'::jsonb)
            AS participant_evidence
        FROM bargain_orders orders
        LEFT JOIN store_bargain_user participant
          ON participant.uid = orders.uid
          AND (participant.id = orders.activity_id OR participant.bargain_id = orders.activity_id)
        GROUP BY orders.order_ordinal, orders.activity_id, orders.paid,
          orders.status, orders.is_del, orders.is_system_del
        ORDER BY orders.order_ordinal
      `;

      const snapshotKeyShapes = await tx<Array<Record<string, unknown>>>`
        WITH parsed AS (
          SELECT CASE WHEN ci.cart_info IS JSON
              THEN ci.cart_info::jsonb ELSE '{}'::jsonb END AS snapshot
          FROM store_order o
          JOIN store_order_cart_info ci ON ci.oid = o.id
          WHERE o.type IN (1, 2, 3)
        )
        SELECT DISTINCT
          (SELECT coalesce(jsonb_agg(key ORDER BY key), '[]'::jsonb)
            FROM jsonb_object_keys(snapshot) AS key) AS top_level_keys,
          (SELECT coalesce(jsonb_agg(key ORDER BY key), '[]'::jsonb)
            FROM jsonb_object_keys(CASE
              WHEN jsonb_typeof(snapshot -> 'productInfo') = 'object'
                THEN snapshot -> 'productInfo' ELSE '{}'::jsonb END) AS key)
            AS product_info_keys,
          (SELECT coalesce(jsonb_agg(key ORDER BY key), '[]'::jsonb)
            FROM jsonb_object_keys(CASE
              WHEN jsonb_typeof(snapshot #> '{productInfo,attrInfo}') = 'object'
                THEN snapshot #> '{productInfo,attrInfo}' ELSE '{}'::jsonb END) AS key)
            AS attr_info_keys
        FROM parsed
      `;

      const historicalActivityCarts = await tx<Array<Record<string, unknown>>>`
        SELECT row_number() OVER (ORDER BY add_time, id)::integer AS cart_ordinal,
          type, activity_id, product_id, product_attr_unique, cart_num,
          is_pay, is_del, status,
          (SELECT count(*)::integer FROM store_product_attr_value activity_sku
            WHERE activity_sku.type = cart.type
              AND activity_sku.product_id = cart.activity_id
              AND activity_sku.unique = cart.product_attr_unique)
            AS existing_activity_unique_match_count,
          (SELECT count(*)::integer FROM store_product_attr_value base
            WHERE base.type = 0 AND base.product_id = cart.product_id
              AND base.unique = cart.product_attr_unique)
            AS base_unique_match_count
        FROM store_cart cart
        WHERE type IN (1, 2, 3)
        ORDER BY add_time, id
      `;

      const limitLowerBounds = await tx<Array<Record<string, unknown>>>`
        WITH relevant AS (
          SELECT uid, type, activity_id, total_num, paid, status, is_del,
            is_system_del, pid
          FROM store_order
          WHERE type IN (1, 3) AND pid IN (0, -1)
        ), reserved_per_user AS (
          SELECT type, activity_id, uid, sum(total_num)::integer AS reserved_total
          FROM relevant
          WHERE paid = 1 OR (paid = 0 AND is_del = 0 AND is_system_del = 0)
          GROUP BY type, activity_id, uid
        ), bounds AS (
          SELECT type, activity_id,
            max(total_num)::integer AS observed_once_num_lower_bound,
            max(reserved_total)::integer AS observed_total_num_lower_bound
          FROM relevant
          LEFT JOIN reserved_per_user USING (type, activity_id, uid)
          GROUP BY type, activity_id
        )
        SELECT bounds.type, bounds.activity_id,
          bounds.observed_once_num_lower_bound,
          bounds.observed_total_num_lower_bound,
          CASE WHEN bounds.type = 1 THEN seckill.once_num ELSE combination.once_num END
            AS configured_once_num,
          CASE WHEN bounds.type = 1 THEN seckill.num ELSE combination.num END
            AS configured_total_num
        FROM bounds
        LEFT JOIN store_seckill seckill
          ON bounds.type = 1 AND seckill.id = bounds.activity_id
        LEFT JOIN store_combination combination
          ON bounds.type = 3 AND combination.id = bounds.activity_id
        ORDER BY bounds.type, bounds.activity_id
      `;

      const recoverySummary = await tx<Array<Record<string, unknown>>>`
        WITH parsed AS (
          SELECT o.paid, o.status, o.is_del, o.is_system_del, o.type,
            o.activity_id, ci.product_id, ci.sku_unique,
            CASE WHEN ci.cart_info IS JSON THEN ci.cart_info::jsonb ELSE '{}'::jsonb END AS snapshot
          FROM store_order o
          JOIN store_order_cart_info ci ON ci.oid = o.id
          WHERE o.type IN (1, 2, 3)
        ), normalized AS (
          SELECT parsed.*,
            COALESCE(
              NULLIF(snapshot #>> '{productInfo,attrInfo,suk}', ''),
              NULLIF(snapshot #>> '{activitySku,suk}', ''),
              NULLIF(snapshot #>> '{sku,suk}', '')
            ) AS snapshot_suk,
            COALESCE(
              NULLIF(snapshot #>> '{productInfo,attrInfo,unique}', ''),
              NULLIF(snapshot #>> '{activitySku,unique}', ''),
              NULLIF(snapshot #>> '{sku,unique}', ''),
              NULLIF(snapshot #>> '{product_attr_unique}', ''),
              NULLIF(sku_unique, '')
            ) AS snapshot_unique,
            COALESCE(
              NULLIF(snapshot #>> '{productInfo,attrInfo,price}', ''),
              NULLIF(snapshot #>> '{activitySku,price}', ''),
              NULLIF(snapshot #>> '{sku,price}', ''),
              NULLIF(snapshot #>> '{truePrice}', '')
            ) AS snapshot_price,
            COALESCE(
              NULLIF(snapshot #>> '{productInfo,attrInfo,cost}', ''),
              NULLIF(snapshot #>> '{costPrice}', '')
            ) AS snapshot_cost
          FROM parsed
        ), evidence AS (
          SELECT normalized.*,
            (SELECT count(*) FROM store_product_attr_value base
              WHERE base.type = 0 AND base.product_id = normalized.product_id
                AND base.suk = normalized.snapshot_suk) AS base_matches
          FROM normalized
        )
        SELECT count(*)::integer AS activity_order_lines,
          count(*) FILTER (WHERE snapshot_suk IS NOT NULL)::integer AS lines_with_suk,
          count(*) FILTER (WHERE snapshot_unique IS NOT NULL)::integer AS lines_with_unique,
          count(*) FILTER (WHERE snapshot_price IS NOT NULL)::integer AS lines_with_price,
          count(*) FILTER (WHERE snapshot_cost IS NOT NULL)::integer AS lines_with_cost,
          count(*) FILTER (WHERE base_matches = 1)::integer AS lines_with_unique_base_suk_match,
          count(*) FILTER (WHERE base_matches = 0)::integer AS lines_without_base_suk_match,
          count(*) FILTER (WHERE base_matches > 1)::integer AS lines_with_ambiguous_base_suk_match,
          count(*) FILTER (
            WHERE paid = 0 AND status = 0 AND is_del = 0 AND is_system_del = 0
          )::integer AS unpaid_visible_lines,
          count(*) FILTER (
            WHERE paid = 0 AND status = 0 AND is_del = 0 AND is_system_del = 0
              AND snapshot_suk IS NOT NULL AND snapshot_unique IS NOT NULL
              AND snapshot_price IS NOT NULL AND snapshot_cost IS NOT NULL
              AND base_matches = 1
          )::integer AS unpaid_lines_with_complete_rebuild_evidence
        FROM evidence
      `;

      const fingerprint = await tx.unsafe<Array<{ fingerprint: string }>>(BUSINESS_FINGERPRINT_SQL);
      return {
        transaction: "READ ONLY",
        pii_projection: "none",
        activity_configuration: activityConfiguration,
        base_sku_candidates: baseSkuCandidates,
        activity_order_snapshots: orderSnapshots,
        snapshot_key_shapes: snapshotKeyShapes,
        bargain_order_resolution: bargainOrderResolution,
        historical_activity_carts: historicalActivityCarts,
        limit_lower_bounds: limitLowerBounds,
        recovery_summary: recoverySummary[0] ?? {},
        business_fingerprint: fingerprint[0]?.fingerprint ?? "",
      };
    });
  } finally {
    await db.$client.end({ timeout: 1 });
  }
}

export default {
  async fetch(request: Request, env: AuditEnv): Promise<Response> {
    if (!(await authorize(request, env.AUDIT_TOKEN_SHA256))) {
      return Response.json({ error: "forbidden" }, { status: 403 });
    }
    const pathname = new URL(request.url).pathname;
    if (request.method === "POST" && pathname === "/isolated") {
      try {
        const creation = await runStoreOrderCreatePostgresScenario(env.HYPERDRIVE.connectionString);
        const payment = await runStoreOrderPaymentCancelPostgresScenario(env.HYPERDRIVE.connectionString);
        const refund = await runStoreOrderRefundPostgresScenario(env.HYPERDRIVE.connectionString);
        return Response.json({ creation, payment, refund });
      } catch (error) {
        return Response.json(
          { error: error instanceof Error ? error.message : String(error) },
          { status: 500 },
        );
      }
    }
    if (request.method === "POST" && pathname === "/migrate-reward") {
      try {
        return Response.json(await applyRewardMigration(env.HYPERDRIVE.connectionString));
      } catch (error) {
        return Response.json(
          { error: error instanceof Error ? error.message : String(error) },
          { status: 500 },
        );
      }
    }
    if (request.method === "GET" && pathname === "/checkout-recovery") {
      try {
        return Response.json(await readCheckoutRecoveryEvidence(env.HYPERDRIVE.connectionString));
      } catch (error) {
        return Response.json(
          { error: error instanceof Error ? error.message : String(error) },
          { status: 500 },
        );
      }
    }
    if (request.method !== "GET" || pathname !== "/state") {
      return Response.json({ error: "not found" }, { status: 404 });
    }
    try {
      return Response.json(await readState(env.HYPERDRIVE.connectionString));
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : String(error) },
        { status: 500 },
      );
    }
  },
} satisfies ExportedHandler<AuditEnv>;
