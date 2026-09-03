import { createDbFromConnectionString } from "@/lib/di";
import { normalizeConfigScalar } from "@/utils/config";
import type postgres from "postgres";

interface AuditEnv {
  HYPERDRIVE: Hyperdrive;
  AUDIT_READ_TOKEN_SHA256: string;
  AUDIT_WRITE_TOKEN_SHA256: string;
}

const ALLOWED_OUTBOX_EVENTS = [
  "order.paid",
  "order.delivery.notice",
  "order.refund.refused.notice",
  "order.second_card.advent.notice",
  "order.second_card.expired.notice",
] as const;

const MIGRATION_STATEMENTS = [
  `ALTER TABLE public.store_order_outbox DROP CONSTRAINT IF EXISTS soob_event_type_ck`,
  `ALTER TABLE public.store_order_outbox ADD CONSTRAINT soob_event_type_ck CHECK (
    event_type IN (
      'order.paid',
      'order.delivery.notice',
      'order.refund.refused.notice',
      'order.second_card.advent.notice',
      'order.second_card.expired.notice'
    )
  )`,
  `CREATE INDEX IF NOT EXISTS soci_second_card_advent_due
    ON public.store_order_cart_info (write_end, id)
    WHERE product_type = 4
      AND is_writeoff = 0
      AND is_advent_sms = 0
      AND write_start > 0
      AND write_end > 0`,
  `CREATE INDEX IF NOT EXISTS soci_second_card_expired_due
    ON public.store_order_cart_info (write_end, id)
    WHERE product_type = 4
      AND is_writeoff = 0
      AND is_expire_sms = 0
      AND write_start > 0
      AND write_end > 0`,
] as const;

function response(data: unknown, status = 200): Response {
  return Response.json(data, {
    status,
    headers: {
      "Cache-Control": "private, no-store, max-age=0",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

async function authorize(request: Request, verifier: string): Promise<boolean> {
  const token = request.headers.get("X-Audit-Token") ?? "";
  if (!token || !/^[a-f0-9]{64}$/i.test(verifier ?? "")) return false;
  const encoder = new TextEncoder();
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

function reminderHours(raw: string | undefined): number {
  const normalized = normalizeConfigScalar(raw);
  if (normalized === "") return 1;
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= 8_760 ? parsed : 1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function summarizePlan(value: unknown) {
  const document = Array.isArray(value) ? value[0] : undefined;
  const root = isRecord(document) && isRecord(document.Plan) ? document.Plan : undefined;
  const nodeTypes = new Set<string>();
  const indexNames = new Set<string>();
  const visit = (node: Record<string, unknown>): void => {
    if (typeof node["Node Type"] === "string") nodeTypes.add(node["Node Type"]);
    if (typeof node["Index Name"] === "string") indexNames.add(node["Index Name"]);
    if (Array.isArray(node.Plans)) {
      for (const child of node.Plans) if (isRecord(child)) visit(child);
    }
  };
  if (root) visit(root);
  return {
    nodeTypes: [...nodeTypes].sort(),
    indexNames: [...indexNames].sort(),
    totalCost: typeof root?.["Total Cost"] === "number" ? root["Total Cost"] : null,
    estimatedRows: typeof root?.["Plan Rows"] === "number" ? root["Plan Rows"] : null,
  };
}

async function indexState(tx: postgres.TransactionSql) {
  const rows = await tx<{
    indexname: string;
    indexdef: string;
    indisvalid: boolean;
    indisready: boolean;
  }[]>`
    SELECT indexes.indexname, indexes.indexdef, catalog.indisvalid, catalog.indisready
    FROM pg_indexes indexes
    JOIN pg_class relation ON relation.relname = indexes.tablename
    JOIN pg_namespace namespace
      ON namespace.oid = relation.relnamespace AND namespace.nspname = indexes.schemaname
    JOIN pg_class index_relation ON index_relation.relname = indexes.indexname
      AND index_relation.relnamespace = namespace.oid
    JOIN pg_index catalog
      ON catalog.indexrelid = index_relation.oid AND catalog.indrelid = relation.oid
    WHERE indexes.schemaname = 'public'
      AND indexes.tablename = 'store_order_cart_info'
      AND indexes.indexname IN (
        'soci_second_card_advent_due',
        'soci_second_card_expired_due'
      )
    ORDER BY indexes.indexname
  `;
  return rows;
}

async function constraintState(tx: postgres.TransactionSql) {
  const [row] = await tx<{ definition: string | null; unsupported_rows: number }[]>`
    SELECT
      (
        SELECT pg_get_constraintdef(oid)
        FROM pg_constraint
        WHERE conrelid = 'public.store_order_outbox'::regclass
          AND conname = 'soob_event_type_ck'
      ) AS definition,
      (
        SELECT count(*)::int
        FROM public.store_order_outbox
        WHERE event_type <> ALL(${ALLOWED_OUTBOX_EVENTS as unknown as string[]})
      ) AS unsupported_rows
  `;
  const definition = row?.definition ?? "";
  return {
    definition,
    unsupportedRows: row?.unsupported_rows ?? -1,
    ready: ALLOWED_OUTBOX_EVENTS.every((eventType) => definition.includes(eventType)),
  };
}

async function businessState(tx: postgres.TransactionSql) {
  const [row] = await tx<{
    cart_rows: number;
    second_card_rows: number;
    advent_flags: number;
    expiry_flags: number;
    outbox_rows: number;
    second_card_outbox_rows: number;
  }[]>`
    SELECT
      (SELECT count(*)::int FROM public.store_order_cart_info) AS cart_rows,
      (SELECT count(*)::int FROM public.store_order_cart_info WHERE product_type = 4)
        AS second_card_rows,
      (SELECT coalesce(sum(is_advent_sms), 0)::int FROM public.store_order_cart_info)
        AS advent_flags,
      (SELECT coalesce(sum(is_expire_sms), 0)::int FROM public.store_order_cart_info)
        AS expiry_flags,
      (SELECT count(*)::int FROM public.store_order_outbox) AS outbox_rows,
      (SELECT count(*)::int FROM public.store_order_outbox
        WHERE event_type IN (
          'order.second_card.advent.notice',
          'order.second_card.expired.notice'
        )) AS second_card_outbox_rows
  `;
  return row;
}

async function readProduction(tx: postgres.TransactionSql) {
  const [clock] = await tx<{ server_version: string; now_seconds: number }[]>`
    SELECT current_setting('server_version') AS server_version,
      extract(epoch FROM clock_timestamp())::int AS now_seconds
  `;
  const configs = await tx<{ menu_name: string; value: string; row_count: number }[]>`
    WITH ranked AS (
      SELECT menu_name, value,
        count(*) OVER (PARTITION BY menu_name)::int AS row_count,
        row_number() OVER (PARTITION BY menu_name ORDER BY sort DESC, id DESC) AS position
      FROM public.system_config
      WHERE is_store = 0
        AND menu_name IN (
          'reminder_deadline_second_card_time',
          'refund_name',
          'refund_phone',
          'refund_address'
        )
    )
    SELECT menu_name, value, row_count FROM ranked WHERE position = 1 ORDER BY menu_name
  `;
  const config = new Map(configs.map((item) => [item.menu_name, item]));
  const hours = reminderHours(config.get("reminder_deadline_second_card_time")?.value);
  const now = clock?.now_seconds ?? Math.floor(Date.now() / 1_000);
  const horizon = now + hours * 3_600;

  const [cards] = await tx<{
    total: number;
    unredeemed: number;
    invalid_window: number;
    advent_flag_pending: number;
    expiry_flag_pending: number;
    advent_due: number;
    expired_due: number;
    eligible_advent_due: number;
    eligible_expired_due: number;
    orphaned_orders: number;
  }[]>`
    SELECT
      count(*)::int AS total,
      count(*) FILTER (WHERE cart.is_writeoff = 0)::int AS unredeemed,
      count(*) FILTER (WHERE cart.write_start <= 0 OR cart.write_end <= 0)::int AS invalid_window,
      count(*) FILTER (WHERE cart.is_writeoff = 0 AND cart.is_advent_sms = 0)::int
        AS advent_flag_pending,
      count(*) FILTER (WHERE cart.is_writeoff = 0 AND cart.is_expire_sms = 0)::int
        AS expiry_flag_pending,
      count(*) FILTER (
        WHERE cart.is_writeoff = 0 AND cart.is_advent_sms = 0
          AND cart.write_start > 0 AND cart.write_end > ${now} AND cart.write_end <= ${horizon}
      )::int AS advent_due,
      count(*) FILTER (
        WHERE cart.is_writeoff = 0 AND cart.is_expire_sms = 0
          AND cart.write_start > 0 AND cart.write_end > 0 AND cart.write_end < ${now}
      )::int AS expired_due,
      count(*) FILTER (
        WHERE cart.is_writeoff = 0 AND cart.is_advent_sms = 0
          AND cart.write_start > 0 AND cart.write_end > ${now} AND cart.write_end <= ${horizon}
          AND orders.paid = 1 AND orders.is_del = 0 AND orders.is_system_del = 0
          AND orders.refund_status IN (0, 3) AND orders.uid = cart.uid
      )::int AS eligible_advent_due,
      count(*) FILTER (
        WHERE cart.is_writeoff = 0 AND cart.is_expire_sms = 0
          AND cart.write_start > 0 AND cart.write_end > 0 AND cart.write_end < ${now}
          AND orders.paid = 1 AND orders.is_del = 0 AND orders.is_system_del = 0
          AND orders.refund_status IN (0, 3) AND orders.uid = cart.uid
      )::int AS eligible_expired_due,
      count(*) FILTER (WHERE orders.id IS NULL)::int AS orphaned_orders
    FROM public.store_order_cart_info cart
    LEFT JOIN public.store_order orders ON orders.id = cart.oid
    WHERE cart.product_type = 4
  `;

  const notifications = await tx<{
    mark: string;
    rows: number;
    system_enabled: number;
    sms_enabled: number;
    sms_template_configured: number;
  }[]>`
    SELECT mark, count(*)::int AS rows,
      count(*) FILTER (WHERE is_system = 1)::int AS system_enabled,
      count(*) FILTER (WHERE is_sms = 1)::int AS sms_enabled,
      count(*) FILTER (WHERE NULLIF(btrim(sms_id), '') IS NOT NULL)::int
        AS sms_template_configured
    FROM public.system_notification
    WHERE mark IN ('reminder_brink_death', 'expiration_reminder')
    GROUP BY mark
    ORDER BY mark
  `;

  const [refunds] = await tx<{
    active: number;
    waiting_for_return: number;
    platform_scope: number;
    store_scope: number;
    supplier_scope: number;
    missing_store: number;
    missing_supplier: number;
  }[]>`
    SELECT
      count(*) FILTER (WHERE refund.is_cancel = 0 AND refund.is_del = 0)::int AS active,
      count(*) FILTER (
        WHERE refund.is_cancel = 0 AND refund.is_del = 0 AND refund.refund_type IN (4, 5)
      )::int AS waiting_for_return,
      count(*) FILTER (
        WHERE refund.is_cancel = 0 AND refund.is_del = 0
          AND refund.apply_type <> 3 AND refund.supplier_id = 0
      )::int AS platform_scope,
      count(*) FILTER (
        WHERE refund.is_cancel = 0 AND refund.is_del = 0 AND refund.apply_type = 3
      )::int AS store_scope,
      count(*) FILTER (
        WHERE refund.is_cancel = 0 AND refund.is_del = 0
          AND refund.apply_type <> 3 AND refund.supplier_id > 0
      )::int AS supplier_scope,
      count(*) FILTER (
        WHERE refund.is_cancel = 0 AND refund.is_del = 0 AND refund.apply_type = 3
          AND (stores.id IS NULL OR stores.is_del <> 0)
      )::int AS missing_store,
      count(*) FILTER (
        WHERE refund.is_cancel = 0 AND refund.is_del = 0
          AND refund.apply_type <> 3 AND refund.supplier_id > 0
          AND (suppliers.id IS NULL OR suppliers.is_del <> 0)
      )::int AS missing_supplier
    FROM public.store_order_refund refund
    LEFT JOIN public.system_store stores ON stores.id = refund.store_id
    LEFT JOIN public.system_supplier suppliers ON suppliers.id = refund.supplier_id
  `;

  const [relation] = await tx<{
    cart_rows: number;
    cart_total_bytes: number;
    outbox_rows: number;
  }[]>`
    SELECT
      (SELECT count(*)::int FROM public.store_order_cart_info) AS cart_rows,
      pg_total_relation_size('public.store_order_cart_info')::float8 AS cart_total_bytes,
      (SELECT count(*)::int FROM public.store_order_outbox) AS outbox_rows
  `;
  const planRows = await tx.unsafe<Record<string, unknown>[]>(`
    EXPLAIN (FORMAT JSON, COSTS TRUE)
    SELECT cart.id, orders.id
    FROM public.store_order_cart_info cart
    JOIN public.store_order orders ON orders.id = cart.oid AND orders.uid = cart.uid
    WHERE cart.product_type = 4
      AND cart.is_writeoff = 0
      AND cart.write_start > 0
      AND cart.write_end > 0
      AND orders.paid = 1
      AND orders.is_del = 0
      AND orders.is_system_del = 0
      AND orders.refund_status IN (0, 3)
      AND (
        (cart.is_expire_sms = 0 AND cart.write_end < $1)
        OR (cart.is_advent_sms = 0 AND cart.write_end > $1 AND cart.write_end <= $2)
      )
    ORDER BY cart.id
    LIMIT 80
  `, [now, horizon]);
  const platformConfig = ["refund_name", "refund_phone", "refund_address"].map((key) => ({
    key,
    rows: config.get(key)?.row_count ?? 0,
    configured: Boolean(normalizeConfigScalar(config.get(key)?.value).trim()),
  }));
  return {
    database: {
      serverVersion: clock?.server_version ?? "unknown",
      transactionReadOnly: true,
    },
    relation,
    reminder: {
      configuredRows: config.get("reminder_deadline_second_card_time")?.row_count ?? 0,
      windowHours: hours,
      cards,
      notifications,
      scanPlan: summarizePlan(planRows[0]?.["QUERY PLAN"]),
    },
    returns: { refunds, platformConfig },
    indexes: await indexState(tx),
    outboxConstraint: await constraintState(tx),
  };
}

async function runReadOnlyAudit(connectionString: string) {
  const db = createDbFromConnectionString(connectionString, 1, {
    applicationName: "cinashop_second_card_read_only_audit",
  });
  try {
    return await db.$client.begin(async (tx) => {
      await tx`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`;
      await tx`SET TRANSACTION READ ONLY`;
      await tx`SET LOCAL search_path TO public, pg_temp`;
      await tx`SET LOCAL lock_timeout TO '500ms'`;
      await tx`SET LOCAL statement_timeout TO '10s'`;
      return readProduction(tx);
    });
  } finally {
    await db.$client.end({ timeout: 5 });
  }
}

async function applyMigration(connectionString: string) {
  const db = createDbFromConnectionString(connectionString, 1, {
    applicationName: "cinashop_second_card_forward_ddl_audit",
  });
  try {
    return await db.$client.begin(async (tx) => {
      await tx`SET LOCAL search_path TO public, pg_temp`;
      await tx`SET LOCAL lock_timeout TO '2s'`;
      await tx`SET LOCAL statement_timeout TO '15s'`;
      await tx`SELECT pg_advisory_xact_lock(1954231107, 0)`;
      const [size] = await tx<{ cart_rows: number; cart_total_bytes: number }[]>`
        SELECT count(*)::int AS cart_rows,
          pg_total_relation_size('public.store_order_cart_info')::float8 AS cart_total_bytes
        FROM public.store_order_cart_info
      `;
      if (!size || size.cart_rows > 100_000 || size.cart_total_bytes > 67_108_864) {
        throw new Error("second_card_migration_size_precondition_failed");
      }
      const constraintBefore = await constraintState(tx);
      if (constraintBefore.unsupportedRows !== 0) {
        throw new Error("second_card_migration_unknown_outbox_event");
      }
      const before = await businessState(tx);
      for (const statement of MIGRATION_STATEMENTS) await tx.unsafe(statement);
      // Replay the exact migration to prove forward-DDL idempotency.
      for (const statement of MIGRATION_STATEMENTS) await tx.unsafe(statement);
      const after = await businessState(tx);
      const indexes = await indexState(tx);
      const constraint = await constraintState(tx);
      const unchanged = JSON.stringify(before) === JSON.stringify(after);
      const definitionsValid = indexes.length === 2
        && indexes.every((index) => index.indisvalid && index.indisready)
        && indexes.some((index) => index.indexdef.includes("is_advent_sms = 0"))
        && indexes.some((index) => index.indexdef.includes("is_expire_sms = 0"));
      if (!unchanged || !definitionsValid || !constraint.ready || constraint.unsupportedRows !== 0) {
        throw new Error("second_card_migration_verification_failed");
      }
      return {
        applied: true,
        idempotentSecondPass: true,
        businessRowsUnchanged: unchanged,
        relation: size,
        indexes,
        outboxConstraint: constraint,
      };
    });
  } finally {
    await db.$client.end({ timeout: 5 });
  }
}

export default {
  async fetch(request: Request, env: AuditEnv): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (request.method !== "POST" || (path !== "/read" && path !== "/apply")) {
      return response({ error: "not_found" }, 404);
    }
    const verifier = path === "/read"
      ? env.AUDIT_READ_TOKEN_SHA256
      : env.AUDIT_WRITE_TOKEN_SHA256;
    if (!(await authorize(request, verifier))) return response({ error: "forbidden" }, 403);
    try {
      const result = path === "/read"
        ? await runReadOnlyAudit(env.HYPERDRIVE.connectionString)
        : await applyMigration(env.HYPERDRIVE.connectionString);
      return response(result);
    } catch {
      return response({ error: "production_audit_failed" }, 500);
    }
  },
} satisfies ExportedHandler<AuditEnv>;
