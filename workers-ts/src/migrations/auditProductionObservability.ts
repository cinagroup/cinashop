import type { DbClient } from "@/lib/di";

type AuditClient = DbClient["$client"];

type Identity = {
  role_ok: boolean;
  database_ok: boolean;
  backend_login_ok: boolean;
  pg16_ok: boolean;
  read_only_ok: boolean;
  repeatable_read_ok: boolean;
};

/** Fixed aggregate-only audit. The caller owns and closes the connection. */
export async function auditProductionObservability(
  client: AuditClient,
  expected: { role: string; database: string },
) {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(expected.role)
    || !/^[a-z_][a-z0-9_]{0,62}$/.test(expected.database)) {
    throw new Error("Invalid observability connection identity");
  }
  return client.begin(async (tx) => {
    await tx`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`;
    await tx`SET LOCAL search_path = pg_catalog, public, pg_temp`;
    await tx`SET LOCAL statement_timeout = '5s'`;
    await tx`SET LOCAL lock_timeout = '500ms'`;
    await tx`SET LOCAL idle_in_transaction_session_timeout = '7s'`;

    const [identity] = await tx<Identity[]>`
      SELECT
        (current_user = ${expected.role} AND session_user = ${expected.role}) AS role_ok,
        current_database() = ${expected.database} AS database_ok,
        EXISTS (
          SELECT 1 FROM pg_catalog.pg_stat_activity a
          JOIN pg_catalog.pg_roles r ON r.oid = a.usesysid
          WHERE a.pid = pg_catalog.pg_backend_pid() AND r.rolname = ${expected.role}
        ) AS backend_login_ok,
        current_setting('server_version_num')::integer / 10000 = 16 AS pg16_ok,
        current_setting('transaction_read_only') = 'on' AS read_only_ok,
        current_setting('transaction_isolation') = 'repeatable read' AS repeatable_read_ok
    `;
    if (!identity || Object.values(identity).some((value) => value !== true)) {
      throw new Error("Observability connection identity or read-only snapshot differs");
    }

    const [settings] = await tx<Record<string, string>[]>`
      SELECT
        current_setting('server_version') AS server_version,
        current_setting('track_activities') AS track_activities,
        current_setting('track_counts') AS track_counts,
        current_setting('track_io_timing') AS track_io_timing,
        current_setting('compute_query_id') AS compute_query_id,
        current_setting('log_min_duration_statement') AS log_min_duration_statement,
        current_setting('statement_timeout') AS statement_timeout,
        current_setting('idle_in_transaction_session_timeout') AS idle_in_transaction_session_timeout
    `;
    if (!settings) throw new Error("Observability settings unavailable");
    const extensions = await tx<{ extname: string }[]>`
      SELECT extname FROM pg_catalog.pg_extension
      WHERE extname IN ('pg_stat_statements', 'pg_stat_monitor') ORDER BY extname
    `;
    const [statsAccess] = await tx<{
      pg_stat_statements_available: boolean;
      read_all_stats: boolean;
    }[]>`
      SELECT
        pg_catalog.to_regclass('public.pg_stat_statements') IS NOT NULL AS pg_stat_statements_available,
        (
          pg_catalog.pg_has_role(current_user, 'pg_read_all_stats', 'USAGE') OR
          pg_catalog.pg_has_role(current_user, 'pg_monitor', 'USAGE') OR
          (SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname = current_user)
        ) AS read_all_stats
    `;
    if (!statsAccess) throw new Error("Observability statistics access unavailable");
    const statementSummary = statsAccess.pg_stat_statements_available && statsAccess.read_all_stats
      ? await tx<Record<string, number | string>[]>`
          SELECT count(*)::int AS statements,
            coalesce(sum(calls), 0)::bigint AS calls,
            coalesce(sum(rows), 0)::bigint AS rows,
            round(coalesce(sum(total_exec_time), 0)::numeric, 3)::float8 AS total_exec_ms,
            round(coalesce(max(max_exec_time), 0)::numeric, 3)::float8 AS maximum_exec_ms
          FROM public.pg_stat_statements
          WHERE dbid = (SELECT oid FROM pg_catalog.pg_database WHERE datname = current_database())
        `
      : [];
    const [databaseStats] = await tx<Record<string, number | string | null>[]>`
      SELECT numbackends::int, xact_commit::bigint, xact_rollback::bigint,
        blks_read::bigint, blks_hit::bigint, temp_files::bigint, temp_bytes::bigint,
        deadlocks::bigint, checksum_failures::bigint,
        round(session_time::numeric, 3)::float8 AS session_time_ms,
        round(active_time::numeric, 3)::float8 AS active_time_ms,
        round(idle_in_transaction_time::numeric, 3)::float8 AS idle_in_transaction_time_ms,
        stats_reset::text
      FROM pg_catalog.pg_stat_database WHERE datname = current_database()
    `;
    if (!databaseStats) throw new Error("Observability database statistics unavailable");
    const activityGroups = statsAccess.read_all_stats && settings.track_activities === 'on'
      ? await tx<{
          state: string; wait_event_type: string; sessions: number;
          transactions_over_1s: number; transactions_over_5s: number;
        }[]>`
          SELECT coalesce(state, 'unknown') AS state,
            coalesce(wait_event_type, 'none') AS wait_event_type,
            count(*)::int AS sessions,
            count(*) FILTER (WHERE xact_start < clock_timestamp() - interval '1 second')::int
              AS transactions_over_1s,
            count(*) FILTER (WHERE xact_start < clock_timestamp() - interval '5 seconds')::int
              AS transactions_over_5s
          FROM pg_catalog.pg_stat_activity
          WHERE datname = current_database() AND pid <> pg_catalog.pg_backend_pid()
          GROUP BY coalesce(state, 'unknown'), coalesce(wait_event_type, 'none')
          ORDER BY state, wait_event_type
        `
      : null;
    // Other sessions can disable activity tracking independently. An observed
    // disabled group makes the whole activity snapshot incomplete.
    const activity = activityGroups?.some((row) => row.state === 'disabled')
      ? null : activityGroups;
    const workflowStatus = await tx<{ workflow: string; status: string; rows: number }[]>`
      SELECT workflow, status, count(*)::int AS rows FROM (
        SELECT 'print'::text AS workflow,
          CASE WHEN status IN ('PENDING', 'ENQUEUING', 'ENQUEUED', 'PROCESSING',
            'RETRYABLE', 'SENT', 'UNKNOWN', 'DEAD', 'CLOSED')
            THEN status::text ELSE 'OTHER' END AS status
        FROM public.order_print_job
        UNION ALL
        SELECT 'waybill',
          CASE WHEN status IN ('PENDING', 'ENQUEUING', 'ENQUEUED', 'PROCESSING',
            'RETRYABLE', 'SENT', 'UNKNOWN', 'DEAD', 'CLOSED')
            THEN status::text ELSE 'OTHER' END
        FROM public.order_waybill_job
        UNION ALL
        SELECT 'refund_payment',
          CASE WHEN provider_status IN ('CREATED', 'REQUESTING', 'PROCESSING',
            'SUCCESS', 'CLOSED', 'ABNORMAL', 'FAILED', 'UNKNOWN')
            THEN provider_status::text ELSE 'OTHER' END
        FROM public.store_order_refund_payment
        UNION ALL
        SELECT 'queue_dead_letter',
          CASE WHEN status IN ('OPEN', 'REPLAYING', 'REPLAYED', 'RESOLVED')
            THEN status::text ELSE 'OTHER' END
        FROM public.system_queue_dead_letter
      ) classified
      GROUP BY workflow, status
      ORDER BY workflow, status
    `;
    const [workflowAttention] = await tx<Record<string, number | string | null>[]>`
      SELECT
        (SELECT count(*)::int FROM public.order_print_job
          WHERE status IN ('UNKNOWN', 'DEAD')) AS print_attention,
        (SELECT count(*)::int FROM public.order_waybill_job
          WHERE status IN ('UNKNOWN', 'DEAD')) AS waybill_attention,
        (SELECT count(*)::int FROM public.store_order_refund_payment
          WHERE provider_status IN ('UNKNOWN', 'ABNORMAL', 'FAILED')) AS refund_attention,
        (SELECT count(*)::int FROM public.system_queue_dead_letter
          WHERE status IN ('OPEN', 'REPLAYING')) AS dead_letter_attention,
        (SELECT greatest(0, coalesce(extract(epoch FROM clock_timestamp())::bigint
          - min(update_time), 0))::bigint
          FROM public.store_order_refund_payment
          WHERE provider_status = 'UNKNOWN') AS oldest_unknown_refund_seconds
    `;
    if (!workflowAttention) throw new Error("Observability workflow statistics unavailable");
    const relationStats = await tx<Record<string, number | string | null>[]>`
      SELECT relname, seq_scan::bigint, idx_scan::bigint, n_live_tup::bigint,
        n_dead_tup::bigint, last_analyze::text, last_autoanalyze::text
      FROM pg_catalog.pg_stat_user_tables
      WHERE schemaname = 'public' AND relname IN (
        'order_print_job', 'order_waybill_job', 'store_order_refund_payment',
        'system_queue_dead_letter', 'store_order', 'store_product', 'user'
      ) ORDER BY relname
    `;
    const required = ['order_print_job', 'order_waybill_job',
      'store_order_refund_payment', 'system_queue_dead_letter'];
    if (required.some((name) => !relationStats.some((row) => row.relname === name))) {
      throw new Error("Observability relation statistics incomplete");
    }
    return {
      generatedAt: new Date().toISOString(),
      scope: 'production-observability-db-aggregate' as const,
      ready: statsAccess.read_all_stats && settings.track_counts === 'on'
        && settings.track_activities === 'on' && activity !== null,
      settings,
      extensions: extensions.map((row) => row.extname),
      statementStatistics: {
        available: statsAccess.pg_stat_statements_available,
        authorized: statsAccess.read_all_stats,
        aggregate: statementSummary[0] ?? null,
        queryTextReturned: false,
      },
      databaseStats,
      activity,
      workflowStatus,
      workflowAttention,
      relationStats,
      safety: {
        identityVerified: true,
        transactionReadOnly: true,
        repeatableRead: true,
        queryTextReturned: false,
        businessValuesReturned: false,
      },
    };
  });
}
