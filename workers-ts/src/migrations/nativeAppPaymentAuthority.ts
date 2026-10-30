import { sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { ServiceUnavailableException } from '@/utils/errors';
import { pricingIdentifier } from './checkoutPricingLockCatalog';

type Query = Pick<DbClient, 'execute'>;
type Names = { maintenance: string; app: string; admin: string };
type Catalog = { maintenance: string; app: string | null; admin: string | null };
type Grant = [string, 'SELECT' | 'INSERT', false];
export const NATIVE_APP_PAYMENT_AUTHORITY_RUNTIME_PRIVILEGES = {
  app: { native_app_payment_account: ['SELECT'], native_app_payment_evidence: ['SELECT', 'INSERT'] },
  admin: { native_app_payment_account: ['SELECT', 'INSERT'], native_app_payment_evidence: [] },
} as const;
const accountBody = `BEGIN
  RAISE EXCEPTION 'Native App payment account evidence is immutable' USING ERRCODE='42501';
END`;
const evidenceBody = `BEGIN
  RAISE EXCEPTION 'Native App payment order evidence is immutable' USING ERRCODE='42501';
END`;

/** Explicit maintenance bundle only, never request-time DDL. A blank mch_id
 * records that the fresh source had no merchant binding. app_id is the canonical
 * JSON.stringify(AppID) text, not a raw decoded string (including escaped NUL).
 * The service must verify canonical JSON and compare the decoded public tuple.
 * A blank merchant is NOT a wildcard,
 * an authorization for a later merchant, or proof of an order's original pair.
 * Public tuple/signature and evidence payload semantics belong to the service;
 * neither table stores an AppSecret, APIv3 key or merchant private key. */
export const NATIVE_APP_PAYMENT_AUTHORITY_SQL = `
CREATE TABLE public.native_app_payment_account (
  account_id varchar(64) NOT NULL,
  app_id varchar(5000) NOT NULL,
  mch_id varchar(32) NOT NULL,
  operation_id uuid NOT NULL,
  actor_id integer NOT NULL,
  source_revision varchar(64) NOT NULL,
  format_version smallint NOT NULL,
  created_at bigint NOT NULL,
  signature varchar(64) NOT NULL,
  CONSTRAINT napa_pk PRIMARY KEY(account_id),
  CONSTRAINT napa_id_ck CHECK(account_id ~ '^[a-f0-9]{64}$'),
  CONSTRAINT napa_app_id_ck CHECK(app_id <> ''),
  CONSTRAINT napa_mch_id_ck CHECK(mch_id = '' OR mch_id ~ '^[0-9]{1,32}$'),
  CONSTRAINT napa_operation_id_ck CHECK(operation_id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  CONSTRAINT napa_actor_id_ck CHECK(actor_id > 0),
  CONSTRAINT napa_source_revision_ck CHECK(source_revision ~ '^[a-f0-9]{64}$'),
  CONSTRAINT napa_format_ck CHECK(format_version = 1),
  CONSTRAINT napa_created_ck CHECK(created_at > 0),
  CONSTRAINT napa_signature_ck CHECK(signature ~ '^[a-f0-9]{64}$')
);
CREATE TABLE public.native_app_payment_evidence (
  evidence_id varchar(192) NOT NULL,
  order_no varchar(64) NOT NULL,
  kind varchar(16) NOT NULL,
  format_version smallint NOT NULL,
  payload jsonb NOT NULL,
  created_at bigint NOT NULL,
  signature varchar(64) NOT NULL,
  CONSTRAINT nape_pk PRIMARY KEY(evidence_id),
  CONSTRAINT nape_order_ck CHECK(order_no ~ '^[A-Za-z0-9_-]{2,64}$'),
  CONSTRAINT nape_kind_ck CHECK(kind IN ('initiation','callback','signed_query')),
  CONSTRAINT nape_format_ck CHECK(format_version = 1),
  CONSTRAINT nape_payload_ck CHECK(jsonb_typeof(payload)='object'),
  CONSTRAINT nape_created_ck CHECK(created_at > 0),
  CONSTRAINT nape_signature_ck CHECK(signature ~ '^[a-f0-9]{64}$')
);
CREATE FUNCTION public.native_app_payment_account_immutable_v1() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $napa_immutable$${accountBody}$napa_immutable$;
CREATE FUNCTION public.native_app_payment_evidence_immutable_v1() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $nape_immutable$${evidenceBody}$nape_immutable$;
CREATE TRIGGER napa_immutable_rows BEFORE UPDATE OR DELETE ON public.native_app_payment_account
FOR EACH ROW EXECUTE FUNCTION public.native_app_payment_account_immutable_v1();
CREATE TRIGGER napa_immutable_truncate BEFORE TRUNCATE ON public.native_app_payment_account
FOR EACH STATEMENT EXECUTE FUNCTION public.native_app_payment_account_immutable_v1();
CREATE TRIGGER nape_immutable_rows BEFORE UPDATE OR DELETE ON public.native_app_payment_evidence
FOR EACH ROW EXECUTE FUNCTION public.native_app_payment_evidence_immutable_v1();
CREATE TRIGGER nape_immutable_truncate BEFORE TRUNCATE ON public.native_app_payment_evidence
FOR EACH STATEMENT EXECUTE FUNCTION public.native_app_payment_evidence_immutable_v1();
REVOKE ALL ON TABLE public.native_app_payment_account, public.native_app_payment_evidence FROM PUBLIC;
REVOKE ALL ON FUNCTION public.native_app_payment_account_immutable_v1(), public.native_app_payment_evidence_immutable_v1() FROM PUBLIC;
`;

const columns = {
  native_app_payment_account: [[1, 'account_id', 'character varying(64)', true, '"default"'],
    [2, 'app_id', 'character varying(5000)', true, '"default"'], [3, 'mch_id', 'character varying(32)', true, '"default"'],
    [4, 'operation_id', 'uuid', true, null], [5, 'actor_id', 'integer', true, null],
    [6, 'source_revision', 'character varying(64)', true, '"default"'], [7, 'format_version', 'smallint', true, null],
    [8, 'created_at', 'bigint', true, null], [9, 'signature', 'character varying(64)', true, '"default"']],
  native_app_payment_evidence: [[1, 'evidence_id', 'character varying(192)', true, '"default"'],
    [2, 'order_no', 'character varying(64)', true, '"default"'], [3, 'kind', 'character varying(16)', true, '"default"'],
    [4, 'format_version', 'smallint', true, null], [5, 'payload', 'jsonb', true, null],
    [6, 'created_at', 'bigint', true, null], [7, 'signature', 'character varying(64)', true, '"default"']],
};
export const NATIVE_APP_PAYMENT_AUTHORITY_EXPECTED_CONSTRAINTS: Record<keyof typeof columns, Record<string, string>> = {
  native_app_payment_account: {
    napa_pk: 'PRIMARY KEY (account_id)',
    napa_id_ck: "CHECK (((account_id)::text ~ '^[a-f0-9]{64}$'::text))",
    napa_app_id_ck: "CHECK (((app_id)::text <> ''::text))",
    napa_mch_id_ck: "CHECK ((((mch_id)::text = ''::text) OR ((mch_id)::text ~ '^[0-9]{1,32}$'::text)))",
    napa_operation_id_ck: "CHECK (((operation_id)::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'::text))",
    napa_actor_id_ck: 'CHECK ((actor_id > 0))',
    napa_source_revision_ck: "CHECK (((source_revision)::text ~ '^[a-f0-9]{64}$'::text))",
    napa_format_ck: 'CHECK ((format_version = 1))',
    napa_created_ck: 'CHECK ((created_at > 0))',
    napa_signature_ck: "CHECK (((signature)::text ~ '^[a-f0-9]{64}$'::text))",
  },
  native_app_payment_evidence: {
    nape_pk: 'PRIMARY KEY (evidence_id)',
    nape_order_ck: "CHECK (((order_no)::text ~ '^[A-Za-z0-9_-]{2,64}$'::text))",
    nape_kind_ck: "CHECK (((kind)::text = ANY ((ARRAY['initiation'::character varying, 'callback'::character varying, 'signed_query'::character varying])::text[])))",
    nape_format_ck: 'CHECK ((format_version = 1))',
    nape_payload_ck: "CHECK ((jsonb_typeof(payload) = 'object'::text))",
    nape_created_ck: 'CHECK ((created_at > 0))',
    nape_signature_ck: "CHECK (((signature)::text ~ '^[a-f0-9]{64}$'::text))",
  },
};

function grants(value: unknown): Grant[] | null {
  if (!Array.isArray(value)) return null;
  const result: Grant[] = [];
  for (const item of value) {
    if (!Array.isArray(item) || item.length !== 3 || typeof item[0] !== 'string'
      || !['SELECT', 'INSERT'].includes(item[1]) || item[2] !== false) return null;
    try { pricingIdentifier(item[0]); } catch { return null; }
    result.push(item as Grant);
  }
  return result;
}
const sameGrants = (actual: Grant[], expected: Grant[]) => JSON.stringify(actual.map(row => JSON.stringify(row)).sort())
  === JSON.stringify(expected.map(row => JSON.stringify(row)).sort());

async function inspectCatalog(tx: Query, names?: Names): Promise<Catalog | null> {
  if (names) {
    try { [names.maintenance, names.app, names.admin].forEach(pricingIdentifier); } catch { return null; }
    if (new Set([names.maintenance, names.app, names.admin]).size !== 3) return null;
  }
  let owner: string | null = null;
  const acl = new Map<keyof typeof columns, Grant[]>();
  for (const name of Object.keys(columns) as Array<keyof typeof columns>) {
    const prefix = name === 'native_app_payment_account' ? 'napa' : 'nape';
    const body = prefix === 'napa' ? accountBody : evidenceBody;
    const expected = NATIVE_APP_PAYMENT_AUTHORITY_EXPECTED_CONSTRAINTS[name];
    const [row] = await tx.execute(sql`SELECT pg_catalog.pg_get_userbyid(c.relowner) AS owner,
      current_setting('server_version_num')::integer/10000=16 AND current_setting('session_replication_role')='origin'
      AND c.relnamespace='public'::regnamespace AND c.relkind='r' AND c.relpersistence='p'
      AND NOT c.relispartition AND NOT c.relrowsecurity AND NOT c.relforcerowsecurity
      AND c.relnatts=${columns[name].length} AND c.relchecks=${Object.keys(expected).length - 1}
      AND c.reloptions IS NULL AND c.relreplident='d' AND c.reltablespace=0
      AND c.relam=(SELECT oid FROM pg_catalog.pg_am WHERE amname='heap')
      AND EXISTS(SELECT 1 FROM pg_catalog.pg_roles r WHERE r.oid=c.relowner AND r.rolsuper
        AND (${names?.maintenance ?? null}::text IS NULL OR r.rolname=${names?.maintenance ?? null}::text))
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_inherits WHERE inhrelid=c.oid OR inhparent=c.oid)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_rewrite WHERE ev_class=c.oid)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_policy WHERE polrelid=c.oid)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_constraint WHERE confrelid=c.oid)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid=c.oid AND contype NOT IN ('p','c','n'))
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_attribute WHERE attrelid=c.oid AND attnum>0
        AND (attisdropped OR atthasdef OR attidentity<>'' OR attgenerated<>'' OR attacl IS NOT NULL)) AS safe,
      (SELECT jsonb_agg(jsonb_build_array(attnum,attname,format_type(atttypid,atttypmod),attnotnull,
        CASE WHEN attcollation=0 THEN NULL ELSE attcollation::regcollation::text END) ORDER BY attnum)
        FROM pg_catalog.pg_attribute WHERE attrelid=c.oid AND attnum>0) AS columns,
      (SELECT count(*)=${Object.keys(expected).length} AND bool_and(convalidated AND NOT condeferrable AND NOT condeferred
        AND conislocal AND coninhcount=0 AND conparentid=0) FROM pg_catalog.pg_constraint WHERE conrelid=c.oid AND contype IN ('p','c')) AS constraint_count,
      (SELECT jsonb_object_agg(conname,pg_get_constraintdef(oid,false)) FROM pg_catalog.pg_constraint
        WHERE conrelid=c.oid AND contype IN ('p','c')) AS constraints,
      (SELECT count(*)=1 AND bool_and(indisprimary AND indisunique AND indisvalid AND indisready AND indislive
        AND indimmediate AND NOT indisexclusion AND NOT indisclustered AND NOT indisreplident
        AND indkey::text='1' AND indnatts=1 AND indnkeyatts=1
        AND indoption::text='0' AND NOT indnullsnotdistinct AND indexprs IS NULL AND indpred IS NULL
        AND indcollation::text=(SELECT oid::text FROM pg_catalog.pg_collation WHERE collname='default' AND collnamespace='pg_catalog'::regnamespace)
        AND indclass::text=(SELECT oid::text FROM pg_catalog.pg_opclass WHERE opcname='text_ops' AND opcnamespace='pg_catalog'::regnamespace
          AND opcmethod=(SELECT oid FROM pg_catalog.pg_am WHERE amname='btree'))
        AND EXISTS(SELECT 1 FROM pg_catalog.pg_class i WHERE i.oid=indexrelid AND i.relname=${prefix + '_pk'}
          AND i.relkind='i' AND i.relpersistence='p' AND i.reloptions IS NULL AND i.reltablespace=0 AND i.relowner=c.relowner
          AND i.relam=(SELECT oid FROM pg_catalog.pg_am WHERE amname='btree')))
        FROM pg_catalog.pg_index WHERE indrelid=c.oid) AS indexes,
      (SELECT count(*)=2 AND bool_and(NOT t.tgisinternal AND t.tgenabled='O' AND t.tgnargs=0 AND t.tgqual IS NULL
        AND t.tgconstraint=0 AND t.tgfoid=f.oid AND t.tgattr::text='' AND t.tgoldtable IS NULL AND t.tgnewtable IS NULL
        AND ((t.tgname=${prefix + '_immutable_rows'} AND t.tgtype=27)
          OR (t.tgname=${prefix + '_immutable_truncate'} AND t.tgtype=34)))
        FROM pg_catalog.pg_trigger t WHERE t.tgrelid=c.oid) AS triggers,
      f.proowner=c.relowner AND f.prosrc=${body} AND f.prorettype='pg_catalog.trigger'::regtype
      AND f.pronargs=0 AND f.proargtypes::text='' AND NOT f.prosecdef AND NOT f.proleakproof AND f.provolatile='v'
      AND f.prokind='f' AND f.proconfig=ARRAY['search_path=pg_catalog'] AND NOT f.proisstrict AND NOT f.proretset
      AND f.proparallel='u' AND f.procost=100 AND f.prorows=0 AND f.prosupport=0
      AND f.provariadic=0 AND f.pronargdefaults=0 AND f.proargdefaults IS NULL
      AND f.proallargtypes IS NULL AND f.proargmodes IS NULL AND f.proargnames IS NULL
      AND f.probin IS NULL AND f.prosqlbody IS NULL AND f.protrftypes IS NULL
      AND f.prolang=(SELECT oid FROM pg_catalog.pg_language WHERE lanname='plpgsql')
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_proc other WHERE other.pronamespace=f.pronamespace AND other.proname=f.proname AND other.oid<>f.oid)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_trigger WHERE tgfoid=f.oid AND tgrelid<>c.oid)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.aclexplode(COALESCE(f.proacl,pg_catalog.acldefault('f',f.proowner))) a
        WHERE a.grantee<>f.proowner) AS function,
      NOT EXISTS(SELECT 1 FROM pg_catalog.aclexplode(COALESCE(c.relacl,pg_catalog.acldefault('r',c.relowner))) a
        LEFT JOIN pg_catalog.pg_roles r ON r.oid=a.grantee WHERE a.grantee<>c.relowner
          AND (a.grantee=0 OR a.grantor<>c.relowner OR a.is_grantable OR a.privilege_type NOT IN ('SELECT','INSERT')
            OR NOT r.rolcanlogin OR r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolinherit OR r.rolreplication OR r.rolbypassrls
            OR EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members WHERE member=r.oid OR roleid=r.oid))) AS acl_safe,
      COALESCE((SELECT jsonb_agg(jsonb_build_array(r.rolname,a.privilege_type,a.is_grantable) ORDER BY r.rolname,a.privilege_type)
        FROM pg_catalog.aclexplode(COALESCE(c.relacl,pg_catalog.acldefault('r',c.relowner))) a
        LEFT JOIN pg_catalog.pg_roles r ON r.oid=a.grantee WHERE a.grantee<>c.relowner),'[]'::jsonb) AS grants
      FROM pg_catalog.pg_class c JOIN pg_catalog.pg_proc f ON f.oid=to_regprocedure(${'public.' + name + '_immutable_v1()'})
      WHERE c.oid=to_regclass(${'public.' + name})`);
    if (!row || ['safe', 'constraint_count', 'indexes', 'triggers', 'function', 'acl_safe'].some(key => row[key] !== true)) return null;
    if (typeof row.owner !== 'string' || owner !== null && owner !== row.owner) return null;
    owner = row.owner;
    if (JSON.stringify(row.columns) !== JSON.stringify(columns[name])) return null;
    const actual = row.constraints as Record<string, string> | undefined;
    if (!actual || Object.keys(actual).length !== Object.keys(expected).length
      || Object.entries(expected).some(([key, value]) => actual[key] !== value)) return null;
    const parsed = grants(row.grants); if (!parsed) return null; acl.set(name, parsed);
  }
  if (!owner) return null;
  const account = acl.get('native_app_payment_account')!, evidence = acl.get('native_app_payment_evidence')!;
  let app: string | null = null, admin: string | null = null;
  if (account.length || evidence.length) {
    const accountInserts = account.filter(row => row[1] === 'INSERT'), evidenceInserts = evidence.filter(row => row[1] === 'INSERT');
    if (accountInserts.length !== 1 || evidenceInserts.length !== 1) return null;
    app = evidenceInserts[0][0]; admin = accountInserts[0][0];
    if (new Set([owner, app, admin]).size !== 3
      || !sameGrants(account, [[app, 'SELECT', false], [admin, 'SELECT', false], [admin, 'INSERT', false]])
      || !sameGrants(evidence, [[app, 'SELECT', false], [app, 'INSERT', false]])) return null;
  }
  // The owner-only shape is permitted only for the installer's pre-GRANT check.
  // Runtime readiness below requires the complete two-role commissioned shape.
  if (names && (owner !== names.maintenance || app !== names.app || admin !== names.admin)) return null;
  const [inventory] = await tx.execute(sql`SELECT
    NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class WHERE relnamespace='public'::regnamespace
      AND (starts_with(relname,'native_app_payment_') OR starts_with(relname,'napa_') OR starts_with(relname,'nape_'))
      AND relname NOT IN ('native_app_payment_account','native_app_payment_evidence','napa_pk','nape_pk'))
    AND (SELECT count(*)=2 FROM pg_catalog.pg_proc WHERE pronamespace='public'::regnamespace AND starts_with(proname,'native_app_payment_'))
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_proc WHERE pronamespace='public'::regnamespace
      AND (starts_with(proname,'napa_') OR starts_with(proname,'nape_')))
    AND (SELECT count(*)=4 AND bool_and(t.typowner=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=${owner})
      AND ((t.typtype='c' AND t.typrelid=to_regclass('public.' || t.typname)
        AND EXISTS(SELECT 1 FROM pg_catalog.pg_class c WHERE c.oid=t.typrelid AND c.reltype=t.oid))
      OR (t.typtype='b' AND EXISTS(SELECT 1 FROM pg_catalog.pg_type e WHERE e.oid=t.typelem
        AND e.typarray=t.oid AND t.typname='_' || e.typname
        AND e.typrelid IN (to_regclass('public.native_app_payment_account'),to_regclass('public.native_app_payment_evidence'))))))
      FROM pg_catalog.pg_type t WHERE t.typnamespace='public'::regnamespace
      AND t.typname IN ('native_app_payment_account','native_app_payment_evidence','_native_app_payment_account','_native_app_payment_evidence'))
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_type WHERE typnamespace='public'::regnamespace
      AND (starts_with(typname,'native_app_payment_') OR starts_with(typname,'_native_app_payment_')
        OR starts_with(typname,'napa_') OR starts_with(typname,'nape_'))
      AND typname NOT IN ('native_app_payment_account','native_app_payment_evidence','_native_app_payment_account','_native_app_payment_evidence'))
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_constraint WHERE connamespace='public'::regnamespace
      AND (starts_with(conname,'napa_') OR starts_with(conname,'nape_') OR starts_with(conname,'native_app_payment_'))
      AND conrelid NOT IN (to_regclass('public.native_app_payment_account'),to_regclass('public.native_app_payment_evidence')))
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_trigger WHERE (starts_with(tgname,'napa_') OR starts_with(tgname,'nape_')
      OR starts_with(tgname,'native_app_payment_')) AND tgrelid NOT IN
      (to_regclass('public.native_app_payment_account'),to_regclass('public.native_app_payment_evidence')))
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_default_acl d CROSS JOIN LATERAL pg_catalog.aclexplode(d.defaclacl) a
      WHERE (d.defaclrole=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=${owner})
        AND d.defaclnamespace IN (0,'public'::regnamespace) AND d.defaclobjtype IN ('r','f','S') AND a.grantee<>d.defaclrole)
      OR a.grantee IN (SELECT oid FROM pg_catalog.pg_roles WHERE rolname IN (${app},${admin}))
      OR (a.grantee=0 AND d.defaclobjtype IN ('r','S'))) AS safe`);
  return inventory?.safe === true ? { maintenance: owner, app, admin } : null;
}

/** Exact PG16 catalog and direct ACL inspection. No business HMAC, current
 * actor authorization, SQL mutation, repair or original-order proof is implied. */
export async function inspectNativeAppPaymentAuthority(tx: Query, names?: Names): Promise<boolean> {
  return await inspectCatalog(tx, names) !== null;
}

/** Caller-owned restricted LOGIN transaction only. The commissioning gate is
 * distinct from account rotation731664 and remains held through caller commit. */
export async function assertNativeAppPaymentAuthorityReady(tx: Query, kind: 'app' | 'admin'): Promise<void> {
  try {
    if (Object.hasOwn(tx, '$client') || !['app', 'admin'].includes(kind)) throw Error('Native App payment readiness requires a caller-owned runtime transaction');
    const [gate] = await tx.execute(sql`SELECT pg_try_advisory_xact_lock_shared(731663,0) AS locked`);
    if (gate?.locked !== true) throw Error('Native App payment authority maintenance is busy');
    const catalog = await inspectCatalog(tx);
    if (!catalog?.app || !catalog.admin) throw Error('Native App payment authority catalog or ACL is absent or drifted');
    const expectedRole = catalog[kind];
    const [identity] = await tx.execute(sql`SELECT current_user=${expectedRole} AND current_user=session_user
      AND (SELECT r.rolname FROM pg_catalog.pg_stat_activity a JOIN pg_catalog.pg_roles r ON r.oid=a.usesysid WHERE a.pid=pg_backend_pid())=current_user
      AND r.rolcanlogin AND NOT(r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolinherit OR r.rolreplication OR r.rolbypassrls)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members WHERE member=r.oid OR roleid=r.oid)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_shdepend WHERE refclassid='pg_catalog.pg_authid'::regclass AND refobjid=r.oid AND deptype='o')
      AND NOT pg_catalog.has_database_privilege(r.oid,current_database(),'CREATE')
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_namespace n WHERE n.nspname NOT LIKE 'pg_%' AND pg_catalog.has_schema_privilege(r.oid,n.oid,'CREATE'))
      AND NOT pg_catalog.has_parameter_privilege(r.oid,'session_replication_role','SET,ALTER SYSTEM') AS ready
      FROM pg_catalog.pg_roles r WHERE r.rolname=current_user`);
    if (identity?.ready !== true) throw Error('Native App payment runtime identity is unsafe');
    for (const name of Object.keys(columns) as Array<keyof typeof columns>) {
      const privileges: readonly string[] = NATIVE_APP_PAYMENT_AUTHORITY_RUNTIME_PRIVILEGES[kind][name];
      const [access] = await tx.execute(sql`SELECT
        pg_catalog.has_table_privilege(current_user,c.oid,'SELECT')=${privileges.some(value => value === 'SELECT')}
        AND pg_catalog.has_table_privilege(current_user,c.oid,'INSERT')=${privileges.some(value => value === 'INSERT')}
        AND NOT pg_catalog.has_table_privilege(current_user,c.oid,'UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
        AND NOT pg_catalog.has_table_privilege(current_user,c.oid,'SELECT WITH GRANT OPTION,INSERT WITH GRANT OPTION')
        AND NOT pg_catalog.has_function_privilege(current_user,to_regprocedure(${'public.' + name + '_immutable_v1()'}),'EXECUTE') AS ready
        FROM pg_catalog.pg_class c WHERE c.oid=to_regclass(${'public.' + name})`);
      if (access?.ready !== true) throw Error('Native App payment runtime table privileges are unsafe');
    }
  } catch (cause) {
    throw Object.assign(new ServiceUnavailableException('原生App支付账号历史、原单见证或运行权限尚未就绪'), { cause });
  }
}
