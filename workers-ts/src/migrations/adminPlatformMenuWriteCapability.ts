import { sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { ServiceUnavailableException } from '@/utils/errors';
import { pricingIdentifier } from './checkoutPricingLockCatalog';
import { inspectRuntimeAdminBoundary } from './runtimeAdminBoundary';
import { captureCashierRuntimeConditionalBinding, type CashierRuntimeConditionalBinding } from './cashierRuntimeConditionalBinding';

type Query = Pick<DbClient, 'execute'>;
export const ADMIN_PLATFORM_MENU_WRITE_FUNCTION = 'cinashop_admin_platform_menu_write_v1';
export const ADMIN_PLATFORM_MENU_WRITE_SIGNATURE = `public.${ADMIN_PLATFORM_MENU_WRITE_FUNCTION}(text,integer,text,jsonb)`;
export const ADMIN_PLATFORM_MENU_OPERATION_RUNTIME_PRIVILEGES = { app: [], admin: ['SELECT', 'INSERT'] } as const;
export interface AdminPlatformMenuWriteTarget { database: string; app: string; admin: string; maintenance: string; owner: string }
export const ADMIN_PLATFORM_MENU_OPERATION_IMMUTABLE_BODY = `BEGIN
  RAISE EXCEPTION 'Platform menu operation evidence is immutable' USING ERRCODE='42501';
END`;

/** Explicit addon SQL only: a request never creates tables, repairs grants, or
 * reuses the old authority operation table's immutable operation namespace. */
export const ADMIN_PLATFORM_MENU_OPERATION_SQL = `
CREATE TABLE public.admin_platform_menu_operation (
  request_id uuid NOT NULL,
  actor_id integer NOT NULL,
  operation varchar(16) NOT NULL,
  menu_id integer NOT NULL,
  payload_hash varchar(64) NOT NULL,
  revision varchar(64) NOT NULL,
  created_at bigint NOT NULL,
  CONSTRAINT apmo_pk PRIMARY KEY(request_id),
  CONSTRAINT apmo_request_ck CHECK(request_id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  CONSTRAINT apmo_actor_ck CHECK(actor_id > 0),
  CONSTRAINT apmo_operation_ck CHECK(operation IN ('create','update','show','delete')),
  CONSTRAINT apmo_menu_ck CHECK(menu_id > 0),
  CONSTRAINT apmo_payload_ck CHECK(payload_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT apmo_revision_ck CHECK(revision ~ '^[a-f0-9]{64}$'),
  CONSTRAINT apmo_created_ck CHECK(created_at > 0)
);
CREATE FUNCTION public.admin_platform_menu_operation_immutable_v1() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $apmo_immutable$${ADMIN_PLATFORM_MENU_OPERATION_IMMUTABLE_BODY}$apmo_immutable$;
CREATE TRIGGER apmo_immutable_rows BEFORE UPDATE OR DELETE ON public.admin_platform_menu_operation
FOR EACH ROW EXECUTE FUNCTION public.admin_platform_menu_operation_immutable_v1();
CREATE TRIGGER apmo_immutable_truncate BEFORE TRUNCATE ON public.admin_platform_menu_operation
FOR EACH STATEMENT EXECUTE FUNCTION public.admin_platform_menu_operation_immutable_v1();
REVOKE ALL ON TABLE public.admin_platform_menu_operation FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_platform_menu_operation_immutable_v1() FROM PUBLIC;
`;

/** Fixed type-1 capability. The reviewed Admin LOGIN may call only after the
 * ordinary staff/role barriers and menu SHARE lock used by role writers.
 * Core service validation additionally restricts route tuples to its real
 * registered catalog and verifies the live actor before calling this body. */
export function adminPlatformMenuWriteBody(adminRole: string): string {
  pricingIdentifier(adminRole);
  return `
DECLARE
  old public.system_menus%ROWTYPE;
  parent public.system_menus%ROWTYPE;
  new_pid integer;
  new_auth_type integer;
  new_name text;
  new_menu_path text;
  new_unique text;
  new_api text;
  new_methods text;
  new_icon text;
  new_sort integer;
  new_show integer;
  new_hidden integer;
  result_id integer;
  cursor_id integer;
  ancestry integer[] := ARRAY[]::integer[];
  derived_path text := '';
  referenced boolean;
  role_rows bigint;
  role_bytes numeric;
  subtree_bad boolean;
BEGIN
  IF session_user <> '${adminRole}'
    OR pg_catalog.current_setting('transaction_isolation') <> 'read committed'
    OR pg_catalog.current_setting('transaction_read_only') <> 'off'
    OR pg_catalog.current_setting('session_replication_role') <> 'origin' THEN
    RAISE EXCEPTION 'Platform menu writes require the reviewed ordinary Admin LOGIN' USING ERRCODE='42501';
  END IF;
  IF (SELECT count(*) FROM pg_catalog.pg_locks WHERE pid=pg_catalog.pg_backend_pid()
      AND relation IN ('public.system_admin'::regclass,'public.system_role'::regclass)
      AND mode='ShareRowExclusiveLock' AND granted) <> 2
    OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_locks WHERE pid=pg_catalog.pg_backend_pid()
      AND relation='public.system_menus'::regclass AND mode IN ('ShareLock','ShareRowExclusiveLock') AND granted) THEN
    RAISE EXCEPTION 'Platform menu writes require staff then role then menu locks' USING ERRCODE='42501';
  END IF;
  LOCK TABLE ONLY public.system_menus IN SHARE ROW EXCLUSIVE MODE NOWAIT;
  IF p_operation IS NULL OR p_operation NOT IN ('create','update','show','delete')
    OR pg_catalog.jsonb_typeof(p_payload) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'Invalid platform menu operation' USING ERRCODE='23514';
  END IF;
  SELECT count(*),coalesce(sum(pg_catalog.octet_length(rules)),0) INTO role_rows,role_bytes FROM public.system_role;
  IF role_rows>10000 OR role_bytes>4194304 THEN
    RAISE EXCEPTION 'Complete role reference catalog exceeds the reviewed budget' USING ERRCODE='54000';
  END IF;
  IF p_operation='create' THEN
    IF p_menu_id IS DISTINCT FROM 0 OR p_expected_xmin IS NOT NULL THEN
      RAISE EXCEPTION 'Create cannot select or revive an explicit menu ID' USING ERRCODE='23514';
    END IF;
    IF (SELECT count(*) FROM public.system_menus WHERE type=1 AND is_del=0)>=5000 THEN
      RAISE EXCEPTION 'Platform menu catalog is full' USING ERRCODE='54000';
    END IF;
  ELSE
    IF p_menu_id IS NULL OR p_menu_id<=0 OR p_expected_xmin IS NULL OR p_expected_xmin !~ '^[0-9]{1,10}$' THEN
      RAISE EXCEPTION 'Menu ID and row revision are required' USING ERRCODE='23514';
    END IF;
    SELECT * INTO old FROM public.system_menus WHERE id=p_menu_id FOR UPDATE;
    IF NOT FOUND OR old.type<>1 OR old.is_del<>0 THEN
      RAISE EXCEPTION 'Platform menu not found' USING ERRCODE='P0002';
    END IF;
    IF (SELECT xmin::text FROM public.system_menus WHERE id=p_menu_id) IS DISTINCT FROM p_expected_xmin THEN
      RAISE EXCEPTION 'Platform menu changed' USING ERRCODE='40001';
    END IF;
  END IF;
  -- Every role is checked, including inactive, unassigned and cross-scope bad
  -- references. Leading-zero numeric strings conservatively count too; they
  -- are not claimed to be effective grants in the current TS resolver.
  SELECT EXISTS(SELECT 1 FROM public.system_role r
    CROSS JOIN LATERAL pg_catalog.unnest(pg_catalog.string_to_array(r.rules,',')) AS token(value)
    WHERE pg_catalog.btrim(token.value) ~ '^[0-9]+$'
      AND pg_catalog.ltrim(pg_catalog.btrim(token.value),'0')=p_menu_id::text) INTO referenced;

  IF p_operation IN ('create','update') THEN
    IF (SELECT count(*) FROM pg_catalog.jsonb_object_keys(p_payload))<>11
      OR NOT p_payload ?& ARRAY['pid','auth_type','menu_name','menu_path','unique_auth','api_url','methods','icon','sort','is_show','is_show_path'] THEN
      RAISE EXCEPTION 'Platform menu payload has unsupported fields' USING ERRCODE='23514';
    END IF;
    IF EXISTS(SELECT 1 FROM pg_catalog.unnest(ARRAY['pid','auth_type','sort','is_show','is_show_path']) AS k(field)
      WHERE pg_catalog.jsonb_typeof(p_payload->k.field) IS DISTINCT FROM 'number' OR (p_payload->>k.field) !~ '^-?(0|[1-9][0-9]{0,9})$')
      OR EXISTS(SELECT 1 FROM pg_catalog.unnest(ARRAY['menu_name','menu_path','unique_auth','api_url','methods','icon']) AS k(field)
      WHERE pg_catalog.jsonb_typeof(p_payload->k.field) IS DISTINCT FROM 'string' OR (p_payload->>k.field) ~ '[[:cntrl:]]') THEN
      RAISE EXCEPTION 'Platform menu fields have invalid types' USING ERRCODE='23514';
    END IF;
    new_pid:=(p_payload->>'pid')::integer; new_auth_type:=(p_payload->>'auth_type')::integer;
    new_name:=p_payload->>'menu_name'; new_menu_path:=p_payload->>'menu_path'; new_unique:=p_payload->>'unique_auth';
    new_api:=p_payload->>'api_url'; new_methods:=p_payload->>'methods'; new_icon:=p_payload->>'icon';
    new_sort:=(p_payload->>'sort')::integer; new_show:=(p_payload->>'is_show')::integer; new_hidden:=(p_payload->>'is_show_path')::integer;
    IF new_pid<0 OR (new_auth_type NOT IN (1,2) AND (p_operation='create' OR new_auth_type IS DISTINCT FROM old.auth_type))
      OR (new_sort<0 AND (p_operation='create' OR new_sort IS DISTINCT FROM old.sort))
      OR new_show NOT IN (0,1) OR new_hidden NOT IN (0,1)
      OR pg_catalog.char_length(new_name) NOT BETWEEN 1 AND 64 OR pg_catalog.btrim(new_name)=''
      OR pg_catalog.char_length(new_menu_path)>255 OR pg_catalog.char_length(new_unique)>150
      OR pg_catalog.char_length(new_api)>255 OR pg_catalog.char_length(new_methods)>32 OR pg_catalog.char_length(new_icon)>50 THEN
      RAISE EXCEPTION 'Platform menu values are outside their reviewed range' USING ERRCODE='23514';
    END IF;
    -- Unchanged old tuples remain editable by name/icon/sort. New or changed
    -- tuples must be local and use one real HTTP method; no normalization
    -- rewrites inactive fields or legacy hidden metadata.
    IF (p_operation='create' OR new_menu_path IS DISTINCT FROM old.menu_path) AND new_menu_path<>''
      AND (new_menu_path !~ '^/[A-Za-z0-9_./:{}-]*$' OR new_menu_path LIKE '//%' OR new_menu_path ~ '(^|/)\\.\\.(/|$)') THEN
      RAISE EXCEPTION 'Platform menu path must be local' USING ERRCODE='23514';
    END IF;
    IF (p_operation='create' OR new_unique IS DISTINCT FROM old.unique_auth) AND new_unique<>'' AND new_unique !~ '^[A-Za-z0-9_.-]+$' THEN
      RAISE EXCEPTION 'Platform menu permission identifier is invalid' USING ERRCODE='23514';
    END IF;
    IF (p_operation='create' OR new_auth_type IS DISTINCT FROM old.auth_type OR new_api IS DISTINCT FROM old.api_url OR new_methods IS DISTINCT FROM old.methods)
      AND new_auth_type=2 AND (new_methods NOT IN ('GET','POST','PUT','DELETE') OR new_api='' OR new_api !~ '^/?[A-Za-z0-9_./:<>{}-]+$'
        OR new_api LIKE '//%' OR new_api ~ '(^|/)\\.\\.(/|$)' OR new_api ~ '://') THEN
      RAISE EXCEPTION 'Changed platform API tuple requires one method and a local path' USING ERRCODE='23514';
    END IF;
    IF (p_operation='create' OR new_auth_type IS DISTINCT FROM old.auth_type OR new_menu_path IS DISTINCT FROM old.menu_path)
      AND new_auth_type=1 AND new_menu_path='' THEN
      RAISE EXCEPTION 'New platform navigation requires a local page path' USING ERRCODE='23514';
    END IF;
    IF (p_operation='create' OR new_auth_type IS DISTINCT FROM old.auth_type) AND new_auth_type=2 THEN new_show:=1; END IF;
    IF referenced AND (new_auth_type IS DISTINCT FROM old.auth_type OR new_methods IS DISTINCT FROM old.methods
      OR new_api IS DISTINCT FROM old.api_url OR new_menu_path IS DISTINCT FROM old.menu_path OR new_unique IS DISTINCT FROM old.unique_auth) THEN
      RAISE EXCEPTION 'Referenced platform permission meaning is immutable' USING ERRCODE='23503';
    END IF;
    IF new_unique<>'' AND (p_operation='create' OR new_unique IS DISTINCT FROM old.unique_auth) AND EXISTS(
      SELECT 1 FROM public.system_menus WHERE type=1 AND is_del=0 AND id<>p_menu_id AND unique_auth=new_unique) THEN
      RAISE EXCEPTION 'Platform permission identifier already exists' USING ERRCODE='23505';
    END IF;
    IF new_auth_type=2 AND (p_operation='create' OR new_auth_type IS DISTINCT FROM old.auth_type OR new_api IS DISTINCT FROM old.api_url OR new_methods IS DISTINCT FROM old.methods)
      AND EXISTS(SELECT 1 FROM public.system_menus WHERE type=1 AND is_del=0 AND id<>p_menu_id
        AND auth_type=2 AND api_url=new_api AND methods=new_methods) THEN
      RAISE EXCEPTION 'Platform API tuple already exists' USING ERRCODE='23505';
    END IF;
    IF p_operation='update' AND old.auth_type=1 AND new_auth_type<>1 AND EXISTS(
      SELECT 1 FROM public.system_menus WHERE pid=p_menu_id AND is_del=0) THEN
      RAISE EXCEPTION 'A parent menu cannot become an API rule' USING ERRCODE='23503';
    END IF;
    -- Historical path text is unchanged on cosmetic edits. Explicit reparenting
    -- validates the complete parent chain and rewrites all descendants or none.
    IF p_operation='create' OR new_pid IS DISTINCT FROM old.pid THEN
      cursor_id:=new_pid;
      WHILE cursor_id>0 LOOP
        IF cursor_id=p_menu_id OR cursor_id=ANY(ancestry) OR pg_catalog.cardinality(ancestry)>=5000 THEN
          RAISE EXCEPTION 'Platform menu parent cycle or capacity' USING ERRCODE='23514';
        END IF;
        SELECT * INTO parent FROM public.system_menus WHERE id=cursor_id FOR SHARE;
        IF NOT FOUND OR parent.type<>1 OR parent.is_del<>0 OR parent.auth_type<>1 THEN
          RAISE EXCEPTION 'Parent must be a live platform menu' USING ERRCODE='23503';
        END IF;
        ancestry:=pg_catalog.array_append(ancestry,cursor_id);
        derived_path:=cursor_id::text || CASE WHEN derived_path='' THEN '' ELSE '/' || derived_path END;
        IF pg_catalog.char_length(derived_path)>255 THEN
          RAISE EXCEPTION 'Complete platform parent path exceeds storage capacity' USING ERRCODE='22001';
        END IF;
        cursor_id:=parent.pid;
      END LOOP;
    ELSE derived_path:=old.path;
    END IF;
    IF p_operation='create' THEN
      INSERT INTO public.system_menus(pid,type,auth_type,menu_name,menu_path,unique_auth,api_url,methods,icon,sort,is_show,is_show_path,access,path,module)
        VALUES(new_pid,1,new_auth_type,new_name,new_menu_path,new_unique,new_api,new_methods,new_icon,new_sort,new_show,new_hidden,1,derived_path,'admin')
        RETURNING id INTO result_id;
      IF EXISTS(SELECT 1 FROM public.system_role r
        CROSS JOIN LATERAL pg_catalog.unnest(pg_catalog.string_to_array(r.rules,',')) AS token(value)
        WHERE pg_catalog.btrim(token.value) ~ '^[0-9]+$' AND pg_catalog.ltrim(pg_catalog.btrim(token.value),'0')=result_id::text) THEN
        -- The whole caller transaction must roll back. The sequence reservation
        -- itself is intentionally not claimed to be transactional in PostgreSQL.
        RAISE EXCEPTION 'Allocated menu ID already has dangling role references' USING ERRCODE='23503';
      END IF;
      RETURN result_id;
    END IF;
    IF new_pid IS DISTINCT FROM old.pid THEN
      WITH RECURSIVE branch(id,type,path,seen,cycle) AS (
        SELECT m.id,m.type,(CASE WHEN derived_path='' THEN p_menu_id::text ELSE derived_path || '/' || p_menu_id END),ARRAY[p_menu_id,m.id],m.id=p_menu_id
          FROM public.system_menus m WHERE m.pid=p_menu_id AND m.is_del=0
        UNION ALL
        SELECT m.id,m.type,b.path || '/' || b.id,pg_catalog.array_append(b.seen,m.id),m.id=ANY(b.seen)
          FROM public.system_menus m JOIN branch b ON m.pid=b.id WHERE m.is_del=0 AND NOT b.cycle AND pg_catalog.cardinality(b.seen)<=5000
      ) SELECT coalesce(bool_or(cycle OR type<>1 OR pg_catalog.char_length(path)>255 OR pg_catalog.cardinality(seen)>5000),false)
        OR count(*)>5000 INTO subtree_bad FROM branch;
      IF subtree_bad THEN RAISE EXCEPTION 'Complete child paths are cyclic, cross-scope or oversized' USING ERRCODE='23503'; END IF;
    END IF;
    UPDATE public.system_menus SET pid=new_pid,auth_type=new_auth_type,menu_name=new_name,menu_path=new_menu_path,
      unique_auth=new_unique,api_url=new_api,methods=new_methods,icon=new_icon,sort=new_sort,is_show=new_show,is_show_path=new_hidden,path=derived_path
      WHERE id=p_menu_id AND type=1 AND is_del=0;
    IF new_pid IS DISTINCT FROM old.pid THEN
      WITH RECURSIVE branch(id,path) AS (
        SELECT m.id,(CASE WHEN derived_path='' THEN p_menu_id::text ELSE derived_path || '/' || p_menu_id END)
          FROM public.system_menus m WHERE m.pid=p_menu_id AND m.type=1 AND m.is_del=0
        UNION ALL SELECT m.id,b.path || '/' || b.id FROM public.system_menus m JOIN branch b ON m.pid=b.id WHERE m.type=1 AND m.is_del=0
      ) UPDATE public.system_menus m SET path=b.path FROM branch b WHERE m.id=b.id;
    END IF;
    RETURN p_menu_id;
  END IF;
  IF p_operation='show' THEN
    IF (SELECT count(*) FROM pg_catalog.jsonb_object_keys(p_payload))<>1 OR NOT p_payload ? 'is_show'
      OR pg_catalog.jsonb_typeof(p_payload->'is_show') IS DISTINCT FROM 'number' OR (p_payload->>'is_show') NOT IN ('0','1')
      OR old.auth_type<>1 THEN RAISE EXCEPTION 'Show requires one navigation flag' USING ERRCODE='23514'; END IF;
    UPDATE public.system_menus SET is_show=(p_payload->>'is_show')::integer WHERE id=p_menu_id AND type=1 AND is_del=0;
    RETURN p_menu_id;
  END IF;
  IF p_payload<>'{}'::jsonb THEN RAISE EXCEPTION 'Delete accepts no fields' USING ERRCODE='23514'; END IF;
  IF referenced OR EXISTS(SELECT 1 FROM public.system_menus WHERE pid=p_menu_id AND is_del=0) THEN
    RAISE EXCEPTION 'Referenced platform menus or parents cannot be deleted' USING ERRCODE='23503';
  END IF;
  -- Permanent soft tombstone: the function never deletes or resurrects IDs.
  UPDATE public.system_menus SET is_del=1 WHERE id=p_menu_id AND type=1 AND is_del=0;
  RETURN p_menu_id;
END
`;
}

const receiptColumns = [[1, 'request_id', 'uuid', true, null], [2, 'actor_id', 'integer', true, null],
  [3, 'operation', 'character varying(16)', true, '"default"'], [4, 'menu_id', 'integer', true, null],
  [5, 'payload_hash', 'character varying(64)', true, '"default"'], [6, 'revision', 'character varying(64)', true, '"default"'], [7, 'created_at', 'bigint', true, null]];
export const ADMIN_PLATFORM_MENU_OPERATION_EXPECTED_CONSTRAINTS: Record<string, string> = {
  apmo_pk: 'PRIMARY KEY (request_id)',
  apmo_request_ck: "CHECK (((request_id)::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'::text))",
  apmo_actor_ck: 'CHECK ((actor_id > 0))',
  apmo_operation_ck: "CHECK (((operation)::text = ANY ((ARRAY['create'::character varying, 'update'::character varying, 'show'::character varying, 'delete'::character varying])::text[])))",
  apmo_menu_ck: 'CHECK ((menu_id > 0))',
  apmo_payload_ck: "CHECK (((payload_hash)::text ~ '^[a-f0-9]{64}$'::text))",
  apmo_revision_ck: "CHECK (((revision)::text ~ '^[a-f0-9]{64}$'::text))",
  apmo_created_ck: 'CHECK ((created_at > 0))',
};

/** Immutable committed receipts have no FK, sequence, cascade or expiry. Exact
 * schema/trigger/function/owner/ACL checks refuse drift, never repair it. */
export async function inspectAdminPlatformMenuOperation(tx: Query, names?: { maintenance: string; admin: string }): Promise<boolean> {
  const [row] = await tx.execute(sql`SELECT
    c.relkind='r' AND c.relpersistence='p' AND NOT c.relispartition AND NOT c.relrowsecurity AND NOT c.relforcerowsecurity
    AND c.relnatts=7 AND c.relchecks=7 AND c.reloptions IS NULL AND c.relreplident='d'
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
    (SELECT count(*)=8 AND bool_and(convalidated AND NOT condeferrable AND NOT condeferred AND conislocal
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
      AND ((t.tgname='apmo_immutable_rows' AND t.tgtype=27) OR (t.tgname='apmo_immutable_truncate' AND t.tgtype=34)))
      FROM pg_catalog.pg_trigger t WHERE t.tgrelid=c.oid) AS triggers,
    f.proowner=c.relowner AND f.prosrc=${ADMIN_PLATFORM_MENU_OPERATION_IMMUTABLE_BODY} AND f.prorettype='pg_catalog.trigger'::regtype
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
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_proc f ON f.oid=to_regprocedure('public.admin_platform_menu_operation_immutable_v1()')
    WHERE c.oid=to_regclass('public.admin_platform_menu_operation')`);
  if (!row || ['safe', 'constraint_count', 'indexes', 'triggers', 'function', 'acl'].some(key => row[key] !== true)) return false;
  if (JSON.stringify(row.columns) !== JSON.stringify(receiptColumns)) return false;
  const actual = row.constraints as Record<string, string> | undefined;
  return !!actual && Object.keys(actual).length === Object.keys(ADMIN_PLATFORM_MENU_OPERATION_EXPECTED_CONSTRAINTS).length
    && Object.entries(ADMIN_PLATFORM_MENU_OPERATION_EXPECTED_CONSTRAINTS).every(([key, value]) => actual[key] === value);
}

export interface AdminPlatformMenuCapabilityState {
  absent: boolean; ready: boolean; functionOid: string | null; definitionSafe: boolean;
  ownerSafe: boolean; aclSafe: boolean; tablesSafe: boolean;
  checks?: Record<string, boolean>;
}

/** The commissioned shop already has one precisely reviewed staff boundary
 * trigger on menus. Never accept arbitrary user triggers, nor mistake that
 * existing original boundary for an unexpected rewrite hook. The complete
 * existing inspector validates its byte-exact body, owner, ACL and all three
 * table triggers; only its static role literal is read to supply that checker. */
async function reviewedPlatformMenuTriggers(db: Query, adminRole: string,
  declared?: { app:string; maintenance:string; cashier:CashierRuntimeConditionalBinding }): Promise<boolean> {
  const [facts] = await db.execute(sql`SELECT count(*)::integer AS count,
    bool_and(tgname='cinashop_runtime_admin_boundary_v1') AS named
    FROM pg_catalog.pg_trigger WHERE tgrelid='public.system_menus'::regclass AND NOT tgisinternal`);
  if (facts?.count === 0) return true;
  if (facts?.count !== 1 || facts.named !== true) return false;
  const [routine] = await db.execute(sql`SELECT p.prosrc,r.rolname AS owner,r.rolsuper
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_roles r ON r.oid=p.proowner
    WHERE p.oid=to_regprocedure('public.cinashop_runtime_admin_boundary_v1()')`);
  let app = declared?.app ?? (typeof routine?.prosrc === 'string' ? /IF current_user = '([a-z_][a-z0-9_]{0,62})' THEN/.exec(routine.prosrc)?.[1] : undefined);
  let conditional = declared;
  // Discovery is only a candidate for this existing staff/menu contract. A
  // complete Cashier grant profile is never inferred here. The exact source,
  // actual principal/database OIDs and all three staff triggers must still
  // prove that the additional branch only constrains the declared principal.
  if (!app && !declared && typeof routine?.prosrc === 'string' && typeof routine.owner === 'string') {
    const principal = /\nBEGIN\n  IF \(current_user = '([a-z_][a-z0-9_]{0,62})' OR \(current_user='([a-z_][a-z0-9_]{0,62})' OR \(SELECT oid FROM pg_catalog\.pg_roles WHERE rolname=current_user\)='([1-9][0-9]*)'::oid\)\) THEN\n/.exec(routine.prosrc);
    const database = /IF current_database\(\)<>'([a-z_][a-z0-9_]{0,62})' OR\n  \(SELECT oid FROM pg_catalog\.pg_database WHERE datname=current_database\(\)\)<>'([1-9][0-9]*)'::oid OR/.exec(routine.prosrc);
    if (principal && database) {
      try {
        const cashier = captureCashierRuntimeConditionalBinding({ role:principal[2], roleOid:principal[3], database:database[1], databaseOid:database[2] });
        app = principal[1]; conditional = { app, maintenance:routine.owner, cashier };
      } catch { return false; }
    }
  }
  if (!app || app === adminRole || routine?.rolsuper !== true || typeof routine.owner !== 'string') return false;
  if (conditional && conditional.maintenance !== routine.owner) return false;
  if (conditional) {
    const b = captureCashierRuntimeConditionalBinding(conditional.cashier);
    if ([app,adminRole,routine.owner].includes(b.role)) return false;
    const [binding] = await db.execute(sql`SELECT current_database()=${b.database}
      AND (SELECT oid::text FROM pg_catalog.pg_database WHERE datname=current_database())=${b.databaseOid}
      AND r.oid::text=${b.roleOid} AND r.rolcanlogin
      AND NOT(r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolinherit OR r.rolreplication OR r.rolbypassrls)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members WHERE member=r.oid OR roleid=r.oid)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_shdepend WHERE refclassid='pg_catalog.pg_authid'::regclass AND refobjid=r.oid AND deptype='o')
      AND NOT pg_catalog.has_database_privilege(r.oid,current_database(),'CREATE')
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_namespace n WHERE n.nspname NOT LIKE 'pg_%' AND pg_catalog.has_schema_privilege(r.oid,n.oid,'CREATE'))
      AND NOT pg_catalog.has_parameter_privilege(r.oid,'session_replication_role','SET,ALTER SYSTEM') AS ready
      FROM pg_catalog.pg_roles r WHERE r.rolname=${b.role}`);
    if (binding?.ready !== true) return false;
  }
  const [role] = await db.execute(sql`SELECT rolcanlogin AND NOT(rolsuper OR rolcreatedb OR rolcreaterole OR rolinherit OR rolreplication OR rolbypassrls)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members WHERE member=r.oid OR roleid=r.oid) AS safe
    FROM pg_catalog.pg_roles r WHERE rolname=${app}`);
  return role?.safe === true && (await inspectRuntimeAdminBoundary(db, app, routine.owner, conditional?.cashier)).ready;
}

export async function inspectAdminPlatformMenuWriteCapability(db: Query, adminRole?: string,
  conditional?: { app:string; maintenance:string; cashier:CashierRuntimeConditionalBinding }): Promise<AdminPlatformMenuCapabilityState> {
  const expectedAdmin = adminRole ?? String((await db.execute(sql`SELECT current_user AS role`))[0]?.role ?? '');
  pricingIdentifier(expectedAdmin);
  const rows = await db.execute(sql`SELECT p.oid::text AS oid,p.prosrc,p.prosecdef,p.provolatile,p.proparallel,p.prokind,
    p.prorettype='pg_catalog.int4'::regtype AS returns_integer,
    p.proargtypes='25 23 25 3802'::oidvector AND p.pronargs=4
      AND p.proargnames=ARRAY['p_operation','p_menu_id','p_expected_xmin','p_payload'] AND p.proargmodes IS NULL AND p.proallargtypes IS NULL AS arguments_safe,
    l.lanname='plpgsql' AND l.lanpltrusted AS language_safe,
    NOT p.proleakproof AND NOT p.proisstrict AND NOT p.proretset AND p.provariadic=0 AND p.pronargdefaults=0
      AND p.proargdefaults IS NULL AND p.prosupport=0 AND p.probin IS NULL AND p.prosqlbody IS NULL
      AND p.procost=100 AND p.prorows=0 AND p.protrftypes IS NULL AS flags_safe,
    p.proconfig,pg_catalog.pg_get_userbyid(p.proowner) AS owner FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_language l ON l.oid=p.prolang WHERE p.pronamespace='public'::regnamespace AND p.proname=${ADMIN_PLATFORM_MENU_WRITE_FUNCTION}`);
  const empty = { absent: rows.length === 0, ready: false, functionOid: null, definitionSafe: false, ownerSafe: false, aclSafe: false, tablesSafe: false };
  if (rows.length !== 1) return empty;
  const row = rows[0], owner = typeof row.owner === 'string' ? row.owner : '';
  const definitionSafe = row.prosrc === adminPlatformMenuWriteBody(expectedAdmin) && row.prosecdef === true
    && row.provolatile === 'v' && row.proparallel === 'u' && row.prokind === 'f'
    && row.returns_integer === true && row.arguments_safe === true && row.language_safe === true && row.flags_safe === true
    && JSON.stringify(row.proconfig) === JSON.stringify(['search_path=pg_catalog, pg_temp']);
  const [catalog] = await db.execute(sql`SELECT
    (SELECT count(*)=2 AND bool_and(a.privilege_type='EXECUTE' AND NOT a.is_grantable
      AND a.grantee IN (SELECT oid FROM pg_catalog.pg_roles WHERE rolname IN (${expectedAdmin},${owner})))
      AND bool_or(a.grantee=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=${expectedAdmin}))
      AND bool_or(a.grantee=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=${owner}))
      FROM pg_catalog.pg_proc p CROSS JOIN LATERAL pg_catalog.aclexplode(p.proacl) a WHERE p.oid=${row.oid}::oid) AS acl,
    (SELECT NOT rolcanlogin AND NOT(rolsuper OR rolcreatedb OR rolcreaterole OR rolinherit OR rolreplication OR rolbypassrls)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members WHERE member=r.oid OR roleid=r.oid)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_namespace WHERE nspowner=r.oid)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class WHERE relowner=r.oid)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_proc p WHERE p.proowner=r.oid AND p.oid<>${row.oid}::oid)
      AND NOT pg_catalog.has_database_privilege(r.oid,current_database(),'CREATE')
      AND NOT pg_catalog.has_schema_privilege(r.oid,'public','CREATE')
      AND NOT pg_catalog.has_parameter_privilege(r.oid,'session_replication_role','SET')
      AND NOT pg_catalog.has_parameter_privilege(r.oid,'session_replication_role','ALTER SYSTEM')
      FROM pg_catalog.pg_roles r WHERE rolname=${owner}) AS owner_role,
    (SELECT count(*)=2 AND bool_and(c.relkind='r' AND c.relpersistence='p' AND NOT c.relispartition
      AND NOT c.relrowsecurity AND NOT c.relforcerowsecurity
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_inherits WHERE inhrelid=c.oid OR inhparent=c.oid)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_rewrite WHERE ev_class=c.oid))
      FROM pg_catalog.pg_class c WHERE c.oid IN ('public.system_menus'::regclass,'public.system_role'::regclass)) AS tables,
    pg_catalog.pg_get_serial_sequence('public.system_menus','id')='public.system_menus_id_seq' AS sequence_shape,
    pg_catalog.has_table_privilege(${owner},'public.system_menus','SELECT') AND pg_catalog.has_table_privilege(${owner},'public.system_menus','INSERT')
      AND pg_catalog.has_table_privilege(${owner},'public.system_menus','UPDATE')
      AND NOT pg_catalog.has_table_privilege(${owner},'public.system_menus','DELETE,TRUNCATE,REFERENCES,TRIGGER')
      AND pg_catalog.has_table_privilege(${owner},'public.system_role','SELECT')
      AND NOT pg_catalog.has_table_privilege(${owner},'public.system_role','INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      AND pg_catalog.has_sequence_privilege(${owner},'public.system_menus_id_seq','USAGE')
      AND NOT pg_catalog.has_sequence_privilege(${owner},'public.system_menus_id_seq','SELECT,UPDATE') AS owner_grants,
    NOT pg_catalog.has_table_privilege(${expectedAdmin},'public.system_menus','INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER')
      AND NOT pg_catalog.has_sequence_privilege(${expectedAdmin},'public.system_menus_id_seq','USAGE,SELECT,UPDATE') AS admin_no_dml,
    NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class c WHERE CASE
      WHEN c.relnamespace='public'::regnamespace AND c.relkind IN ('r','p','v','m','f')
        AND c.oid NOT IN ('public.system_menus'::regclass,'public.system_role'::regclass)
      THEN pg_catalog.has_table_privilege(${owner},c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') ELSE false END)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid=a.attrelid
        WHERE CASE WHEN c.relnamespace='public'::regnamespace AND c.relkind IN ('r','p','v','m','f') AND a.attnum>0 AND NOT a.attisdropped
          THEN (pg_catalog.has_column_privilege(${owner},c.oid,a.attnum,'REFERENCES')
            OR c.oid NOT IN ('public.system_menus'::regclass,'public.system_role'::regclass)
              AND pg_catalog.has_column_privilege(${owner},c.oid,a.attnum,'SELECT,INSERT,UPDATE')
            OR c.oid='public.system_role'::regclass AND pg_catalog.has_column_privilege(${owner},c.oid,a.attnum,'INSERT,UPDATE')) ELSE false END)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class c WHERE CASE WHEN c.relnamespace='public'::regnamespace AND c.relkind='S'
        AND c.oid<>'public.system_menus_id_seq'::regclass THEN pg_catalog.has_sequence_privilege(${owner},c.oid,'USAGE,SELECT,UPDATE') ELSE false END) AS owner_no_other_tables`);
  const ownerSafe = catalog?.owner_role === true && owner !== expectedAdmin;
  const aclSafe = catalog?.acl === true;
  const menuTriggersSafe = await reviewedPlatformMenuTriggers(db, expectedAdmin, conditional);
  const tablesSafe = catalog?.tables === true && catalog?.sequence_shape === true && catalog?.owner_grants === true
    && catalog?.admin_no_dml === true && catalog?.owner_no_other_tables === true && menuTriggersSafe;
  return { absent: false, ready: definitionSafe && ownerSafe && aclSafe && tablesSafe,
    functionOid: typeof row.oid === 'string' ? row.oid : null, definitionSafe, ownerSafe, aclSafe, tablesSafe,
    checks: { tables: catalog?.tables === true, sequence: catalog?.sequence_shape === true, ownerGrants: catalog?.owner_grants === true,
      adminNoDml: catalog?.admin_no_dml === true, ownerNoOtherTables: catalog?.owner_no_other_tables === true, menuTriggersSafe } };
}

export async function assertAdminPlatformMenuWriteReady(tx: Query): Promise<void> {
  try {
    if (!await inspectAdminPlatformMenuOperation(tx) || !(await inspectAdminPlatformMenuWriteCapability(tx)).ready) throw Error('Platform menu addon drift');
    const [row] = await tx.execute(sql`SELECT has_table_privilege(current_user,c.oid,'SELECT')
      AND has_table_privilege(current_user,c.oid,'INSERT')
      AND NOT has_table_privilege(current_user,c.oid,'UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.aclexplode(COALESCE(c.relacl,pg_catalog.acldefault('r',c.relowner))) a
        WHERE a.grantee<>c.relowner AND a.grantee<>(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=current_user)) AS ready
      FROM pg_catalog.pg_class c WHERE c.oid=to_regclass('public.admin_platform_menu_operation')`);
    if (row?.ready !== true) throw Error('Platform menu receipt runtime ACL drift');
  } catch (cause) { throw Object.assign(new ServiceUnavailableException('平台权限规则写入或回执能力尚未就绪'), { cause }); }
}

/** Definition builder is exported for isolated SQL fixtures. It does not grant
 * privileges or run installation; production uses the explicit PG16 upgrade. */
export function adminPlatformMenuWriteDefinition(adminRole: string): string {
  return `CREATE FUNCTION public.${ADMIN_PLATFORM_MENU_WRITE_FUNCTION}(p_operation text,p_menu_id integer,p_expected_xmin text,p_payload jsonb)
    RETURNS integer LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog,pg_temp
    AS $platform_menu_write$${adminPlatformMenuWriteBody(adminRole)}$platform_menu_write$`;
}

/** Low-level addon installation in an existing maintenance transaction. No
 * legacy type-4 capability, business rows, sequence values or old receipt
 * schema are altered. Existing partial objects and privilege drift refuse. */
export async function installAdminPlatformMenuWriteCapabilityInTransaction(tx: Query, target: AdminPlatformMenuWriteTarget): Promise<{ applied: boolean; ready: true }> {
  if (Object.hasOwn(tx, '$client')) throw Error('Platform menu installation requires an existing transaction');
  Object.values(target).forEach(pricingIdentifier);
  if (new Set([target.app, target.admin, target.maintenance, target.owner]).size !== 4) throw Error('Platform menu identities must be distinct');
  await tx.execute(sql`SELECT set_config('search_path','public,pg_temp',true),set_config('statement_timeout','5000',true),
    set_config('lock_timeout','1000',true),set_config('idle_in_transaction_session_timeout','5000',true)`);
  const [identity] = await tx.execute(sql`SELECT current_database()=${target.database} AND current_user=${target.maintenance}
    AND session_user=current_user AND current_schema()='public' AND current_setting('server_version_num')::integer/10000=16
    AND current_setting('transaction_isolation')='read committed' AND NOT current_setting('transaction_read_only')::boolean
    AND current_setting('session_replication_role')='origin'
    AND EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=current_user AND rolsuper)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_event_trigger WHERE evtenabled<>'D') AS supported,
    to_regclass('public.admin_platform_menu_operation') IS NOT NULL AS receipt,
    to_regprocedure('public.admin_platform_menu_operation_immutable_v1()') IS NOT NULL AS immutable,
    EXISTS(SELECT 1 FROM pg_catalog.pg_proc WHERE pronamespace='public'::regnamespace AND proname=${ADMIN_PLATFORM_MENU_WRITE_FUNCTION}) AS capability`);
  if (identity?.supported !== true) throw Error('Platform menu installation requires explicit PG16 owner/database maintenance');
  const [gate] = await tx.execute(sql`SELECT pg_try_advisory_xact_lock(731626,14) AS acquired`);
  if (gate?.acquired !== true) throw Error('Platform menu commissioning is busy');
  await tx.execute(sql.raw('LOCK TABLE ONLY public.system_admin, ONLY public.system_role IN SHARE ROW EXCLUSIVE MODE NOWAIT'));
  await tx.execute(sql.raw('LOCK TABLE ONLY public.system_menus IN ACCESS EXCLUSIVE MODE NOWAIT'));
  if (!(await inspectRuntimeAdminBoundary(tx, target.app, target.maintenance)).ready) throw Error('Platform menu installation requires the reviewed staff boundary');
  const presence = [identity.receipt, identity.immutable, identity.capability];
  if (presence.some(Boolean) && !presence.every(value => value === true)) throw Error('Partial platform menu addon requires review');
  if (presence.every(value => value === true)) {
    await tx.execute(sql.raw('LOCK TABLE ONLY public.admin_platform_menu_operation IN ACCESS EXCLUSIVE MODE NOWAIT'));
    if (!await inspectAdminPlatformMenuOperation(tx, target) || !(await inspectAdminPlatformMenuWriteCapability(tx, target.admin)).ready) throw Error('Existing platform menu addon catalog/ACL drift');
    return { applied: false, ready: true };
  }
  const [owner] = await tx.execute(sql`SELECT NOT rolcanlogin
    AND NOT(rolsuper OR rolcreatedb OR rolcreaterole OR rolinherit OR rolreplication OR rolbypassrls)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members WHERE member=r.oid OR roleid=r.oid)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_namespace WHERE nspowner=r.oid)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class WHERE relowner=r.oid)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_proc WHERE proowner=r.oid)
    AND NOT pg_catalog.has_database_privilege(r.oid,current_database(),'CREATE')
    AND NOT pg_catalog.has_schema_privilege(r.oid,'public','CREATE')
    AND NOT pg_catalog.has_parameter_privilege(r.oid,'session_replication_role','SET')
    AND NOT pg_catalog.has_parameter_privilege(r.oid,'session_replication_role','ALTER SYSTEM') AS safe
    FROM pg_catalog.pg_roles r WHERE rolname=${target.owner}`);
  if (owner?.safe !== true) throw Error('Platform menu function owner must be a separate restricted NOLOGIN role');
  const [baseline] = await tx.execute(sql`SELECT
    NOT pg_catalog.has_table_privilege(${target.owner},'public.system_menus','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    AND NOT pg_catalog.has_table_privilege(${target.owner},'public.system_role','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    AND NOT pg_catalog.has_sequence_privilege(${target.owner},'public.system_menus_id_seq','USAGE,SELECT,UPDATE')
    AND NOT pg_catalog.has_table_privilege(${target.admin},'public.system_menus','INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER')
    AND NOT pg_catalog.has_sequence_privilege(${target.admin},'public.system_menus_id_seq','USAGE,SELECT,UPDATE') AS clean`);
  if (baseline?.clean !== true) throw Error('Platform menu capability owner or Admin ACL drift');
  await tx.execute(sql.raw(ADMIN_PLATFORM_MENU_OPERATION_SQL));
  if (!await inspectAdminPlatformMenuOperation(tx)) throw Error('Platform menu initial immutable receipt catalog verification failed');
  await tx.execute(sql.raw(`GRANT SELECT, INSERT ON TABLE public.admin_platform_menu_operation TO ${pricingIdentifier(target.admin)}`));
  await tx.execute(sql.raw(`GRANT SELECT,INSERT,UPDATE ON public.system_menus TO ${pricingIdentifier(target.owner)}`));
  await tx.execute(sql.raw(`GRANT SELECT ON public.system_role TO ${pricingIdentifier(target.owner)}`));
  await tx.execute(sql.raw(`GRANT USAGE ON SEQUENCE public.system_menus_id_seq TO ${pricingIdentifier(target.owner)}`));
  await tx.execute(sql.raw(`GRANT USAGE,CREATE ON SCHEMA public TO ${pricingIdentifier(target.owner)}`));
  await tx.execute(sql.raw(adminPlatformMenuWriteDefinition(target.admin)));
  await tx.execute(sql.raw(`REVOKE ALL ON FUNCTION ${ADMIN_PLATFORM_MENU_WRITE_SIGNATURE} FROM PUBLIC`));
  await tx.execute(sql.raw(`ALTER FUNCTION ${ADMIN_PLATFORM_MENU_WRITE_SIGNATURE} OWNER TO ${pricingIdentifier(target.owner)}`));
  await tx.execute(sql.raw(`REVOKE CREATE ON SCHEMA public FROM ${pricingIdentifier(target.owner)}`));
  await tx.execute(sql.raw(`GRANT EXECUTE ON FUNCTION ${ADMIN_PLATFORM_MENU_WRITE_SIGNATURE} TO ${pricingIdentifier(target.admin)}`));
  const receiptReady = await inspectAdminPlatformMenuOperation(tx, target);
  const capability = await inspectAdminPlatformMenuWriteCapability(tx, target.admin);
  if (!receiptReady || !capability.ready) throw Error(`Platform menu installed catalog/ACL verification failed: ${JSON.stringify({ receiptReady, capability })}`);
  return { applied: true, ready: true };
}
