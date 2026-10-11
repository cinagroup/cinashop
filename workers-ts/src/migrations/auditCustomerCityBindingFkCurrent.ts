import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { DbClient } from '../lib/di';

/** Fixed catalog/size evidence only. No table rows, row counts, plans or writes. */
const names = ['customer_city_delivery_attempt', 'customer_city_delivery_binding'] as const;
type TableName = typeof names[number];
type TableRow = { name: string; present: boolean; estimated_rows: string | null;
  live_rows_estimate: string | null; modifications_since_analyze: string | null;
  heap_bytes: string | null; index_bytes: string | null; total_bytes: string | null;
  last_analyze_ms: string | null; last_autoanalyze_ms: string | null };
type ForeignKeyRow = { exact: boolean };
type IndexRow = { name: string; definition: string; leading: boolean; usable: boolean;
  partial: boolean; expression: boolean };

function decimal(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || !/^\d{1,20}$/.test(value))
    throw new Error('Unexpected city FK catalog number');
  return value;
}

export async function auditCustomerCityBindingFkCurrent(
  db: Pick<DbClient, 'transaction'> & Partial<Pick<DbClient, '$client'>>,
  expected: { role: string; database: string },
) {
  if (!db.$client) throw new Error('City FK audit requires a root database');
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(expected.role)
    || !/^[a-z_][a-z0-9_]{0,62}$/.test(expected.database))
    throw new Error('Invalid expected city FK connection identity');

  return db.transaction(async tx => {
    await tx.execute(sql.raw(`SELECT
      pg_catalog.set_config('statement_timeout', LEAST(COALESCE(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='statement_timeout'),0),5000),5000)::text || 'ms',true),
      pg_catalog.set_config('lock_timeout', LEAST(COALESCE(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='lock_timeout'),0),1000),1000)::text || 'ms',true),
      pg_catalog.set_config('idle_in_transaction_session_timeout', LEAST(COALESCE(NULLIF((SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000),5000)::text || 'ms',true)`));
    const [identity] = await tx.execute(sql<{ matches: boolean }>`SELECT (
      current_user = ${expected.role} AND session_user = ${expected.role}
      AND current_database() = ${expected.database}
      AND current_setting('server_version_num')::integer / 10000 = 16
      AND EXISTS (SELECT 1 FROM pg_catalog.pg_stat_activity a
        JOIN pg_catalog.pg_roles r ON r.oid = a.usesysid
        WHERE a.pid = pg_catalog.pg_backend_pid() AND r.rolname = ${expected.role})
    ) AS matches`);
    const empty = { scope: 'city-binding-fk-metadata-only' as const,
      identityMatch: identity?.matches === true, catalogMatch: false,
      tables: null, foreignKey: null, indexes: null, readyForIndexDecision: false as const };
    if (identity?.matches !== true) return empty;

    const tableRows = Array.from(await tx.execute(sql<TableRow>`
      WITH wanted(ord,name) AS (VALUES
        (1,'customer_city_delivery_attempt'),(2,'customer_city_delivery_binding'))
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
    if (tableRows.length !== 2 || tableRows.some((row, i) => row.name !== names[i]
      || typeof row.present !== 'boolean')) throw new Error('City FK table result shape changed');
    if (tableRows.some(row => !row.present)) return empty;

    const [foreignKey] = Array.from(await tx.execute(sql<ForeignKeyRow>`
      SELECT COALESCE(
        fk.contype='f' AND fk.convalidated AND NOT fk.condeferrable AND NOT fk.condeferred
        AND fk.confdeltype='r' AND fk.confupdtype='a'
        AND fk.confmatchtype='s' AND fk.conkey=ARRAY[child_column.attnum]::smallint[]
        AND fk.confkey=ARRAY[parent_column.attnum]::smallint[]
        AND child_column.attnotnull AND child_column.atttypid='pg_catalog.int8'::regtype
        AND parent_column.attnotnull AND parent_column.atttypid='pg_catalog.int8'::regtype
        AND EXISTS (SELECT 1 FROM pg_catalog.pg_constraint parent_pk
          WHERE parent_pk.conrelid=parent.oid AND parent_pk.contype='p'
            AND parent_pk.conkey=ARRAY[parent_column.attnum]::smallint[]), false) AS exact
      FROM (VALUES (1)) seed(ord)
      JOIN pg_catalog.pg_namespace n ON n.nspname='public'
      JOIN pg_catalog.pg_class child ON child.relnamespace=n.oid
        AND child.relname='customer_city_delivery_binding' AND child.relkind='r'
        AND child.relpersistence='p' AND NOT child.relispartition
      JOIN pg_catalog.pg_class parent ON parent.relnamespace=n.oid
        AND parent.relname='customer_city_delivery_attempt' AND parent.relkind='r'
        AND parent.relpersistence='p' AND NOT parent.relispartition
      JOIN pg_catalog.pg_attribute child_column ON child_column.attrelid=child.oid
        AND child_column.attname='attempt_id' AND child_column.attnum>0 AND NOT child_column.attisdropped
      JOIN pg_catalog.pg_attribute parent_column ON parent_column.attrelid=parent.oid
        AND parent_column.attname='id' AND parent_column.attnum>0 AND NOT parent_column.attisdropped
      LEFT JOIN pg_catalog.pg_constraint fk ON fk.conrelid=child.oid
        AND fk.confrelid=parent.oid AND fk.conname='ccdbinding_attempt_fk'`)) as ForeignKeyRow[];
    if (!foreignKey || foreignKey.exact !== true) return empty;

    // Inspect every child index, including invalid, partial and expression
    // entries. A bounded result prevents an unexpected catalog from expanding
    // the public response or Worker memory. No index definition leaves Worker.
    const indexRows = Array.from(await tx.execute(sql<IndexRow>`
      SELECT ic.relname AS name, pg_catalog.pg_get_indexdef(ix.indexrelid) AS definition,
        (ix.indkey[0]=a.attnum) AS leading,
        (ic.relkind='i' AND ic.relpersistence='p' AND am.amname='btree'
          AND ix.indisvalid AND ix.indisready AND ix.indislive
          AND ix.indexprs IS NULL) AS usable,
        (ix.indpred IS NOT NULL) AS partial,
        (ix.indexprs IS NOT NULL) AS expression
      FROM pg_catalog.pg_namespace n
      JOIN pg_catalog.pg_class child ON child.relnamespace=n.oid
        AND child.relname='customer_city_delivery_binding'
      JOIN pg_catalog.pg_attribute a ON a.attrelid=child.oid AND a.attname='attempt_id'
        AND a.attnum>0 AND NOT a.attisdropped
      JOIN pg_catalog.pg_index ix ON ix.indrelid=child.oid
      JOIN pg_catalog.pg_class ic ON ic.oid=ix.indexrelid
      JOIN pg_catalog.pg_am am ON am.oid=ic.relam
      WHERE n.nspname='public' ORDER BY ic.relname LIMIT 33`)) as IndexRow[];
    if (indexRows.length > 32 || indexRows.some(row => !/^[a-z_][a-z0-9_]{0,62}$/.test(row.name)
      || typeof row.definition !== 'string' || row.definition.length > 2048
      || typeof row.leading !== 'boolean' || typeof row.usable !== 'boolean'
      || typeof row.partial !== 'boolean' || typeof row.expression !== 'boolean'))
      throw new Error('City FK index catalog exceeds reviewed bounds');

    const tables = Object.fromEntries(tableRows.map(row => [row.name as TableName, {
      estimatedRows: decimal(row.estimated_rows), liveRowsEstimate: decimal(row.live_rows_estimate),
      modificationsSinceAnalyze: decimal(row.modifications_since_analyze),
      heapBytes: decimal(row.heap_bytes), indexBytes: decimal(row.index_bytes),
      totalBytes: decimal(row.total_bytes), lastAnalyzeMs: decimal(row.last_analyze_ms),
      lastAutoanalyzeMs: decimal(row.last_autoanalyze_ms),
    }])) as Record<TableName, { estimatedRows: string | null; liveRowsEstimate: string | null;
      modificationsSinceAnalyze: string | null; heapBytes: string | null; indexBytes: string | null;
      totalBytes: string | null; lastAnalyzeMs: string | null; lastAutoanalyzeMs: string | null }>;
    const digest = createHash('sha256').update(indexRows.map(row => `${row.name}:${row.definition}`).join('\n')).digest('hex');
    return { scope: 'city-binding-fk-metadata-only' as const,
      identityMatch: true, catalogMatch: true, tables,
      foreignKey: { name: 'ccdbinding_attempt_fk' as const, exact: true as const },
      indexes: { catalogSha256: digest, count: indexRows.length,
        leadingAny: indexRows.filter(row => row.leading).length,
        leadingUsableNonpartial: indexRows.filter(row => row.leading && row.usable && !row.partial).length,
        leadingUsablePartial: indexRows.filter(row => row.leading && row.usable && row.partial).length,
        expression: indexRows.filter(row => row.expression).length },
      readyForIndexDecision: false as const };
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
}
