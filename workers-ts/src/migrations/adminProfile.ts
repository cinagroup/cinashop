import { sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { ServiceUnavailableException } from '@/utils/errors';

export const ADMIN_PROFILE_RUNTIME_PRIVILEGES = { app: [], admin: ['SELECT', 'INSERT'] } as const;
export const ADMIN_PROFILE_IMMUTABLE_BODY = ` BEGIN
 RAISE EXCEPTION 'Admin profile evidence is immutable' USING ERRCODE='42501'; END `;

/** Explicit maintenance SQL; never run from a request, startup or login.
 * Grant SELECT/INSERT on the two tables ONLY to the commissioned Admin role.
 * The ordinary application role must receive no privileges. */
export const ADMIN_PROFILE_SQL = `
CREATE TABLE public.admin_profile_operation (
 operation_id uuid PRIMARY KEY, actor_id integer NOT NULL CHECK(actor_id>0),
 operation varchar(16) NOT NULL CHECK(operation IN ('name','avatar','password','phone')),
 request_hash varchar(64) NOT NULL,
 state varchar(16) NOT NULL CHECK(state IN ('committed','not_applied')),
 created_at integer NOT NULL CHECK(created_at>0),
 CHECK(operation_id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
 CHECK((state='committed' AND request_hash ~ '^[a-f0-9]{64}$') OR (state='not_applied' AND request_hash=''))
);
CREATE TABLE public.admin_profile_avatar (
 avatar_id uuid PRIMARY KEY, actor_id integer NOT NULL CHECK(actor_id>0),
 object_key varchar(200) NOT NULL UNIQUE, sha256 varchar(64) NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'),
 mime varchar(32) NOT NULL CHECK(mime IN ('image/jpeg','image/png','image/webp','image/gif')),
 size integer NOT NULL CHECK(size BETWEEN 1 AND 2097152), created_at integer NOT NULL CHECK(created_at>0),
 CHECK(avatar_id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
);
CREATE FUNCTION public.admin_profile_immutable_v1() RETURNS trigger LANGUAGE plpgsql
 SET search_path=pg_catalog AS $$${ADMIN_PROFILE_IMMUTABLE_BODY}$$;
CREATE TRIGGER apo_immutable BEFORE UPDATE OR DELETE ON public.admin_profile_operation
 FOR EACH ROW EXECUTE FUNCTION public.admin_profile_immutable_v1();
CREATE TRIGGER apo_no_truncate BEFORE TRUNCATE ON public.admin_profile_operation
 FOR EACH STATEMENT EXECUTE FUNCTION public.admin_profile_immutable_v1();
CREATE TRIGGER apa_immutable BEFORE UPDATE OR DELETE ON public.admin_profile_avatar
 FOR EACH ROW EXECUTE FUNCTION public.admin_profile_immutable_v1();
CREATE TRIGGER apa_no_truncate BEFORE TRUNCATE ON public.admin_profile_avatar
 FOR EACH STATEMENT EXECUTE FUNCTION public.admin_profile_immutable_v1();
REVOKE ALL ON TABLE public.admin_profile_operation, public.admin_profile_avatar FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_profile_immutable_v1() FROM PUBLIC;
`;

const columns = {
  admin_profile_operation: [['operation_id','uuid',true,null],['actor_id','integer',true,null],
    ['operation','character varying(16)',true,'"default"'],['request_hash','character varying(64)',true,'"default"'],
    ['state','character varying(16)',true,'"default"'],['created_at','integer',true,null]],
  admin_profile_avatar: [['avatar_id','uuid',true,null],['actor_id','integer',true,null],
    ['object_key','character varying(200)',true,'"default"'],['sha256','character varying(64)',true,'"default"'],
    ['mime','character varying(32)',true,'"default"'],['size','integer',true,null],['created_at','integer',true,null]],
};
const uuidCheck = (column: string) => `CHECK (((${column})::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'::text))`;
export const ADMIN_PROFILE_EXPECTED_CONSTRAINTS: Record<keyof typeof columns, Record<string,string>> = {
  admin_profile_operation: {
    admin_profile_operation_pkey: 'PRIMARY KEY (operation_id)',
    admin_profile_operation_actor_id_check: 'CHECK ((actor_id > 0))',
    admin_profile_operation_operation_check: "CHECK (((operation)::text = ANY ((ARRAY['name'::character varying, 'avatar'::character varying, 'password'::character varying, 'phone'::character varying])::text[])))",
    admin_profile_operation_state_check: "CHECK (((state)::text = ANY ((ARRAY['committed'::character varying, 'not_applied'::character varying])::text[])))",
    admin_profile_operation_created_at_check: 'CHECK ((created_at > 0))',
    admin_profile_operation_operation_id_check: uuidCheck('operation_id'),
    admin_profile_operation_check: "CHECK (((((state)::text = 'committed'::text) AND ((request_hash)::text ~ '^[a-f0-9]{64}$'::text)) OR (((state)::text = 'not_applied'::text) AND ((request_hash)::text = ''::text))))",
  },
  admin_profile_avatar: {
    admin_profile_avatar_pkey: 'PRIMARY KEY (avatar_id)',
    admin_profile_avatar_actor_id_check: 'CHECK ((actor_id > 0))',
    admin_profile_avatar_object_key_key: 'UNIQUE (object_key)',
    admin_profile_avatar_sha256_check: "CHECK (((sha256)::text ~ '^[a-f0-9]{64}$'::text))",
    admin_profile_avatar_mime_check: "CHECK (((mime)::text = ANY ((ARRAY['image/jpeg'::character varying, 'image/png'::character varying, 'image/webp'::character varying, 'image/gif'::character varying])::text[])))",
    admin_profile_avatar_size_check: 'CHECK (((size >= 1) AND (size <= 2097152)))',
    admin_profile_avatar_created_at_check: 'CHECK ((created_at > 0))',
    admin_profile_avatar_avatar_id_check: uuidCheck('avatar_id'),
  },
};

/** Read-only exact addon inspection. An absent/partial catalog, changed body,
 * grant option, public grant, unexpected index/trigger/FK or owner fails closed.
 * No request path installs, grants, repairs, or rewrites historical evidence. */
export async function inspectAdminProfile(tx: Pick<DbClient,'execute'>, names?: { maintenance: string; admin: string }): Promise<boolean> {
  for (const name of Object.keys(columns) as Array<keyof typeof columns>) {
    const prefix = name === 'admin_profile_operation' ? 'apo' : 'apa';
    const [row] = await tx.execute(sql`SELECT
      c.relkind='r' AND c.relpersistence='p' AND NOT c.relispartition AND NOT c.relrowsecurity AND NOT c.relforcerowsecurity
      AND c.relnatts=${columns[name].length} AND c.relchecks=6 AND c.reloptions IS NULL AND c.relreplident='d'
      AND c.relam=(SELECT oid FROM pg_catalog.pg_am WHERE amname='heap')
      AND EXISTS(SELECT 1 FROM pg_catalog.pg_roles owner WHERE owner.oid=c.relowner AND owner.rolsuper
        AND (${names?.maintenance ?? null}::text IS NULL OR owner.rolname=${names?.maintenance ?? null}::text))
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_inherits WHERE inhrelid=c.oid OR inhparent=c.oid)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_rewrite WHERE ev_class=c.oid)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_policy WHERE polrelid=c.oid)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_constraint WHERE confrelid=c.oid)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid=c.oid AND contype NOT IN ('p','u','c','n')) AS safe,
      (SELECT jsonb_agg(jsonb_build_array(attname,format_type(atttypid,atttypmod),attnotnull,
        CASE WHEN attcollation=0 THEN NULL ELSE attcollation::regcollation::text END,attnum,atthasdef,attidentity,attgenerated,attisdropped) ORDER BY attnum)
        FROM pg_catalog.pg_attribute WHERE attrelid=c.oid AND attnum>0) AS columns,
      (SELECT count(*)=${Object.keys(ADMIN_PROFILE_EXPECTED_CONSTRAINTS[name]).length} AND bool_and(convalidated AND NOT condeferrable
        AND NOT condeferred AND conislocal AND coninhcount=0 AND conparentid=0)
        FROM pg_catalog.pg_constraint WHERE conrelid=c.oid AND contype IN ('p','u','c')) AS constraint_count,
      (SELECT jsonb_object_agg(conname,pg_get_constraintdef(oid,false)) FROM pg_catalog.pg_constraint
        WHERE conrelid=c.oid AND contype IN ('p','u','c')) AS constraints,
      (SELECT count(*)=${name === 'admin_profile_operation' ? 1 : 2} AND bool_and(indisunique AND indisvalid AND indisready AND indislive
        AND indimmediate AND NOT indisexclusion AND indexprs IS NULL AND indpred IS NULL
        AND indnatts=1 AND indnkeyatts=1 AND indoption::text='0' AND NOT indnullsnotdistinct
        AND EXISTS(SELECT 1 FROM pg_catalog.pg_class i WHERE i.oid=indexrelid AND i.relkind='i' AND i.relpersistence='p'
          AND i.reloptions IS NULL AND i.relowner=c.relowner AND i.relam=(SELECT oid FROM pg_catalog.pg_am WHERE amname='btree'))
        AND ((indisprimary AND indkey::text='1' AND indcollation::text='0'
          AND indclass::text=(SELECT oid::text FROM pg_catalog.pg_opclass WHERE opcname='uuid_ops' AND opcnamespace='pg_catalog'::regnamespace
            AND opcmethod=(SELECT oid FROM pg_catalog.pg_am WHERE amname='btree')))
        OR (${name === 'admin_profile_avatar'} AND NOT indisprimary AND indkey::text='3'
          AND indcollation::text=(SELECT oid::text FROM pg_catalog.pg_collation WHERE collname='default' AND collnamespace='pg_catalog'::regnamespace)
          AND indclass::text=(SELECT oid::text FROM pg_catalog.pg_opclass WHERE opcname='text_ops' AND opcnamespace='pg_catalog'::regnamespace
            AND opcmethod=(SELECT oid FROM pg_catalog.pg_am WHERE amname='btree')))))
        FROM pg_catalog.pg_index WHERE indrelid=c.oid) AS indexes,
      (SELECT count(*)=2 AND bool_and(NOT t.tgisinternal AND t.tgenabled='O' AND t.tgnargs=0 AND t.tgqual IS NULL
        AND t.tgconstraint=0 AND t.tgfoid=f.oid AND t.tgattr::text='' AND t.tgoldtable IS NULL AND t.tgnewtable IS NULL
        AND ((t.tgname=${prefix + '_immutable'} AND t.tgtype=27) OR (t.tgname=${prefix + '_no_truncate'} AND t.tgtype=34)))
        FROM pg_catalog.pg_trigger t WHERE t.tgrelid=c.oid) AS triggers,
      f.proowner=c.relowner AND f.prosrc=${ADMIN_PROFILE_IMMUTABLE_BODY} AND f.prorettype='pg_catalog.trigger'::regtype
      AND f.pronargs=0 AND f.proargtypes::text='' AND NOT f.prosecdef AND NOT f.proleakproof AND f.provolatile='v'
      AND f.prokind='f' AND f.proconfig=ARRAY['search_path=pg_catalog'] AND NOT f.proisstrict AND NOT f.proretset
      AND f.proparallel='u' AND f.prosupport=0 AND f.provariadic=0 AND f.pronargdefaults=0 AND f.proargdefaults IS NULL
      AND f.proallargtypes IS NULL AND f.proargmodes IS NULL AND f.proargnames IS NULL
      AND f.prolang=(SELECT oid FROM pg_catalog.pg_language WHERE lanname='plpgsql')
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
      FROM pg_catalog.pg_class c JOIN pg_catalog.pg_proc f ON f.oid=to_regprocedure('public.admin_profile_immutable_v1()')
      WHERE c.oid=to_regclass(${'public.' + name})`);
    if (!row || ['safe','constraint_count','indexes','triggers','function','acl'].some(key => row[key] !== true)) return false;
    if (JSON.stringify(row.columns) !== JSON.stringify(columns[name].map((column, i) => [...column,i+1,false,'','',false]))) return false;
    const actual = row.constraints as Record<string,string> | undefined, expected = ADMIN_PROFILE_EXPECTED_CONSTRAINTS[name];
    if (!actual || Object.keys(actual).length !== Object.keys(expected).length || Object.entries(expected).some(([key, value]) => actual[key] !== value)) return false;
  }
  return true;
}

export async function assertAdminProfileReady(tx: Pick<DbClient,'execute'>): Promise<void> {
  try {
    if (!await inspectAdminProfile(tx)) throw Error('Admin profile catalog drift');
    const [row] = await tx.execute(sql`SELECT count(*)=2 AND bool_and(has_table_privilege(current_user,c.oid,'SELECT')
      AND has_table_privilege(current_user,c.oid,'INSERT')
      AND (c.relowner=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=current_user) OR
        (NOT has_table_privilege(current_user,c.oid,'UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
          AND NOT EXISTS(SELECT 1 FROM pg_catalog.aclexplode(COALESCE(c.relacl,pg_catalog.acldefault('r',c.relowner))) a
            WHERE a.grantee<>c.relowner AND a.grantee<>(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=current_user))))) AS ready
      FROM pg_catalog.pg_class c WHERE c.oid IN (to_regclass('public.admin_profile_operation'),to_regclass('public.admin_profile_avatar'))`);
    if (row?.ready !== true) throw Error('Admin profile runtime privileges drift');
  } catch (cause) { throw Object.assign(new ServiceUnavailableException('个人资料回执、头像目录或运行权限尚未就绪'), { cause }); }
}
