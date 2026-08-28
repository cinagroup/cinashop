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
      const plans = await tx<Array<{ "QUERY PLAN": unknown }>>`
        EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
        SELECT id, order_id, paid, status, refund_status, add_time
        FROM store_order
        WHERE uid = -2147483648 AND is_del = 0 AND is_system_del = 0
        ORDER BY add_time DESC, id DESC
        LIMIT 10
      `;
      return {
        state: state[0] ?? {},
        integrity: integrity[0] ?? {},
        user_order_list_plan: plans[0]?.["QUERY PLAN"] ?? null,
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
