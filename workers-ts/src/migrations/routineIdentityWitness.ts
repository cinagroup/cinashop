import { sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { ServiceUnavailableException } from '@/utils/errors';

/** Explicit maintenance definition only. No startup/request DDL, historical
 * backfill, UID rewrite, provider secret, session key or original-order claim.
 * Runtime commissioning and the dedicated Mini author bundle remain separate. */
export const ROUTINE_IDENTITY_WITNESS_IMMUTABLE_BODY = `BEGIN
  RAISE EXCEPTION 'Routine identity observations are immutable' USING ERRCODE='42501';
END`;
export const ROUTINE_IDENTITY_WITNESS_SQL = `
CREATE TABLE public.routine_identity_witness (
  observation_id uuid NOT NULL,
  uid integer NOT NULL,
  binding_id integer NOT NULL,
  format_version smallint NOT NULL,
  observation jsonb NOT NULL,
  created_at bigint NOT NULL,
  signature varchar(64) NOT NULL,
  CONSTRAINT riw_pk PRIMARY KEY(observation_id),
  CONSTRAINT riw_id_ck CHECK(observation_id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  CONSTRAINT riw_uid_ck CHECK(uid > 0),
  CONSTRAINT riw_binding_ck CHECK(binding_id > 0),
  CONSTRAINT riw_format_ck CHECK(format_version = 1),
  CONSTRAINT riw_observation_ck CHECK(jsonb_typeof(observation)='object' AND octet_length(observation::text)<=8192),
  CONSTRAINT riw_created_ck CHECK(created_at > 0),
  CONSTRAINT riw_signature_ck CHECK(signature ~ '^[a-f0-9]{64}$')
);
CREATE INDEX riw_binding_latest ON public.routine_identity_witness(uid,binding_id,created_at DESC,observation_id);
CREATE FUNCTION public.routine_identity_witness_immutable_v1() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $riw$${ROUTINE_IDENTITY_WITNESS_IMMUTABLE_BODY}$riw$;
CREATE TRIGGER riw_immutable_rows BEFORE UPDATE OR DELETE ON public.routine_identity_witness
FOR EACH ROW EXECUTE FUNCTION public.routine_identity_witness_immutable_v1();
CREATE TRIGGER riw_immutable_truncate BEFORE TRUNCATE ON public.routine_identity_witness
FOR EACH STATEMENT EXECUTE FUNCTION public.routine_identity_witness_immutable_v1();
REVOKE ALL ON TABLE public.routine_identity_witness FROM PUBLIC;
REVOKE ALL ON FUNCTION public.routine_identity_witness_immutable_v1() FROM PUBLIC;
`;
const columns = [[1,'observation_id','uuid',true,null],[2,'uid','integer',true,null],
  [3,'binding_id','integer',true,null],[4,'format_version','smallint',true,null],
  [5,'observation','jsonb',true,null],[6,'created_at','bigint',true,null],
  [7,'signature','character varying(64)',true,'"default"']];
const constraints: Record<string,string> = {
  riw_pk: 'PRIMARY KEY (observation_id)',
  riw_id_ck: "CHECK (((observation_id)::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'::text))",
  riw_uid_ck: 'CHECK ((uid > 0))', riw_binding_ck: 'CHECK ((binding_id > 0))',
  riw_format_ck: 'CHECK ((format_version = 1))',
  riw_observation_ck: "CHECK (((jsonb_typeof(observation) = 'object'::text) AND (octet_length((observation)::text) <= 8192)))",
  riw_created_ck: 'CHECK ((created_at > 0))',
  riw_signature_ck: "CHECK (((signature)::text ~ '^[a-f0-9]{64}$'::text))",
};

/** Structural and immutable-storage inspection. This intentionally does not
 * claim independent runtime-role commissioning; the future author installer
 * must install exact App/Admin grants and audit the complete runtime profile. */
export async function inspectRoutineIdentityWitness(tx: Pick<DbClient,'execute'>): Promise<boolean> {
  const [row] = await tx.execute(sql`SELECT
    c.relkind='r' AND c.relpersistence='p' AND NOT c.relispartition AND NOT c.relrowsecurity
    AND NOT c.relforcerowsecurity AND c.relnatts=7 AND c.relchecks=7 AND c.reloptions IS NULL
    AND c.relreplident='d' AND c.relam=(SELECT oid FROM pg_catalog.pg_am WHERE amname='heap')
    AND EXISTS(SELECT 1 FROM pg_catalog.pg_roles r WHERE r.oid=c.relowner AND r.rolsuper)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_inherits WHERE inhrelid=c.oid OR inhparent=c.oid)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_rewrite WHERE ev_class=c.oid)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_attribute WHERE attrelid=c.oid AND attnum>0
      AND (attisdropped OR attgenerated<>'' OR attidentity<>'' OR atthasdef)) AS safe,
    (SELECT jsonb_agg(jsonb_build_array(a.attnum,a.attname,pg_catalog.format_type(a.atttypid,a.atttypmod),a.attnotnull,
      CASE WHEN a.attcollation=0 THEN NULL ELSE pg_catalog.to_jsonb(co.collname)::text END) ORDER BY a.attnum)
      FROM pg_catalog.pg_attribute a LEFT JOIN pg_catalog.pg_collation co ON co.oid=a.attcollation
      WHERE a.attrelid=c.oid AND a.attnum>0) AS columns,
    (SELECT jsonb_object_agg(conname,pg_catalog.pg_get_constraintdef(oid)) FROM pg_catalog.pg_constraint
      WHERE conrelid=c.oid AND convalidated AND NOT condeferrable AND NOT condeferred AND conislocal AND coninhcount=0) AS constraints,
    (SELECT count(*)=8 FROM pg_catalog.pg_constraint WHERE conrelid=c.oid) AS constraint_count,
    (SELECT count(*)=2 AND bool_and(i.indisvalid AND i.indisready AND i.indislive AND NOT i.indisclustered
      AND NOT i.indisreplident AND i.indpred IS NULL AND i.indexprs IS NULL
      AND ((ic.relname='riw_pk' AND i.indisprimary AND i.indisunique AND i.indkey::text='1' AND i.indoption::text='0')
        OR (ic.relname='riw_binding_latest' AND NOT i.indisprimary AND NOT i.indisunique
          AND i.indkey::text='2 3 6 1' AND i.indoption::text='0 0 3 0'))
      AND ic.relkind='i' AND ic.relpersistence='p' AND ic.reloptions IS NULL AND ic.relowner=c.relowner
      AND ic.relam=(SELECT oid FROM pg_catalog.pg_am WHERE amname='btree'))
      FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class ic ON ic.oid=i.indexrelid WHERE i.indrelid=c.oid) AS indexes,
    (SELECT count(*)=2 AND bool_and(NOT t.tgisinternal AND t.tgenabled='O' AND t.tgnargs=0 AND t.tgqual IS NULL
      AND t.tgconstraint=0 AND t.tgfoid=f.oid AND t.tgattr::text='' AND t.tgoldtable IS NULL AND t.tgnewtable IS NULL
      AND ((t.tgname='riw_immutable_rows' AND t.tgtype=27) OR (t.tgname='riw_immutable_truncate' AND t.tgtype=34)))
      FROM pg_catalog.pg_trigger t WHERE t.tgrelid=c.oid) AS triggers,
    f.proowner=c.relowner AND f.prosrc=${ROUTINE_IDENTITY_WITNESS_IMMUTABLE_BODY} AND f.prorettype='pg_catalog.trigger'::regtype
    AND f.pronargs=0 AND f.proargtypes::text='' AND NOT f.prosecdef AND NOT f.proleakproof AND f.provolatile='v'
    AND f.prokind='f' AND f.proconfig=ARRAY['search_path=pg_catalog'] AND f.proparallel='u' AND f.prosupport=0
    AND NOT f.proisstrict AND NOT f.proretset AND f.provariadic=0 AND f.pronargdefaults=0 AND f.proargdefaults IS NULL
    AND f.proallargtypes IS NULL AND f.proargmodes IS NULL AND f.proargnames IS NULL AND f.probin IS NULL AND f.prosqlbody IS NULL
    AND f.prolang=(SELECT oid FROM pg_catalog.pg_language WHERE lanname='plpgsql')
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_proc p WHERE p.pronamespace=f.pronamespace AND p.proname=f.proname AND p.oid<>f.oid)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.aclexplode(COALESCE(f.proacl,pg_catalog.acldefault('f',f.proowner))) a WHERE a.grantee<>f.proowner) AS function,
    NOT EXISTS(SELECT 1 FROM pg_catalog.aclexplode(COALESCE(c.relacl,pg_catalog.acldefault('r',c.relowner))) a
      WHERE a.grantee<>c.relowner AND (a.grantee=0 OR a.is_grantable OR a.privilege_type NOT IN ('SELECT','INSERT')))
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_attribute col CROSS JOIN LATERAL pg_catalog.aclexplode(col.attacl) a
      WHERE col.attrelid=c.oid AND a.grantee<>c.relowner) AS acl
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_proc f ON f.oid=to_regprocedure('public.routine_identity_witness_immutable_v1()')
    WHERE c.oid=to_regclass('public.routine_identity_witness')`);
  if (!row || ['safe','constraint_count','indexes','triggers','function','acl'].some(key => row[key]!==true)
    || JSON.stringify(row.columns)!==JSON.stringify(columns)) return false;
  const actual = row.constraints as Record<string,string> | undefined;
  return !!actual && Object.keys(actual).length===Object.keys(constraints).length
    && Object.entries(constraints).every(([key,value])=>actual[key]===value);
}

export async function assertRoutineIdentityWitnessReady(tx: Pick<DbClient,'execute'>): Promise<void> {
  if (Object.hasOwn(tx,'$client')) throw new ServiceUnavailableException('小程序身份观察需要调用方事务');
  const [gate] = await tx.execute(sql`SELECT pg_try_advisory_xact_lock_shared(731669,0) AS locked`);
  if (gate?.locked!==true || !await inspectRoutineIdentityWitness(tx))
    throw new ServiceUnavailableException('小程序身份观察存储未完整就绪');
}
