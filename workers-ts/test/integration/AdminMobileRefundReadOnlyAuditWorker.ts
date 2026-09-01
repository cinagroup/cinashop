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
    connection: { application_name: "cinashop_admin_refund_read_only_audit" },
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
          to_regclass('public.store_order') IS NOT NULL AS order_table_ready,
          to_regclass('public.store_order_refund') IS NOT NULL AS refund_table_ready,
          to_regclass('public.store_order_refund_payment') IS NOT NULL AS refund_payment_table_ready,
          to_regclass('public.store_order_status') IS NOT NULL AS order_status_table_ready
      `)[0];
      if (
        context?.current_schema !== "public" ||
        context.search_path !== "public, pg_temp" ||
        context.transaction_read_only !== "on"
      ) {
        throw new Error("production audit transaction was not pinned read-only to public");
      }

      const orders = (await tx<Array<Record<string, unknown>>>`
        WITH duplicate_public_ids AS (
          SELECT order_id FROM store_order GROUP BY order_id HAVING count(*) > 1
        )
        SELECT count(*)::int AS total_rows,
          count(*) FILTER (WHERE is_del = 0 AND is_system_del = 0)::int AS visible_rows,
          count(*) FILTER (WHERE paid = 0 AND status = 0 AND pid = 0
            AND supplier_allocation_status <> 1 AND is_del = 0 AND is_system_del = 0)::int
            AS offline_confirmable_rows,
          count(*) FILTER (WHERE paid = 1 AND pay_type = 'offline'
            AND is_del = 0 AND is_system_del = 0)::int AS paid_offline_rows,
          count(*) FILTER (WHERE paid = 1 AND pay_type <> 'offline'
            AND is_del = 0 AND is_system_del = 0)::int AS paid_other_rows,
          count(*) FILTER (WHERE paid = 1 AND (pay_type = '' OR pay_type IS NULL)
            AND is_del = 0 AND is_system_del = 0)::int AS paid_missing_type_rows,
          (SELECT count(*)::int FROM duplicate_public_ids) AS duplicate_public_id_groups
        FROM store_order
      `)[0];

      const refunds = (await tx<Array<Record<string, unknown>>>`
        WITH visible_refunds AS (
          SELECT refund.*, orders.pay_price, orders.pay_type,
            orders.uid AS order_uid, orders.supplier_id AS order_supplier_id,
            orders.is_del AS order_is_del, orders.is_system_del AS order_is_system_del
          FROM store_order_refund AS refund
          LEFT JOIN store_order AS orders ON orders.id = refund.store_order_id
          WHERE refund.is_cancel = 0 AND refund.is_del = 0
        ), duplicate_refund_ids AS (
          SELECT order_id FROM store_order_refund
          WHERE order_id <> '' GROUP BY order_id HAVING count(*) > 1
        ), multiple_active AS (
          SELECT store_order_id FROM store_order_refund
          WHERE refund_type IN (0, 1, 2, 4, 5) AND is_cancel = 0 AND is_del = 0
          GROUP BY store_order_id HAVING count(*) > 1
        )
        SELECT count(*)::int AS active_or_terminal_visible_rows,
          count(*) FILTER (WHERE refund_type IN (0, 1, 2, 4, 5))::int AS pending_rows,
          count(*) FILTER (WHERE refund_type = 3)::int AS refused_rows,
          count(*) FILTER (WHERE refund_type = 4)::int AS waiting_return_rows,
          count(*) FILTER (WHERE refund_type = 6)::int AS completed_rows,
          count(*) FILTER (WHERE apply_type = 4)::int AS proactive_admin_rows,
          count(*) FILTER (WHERE store_order_id IS NULL OR order_uid IS NULL)::int AS order_orphan_rows,
          count(*) FILTER (WHERE order_uid IS NOT NULL AND (
            uid <> order_uid OR supplier_id <> order_supplier_id
          ))::int AS ownership_mismatch_rows,
          count(*) FILTER (WHERE refund_price < 0 OR refund_price > pay_price)::int AS invalid_amount_rows,
          count(*) FILTER (WHERE refund_type IN (0, 1, 2, 4, 5)
            AND pay_type IN ('weixin', 'alipay', 'yue'))::int AS executable_channel_pending_rows,
          count(*) FILTER (WHERE refund_type IN (0, 1, 2, 4, 5)
            AND pay_type NOT IN ('weixin', 'alipay', 'yue'))::int AS unsupported_channel_pending_rows,
          count(*) FILTER (WHERE order_is_del <> 0 OR order_is_system_del <> 0)::int
            AS hidden_order_refund_rows,
          (SELECT count(*)::int FROM duplicate_refund_ids) AS duplicate_refund_id_groups,
          (SELECT count(*)::int FROM multiple_active) AS multiple_active_order_groups
        FROM visible_refunds
      `)[0];

      const paymentLedger = context.refund_payment_table_ready
        ? (await tx<Array<Record<string, unknown>>>`
            SELECT count(*)::int AS total_rows,
              count(*) FILTER (WHERE provider_status = 'SUCCESS')::int AS success_rows,
              count(*) FILTER (WHERE provider_status IN ('REQUESTING', 'PROCESSING', 'UNKNOWN'))::int
                AS pending_or_unknown_rows,
              count(*) FILTER (WHERE provider_status IN ('CLOSED', 'ABNORMAL', 'FAILED'))::int
                AS terminal_or_failed_rows,
              count(*) FILTER (WHERE request_amount < 0 OR total_amount <= 0
                OR request_amount > total_amount)::int AS invalid_amount_rows,
              count(*) FILTER (WHERE refund.id IS NULL)::int AS orphan_rows
            FROM store_order_refund_payment AS payment
            LEFT JOIN store_order_refund AS refund ON refund.id = payment.refund_id
          `)[0]
        : { table_missing: true };

      const auditEvidence = (await tx<Array<Record<string, unknown>>>`
        SELECT count(*) FILTER (WHERE change_type = 'admin_order_offline')::int
            AS admin_offline_rows,
          count(*) FILTER (WHERE change_type = 'admin_refund_apply')::int
            AS admin_refund_apply_rows,
          count(*) FILTER (WHERE change_type = 'admin_refund_execute')::int
            AS admin_refund_execute_rows,
          count(*) FILTER (WHERE change_type = 'admin_refund_refuse')::int
            AS admin_refund_refuse_rows,
          count(*) FILTER (WHERE change_type = 'admin_refund_return')::int
            AS admin_refund_return_rows
        FROM store_order_status
      `)[0];

      return { context, orders, refunds, payment_ledger: paymentLedger, audit_evidence: auditEvidence };
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
