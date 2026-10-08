import { sql } from 'drizzle-orm';
import type { DbClient } from '../lib/di';
import { ServiceUnavailableException } from '../utils/errors';

/** Independently commissioned addon; historical whole-shop stages stay fixed. */
export const ADMIN_AUTHORITY_OPERATION_RUNTIME_PRIVILEGES = {
  app: [], admin: ['SELECT','INSERT'],
} as const;
export const ADMIN_AUTHORITY_OPERATION_RUNTIME_FUNCTIONS = {
  app: [], admin: ['admin_authority_menu_lock_v1()'],
} as const;

/** Exact, argument-free lock capability. It has no data reads/writes or dynamic
 * SQL and only operates after the caller holds the two staff table barriers. */
export const ADMIN_AUTHORITY_MENU_LOCK_BODY = `BEGIN
  IF pg_catalog.current_setting('transaction_isolation') <> 'read committed'
    OR pg_catalog.current_setting('transaction_read_only') <> 'off'
    OR pg_catalog.current_setting('session_replication_role') <> 'origin' THEN
    RAISE EXCEPTION 'Admin authority menu lock requires ordinary READ COMMITTED' USING ERRCODE='42501';
  END IF;
  IF (SELECT count(*) FROM pg_catalog.pg_locks WHERE pid=pg_catalog.pg_backend_pid()
    AND relation IN (pg_catalog.to_regclass('public.system_admin'),pg_catalog.to_regclass('public.system_role'))
    AND mode='ShareRowExclusiveLock' AND granted) <> 2 THEN
    RAISE EXCEPTION 'Admin authority staff barriers must precede the menu lock' USING ERRCODE='42501';
  END IF;
  LOCK TABLE ONLY public.system_menus IN SHARE MODE NOWAIT;
END`;

export const ADMIN_AUTHORITY_OPERATION_IMMUTABLE_BODY = `BEGIN
  RAISE EXCEPTION 'Admin authority operation evidence is immutable' USING ERRCODE='42501';
END`;
/** No sequence, FK cascade, expiration, business-row backfill or runtime DDL. */
export const ADMIN_AUTHORITY_OPERATION_SQL = `
CREATE TABLE public.admin_authority_operation (
  operation_id uuid NOT NULL,
  actor_id integer NOT NULL,
  admin_type integer NOT NULL,
  relation_id integer NOT NULL,
  operation varchar(32) NOT NULL,
  request_hash varchar(64) NOT NULL,
  revision varchar(64) NOT NULL,
  state varchar(16) NOT NULL,
  result jsonb,
  created_at integer NOT NULL,
  CONSTRAINT aao_pk PRIMARY KEY (operation_id),
  CONSTRAINT aao_identity_ck CHECK (actor_id > 0 AND admin_type = 1 AND relation_id = 0 AND created_at > 0),
  CONSTRAINT aao_key_ck CHECK (operation_id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  CONSTRAINT aao_operation_ck CHECK (operation IN ('admin-save','role-save','role-delete')),
  CONSTRAINT aao_state_ck CHECK ((
    (state = 'not_applied' AND request_hash = '' AND revision = '' AND result IS NULL) OR
    (state = 'committed' AND request_hash ~ '^[0-9a-f]{64}$' AND revision ~ '^[0-9a-f]{64}$'
      AND result IS NOT NULL AND jsonb_typeof(result) = 'object'
      AND jsonb_typeof(result->'id') = 'number' AND (result->>'id') ~ '^[1-9][0-9]{0,9}$'
      AND (result->>'id')::bigint <= 2147483647
      AND ((operation = 'role-delete' AND result->'deleted' = 'true'::jsonb
        AND result - 'id' - 'deleted' = '{}'::jsonb AND result ? 'deleted') OR
        (operation IN ('admin-save','role-save') AND jsonb_typeof(result->'created') = 'boolean'
          AND result - 'id' - 'created' = '{}'::jsonb AND result ? 'created')))) IS TRUE)
);
CREATE FUNCTION public.admin_authority_operation_immutable_v1() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $aao_immutable$${ADMIN_AUTHORITY_OPERATION_IMMUTABLE_BODY}$aao_immutable$;
REVOKE ALL ON FUNCTION public.admin_authority_operation_immutable_v1() FROM PUBLIC;
CREATE TRIGGER aao_immutable_rows BEFORE UPDATE OR DELETE ON public.admin_authority_operation
FOR EACH ROW EXECUTE FUNCTION public.admin_authority_operation_immutable_v1();
CREATE TRIGGER aao_immutable_truncate BEFORE TRUNCATE ON public.admin_authority_operation
FOR EACH STATEMENT EXECUTE FUNCTION public.admin_authority_operation_immutable_v1();
REVOKE ALL ON TABLE public.admin_authority_operation FROM PUBLIC;
CREATE FUNCTION public.admin_authority_menu_lock_v1() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $aao_menu_lock$${ADMIN_AUTHORITY_MENU_LOCK_BODY}$aao_menu_lock$;
REVOKE ALL ON FUNCTION public.admin_authority_menu_lock_v1() FROM PUBLIC;
`;

const columns = [
  [1,'operation_id','uuid',true],[2,'actor_id','integer',true],[3,'admin_type','integer',true],
  [4,'relation_id','integer',true],[5,'operation','character varying(32)',true],
  [6,'request_hash','character varying(64)',true],[7,'revision','character varying(64)',true],
  [8,'state','character varying(16)',true],[9,'result','jsonb',false],[10,'created_at','integer',true],
];
/** PG16 canonical definitions are checked as part of readiness. */
export const ADMIN_AUTHORITY_OPERATION_EXPECTED_CONSTRAINTS: Record<string,string> = {
  aao_pk: 'PRIMARY KEY (operation_id)',
  aao_identity_ck: 'CHECK (((actor_id > 0) AND (admin_type = 1) AND (relation_id = 0) AND (created_at > 0)))',
  aao_key_ck: "CHECK (((operation_id)::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'::text))",
  aao_operation_ck: "CHECK (((operation)::text = ANY ((ARRAY['admin-save'::character varying, 'role-save'::character varying, 'role-delete'::character varying])::text[])))",
  aao_state_ck: "CHECK ((((((state)::text = 'not_applied'::text) AND ((request_hash)::text = ''::text) AND ((revision)::text = ''::text) AND (result IS NULL)) OR (((state)::text = 'committed'::text) AND ((request_hash)::text ~ '^[0-9a-f]{64}$'::text) AND ((revision)::text ~ '^[0-9a-f]{64}$'::text) AND (result IS NOT NULL) AND (jsonb_typeof(result) = 'object'::text) AND (jsonb_typeof((result -> 'id'::text)) = 'number'::text) AND ((result ->> 'id'::text) ~ '^[1-9][0-9]{0,9}$'::text) AND (((result ->> 'id'::text))::bigint <= 2147483647) AND ((((operation)::text = 'role-delete'::text) AND ((result -> 'deleted'::text) = 'true'::jsonb) AND (((result - 'id'::text) - 'deleted'::text) = '{}'::jsonb) AND (result ? 'deleted'::text)) OR (((operation)::text = ANY ((ARRAY['admin-save'::character varying, 'role-save'::character varying])::text[])) AND (jsonb_typeof((result -> 'created'::text)) = 'boolean'::text) AND (((result - 'id'::text) - 'created'::text) = '{}'::jsonb) AND (result ? 'created'::text))))) IS TRUE))",
};

export async function inspectAdminAuthorityOperation(tx: Pick<DbClient,'execute'>,names?: { maintenance:string; admin:string }): Promise<boolean> {
  const [row] = await tx.execute(sql`SELECT
    c.relkind='r' AND c.relpersistence='p' AND NOT c.relispartition AND NOT c.relrowsecurity AND NOT c.relforcerowsecurity
    AND c.relnatts=10 AND c.relchecks=4 AND c.reloptions IS NULL AND c.relreplident='d'
    AND c.relam=(SELECT oid FROM pg_catalog.pg_am WHERE amname='heap')
    AND EXISTS(SELECT 1 FROM pg_catalog.pg_roles owner WHERE owner.oid=c.relowner AND owner.rolsuper
      AND (${names?.maintenance ?? null}::text IS NULL OR owner.rolname=${names?.maintenance ?? null}::text))
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_inherits WHERE inhrelid=c.oid OR inhparent=c.oid)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_rewrite WHERE ev_class=c.oid)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_policy WHERE polrelid=c.oid)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_constraint WHERE confrelid=c.oid)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid=c.oid AND contype NOT IN ('p','c','n'))
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_attribute WHERE attrelid=c.oid AND attnum>0 AND (attisdropped OR atthasdef OR attidentity<>'' OR attgenerated<>''))
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.aclexplode(COALESCE(c.relacl,pg_catalog.acldefault('r',c.relowner))) a
      WHERE a.grantee<>c.relowner AND (a.grantee=0 OR a.is_grantable OR a.privilege_type NOT IN ('SELECT','INSERT')))
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_attribute col CROSS JOIN LATERAL pg_catalog.aclexplode(col.attacl) a
      WHERE col.attrelid=c.oid AND a.grantee<>c.relowner) AS safe,
    (${names?.admin ?? null}::text IS NULL OR
      (NOT EXISTS(SELECT 1 FROM pg_catalog.aclexplode(COALESCE(c.relacl,pg_catalog.acldefault('r',c.relowner))) a
        WHERE a.grantee<>c.relowner AND a.grantee<>(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=${names?.admin ?? null}::text))
       AND EXISTS(SELECT 1 FROM pg_catalog.aclexplode(COALESCE(c.relacl,pg_catalog.acldefault('r',c.relowner))) a
         WHERE a.grantee=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=${names?.admin ?? null}::text) AND a.privilege_type='SELECT')
       AND EXISTS(SELECT 1 FROM pg_catalog.aclexplode(COALESCE(c.relacl,pg_catalog.acldefault('r',c.relowner))) a
         WHERE a.grantee=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=${names?.admin ?? null}::text) AND a.privilege_type='INSERT'))) AS commissioned_acl,
    (SELECT jsonb_agg(jsonb_build_array(attnum,attname,format_type(atttypid,atttypmod),attnotnull) ORDER BY attnum)
      FROM pg_catalog.pg_attribute WHERE attrelid=c.oid AND attnum>0 AND NOT attisdropped) AS columns,
    (SELECT jsonb_object_agg(conname,pg_get_constraintdef(oid,false)) FROM pg_catalog.pg_constraint WHERE conrelid=c.oid AND contype IN ('p','c')
      AND convalidated AND NOT condeferrable AND NOT condeferred AND conislocal AND coninhcount=0 AND conparentid=0) AS constraints,
    (SELECT count(*)=1 AND bool_and(indisprimary AND indisunique AND indisvalid AND indisready AND indislive
      AND indimmediate AND NOT indisexclusion AND indkey::text='1' AND indnatts=1 AND indnkeyatts=1
      AND indoption::text='0' AND NOT indnullsnotdistinct AND indexprs IS NULL AND indpred IS NULL)
      FROM pg_catalog.pg_index WHERE indrelid=c.oid) AS indexes,
    (SELECT count(*)=2 AND bool_and(NOT t.tgisinternal AND t.tgenabled='O' AND t.tgnargs=0 AND t.tgqual IS NULL
      AND t.tgconstraint=0 AND t.tgfoid=f.oid AND t.tgattr::text='' AND t.tgoldtable IS NULL AND t.tgnewtable IS NULL AND
      ((t.tgname='aao_immutable_rows' AND t.tgtype=27) OR (t.tgname='aao_immutable_truncate' AND t.tgtype=34)))
      FROM pg_catalog.pg_trigger t WHERE t.tgrelid=c.oid) AS triggers,
    f.proowner=c.relowner AND f.prosrc=${ADMIN_AUTHORITY_OPERATION_IMMUTABLE_BODY} AND f.prorettype='pg_catalog.trigger'::regtype
    AND f.pronargs=0 AND NOT f.prosecdef AND NOT f.proleakproof AND f.provolatile='v'
    AND f.prokind='f' AND f.proconfig=ARRAY['search_path=pg_catalog']
    AND f.prolang=(SELECT oid FROM pg_catalog.pg_language WHERE lanname='plpgsql')
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.aclexplode(COALESCE(f.proacl,pg_catalog.acldefault('f',f.proowner))) a
      WHERE a.grantee<>f.proowner) AS function
  FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace AND n.nspname='public'
  JOIN pg_catalog.pg_proc f ON f.oid=to_regprocedure('public.admin_authority_operation_immutable_v1()')
  WHERE c.oid=to_regclass('public.admin_authority_operation')`);
  if (!row || row.safe !== true || row.commissioned_acl !== true || row.indexes !== true || row.triggers !== true || row.function !== true) return false;
  if (JSON.stringify(row.columns) !== JSON.stringify(columns)) return false;
  const actual = row.constraints as Record<string,string>;
  return !!actual && Object.keys(actual).length===5 && Object.entries(ADMIN_AUTHORITY_OPERATION_EXPECTED_CONSTRAINTS)
    .every(([name,definition]) => actual[name] === definition);
}

/** Runtime assertion only: a missing or altered catalog fails before DML. */
export async function assertAdminAuthorityOperationReady(tx: Pick<DbClient,'execute'>): Promise<void> {
  if (!(await inspectAdminAuthorityOperation(tx))) throw new ServiceUnavailableException('权限操作回执结构尚未就绪');
  const [privileges] = await tx.execute(sql`SELECT has_table_privilege(current_user,c.oid,'SELECT')
    AND has_table_privilege(current_user,c.oid,'INSERT')
    AND (c.relowner=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=current_user) OR
      (NOT has_table_privilege(current_user,c.oid,'UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
       AND NOT EXISTS(SELECT 1 FROM pg_catalog.aclexplode(COALESCE(c.relacl,pg_catalog.acldefault('r',c.relowner))) a
         WHERE a.grantee<>c.relowner AND a.grantee<>(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=current_user)))) AS ready
    FROM pg_catalog.pg_class c WHERE c.oid=to_regclass('public.admin_authority_operation')`);
  if (privileges?.ready !== true) throw new ServiceUnavailableException('权限操作回执权限尚未就绪');
}

export async function inspectAdminAuthorityMenuLock(tx: Pick<DbClient,'execute'>,names?: { maintenance:string; admin:string }): Promise<boolean> {
  const [row]=await tx.execute(sql`SELECT f.prosrc=${ADMIN_AUTHORITY_MENU_LOCK_BODY} AND f.prosecdef
    AND f.prorettype='pg_catalog.void'::regtype AND f.pronargs=0 AND f.proargtypes::text=''
    AND f.proargmodes IS NULL AND f.proargnames IS NULL AND f.pronargdefaults=0
    AND f.prokind='f' AND NOT f.proleakproof AND NOT f.proisstrict AND f.provolatile='v'
    AND f.proparallel='u' AND f.proconfig=ARRAY['search_path=pg_catalog']
    AND f.prolang=(SELECT oid FROM pg_catalog.pg_language WHERE lanname='plpgsql')
    AND f.proowner=c.relowner
    AND EXISTS(SELECT 1 FROM pg_catalog.pg_roles owner WHERE owner.oid=f.proowner AND owner.rolsuper
      AND (${names?.maintenance ?? null}::text IS NULL OR owner.rolname=${names?.maintenance ?? null}::text))
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.aclexplode(COALESCE(f.proacl,pg_catalog.acldefault('f',f.proowner))) a
      WHERE a.grantee<>f.proowner AND (a.grantee=0 OR a.is_grantable OR a.privilege_type<>'EXECUTE'
        OR (${names?.admin ?? null}::text IS NOT NULL AND a.grantee<>(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=${names?.admin ?? null}::text))
        OR NOT EXISTS(SELECT 1 FROM pg_catalog.aclexplode(COALESCE(c.relacl,pg_catalog.acldefault('r',c.relowner))) receipt_acl
          WHERE receipt_acl.grantee=a.grantee AND receipt_acl.privilege_type='INSERT')))
    AND (${names?.admin ?? null}::text IS NULL OR EXISTS(SELECT 1 FROM pg_catalog.aclexplode(COALESCE(f.proacl,pg_catalog.acldefault('f',f.proowner))) a
      WHERE a.grantee=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=${names?.admin ?? null}::text) AND a.privilege_type='EXECUTE')) AS ready
    FROM pg_catalog.pg_proc f JOIN pg_catalog.pg_class c ON c.oid=to_regclass('public.admin_authority_operation')
    WHERE f.oid=to_regprocedure('public.admin_authority_menu_lock_v1()')`);
  return row?.ready===true;
}

/** Request transaction only. No DDL/grants or caller-provided object names. */
export async function acquireAdminAuthorityMenuLock(tx: Pick<DbClient,'execute'>):Promise<void> {
  if (!(await inspectAdminAuthorityMenuLock(tx))) throw new ServiceUnavailableException('权限目录锁结构尚未就绪');
  const [privilege]=await tx.execute(sql`SELECT has_function_privilege(current_user,'public.admin_authority_menu_lock_v1()','EXECUTE') AS ready`);
  if (privilege?.ready!==true) throw new ServiceUnavailableException('权限目录锁授权尚未就绪');
  await tx.execute(sql`SELECT public.admin_authority_menu_lock_v1()`);
}

/** Explicit owner-maintenance transaction; never called by request/startup. */
export async function installAdminAuthorityOperation(tx: Pick<DbClient,'execute'>): Promise<void> {
  if (Object.hasOwn(tx,'$client')) throw Error('Authority receipt installation requires an existing maintenance transaction');
  const [gate] = await tx.execute(sql`SELECT current_setting('server_version_num')::integer/10000=16
    AND current_setting('transaction_isolation')='read committed' AND NOT current_setting('transaction_read_only')::boolean
    AND current_setting('session_replication_role')='origin' AND current_schema()='public'
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_event_trigger WHERE evtenabled<>'D')
    AND EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=current_user AND rolsuper)
    AND current_user=session_user AND pg_try_advisory_xact_lock(731626,8) AS supported,
    to_regclass('public.admin_authority_operation') IS NOT NULL AS present,
    (to_regprocedure('public.admin_authority_operation_immutable_v1()') IS NOT NULL
      OR to_regprocedure('public.admin_authority_menu_lock_v1()') IS NOT NULL) AS function_present,
    (SELECT relowner=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=current_user) FROM pg_catalog.pg_class
      WHERE oid=to_regclass('public.admin_authority_operation')) AS owned`);
  if (gate?.supported !== true) throw Error('Authority receipt installation requires explicit PG16 owner maintenance');
  if (gate.present === true) {
    if (gate.owned!==true) throw Error('Authority receipt owner does not match this maintenance identity');
    if (!(await inspectAdminAuthorityOperation(tx)) || !(await inspectAdminAuthorityMenuLock(tx))) throw Error('Authority receipt catalog drift requires review');
    await tx.execute(sql.raw('LOCK TABLE ONLY public.admin_authority_operation IN ACCESS EXCLUSIVE MODE NOWAIT'));
  } else {
    if (gate.function_present === true) throw Error('Authority receipt function already exists without its table');
    await tx.execute(sql.raw(ADMIN_AUTHORITY_OPERATION_SQL));
    const [acl]=await tx.execute(sql`SELECT NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class c
      CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(c.relacl,pg_catalog.acldefault('r',c.relowner))) a
      WHERE c.oid=to_regclass('public.admin_authority_operation') AND a.grantee<>c.relowner) AS safe`);
    if (acl?.safe!==true) throw Error('Authority receipt installation inherited an unreviewed default grant');
  }
  if (!(await inspectAdminAuthorityOperation(tx)) || !(await inspectAdminAuthorityMenuLock(tx))) throw Error('Authority receipt installed catalog verification failed');
}
