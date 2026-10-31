import { sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { ServiceUnavailableException } from '@/utils/errors';

type Query = Pick<DbClient, 'execute'>;
export const ADMIN_WECHAT_ROUTINE_OPERATION_RUNTIME_PRIVILEGES = { app: [], admin: ['SELECT'] } as const;
export const ADMIN_WECHAT_ROUTINE_OPERATION_GATE = [731667, 0] as const;
export const ADMIN_WECHAT_ROUTINE_OPERATION_IMMUTABLE_BODY = `BEGIN
  RAISE EXCEPTION 'WechatRoutine operation evidence is immutable' USING ERRCODE='42501';
END`;

/** Explicit maintenance addon only. No foreign key, sequence,
 * expiry, mutable receipt, request-time installation or catalog DML capability. */
export const ADMIN_WECHAT_ROUTINE_OPERATION_SQL = `
CREATE TABLE public.admin_wechat_routine_operation (
  operation_id uuid NOT NULL,
  actor_id integer NOT NULL,
  operation varchar(16) NOT NULL,
  format_version smallint NOT NULL,
  payload_hash varchar(64) NOT NULL,
  revision varchar(64) NOT NULL,
  state varchar(16) NOT NULL,
  result jsonb NOT NULL,
  created_at bigint NOT NULL,
  CONSTRAINT awro_pk PRIMARY KEY(operation_id),
  CONSTRAINT awro_id_ck CHECK(operation_id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  CONSTRAINT awro_actor_ck CHECK(actor_id > 0),
  CONSTRAINT awro_operation_ck CHECK(operation IN ('save','resolve')),
  CONSTRAINT awro_format_ck CHECK(format_version = 1),
  CONSTRAINT awro_payload_hash_ck CHECK(payload_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT awro_revision_ck CHECK(revision ~ '^[a-f0-9]{64}$'),
  CONSTRAINT awro_state_ck CHECK(state IN ('committed','not_applied')),
  CONSTRAINT awro_result_ck CHECK(jsonb_typeof(result)='object'),
  CONSTRAINT awro_created_ck CHECK(created_at > 0)
);
CREATE FUNCTION public.admin_wechat_routine_operation_immutable_v1() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $awro_immutable$${ADMIN_WECHAT_ROUTINE_OPERATION_IMMUTABLE_BODY}$awro_immutable$;
CREATE TRIGGER awro_immutable_rows BEFORE UPDATE OR DELETE ON public.admin_wechat_routine_operation
FOR EACH ROW EXECUTE FUNCTION public.admin_wechat_routine_operation_immutable_v1();
CREATE TRIGGER awro_immutable_truncate BEFORE TRUNCATE ON public.admin_wechat_routine_operation
FOR EACH STATEMENT EXECUTE FUNCTION public.admin_wechat_routine_operation_immutable_v1();
REVOKE ALL ON TABLE public.admin_wechat_routine_operation FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_wechat_routine_operation_immutable_v1() FROM PUBLIC;
`;
const receiptColumns = [[1, 'operation_id', 'uuid', true, null], [2, 'actor_id', 'integer', true, null],
  [3, 'operation', 'character varying(16)', true, '"default"'], [4, 'format_version', 'smallint', true, null],
  [5, 'payload_hash', 'character varying(64)', true, '"default"'], [6, 'revision', 'character varying(64)', true, '"default"'],
  [7, 'state', 'character varying(16)', true, '"default"'], [8, 'result', 'jsonb', true, null], [9, 'created_at', 'bigint', true, null]];
export const ADMIN_WECHAT_ROUTINE_OPERATION_EXPECTED_CONSTRAINTS: Record<string, string> = {
  awro_pk: 'PRIMARY KEY (operation_id)',
  awro_id_ck: "CHECK (((operation_id)::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'::text))",
  awro_actor_ck: 'CHECK ((actor_id > 0))',
  awro_operation_ck: "CHECK (((operation)::text = ANY ((ARRAY['save'::character varying, 'resolve'::character varying])::text[])))",
  awro_format_ck: 'CHECK ((format_version = 1))',
  awro_payload_hash_ck: "CHECK (((payload_hash)::text ~ '^[a-f0-9]{64}$'::text))",
  awro_revision_ck: "CHECK (((revision)::text ~ '^[a-f0-9]{64}$'::text))",
  awro_state_ck: "CHECK (((state)::text = ANY ((ARRAY['committed'::character varying, 'not_applied'::character varying])::text[])))",
  awro_result_ck: "CHECK ((jsonb_typeof(result) = 'object'::text))",
  awro_created_ck: 'CHECK ((created_at > 0))',
};

/** Exact schema and immutable maintenance-owned evidence. With no names this
 * accepts only the owner-only pre-grant state; the installed matrix is exactly
 * Admin SELECT plus the independent writer SELECT/INSERT. Neither proves JWT. */
export async function inspectAdminWechatRoutineOperation(tx: Query, names?: { maintenance: string; admin: string; writer: string }): Promise<boolean> {
  if (names && new Set([names.maintenance, names.admin, names.writer]).size !== 3) return false;
  const expectedAcl = names ? [[names.admin, 'SELECT', false], [names.writer, 'INSERT', false], [names.writer, 'SELECT', false]]
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])) || String(a[1]).localeCompare(String(b[1]))) : [];
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
      AND ((t.tgname='awro_immutable_rows' AND t.tgtype=27) OR (t.tgname='awro_immutable_truncate' AND t.tgtype=34)))
      FROM pg_catalog.pg_trigger t WHERE t.tgrelid=c.oid) AS triggers,
    f.proowner=c.relowner AND f.prosrc=${ADMIN_WECHAT_ROUTINE_OPERATION_IMMUTABLE_BODY} AND f.prorettype='pg_catalog.trigger'::regtype
    AND f.pronargs=0 AND f.proargtypes::text='' AND NOT f.prosecdef AND NOT f.proleakproof AND f.provolatile='v'
    AND f.prokind='f' AND f.proconfig=ARRAY['search_path=pg_catalog'] AND NOT f.proisstrict AND NOT f.proretset
    AND f.proparallel='u' AND f.prosupport=0 AND f.provariadic=0 AND f.pronargdefaults=0 AND f.proargdefaults IS NULL
    AND f.proallargtypes IS NULL AND f.proargmodes IS NULL AND f.proargnames IS NULL AND f.probin IS NULL AND f.prosqlbody IS NULL
    AND f.prolang=(SELECT oid FROM pg_catalog.pg_language WHERE lanname='plpgsql')
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_proc other WHERE other.pronamespace=f.pronamespace AND other.proname=f.proname AND other.oid<>f.oid)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.aclexplode(COALESCE(f.proacl,pg_catalog.acldefault('f',f.proowner))) a
      WHERE a.grantee<>f.proowner) AS function,
    (SELECT COALESCE(jsonb_agg(jsonb_build_array(pg_catalog.pg_get_userbyid(a.grantee),a.privilege_type,a.is_grantable)
      ORDER BY pg_catalog.pg_get_userbyid(a.grantee) COLLATE "C",a.privilege_type COLLATE "C"),'[]'::jsonb)
      FROM pg_catalog.aclexplode(COALESCE(c.relacl,pg_catalog.acldefault('r',c.relowner))) a
      WHERE a.grantee<>c.relowner)=${JSON.stringify(expectedAcl)}::jsonb
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_attribute col CROSS JOIN LATERAL pg_catalog.aclexplode(col.attacl) a
      WHERE col.attrelid=c.oid AND a.grantee<>c.relowner) AS acl
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_proc f ON f.oid=to_regprocedure('public.admin_wechat_routine_operation_immutable_v1()')
    WHERE c.oid=to_regclass('public.admin_wechat_routine_operation')`);
  if (!row || ['safe', 'constraint_count', 'indexes', 'triggers', 'function', 'acl'].some(key => row[key] !== true)) return false;
  if (JSON.stringify(row.columns) !== JSON.stringify(receiptColumns)) return false;
  const actual = row.constraints as Record<string, string> | undefined;
  return !!actual && Object.keys(actual).length === Object.keys(ADMIN_WECHAT_ROUTINE_OPERATION_EXPECTED_CONSTRAINTS).length
    && Object.entries(ADMIN_WECHAT_ROUTINE_OPERATION_EXPECTED_CONSTRAINTS).every(([key, value]) => actual[key] === value);
}

/** Caller-owned transaction only: the shared gate survives through the same
 * business commit. Runtime must be a real restricted LOGIN, never an owner,
 * inherited role or maintenance identity. No repair or DDL is performed. */
export async function assertAdminWechatRoutineOperationReady(tx: Query): Promise<void> {
  try {
    if (Object.hasOwn(tx, '$client')) throw Error('WechatRoutine readiness requires a caller-owned transaction');
    const [gate] = await tx.execute(sql`SELECT pg_try_advisory_xact_lock_shared(731667,0) AS locked`);
    if (gate?.locked !== true) throw Error('WechatRoutine operation maintenance is busy');
    // The receipt's SELECT grant alone cannot establish the separate writer,
    // its atomic SQL body or the five-key guard. Inspect their joint catalog.
    const { inspectAdminWechatRoutineWriteCatalog } = await import('./adminWechatRoutineWriteCatalog');
    const state = await inspectAdminWechatRoutineWriteCatalog(tx);
    if (!state.ready || !state.binding) throw Error('WechatRoutine operation catalog is absent or drifted');
    const [row] = await tx.execute(sql`SELECT current_user=session_user
      AND current_user=${state.binding.admin}::name AND r.oid=${state.binding.adminOid}::oid AS ready
      FROM pg_catalog.pg_roles r WHERE r.rolname=current_user`);
    if (row?.ready !== true) throw Error('WechatRoutine operation runtime privileges are unsafe');
  } catch (cause) {
    throw Object.assign(new ServiceUnavailableException('微信小程序配置操作回执或运行权限尚未就绪'), { cause });
  }
}
