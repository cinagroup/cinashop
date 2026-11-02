import { sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { outRequestHash } from '@/services/out/OutIdempotency';
import { pricingIdentifier } from './checkoutPricingLockCatalog';
import { MANAGER_RUNTIME_ROLE } from './managerRuntimePrivilegePlan';

type Query = Pick<DbClient, 'execute'>;
export interface ManagerAssignedWholeExpressAddon { receipts: true }
export interface ManagerAssignedFulfillmentNames { maintenance: string; manager?: string }
export interface ManagerAssignedFulfillmentBinding {
  database: string; databaseOid: string; maintenance: string; maintenanceOid: string;
  manager: string; managerOid: string; tableOid: string;
}
export interface ManagerAssignedFulfillmentInspection {
  present: boolean; ready: boolean; catalogReady: boolean; ownerOnly: boolean;
  binding: ManagerAssignedFulfillmentBinding | null; failures: string[];
}
export const MANAGER_ASSIGNED_FULFILLMENT_TABLE = 'manager_assigned_fulfillment_request';
export const MANAGER_ASSIGNED_FULFILLMENT_GATE = [731724, 0] as const;
export const MANAGER_ASSIGNED_FULFILLMENT_IMMUTABLE_BODY = `BEGIN
  RAISE EXCEPTION 'Manager assigned fulfillment receipt is immutable' USING ERRCODE='42501';
END`;

/** Success-only receipt storage. This is a controlled-writer ledger, not an
 * independent attestation of Manager authority, assignment, delivery or payment.
 * A business author must prove those facts and bind the actual outbox atomically.
 * No financial/inventory ownership changes and no provider dispatch occur here.
 * SQL's created_at default can be supplied explicitly; it is not provider time. */
export const MANAGER_ASSIGNED_FULFILLMENT_SQL = `
CREATE TABLE public.manager_assigned_fulfillment_request (
  actor_uid integer NOT NULL,
  request_key uuid NOT NULL,
  format_version smallint NOT NULL,
  kind varchar(32) NOT NULL,
  outcome varchar(32) NOT NULL,
  request_hash varchar(64) NOT NULL,
  target_store_id integer NOT NULL,
  staff_id integer NOT NULL,
  scope_key varchar(64) NOT NULL,
  root_order_id integer NOT NULL,
  order_id integer NOT NULL,
  customer_uid integer NOT NULL,
  financial_store_id integer NOT NULL,
  supplier_id integer NOT NULL,
  assignment_operation_id uuid NOT NULL,
  assignment_ordinal integer NOT NULL,
  assignment_payload_hash varchar(64) NOT NULL,
  assignment_source_hash varchar(64) NOT NULL,
  assignment_order_revision varchar(64) NOT NULL,
  expected_order_revision varchar(64) NOT NULL,
  post_order_revision varchar(64) NOT NULL,
  delivery_outbox_id integer NOT NULL,
  delivery_event_key varchar(128) NOT NULL,
  delivery_payload_hash varchar(64) NOT NULL,
  intent jsonb NOT NULL,
  created_at bigint DEFAULT pg_catalog.floor(extract(epoch FROM pg_catalog.clock_timestamp()))::bigint NOT NULL,
  CONSTRAINT mafr_pk PRIMARY KEY(actor_uid,request_key),
  CONSTRAINT mafr_order_uq UNIQUE(order_id),
  CONSTRAINT mafr_outbox_uq UNIQUE(delivery_outbox_id),
  CONSTRAINT mafr_actor_ck CHECK(actor_uid>0),
  CONSTRAINT mafr_request_key_ck CHECK(request_key::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  CONSTRAINT mafr_format_ck CHECK(format_version=1),
  CONSTRAINT mafr_kind_ck CHECK(kind='assigned_whole_express'),
  CONSTRAINT mafr_outcome_ck CHECK(outcome='delivery-recorded'),
  CONSTRAINT mafr_request_hash_ck CHECK(request_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT mafr_target_ck CHECK(target_store_id>0),
  CONSTRAINT mafr_staff_ck CHECK(staff_id>0),
  CONSTRAINT mafr_scope_ck CHECK(scope_key ~ '^[a-f0-9]{64}$'),
  CONSTRAINT mafr_root_ck CHECK(root_order_id>0 AND order_id=root_order_id),
  CONSTRAINT mafr_customer_ck CHECK(customer_uid>0),
  CONSTRAINT mafr_financial_ck CHECK(financial_store_id=0 AND supplier_id=0),
  CONSTRAINT mafr_assignment_operation_ck CHECK(assignment_operation_id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  CONSTRAINT mafr_assignment_ordinal_ck CHECK(assignment_ordinal BETWEEN 1 AND 64),
  CONSTRAINT mafr_assignment_payload_hash_ck CHECK(assignment_payload_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT mafr_assignment_source_hash_ck CHECK(assignment_source_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT mafr_assignment_revision_ck CHECK(assignment_order_revision ~ '^[a-f0-9]{64}$'),
  CONSTRAINT mafr_expected_revision_ck CHECK(expected_order_revision ~ '^[a-f0-9]{64}$' AND expected_order_revision=assignment_order_revision),
  CONSTRAINT mafr_post_revision_ck CHECK(post_order_revision ~ '^[a-f0-9]{64}$'),
  CONSTRAINT mafr_outbox_ck CHECK(delivery_outbox_id>0 AND delivery_event_key='order.delivery.notice:'||order_id::text),
  CONSTRAINT mafr_delivery_payload_hash_ck CHECK(delivery_payload_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT mafr_intent_ck CHECK(pg_catalog.jsonb_typeof(intent)='object' AND
    pg_catalog.octet_length(intent::text)<=8192 AND
    intent ?& ARRAY['version','order_id','store_id','scope_key','assignment_operation_id','assignment_ordinal','assignment_payload_hash','expected_assignment_source_hash','expected_order_revision','payload']::text[] AND
    intent-ARRAY['version','order_id','store_id','scope_key','assignment_operation_id','assignment_ordinal','assignment_payload_hash','expected_assignment_source_hash','expected_order_revision','payload']::text[]='{}'::jsonb AND
    intent->'version'='"merchant-assigned-whole-express-v1"'::jsonb AND
    intent->'order_id'=pg_catalog.to_jsonb(order_id) AND
    intent->'store_id'=pg_catalog.to_jsonb(target_store_id) AND
    intent->'scope_key'=pg_catalog.to_jsonb(scope_key) AND
    intent->'assignment_operation_id'=pg_catalog.to_jsonb(assignment_operation_id::text) AND
    intent->'assignment_ordinal'=pg_catalog.to_jsonb(assignment_ordinal) AND
    intent->'assignment_payload_hash'=pg_catalog.to_jsonb(assignment_payload_hash) AND
    intent->'expected_assignment_source_hash'=pg_catalog.to_jsonb(assignment_source_hash) AND
    intent->'expected_order_revision'=pg_catalog.to_jsonb(expected_order_revision) AND
    pg_catalog.jsonb_typeof(intent->'payload')='object' AND
    (intent->'payload') ?& ARRAY['type','express_record_type','delivery_name','delivery_code','delivery_id']::text[] AND
    (intent->'payload')-ARRAY['type','express_record_type','delivery_name','delivery_code','delivery_id']::text[]='{}'::jsonb AND
    intent->'payload'->'type'='1'::jsonb AND intent->'payload'->'express_record_type'='1'::jsonb AND
    pg_catalog.jsonb_typeof(intent->'payload'->'delivery_name')='string' AND
    pg_catalog.char_length(intent->'payload'->>'delivery_name') BETWEEN 1 AND 64 AND
    pg_catalog.btrim(intent->'payload'->>'delivery_name')=intent->'payload'->>'delivery_name' AND
    (intent->'payload'->>'delivery_name') !~ '[[:cntrl:]]' AND
    pg_catalog.jsonb_typeof(intent->'payload'->'delivery_code')='string' AND
    pg_catalog.char_length(intent->'payload'->>'delivery_code') BETWEEN 1 AND 50 AND
    pg_catalog.btrim(intent->'payload'->>'delivery_code')=intent->'payload'->>'delivery_code' AND
    (intent->'payload'->>'delivery_code') !~ '[[:cntrl:]]' AND
    pg_catalog.jsonb_typeof(intent->'payload'->'delivery_id')='string' AND
    pg_catalog.char_length(intent->'payload'->>'delivery_id') BETWEEN 1 AND 64 AND
    pg_catalog.btrim(intent->'payload'->>'delivery_id')=intent->'payload'->>'delivery_id' AND
    (intent->'payload'->>'delivery_id') !~ '[[:cntrl:]]'),
  CONSTRAINT mafr_created_ck CHECK(created_at>0)
);
CREATE FUNCTION public.manager_assigned_fulfillment_request_immutable_v1() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $mafr$${MANAGER_ASSIGNED_FULFILLMENT_IMMUTABLE_BODY}$mafr$;
CREATE TRIGGER mafr_immutable_rows BEFORE UPDATE OR DELETE ON public.manager_assigned_fulfillment_request
FOR EACH ROW EXECUTE FUNCTION public.manager_assigned_fulfillment_request_immutable_v1();
CREATE TRIGGER mafr_immutable_truncate BEFORE TRUNCATE ON public.manager_assigned_fulfillment_request
FOR EACH STATEMENT EXECUTE FUNCTION public.manager_assigned_fulfillment_request_immutable_v1();
REVOKE ALL ON TABLE public.manager_assigned_fulfillment_request FROM PUBLIC;
REVOKE ALL ON FUNCTION public.manager_assigned_fulfillment_request_immutable_v1() FROM PUBLIC;
`;

/** Complete PG16 logical shape; OIDs and ACLs are checked independently. There
 * are no dynamic expected definitions, runtime DDL or server-learned hashes. */
export const MANAGER_ASSIGNED_FULFILLMENT_CATALOG_SQL = `SELECT pg_catalog.jsonb_build_object(
  'table',pg_catalog.jsonb_build_object('name',c.relname,'kind',c.relkind,'persistence',c.relpersistence,
    'columns',c.relnatts,'checks',c.relchecks,'options',c.reloptions,'replident',c.relreplident,
    'rls',c.relrowsecurity,'forceRls',c.relforcerowsecurity,'partition',c.relispartition,'hasRules',c.relhasrules,
    'accessMethod',am.amname,'populated',c.relispopulated),
  'columns',(SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('ordinal',a.attnum,'name',a.attname,
    'type',pg_catalog.format_type(a.atttypid,a.atttypmod),'typeSchema',tn.nspname,'notNull',a.attnotnull,
    'dropped',a.attisdropped,'identity',a.attidentity,'generated',a.attgenerated,'hasDefault',a.atthasdef,
    'hasMissing',a.atthasmissing,'missing',a.attmissingval::text,
    'default',pg_catalog.pg_get_expr(d.adbin,d.adrelid,false),'collationSchema',cn.nspname,'collation',coll.collname,
    'options',a.attoptions,'fdwOptions',a.attfdwoptions,'storage',a.attstorage,'compression',a.attcompression)
    ORDER BY a.attnum) FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_type ty ON ty.oid=a.atttypid
    JOIN pg_catalog.pg_namespace tn ON tn.oid=ty.typnamespace
    LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
    LEFT JOIN pg_catalog.pg_collation coll ON coll.oid=a.attcollation
    LEFT JOIN pg_catalog.pg_namespace cn ON cn.oid=coll.collnamespace WHERE a.attrelid=c.oid AND a.attnum>0),
  'types',(SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('name',ty.typname,'type',ty.typtype,
    'category',ty.typcategory,'preferred',ty.typispreferred,'defined',ty.typisdefined,'delimiter',ty.typdelim,
    'notNull',ty.typnotnull,'base',ty.typbasetype::text,'typeModifier',ty.typtypmod,'dimensions',ty.typndims,
    'collation',ty.typcollation::text,'default',ty.typdefault,'defaultBin',ty.typdefaultbin::text,
    'input',ty.typinput::regproc::text,'output',ty.typoutput::regproc::text,'receive',ty.typreceive::regproc::text,
    'send',ty.typsend::regproc::text,'analyze',ty.typanalyze::regproc::text,'subscript',ty.typsubscript::regproc::text)
    ORDER BY ty.typname COLLATE pg_catalog."C") FROM pg_catalog.pg_type ty
    WHERE ty.oid=c.reltype OR ty.oid=(SELECT typarray FROM pg_catalog.pg_type WHERE oid=c.reltype)),
  'constraints',(SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('name',k.conname,'type',k.contype,
    'definition',pg_catalog.pg_get_constraintdef(k.oid,false),'validated',k.convalidated,'deferrable',k.condeferrable,
    'deferred',k.condeferred,'local',k.conislocal,'inheritance',k.coninhcount,'parent',k.conparentid::text,
    'noInherit',k.connoinherit) ORDER BY k.conname COLLATE pg_catalog."C") FROM pg_catalog.pg_constraint k WHERE k.conrelid=c.oid),
  'indexes',(SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('name',ic.relname,
    'definition',pg_catalog.pg_get_indexdef(i.indexrelid,0,false),'kind',ic.relkind,'persistence',ic.relpersistence,
    'options',ic.reloptions,'accessMethod',ia.amname,'primary',i.indisprimary,'unique',i.indisunique,
    'valid',i.indisvalid,'ready',i.indisready,'live',i.indislive,'immediate',i.indimmediate,
    'exclusion',i.indisexclusion,'nullsNotDistinct',i.indnullsnotdistinct,'keys',i.indkey::text,
    'attributes',i.indnatts,'keyAttributes',i.indnkeyatts,'ordering',i.indoption::text,
    'expressions',pg_catalog.pg_get_expr(i.indexprs,i.indrelid,false),'predicate',pg_catalog.pg_get_expr(i.indpred,i.indrelid,false),
    'opclasses',(SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(n.nspname,o.opcname) ORDER BY x.ordinality)
      FROM pg_catalog.unnest(i.indclass::oid[]) WITH ORDINALITY x(oid,ordinality)
      JOIN pg_catalog.pg_opclass o ON o.oid=x.oid JOIN pg_catalog.pg_namespace n ON n.oid=o.opcnamespace),
    'collations',(SELECT pg_catalog.jsonb_agg(CASE WHEN x.oid=0 THEN NULL ELSE pg_catalog.jsonb_build_array(n.nspname,co.collname) END ORDER BY x.ordinality)
      FROM pg_catalog.unnest(i.indcollation::oid[]) WITH ORDINALITY x(oid,ordinality)
      LEFT JOIN pg_catalog.pg_collation co ON co.oid=x.oid LEFT JOIN pg_catalog.pg_namespace n ON n.oid=co.collnamespace))
    ORDER BY ic.relname COLLATE pg_catalog."C") FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class ic ON ic.oid=i.indexrelid
    JOIN pg_catalog.pg_am ia ON ia.oid=ic.relam WHERE i.indrelid=c.oid),
  'triggers',(SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('name',t.tgname,'type',t.tgtype,
    'internal',t.tgisinternal,'enabled',t.tgenabled,'arguments',t.tgnargs,'argumentBytes',pg_catalog.encode(t.tgargs,'hex'),
    'qual',pg_catalog.pg_get_expr(t.tgqual,t.tgrelid,false),'constraint',t.tgconstraint::text,'columns',t.tgattr::text,
    'oldTable',t.tgoldtable,'newTable',t.tgnewtable,'functionSchema',n.nspname,'function',p.proname)
    ORDER BY t.tgname COLLATE pg_catalog."C") FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_proc p ON p.oid=t.tgfoid
    JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE t.tgrelid=c.oid)
) AS shape FROM pg_catalog.pg_class c JOIN pg_catalog.pg_am am ON am.oid=c.relam
WHERE c.oid=pg_catalog.to_regclass('public.manager_assigned_fulfillment_request')`;

// The owned PG16 capture is pinned before commissioning; never updated by an inspector.
export const MANAGER_ASSIGNED_FULFILLMENT_CATALOG_SHA256 = '4788618e9687ce6a882762999790f714020bfabe46711f503b8c81a94594f039';

function data(value: unknown, allowed: readonly string[]): Record<string, PropertyDescriptor> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw Error('Plain Manager assigned receipt declaration required');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).some(k => typeof k !== 'string' || !allowed.includes(k)
    || !descriptors[k]?.enumerable || !('value' in descriptors[k]))) throw Error('Data-only Manager assigned receipt declaration required');
  return descriptors;
}
export function captureManagerAssignedWholeExpressAddon(value: ManagerAssignedWholeExpressAddon): ManagerAssignedWholeExpressAddon {
  const d = data(value, ['receipts']);
  if (Reflect.ownKeys(d).length !== 1 || d.receipts?.value !== true) throw Error('Explicit complete Manager assigned whole express addon required');
  return Object.freeze({ receipts: true as const });
}
function captureNames(value: ManagerAssignedFulfillmentNames): ManagerAssignedFulfillmentNames {
  const d = data(value, ['maintenance', 'manager']);
  const maintenance: unknown = d.maintenance?.value, manager: unknown = d.manager?.value;
  if (typeof maintenance !== 'string' || manager !== undefined && manager !== MANAGER_RUNTIME_ROLE)
    throw Error('Exact receipt maintenance/fixed Manager required');
  [maintenance, MANAGER_RUNTIME_ROLE].forEach(pricingIdentifier);
  if (maintenance === MANAGER_RUNTIME_ROLE) throw Error('Independent receipt identities required');
  return { maintenance, manager: MANAGER_RUNTIME_ROLE };
}

interface MetadataRow extends Record<string, unknown> {
  database: string; databaseOid: string; tableOid: string; owner: string; ownerOid: string;
  ownerSafe: boolean; namespaceSafe: boolean; functionSafe: boolean; functionAclSafe: boolean;
  columnAclSafe: boolean; attachmentsSafe: boolean; indexOwnersSafe: boolean;
  acl: Array<{ name: string | null; oid: string; privilege: string; grantor: string; delegate: boolean }>;
}

async function namespace(tx: Query) {
  const [row] = await tx.execute<{ present: boolean; safe: boolean }>(sql`WITH
    relations AS(SELECT c.*,n.nspname FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname<>'information_schema' AND n.nspname !~ '^pg_'
      AND (pg_catalog.starts_with(c.relname,'manager_assigned_fulfillment_request') OR pg_catalog.starts_with(c.relname,'mafr_'))),
    functions AS(SELECT p.*,n.nspname FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname<>'information_schema' AND n.nspname !~ '^pg_'
      AND (pg_catalog.starts_with(p.proname,'manager_assigned_fulfillment_request') OR pg_catalog.starts_with(p.proname,'mafr_'))),
    types AS(SELECT t.*,n.nspname FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid=t.typnamespace
      WHERE n.nspname<>'information_schema' AND n.nspname !~ '^pg_'
      AND (pg_catalog.starts_with(t.typname,'manager_assigned_fulfillment_request') OR pg_catalog.starts_with(t.typname,'_manager_assigned_fulfillment_request')
        OR pg_catalog.starts_with(t.typname,'mafr_') OR pg_catalog.starts_with(t.typname,'_mafr_'))),
    constraints AS(SELECT k.*,n.nspname FROM pg_catalog.pg_constraint k JOIN pg_catalog.pg_namespace n ON n.oid=k.connamespace
      WHERE n.nspname<>'information_schema' AND n.nspname !~ '^pg_'
      AND (pg_catalog.starts_with(k.conname,'mafr_') OR pg_catalog.starts_with(k.conname,'manager_assigned_fulfillment_request'))),
    triggers AS(SELECT t.* FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid
      JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname<>'information_schema' AND n.nspname !~ '^pg_'
      AND (pg_catalog.starts_with(t.tgname,'mafr_') OR pg_catalog.starts_with(t.tgname,'manager_assigned_fulfillment_request')))
    SELECT EXISTS(SELECT 1 FROM relations) OR EXISTS(SELECT 1 FROM functions) OR EXISTS(SELECT 1 FROM types)
      OR EXISTS(SELECT 1 FROM constraints) OR EXISTS(SELECT 1 FROM triggers) AS present,
      (SELECT pg_catalog.count(*)=4 AND pg_catalog.bool_and(nspname='public' AND relname IN('manager_assigned_fulfillment_request','mafr_pk','mafr_order_uq','mafr_outbox_uq')) FROM relations)
      AND (SELECT pg_catalog.count(*)=1 AND pg_catalog.bool_and(nspname='public' AND proname='manager_assigned_fulfillment_request_immutable_v1') FROM functions)
      AND (SELECT pg_catalog.count(*)=2 AND pg_catalog.bool_and(nspname='public' AND typowner=(SELECT relowner FROM pg_catalog.pg_class WHERE oid=pg_catalog.to_regclass('public.manager_assigned_fulfillment_request'))
        AND typname IN('manager_assigned_fulfillment_request','_manager_assigned_fulfillment_request') AND typisdefined
        AND NOT typnotnull AND typbasetype=0 AND typtypmod=-1 AND typndims=0 AND typcollation=0
        AND (typname='manager_assigned_fulfillment_request' AND typtype='c' AND typelem=0
          AND typrelid=pg_catalog.to_regclass('public.manager_assigned_fulfillment_request')
          AND typarray=pg_catalog.to_regtype('public._manager_assigned_fulfillment_request')
          OR typname='_manager_assigned_fulfillment_request' AND typtype='b' AND typcategory='A' AND typrelid=0
          AND typelem=pg_catalog.to_regtype('public.manager_assigned_fulfillment_request') AND typarray=0)) FROM types)
      AND NOT EXISTS(SELECT 1 FROM constraints WHERE nspname<>'public' OR conrelid<>pg_catalog.to_regclass('public.manager_assigned_fulfillment_request'))
      AND NOT EXISTS(SELECT 1 FROM triggers WHERE tgrelid<>pg_catalog.to_regclass('public.manager_assigned_fulfillment_request')) AS safe`);
  return row;
}

async function metadata(tx: Query): Promise<MetadataRow | undefined> {
  const [row] = await tx.execute<MetadataRow>(sql`SELECT pg_catalog.current_database() AS database,
    (SELECT oid::text FROM pg_catalog.pg_database WHERE datname=pg_catalog.current_database()) AS "databaseOid",
    c.oid::text AS "tableOid",r.rolname AS owner,r.oid::text AS "ownerOid",
    r.rolsuper AND r.rolcanlogin AND pg_catalog.current_setting('server_version_num')::integer/10000=16 AS "ownerSafe",
    NOT EXISTS(SELECT 1 FROM pg_catalog.pg_inherits WHERE inhrelid=c.oid OR inhparent=c.oid)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_rewrite WHERE ev_class=c.oid)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_policy WHERE polrelid=c.oid)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_constraint WHERE confrelid=c.oid)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_publication_rel WHERE prrelid=c.oid)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_publication WHERE puballtables)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_foreign_table WHERE ftrelid=c.oid)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_depend d WHERE d.deptype='e' AND
        (d.classid='pg_catalog.pg_class'::regclass AND (d.objid=c.oid OR d.objid IN(SELECT indexrelid FROM pg_catalog.pg_index WHERE indrelid=c.oid))
        OR d.classid='pg_catalog.pg_proc'::regclass AND d.objid=f.oid
        OR d.classid='pg_catalog.pg_type'::regclass AND d.objid IN(c.reltype,(SELECT typarray FROM pg_catalog.pg_type WHERE oid=c.reltype)))) AS "namespaceSafe",
    f.proowner=c.relowner AND f.prosrc=${MANAGER_ASSIGNED_FULFILLMENT_IMMUTABLE_BODY}
      AND f.prorettype='pg_catalog.trigger'::regtype AND f.pronargs=0 AND f.proargtypes::text=''
      AND NOT f.prosecdef AND NOT f.proleakproof AND f.provolatile='v' AND f.prokind='f'
      AND f.proconfig=ARRAY['search_path=pg_catalog']::text[] AND NOT f.proisstrict AND NOT f.proretset
      AND f.proparallel='u' AND f.prosupport=0 AND f.provariadic=0 AND f.pronargdefaults=0
      AND f.proargdefaults IS NULL AND f.proallargtypes IS NULL AND f.proargmodes IS NULL AND f.proargnames IS NULL
      AND f.probin IS NULL AND f.prosqlbody IS NULL AND f.procost=100 AND f.prorows=0
      AND l.lanname='plpgsql' AND l.lanpltrusted AS "functionSafe",
    NOT EXISTS(SELECT 1 FROM pg_catalog.aclexplode(COALESCE(f.proacl,pg_catalog.acldefault('f',f.proowner))) a
      WHERE a.grantee<>f.proowner OR a.grantor<>f.proowner OR a.privilege_type<>'EXECUTE') AS "functionAclSafe",
    NOT EXISTS(SELECT 1 FROM pg_catalog.pg_attribute WHERE attrelid=c.oid AND attacl IS NOT NULL) AS "columnAclSafe",
    (SELECT pg_catalog.count(*)=2 AND pg_catalog.bool_and(tgrelid=c.oid AND tgname IN('mafr_immutable_rows','mafr_immutable_truncate'))
      FROM pg_catalog.pg_trigger WHERE tgfoid=f.oid) AS "attachmentsSafe",
    NOT EXISTS(SELECT 1 FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class ic ON ic.oid=i.indexrelid
      WHERE i.indrelid=c.oid AND ic.relowner<>c.relowner) AS "indexOwnersSafe",
    COALESCE((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('name',grantee.rolname,'oid',a.grantee::text,
      'privilege',a.privilege_type,'grantor',a.grantor::text,'delegate',a.is_grantable) ORDER BY a.grantee,a.privilege_type COLLATE pg_catalog."C")
      FROM pg_catalog.aclexplode(COALESCE(c.relacl,pg_catalog.acldefault('r',c.relowner))) a
      LEFT JOIN pg_catalog.pg_roles grantee ON grantee.oid=a.grantee WHERE a.grantee<>c.relowner),'[]'::jsonb) AS acl
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_roles r ON r.oid=c.relowner
    JOIN pg_catalog.pg_proc f ON f.oid=pg_catalog.to_regprocedure('public.manager_assigned_fulfillment_request_immutable_v1()')
    JOIN pg_catalog.pg_language l ON l.oid=f.prolang WHERE c.oid=pg_catalog.to_regclass('public.manager_assigned_fulfillment_request')`);
  return row;
}

/** Metadata-only leaf; it does not authenticate an HTTP actor or current LOGIN,
 * verify an assignment/source/delivery fact, grant rights, take a business lock
 * or enable a runtime handler. Owner-only is a fresh installation stage, never ready. */
export async function inspectManagerAssignedFulfillment(tx: Query,
  value?: ManagerAssignedFulfillmentNames): Promise<ManagerAssignedFulfillmentInspection> {
  const names = value === undefined ? undefined : captureNames(value);
  const result: ManagerAssignedFulfillmentInspection = { present: false, ready: false,
    catalogReady: false, ownerOnly: false, binding: null, failures: [] };
  try {
    const inventory = await namespace(tx); result.present = inventory?.present === true;
    if (!result.present) { result.failures.push('absent'); return result; }
    if (inventory?.safe !== true) { result.failures.push('namespace'); return result; }
    const [catalog] = await tx.execute<{ shape: unknown }>(sql.raw(MANAGER_ASSIGNED_FULFILLMENT_CATALOG_SQL));
    const row = await metadata(tx);
    if (!row || !catalog?.shape || await outRequestHash(catalog.shape) !== MANAGER_ASSIGNED_FULFILLMENT_CATALOG_SHA256
      || !['ownerSafe','namespaceSafe','functionSafe','functionAclSafe','columnAclSafe','attachmentsSafe','indexOwnersSafe'].every(k => row[k] === true)
      || names && row.owner !== names.maintenance) { result.failures.push('canonical_catalog'); return result; }
    result.catalogReady = true;
    const acl = row.acl;
    if (!Array.isArray(acl)) { result.failures.push('acl'); return result; }
    result.ownerOnly = acl.length === 0;
    // The runtime principal is source-fixed, never learned from table ACLs.
    const roles = await tx.execute<{ name: string; oid: string; safe: boolean }>(sql`SELECT r.rolname AS name,r.oid::text AS oid,
      r.rolcanlogin AND NOT(r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolinherit OR r.rolreplication OR r.rolbypassrls)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members WHERE member=r.oid OR roleid=r.oid)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_shdepend WHERE refclassid='pg_catalog.pg_authid'::regclass AND refobjid=r.oid AND deptype='o')
      AND pg_catalog.has_database_privilege(r.oid,pg_catalog.current_database(),'CONNECT') AND pg_catalog.has_schema_privilege(r.oid,'public','USAGE')
      AND NOT pg_catalog.has_database_privilege(r.oid,pg_catalog.current_database(),'CREATE')
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname !~ '^pg_' AND nspname<>'information_schema' AND pg_catalog.has_schema_privilege(r.oid,oid,'CREATE'))
      AND NOT pg_catalog.has_parameter_privilege(r.oid,'session_replication_role','SET,ALTER SYSTEM')
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_default_acl d WHERE EXISTS(SELECT 1 FROM pg_catalog.aclexplode(d.defaclacl) a WHERE a.grantee=r.oid)) AS safe
      FROM pg_catalog.pg_roles r WHERE r.rolname=${MANAGER_RUNTIME_ROLE} ORDER BY r.rolname COLLATE pg_catalog."C"`);
    const m = roles.find(r => r.name === MANAGER_RUNTIME_ROLE);
    if (roles.length !== 1 || m?.safe !== true) { result.failures.push('restricted_principals'); return result; }
    const binding: ManagerAssignedFulfillmentBinding = { database: row.database, databaseOid: row.databaseOid,
      maintenance: row.owner, maintenanceOid: row.ownerOid,
      manager: MANAGER_RUNTIME_ROLE, managerOid: m.oid, tableOid: row.tableOid };
    result.binding = Object.freeze(binding);
    if (result.ownerOnly) { result.failures.push('owner_only'); return result; }
    const wanted = [[m.oid,'INSERT'],[m.oid,'SELECT']].map(v => v.join(':')).sort();
    const actual = acl.map(v => `${v.oid}:${v.privilege}`).sort();
    if (JSON.stringify(actual) !== JSON.stringify(wanted) || acl.some(v => v.delegate !== false || v.grantor !== row.ownerOid)) {
      result.failures.push('acl'); return result;
    }
    const [after] = await tx.execute<{ shape: unknown }>(sql.raw(MANAGER_ASSIGNED_FULFILLMENT_CATALOG_SQL));
    if (JSON.stringify(row) !== JSON.stringify(await metadata(tx)) || (await namespace(tx))?.safe !== true
      || !after?.shape || await outRequestHash(after.shape) !== MANAGER_ASSIGNED_FULFILLMENT_CATALOG_SHA256) {
      result.failures.push('metadata_changed'); return result;
    }
    result.ready = true; return result;
  } catch { result.failures.push('catalog_query'); return result; }
}
