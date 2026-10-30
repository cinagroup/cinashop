import { sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { ServiceUnavailableException } from '@/utils/errors';

type Query = Pick<DbClient, 'execute'>;
export const ADMIN_UNIT_OPERATION_RUNTIME_PRIVILEGES = { app: [], admin: ['SELECT', 'INSERT'] } as const;
export const ADMIN_UNIT_OPERATION_GATE = [731626, 22] as const;
export const ADMIN_UNIT_OPERATION_IMMUTABLE_BODY = `BEGIN
  RAISE EXCEPTION 'Unit operation evidence is immutable' USING ERRCODE='42501';
END`;

/** Explicit maintenance addon only. No foreign key, sequence,
 * expiry, mutable receipt, request-time installation or catalog DML capability. */
export const ADMIN_UNIT_OPERATION_SQL = `
CREATE TABLE public.admin_unit_operation (
  operation_id uuid NOT NULL,
  actor_id integer NOT NULL,
  operation varchar(16) NOT NULL,
  target_id integer NOT NULL,
  payload_hash varchar(64) NOT NULL,
  revision varchar(64) NOT NULL,
  state varchar(16) NOT NULL,
  result jsonb NOT NULL,
  created_at bigint NOT NULL,
  CONSTRAINT auno_pk PRIMARY KEY(operation_id),
  CONSTRAINT auno_id_ck CHECK(operation_id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  CONSTRAINT auno_actor_ck CHECK(actor_id > 0),
  CONSTRAINT auno_operation_ck CHECK(operation IN ('create','update','delete')),
  CONSTRAINT auno_target_ck CHECK(target_id >= 0),
  CONSTRAINT auno_payload_hash_ck CHECK(payload_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT auno_revision_ck CHECK(revision ~ '^[a-f0-9]{64}$'),
  CONSTRAINT auno_state_ck CHECK(state IN ('committed','not_applied')),
  CONSTRAINT auno_result_ck CHECK(jsonb_typeof(result)='object'),
  CONSTRAINT auno_created_ck CHECK(created_at > 0)
);
CREATE FUNCTION public.admin_unit_operation_immutable_v1() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $auno_immutable$${ADMIN_UNIT_OPERATION_IMMUTABLE_BODY}$auno_immutable$;
CREATE TRIGGER auno_immutable_rows BEFORE UPDATE OR DELETE ON public.admin_unit_operation
FOR EACH ROW EXECUTE FUNCTION public.admin_unit_operation_immutable_v1();
CREATE TRIGGER auno_immutable_truncate BEFORE TRUNCATE ON public.admin_unit_operation
FOR EACH STATEMENT EXECUTE FUNCTION public.admin_unit_operation_immutable_v1();
REVOKE ALL ON TABLE public.admin_unit_operation FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_unit_operation_immutable_v1() FROM PUBLIC;
`;
const receiptColumns = [[1, 'operation_id', 'uuid', true, null], [2, 'actor_id', 'integer', true, null],
  [3, 'operation', 'character varying(16)', true, '"default"'], [4, 'target_id', 'integer', true, null],
  [5, 'payload_hash', 'character varying(64)', true, '"default"'], [6, 'revision', 'character varying(64)', true, '"default"'],
  [7, 'state', 'character varying(16)', true, '"default"'], [8, 'result', 'jsonb', true, null], [9, 'created_at', 'bigint', true, null]];
export const ADMIN_UNIT_OPERATION_EXPECTED_CONSTRAINTS: Record<string, string> = {
  auno_pk: 'PRIMARY KEY (operation_id)',
  auno_id_ck: "CHECK (((operation_id)::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'::text))",
  auno_actor_ck: 'CHECK ((actor_id > 0))',
  auno_operation_ck: "CHECK (((operation)::text = ANY ((ARRAY['create'::character varying, 'update'::character varying, 'delete'::character varying])::text[])))",
  auno_target_ck: 'CHECK ((target_id >= 0))',
  auno_payload_hash_ck: "CHECK (((payload_hash)::text ~ '^[a-f0-9]{64}$'::text))",
  auno_revision_ck: "CHECK (((revision)::text ~ '^[a-f0-9]{64}$'::text))",
  auno_state_ck: "CHECK (((state)::text = ANY ((ARRAY['committed'::character varying, 'not_applied'::character varying])::text[])))",
  auno_result_ck: "CHECK ((jsonb_typeof(result) = 'object'::text))",
  auno_created_ck: 'CHECK ((created_at > 0))',
};

/** Exact schema, immutable trigger/function, maintenance owner and sole
 * SELECT/INSERT grantee. This does not establish a live HTTP actor. */
export async function inspectAdminUnitOperation(tx: Query, names?: { maintenance: string; admin: string }): Promise<boolean> {
  const [row] = await tx.execute(sql`SELECT
    c.relkind='r' AND c.relpersistence='p' AND NOT c.relispartition AND NOT c.relrowsecurity AND NOT c.relforcerowsecurity
    AND c.relnatts=9 AND c.relchecks=9 AND c.reloptions IS NULL AND c.relreplident='d'
    AND c.relam=(SELECT oid FROM pg_catalog.pg_am WHERE amname='heap')
    AND EXISTS(SELECT 1 FROM pg_catalog.pg_roles r WHERE r.oid=c.relowner AND r.rolsuper
      AND (${names?.maintenance ?? null}::text IS NULL OR r.rolname=${names?.maintenance ?? null}::text))
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_inherits WHERE inhrelid=c.oid OR inhparent=c.oid)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_rewrite WHERE ev_class=c.oid)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_policy WHERE polrelid=c.oid)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_constraint WHERE confrelid=c.oid)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid=c.oid AND contype NOT IN ('p','c','n'))
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_attribute WHERE attrelid=c.oid AND attnum>0
      AND (attisdropped OR atthasdef OR attidentity<>'' OR attgenerated<>'')) AS safe,
    (SELECT jsonb_agg(jsonb_build_array(attnum,attname,format_type(atttypid,atttypmod),attnotnull,
      CASE WHEN attcollation=0 THEN NULL ELSE attcollation::regcollation::text END) ORDER BY attnum)
      FROM pg_catalog.pg_attribute WHERE attrelid=c.oid AND attnum>0) AS columns,
    (SELECT count(*)=10 AND bool_and(convalidated AND NOT condeferrable AND NOT condeferred AND conislocal
      AND coninhcount=0 AND conparentid=0) FROM pg_catalog.pg_constraint WHERE conrelid=c.oid AND contype IN ('p','c')) AS constraint_count,
    (SELECT jsonb_object_agg(conname,pg_get_constraintdef(oid,false)) FROM pg_catalog.pg_constraint WHERE conrelid=c.oid AND contype IN ('p','c')) AS constraints,
    (SELECT count(*)=1 AND bool_and(indisprimary AND indisunique AND indisvalid AND indisready AND indislive
      AND indimmediate AND NOT indisexclusion AND indkey::text='1' AND indnatts=1 AND indnkeyatts=1
      AND indoption::text='0' AND indcollation::text='0' AND NOT indnullsnotdistinct AND indexprs IS NULL AND indpred IS NULL
      AND indclass::text=(SELECT oid::text FROM pg_catalog.pg_opclass WHERE opcname='uuid_ops' AND opcnamespace='pg_catalog'::regnamespace AND opcmethod=(SELECT oid FROM pg_catalog.pg_am WHERE amname='btree'))
      AND EXISTS(SELECT 1 FROM pg_catalog.pg_class i WHERE i.oid=indexrelid AND i.relkind='i' AND i.relpersistence='p'
        AND i.reloptions IS NULL AND i.relowner=c.relowner AND i.relam=(SELECT oid FROM pg_catalog.pg_am WHERE amname='btree')))
      FROM pg_catalog.pg_index WHERE indrelid=c.oid) AS indexes,
    (SELECT count(*)=2 AND bool_and(NOT t.tgisinternal AND t.tgenabled='O' AND t.tgnargs=0 AND t.tgqual IS NULL
      AND t.tgconstraint=0 AND t.tgfoid=f.oid AND t.tgattr::text='' AND t.tgoldtable IS NULL AND t.tgnewtable IS NULL
      AND ((t.tgname='auno_immutable_rows' AND t.tgtype=27) OR (t.tgname='auno_immutable_truncate' AND t.tgtype=34)))
      FROM pg_catalog.pg_trigger t WHERE t.tgrelid=c.oid) AS triggers,
    f.proowner=c.relowner AND f.prosrc=${ADMIN_UNIT_OPERATION_IMMUTABLE_BODY} AND f.prorettype='pg_catalog.trigger'::regtype
    AND f.pronargs=0 AND f.proargtypes::text='' AND NOT f.prosecdef AND NOT f.proleakproof AND f.provolatile='v'
    AND f.prokind='f' AND f.proconfig=ARRAY['search_path=pg_catalog'] AND NOT f.proisstrict AND NOT f.proretset
    AND f.proparallel='u' AND f.prosupport=0 AND f.provariadic=0 AND f.pronargdefaults=0 AND f.proargdefaults IS NULL
    AND f.proallargtypes IS NULL AND f.proargmodes IS NULL AND f.proargnames IS NULL AND f.probin IS NULL AND f.prosqlbody IS NULL
    AND f.prolang=(SELECT oid FROM pg_catalog.pg_language WHERE lanname='plpgsql')
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_proc other WHERE other.pronamespace=f.pronamespace AND other.proname=f.proname AND other.oid<>f.oid)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.aclexplode(COALESCE(f.proacl,pg_catalog.acldefault('f',f.proowner))) a
      WHERE a.grantee<>f.proowner) AS function,
    NOT EXISTS(SELECT 1 FROM pg_catalog.aclexplode(COALESCE(c.relacl,pg_catalog.acldefault('r',c.relowner))) a
      WHERE a.grantee<>c.relowner AND (a.grantee=0 OR a.is_grantable OR a.privilege_type NOT IN ('SELECT','INSERT')
        OR (${names?.admin ?? null}::text IS NOT NULL AND a.grantee<>(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=${names?.admin ?? null}::text))))
    AND (SELECT count(DISTINCT a.grantee)<=1 FROM pg_catalog.aclexplode(COALESCE(c.relacl,pg_catalog.acldefault('r',c.relowner))) a WHERE a.grantee<>c.relowner)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_attribute col CROSS JOIN LATERAL pg_catalog.aclexplode(col.attacl) a
      WHERE col.attrelid=c.oid AND a.grantee<>c.relowner)
    AND (${names?.admin ?? null}::text IS NULL OR
      (EXISTS(SELECT 1 FROM pg_catalog.aclexplode(COALESCE(c.relacl,pg_catalog.acldefault('r',c.relowner))) a
        WHERE a.grantee=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=${names?.admin ?? null}::text) AND a.privilege_type='SELECT')
      AND EXISTS(SELECT 1 FROM pg_catalog.aclexplode(COALESCE(c.relacl,pg_catalog.acldefault('r',c.relowner))) a
        WHERE a.grantee=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=${names?.admin ?? null}::text) AND a.privilege_type='INSERT'))) AS acl
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_proc f ON f.oid=to_regprocedure('public.admin_unit_operation_immutable_v1()')
    WHERE c.oid=to_regclass('public.admin_unit_operation')`);
  if (!row || ['safe', 'constraint_count', 'indexes', 'triggers', 'function', 'acl'].some(key => row[key] !== true)) return false;
  if (JSON.stringify(row.columns) !== JSON.stringify(receiptColumns)) return false;
  const actual = row.constraints as Record<string, string> | undefined;
  return !!actual && Object.keys(actual).length === Object.keys(ADMIN_UNIT_OPERATION_EXPECTED_CONSTRAINTS).length
    && Object.entries(ADMIN_UNIT_OPERATION_EXPECTED_CONSTRAINTS).every(([key, value]) => actual[key] === value);
}

/** Caller-owned transaction only: the shared gate survives through the same
 * business commit. Runtime must be a real restricted LOGIN, never an owner,
 * inherited role or maintenance identity. No repair or DDL is performed. */
export async function assertAdminUnitOperationReady(tx: Query): Promise<void> {
  try {
    if (Object.hasOwn(tx, '$client')) throw Error('Unit readiness requires a caller-owned transaction');
    const [gate] = await tx.execute(sql`SELECT pg_try_advisory_xact_lock_shared(731626,22) AS locked`);
    if (gate?.locked !== true) throw Error('Unit operation maintenance is busy');
    if (!await inspectAdminUnitOperation(tx)) throw Error('Unit operation catalog is absent or drifted');
    const [row] = await tx.execute(sql`SELECT current_user=session_user
      AND r.rolcanlogin AND NOT(r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolinherit OR r.rolreplication OR r.rolbypassrls)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members WHERE member=r.oid OR roleid=r.oid)
      AND NOT pg_catalog.has_database_privilege(r.oid,current_database(),'CREATE')
      AND NOT pg_catalog.has_schema_privilege(r.oid,'public','CREATE')
      AND NOT pg_catalog.has_parameter_privilege(r.oid,'session_replication_role','SET,ALTER SYSTEM')
      AND c.relowner<>r.oid AND pg_catalog.has_table_privilege(r.oid,c.oid,'SELECT')
      AND pg_catalog.has_table_privilege(r.oid,c.oid,'INSERT')
      AND NOT pg_catalog.has_table_privilege(r.oid,c.oid,'UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.aclexplode(COALESCE(c.relacl,pg_catalog.acldefault('r',c.relowner))) a
        WHERE a.grantee<>c.relowner AND a.grantee<>r.oid) AS ready
      FROM pg_catalog.pg_roles r CROSS JOIN pg_catalog.pg_class c
      WHERE r.rolname=current_user AND c.oid=to_regclass('public.admin_unit_operation')`);
    if (row?.ready !== true) throw Error('Unit operation runtime privileges are unsafe');
  } catch (cause) {
    throw Object.assign(new ServiceUnavailableException('商品单位操作回执或运行权限尚未就绪'), { cause });
  }
}
