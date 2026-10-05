import { sql } from 'drizzle-orm';
import type { DbClient } from '../lib/di';
import { inspectRuntimeAgentLevelCatalogBoundary, type AgentLevelRuntimeNames } from './runtimeAgentLevelCatalogBoundary';

/** Existing 0011/0051 tables only. This inspector never creates or repairs objects. */
export const AGENT_LEVEL_RUNTIME_TABLES = ['agent_level', 'agent_level_task', 'agent_level_task_record'] as const;
const literal = (value: string | boolean | null) => value === null ? 'NULL'
  : typeof value === 'boolean' ? String(value) : "'" + value.replaceAll("'", "''") + "'";
const columns = [
  [
    "agent_level",
    "id",
    "integer",
    "nextval('agent_level_id_seq'::regclass)",
    true
  ],
  [
    "agent_level",
    "name",
    "character varying(50)",
    "''::character varying",
    true
  ],
  [
    "agent_level",
    "image",
    "character varying(255)",
    "''::character varying",
    true
  ],
  [
    "agent_level",
    "color",
    "character varying(32)",
    "''::character varying",
    true
  ],
  [
    "agent_level",
    "one_brokerage",
    "smallint",
    "0",
    true
  ],
  [
    "agent_level",
    "two_brokerage",
    "smallint",
    "0",
    true
  ],
  [
    "agent_level",
    "grade",
    "smallint",
    "0",
    true
  ],
  [
    "agent_level",
    "status",
    "smallint",
    "1",
    true
  ],
  [
    "agent_level",
    "is_del",
    "smallint",
    "0",
    true
  ],
  [
    "agent_level",
    "add_time",
    "integer",
    "0",
    true
  ],
  [
    "agent_level_task",
    "id",
    "integer",
    "nextval('agent_level_task_id_seq'::regclass)",
    true
  ],
  [
    "agent_level_task",
    "level_id",
    "integer",
    "0",
    true
  ],
  [
    "agent_level_task",
    "name",
    "character varying(50)",
    "''::character varying",
    true
  ],
  [
    "agent_level_task",
    "type",
    "smallint",
    "0",
    true
  ],
  [
    "agent_level_task",
    "number",
    "integer",
    "0",
    true
  ],
  [
    "agent_level_task",
    "desc",
    "character varying(255)",
    "''::character varying",
    true
  ],
  [
    "agent_level_task",
    "is_must",
    "smallint",
    "0",
    true
  ],
  [
    "agent_level_task",
    "sort",
    "smallint",
    "0",
    true
  ],
  [
    "agent_level_task",
    "status",
    "smallint",
    "1",
    true
  ],
  [
    "agent_level_task",
    "is_del",
    "smallint",
    "0",
    true
  ],
  [
    "agent_level_task",
    "add_time",
    "integer",
    "0",
    true
  ],
  [
    "agent_level_task_record",
    "id",
    "integer",
    "nextval('agent_level_task_record_id_seq'::regclass)",
    true
  ],
  [
    "agent_level_task_record",
    "uid",
    "integer",
    "0",
    true
  ],
  [
    "agent_level_task_record",
    "level_id",
    "integer",
    "0",
    true
  ],
  [
    "agent_level_task_record",
    "task_id",
    "integer",
    "0",
    true
  ],
  [
    "agent_level_task_record",
    "status",
    "smallint",
    "0",
    true
  ],
  [
    "agent_level_task_record",
    "add_time",
    "integer",
    "10",
    true
  ]
] as const;
const indexes = [
  [
    "agent_level",
    "agent_level_pkey",
    "CREATE UNIQUE INDEX agent_level_pkey ON public.agent_level USING btree (id)"
  ],
  [
    "agent_level",
    "al_status_del",
    "CREATE INDEX al_status_del ON public.agent_level USING btree (status, is_del)"
  ],
  [
    "agent_level_task",
    "agent_level_task_pkey",
    "CREATE UNIQUE INDEX agent_level_task_pkey ON public.agent_level_task USING btree (id)"
  ],
  [
    "agent_level_task",
    "alt_level_active",
    "CREATE INDEX alt_level_active ON public.agent_level_task USING btree (level_id, is_del, status, sort, id)"
  ],
  [
    "agent_level_task",
    "alt_type_level",
    "CREATE INDEX alt_type_level ON public.agent_level_task USING btree (type, level_id, is_del)"
  ],
  [
    "agent_level_task_record",
    "agent_level_task_record_pkey",
    "CREATE UNIQUE INDEX agent_level_task_record_pkey ON public.agent_level_task_record USING btree (id)"
  ],
  [
    "agent_level_task_record",
    "altr_user_level_task",
    "CREATE INDEX altr_user_level_task ON public.agent_level_task_record USING btree (uid, level_id, task_id, id)"
  ],
  [
    "agent_level_task_record",
    "altr_task_user",
    "CREATE INDEX altr_task_user ON public.agent_level_task_record USING btree (task_id, uid)"
  ]
] as const;
export const AGENT_LEVEL_RUNTIME_CATALOG_SQL = `WITH expected_columns(table_name,column_name,type_name,default_expr,not_null) AS (VALUES
${columns.map(row => '(' + row.map(literal).join(',') + ')').join(',\n')}
), expected_indexes(table_name,name,definition) AS (VALUES
${indexes.map(row => '(' + row.map(literal).join(',') + ')').join(',\n')}
), targets AS (
  SELECT * FROM pg_catalog.pg_class WHERE relnamespace='public'::regnamespace
    AND relname IN ('agent_level','agent_level_task','agent_level_task_record')
), actual_columns AS (
  SELECT t.relname AS table_name,a.attname AS column_name,pg_catalog.format_type(a.atttypid,a.atttypmod) AS type_name,
    pg_catalog.pg_get_expr(d.adbin,d.adrelid) AS default_expr,a.attnotnull AS not_null,
    NOT a.attisdropped AND a.attidentity='' AND a.attgenerated='' AND a.attislocal AND a.attinhcount=0
      AND (a.attcollation=0 OR a.attcollation='pg_catalog."default"'::regcollation) AS safe
  FROM targets t JOIN pg_catalog.pg_attribute a ON a.attrelid=t.oid AND a.attnum>0
  LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
), actual_indexes AS (
  SELECT t.relname AS table_name,c.relname AS name,pg_catalog.pg_get_indexdef(i.indexrelid) AS definition,
    i.indisvalid AND i.indisready AND i.indislive AND NOT i.indisexclusion AS safe
  FROM targets t JOIN pg_catalog.pg_index i ON i.indrelid=t.oid JOIN pg_catalog.pg_class c ON c.oid=i.indexrelid
), actual_constraints AS (
  SELECT t.relname AS table_name,c.conname AS name,pg_catalog.pg_get_constraintdef(c.oid) AS definition,
    c.contype IN('p','c') AND (c.contype='p' OR NOT c.connoinherit) AND c.convalidated AND NOT c.condeferrable AND NOT c.condeferred AND c.conislocal AND c.coninhcount=0 AS safe
  FROM targets t JOIN pg_catalog.pg_constraint c ON c.conrelid=t.oid WHERE c.contype<>'n'
), expected_constraints(table_name,name,definition) AS (VALUES
  ('agent_level','agent_level_pkey','PRIMARY KEY (id)'),
  ('agent_level_task','agent_level_task_pkey','PRIMARY KEY (id)'),
  ('agent_level_task_record','agent_level_task_record_pkey','PRIMARY KEY (id)'),
  ('agent_level','al_brokerage_ck','CHECK ((((one_brokerage >= 0) AND (one_brokerage <= 1000)) AND ((two_brokerage >= 0) AND (two_brokerage <= 1000))))')
) SELECT (SELECT count(*)=3 AND bool_and(relkind='r' AND relpersistence='p' AND NOT relrowsecurity
    AND NOT relforcerowsecurity AND NOT relispartition) FROM targets)
  AND NOT EXISTS(SELECT 1 FROM targets t JOIN pg_catalog.pg_inherits i ON i.inhrelid=t.oid OR i.inhparent=t.oid)
  AND NOT EXISTS(SELECT 1 FROM targets t JOIN pg_catalog.pg_trigger g ON g.tgrelid=t.oid
    WHERE NOT g.tgisinternal AND g.tgname NOT IN ('cinashop_runtime_agent_level_catalog_fence_v1','cinashop_runtime_agent_level_row_guard_v1')
      AND NOT(t.relname='agent_level' AND g.tgname='cinashop_runtime_lock_only_v1'))
  AND NOT EXISTS(SELECT 1 FROM targets t JOIN pg_catalog.pg_rewrite r ON r.ev_class=t.oid)
  AND NOT EXISTS(SELECT 1 FROM expected_columns e FULL JOIN actual_columns a USING(table_name,column_name)
    WHERE e.table_name IS NULL OR a.table_name IS NULL OR NOT a.safe OR e.type_name IS DISTINCT FROM a.type_name
      OR e.default_expr IS DISTINCT FROM a.default_expr OR e.not_null IS DISTINCT FROM a.not_null)
  AND NOT EXISTS(SELECT 1 FROM expected_indexes e FULL JOIN actual_indexes a USING(table_name,name)
    WHERE e.table_name IS NULL OR a.table_name IS NULL OR NOT a.safe OR e.definition IS DISTINCT FROM a.definition)
  AND NOT EXISTS(SELECT 1 FROM expected_constraints e FULL JOIN actual_constraints a USING(table_name,name)
    WHERE e.table_name IS NULL OR a.table_name IS NULL OR NOT a.safe OR e.definition IS DISTINCT FROM a.definition) AS ready,
  NOT EXISTS(SELECT 1 FROM expected_columns e FULL JOIN actual_columns a USING(table_name,column_name)
    WHERE e.table_name IS NULL OR a.table_name IS NULL OR NOT a.safe OR e.type_name IS DISTINCT FROM a.type_name
      OR e.default_expr IS DISTINCT FROM a.default_expr OR e.not_null IS DISTINCT FROM a.not_null) AS columns_ready,
  NOT EXISTS(SELECT 1 FROM expected_indexes e FULL JOIN actual_indexes a USING(table_name,name)
    WHERE e.table_name IS NULL OR a.table_name IS NULL OR NOT a.safe OR e.definition IS DISTINCT FROM a.definition) AS indexes_ready,
  NOT EXISTS(SELECT 1 FROM expected_constraints e FULL JOIN actual_constraints a USING(table_name,name)
    WHERE e.table_name IS NULL OR a.table_name IS NULL OR NOT a.safe OR e.definition IS DISTINCT FROM a.definition) AS constraints_ready`;

/** Fixed owned-by serial identities and maintenance owner are prerequisites to
 * both the narrow forward and fresh commissioning. No last_value resets. */
export async function inspectAgentLevelRuntimeCatalog(tx: Pick<DbClient, 'execute'>, maintenance: string, names: AgentLevelRuntimeNames) {
  if(names.maintenance!==maintenance)throw Error('Distributor catalog owner identity requires review');
  const [catalog] = await tx.execute(sql.raw(AGENT_LEVEL_RUNTIME_CATALOG_SQL));
  const [owner] = await tx.execute(sql`SELECT count(*)=6 AND bool_and(c.relowner=r.oid) AS ready
    FROM pg_catalog.pg_class c CROSS JOIN pg_catalog.pg_roles r WHERE c.relnamespace='public'::regnamespace
      AND r.rolname=${maintenance} AND c.relname IN
      ('agent_level','agent_level_task','agent_level_task_record','agent_level_id_seq','agent_level_task_id_seq','agent_level_task_record_id_seq')`);
  const [sequences] = await tx.execute(sql`WITH expected(table_name,sequence_name) AS (VALUES
    ('agent_level','agent_level_id_seq'),('agent_level_task','agent_level_task_id_seq'),('agent_level_task_record','agent_level_task_record_id_seq'))
    SELECT count(*)=3 AND bool_and(s.relkind='S' AND s.relpersistence='p'
      AND q.seqtypid='integer'::regtype AND q.seqstart=1 AND q.seqincrement=1 AND q.seqmin=1
      AND q.seqmax=2147483647 AND q.seqcache=1 AND NOT q.seqcycle
      AND (SELECT count(*)=1 AND bool_and(d.refobjid=to_regclass('public.'||e.table_name)
        AND d.refobjsubid=(SELECT attnum FROM pg_catalog.pg_attribute
          WHERE attrelid=d.refobjid AND attname='id' AND attnum>0 AND NOT attisdropped))
        FROM pg_catalog.pg_depend d WHERE d.classid='pg_catalog.pg_class'::regclass AND d.objid=s.oid
          AND d.refclassid=d.classid AND d.deptype IN('a','i'))
      AND CASE WHEN EXISTS(SELECT 1 FROM pg_catalog.pg_attribute WHERE attrelid=to_regclass('public.'||e.table_name)
        AND attname='id' AND attnum>0 AND NOT attisdropped)
        THEN pg_catalog.pg_get_serial_sequence('public.'||e.table_name,'id') END='public.'||e.sequence_name) AS ready
    FROM expected e JOIN pg_catalog.pg_class s ON s.relnamespace='public'::regnamespace AND s.relname=e.sequence_name
      JOIN pg_catalog.pg_sequence q ON q.seqrelid=s.oid`);
  const guard=await inspectRuntimeAgentLevelCatalogBoundary(tx,names);
  return { ready: catalog?.ready === true && owner?.ready === true && sequences?.ready === true
      && guard.tablesSafe && (guard.absent || guard.ready),
    catalogReady: catalog?.ready === true, ownerReady: owner?.ready === true, sequenceReady: sequences?.ready === true,
    columnsReady:catalog?.columns_ready===true,indexesReady:catalog?.indexes_ready===true,constraintsReady:catalog?.constraints_ready===true };
}
