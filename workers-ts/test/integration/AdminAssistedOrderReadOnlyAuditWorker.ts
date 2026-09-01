import postgres from "postgres";

interface AuditEnv {
  HYPERDRIVE: Hyperdrive;
}

async function productionAggregates(connectionString: string) {
  const client = postgres(connectionString, {
    max: 1,
    prepare: false,
    connect_timeout: 10,
    idle_timeout: 5,
    connection: { application_name: "cinashop_admin_assisted_read_only_audit" },
  });
  try {
    return await client.begin(async (tx) => {
      await tx`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`;
      await tx`SET LOCAL search_path TO public, pg_temp`;
      await tx`SET LOCAL statement_timeout = '15s'`;
      await tx`SET LOCAL lock_timeout = '1s'`;
      const context = (await tx<Array<Record<string, unknown>>>`
        SELECT current_schema() AS current_schema,
          current_setting('search_path') AS search_path,
          current_setting('transaction_read_only') AS transaction_read_only,
          current_setting('transaction_isolation') AS transaction_isolation,
          current_setting('server_version') AS server_version,
          to_regclass('public.store_cart') IS NOT NULL AS cart_table_ready,
          to_regclass('public.store_order') IS NOT NULL AS order_table_ready,
          to_regclass('public.store_order_cart_info') IS NOT NULL AS cart_snapshot_table_ready,
          to_regclass('public.store_order_status') IS NOT NULL AS order_status_table_ready,
          to_regclass('public.store_coupon_user') IS NOT NULL AS coupon_user_table_ready,
          to_regclass('public.store_coupon_issue') IS NOT NULL AS coupon_issue_table_ready
      `)[0];
      if (
        context?.current_schema !== "public" || context.search_path !== "public, pg_temp" ||
        context.transaction_read_only !== "on" || context.transaction_isolation !== "repeatable read"
      ) throw new Error("production audit transaction was not pinned repeatable-read/read-only to public");

      const columns = await tx<Array<Record<string, unknown>>>`
        SELECT table_name, column_name, data_type, is_nullable
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND ((table_name = 'store_cart' AND column_name IN (
            'uid', 'tourist_uid', 'staff_id', 'type', 'activity_id', 'store_id',
            'is_new', 'is_pay', 'is_del', 'status'
          )) OR (table_name = 'store_order' AND column_name IN (
            'uid', 'staff_id', 'is_channel', 'unique', 'paid', 'status',
            'is_del', 'is_system_del', 'pid'
          )))
        ORDER BY table_name, ordinal_position
      `;

      const carts = (await tx<Array<Record<string, unknown>>>`
        WITH duplicate_active_scope AS (
          SELECT staff_id, uid, tourist_uid, is_new, product_id, product_attr_unique
          FROM store_cart
          WHERE staff_id > 0 AND type = 0 AND activity_id = 0 AND store_id = 0
            AND is_pay = 0 AND is_del = 0 AND status = 1
          GROUP BY staff_id, uid, tourist_uid, is_new, product_id, product_attr_unique
          HAVING count(*) > 1
        )
        SELECT count(*) FILTER (WHERE staff_id > 0)::int AS staff_scoped_rows,
          count(*) FILTER (WHERE staff_id > 0 AND is_pay = 0 AND is_del = 0 AND status = 1)::int
            AS active_staff_scoped_rows,
          count(*) FILTER (WHERE staff_id > 0 AND uid > 0 AND tourist_uid = ''
            AND is_pay = 0 AND is_del = 0 AND status = 1)::int AS active_registered_rows,
          count(*) FILTER (WHERE staff_id > 0 AND uid = 0 AND tourist_uid <> ''
            AND is_pay = 0 AND is_del = 0 AND status = 1)::int AS active_guest_rows,
          count(*) FILTER (WHERE staff_id > 0 AND uid = 0 AND tourist_uid = ''
            AND is_pay = 0 AND is_del = 0 AND status = 1)::int AS invalid_guest_scope_rows,
          count(*) FILTER (WHERE staff_id > 0 AND uid > 0 AND tourist_uid <> ''
            AND is_pay = 0 AND is_del = 0 AND status = 1)::int AS invalid_registered_scope_rows,
          count(*) FILTER (WHERE staff_id > 0 AND (type <> 0 OR activity_id <> 0 OR store_id <> 0)
            AND is_pay = 0 AND is_del = 0 AND status = 1)::int AS unsupported_active_rows,
          (SELECT count(*)::int FROM duplicate_active_scope) AS duplicate_active_scope_groups
        FROM store_cart
      `)[0];

      const orders = (await tx<Array<Record<string, unknown>>>`
        WITH assisted AS (
          SELECT * FROM store_order WHERE staff_id > 0 AND is_channel = 2
        ), missing_create_audit AS (
          SELECT orders.id
          FROM assisted AS orders
          WHERE NOT EXISTS (
            SELECT 1 FROM store_order_status AS history
            WHERE history.oid = orders.id AND history.change_type = 'admin_assisted_create'
          )
        ), missing_cash_audit AS (
          SELECT orders.id
          FROM assisted AS orders
          WHERE orders.paid = 1 AND orders.pay_type = 'cash' AND NOT EXISTS (
            SELECT 1 FROM store_order_status AS history
            WHERE history.oid = orders.id AND history.change_type = 'admin_assisted_pay'
          )
        )
        SELECT count(*)::int AS assisted_rows,
          count(*) FILTER (WHERE uid = 0)::int AS assisted_guest_rows,
          count(*) FILTER (WHERE uid > 0)::int AS assisted_registered_rows,
          count(*) FILTER (WHERE paid = 0 AND status = 0 AND is_del = 0 AND is_system_del = 0)::int
            AS active_unpaid_rows,
          count(*) FILTER (WHERE paid = 1 AND is_del = 0 AND is_system_del = 0)::int AS paid_rows,
          count(*) FILTER (WHERE unique IS NULL OR unique = '')::int AS missing_idempotency_key_rows,
          (SELECT count(*)::int FROM missing_create_audit) AS missing_create_audit_rows,
          (SELECT count(*)::int FROM missing_cash_audit) AS missing_cash_audit_rows,
          (SELECT count(*)::int FROM store_order WHERE is_channel = 2 AND staff_id <= 0)
            AS invalid_channel_actor_rows,
          (SELECT count(*)::int FROM store_order WHERE staff_id > 0 AND is_channel <> 2)
            AS legacy_staff_non_channel_rows
        FROM assisted
      `)[0];

      const cartEvidence = (await tx<Array<Record<string, unknown>>>`
        SELECT count(*) FILTER (WHERE orders.staff_id > 0 AND orders.is_channel = 2)::int
            AS assisted_snapshot_rows,
          count(*) FILTER (WHERE orders.staff_id > 0 AND orders.is_channel = 2
            AND carts.uid <> orders.uid)::int AS snapshot_uid_mismatch_rows,
          count(DISTINCT orders.id) FILTER (WHERE orders.staff_id > 0 AND orders.is_channel = 2
            AND carts.id IS NULL)::int AS assisted_orders_without_snapshots
        FROM store_order AS orders
        LEFT JOIN store_order_cart_info AS carts ON carts.oid = orders.id
      `)[0];

      const indexes = await tx<Array<Record<string, unknown>>>`
        SELECT tablename, indexname, indexdef
        FROM pg_indexes
        WHERE schemaname = 'public' AND tablename IN ('store_cart', 'store_order')
          AND (indexdef ILIKE '%staff_id%' OR indexdef ILIKE '%tourist_uid%' OR indexdef ILIKE '%is_channel%')
        ORDER BY tablename, indexname
      `;

      return { context, columns, carts, orders, cart_evidence: cartEvidence, supporting_indexes: indexes };
    });
  } finally {
    await client.end({ timeout: 2 });
  }
}

export default {
  async fetch(request: Request, env: AuditEnv): Promise<Response> {
    if (request.method !== "GET" || new URL(request.url).pathname !== "/audit") {
      return Response.json({ error: "not found" }, { status: 404 });
    }
    try {
      return Response.json(await productionAggregates(env.HYPERDRIVE.connectionString), {
        headers: { "Cache-Control": "no-store" },
      });
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : String(error) },
        { status: 500, headers: { "Cache-Control": "no-store" } },
      );
    }
  },
} satisfies ExportedHandler<AuditEnv>;
