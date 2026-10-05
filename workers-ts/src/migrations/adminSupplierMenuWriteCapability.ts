import { sql } from 'drizzle-orm';
import type { DbClient } from '../lib/di';
import { pricingIdentifier } from './checkoutPricingLockCatalog';
import { inspectRuntimeAdminBoundary } from './runtimeAdminBoundary';

type Query = Pick<DbClient, 'execute'>;
export const ADMIN_SUPPLIER_MENU_WRITE_FUNCTION = 'cinashop_admin_supplier_menu_write_v1';
export const ADMIN_SUPPLIER_MENU_WRITE_SIGNATURE =
  `public.${ADMIN_SUPPLIER_MENU_WRITE_FUNCTION}(text,integer,text,jsonb)`;
const lockNamespace = 731_606;
const lockKey = 4;

export interface AdminSupplierMenuWriteTarget {
  app: string;
  admin: string;
  maintenance: string;
  owner: string;
}

/** The body is pinned byte-for-byte by the catalog inspector. A caller may
 * never supply table names, SQL, a type, an ID for insertion, or a deletion
 * statement. The owner is a separate restricted NOLOGIN role. */
export function adminSupplierMenuWriteBody(adminRole: string): string {
  pricingIdentifier(adminRole);
  return `
DECLARE
  row_before public.system_menus%ROWTYPE;
  row_xmin text;
  result_id integer;
  parent_id integer;
  parent_row public.system_menus%ROWTYPE;
  ancestors integer[] := ARRAY[]::integer[];
  new_path text := '';
  referenced boolean;
  new_pid integer;
  new_auth_type integer;
  new_menu_name text;
  new_menu_path text;
  new_unique_auth text;
  new_api_url text;
  new_methods text;
  new_icon text;
  new_sort integer;
  new_is_show integer;
  new_is_show_path integer;
  new_access integer;
BEGIN
  IF session_user <> '${adminRole}' THEN
    RAISE EXCEPTION 'Supplier menu write requires the reviewed Admin LOGIN' USING ERRCODE='42501';
  END IF;
  IF pg_catalog.current_setting('session_replication_role') <> 'origin' THEN
    RAISE EXCEPTION 'Supplier menu write requires ordinary triggers' USING ERRCODE='42501';
  END IF;
  IF p_operation NOT IN ('create','update','visibility','delete') OR p_payload IS NULL
    OR pg_catalog.jsonb_typeof(p_payload) <> 'object' THEN
    RAISE EXCEPTION 'Invalid supplier menu operation' USING ERRCODE='23514';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(${lockNamespace},${lockKey});
  IF p_operation = 'create' THEN
    IF p_menu_id <> 0 OR p_expected_xmin IS NOT NULL THEN
      RAISE EXCEPTION 'Create must not select an existing menu ID' USING ERRCODE='23514';
    END IF;
  ELSE
    IF p_menu_id IS NULL OR p_menu_id <= 0 OR p_expected_xmin IS NULL
      OR p_expected_xmin !~ '^[0-9]{1,10}$' THEN
      RAISE EXCEPTION 'Menu ID and row revision are required' USING ERRCODE='23514';
    END IF;
    SELECT * INTO row_before FROM public.system_menus WHERE id=p_menu_id FOR UPDATE;
    IF NOT FOUND OR row_before.type <> 4 OR row_before.is_del <> 0 THEN
      RAISE EXCEPTION 'Supplier menu not found' USING ERRCODE='P0002';
    END IF;
    SELECT xmin::text INTO row_xmin FROM public.system_menus WHERE id=p_menu_id;
    IF row_xmin IS DISTINCT FROM p_expected_xmin THEN
      RAISE EXCEPTION 'Supplier menu changed' USING ERRCODE='40001';
    END IF;
  END IF;

  IF p_operation IN ('create','update') THEN
    IF (SELECT count(*) FROM pg_catalog.jsonb_object_keys(p_payload)) <> 12
      OR NOT p_payload ?& ARRAY['pid','auth_type','menu_name','menu_path','unique_auth',
        'api_url','methods','icon','sort','is_show','is_show_path','access'] THEN
      RAISE EXCEPTION 'Supplier menu payload has unsupported fields' USING ERRCODE='23514';
    END IF;
    IF pg_catalog.jsonb_typeof(p_payload->'pid') <> 'number'
      OR pg_catalog.jsonb_typeof(p_payload->'auth_type') <> 'number'
      OR pg_catalog.jsonb_typeof(p_payload->'sort') <> 'number'
      OR pg_catalog.jsonb_typeof(p_payload->'is_show') <> 'number'
      OR pg_catalog.jsonb_typeof(p_payload->'is_show_path') <> 'number'
      OR pg_catalog.jsonb_typeof(p_payload->'access') <> 'number'
      OR pg_catalog.jsonb_typeof(p_payload->'menu_name') <> 'string'
      OR pg_catalog.jsonb_typeof(p_payload->'menu_path') <> 'string'
      OR pg_catalog.jsonb_typeof(p_payload->'unique_auth') <> 'string'
      OR pg_catalog.jsonb_typeof(p_payload->'api_url') <> 'string'
      OR pg_catalog.jsonb_typeof(p_payload->'methods') <> 'string'
      OR pg_catalog.jsonb_typeof(p_payload->'icon') <> 'string' THEN
      RAISE EXCEPTION 'Supplier menu payload types are invalid' USING ERRCODE='23514';
    END IF;
    new_pid := (p_payload->>'pid')::integer;
    new_auth_type := (p_payload->>'auth_type')::integer;
    new_menu_name := pg_catalog.btrim(p_payload->>'menu_name');
    new_menu_path := pg_catalog.btrim(p_payload->>'menu_path');
    new_unique_auth := pg_catalog.btrim(p_payload->>'unique_auth');
    new_api_url := pg_catalog.btrim(p_payload->>'api_url');
    new_methods := p_payload->>'methods';
    new_icon := p_payload->>'icon';
    new_sort := (p_payload->>'sort')::integer;
    new_is_show := (p_payload->>'is_show')::integer;
    new_is_show_path := (p_payload->>'is_show_path')::integer;
    new_access := (p_payload->>'access')::integer;
    IF new_pid < 0 OR new_auth_type NOT IN (1,2) OR new_sort NOT BETWEEN 0 AND 100000
      OR new_is_show NOT IN (0,1) OR new_is_show_path NOT IN (0,1)
      OR new_access NOT IN (0,1) OR pg_catalog.char_length(new_menu_name) NOT BETWEEN 1 AND 64
      OR pg_catalog.char_length(new_icon) > 50 THEN
      RAISE EXCEPTION 'Supplier menu values are outside the reviewed range' USING ERRCODE='23514';
    END IF;
    IF new_auth_type = 1 THEN
      IF new_methods <> '' OR new_api_url <> ''
        OR (new_menu_path <> '/supplier' AND new_menu_path !~ '^/supplier/[A-Za-z0-9_/-]+$')
        OR pg_catalog.char_length(new_menu_path) > 255
        OR new_unique_auth !~ '^[A-Za-z0-9_.-]+$'
        OR pg_catalog.char_length(new_unique_auth) > 150 THEN
        RAISE EXCEPTION 'Supplier navigation fields are invalid' USING ERRCODE='23514';
      END IF;
      IF EXISTS(SELECT 1 FROM public.system_menus AS other
        WHERE other.id <> p_menu_id AND other.type=4 AND other.is_del=0
          AND other.auth_type=1 AND other.unique_auth=new_unique_auth) THEN
        RAISE EXCEPTION 'Supplier menu permission identifier already exists' USING ERRCODE='23505';
      END IF;
    ELSE
      IF new_menu_path <> '' OR new_unique_auth <> '' OR new_methods NOT IN ('GET','POST','PUT','DELETE')
        OR new_api_url !~ '^[A-Za-z0-9_./:<>{}-]+$'
        OR pg_catalog.char_length(new_api_url) > 255
        OR new_is_show <> 1 OR new_is_show_path <> 0 THEN
        RAISE EXCEPTION 'Supplier API rule fields are invalid' USING ERRCODE='23514';
      END IF;
      IF EXISTS(SELECT 1 FROM public.system_menus AS other
        WHERE other.id <> p_menu_id AND other.type=4 AND other.is_del=0
          AND other.auth_type=2 AND other.methods=new_methods AND other.api_url=new_api_url) THEN
        RAISE EXCEPTION 'Supplier API rule already exists' USING ERRCODE='23505';
      END IF;
    END IF;
    parent_id := new_pid;
    WHILE parent_id > 0 LOOP
      IF parent_id = p_menu_id OR parent_id = ANY(ancestors)
        OR pg_catalog.cardinality(ancestors) >= 64 THEN
        RAISE EXCEPTION 'Supplier menu parent cycle or depth limit' USING ERRCODE='23514';
      END IF;
      SELECT * INTO parent_row FROM public.system_menus WHERE id=parent_id FOR SHARE;
      IF NOT FOUND OR parent_row.type <> 4 OR parent_row.is_del <> 0 OR parent_row.auth_type <> 1 THEN
        RAISE EXCEPTION 'Supplier menu parent must be an active type-4 menu' USING ERRCODE='23514';
      END IF;
      ancestors := pg_catalog.array_append(ancestors,parent_id);
      new_path := parent_id::text || CASE WHEN new_path='' THEN '' ELSE '/' || new_path END;
      parent_id := parent_row.pid;
    END LOOP;
    IF p_operation = 'create' THEN
      INSERT INTO public.system_menus(pid,type,auth_type,menu_name,menu_path,unique_auth,
        api_url,methods,icon,sort,is_show,is_show_path,access,path)
      VALUES(new_pid,4,new_auth_type,new_menu_name,new_menu_path,new_unique_auth,
        new_api_url,new_methods,new_icon,new_sort,new_is_show,new_is_show_path,new_access,new_path)
      RETURNING id INTO result_id;
      RETURN result_id;
    END IF;
    IF row_before.auth_type=1 AND new_auth_type=2 AND EXISTS(
      SELECT 1 FROM public.system_menus WHERE pid=p_menu_id AND type=4 AND is_del=0) THEN
      RAISE EXCEPTION 'Supplier menu with children cannot become an API rule' USING ERRCODE='23503';
    END IF;
    SELECT EXISTS(SELECT 1 FROM public.system_role AS role
      WHERE role.type=4 AND EXISTS(SELECT 1
        FROM pg_catalog.unnest(pg_catalog.string_to_array(role.rules,',')) AS token(value)
        WHERE pg_catalog.btrim(token.value)=p_menu_id::text)) INTO referenced;
    IF referenced AND (row_before.auth_type IS DISTINCT FROM new_auth_type
      OR row_before.methods IS DISTINCT FROM new_methods
      OR row_before.api_url IS DISTINCT FROM new_api_url
      OR row_before.access IS DISTINCT FROM new_access) THEN
      RAISE EXCEPTION 'Referenced supplier permission meaning is immutable' USING ERRCODE='23503';
    END IF;
    UPDATE public.system_menus SET pid=new_pid,auth_type=new_auth_type,
      menu_name=new_menu_name,menu_path=new_menu_path,unique_auth=new_unique_auth,
      api_url=new_api_url,methods=new_methods,icon=new_icon,sort=new_sort,
      is_show=new_is_show,is_show_path=new_is_show_path,access=new_access,path=new_path
      WHERE id=p_menu_id AND type=4 AND is_del=0;
    IF row_before.pid IS DISTINCT FROM new_pid THEN
      WITH RECURSIVE descendants(id,path,seen) AS (
        SELECT child.id,(CASE WHEN new_path='' THEN p_menu_id::text
          ELSE new_path || '/' || p_menu_id END)::text,ARRAY[p_menu_id,child.id]
          FROM public.system_menus AS child WHERE child.pid=p_menu_id AND child.type=4 AND child.is_del=0
        UNION ALL
        SELECT child.id,descendants.path || '/' || descendants.id,
          pg_catalog.array_append(descendants.seen,child.id)
          FROM public.system_menus AS child JOIN descendants ON child.pid=descendants.id
          WHERE child.type=4 AND child.is_del=0
            AND NOT child.id=ANY(descendants.seen) AND pg_catalog.cardinality(descendants.seen)<64
      ) UPDATE public.system_menus AS child SET path=descendants.path
        FROM descendants WHERE child.id=descendants.id;
    END IF;
    RETURN p_menu_id;
  END IF;

  IF p_operation = 'visibility' THEN
    IF (SELECT count(*) FROM pg_catalog.jsonb_object_keys(p_payload)) <> 1
      OR NOT p_payload ? 'is_show'
      OR pg_catalog.jsonb_typeof(p_payload->'is_show') <> 'number' THEN
      RAISE EXCEPTION 'Visibility requires only is_show' USING ERRCODE='23514';
    END IF;
    new_is_show := (p_payload->>'is_show')::integer;
    IF row_before.auth_type <> 1 OR new_is_show NOT IN (0,1) THEN
      RAISE EXCEPTION 'Only navigation menus have visibility' USING ERRCODE='23514';
    END IF;
    UPDATE public.system_menus SET is_show=new_is_show
      WHERE id=p_menu_id AND type=4 AND is_del=0;
    RETURN p_menu_id;
  END IF;

  IF p_payload <> '{}'::jsonb THEN
    RAISE EXCEPTION 'Delete does not accept fields' USING ERRCODE='23514';
  END IF;
  IF EXISTS(SELECT 1 FROM public.system_menus WHERE pid=p_menu_id AND type=4 AND is_del=0) THEN
    RAISE EXCEPTION 'Supplier menu still has children' USING ERRCODE='23503';
  END IF;
  IF EXISTS(SELECT 1 FROM public.system_role AS role WHERE role.type=4
    AND EXISTS(SELECT 1 FROM pg_catalog.unnest(pg_catalog.string_to_array(role.rules,',')) AS token(value)
      WHERE pg_catalog.btrim(token.value)=p_menu_id::text)) THEN
    RAISE EXCEPTION 'Supplier menu is referenced by a role' USING ERRCODE='23503';
  END IF;
  UPDATE public.system_menus SET is_del=1 WHERE id=p_menu_id AND type=4 AND is_del=0;
  RETURN p_menu_id;
END
`;
}

export interface AdminSupplierMenuCapabilityState {
  absent: boolean;
  ready: boolean;
  functionOid: string | null;
  definitionSafe: boolean;
  ownerSafe: boolean;
  aclSafe: boolean;
  tablesSafe: boolean;
}

/** Safe on an actual Admin LOGIN; never treats existence alone as readiness. */
export async function inspectAdminSupplierMenuWriteCapability(
  db: Query,
  adminRole?: string,
): Promise<AdminSupplierMenuCapabilityState> {
  const expectedAdmin = adminRole ?? String((await db.execute(sql`SELECT current_user AS role`))[0]?.role ?? '');
  pricingIdentifier(expectedAdmin);
  const rows = await db.execute(sql`SELECT p.oid::text AS oid,p.prosrc,p.prosecdef,p.provolatile,
      p.proparallel,p.prokind,p.prorettype='pg_catalog.int4'::regtype AS returns_integer,
      p.proargtypes='25 23 25 3802'::oidvector AND p.pronargs=4
        AND p.proargnames=ARRAY['p_operation','p_menu_id','p_expected_xmin','p_payload']
        AND p.proargmodes IS NULL AND p.proallargtypes IS NULL AS arguments_safe,
      l.lanname='plpgsql' AND l.lanpltrusted AS language_safe,
      NOT p.proleakproof AND NOT p.proisstrict AND NOT p.proretset
        AND p.provariadic=0 AND p.pronargdefaults=0 AND p.proargdefaults IS NULL
        AND p.prosupport=0 AND p.probin IS NULL AND p.prosqlbody IS NULL AS flags_safe,
      p.proconfig,p.proacl,pg_catalog.pg_get_userbyid(p.proowner) AS owner
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_language l ON l.oid=p.prolang
    WHERE p.pronamespace='public'::regnamespace
      AND p.proname=${ADMIN_SUPPLIER_MENU_WRITE_FUNCTION}`);
  const absent = rows.length === 0;
  if (absent) return { absent: true, ready: false, functionOid: null,
    definitionSafe: false, ownerSafe: false, aclSafe: false, tablesSafe: false };
  if (rows.length !== 1) return { absent: false, ready: false, functionOid: null,
    definitionSafe: false, ownerSafe: false, aclSafe: false, tablesSafe: false };
  const row = rows.length === 1 ? rows[0] : undefined;
  const owner = typeof row?.owner === 'string' ? row.owner : '';
  const definitionSafe = !!row && row.prosrc === adminSupplierMenuWriteBody(expectedAdmin)
    && row.prosecdef === true && row.provolatile === 'v' && row.proparallel === 'u'
    && row.prokind === 'f' && row.returns_integer === true && row.arguments_safe === true
    && row.language_safe === true && row.flags_safe === true
    && JSON.stringify(row.proconfig) === JSON.stringify(['search_path=pg_catalog, pg_temp']);
  const [catalog] = await db.execute(sql`SELECT
      (SELECT count(*)=2 AND bool_and(a.privilege_type='EXECUTE' AND NOT a.is_grantable
        AND a.grantee IN (SELECT oid FROM pg_catalog.pg_roles WHERE rolname IN (${expectedAdmin},${owner})))
        AND bool_or(a.grantee=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=${expectedAdmin}))
        AND bool_or(a.grantee=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=${owner}))
        FROM pg_catalog.pg_proc p CROSS JOIN LATERAL pg_catalog.aclexplode(p.proacl) a
        WHERE p.oid=${row?.oid ?? '0'}::oid) AS acl,
      (SELECT NOT rolcanlogin AND NOT(rolsuper OR rolcreatedb OR rolcreaterole OR rolinherit
        OR rolreplication OR rolbypassrls) AND NOT EXISTS(
          SELECT 1 FROM pg_catalog.pg_auth_members WHERE member=r.oid OR roleid=r.oid)
        AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_namespace WHERE nspowner=r.oid)
        AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class WHERE relowner=r.oid)
        AND NOT pg_catalog.has_database_privilege(r.oid,current_database(),'CREATE')
        AND NOT pg_catalog.has_schema_privilege(r.oid,'public','CREATE')
        FROM pg_catalog.pg_roles r WHERE rolname=${owner}) AS owner_role,
      (SELECT c.relkind='r' AND c.relpersistence='p' AND NOT c.relispartition
        AND NOT c.relrowsecurity AND NOT c.relforcerowsecurity
        AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_inherits WHERE inhrelid=c.oid OR inhparent=c.oid)
        AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_rewrite WHERE ev_class=c.oid)
        FROM pg_catalog.pg_class c WHERE c.oid='public.system_menus'::regclass) AS menu_table,
      (SELECT c.relkind='r' AND c.relpersistence='p' AND NOT c.relispartition
        AND NOT c.relrowsecurity AND NOT c.relforcerowsecurity
        FROM pg_catalog.pg_class c WHERE c.oid='public.system_role'::regclass) AS role_table,
      (SELECT pg_catalog.pg_get_serial_sequence('public.system_menus','id')
        = 'public.system_menus_id_seq') AS sequence_shape,
      pg_catalog.has_table_privilege(${owner},'public.system_menus','SELECT') AS owner_menu_select,
      pg_catalog.has_table_privilege(${owner},'public.system_menus','INSERT') AS owner_menu_insert,
      pg_catalog.has_table_privilege(${owner},'public.system_menus','UPDATE') AS owner_menu_update,
      NOT pg_catalog.has_table_privilege(${owner},'public.system_menus','DELETE,TRUNCATE,REFERENCES,TRIGGER') AS owner_menu_no_extra,
      pg_catalog.has_table_privilege(${owner},'public.system_role','SELECT') AS owner_role_select,
      NOT pg_catalog.has_table_privilege(${owner},'public.system_role','INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS owner_role_no_extra,
      pg_catalog.has_sequence_privilege(${owner},'public.system_menus_id_seq','USAGE') AS owner_sequence_usage,
      NOT pg_catalog.has_sequence_privilege(${owner},'public.system_menus_id_seq','SELECT,UPDATE') AS owner_sequence_no_extra,
      NOT pg_catalog.has_table_privilege(${expectedAdmin},'public.system_menus','INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER') AS admin_no_menu_dml`);
  const ownerSafe = catalog?.owner_role === true && owner !== expectedAdmin;
  const aclSafe = catalog?.acl === true;
  const tablesSafe = catalog?.menu_table === true && catalog?.role_table === true
    && catalog?.sequence_shape === true && catalog?.owner_menu_select === true
    && catalog?.owner_menu_insert === true && catalog?.owner_menu_update === true
    && catalog?.owner_menu_no_extra === true && catalog?.owner_role_select === true
    && catalog?.owner_role_no_extra === true && catalog?.owner_sequence_usage === true
    && catalog?.owner_sequence_no_extra === true && catalog?.admin_no_menu_dml === true;
  return { absent, ready: !absent && definitionSafe && ownerSafe && aclSafe && tablesSafe,
    functionOid: typeof row?.oid === 'string' ? row.oid : null,
    definitionSafe, ownerSafe, aclSafe, tablesSafe };
}

/** Explicit add-on for an already commissioned database. It does not change
 * the app/Admin whole-table runtime grant plan and never repairs drift. */
export async function installAdminSupplierMenuWriteCapabilityInTransaction(
  tx: Query,
  target: AdminSupplierMenuWriteTarget,
): Promise<{ applied: boolean; ready: true }> {
  if (Object.hasOwn(tx, '$client')) throw Error('Supplier menu installation requires an existing transaction');
  Object.values(target).forEach(pricingIdentifier);
  if (new Set(Object.values(target)).size !== 4) throw Error('Supplier menu identities must be distinct');
  const [identity] = await tx.execute(sql`SELECT current_user=${target.maintenance}
      AND session_user=current_user AND pg_catalog.current_setting('server_version_num')::integer/10000=16
      AND pg_catalog.current_setting('transaction_isolation')='read committed'
      AND pg_catalog.current_setting('session_replication_role')='origin'
      AND NOT pg_catalog.current_setting('transaction_read_only')::boolean
      AND EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=current_user AND rolsuper)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_event_trigger WHERE evtenabled<>'D') AS supported`);
  if (identity?.supported !== true) throw Error('Supplier menu installation identity requires review');
  const [gate] = await tx.execute(sql`SELECT pg_catalog.pg_try_advisory_xact_lock(731606,4) AS acquired`);
  if (gate?.acquired !== true) throw Error('Supplier menu maintenance is busy');
  if (!(await inspectRuntimeAdminBoundary(tx, target.app, target.maintenance)).ready)
    throw Error('Supplier menu installation requires the reviewed staff boundary');
  const [owner] = await tx.execute(sql`SELECT oid::text AS oid FROM pg_catalog.pg_roles r
    WHERE rolname=${target.owner} AND NOT rolcanlogin
      AND NOT(rolsuper OR rolcreatedb OR rolcreaterole OR rolinherit OR rolreplication OR rolbypassrls)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members WHERE member=r.oid OR roleid=r.oid)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_namespace WHERE nspowner=r.oid)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class WHERE relowner=r.oid)
      AND NOT pg_catalog.has_database_privilege(r.oid,current_database(),'CREATE')
      AND NOT pg_catalog.has_schema_privilege(r.oid,'public','CREATE')`);
  if (!owner?.oid) throw Error('Supplier menu function owner must be a separate restricted NOLOGIN role');
  const before = await inspectAdminSupplierMenuWriteCapability(tx,target.admin);
  if (!before.absent && !before.ready) throw Error('Supplier menu capability catalog drift');
  if (before.ready) return { applied: false, ready: true };
  const [baseline] = await tx.execute(sql`SELECT
      NOT pg_catalog.has_table_privilege(${target.owner},'public.system_menus','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      AND NOT pg_catalog.has_table_privilege(${target.owner},'public.system_role','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      AND NOT pg_catalog.has_sequence_privilege(${target.owner},'public.system_menus_id_seq','USAGE,SELECT,UPDATE')
      AND NOT pg_catalog.has_table_privilege(${target.admin},'public.system_menus','INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER') AS clean`);
  if (baseline?.clean !== true) throw Error('Supplier menu capability owner or Admin ACL drift');
  await tx.execute(sql.raw('LOCK TABLE ONLY public.system_menus, ONLY public.system_role IN ACCESS EXCLUSIVE MODE NOWAIT'));
  if (!(await inspectAdminSupplierMenuWriteCapability(tx,target.admin)).absent)
    throw Error('Supplier menu capability changed during installation');
  await tx.execute(sql.raw(`GRANT SELECT,INSERT,UPDATE ON public.system_menus TO "${target.owner}"`));
  await tx.execute(sql.raw(`GRANT SELECT ON public.system_role TO "${target.owner}"`));
  await tx.execute(sql.raw(`GRANT USAGE ON SEQUENCE public.system_menus_id_seq TO "${target.owner}"`));
  await tx.execute(sql.raw(`GRANT USAGE,CREATE ON SCHEMA public TO "${target.owner}"`));
  await tx.execute(sql.raw(`CREATE FUNCTION public.${ADMIN_SUPPLIER_MENU_WRITE_FUNCTION}(
      p_operation text,p_menu_id integer,p_expected_xmin text,p_payload jsonb)
    RETURNS integer LANGUAGE plpgsql VOLATILE SECURITY DEFINER
    SET search_path=pg_catalog,pg_temp AS $supplier_menu_write$${adminSupplierMenuWriteBody(target.admin)}$supplier_menu_write$`));
  await tx.execute(sql.raw(`REVOKE ALL ON FUNCTION ${ADMIN_SUPPLIER_MENU_WRITE_SIGNATURE} FROM PUBLIC`));
  await tx.execute(sql.raw(`ALTER FUNCTION ${ADMIN_SUPPLIER_MENU_WRITE_SIGNATURE} OWNER TO "${target.owner}"`));
  await tx.execute(sql.raw(`REVOKE CREATE ON SCHEMA public FROM "${target.owner}"`));
  await tx.execute(sql.raw(`GRANT EXECUTE ON FUNCTION ${ADMIN_SUPPLIER_MENU_WRITE_SIGNATURE} TO "${target.admin}"`));
  const after = await inspectAdminSupplierMenuWriteCapability(tx,target.admin);
  if (!after.ready) throw Error(`Supplier menu capability final verification failed: ${JSON.stringify(after)}`);
  return { applied: true, ready: true };
}

export async function installAdminSupplierMenuWriteCapability(db: DbClient, target: AdminSupplierMenuWriteTarget) {
  if (!Object.hasOwn(db, '$client')) throw Error('Supplier menu installer requires a root connection');
  return db.transaction(tx => installAdminSupplierMenuWriteCapabilityInTransaction(tx,target),
    { isolationLevel: 'read committed', accessMode: 'read write' });
}
