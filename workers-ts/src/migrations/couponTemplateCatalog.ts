import { sql } from 'drizzle-orm';
import type { DbClient } from '../lib/di';

/** Fixed independent Admin template catalog. Never grants roles or creates data. */
export const COUPON_TEMPLATE_TABLES = ['store_coupon_template', 'store_coupon_template_issue'] as const;

export const COUPON_TEMPLATE_DDL = `
CREATE TABLE public.store_coupon_template (
  id serial PRIMARY KEY NOT NULL,
  title varchar(64) NOT NULL,
  scope_type smallint NOT NULL,
  category_id integer DEFAULT 0 NOT NULL,
  product_ids varchar(500) DEFAULT '' NOT NULL,
  coupon_price numeric(12,2) NOT NULL,
  use_min_price numeric(12,2) DEFAULT '0.00' NOT NULL,
  valid_days integer NOT NULL,
  sort integer DEFAULT 0 NOT NULL,
  status smallint DEFAULT 1 NOT NULL,
  is_del smallint DEFAULT 0 NOT NULL,
  add_time integer NOT NULL,
  CONSTRAINT sct_title_ck CHECK (length(btrim(title)) > 0),
  CONSTRAINT sct_scope_ck CHECK ((scope_type=0 AND category_id=0 AND product_ids='') OR (scope_type=1 AND category_id>0 AND product_ids='') OR (scope_type=2 AND category_id=0 AND CASE WHEN product_ids ~ '^[1-9][0-9]*(,[1-9][0-9]*)*$' THEN cardinality(string_to_array(product_ids, ',')::integer[]) <= 100 ELSE false END)),
  CONSTRAINT sct_money_ck CHECK (coupon_price>0 AND coupon_price<'Infinity'::numeric AND use_min_price>=0 AND use_min_price<'Infinity'::numeric),
  CONSTRAINT sct_days_ck CHECK (valid_days BETWEEN 1 AND 3650),
  CONSTRAINT sct_state_ck CHECK (sort>=0 AND status IN (0,1) AND is_del IN (0,1) AND add_time>=0)
);
CREATE TABLE public.store_coupon_template_issue (
  issue_id integer PRIMARY KEY NOT NULL,
  template_id integer NOT NULL,
  issued_at integer NOT NULL,
  source_revision varchar(64) NOT NULL,
  CONSTRAINT scti_issued_at_ck CHECK (issued_at>=0),
  CONSTRAINT scti_revision_ck CHECK (source_revision ~ '^[a-f0-9]{64}$'),
  CONSTRAINT scti_issue_fk FOREIGN KEY (issue_id) REFERENCES public.store_coupon_issue(id) ON DELETE NO ACTION ON UPDATE NO ACTION,
  CONSTRAINT scti_template_fk FOREIGN KEY (template_id) REFERENCES public.store_coupon_template(id) ON DELETE NO ACTION ON UPDATE NO ACTION
);
CREATE INDEX sct_catalog_idx ON public.store_coupon_template USING btree(is_del,status,sort,id);
CREATE INDEX scti_template_idx ON public.store_coupon_template_issue USING btree(template_id,issue_id);
`;

const literal = (value: string | null) => value === null ? 'NULL' : `'${value.replaceAll("'", "''")}'`;
const columnSpec = [
  ['store_coupon_template', 'id', 'integer', "nextval('store_coupon_template_id_seq'::regclass)"],
  ['store_coupon_template', 'title', 'character varying(64)', null],
  ['store_coupon_template', 'scope_type', 'smallint', null],
  ['store_coupon_template', 'category_id', 'integer', '0'],
  ['store_coupon_template', 'product_ids', 'character varying(500)', "''::character varying"],
  ['store_coupon_template', 'coupon_price', 'numeric(12,2)', null],
  ['store_coupon_template', 'use_min_price', 'numeric(12,2)', '0.00'],
  ['store_coupon_template', 'valid_days', 'integer', null],
  ['store_coupon_template', 'sort', 'integer', '0'],
  ['store_coupon_template', 'status', 'smallint', '1'],
  ['store_coupon_template', 'is_del', 'smallint', '0'],
  ['store_coupon_template', 'add_time', 'integer', null],
  ['store_coupon_template_issue', 'issue_id', 'integer', null],
  ['store_coupon_template_issue', 'template_id', 'integer', null],
  ['store_coupon_template_issue', 'issued_at', 'integer', null],
  ['store_coupon_template_issue', 'source_revision', 'character varying(64)', null],
] as const;
const constraintSpec = [
  ['store_coupon_template', 'store_coupon_template_pkey', 'PRIMARY KEY (id)'],
  ['store_coupon_template', 'sct_title_ck', 'CHECK ((length(btrim((title)::text)) > 0))'],
  ['store_coupon_template', 'sct_days_ck', 'CHECK (((valid_days >= 1) AND (valid_days <= 3650)))'],
  ['store_coupon_template', 'sct_money_ck', "CHECK (((coupon_price > (0)::numeric) AND (coupon_price < 'Infinity'::numeric) AND (use_min_price >= (0)::numeric) AND (use_min_price < 'Infinity'::numeric)))"],
  ['store_coupon_template', 'sct_state_ck', 'CHECK (((sort >= 0) AND (status = ANY (ARRAY[0, 1])) AND (is_del = ANY (ARRAY[0, 1])) AND (add_time >= 0)))'],
  ['store_coupon_template', 'sct_scope_ck', "CHECK ((((scope_type = 0) AND (category_id = 0) AND ((product_ids)::text = ''::text)) OR ((scope_type = 1) AND (category_id > 0) AND ((product_ids)::text = ''::text)) OR ((scope_type = 2) AND (category_id = 0) AND\nCASE\n    WHEN ((product_ids)::text ~ '^[1-9][0-9]*(,[1-9][0-9]*)*$'::text) THEN (cardinality((string_to_array((product_ids)::text, ','::text))::integer[]) <= 100)\n    ELSE false\nEND)))"],
  ['store_coupon_template_issue', 'store_coupon_template_issue_pkey', 'PRIMARY KEY (issue_id)'],
  ['store_coupon_template_issue', 'scti_issued_at_ck', 'CHECK ((issued_at >= 0))'],
  ['store_coupon_template_issue', 'scti_revision_ck', "CHECK (((source_revision)::text ~ '^[a-f0-9]{64}$'::text))"],
  ['store_coupon_template_issue', 'scti_issue_fk', 'FOREIGN KEY (issue_id) REFERENCES store_coupon_issue(id)'],
  ['store_coupon_template_issue', 'scti_template_fk', 'FOREIGN KEY (template_id) REFERENCES store_coupon_template(id)'],
] as const;
const indexSpec = [
  ['store_coupon_template', 'store_coupon_template_pkey', 'CREATE UNIQUE INDEX store_coupon_template_pkey ON public.store_coupon_template USING btree (id)'],
  ['store_coupon_template', 'sct_catalog_idx', 'CREATE INDEX sct_catalog_idx ON public.store_coupon_template USING btree (is_del, status, sort, id)'],
  ['store_coupon_template_issue', 'store_coupon_template_issue_pkey', 'CREATE UNIQUE INDEX store_coupon_template_issue_pkey ON public.store_coupon_template_issue USING btree (issue_id)'],
  ['store_coupon_template_issue', 'scti_template_idx', 'CREATE INDEX scti_template_idx ON public.store_coupon_template_issue USING btree (template_id, issue_id)'],
] as const;

/** Public-schema exact structural comparison; no role-specific grants or rows. */
export const COUPON_TEMPLATE_CATALOG_INSPECTION_SQL = `WITH expected_columns(table_name,column_name,type_name,default_expr) AS (VALUES
${columnSpec.map(row => '(' + row.map(literal).join(',') + ')').join(',\n')}
), expected_constraints(table_name,name,definition) AS (VALUES
${constraintSpec.map(row => '(' + row.map(literal).join(',') + ')').join(',\n')}
), expected_indexes(table_name,name,definition) AS (VALUES
${indexSpec.map(row => '(' + row.map(literal).join(',') + ')').join(',\n')}
), target_tables AS (
  SELECT c.* FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND c.relname IN ('store_coupon_template','store_coupon_template_issue')
), actual_columns AS (
  SELECT c.relname AS table_name,a.attname AS column_name,pg_catalog.format_type(a.atttypid,a.atttypmod) AS type_name,
    pg_catalog.pg_get_expr(d.adbin,d.adrelid) AS default_expr,
    a.attnotnull AND NOT a.attisdropped AND a.attidentity='' AND a.attgenerated='' AND a.attislocal AND a.attinhcount=0
      AND (a.attcollation=0 OR a.attcollation='pg_catalog."default"'::regcollation) AS safe
  FROM target_tables c JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid AND a.attnum>0
  LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
), actual_constraints AS (
  SELECT t.relname AS table_name,c.conname AS name,pg_catalog.pg_get_constraintdef(c.oid) AS definition,
    c.convalidated AND NOT c.condeferrable AND NOT c.condeferred AND (c.contype<>'c' OR NOT c.connoinherit) AND c.conislocal AND c.coninhcount=0 AS safe
  FROM target_tables t JOIN pg_catalog.pg_constraint c ON c.conrelid=t.oid WHERE c.contype<>'n'
), actual_indexes AS (
  SELECT t.relname AS table_name,c.relname AS name,pg_catalog.pg_get_indexdef(i.indexrelid) AS definition,
    i.indisvalid AND i.indisready AND i.indislive AND NOT i.indisexclusion AS safe
  FROM target_tables t JOIN pg_catalog.pg_index i ON i.indrelid=t.oid JOIN pg_catalog.pg_class c ON c.oid=i.indexrelid
)
SELECT (SELECT count(*)=2 AND bool_and(relkind='r' AND relpersistence='p' AND NOT relrowsecurity AND NOT relforcerowsecurity AND NOT relispartition) FROM target_tables)
  AND NOT EXISTS(SELECT 1 FROM target_tables t JOIN pg_catalog.pg_inherits i ON i.inhrelid=t.oid OR i.inhparent=t.oid)
  AND NOT EXISTS(SELECT 1 FROM target_tables t JOIN pg_catalog.pg_trigger g ON g.tgrelid=t.oid WHERE NOT g.tgisinternal)
  AND NOT EXISTS(SELECT 1 FROM target_tables t JOIN pg_catalog.pg_rewrite r ON r.ev_class=t.oid)
  AND NOT EXISTS(SELECT 1 FROM expected_columns e FULL JOIN actual_columns a USING(table_name,column_name)
    WHERE e.table_name IS NULL OR a.table_name IS NULL OR NOT a.safe OR e.type_name IS DISTINCT FROM a.type_name OR e.default_expr IS DISTINCT FROM a.default_expr)
  AND NOT EXISTS(SELECT 1 FROM expected_constraints e FULL JOIN actual_constraints a USING(table_name,name)
    WHERE e.table_name IS NULL OR a.table_name IS NULL OR NOT a.safe OR e.definition IS DISTINCT FROM a.definition)
  AND NOT EXISTS(SELECT 1 FROM expected_indexes e FULL JOIN actual_indexes a USING(table_name,name)
    WHERE e.table_name IS NULL OR a.table_name IS NULL OR NOT a.safe OR e.definition IS DISTINCT FROM a.definition) AS catalog_ready,
  EXISTS(SELECT 1 FROM pg_catalog.pg_class s JOIN pg_catalog.pg_namespace n ON n.oid=s.relnamespace
    JOIN pg_catalog.pg_sequence q ON q.seqrelid=s.oid
    JOIN pg_catalog.pg_depend d ON d.classid='pg_catalog.pg_class'::regclass AND d.objid=s.oid AND d.deptype='a'
    JOIN pg_catalog.pg_attribute a ON a.attrelid=d.refobjid AND a.attnum=d.refobjsubid
    WHERE n.nspname='public' AND s.relname='store_coupon_template_id_seq' AND s.relkind='S' AND s.relpersistence='p'
      AND d.refclassid='pg_catalog.pg_class'::regclass AND d.refobjid=to_regclass('public.store_coupon_template') AND a.attname='id'
      AND q.seqtypid='integer'::regtype AND q.seqstart=1 AND q.seqincrement=1 AND q.seqmin=1 AND q.seqmax=2147483647
      AND q.seqcache=1 AND NOT q.seqcycle
      AND CASE WHEN to_regclass('public.store_coupon_template') IS NOT NULL THEN pg_catalog.pg_get_serial_sequence('public.store_coupon_template','id') END='public.store_coupon_template_id_seq') AS sequence_ready`;

export async function inspectCouponTemplateCatalog(tx: Pick<DbClient, 'execute'>, maintenance?: string) {
  const [row] = await tx.execute(sql.raw(COUPON_TEMPLATE_CATALOG_INSPECTION_SQL));
  const [owner] = maintenance === undefined ? [{ ready: true }] : await tx.execute(sql`SELECT count(*)=3 AND bool_and(c.relowner=r.oid) AS ready
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    CROSS JOIN pg_catalog.pg_roles r WHERE n.nspname='public' AND r.rolname=${maintenance}
      AND c.relname IN ('store_coupon_template','store_coupon_template_issue','store_coupon_template_id_seq')`);
  return { ready: row?.catalog_ready === true && row?.sequence_ready === true && owner?.ready === true,
    catalogReady: row?.catalog_ready === true, sequenceReady: row?.sequence_ready === true };
}

export const COUPON_TEMPLATE_CATALOG_SQL = `-- Explicit root maintenance transaction only. No seed rows, grants or automatic repair.
DO $coupon_template_preflight$
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' OR current_setting('transaction_read_only') <> 'off' THEN
    RAISE EXCEPTION 'Coupon template catalog requires a READ COMMITTED write transaction';
  END IF;
  PERFORM set_config('statement_timeout',LEAST(COALESCE(NULLIF((SELECT setting::int FROM pg_settings WHERE name='statement_timeout'),0),5000),5000)::text,true);
  PERFORM set_config('lock_timeout',LEAST(COALESCE(NULLIF((SELECT setting::int FROM pg_settings WHERE name='lock_timeout'),0),1000),1000)::text,true);
  PERFORM set_config('idle_in_transaction_session_timeout',LEAST(COALESCE(NULLIF((SELECT setting::int FROM pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000),5000)::text,true);
  PERFORM set_config('search_path','public,pg_temp',true);
  IF NOT pg_try_advisory_xact_lock(731626,5) THEN RAISE EXCEPTION 'Coupon template catalog maintenance is busy'; END IF;
  IF EXISTS(SELECT 1 FROM pg_event_trigger WHERE evtenabled<>'D') THEN RAISE EXCEPTION 'Coupon template catalog event-trigger review required'; END IF;
  IF (to_regclass('public.store_coupon_template') IS NULL) <> (to_regclass('public.store_coupon_template_issue') IS NULL) THEN
    RAISE EXCEPTION 'Partial coupon template catalog; no automatic repair';
  END IF;
END
$coupon_template_preflight$;
LOCK TABLE ONLY public.store_coupon_issue IN SHARE ROW EXCLUSIVE MODE;
DO $coupon_template_create$
BEGIN
  IF to_regclass('public.store_coupon_template') IS NULL THEN
    ${COUPON_TEMPLATE_DDL}
  END IF;
END
$coupon_template_create$;
LOCK TABLE ONLY public.store_coupon_template, ONLY public.store_coupon_template_issue IN SHARE ROW EXCLUSIVE MODE;
DO $coupon_template_validate$
DECLARE checked record;
BEGIN
  ${COUPON_TEMPLATE_CATALOG_INSPECTION_SQL} INTO checked;
  IF checked.catalog_ready IS DISTINCT FROM true OR checked.sequence_ready IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Coupon template catalog drift; no automatic repair';
  END IF;
END
$coupon_template_validate$;
`;
