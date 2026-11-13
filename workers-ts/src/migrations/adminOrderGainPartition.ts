import { sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { ServiceUnavailableException } from '@/utils/errors';

/** Independently commissioned addon. The historical whole-shop bootstrap and
 * registered ORM cohort remain unchanged; HTTP never executes this DDL. */
export const ADMIN_ORDER_GAIN_PARTITION_IMMUTABLE_BODY = `BEGIN
  RAISE EXCEPTION 'Admin order gain partition operation evidence is immutable' USING ERRCODE='42501';
END`;
export const ADMIN_ORDER_GAIN_PARTITION_SQL = `CREATE TABLE public.admin_order_gain_partition_v1 (
  partition_id uuid NOT NULL,
  operation_id uuid NOT NULL,
  source_order_id integer NOT NULL,
  child_order_id integer NOT NULL,
  buyer_id integer NOT NULL,
  supplier_id integer NOT NULL,
  kind varchar(16) NOT NULL,
  source_hash varchar(64) NOT NULL,
  child_hash varchar(64) NOT NULL,
  evidence jsonb NOT NULL,
  created_at integer NOT NULL,
  CONSTRAINT aogp_pk PRIMARY KEY (partition_id),
  CONSTRAINT aogp_identity_ck CHECK (source_order_id > 0 AND child_order_id > 0 AND buyer_id >= 0 AND supplier_id >= 0 AND created_at > 0),
  CONSTRAINT aogp_key_ck CHECK (partition_id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND operation_id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  CONSTRAINT aogp_evidence_ck CHECK ((kind IN ('allocation','fulfillment','refund')
    AND source_hash ~ '^[0-9a-f]{64}$' AND child_hash ~ '^[0-9a-f]{64}$'
    AND jsonb_typeof(evidence)='object' AND octet_length(evidence::text)<=196608
    AND evidence->>'version'='admin-order-gain-partition-v1'
    AND jsonb_typeof(evidence->'source')='object' AND jsonb_typeof(evidence->'child')='object'
    AND jsonb_typeof(evidence->'selection')='array' AND jsonb_array_length(evidence->'selection') BETWEEN 1 AND 200) IS TRUE)
);
CREATE UNIQUE INDEX aogp_child_state ON public.admin_order_gain_partition_v1(child_order_id,child_hash);
CREATE FUNCTION public.admin_order_gain_partition_immutable_v1() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $aogp_immutable$${ADMIN_ORDER_GAIN_PARTITION_IMMUTABLE_BODY}$aogp_immutable$;
REVOKE ALL ON FUNCTION public.admin_order_gain_partition_immutable_v1() FROM PUBLIC;
CREATE TRIGGER aogp_immutable_rows BEFORE UPDATE OR DELETE ON public.admin_order_gain_partition_v1
FOR EACH ROW EXECUTE FUNCTION public.admin_order_gain_partition_immutable_v1();
CREATE TRIGGER aogp_immutable_truncate BEFORE TRUNCATE ON public.admin_order_gain_partition_v1
FOR EACH STATEMENT EXECUTE FUNCTION public.admin_order_gain_partition_immutable_v1();
REVOKE ALL ON TABLE public.admin_order_gain_partition_v1 FROM PUBLIC;
`;

// PG16 canonical CHECK definitions, independently bound by native installation
// tests. No source offsets/OIDs, rows, role names or mutable ACLs enter this pin.
export const ADMIN_ORDER_GAIN_PARTITION_CONSTRAINTS_SHA256 = '3231f485dbbe2eac7b17672eedc55244c336d174adc35483a341b8e813cd6708';
export async function inspectAdminOrderGainPartition(tx: Pick<DbClient, 'execute'>, mode: 'read' | 'write' = 'write') {
  const [row] = await tx.execute(sql`SELECT
    current_user=session_user AND current_schema()='public'
      AND current_setting('server_version_num')::integer/10000=16 AND current_setting('session_replication_role')='origin'
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_event_trigger WHERE evtenabled<>'D') AS supported,
    c.relkind='r' AND c.relpersistence='p' AND NOT c.relispartition
      AND NOT c.relrowsecurity AND NOT c.relforcerowsecurity AND c.relnatts=11 AND c.relchecks=3
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
    (SELECT count(*)=2 AND bool_and(i.indisunique AND i.indisvalid AND i.indisready AND i.indislive
      AND i.indimmediate AND NOT i.indisexclusion AND NOT i.indnullsnotdistinct
      AND i.indexprs IS NULL AND i.indpred IS NULL AND x.relkind='i' AND x.relowner=c.relowner
      AND x.relnamespace=c.relnamespace AND x.reloptions IS NULL
      AND x.relam=(SELECT oid FROM pg_catalog.pg_am WHERE amname='btree')
      AND ((x.relname='aogp_pk' AND i.indisprimary AND i.indkey::text='1' AND i.indnatts=1 AND i.indnkeyatts=1
        AND i.indoption::text='0' AND i.indcollation::text='0'
        AND i.indclass::text=(SELECT oid::text FROM pg_catalog.pg_opclass WHERE opcname='uuid_ops' AND opcnamespace='pg_catalog'::regnamespace AND opcmethod=x.relam))
      OR (x.relname='aogp_child_state' AND NOT i.indisprimary AND i.indkey::text='4 9' AND i.indnatts=2 AND i.indnkeyatts=2
        AND i.indoption::text='0 0'
        AND i.indcollation::text='0 '||(SELECT oid::text FROM pg_catalog.pg_collation WHERE collname='default' AND collnamespace='pg_catalog'::regnamespace)
        AND i.indclass::text=(SELECT oid::text FROM pg_catalog.pg_opclass WHERE opcname='int4_ops' AND opcnamespace='pg_catalog'::regnamespace AND opcmethod=x.relam)||' '||(SELECT oid::text FROM pg_catalog.pg_opclass WHERE opcname='text_ops' AND opcnamespace='pg_catalog'::regnamespace AND opcmethod=x.relam))))
      FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class x ON x.oid=i.indexrelid WHERE i.indrelid=c.oid) AS indexes,
    (SELECT count(*)=2 AND bool_and(NOT t.tgisinternal AND t.tgenabled='O' AND t.tgnargs=0 AND t.tgqual IS NULL
      AND t.tgconstraint=0 AND t.tgfoid=f.oid AND t.tgattr::text='' AND t.tgargs='\\x'::bytea AND t.tgoldtable IS NULL AND t.tgnewtable IS NULL
      AND ((t.tgname='aogp_immutable_rows' AND t.tgtype=27) OR (t.tgname='aogp_immutable_truncate' AND t.tgtype=34)))
      FROM pg_catalog.pg_trigger t WHERE t.tgrelid=c.oid)
      AND (SELECT count(*)=2 FROM pg_catalog.pg_trigger t WHERE t.tgfoid=f.oid) AS triggers,
    f.proowner=c.relowner AND f.prosrc=${ADMIN_ORDER_GAIN_PARTITION_IMMUTABLE_BODY} AND f.prorettype='pg_catalog.trigger'::regtype
      AND f.pronargs=0 AND NOT f.prosecdef AND NOT f.proleakproof AND f.provolatile='v' AND f.prokind='f'
      AND NOT f.proisstrict AND NOT f.proretset AND f.proparallel='u' AND f.prosupport=0 AND f.provariadic=0
      AND f.pronargdefaults=0 AND f.proargdefaults IS NULL AND f.proallargtypes IS NULL
      AND f.proargmodes IS NULL AND f.proargnames IS NULL AND f.procost=100 AND f.prorows=0
      AND f.probin IS NULL AND f.prosqlbody IS NULL AND f.protrftypes IS NULL
      AND (SELECT count(*)=1 FROM pg_catalog.pg_proc p WHERE p.pronamespace=c.relnamespace AND p.proname='admin_order_gain_partition_immutable_v1')
      AND f.proconfig=ARRAY['search_path=pg_catalog'] AND f.prolang=(SELECT oid FROM pg_catalog.pg_language WHERE lanname='plpgsql')
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.aclexplode(COALESCE(f.proacl,pg_catalog.acldefault('f',f.proowner))) a
        WHERE a.grantee<>f.proowner) AS function,
    NOT EXISTS(SELECT 1 FROM pg_catalog.aclexplode(COALESCE(c.relacl,pg_catalog.acldefault('r',c.relowner))) a
      WHERE a.grantee<>c.relowner AND (a.grantee=0 OR a.is_grantable OR a.privilege_type NOT IN ('SELECT','INSERT')))
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_attribute col CROSS JOIN LATERAL pg_catalog.aclexplode(col.attacl) a
        WHERE col.attrelid=c.oid AND a.grantee<>c.relowner)
      AND has_table_privilege(current_user,c.oid,'SELECT') AND (${mode === 'read'} OR has_table_privilege(current_user,c.oid,'INSERT'))
      AND (c.relowner=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=current_user) OR
        NOT has_table_privilege(current_user,c.oid,'UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')) AS privileges
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_proc f ON f.oid=to_regprocedure('public.admin_order_gain_partition_immutable_v1()')
    WHERE c.oid=to_regclass('public.admin_order_gain_partition_v1')`);
  return row;
}

/** Explicit additive PG16 maintenance only. An existing unknown or partial
 * catalog is refused; HTTP/startup never calls this installer. No business data
 * or existing runtime grants are changed. */
export async function installAdminOrderGainPartition(tx: Pick<DbClient, 'execute'>, runtimeRole?: string) {
  if (Object.hasOwn(tx, '$client')) throw Error('Admin order gain partition installation requires an existing maintenance transaction');
  if (runtimeRole !== undefined && !/^[a-z][a-z0-9_]{0,62}$/.test(runtimeRole)) throw Error('Invalid admin order gain partition runtime identity');
  const [gate] = await tx.execute(sql`SELECT current_user AS identity,
    current_user=session_user AND current_schema()='public'
    AND current_setting('server_version_num')::integer/10000=16
    AND current_setting('transaction_isolation')='read committed'
    AND NOT current_setting('transaction_read_only')::boolean
    AND current_setting('session_replication_role')='origin'
    AND EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=current_user AND rolsuper)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_event_trigger WHERE evtenabled<>'D')
    AND pg_try_advisory_xact_lock(731628,16) AS supported,
    to_regclass('public.admin_order_gain_partition_v1') IS NOT NULL AS table_exists,
    to_regprocedure('public.admin_order_gain_partition_immutable_v1()') IS NOT NULL AS function_exists`);
  if (gate?.supported !== true) throw Error('Admin order gain partition installation requires explicit PG16 owner maintenance');
  if (runtimeRole) {
    const [role] = await tx.execute(sql`SELECT NOT rolsuper AND NOT rolcreaterole AND NOT rolcreatedb
      AND NOT rolreplication AND NOT rolbypassrls AS safe FROM pg_catalog.pg_roles WHERE rolname=${runtimeRole}`);
    if (role?.safe !== true || runtimeRole === gate.identity) throw Error('Admin order gain partition runtime must be a separate restricted identity');
  }
  if (gate.table_exists || gate.function_exists) {
    if (!gate.table_exists || !gate.function_exists) throw Error('Partial admin order gain partition receipt catalog requires review');
    await tx.execute(sql.raw('LOCK TABLE ONLY public.admin_order_gain_partition_v1 IN ACCESS EXCLUSIVE MODE NOWAIT'));
    await assertAdminOrderGainPartitionReady(tx);
    if (runtimeRole) {
      const [grant] = await tx.execute(sql`SELECT has_table_privilege(${runtimeRole},'public.admin_order_gain_partition_v1','SELECT')
        AND has_table_privilege(${runtimeRole},'public.admin_order_gain_partition_v1','INSERT')
        AND NOT has_table_privilege(${runtimeRole},'public.admin_order_gain_partition_v1','UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS ready`);
      if (grant?.ready !== true) throw Error('Existing admin order gain partition runtime grants require review');
    }
    return { applied: false };
  }
  await tx.execute(sql.raw(ADMIN_ORDER_GAIN_PARTITION_SQL));
  if (runtimeRole) await tx.execute(sql.raw(`GRANT SELECT,INSERT ON TABLE public.admin_order_gain_partition_v1 TO "${runtimeRole}"`));
  await assertAdminOrderGainPartitionReady(tx);
  if (runtimeRole) {
    const [grant] = await tx.execute(sql`SELECT has_table_privilege(${runtimeRole},'public.admin_order_gain_partition_v1','SELECT')
      AND has_table_privilege(${runtimeRole},'public.admin_order_gain_partition_v1','INSERT')
      AND NOT has_table_privilege(${runtimeRole},'public.admin_order_gain_partition_v1','UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS ready`);
    if (grant?.ready !== true) throw Error('Admin order gain partition runtime grants require review');
  }
  return { applied: true };
}
const expectedColumns = [
  [1,'partition_id','uuid',true,false,'','',false,null],
  [2,'operation_id','uuid',true,false,'','',false,null],
  [3,'source_order_id','integer',true,false,'','',false,null],
  [4,'child_order_id','integer',true,false,'','',false,null],
  [5,'buyer_id','integer',true,false,'','',false,null],
  [6,'supplier_id','integer',true,false,'','',false,null],
  [7,'kind','character varying(16)',true,false,'','',false,'\"default\"'],
  [8,'source_hash','character varying(64)',true,false,'','',false,'\"default\"'],
  [9,'child_hash','character varying(64)',true,false,'','',false,'\"default\"'],
  [10,'evidence','jsonb',true,false,'','',false,null],
  [11,'created_at','integer',true,false,'','',false,null],
];
export function adminOrderGainPartitionCatalogReady(state: Awaited<ReturnType<typeof inspectAdminOrderGainPartition>>): boolean {
  return !!state && ['supported','safe','constraint_count','indexes','triggers','function','privileges'].every(key => state[key] === true)
    && state.constraints_hash === ADMIN_ORDER_GAIN_PARTITION_CONSTRAINTS_SHA256
    && JSON.stringify(state.columns) === JSON.stringify(expectedColumns);
}
export async function assertAdminOrderGainPartitionReady(tx: Pick<DbClient, 'execute'>, mode: 'read' | 'write' = 'write') {
  try {
    // Keep the actual relation locked against schema replacement throughout
    // this transaction before inspecting its physical catalog.
    await tx.execute(sql`SELECT partition_id FROM public.admin_order_gain_partition_v1 LIMIT 0`);
    const state = await inspectAdminOrderGainPartition(tx, mode);
    if (!adminOrderGainPartitionCatalogReady(state)) throw Error('Admin order gain partition receipt catalog drift');
  } catch (cause) {
    throw Object.assign(new ServiceUnavailableException('旧订单赠分分割凭据或运行权限尚未就绪'), { cause });
  }
}
/** Existing financial readers do not acquire the new editor's INSERT grant.
 * The exact protected catalog is still checked whenever its proof is used. */
export async function assertAdminOrderGainPartitionReadable(tx: Pick<DbClient, 'execute'>) {
  await assertAdminOrderGainPartitionReady(tx, 'read');
}
