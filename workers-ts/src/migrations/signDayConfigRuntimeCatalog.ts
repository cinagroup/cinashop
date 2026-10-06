import { sql } from 'drizzle-orm';
import type { DbClient } from '../lib/di';
import { inspectRuntimeSignDayGroupLockBoundary, type SignDayGroupRuntimeNames } from './runtimeSignDayGroupLockBoundary';

/** Existing 0054 tables only. This inspector never creates or repairs objects. */
export const SIGN_DAY_CONFIG_RUNTIME_TABLES = ['system_group', 'system_group_data'] as const;
const literal = (value: string | boolean | null) => value === null ? 'NULL'
  : typeof value === 'boolean' ? String(value) : "'" + value.replaceAll("'", "''") + "'";
const columns = [
  ['system_group', 'id', 'integer', "nextval('system_group_id_seq'::regclass)", true],
  ['system_group', 'cate_id', 'integer', '0', true],
  ['system_group', 'name', 'character varying(50)', "''::character varying", true],
  ['system_group', 'info', 'character varying(256)', "''::character varying", true],
  ['system_group', 'config_name', 'character varying(50)', "''::character varying", true],
  ['system_group', 'fields', 'text', null, false],
  ['system_group_data', 'id', 'integer', "nextval('system_group_data_id_seq'::regclass)", true],
  ['system_group_data', 'gid', 'integer', '0', true],
  ['system_group_data', 'value', 'text', null, false],
  ['system_group_data', 'add_time', 'integer', '0', true],
  ['system_group_data', 'sort', 'integer', '0', true],
  ['system_group_data', 'status', 'smallint', '1', true],
] as const;
const indexes = [
  ['system_group', 'system_group_pkey', 'CREATE UNIQUE INDEX system_group_pkey ON public.system_group USING btree (id)'],
  ['system_group', 'system_group_config_name_uq', 'CREATE UNIQUE INDEX system_group_config_name_uq ON public.system_group USING btree (config_name)'],
  ['system_group', 'system_group_cate', 'CREATE INDEX system_group_cate ON public.system_group USING btree (cate_id)'],
  ['system_group_data', 'system_group_data_pkey', 'CREATE UNIQUE INDEX system_group_data_pkey ON public.system_group_data USING btree (id)'],
  ['system_group_data', 'system_group_data_gid', 'CREATE INDEX system_group_data_gid ON public.system_group_data USING btree (gid, status, sort, id)'],
] as const;
export const SIGN_DAY_CONFIG_RUNTIME_CATALOG_SQL = `WITH expected_columns(table_name,column_name,type_name,default_expr,not_null) AS (VALUES
${columns.map(row => '(' + row.map(literal).join(',') + ')').join(',\n')}
), expected_indexes(table_name,name,definition) AS (VALUES
${indexes.map(row => '(' + row.map(literal).join(',') + ')').join(',\n')}
), targets AS (
  SELECT * FROM pg_catalog.pg_class WHERE relnamespace='public'::regnamespace
    AND relname IN ('system_group','system_group_data')
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
    c.contype='p' AND c.convalidated AND NOT c.condeferrable AND NOT c.condeferred AND c.conislocal AND c.coninhcount=0 AS safe
  FROM targets t JOIN pg_catalog.pg_constraint c ON c.conrelid=t.oid WHERE c.contype<>'n'
), expected_constraints(table_name,name,definition) AS (VALUES
  ('system_group','system_group_pkey','PRIMARY KEY (id)'),('system_group_data','system_group_data_pkey','PRIMARY KEY (id)')
) SELECT (SELECT count(*)=2 AND bool_and(relkind='r' AND relpersistence='p' AND NOT relrowsecurity
    AND NOT relforcerowsecurity AND NOT relispartition) FROM targets)
  AND NOT EXISTS(SELECT 1 FROM targets t JOIN pg_catalog.pg_inherits i ON i.inhrelid=t.oid OR i.inhparent=t.oid)
  AND NOT EXISTS(SELECT 1 FROM targets t JOIN pg_catalog.pg_trigger g ON g.tgrelid=t.oid
    WHERE NOT g.tgisinternal AND (t.relname<>'system_group' OR g.tgname<>'cinashop_runtime_sign_day_group_lock_only_v1'))
  AND NOT EXISTS(SELECT 1 FROM targets t JOIN pg_catalog.pg_rewrite r ON r.ev_class=t.oid)
  AND NOT EXISTS(SELECT 1 FROM expected_columns e FULL JOIN actual_columns a USING(table_name,column_name)
    WHERE e.table_name IS NULL OR a.table_name IS NULL OR NOT a.safe OR e.type_name IS DISTINCT FROM a.type_name
      OR e.default_expr IS DISTINCT FROM a.default_expr OR e.not_null IS DISTINCT FROM a.not_null)
  AND NOT EXISTS(SELECT 1 FROM expected_indexes e FULL JOIN actual_indexes a USING(table_name,name)
    WHERE e.table_name IS NULL OR a.table_name IS NULL OR NOT a.safe OR e.definition IS DISTINCT FROM a.definition)
  AND NOT EXISTS(SELECT 1 FROM expected_constraints e FULL JOIN actual_constraints a USING(table_name,name)
    WHERE e.table_name IS NULL OR a.table_name IS NULL OR NOT a.safe OR e.definition IS DISTINCT FROM a.definition) AS ready`;

/** Fixed owned-by serial identities and maintenance owner are prerequisites to
 * both the narrow forward and fresh commissioning. No last_value resets. */
export async function inspectSignDayConfigRuntimeCatalog(tx: Pick<DbClient, 'execute'>, maintenance: string, names: SignDayGroupRuntimeNames) {
  if(names.maintenance!==maintenance)throw Error('Sign-day catalog owner identity requires review');
  const [catalog] = await tx.execute(sql.raw(SIGN_DAY_CONFIG_RUNTIME_CATALOG_SQL));
  const [owner] = await tx.execute(sql`SELECT count(*)=4 AND bool_and(c.relowner=r.oid) AS ready
    FROM pg_catalog.pg_class c CROSS JOIN pg_catalog.pg_roles r WHERE c.relnamespace='public'::regnamespace
      AND r.rolname=${maintenance} AND c.relname IN
      ('system_group','system_group_data','system_group_id_seq','system_group_data_id_seq')`);
  const [sequences] = await tx.execute(sql`WITH expected(table_name,sequence_name) AS (VALUES
    ('system_group','system_group_id_seq'),('system_group_data','system_group_data_id_seq'))
    SELECT count(*)=2 AND bool_and(s.relkind='S' AND s.relpersistence='p'
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
  const guard=await inspectRuntimeSignDayGroupLockBoundary(tx,names);
  return { ready: catalog?.ready === true && owner?.ready === true && sequences?.ready === true
      && guard.tablesSafe && (guard.absent || guard.ready),
    catalogReady: catalog?.ready === true, ownerReady: owner?.ready === true, sequenceReady: sequences?.ready === true };
}
