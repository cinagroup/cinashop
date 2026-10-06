import { sql, type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { DbClient } from '@/lib/di';
import { pricingIdentifier } from './checkoutPricingLockCatalog';

export const CASHIER_SECOND_CARD_PROMOTION_LOCK_KEY = 731695;
export const CASHIER_SECOND_CARD_PROMOTION_LOCK_FUNCTION = 'cashier_second_card_promotion_lock_v1';
export const CASHIER_SECOND_CARD_PROMOTION_LOCK_TRIGGER = CASHIER_SECOND_CARD_PROMOTION_LOCK_FUNCTION;
export const CASHIER_SECOND_CARD_PROMOTION_LOCK_COLUMNS = ['id'] as const;
type Query = Pick<DbClient, 'execute'>;
type Root = Pick<DbClient, 'transaction'> & Partial<Pick<DbClient, '$client'>>;
const inline = (query: SQL) => {
  const value = new PgDialect().sqlToQuery(query.inlineParams());
  if (value.params.length) throw Error('Cashier promotion lock SQL has unresolved parameters');
  return value.sql;
};
const literal = (value: string) => inline(sql`${value}`);

/** The invoker never gains a privilege. Every UPDATE, including id=id, from
 * a non-owner backend is rejected even after inheritance or SET ROLE. Only an
 * actual table-owner connection may maintain rows, never an assumed identity. */
export function cashierSecondCardPromotionLockBody(runtimeRole: string, schema = 'public') {
  pricingIdentifier(runtimeRole); pricingIdentifier(schema);
  return `BEGIN
  IF TG_OP <> 'UPDATE' OR TG_WHEN <> 'BEFORE' OR TG_LEVEL <> 'ROW'
    OR TG_TABLE_SCHEMA <> ${literal(schema)} OR TG_TABLE_NAME <> 'store_order_promotions' THEN
    RAISE EXCEPTION 'Cashier promotion lock trigger context changed' USING ERRCODE='42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_roles r ON r.oid=c.relowner
    JOIN pg_catalog.pg_stat_activity a ON a.pid=pg_catalog.pg_backend_pid()
    WHERE c.oid=TG_RELID AND r.rolname=current_user AND r.rolname=session_user AND a.usesysid=c.relowner) THEN
    RAISE EXCEPTION 'Cashier promotion row-lock privilege cannot update ledger rows' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END`;
}

/** Exact structural catalog, not a name-only trigger or an allowed UPDATE.
 * No server-produced fingerprint is guessed: all columns, indices, function,
 * trigger, owner, identity and ACL fields are inspected independently. */
export function cashierSecondCardPromotionLockCatalogQuery(runtimeRole: string, schema = 'public') {
  pricingIdentifier(runtimeRole); pricingIdentifier(schema);
  const body = cashierSecondCardPromotionLockBody(runtimeRole, schema);
  return sql`WITH RECURSIVE ns AS (SELECT * FROM pg_catalog.pg_namespace WHERE nspname=${schema}),
  target AS (SELECT c.* FROM pg_catalog.pg_class c JOIN ns ON ns.oid=c.relnamespace WHERE c.relname='store_order_promotions'),
  runtime AS (SELECT * FROM pg_catalog.pg_roles WHERE rolname=${runtimeRole}),
  authority(oid) AS (SELECT oid FROM runtime UNION SELECT m.roleid FROM pg_catalog.pg_auth_members m JOIN authority a ON a.oid=m.member),
  expected_columns(name,kind,default_value) AS (VALUES ('id','integer',NULL),('oid','integer','0'),('uid','integer','0'),
    ('promotions_id','integer','0'),('product_id','integer','0'),('promotions_price','numeric(12,2)','0.00'),('add_time','integer','0')),
  actual_columns AS (SELECT a.*,pg_catalog.format_type(a.atttypid,a.atttypmod) AS kind,pg_catalog.pg_get_expr(d.adbin,d.adrelid) AS default_value
    FROM target c JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
    LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum),
  sequences AS (SELECT s.*,n.nspname AS schema_name,q.seqtypid,q.seqstart,q.seqincrement,q.seqmax,q.seqmin,q.seqcache,q.seqcycle FROM target c JOIN actual_columns a ON a.attname='id'
    JOIN pg_catalog.pg_depend d ON d.refclassid='pg_catalog.pg_class'::regclass AND d.refobjid=c.oid AND d.refobjsubid=a.attnum
      AND d.classid='pg_catalog.pg_class'::regclass AND d.deptype IN('a','i')
    JOIN pg_catalog.pg_class s ON s.oid=d.objid AND s.relkind='S' JOIN pg_catalog.pg_namespace n ON n.oid=s.relnamespace
    JOIN pg_catalog.pg_sequence q ON q.seqrelid=s.oid),
  column_authority(grantee,oid) AS (SELECT a.grantee,a.grantee FROM actual_columns c CROSS JOIN LATERAL pg_catalog.aclexplode(c.attacl) a
    UNION SELECT a.grantee,m.roleid FROM column_authority a JOIN pg_catalog.pg_auth_members m ON m.member=a.oid),
  routines AS (SELECT p.* FROM pg_catalog.pg_proc p JOIN ns ON ns.oid=p.pronamespace WHERE p.proname=${CASHIER_SECOND_CARD_PROMOTION_LOCK_FUNCTION}),
  triggers AS (SELECT t.* FROM pg_catalog.pg_trigger t JOIN target c ON c.oid=t.tgrelid WHERE NOT t.tgisinternal),
  expected_indexes(name,keys,is_primary,is_unique) AS (VALUES
    ('store_order_promotions_pkey',ARRAY['id']::text[],true,true),
    ('sop_order_promotion',ARRAY['oid','promotions_id']::text[],false,false),
    ('sop_order_product',ARRAY['oid','product_id']::text[],false,false),
    ('sop_uid_time',ARRAY['uid','add_time']::text[],false,false)),
  actual_indexes AS (SELECT i.*,ic.relname AS name,ic.reloptions,ic.relowner AS index_owner,ic.relnamespace AS index_namespace,am.amname,
    ARRAY(SELECT a.attname::text FROM pg_catalog.unnest(i.indkey::smallint[]) WITH ORDINALITY k(num,position)
      JOIN pg_catalog.pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.num ORDER BY k.position) AS keys
    FROM target c JOIN pg_catalog.pg_index i ON i.indrelid=c.oid JOIN pg_catalog.pg_class ic ON ic.oid=i.indexrelid
    JOIN pg_catalog.pg_am am ON am.oid=ic.relam),
  table_state AS (SELECT pg_catalog.current_setting('server_version_num')::integer/10000=16
    AND (SELECT count(*)=1 AND bool_and(relkind='r' AND relpersistence='p' AND NOT relispartition
      AND NOT relrowsecurity AND NOT relforcerowsecurity AND reloptions IS NULL) FROM target)
    AND (SELECT count(*)=7 FROM actual_columns)
    AND NOT EXISTS(SELECT 1 FROM target c JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid WHERE a.attnum>0 AND a.attisdropped)
    AND NOT EXISTS(SELECT 1 FROM expected_columns e LEFT JOIN actual_columns a ON a.attname=e.name
      WHERE a.attname IS NULL OR a.kind<>e.kind OR NOT a.attnotnull OR a.attidentity<>'' OR a.attgenerated<>'' OR a.attcollation<>0
      OR a.attnum<>CASE e.name WHEN 'id' THEN 1 WHEN 'oid' THEN 2 WHEN 'uid' THEN 3 WHEN 'promotions_id' THEN 4
        WHEN 'product_id' THEN 5 WHEN 'promotions_price' THEN 6 WHEN 'add_time' THEN 7 END
      OR (e.name<>'id' AND (a.default_value IS NULL OR (a.default_value<>e.default_value
        AND NOT(e.name='promotions_price' AND a.default_value='0')))))
    AND (SELECT count(*)=1 AND bool_and(schema_name=${schema} AND relname='store_order_promotions_id_seq'
      AND relowner=(SELECT relowner FROM target) AND relpersistence='p' AND reloptions IS NULL
      AND seqtypid='integer'::regtype AND seqstart=1 AND seqincrement=1 AND seqmax=2147483647 AND seqmin=1 AND seqcache=1 AND NOT seqcycle) FROM sequences)
    AND EXISTS(SELECT 1 FROM actual_columns a JOIN sequences s ON a.attname='id'
      WHERE a.default_value=pg_catalog.format('nextval(%L::regclass)',s.oid::regclass::text))
    AND (SELECT count(*)=4 FROM actual_indexes)
    AND NOT EXISTS(SELECT 1 FROM expected_indexes e LEFT JOIN actual_indexes a ON a.name=e.name
      WHERE a.name IS NULL OR a.keys<>e.keys OR a.indisprimary<>e.is_primary OR a.indisunique<>e.is_unique
        OR a.amname<>'btree' OR NOT a.indisvalid OR NOT a.indisready OR NOT a.indislive OR a.indisexclusion
        OR a.indnkeyatts<>pg_catalog.cardinality(e.keys) OR a.indnatts<>a.indnkeyatts
        OR a.indexprs IS NOT NULL OR a.indpred IS NOT NULL OR a.reloptions IS NOT NULL
        OR a.index_owner<>(SELECT relowner FROM target) OR a.index_namespace<>(SELECT oid FROM ns)
        OR EXISTS(SELECT 1 FROM pg_catalog.unnest(a.indoption::smallint[]) o(value) WHERE value<>0)
        OR EXISTS(SELECT 1 FROM pg_catalog.unnest(a.indcollation::oid[]) o(value) WHERE value<>0)
        OR EXISTS(SELECT 1 FROM pg_catalog.unnest(a.indclass::oid[]) o(value) WHERE value<>(SELECT oc.oid FROM pg_catalog.pg_opclass oc
          JOIN pg_catalog.pg_namespace n ON n.oid=oc.opcnamespace WHERE n.nspname='pg_catalog' AND oc.opcname='int4_ops'
          AND oc.opcmethod=(SELECT oid FROM pg_catalog.pg_am WHERE amname='btree') AND oc.opcdefault)))
    AND (SELECT count(*)=1 AND bool_and(contype='p' AND NOT condeferrable AND NOT condeferred AND convalidated
      AND conkey=ARRAY[(SELECT attnum FROM actual_columns WHERE attname='id')]::smallint[]) FROM pg_catalog.pg_constraint
      WHERE conrelid IN(SELECT oid FROM target))
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_constraint WHERE confrelid IN(SELECT oid FROM target))
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_policy WHERE polrelid IN(SELECT oid FROM target))
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_rewrite WHERE ev_class IN(SELECT oid FROM target))
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_inherits WHERE inhrelid IN(SELECT oid FROM target) OR inhparent IN(SELECT oid FROM target)) AS safe)
  SELECT (SELECT count(*)=0 FROM routines) AND (SELECT count(*)=0 FROM triggers) AS absent,
    (SELECT safe FROM table_state) AS "tablesSafe",
    (SELECT count(*)=1 AND bool_and(p.pronargs=0 AND p.proargtypes=''::oidvector AND p.prokind='f'
      AND p.prorettype='pg_catalog.trigger'::regtype AND NOT p.prosecdef AND NOT p.proleakproof AND NOT p.proisstrict
      AND NOT p.proretset AND p.provolatile='v' AND p.proparallel='u' AND p.prosrc=${body}
      AND p.proconfig=ARRAY['search_path=pg_catalog, pg_temp']::text[] AND p.prosupport=0 AND p.probin IS NULL
      AND p.prosqlbody IS NULL AND p.procost=100 AND p.prorows=0 AND p.provariadic=0 AND p.pronargdefaults=0
      AND p.proallargtypes IS NULL AND p.proargmodes IS NULL AND p.proargnames IS NULL AND p.proargdefaults IS NULL
      AND p.protrftypes IS NULL AND p.prolang=(SELECT oid FROM pg_catalog.pg_language WHERE lanname='plpgsql' AND lanpltrusted))
      FROM routines p) AS "definitionSafe",
    (SELECT count(*)=1 AND bool_and(t.tgname=${CASHIER_SECOND_CARD_PROMOTION_LOCK_TRIGGER} AND t.tgtype=19
      AND t.tgenabled='O' AND NOT t.tgisinternal AND t.tgnargs=0 AND t.tgargs=''::bytea AND t.tgattr=''::int2vector
      AND t.tgqual IS NULL AND NOT t.tgdeferrable AND NOT t.tginitdeferred AND t.tgconstraint=0 AND t.tgparentid=0
      AND t.tgoldtable IS NULL AND t.tgnewtable IS NULL AND t.tgfoid=(SELECT oid FROM routines LIMIT 1)) FROM triggers t)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_trigger t WHERE t.tgfoid IN(SELECT oid FROM routines)
      AND t.tgrelid NOT IN(SELECT oid FROM target)) AS "triggerSafe",
    (SELECT count(*)=1 AND bool_and(p.proowner=c.relowner AND p.proowner<>r.oid
      AND NOT EXISTS(SELECT 1 FROM authority a WHERE a.oid=p.proowner)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members m WHERE m.member=r.oid AND m.roleid=p.proowner))
      FROM routines p CROSS JOIN target c CROSS JOIN runtime r) AS "ownerSafe",
    (SELECT count(*)=1 AND bool_and(r.rolcanlogin AND NOT(r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls)) FROM runtime r)
    AND NOT EXISTS(SELECT 1 FROM authority a JOIN pg_catalog.pg_roles r ON r.oid=a.oid WHERE r.rolsuper OR r.rolcreatedb
      OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls OR pg_catalog.has_parameter_privilege(r.oid,'session_replication_role','SET')
      OR pg_catalog.has_parameter_privilege(r.oid,'session_replication_role','ALTER SYSTEM')
      OR EXISTS(SELECT 1 FROM ns WHERE nspowner=r.oid OR pg_catalog.has_schema_privilege(r.oid,oid,'CREATE'))
      OR EXISTS(SELECT 1 FROM pg_catalog.pg_database WHERE datname=current_database() AND datdba=r.oid)) AS "roleSafe",
    NOT EXISTS(SELECT 1 FROM routines p CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner)
    AND NOT EXISTS(SELECT 1 FROM target c CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(c.relacl,pg_catalog.acldefault('r',c.relowner))) a
      WHERE a.grantee<>c.relowner AND(a.grantee=0 OR a.is_grantable OR a.privilege_type NOT IN('SELECT','INSERT')))
    AND NOT EXISTS(SELECT 1 FROM actual_columns c CROSS JOIN LATERAL pg_catalog.aclexplode(c.attacl) a
      LEFT JOIN pg_catalog.pg_roles r ON r.oid=a.grantee
      WHERE c.attname<>'id' OR a.privilege_type<>'UPDATE' OR a.is_grantable OR r.oid IS NULL OR NOT r.rolcanlogin
        OR r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls)
    AND NOT EXISTS(SELECT 1 FROM column_authority a JOIN pg_catalog.pg_roles r ON r.oid=a.oid CROSS JOIN target c
      WHERE r.oid=c.relowner OR r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls
        OR pg_catalog.has_parameter_privilege(r.oid,'session_replication_role','SET')
        OR pg_catalog.has_parameter_privilege(r.oid,'session_replication_role','ALTER SYSTEM')
        OR EXISTS(SELECT 1 FROM ns WHERE nspowner=r.oid OR pg_catalog.has_schema_privilege(r.oid,oid,'CREATE'))
        OR EXISTS(SELECT 1 FROM pg_catalog.pg_database WHERE datname=current_database() AND datdba=r.oid)
        OR pg_catalog.has_table_privilege(r.oid,c.oid,'UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
        OR EXISTS(SELECT 1 FROM actual_columns col WHERE col.attname<>'id' AND pg_catalog.has_column_privilege(r.oid,c.oid,col.attnum,'UPDATE')))
    AND NOT EXISTS(SELECT 1 FROM sequences s CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(s.relacl,pg_catalog.acldefault('s',s.relowner))) a
      WHERE a.grantee<>s.relowner AND(a.grantee=0 OR a.is_grantable OR a.privilege_type<>'USAGE'))
    AND NOT EXISTS(SELECT 1 FROM authority a CROSS JOIN target c WHERE a.oid=c.relowner
      OR pg_catalog.has_table_privilege(a.oid,c.oid,'UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      OR EXISTS(SELECT 1 FROM actual_columns col WHERE col.attname<>'id'
        AND pg_catalog.has_column_privilege(a.oid,c.oid,col.attnum,'UPDATE')))
    AS "aclSafe",(SELECT oid::text FROM routines LIMIT 1) AS "functionOid",(SELECT oid::text FROM runtime) AS "runtimeOid"`;
}

export async function inspectCashierSecondCardPromotionLock(db: Query, runtimeRole: string, schema = 'public') {
  const [row] = await db.execute(cashierSecondCardPromotionLockCatalogQuery(runtimeRole, schema));
  const state = { absent: row?.absent === true, tablesSafe: row?.tablesSafe === true, definitionSafe: row?.definitionSafe === true,
    triggerSafe: row?.triggerSafe === true, ownerSafe: row?.ownerSafe === true, roleSafe: row?.roleSafe === true,
    aclSafe: row?.aclSafe === true, functionOid: typeof row?.functionOid === 'string' ? row.functionOid : null,
    runtimeOid: typeof row?.runtimeOid === 'string' ? row.runtimeOid : null };
  return { ...state, ready: !state.absent && state.tablesSafe && state.definitionSafe && state.triggerSafe && state.ownerSafe && state.roleSafe && state.aclSafe };
}

export async function cashierSecondCardPromotionLockReadiness(db: Query, schema = 'public') {
  const [identity] = await db.execute<{ role: string; same_backend: boolean }>(sql`SELECT session_user AS role,
    EXISTS(SELECT 1 FROM pg_catalog.pg_stat_activity a JOIN pg_catalog.pg_roles r ON r.oid=a.usesysid
      WHERE a.pid=pg_catalog.pg_backend_pid() AND r.rolname=session_user) AS same_backend`);
  if (!identity || typeof identity.role !== 'string' || identity.same_backend !== true)
    return { ready: false, reason: 'cashier_promotion_connection_identity_unproven', catalog: null };
  const catalog = await inspectCashierSecondCardPromotionLock(db, identity.role, schema);
  return { ready: catalog.ready, reason: catalog.ready ? '' : 'cashier_promotion_lock_guard_unreviewed', catalog };
}

const ready = (name: string) => ['tablesSafe','definitionSafe','triggerSafe','ownerSafe','roleSafe','aclSafe']
  .map(key => `${name}->>'${key}'='true'`).join(' AND ');
const maintenance = (namespace: string, runtimeRole: string) => `
 IF pg_catalog.current_setting('server_version_num')::integer/10000<>16 OR pg_catalog.current_setting('transaction_isolation')<>'read committed'
 OR pg_catalog.current_setting('transaction_read_only')<>'off' OR pg_catalog.current_setting('session_replication_role')<>'origin'
 OR current_user<>session_user OR current_user=${literal(runtimeRole)}
 OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_stat_activity a JOIN pg_catalog.pg_roles r ON r.oid=a.usesysid WHERE a.pid=pg_catalog.pg_backend_pid() AND r.rolname=current_user)
 OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_roles r ON r.oid=c.relowner WHERE c.oid='${namespace}.store_order_promotions'::regclass AND r.rolname=current_user)
 OR EXISTS(SELECT 1 FROM pg_catalog.pg_event_trigger WHERE evtenabled<>'D') THEN RAISE EXCEPTION 'Cashier promotion lock requires explicit PG16 table-owner maintenance';END IF;
 SELECT oid::integer INTO namespace_oid FROM pg_catalog.pg_namespace WHERE nspname=${literal(namespace.replaceAll('"',''))};
 IF namespace_oid IS NULL OR NOT pg_catalog.pg_try_advisory_xact_lock(${CASHIER_SECOND_CARD_PROMOTION_LOCK_KEY},namespace_oid) THEN RAISE EXCEPTION 'Cashier promotion lock maintenance busy';END IF;
 LOCK TABLE ${namespace}.store_order_promotions IN SHARE ROW EXCLUSIVE MODE NOWAIT;
`;
/** Root maintenance only, no role creation, grants, implicit role or drift repair. */
export async function installCashierSecondCardPromotionLock(db: Root, runtimeRole: string, schema = 'public') {
  if (!Object.hasOwn(db, '$client') || !db.$client) throw Error('Cashier promotion lock requires root maintenance client');
  const namespace = pricingIdentifier(schema); pricingIdentifier(runtimeRole);
  const catalog = inline(cashierSecondCardPromotionLockCatalogQuery(runtimeRole, schema)),body = cashierSecondCardPromotionLockBody(runtimeRole, schema);
  const statement = `DO $cashier_promotion_install$
 DECLARE namespace_oid integer;state jsonb;
 BEGIN ${maintenance(namespace,runtimeRole)}
 SELECT pg_catalog.to_jsonb(q) INTO state FROM (${catalog}) q;
 IF COALESCE((${ready('state')}),false) AND state->>'absent'='false' THEN RETURN;END IF;
 IF state->>'absent' IS DISTINCT FROM 'true' OR state->>'tablesSafe' IS DISTINCT FROM 'true' OR state->>'roleSafe' IS DISTINCT FROM 'true' OR state->>'aclSafe' IS DISTINCT FROM 'true' THEN RAISE EXCEPTION 'Cashier promotion lock catalog role ACL drift';END IF;
 EXECUTE ${literal(`CREATE FUNCTION ${namespace}.${CASHIER_SECOND_CARD_PROMOTION_LOCK_FUNCTION}() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,pg_temp AS $cashier_promotion_guard$${body}$cashier_promotion_guard$`)};
 REVOKE ALL ON FUNCTION ${namespace}.${CASHIER_SECOND_CARD_PROMOTION_LOCK_FUNCTION}() FROM PUBLIC;
 CREATE TRIGGER ${CASHIER_SECOND_CARD_PROMOTION_LOCK_TRIGGER} BEFORE UPDATE ON ${namespace}.store_order_promotions FOR EACH ROW EXECUTE FUNCTION ${namespace}.${CASHIER_SECOND_CARD_PROMOTION_LOCK_FUNCTION}();
 SELECT pg_catalog.to_jsonb(q) INTO state FROM (${catalog}) q;
 IF NOT COALESCE((${ready('state')}),false) OR state->>'absent' IS DISTINCT FROM 'false' THEN RAISE EXCEPTION 'Cashier promotion lock final verification failed';END IF;
 END $cashier_promotion_install$;`;
  return db.transaction(async tx => { await tx.execute(sql.raw(statement)); return inspectCashierSecondCardPromotionLock(tx,runtimeRole,schema); },
    { isolationLevel: 'read committed', accessMode: 'read write' });
}

/** One atomic checked grant. The compiler cannot emit a naked UPDATE(id):
 * actual owner/table lock/catalog validation and grant share this transaction. */
export function cashierSecondCardPromotionLockGrantSql(runtimeRole: string, schema = 'public') {
  const namespace=pricingIdentifier(schema),role=pricingIdentifier(runtimeRole),catalog=inline(cashierSecondCardPromotionLockCatalogQuery(runtimeRole,schema));
  return `DO $cashier_promotion_grant$
 DECLARE namespace_oid integer;state jsonb;
 BEGIN ${maintenance(namespace,runtimeRole)}
 SELECT pg_catalog.to_jsonb(q) INTO state FROM (${catalog}) q;
 IF NOT COALESCE((${ready('state')}),false) OR state->>'absent' IS DISTINCT FROM 'false' THEN RAISE EXCEPTION 'Cashier promotion lock guard must be verified before UPDATE(id) grant';END IF;
 GRANT UPDATE(id) ON ${namespace}.store_order_promotions TO ${role};
 SELECT pg_catalog.to_jsonb(q) INTO state FROM (${catalog}) q;
 IF NOT COALESCE((${ready('state')}),false) THEN RAISE EXCEPTION 'Cashier promotion lock grant verification failed';END IF;
 END $cashier_promotion_grant$;`;
}
