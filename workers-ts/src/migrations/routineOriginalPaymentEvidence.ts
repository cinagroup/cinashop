import { sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { ServiceUnavailableException } from '@/utils/errors';
import { pricingIdentifier } from './checkoutPricingLockCatalog';

type Query = Pick<DbClient, 'execute'>;
export interface RoutineOriginalPaymentEvidenceNames { maintenance: string; app: string; admin: string }
export interface RoutineOriginalPaymentEvidenceCatalog {
  present: boolean;
  ready: boolean;
  binding: { maintenance: string; maintenanceOid: string; app: string | null; appOid: string | null } | null;
  failures: string[];
}
export const ROUTINE_ORIGINAL_PAYMENT_EVIDENCE_RUNTIME_PRIVILEGES = { app: ['SELECT', 'INSERT'], admin: [] } as const;
// Separate from identity witness731669, initiation731670 and author731667.
export const ROUTINE_ORIGINAL_PAYMENT_EVIDENCE_GATE = [731714, 0] as const;
export const ROUTINE_ORIGINAL_PAYMENT_EVIDENCE_IMMUTABLE_BODY = `BEGIN
  RAISE EXCEPTION 'Routine original payment evidence is immutable' USING ERRCODE='42501';
END`;

/** Explicit maintenance only. Storage does not authenticate caller JSON,
 * signatures, provider facts, local ownership or an original payment. Those
 * claims must be verified by the service before use. No FK, sequence, default,
 * expiration, account reassignment or request/startup installation exists. */
export const ROUTINE_ORIGINAL_PAYMENT_EVIDENCE_SQL = `
CREATE TABLE public.routine_original_payment_evidence (
  evidence_id varchar(64) NOT NULL,
  order_no varchar(64) NOT NULL,
  transaction_id varchar(100) NOT NULL,
  source varchar(16) NOT NULL,
  source_id varchar(128) NOT NULL,
  format_version smallint NOT NULL,
  payload jsonb NOT NULL,
  created_at bigint NOT NULL,
  signature varchar(64) NOT NULL,
  CONSTRAINT rope_pk PRIMARY KEY(evidence_id),
  CONSTRAINT rope_source_uq UNIQUE(source,source_id),
  CONSTRAINT rope_id_ck CHECK(evidence_id ~ '^[a-f0-9]{64}$'),
  CONSTRAINT rope_order_ck CHECK(order_no ~ '^[A-Za-z0-9_-]{2,64}$'),
  CONSTRAINT rope_transaction_ck CHECK(transaction_id ~ '^[A-Za-z0-9_-]{1,100}$'),
  CONSTRAINT rope_source_ck CHECK(source IN ('callback','signed_query')),
  CONSTRAINT rope_source_id_ck CHECK(source_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
  CONSTRAINT rope_format_ck CHECK(format_version = 1),
  CONSTRAINT rope_payload_ck CHECK(jsonb_typeof(payload)='object' AND octet_length(payload::text)<=16384),
  CONSTRAINT rope_created_ck CHECK(created_at > 0),
  CONSTRAINT rope_signature_ck CHECK(signature ~ '^[a-f0-9]{64}$')
);
CREATE INDEX rope_order_idx ON public.routine_original_payment_evidence(order_no,evidence_id);
CREATE INDEX rope_transaction_idx ON public.routine_original_payment_evidence(transaction_id,evidence_id);
CREATE FUNCTION public.routine_original_payment_evidence_immutable_v1() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $rope$${ROUTINE_ORIGINAL_PAYMENT_EVIDENCE_IMMUTABLE_BODY}$rope$;
CREATE TRIGGER rope_immutable_rows BEFORE UPDATE OR DELETE ON public.routine_original_payment_evidence
FOR EACH ROW EXECUTE FUNCTION public.routine_original_payment_evidence_immutable_v1();
CREATE TRIGGER rope_immutable_truncate BEFORE TRUNCATE ON public.routine_original_payment_evidence
FOR EACH STATEMENT EXECUTE FUNCTION public.routine_original_payment_evidence_immutable_v1();
REVOKE ALL ON TABLE public.routine_original_payment_evidence FROM PUBLIC;
REVOKE ALL ON FUNCTION public.routine_original_payment_evidence_immutable_v1() FROM PUBLIC;
`;
const columns = [[1, 'evidence_id', 'character varying(64)', true, '"default"'],
  [2, 'order_no', 'character varying(64)', true, '"default"'],
  [3, 'transaction_id', 'character varying(100)', true, '"default"'],
  [4, 'source', 'character varying(16)', true, '"default"'],
  [5, 'source_id', 'character varying(128)', true, '"default"'],
  [6, 'format_version', 'smallint', true, null], [7, 'payload', 'jsonb', true, null],
  [8, 'created_at', 'bigint', true, null], [9, 'signature', 'character varying(64)', true, '"default"']];
export const ROUTINE_ORIGINAL_PAYMENT_EVIDENCE_EXPECTED_CONSTRAINTS: Record<string, string> = {
  rope_pk: 'PRIMARY KEY (evidence_id)', rope_source_uq: 'UNIQUE (source, source_id)',
  rope_id_ck: "CHECK (((evidence_id)::text ~ '^[a-f0-9]{64}$'::text))",
  rope_order_ck: "CHECK (((order_no)::text ~ '^[A-Za-z0-9_-]{2,64}$'::text))",
  rope_transaction_ck: "CHECK (((transaction_id)::text ~ '^[A-Za-z0-9_-]{1,100}$'::text))",
  rope_source_ck: "CHECK (((source)::text = ANY ((ARRAY['callback'::character varying, 'signed_query'::character varying])::text[])))",
  rope_source_id_ck: "CHECK (((source_id)::text ~ '^[A-Za-z0-9._:-]{1,128}$'::text))",
  rope_format_ck: 'CHECK ((format_version = 1))',
  rope_payload_ck: "CHECK (((jsonb_typeof(payload) = 'object'::text) AND (octet_length((payload)::text) <= 16384)))",
  rope_created_ck: 'CHECK ((created_at > 0))',
  rope_signature_ck: "CHECK (((signature)::text ~ '^[a-f0-9]{64}$'::text))",
};
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Read-only exact PG16 catalog/namespace inspection. With no names, only the
 * owner-only pre-GRANT state or one restricted App's exact SELECT/INSERT ACL is
 * accepted. Supplied names require the commissioned shape, including no Admin
 * or other principal grant. This never proves the payload's business claims. */
export async function inspectRoutineOriginalPaymentEvidenceCatalog(tx: Query,
  declaredNames?: RoutineOriginalPaymentEvidenceNames): Promise<RoutineOriginalPaymentEvidenceCatalog> {
  const names = declaredNames ? { maintenance: declaredNames.maintenance, app: declaredNames.app, admin: declaredNames.admin } : undefined;
  if (names) {
    try {
      [names.maintenance, names.app, names.admin].forEach(pricingIdentifier);
      if (new Set([names.maintenance, names.app, names.admin]).size !== 3) throw Error('Distinct names required');
    } catch { return { present: true, ready: false, binding: null, failures: ['binding'] }; }
  }
  const [inventory] = await tx.execute<{ present: boolean; namespace: boolean }>(sql`SELECT
    EXISTS(SELECT 1 FROM pg_catalog.pg_class WHERE relnamespace='public'::regnamespace
      AND (starts_with(relname,'routine_original_payment_evidence') OR starts_with(relname,'rope_')))
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_proc WHERE pronamespace='public'::regnamespace
      AND (starts_with(proname,'routine_original_payment_evidence') OR starts_with(proname,'rope_')))
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_type WHERE typnamespace='public'::regnamespace
      AND (starts_with(typname,'routine_original_payment_evidence') OR starts_with(typname,'_routine_original_payment_evidence')
        OR starts_with(typname,'rope_') OR starts_with(typname,'_rope_')))
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_constraint WHERE connamespace='public'::regnamespace
      AND (starts_with(conname,'routine_original_payment_evidence') OR starts_with(conname,'rope_')))
    OR EXISTS(SELECT 1 FROM pg_catalog.pg_trigger WHERE starts_with(tgname,'routine_original_payment_evidence') OR starts_with(tgname,'rope_')) AS present,
    NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class WHERE relnamespace='public'::regnamespace
      AND (starts_with(relname,'routine_original_payment_evidence') OR starts_with(relname,'rope_'))
      AND relname NOT IN ('routine_original_payment_evidence','rope_pk','rope_source_uq','rope_order_idx','rope_transaction_idx'))
    AND (SELECT count(*)=1 FROM pg_catalog.pg_proc WHERE pronamespace='public'::regnamespace
      AND (starts_with(proname,'routine_original_payment_evidence') OR starts_with(proname,'rope_')))
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_constraint WHERE connamespace='public'::regnamespace
      AND (starts_with(conname,'routine_original_payment_evidence') OR starts_with(conname,'rope_'))
      AND conrelid IS DISTINCT FROM to_regclass('public.routine_original_payment_evidence'))
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_trigger WHERE
      (starts_with(tgname,'routine_original_payment_evidence') OR starts_with(tgname,'rope_'))
      AND tgrelid IS DISTINCT FROM to_regclass('public.routine_original_payment_evidence')) AS namespace`);
  if (!inventory || typeof inventory.present !== 'boolean')
    return { present: true, ready: false, binding: null, failures: ['inventory'] };
  if (!inventory.present) return { present: false, ready: false, binding: null, failures: [] };
  const failures: string[] = [];
  const check = (key: string, value: boolean) => { if (!value) failures.push(key); };
  check('namespace', inventory.namespace === true);
  const [row] = await tx.execute<Record<string, unknown>>(sql`SELECT
    pg_catalog.pg_get_userbyid(c.relowner) AS maintenance,c.relowner::text AS maintenance_oid,
    current_setting('server_version_num')::integer/10000=16
    AND c.relkind='r' AND c.relpersistence='p' AND NOT c.relispartition AND NOT c.relrowsecurity AND NOT c.relforcerowsecurity
    AND c.relnatts=9 AND c.relchecks=9 AND c.reloptions IS NULL AND c.relreplident='d' AND c.reltablespace=0
    AND c.relam=(SELECT oid FROM pg_catalog.pg_am WHERE amname='heap')
    AND EXISTS(SELECT 1 FROM pg_catalog.pg_roles r WHERE r.oid=c.relowner AND r.rolsuper
      AND (${names?.maintenance ?? null}::text IS NULL OR r.rolname=${names?.maintenance ?? null}::text))
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_inherits WHERE inhrelid=c.oid OR inhparent=c.oid)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_rewrite WHERE ev_class=c.oid)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_policy WHERE polrelid=c.oid)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_constraint WHERE confrelid=c.oid)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_constraint WHERE conrelid=c.oid AND contype NOT IN ('p','u','c','n'))
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_attribute WHERE attrelid=c.oid AND attnum>0
      AND (attisdropped OR atthasdef OR attidentity<>'' OR attgenerated<>'' OR attacl IS NOT NULL))
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_attrdef WHERE adrelid=c.oid)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_depend WHERE classid='pg_catalog.pg_class'::regclass AND objid=c.oid AND deptype='e') AS safe,
    (SELECT jsonb_agg(jsonb_build_array(attnum,attname,format_type(atttypid,atttypmod),attnotnull,
      CASE WHEN attcollation=0 THEN NULL ELSE attcollation::regcollation::text END) ORDER BY attnum)
      FROM pg_catalog.pg_attribute WHERE attrelid=c.oid AND attnum>0) AS columns,
    (SELECT count(*)=11 AND bool_and(convalidated AND NOT condeferrable AND NOT condeferred AND conislocal
      AND coninhcount=0 AND conparentid=0 AND connamespace='public'::regnamespace)
      FROM pg_catalog.pg_constraint WHERE conrelid=c.oid AND contype IN ('p','u','c')) AS constraint_count,
    (SELECT jsonb_object_agg(conname,pg_get_constraintdef(oid,false)) FROM pg_catalog.pg_constraint
      WHERE conrelid=c.oid AND contype IN ('p','u','c')) AS constraints,
    (SELECT count(*)=4 AND bool_and(i.indisvalid AND i.indisready AND i.indislive AND i.indimmediate
      AND NOT i.indisexclusion AND NOT i.indisclustered AND NOT i.indisreplident AND NOT i.indnullsnotdistinct
      AND i.indexprs IS NULL AND i.indpred IS NULL AND i.indnatts=i.indnkeyatts
      AND ic.relkind='i' AND ic.relpersistence='p' AND ic.reloptions IS NULL AND ic.reltablespace=0
      AND ic.relowner=c.relowner AND ic.relnamespace=c.relnamespace AND ic.relacl IS NULL
      AND ic.relam=(SELECT oid FROM pg_catalog.pg_am WHERE amname='btree')
      AND i.indcollation::text=CASE WHEN i.indnkeyatts=1 THEN dc.oid::text ELSE dc.oid::text||' '||dc.oid::text END
      AND i.indclass::text=CASE WHEN i.indnkeyatts=1 THEN op.oid::text ELSE op.oid::text||' '||op.oid::text END
      AND ((ic.relname='rope_pk' AND i.indisprimary AND i.indisunique AND i.indnkeyatts=1 AND i.indkey::text='1' AND i.indoption::text='0')
        OR (ic.relname='rope_source_uq' AND NOT i.indisprimary AND i.indisunique AND i.indnkeyatts=2 AND i.indkey::text='4 5' AND i.indoption::text='0 0')
        OR (ic.relname='rope_order_idx' AND NOT i.indisprimary AND NOT i.indisunique AND i.indnkeyatts=2 AND i.indkey::text='2 1' AND i.indoption::text='0 0')
        OR (ic.relname='rope_transaction_idx' AND NOT i.indisprimary AND NOT i.indisunique AND i.indnkeyatts=2 AND i.indkey::text='3 1' AND i.indoption::text='0 0')))
      FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class ic ON ic.oid=i.indexrelid
      CROSS JOIN pg_catalog.pg_collation dc CROSS JOIN pg_catalog.pg_opclass op
      WHERE i.indrelid=c.oid AND dc.collname='default' AND dc.collnamespace='pg_catalog'::regnamespace
        AND op.opcname='text_ops' AND op.opcnamespace='pg_catalog'::regnamespace
        AND op.opcmethod=(SELECT oid FROM pg_catalog.pg_am WHERE amname='btree')) AS indexes,
    (SELECT count(*)=2 AND bool_and(NOT t.tgisinternal AND t.tgenabled='O' AND t.tgnargs=0 AND t.tgqual IS NULL
      AND t.tgconstraint=0 AND t.tgfoid=f.oid AND t.tgattr::text='' AND t.tgoldtable IS NULL AND t.tgnewtable IS NULL
      AND ((t.tgname='rope_immutable_rows' AND t.tgtype=27) OR (t.tgname='rope_immutable_truncate' AND t.tgtype=34)))
      FROM pg_catalog.pg_trigger t WHERE t.tgrelid=c.oid) AS triggers,
    f.proowner=c.relowner AND f.prosrc=${ROUTINE_ORIGINAL_PAYMENT_EVIDENCE_IMMUTABLE_BODY}
    AND f.prorettype='pg_catalog.trigger'::regtype AND f.pronargs=0 AND f.proargtypes::text=''
    AND NOT f.prosecdef AND NOT f.proleakproof AND f.provolatile='v' AND f.prokind='f'
    AND f.proconfig=ARRAY['search_path=pg_catalog'] AND NOT f.proisstrict AND NOT f.proretset AND f.proparallel='u'
    AND f.procost=100 AND f.prorows=0 AND f.prosupport=0 AND f.provariadic=0 AND f.pronargdefaults=0
    AND f.proargdefaults IS NULL AND f.proallargtypes IS NULL AND f.proargmodes IS NULL AND f.proargnames IS NULL
    AND f.probin IS NULL AND f.prosqlbody IS NULL AND f.protrftypes IS NULL
    AND f.prolang=(SELECT oid FROM pg_catalog.pg_language WHERE lanname='plpgsql' AND lanpltrusted)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_trigger WHERE tgfoid=f.oid AND tgrelid<>c.oid)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_depend WHERE classid='pg_catalog.pg_proc'::regclass AND objid=f.oid AND deptype='e')
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.aclexplode(COALESCE(f.proacl,pg_catalog.acldefault('f',f.proowner))) a
      WHERE a.grantee<>f.proowner OR a.grantor<>f.proowner) AS function,
    NOT EXISTS(SELECT 1 FROM pg_catalog.aclexplode(COALESCE(c.relacl,pg_catalog.acldefault('r',c.relowner))) a
      LEFT JOIN pg_catalog.pg_roles r ON r.oid=a.grantee WHERE a.grantee<>c.relowner
      AND (a.grantee=0 OR a.grantor<>c.relowner OR a.is_grantable OR a.privilege_type NOT IN ('SELECT','INSERT')
        OR NOT r.rolcanlogin OR r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolinherit OR r.rolreplication OR r.rolbypassrls
        OR EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members WHERE member=r.oid OR roleid=r.oid))) AS acl_safe,
    COALESCE((SELECT jsonb_agg(jsonb_build_array(r.rolname,r.oid::text,a.privilege_type,a.is_grantable)
      ORDER BY r.rolname COLLATE "C",a.privilege_type COLLATE "C")
      FROM pg_catalog.aclexplode(COALESCE(c.relacl,pg_catalog.acldefault('r',c.relowner))) a
      LEFT JOIN pg_catalog.pg_roles r ON r.oid=a.grantee WHERE a.grantee<>c.relowner),'[]'::jsonb) AS grants
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_proc f
      ON f.oid=to_regprocedure('public.routine_original_payment_evidence_immutable_v1()')
    WHERE c.oid=to_regclass('public.routine_original_payment_evidence')`);
  if (!row) return { present: true, ready: false, binding: null, failures: [...failures, 'catalog'] };
  for (const key of ['safe', 'constraint_count', 'indexes', 'triggers', 'function', 'acl_safe']) check(key, row[key] === true);
  check('columns', same(row.columns, columns));
  const actual = row.constraints as Record<string, string> | null;
  check('constraints', !!actual && Object.keys(actual).length === Object.keys(ROUTINE_ORIGINAL_PAYMENT_EVIDENCE_EXPECTED_CONSTRAINTS).length
    && Object.entries(ROUTINE_ORIGINAL_PAYMENT_EVIDENCE_EXPECTED_CONSTRAINTS).every(([key, value]) => actual[key] === value));
  const grants = row.grants as Array<[string, string, string, boolean]> | null;
  let app: string | null = null, appOid: string | null = null;
  if (Array.isArray(grants) && grants.length === 2 && grants.every(value => Array.isArray(value) && value.length === 4)
    && grants[0][0] === grants[1][0] && grants[0][1] === grants[1][1]
    && grants[0][2] === 'INSERT' && grants[1][2] === 'SELECT' && grants.every(value => value[3] === false)) {
    app = grants[0][0]; appOid = grants[0][1];
  } else check('acl', Array.isArray(grants) && grants.length === 0);
  const maintenance = typeof row.maintenance === 'string' ? row.maintenance : null;
  const maintenanceOid = typeof row.maintenance_oid === 'string' ? row.maintenance_oid : null;
  check('binding', maintenance !== null && maintenanceOid !== null && (app === null || app !== maintenance)
    && (!names || maintenance === names.maintenance && app === names.app));
  const [namespace] = await tx.execute<{ safe: boolean; roles: boolean }>(sql`SELECT
    (SELECT count(*)=2 AND bool_and(t.typowner=${maintenanceOid}::oid AND t.typacl IS NULL
      AND ((t.typname='routine_original_payment_evidence' AND t.typtype='c'
        AND t.typrelid=to_regclass('public.routine_original_payment_evidence')
        AND t.oid=(SELECT reltype FROM pg_catalog.pg_class WHERE oid=t.typrelid)
        AND t.typarray=to_regtype('public._routine_original_payment_evidence'))
      OR (t.typname='_routine_original_payment_evidence' AND t.typtype='b'
        AND t.typelem=to_regtype('public.routine_original_payment_evidence')
        AND t.oid=(SELECT typarray FROM pg_catalog.pg_type WHERE oid=t.typelem))))
      FROM pg_catalog.pg_type t WHERE t.typnamespace='public'::regnamespace
      AND (starts_with(t.typname,'routine_original_payment_evidence') OR starts_with(t.typname,'_routine_original_payment_evidence')
        OR starts_with(t.typname,'rope_') OR starts_with(t.typname,'_rope_')))
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_default_acl d CROSS JOIN LATERAL pg_catalog.aclexplode(d.defaclacl) a
      WHERE (d.defaclrole=${maintenanceOid}::oid AND d.defaclnamespace IN (0,'public'::regnamespace)
        AND d.defaclobjtype IN ('r','f','S') AND a.grantee<>d.defaclrole)
      OR a.grantee IN (SELECT oid FROM pg_catalog.pg_roles WHERE rolname IN (${app},${names?.admin ?? null}))
      OR (a.grantee=0 AND d.defaclobjtype IN ('r','S'))) AS safe,
    (SELECT count(*)=${names ? 2 : app ? 1 : 0} AND COALESCE(bool_and(r.rolcanlogin
      AND NOT(r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolinherit OR r.rolreplication OR r.rolbypassrls)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members WHERE member=r.oid OR roleid=r.oid)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_shdepend WHERE refclassid='pg_catalog.pg_authid'::regclass AND refobjid=r.oid AND deptype='o')
      AND pg_catalog.has_database_privilege(r.oid,current_database(),'CONNECT') AND pg_catalog.has_schema_privilege(r.oid,'public','USAGE')
      AND NOT pg_catalog.has_database_privilege(r.oid,current_database(),'CREATE')
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_namespace n WHERE n.nspname NOT LIKE 'pg_%' AND pg_catalog.has_schema_privilege(r.oid,n.oid,'CREATE'))
      AND NOT pg_catalog.has_parameter_privilege(r.oid,'session_replication_role','SET,ALTER SYSTEM')),true)
      FROM pg_catalog.pg_roles r WHERE r.rolname IN (${app},${names?.admin ?? null})) AS roles`);
  check('types_defaults', namespace?.safe === true);
  check('runtime_roles', namespace?.roles === true);
  const unique = [...new Set(failures)].sort();
  return { present: true, ready: unique.length === 0,
    binding: unique.length === 0 && maintenance && maintenanceOid ? { maintenance, maintenanceOid, app, appOid } : null, failures: unique };
}

export async function inspectRoutineOriginalPaymentEvidence(tx: Query, names?: RoutineOriginalPaymentEvidenceNames): Promise<boolean> {
  return (await inspectRoutineOriginalPaymentEvidenceCatalog(tx, names)).ready;
}

/** Caller-owned real App LOGIN transaction only. The independent shared gate
 * stays held through the business commit. It grants no authority and performs
 * no DDL, repair, data mutation or provider/ownership verification. */
export async function assertRoutineOriginalPaymentEvidenceReady(tx: Query): Promise<void> {
  try {
    if (Object.hasOwn(tx, '$client')) throw Error('Routine original payment evidence requires a caller-owned transaction');
    const [gate] = await tx.execute(sql`SELECT pg_try_advisory_xact_lock_shared(731714,0) AS locked`);
    if (gate?.locked !== true) throw Error('Routine original payment evidence maintenance is busy');
    const catalog = await inspectRoutineOriginalPaymentEvidenceCatalog(tx), binding = catalog.binding;
    if (!catalog.ready || !binding?.app || !binding.appOid) throw Error('Routine original payment evidence catalog or ACL is absent or drifted');
    const [identity] = await tx.execute(sql`SELECT current_user=session_user AND current_user=${binding.app}::name
      AND r.oid=${binding.appOid}::oid AND (SELECT usesysid FROM pg_catalog.pg_stat_activity WHERE pid=pg_backend_pid())=r.oid
      AND current_setting('server_version_num')::integer/10000=16 AND current_setting('transaction_isolation')='read committed'
      AND current_setting('transaction_read_only')='off' AND current_setting('session_replication_role')='origin'
      AND current_schema()='public' AND to_regclass('store_order')=to_regclass('public.store_order')
      AND to_regclass('user_recharge')=to_regclass('public.user_recharge') AND to_regclass('other_order')=to_regclass('public.other_order')
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_event_trigger WHERE evtenabled<>'D')
      AND r.rolcanlogin AND NOT(r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolinherit OR r.rolreplication OR r.rolbypassrls)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members WHERE member=r.oid OR roleid=r.oid)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_shdepend WHERE refclassid='pg_catalog.pg_authid'::regclass AND refobjid=r.oid AND deptype='o')
      AND pg_catalog.has_database_privilege(r.oid,current_database(),'CONNECT') AND pg_catalog.has_schema_privilege(r.oid,'public','USAGE')
      AND NOT pg_catalog.has_database_privilege(r.oid,current_database(),'CREATE')
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_namespace n WHERE n.nspname NOT LIKE 'pg_%' AND pg_catalog.has_schema_privilege(r.oid,n.oid,'CREATE'))
      AND NOT pg_catalog.has_parameter_privilege(r.oid,'session_replication_role','SET,ALTER SYSTEM')
      AND pg_catalog.has_table_privilege(r.oid,c.oid,'SELECT') AND pg_catalog.has_table_privilege(r.oid,c.oid,'INSERT')
      AND NOT pg_catalog.has_table_privilege(r.oid,c.oid,'UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      AND NOT pg_catalog.has_table_privilege(r.oid,c.oid,'SELECT WITH GRANT OPTION,INSERT WITH GRANT OPTION')
      AND NOT pg_catalog.has_function_privilege(r.oid,to_regprocedure('public.routine_original_payment_evidence_immutable_v1()'),'EXECUTE') AS ready
      FROM pg_catalog.pg_roles r CROSS JOIN pg_catalog.pg_class c
      WHERE r.rolname=current_user AND c.oid=to_regclass('public.routine_original_payment_evidence')`);
    if (identity?.ready !== true) throw Error('Routine original payment evidence runtime identity or privileges are unsafe');
  } catch (cause) {
    throw Object.assign(new ServiceUnavailableException('小程序原始支付证据或运行权限尚未就绪'), { cause });
  }
}
