import { createDbFromConnectionString } from "@/lib/di";

interface AuditEnv {
  HYPERDRIVE: Hyperdrive;
  AUDIT_TOKEN_SHA256: string;
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

export default {
  async fetch(request: Request, env: AuditEnv): Promise<Response> {
    if (!(await authorize(request, env.AUDIT_TOKEN_SHA256))) {
      return Response.json({ error: "forbidden" }, { status: 403 });
    }
    if (request.method !== "GET" || new URL(request.url).pathname !== "/observability") {
      return Response.json({ error: "not found" }, { status: 404 });
    }

    const db = createDbFromConnectionString(env.HYPERDRIVE.connectionString, 1, {
      applicationName: "cinashop_observability_audit",
    });
    try {
      const result = await db.$client.begin(async (tx) => {
        await tx.unsafe("SET TRANSACTION READ ONLY");
        await tx`SET LOCAL search_path TO public, pg_temp`;
        await tx`SET LOCAL statement_timeout TO '5s'`;
        await tx`SET LOCAL lock_timeout TO '500ms'`;

        const [version] = await tx<{
          server_version: string;
          transaction_read_only: string;
          track_activities: string;
          track_counts: string;
          track_io_timing: string;
          compute_query_id: string;
          log_min_duration_statement: string;
          statement_timeout: string;
          idle_in_transaction_session_timeout: string;
        }[]>`
          SELECT
            current_setting('server_version') AS server_version,
            current_setting('transaction_read_only') AS transaction_read_only,
            current_setting('track_activities') AS track_activities,
            current_setting('track_counts') AS track_counts,
            current_setting('track_io_timing') AS track_io_timing,
            current_setting('compute_query_id') AS compute_query_id,
            current_setting('log_min_duration_statement') AS log_min_duration_statement,
            current_setting('statement_timeout') AS statement_timeout,
            current_setting('idle_in_transaction_session_timeout') AS idle_in_transaction_session_timeout
        `;
        const extensions = await tx<{ extname: string }[]>`
          SELECT extname FROM pg_extension
          WHERE extname IN ('pg_stat_statements', 'pg_stat_monitor')
          ORDER BY extname
        `;
        const [statsAccess] = await tx<{
          pg_stat_statements_available: boolean;
          read_all_stats: boolean;
        }[]>`
          SELECT
            to_regclass('public.pg_stat_statements') IS NOT NULL AS pg_stat_statements_available,
            (
              pg_has_role(current_user, 'pg_read_all_stats', 'member') OR
              pg_has_role(current_user, 'pg_monitor', 'member') OR
              (SELECT rolsuper FROM pg_roles WHERE rolname = current_user)
            ) AS read_all_stats
        `;
        const statementSummary = statsAccess?.pg_stat_statements_available && statsAccess.read_all_stats
          ? await tx<{
              statements: number;
              calls: number;
              rows: number;
              total_exec_ms: number;
              maximum_exec_ms: number;
            }[]>`
              SELECT
                count(*)::int AS statements,
                coalesce(sum(calls), 0)::bigint AS calls,
                coalesce(sum(rows), 0)::bigint AS rows,
                round(coalesce(sum(total_exec_time), 0)::numeric, 3)::float8 AS total_exec_ms,
                round(coalesce(max(max_exec_time), 0)::numeric, 3)::float8 AS maximum_exec_ms
              FROM public.pg_stat_statements
              WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
            `
          : [];
        const [databaseStats] = await tx<Record<string, number | string | null>[]>`
          SELECT
            numbackends::int,
            xact_commit::bigint,
            xact_rollback::bigint,
            blks_read::bigint,
            blks_hit::bigint,
            temp_files::bigint,
            temp_bytes::bigint,
            deadlocks::bigint,
            checksum_failures::bigint,
            round(session_time::numeric, 3)::float8 AS session_time_ms,
            round(active_time::numeric, 3)::float8 AS active_time_ms,
            round(idle_in_transaction_time::numeric, 3)::float8 AS idle_in_transaction_time_ms,
            stats_reset::text
          FROM pg_stat_database
          WHERE datname = current_database()
        `;
        const activity = await tx<{
          state: string;
          wait_event_type: string;
          sessions: number;
          transactions_over_1s: number;
          transactions_over_5s: number;
        }[]>`
          SELECT
            coalesce(state, 'unknown') AS state,
            coalesce(wait_event_type, 'none') AS wait_event_type,
            count(*)::int AS sessions,
            count(*) FILTER (WHERE xact_start < clock_timestamp() - interval '1 second')::int AS transactions_over_1s,
            count(*) FILTER (WHERE xact_start < clock_timestamp() - interval '5 seconds')::int AS transactions_over_5s
          FROM pg_stat_activity
          WHERE datname = current_database() AND pid <> pg_backend_pid()
          GROUP BY coalesce(state, 'unknown'), coalesce(wait_event_type, 'none')
          ORDER BY state, wait_event_type
        `;
        const workflowStatus = await tx<{ workflow: string; status: string; rows: number }[]>`
          SELECT 'print' AS workflow, status::text, count(*)::int AS rows
          FROM order_print_job GROUP BY status
          UNION ALL
          SELECT 'waybill', status::text, count(*)::int
          FROM order_waybill_job GROUP BY status
          UNION ALL
          SELECT 'refund_payment', status::text, count(*)::int
          FROM store_order_refund_payment GROUP BY status
          UNION ALL
          SELECT 'queue_dead_letter', status::text, count(*)::int
          FROM system_queue_dead_letter GROUP BY status
          ORDER BY workflow, status
        `;
        const workflowAge = await tx<Record<string, number | null>[]>`
          SELECT
            (SELECT count(*)::int FROM order_print_job WHERE status IN ('UNKNOWN', 'DEAD')) AS print_attention,
            (SELECT count(*)::int FROM order_waybill_job WHERE status IN ('UNKNOWN', 'DEAD')) AS waybill_attention,
            (SELECT count(*)::int FROM store_order_refund_payment WHERE status IN ('UNKNOWN', 'DEAD')) AS refund_attention,
            (SELECT count(*)::int FROM system_queue_dead_letter WHERE status IN ('OPEN', 'REPLAYING')) AS dead_letter_attention,
            (SELECT coalesce(extract(epoch FROM clock_timestamp())::bigint - min(update_time), 0)::bigint
             FROM store_order_refund_payment WHERE status = 'UNKNOWN') AS oldest_unknown_refund_seconds
        `;
        const relationStats = await tx<Record<string, number | string | null>[]>`
          SELECT
            relname,
            seq_scan::bigint,
            idx_scan::bigint,
            n_live_tup::bigint,
            n_dead_tup::bigint,
            last_analyze::text,
            last_autoanalyze::text
          FROM pg_stat_user_tables
          WHERE schemaname = 'public' AND relname IN (
            'order_print_job', 'order_waybill_job', 'store_order_refund_payment',
            'system_queue_dead_letter', 'store_order', 'store_product', 'user'
          )
          ORDER BY relname
        `;

        return {
          generatedAt: new Date().toISOString(),
          settings: version,
          extensions: extensions.map((row) => row.extname),
          statementStatistics: {
            available: statsAccess?.pg_stat_statements_available ?? false,
            authorized: statsAccess?.read_all_stats ?? false,
            aggregate: statementSummary[0] ?? null,
            queryTextReturned: false,
          },
          databaseStats,
          activity,
          workflowStatus,
          workflowAttention: workflowAge[0],
          relationStats,
          safety: {
            transactionReadOnly: version?.transaction_read_only === "on",
            queryTextReturned: false,
            businessValuesReturned: false,
          },
        };
      });
      return Response.json(result);
    } catch (error) {
      return Response.json({
        error: error instanceof Error ? error.name : "unknown_error",
      }, { status: 500 });
    } finally {
      await db.$client.end({ timeout: 1 });
    }
  },
} satisfies ExportedHandler<AuditEnv>;
