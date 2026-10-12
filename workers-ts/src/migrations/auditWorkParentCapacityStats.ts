import { sql } from 'drizzle-orm';
import type { DbClient } from '../lib/di';

/** Fixed, read-only planner metadata. Estimates are not row counts or a
 * retention policy, and this audit never samples rows or changes statistics. */
const expectedTables = ['work_client_current', 'work_callback_event', 'work_contact_action_outbox'] as const;
const expectedColumns = ['corp_id', 'client_id'] as const;
type TableName = typeof expectedTables[number];
type ColumnName = typeof expectedColumns[number];
type TableRow = { name: string; present: boolean; estimated_rows: string | null;
  live_rows_estimate: string | null; modifications_since_analyze: string | null;
  heap_bytes: string | null; index_bytes: string | null; total_bytes: string | null;
  last_analyze_ms: string | null; last_autoanalyze_ms: string | null };
type IndexRow = { present: boolean; exact: boolean; estimated_rows: string | null; bytes: string | null };
type ColumnRow = { name: string; present: boolean; target: number | null; effective_target: number | null };

function boundedDecimal(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !/^\d{1,20}$/.test(value))
    throw new Error('Unexpected work-parent catalog number');
  return value;
}

export async function auditWorkParentCapacityStats(
  db: Pick<DbClient, 'transaction'> & Partial<Pick<DbClient, '$client'>>,
  expectedConnection: { role: string; database: string },
) {
  if (!db.$client) throw new Error('Work-parent capacity audit requires a root database');
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(expectedConnection.role)
    || !/^[a-z_][a-z0-9_]{0,62}$/.test(expectedConnection.database)) {
    throw new Error('Invalid expected work-parent capacity connection identity');
  }
  return db.transaction(async tx => {
    await tx.execute(sql.raw(`SELECT
      pg_catalog.set_config('statement_timeout', LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='statement_timeout'),0),5000)::text || 'ms',true),
      pg_catalog.set_config('lock_timeout', LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='lock_timeout'),0),1000)::text || 'ms',true),
      pg_catalog.set_config('idle_in_transaction_session_timeout', LEAST(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000)::text || 'ms',true)`));
    // The identity guard and all metadata reads share one PG16 backend and one
    // read-only snapshot. Hyperdrive may choose a different backend per txn.
    const [identity] = await tx.execute(sql<{ matches: boolean }>`SELECT (
      current_user = ${expectedConnection.role}
      AND session_user = ${expectedConnection.role}
      AND current_database() = ${expectedConnection.database}
      AND current_setting('server_version_num')::integer / 10000 = 16
      AND (SELECT count(*) = 1 FROM pg_catalog.pg_stat_activity a
        JOIN pg_catalog.pg_roles r ON r.oid = a.usesysid
        WHERE a.pid = pg_catalog.pg_backend_pid() AND r.rolname = ${expectedConnection.role})
    ) AS matches`);
    if (identity?.matches !== true) {
      return { scope: 'work-parent-capacity-metadata-only' as const,
        identityMatch: false, catalogMatch: false, tables: null, index: null, statisticsTargets: null };
    }

    const tableRows = Array.from(await tx.execute(sql<TableRow>`
      WITH wanted(ord,name) AS (VALUES
        (1,'work_client_current'),(2,'work_callback_event'),(3,'work_contact_action_outbox'))
      SELECT w.name, (c.oid IS NOT NULL) AS present,
        CASE WHEN c.reltuples >= 0 THEN ceil(c.reltuples)::bigint::text END AS estimated_rows,
        s.n_live_tup::text AS live_rows_estimate,
        s.n_mod_since_analyze::text AS modifications_since_analyze,
        CASE WHEN c.oid IS NOT NULL THEN pg_catalog.pg_relation_size(c.oid)::text END AS heap_bytes,
        CASE WHEN c.oid IS NOT NULL THEN pg_catalog.pg_indexes_size(c.oid)::text END AS index_bytes,
        CASE WHEN c.oid IS NOT NULL THEN pg_catalog.pg_total_relation_size(c.oid)::text END AS total_bytes,
        (extract(epoch FROM s.last_analyze)*1000)::bigint::text AS last_analyze_ms,
        (extract(epoch FROM s.last_autoanalyze)*1000)::bigint::text AS last_autoanalyze_ms
      FROM wanted w
      LEFT JOIN pg_catalog.pg_namespace n ON n.nspname='public'
      LEFT JOIN pg_catalog.pg_class c ON c.relnamespace=n.oid AND c.relname=w.name
        AND c.relkind='r' AND c.relpersistence='p' AND NOT c.relispartition
      LEFT JOIN pg_catalog.pg_stat_all_tables s ON s.relid=c.oid
      ORDER BY w.ord`)) as TableRow[];
    const [indexRow] = Array.from(await tx.execute(sql<IndexRow>`
      SELECT (ic.oid IS NOT NULL) AS present,
        COALESCE(ic.relkind='i' AND ic.relpersistence='p' AND ic.reloptions IS NULL
          AND ic.reltablespace=0 AND ic.relowner=tc.relowner AND ix.indrelid=tc.oid
          AND NOT ix.indisunique AND NOT ix.indisprimary AND NOT ix.indisexclusion
          AND ix.indisvalid AND ix.indisready AND ix.indislive AND ix.indimmediate
          AND NOT ix.indnullsnotdistinct AND NOT ix.indisreplident
          AND ix.indnkeyatts=2 AND ix.indnatts=2 AND ix.indexprs IS NULL AND ix.indpred IS NULL
          AND pg_catalog.pg_get_indexdef(ix.indexrelid)=
            'CREATE INDEX wcao_client_ref ON public.work_contact_action_outbox USING btree (corp_id, client_id)'
          AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint owner WHERE owner.conindid=ix.indexrelid),false) AS exact,
        CASE WHEN ic.reltuples >= 0 THEN ceil(ic.reltuples)::bigint::text END AS estimated_rows,
        CASE WHEN ic.oid IS NOT NULL THEN pg_catalog.pg_relation_size(ic.oid)::text END AS bytes
      FROM (VALUES (1)) seed(ord)
      LEFT JOIN pg_catalog.pg_namespace n ON n.nspname='public'
      LEFT JOIN pg_catalog.pg_class tc ON tc.relnamespace=n.oid AND tc.relname='work_contact_action_outbox'
        AND tc.relkind='r' AND tc.relpersistence='p' AND NOT tc.relispartition
      LEFT JOIN pg_catalog.pg_class ic ON ic.relnamespace=n.oid AND ic.relname='wcao_client_ref'
      LEFT JOIN pg_catalog.pg_index ix ON ix.indexrelid=ic.oid`)) as IndexRow[];
    const columnRows = Array.from(await tx.execute(sql<ColumnRow>`
      WITH wanted(ord,name) AS (VALUES (1,'corp_id'),(2,'client_id'))
      SELECT w.name, (a.attnum IS NOT NULL) AS present,
        a.attstattarget AS target,
        CASE WHEN a.attstattarget=-1 THEN current_setting('default_statistics_target')::integer
          ELSE a.attstattarget END AS effective_target
      FROM wanted w
      LEFT JOIN pg_catalog.pg_namespace n ON n.nspname='public'
      LEFT JOIN pg_catalog.pg_class c ON c.relnamespace=n.oid AND c.relname='work_contact_action_outbox'
        AND c.relkind='r' AND c.relpersistence='p' AND NOT c.relispartition
      LEFT JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid AND a.attname=w.name
        AND a.attnum>0 AND NOT a.attisdropped
      ORDER BY w.ord`)) as ColumnRow[];

    if (tableRows.length !== 3 || columnRows.length !== 2 || !indexRow
      || tableRows.some((row, n) => row.name !== expectedTables[n])
      || columnRows.some((row, n) => row.name !== expectedColumns[n])) {
      throw new Error('Work-parent catalog result shape changed');
    }
    const catalogMatch = tableRows.every(row => row.present === true)
      && indexRow.exact === true && columnRows.every(row => row.present === true);
    if (!catalogMatch) {
      return { scope: 'work-parent-capacity-metadata-only' as const,
        identityMatch: true, catalogMatch: false, tables: null, index: null, statisticsTargets: null };
    }
    const tables = Object.fromEntries(tableRows.map(row => [row.name as TableName, {
      estimatedRows: boundedDecimal(row.estimated_rows),
      liveRowsEstimate: boundedDecimal(row.live_rows_estimate),
      modificationsSinceAnalyze: boundedDecimal(row.modifications_since_analyze),
      heapBytes: boundedDecimal(row.heap_bytes), indexBytes: boundedDecimal(row.index_bytes),
      totalBytes: boundedDecimal(row.total_bytes),
      lastAnalyzeMs: boundedDecimal(row.last_analyze_ms),
      lastAutoanalyzeMs: boundedDecimal(row.last_autoanalyze_ms),
    }])) as Record<TableName, { estimatedRows: string | null; liveRowsEstimate: string | null;
      modificationsSinceAnalyze: string | null; heapBytes: string | null; indexBytes: string | null;
      totalBytes: string | null; lastAnalyzeMs: string | null; lastAutoanalyzeMs: string | null }>;
    const index = { name: 'wcao_client_ref' as const, exact: true as const,
      estimatedRows: boundedDecimal(indexRow.estimated_rows), bytes: boundedDecimal(indexRow.bytes) };
    const statisticsTargets = Object.fromEntries(columnRows.map(row => {
      if (typeof row.target !== 'number' || !Number.isInteger(row.target)
        || row.target < -1 || row.target > 10000
        || typeof row.effective_target !== 'number' || !Number.isInteger(row.effective_target)
        || row.effective_target < 0 || row.effective_target > 10000) {
        throw new Error('Unexpected work-parent statistics target');
      }
      return [row.name as ColumnName, { configured: row.target, effective: row.effective_target }];
    })) as Record<ColumnName, { configured: number; effective: number }>;
    return { scope: 'work-parent-capacity-metadata-only' as const,
      identityMatch: true, catalogMatch: true, tables, index, statisticsTargets };
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
}
