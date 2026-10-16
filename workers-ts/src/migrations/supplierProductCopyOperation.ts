import { sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { ServiceUnavailableException } from '@/utils/errors';

/** Independently commissioned addon. The historical whole-shop bootstrap and
 * registered ORM cohort remain unchanged; HTTP never executes this DDL. */
export const SUPPLIER_PRODUCT_COPY_OPERATION_IMMUTABLE_BODY = `BEGIN
  RAISE EXCEPTION 'Supplier product copy operation evidence is immutable' USING ERRCODE='42501';
END`;
export const SUPPLIER_PRODUCT_COPY_OPERATION_SQL = `CREATE TABLE public.supplier_product_copy_operation_v1 (
  operation_id uuid NOT NULL,
  actor_id integer NOT NULL,
  supplier_id integer NOT NULL,
  source_id integer NOT NULL,
  request_hash varchar(64) NOT NULL,
  state varchar(16) NOT NULL,
  result jsonb,
  created_at integer NOT NULL,
  CONSTRAINT spco_pk PRIMARY KEY (operation_id),
  CONSTRAINT spco_identity_ck CHECK (actor_id > 0 AND supplier_id > 0 AND source_id > 0 AND created_at > 0),
  CONSTRAINT spco_key_ck CHECK (operation_id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  CONSTRAINT spco_state_ck CHECK ((
    (state = 'not_applied' AND request_hash = '' AND result IS NULL) OR
    (state = 'committed' AND request_hash ~ '^[0-9a-f]{64}$'
      AND result IS NOT NULL AND jsonb_typeof(result) = 'object'
      AND jsonb_typeof(result->'id') = 'number' AND (result->>'id') ~ '^[1-9][0-9]{0,9}$'
      AND (result->>'id')::bigint <= 2147483647
      AND result->'is_show' = '0'::jsonb AND result->'is_verify' = '0'::jsonb
      AND result - 'id' - 'is_show' - 'is_verify' = '{}'::jsonb)) IS TRUE)
);
CREATE FUNCTION public.supplier_product_copy_operation_immutable_v1() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $spco_immutable$${SUPPLIER_PRODUCT_COPY_OPERATION_IMMUTABLE_BODY}$spco_immutable$;
REVOKE ALL ON FUNCTION public.supplier_product_copy_operation_immutable_v1() FROM PUBLIC;
CREATE TRIGGER spco_immutable_rows BEFORE UPDATE OR DELETE ON public.supplier_product_copy_operation_v1
FOR EACH ROW EXECUTE FUNCTION public.supplier_product_copy_operation_immutable_v1();
CREATE TRIGGER spco_immutable_truncate BEFORE TRUNCATE ON public.supplier_product_copy_operation_v1
FOR EACH STATEMENT EXECUTE FUNCTION public.supplier_product_copy_operation_immutable_v1();
REVOKE ALL ON TABLE public.supplier_product_copy_operation_v1 FROM PUBLIC;
`;

// PG16 canonical CHECK definitions, independently bound by native installation
// tests. No source offsets/OIDs, rows, role names or mutable ACLs enter this pin.
export const SUPPLIER_PRODUCT_COPY_OPERATION_CONSTRAINTS_SHA256 = '77e6e703155e85c13046caab735f424446a7bb4a5b84cb2fc64d3bf30caebba1';
export async function inspectSupplierProductCopyOperation(tx: Pick<DbClient, 'execute'>) {
  const [row] = await tx.execute(sql`SELECT
    current_user=session_user AND current_schema()='public'
      AND current_setting('server_version_num')::integer/10000=16 AND current_setting('session_replication_role')='origin'
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_event_trigger WHERE evtenabled<>'D') AS supported,
    c.relkind='r' AND c.relpersistence='p' AND NOT c.relispartition
      AND NOT c.relrowsecurity AND NOT c.relforcerowsecurity AND c.relnatts=8 AND c.relchecks=3
      AND c.reloptions IS NULL AND c.relreplident='d'
      AND c.relam=(SELECT oid FROM pg_catalog.pg_am WHERE amname='heap')
      AND EXISTS(SELECT 1 FROM pg_catalog.pg_roles r WHERE r.oid=c.relowner AND r.rolsuper)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_inherits WHERE inhparent=c.oid OR inhrelid=c.oid)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_rewrite WHERE ev_class=c.oid)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_policy WHERE polrelid=c.oid)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_constraint WHERE confrelid=c.oid)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid=c.oid AND contype NOT IN ('p','c','n'))
      AS safe,
    (SELECT jsonb_agg(jsonb_build_array(a.attnum,a.attname,format_type(a.atttypid,a.atttypmod),a.attnotnull,
        a.atthasdef,a.attidentity,a.attgenerated,a.attisdropped,
        CASE WHEN a.attcollation=0 THEN NULL ELSE a.attcollation::regcollation::text END) ORDER BY a.attnum)
      FROM pg_catalog.pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0) AS columns,
    (SELECT encode(sha256(convert_to(jsonb_object_agg(conname,pg_get_constraintdef(oid,false) ORDER BY conname)::text,'UTF8')),'hex')
      FROM pg_catalog.pg_constraint WHERE conrelid=c.oid AND contype IN ('p','c')
        AND convalidated AND NOT condeferrable AND NOT condeferred AND conislocal AND coninhcount=0 AND conparentid=0) AS constraints_hash,
    (SELECT count(*)=4 FROM pg_catalog.pg_constraint WHERE conrelid=c.oid AND contype IN ('p','c')) AS constraint_count,
    (SELECT count(*)=1 AND bool_and(indisprimary AND indisunique AND indisvalid AND indisready AND indislive
      AND indimmediate AND NOT indisexclusion AND indkey::text='1' AND indnatts=1 AND indnkeyatts=1
      AND indoption::text='0' AND indcollation::text='0'
      AND indclass::text=(SELECT oid::text FROM pg_catalog.pg_opclass WHERE opcname='uuid_ops' AND opcnamespace='pg_catalog'::regnamespace
        AND opcmethod=(SELECT oid FROM pg_catalog.pg_am WHERE amname='btree'))
      AND NOT indnullsnotdistinct AND indexprs IS NULL AND indpred IS NULL
      AND EXISTS(SELECT 1 FROM pg_catalog.pg_class i WHERE i.oid=indexrelid AND i.relkind='i'
        AND i.relname='spco_pk' AND i.relnamespace=c.relnamespace AND i.relowner=c.relowner AND i.reloptions IS NULL
        AND i.relam=(SELECT oid FROM pg_catalog.pg_am WHERE amname='btree')))
      FROM pg_catalog.pg_index WHERE indrelid=c.oid) AS indexes,
    (SELECT count(*)=2 AND bool_and(NOT t.tgisinternal AND t.tgenabled='O' AND t.tgnargs=0 AND t.tgqual IS NULL
      AND t.tgconstraint=0 AND t.tgfoid=f.oid AND t.tgattr::text='' AND t.tgargs='\\x'::bytea AND t.tgoldtable IS NULL AND t.tgnewtable IS NULL
      AND ((t.tgname='spco_immutable_rows' AND t.tgtype=27) OR (t.tgname='spco_immutable_truncate' AND t.tgtype=34)))
      FROM pg_catalog.pg_trigger t WHERE t.tgrelid=c.oid)
      AND (SELECT count(*)=2 FROM pg_catalog.pg_trigger t WHERE t.tgfoid=f.oid) AS triggers,
    f.proowner=c.relowner AND f.prosrc=${SUPPLIER_PRODUCT_COPY_OPERATION_IMMUTABLE_BODY} AND f.prorettype='pg_catalog.trigger'::regtype
      AND f.pronargs=0 AND NOT f.prosecdef AND NOT f.proleakproof AND f.provolatile='v' AND f.prokind='f'
      AND NOT f.proisstrict AND NOT f.proretset AND f.proparallel='u' AND f.prosupport=0 AND f.provariadic=0
      AND f.pronargdefaults=0 AND f.proargdefaults IS NULL AND f.proallargtypes IS NULL
      AND f.proargmodes IS NULL AND f.proargnames IS NULL AND f.procost=100 AND f.prorows=0
      AND f.probin IS NULL AND f.prosqlbody IS NULL AND f.protrftypes IS NULL
      AND (SELECT count(*)=1 FROM pg_catalog.pg_proc p WHERE p.pronamespace=c.relnamespace AND p.proname='supplier_product_copy_operation_immutable_v1')
      AND f.proconfig=ARRAY['search_path=pg_catalog'] AND f.prolang=(SELECT oid FROM pg_catalog.pg_language WHERE lanname='plpgsql')
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.aclexplode(COALESCE(f.proacl,pg_catalog.acldefault('f',f.proowner))) a
        WHERE a.grantee<>f.proowner) AS function,
    NOT EXISTS(SELECT 1 FROM pg_catalog.aclexplode(COALESCE(c.relacl,pg_catalog.acldefault('r',c.relowner))) a
      WHERE a.grantee<>c.relowner AND (a.grantee=0 OR a.is_grantable OR a.privilege_type NOT IN ('SELECT','INSERT')))
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_attribute col CROSS JOIN LATERAL pg_catalog.aclexplode(col.attacl) a
        WHERE col.attrelid=c.oid AND a.grantee<>c.relowner)
      AND has_table_privilege(current_user,c.oid,'SELECT') AND has_table_privilege(current_user,c.oid,'INSERT')
      AND (c.relowner=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=current_user) OR
        NOT has_table_privilege(current_user,c.oid,'UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')) AS privileges
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_proc f ON f.oid=to_regprocedure('public.supplier_product_copy_operation_immutable_v1()')
    WHERE c.oid=to_regclass('public.supplier_product_copy_operation_v1')`);
  return row;
}

/** Explicit additive PG16 maintenance only. An existing unknown or partial
 * catalog is refused; HTTP/startup never calls this installer. No business data
 * or existing runtime grants are changed. */
export async function installSupplierProductCopyOperation(tx: Pick<DbClient, 'execute'>, runtimeRole?: string) {
  if (Object.hasOwn(tx, '$client')) throw Error('Supplier product copy installation requires an existing maintenance transaction');
  if (runtimeRole !== undefined && !/^[a-z][a-z0-9_]{0,62}$/.test(runtimeRole)) throw Error('Invalid supplier product copy runtime identity');
  const [gate] = await tx.execute(sql`SELECT current_user AS identity,
    current_user=session_user AND current_schema()='public'
    AND current_setting('server_version_num')::integer/10000=16
    AND current_setting('transaction_isolation')='read committed'
    AND NOT current_setting('transaction_read_only')::boolean
    AND current_setting('session_replication_role')='origin'
    AND EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=current_user AND rolsuper)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_event_trigger WHERE evtenabled<>'D')
    AND pg_try_advisory_xact_lock(731627,14) AS supported,
    to_regclass('public.supplier_product_copy_operation_v1') IS NOT NULL AS table_exists,
    to_regprocedure('public.supplier_product_copy_operation_immutable_v1()') IS NOT NULL AS function_exists`);
  if (gate?.supported !== true) throw Error('Supplier product copy installation requires explicit PG16 owner maintenance');
  if (runtimeRole) {
    const [role] = await tx.execute(sql`SELECT NOT rolsuper AND NOT rolcreaterole AND NOT rolcreatedb
      AND NOT rolreplication AND NOT rolbypassrls AS safe FROM pg_catalog.pg_roles WHERE rolname=${runtimeRole}`);
    if (role?.safe !== true || runtimeRole === gate.identity) throw Error('Supplier product copy runtime must be a separate restricted identity');
  }
  if (gate.table_exists || gate.function_exists) {
    if (!gate.table_exists || !gate.function_exists) throw Error('Partial supplier product copy receipt catalog requires review');
    await tx.execute(sql.raw('LOCK TABLE ONLY public.supplier_product_copy_operation_v1 IN ACCESS EXCLUSIVE MODE NOWAIT'));
    await assertSupplierProductCopyOperationReady(tx);
    if (runtimeRole) {
      const [grant] = await tx.execute(sql`SELECT has_table_privilege(${runtimeRole},'public.supplier_product_copy_operation_v1','SELECT')
        AND has_table_privilege(${runtimeRole},'public.supplier_product_copy_operation_v1','INSERT')
        AND NOT has_table_privilege(${runtimeRole},'public.supplier_product_copy_operation_v1','UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS ready`);
      if (grant?.ready !== true) throw Error('Existing supplier product copy runtime grants require review');
    }
    return { applied: false };
  }
  await tx.execute(sql.raw(SUPPLIER_PRODUCT_COPY_OPERATION_SQL));
  if (runtimeRole) await tx.execute(sql.raw(`GRANT SELECT,INSERT ON TABLE public.supplier_product_copy_operation_v1 TO "${runtimeRole}"`));
  await assertSupplierProductCopyOperationReady(tx);
  if (runtimeRole) {
    const [grant] = await tx.execute(sql`SELECT has_table_privilege(${runtimeRole},'public.supplier_product_copy_operation_v1','SELECT')
      AND has_table_privilege(${runtimeRole},'public.supplier_product_copy_operation_v1','INSERT')
      AND NOT has_table_privilege(${runtimeRole},'public.supplier_product_copy_operation_v1','UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS ready`);
    if (grant?.ready !== true) throw Error('Supplier product copy runtime grants require review');
  }
  return { applied: true };
}
const expectedColumns = [
  [1,'operation_id','uuid',true,false,'','',false,null],
  [2,'actor_id','integer',true,false,'','',false,null],
  [3,'supplier_id','integer',true,false,'','',false,null],
  [4,'source_id','integer',true,false,'','',false,null],
  [5,'request_hash','character varying(64)',true,false,'','',false,'"default"'],
  [6,'state','character varying(16)',true,false,'','',false,'"default"'],
  [7,'result','jsonb',false,false,'','',false,null],
  [8,'created_at','integer',true,false,'','',false,null],
];
export async function assertSupplierProductCopyOperationReady(tx: Pick<DbClient, 'execute'>) {
  try {
    // Keep the actual relation locked against schema replacement throughout
    // this transaction before inspecting its physical catalog.
    await tx.execute(sql`SELECT operation_id FROM public.supplier_product_copy_operation_v1 LIMIT 0`);
    const state = await inspectSupplierProductCopyOperation(tx);
    if (!state || ['supported','safe','constraint_count','indexes','triggers','function','privileges'].some(key => state[key] !== true)
      || state.constraints_hash !== SUPPLIER_PRODUCT_COPY_OPERATION_CONSTRAINTS_SHA256
      || JSON.stringify(state.columns) !== JSON.stringify(expectedColumns)) throw Error('Supplier product copy receipt catalog drift');
  } catch (cause) {
    throw Object.assign(new ServiceUnavailableException('商品编辑操作回执或运行权限尚未就绪'), { cause });
  }
}
