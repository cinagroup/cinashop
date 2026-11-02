import { sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { outRequestHash } from '@/services/out/OutIdempotency';
import { pricingIdentifier } from './checkoutPricingLockCatalog';
import { MANAGER_RUNTIME_ROLE } from './managerRuntimePrivilegePlan';

type Query = Pick<DbClient, 'execute'>;
export interface StoreOrderFulfillmentAssignmentsAddon { assignments: true }
export interface StoreOrderFulfillmentAssignmentNames { maintenance: string; admin: string; manager?: string }
export interface StoreOrderFulfillmentAssignmentBinding {
  database: string; databaseOid: string; maintenance: string; maintenanceOid: string;
  admin: string; adminOid: string; manager: string; managerOid: string; tableOid: string;
}
export interface StoreOrderFulfillmentAssignmentInspection {
  present: boolean; ready: boolean; catalogReady: boolean; ownerOnly: boolean;
  binding: StoreOrderFulfillmentAssignmentBinding | null; failures: string[];
}
export const STORE_ORDER_FULFILLMENT_ASSIGNMENT_TABLE = 'store_order_fulfillment_assignment';
export const STORE_ORDER_FULFILLMENT_ASSIGNMENTS_GATE = [731723, 0] as const;
export const STORE_ORDER_FULFILLMENT_ASSIGNMENT_IMMUTABLE_BODY = `BEGIN
  RAISE EXCEPTION 'Store fulfillment assignment evidence is immutable' USING ERRCODE='42501';
END`;

/** Prospective storage only. A row is neither a verified Admin decision nor a
 * Manager capability. The future author must prove the complete chain and real
 * order/cart facts under the actual payment-root lock. No ownership is changed.
 * cart_id is the source varchar(50), never a coerced numeric shopping-cart ID.
 * SQL's created_at default is not an independent provider time attestation. */
export const STORE_ORDER_FULFILLMENT_ASSIGNMENT_SQL = `
CREATE TABLE public.store_order_fulfillment_assignment (
  operation_id uuid NOT NULL,
  format_version smallint NOT NULL,
  kind varchar(8) NOT NULL,
  actor_id integer NOT NULL,
  root_order_id integer NOT NULL,
  order_id integer NOT NULL,
  target_store_id integer NOT NULL,
  customer_uid integer NOT NULL,
  financial_store_id integer NOT NULL,
  ordinal integer NOT NULL,
  previous_ref uuid,
  order_revision varchar(64) NOT NULL,
  payload_hash varchar(64) NOT NULL,
  source_hash varchar(64) NOT NULL,
  source jsonb NOT NULL,
  created_at bigint DEFAULT pg_catalog.floor(extract(epoch FROM pg_catalog.clock_timestamp()))::bigint NOT NULL,
  CONSTRAINT sofa_pk PRIMARY KEY(operation_id),
  CONSTRAINT sofa_order_ordinal_uq UNIQUE(order_id,ordinal),
  CONSTRAINT sofa_previous_uq UNIQUE NULLS NOT DISTINCT(order_id,previous_ref),
  CONSTRAINT sofa_operation_ck CHECK(operation_id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  CONSTRAINT sofa_format_ck CHECK(format_version=1),
  CONSTRAINT sofa_kind_ck CHECK(kind IN('grant','revoke')),
  CONSTRAINT sofa_actor_ck CHECK(actor_id>0),
  CONSTRAINT sofa_root_ck CHECK(root_order_id>0 AND order_id=root_order_id),
  CONSTRAINT sofa_target_ck CHECK(target_store_id>0),
  CONSTRAINT sofa_customer_ck CHECK(customer_uid>0),
  CONSTRAINT sofa_financial_ck CHECK(financial_store_id=0),
  CONSTRAINT sofa_ordinal_ck CHECK(ordinal>0),
  CONSTRAINT sofa_previous_ck CHECK((ordinal=1 AND previous_ref IS NULL AND kind='grant') OR
    (ordinal>1 AND previous_ref IS NOT NULL AND previous_ref<>operation_id AND previous_ref::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')),
  CONSTRAINT sofa_order_revision_ck CHECK(order_revision ~ '^[a-f0-9]{64}$'),
  CONSTRAINT sofa_payload_hash_ck CHECK(payload_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT sofa_source_hash_ck CHECK(source_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT sofa_source_ck CHECK(pg_catalog.jsonb_typeof(source)='object' AND
    source ? 'cart_rows' AND source-'cart_rows'='{}'::jsonb AND
    pg_catalog.jsonb_typeof(source->'cart_rows')='array' AND
    pg_catalog.jsonb_array_length(source->'cart_rows') BETWEEN 1 AND 200 AND
    pg_catalog.octet_length(source::text)<=65536 AND
    NOT pg_catalog.jsonb_path_exists(source,'$.cart_rows[*] ? (@.type() != "object" || !exists(@.row_id) || !exists(@.cart_id) || !exists(@.product_id) || !exists(@.unique) || !exists(@.quantity) || @.row_id.type() != "number" || @.row_id <= 0 || @.row_id > 2147483647 || @.row_id.floor() != @.row_id || @.product_id.type() != "number" || @.product_id <= 0 || @.product_id > 2147483647 || @.product_id.floor() != @.product_id || @.quantity.type() != "number" || @.quantity <= 0 || @.quantity > 2147483647 || @.quantity.floor() != @.quantity || @.cart_id.type() != "string" || !(@.cart_id like_regex "^.{1,50}$" flag "s") || @.unique.type() != "string" || !(@.unique like_regex "^.{0,255}$" flag "s"))') AND
    NOT pg_catalog.jsonb_path_exists(source,'$.cart_rows[*].keyvalue() ? (@.key != "row_id" && @.key != "cart_id" && @.key != "product_id" && @.key != "unique" && @.key != "quantity")')),
  CONSTRAINT sofa_created_ck CHECK(created_at>0)
);
CREATE INDEX sofa_worklist_idx ON public.store_order_fulfillment_assignment(target_store_id,order_id,ordinal DESC);
CREATE FUNCTION public.store_order_fulfillment_assignment_immutable_v1() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $sofa$${STORE_ORDER_FULFILLMENT_ASSIGNMENT_IMMUTABLE_BODY}$sofa$;
CREATE TRIGGER sofa_immutable_rows BEFORE UPDATE OR DELETE ON public.store_order_fulfillment_assignment
FOR EACH ROW EXECUTE FUNCTION public.store_order_fulfillment_assignment_immutable_v1();
CREATE TRIGGER sofa_immutable_truncate BEFORE TRUNCATE ON public.store_order_fulfillment_assignment
FOR EACH STATEMENT EXECUTE FUNCTION public.store_order_fulfillment_assignment_immutable_v1();
REVOKE ALL ON TABLE public.store_order_fulfillment_assignment FROM PUBLIC;
REVOKE ALL ON FUNCTION public.store_order_fulfillment_assignment_immutable_v1() FROM PUBLIC;
`;

/** Complete PG16 logical shape; OIDs and ACLs are checked independently. There
 * are no dynamic expected definitions, runtime DDL or server-learned hashes. */
export const STORE_ORDER_FULFILLMENT_ASSIGNMENT_CATALOG_SQL = `SELECT pg_catalog.jsonb_build_object(
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
WHERE c.oid=pg_catalog.to_regclass('public.store_order_fulfillment_assignment')`;

// The owned PG16 capture is pinned before commissioning; never updated by an inspector.
export const STORE_ORDER_FULFILLMENT_ASSIGNMENT_CATALOG_SHA256 = '9805d9ab6bbce34371dcbd45cd36a1d5fd09d3683a2c8e66fa374fc670b9e7bc';

function data(value: unknown, allowed: readonly string[]): Record<string, PropertyDescriptor> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw Error('Plain assignment declaration required');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).some(k => typeof k !== 'string' || !allowed.includes(k)
    || !descriptors[k]?.enumerable || !('value' in descriptors[k]))) throw Error('Data-only assignment declaration required');
  return descriptors;
}
export function captureStoreOrderFulfillmentAssignmentsAddon(value: StoreOrderFulfillmentAssignmentsAddon): StoreOrderFulfillmentAssignmentsAddon {
  const d = data(value, ['assignments']);
  if (Reflect.ownKeys(d).length !== 1 || d.assignments?.value !== true) throw Error('Explicit complete fulfillment assignment addon required');
  return Object.freeze({ assignments: true as const });
}
function captureNames(value: StoreOrderFulfillmentAssignmentNames): StoreOrderFulfillmentAssignmentNames {
  const d = data(value, ['maintenance', 'admin', 'manager']);
  const maintenance: unknown = d.maintenance?.value, admin: unknown = d.admin?.value, manager: unknown = d.manager?.value;
  if (typeof maintenance !== 'string' || typeof admin !== 'string' || manager !== undefined && manager !== MANAGER_RUNTIME_ROLE)
    throw Error('Exact assignment maintenance/Admin/fixed Manager required');
  [maintenance, admin, MANAGER_RUNTIME_ROLE].forEach(pricingIdentifier);
  if (new Set([maintenance, admin, MANAGER_RUNTIME_ROLE]).size !== 3) throw Error('Independent assignment identities required');
  return { maintenance, admin, manager: MANAGER_RUNTIME_ROLE };
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
      AND (pg_catalog.starts_with(c.relname,'store_order_fulfillment_assignment') OR pg_catalog.starts_with(c.relname,'sofa_'))),
    functions AS(SELECT p.*,n.nspname FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname<>'information_schema' AND n.nspname !~ '^pg_'
      AND (pg_catalog.starts_with(p.proname,'store_order_fulfillment_assignment') OR pg_catalog.starts_with(p.proname,'sofa_'))),
    types AS(SELECT t.*,n.nspname FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid=t.typnamespace
      WHERE n.nspname<>'information_schema' AND n.nspname !~ '^pg_'
      AND (pg_catalog.starts_with(t.typname,'store_order_fulfillment_assignment') OR pg_catalog.starts_with(t.typname,'_store_order_fulfillment_assignment')
        OR pg_catalog.starts_with(t.typname,'sofa_') OR pg_catalog.starts_with(t.typname,'_sofa_'))),
    constraints AS(SELECT k.*,n.nspname FROM pg_catalog.pg_constraint k JOIN pg_catalog.pg_namespace n ON n.oid=k.connamespace
      WHERE n.nspname<>'information_schema' AND n.nspname !~ '^pg_'
      AND (pg_catalog.starts_with(k.conname,'sofa_') OR pg_catalog.starts_with(k.conname,'store_order_fulfillment_assignment'))),
    triggers AS(SELECT t.* FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid
      JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname<>'information_schema' AND n.nspname !~ '^pg_'
      AND (pg_catalog.starts_with(t.tgname,'sofa_') OR pg_catalog.starts_with(t.tgname,'store_order_fulfillment_assignment')))
    SELECT EXISTS(SELECT 1 FROM relations) OR EXISTS(SELECT 1 FROM functions) OR EXISTS(SELECT 1 FROM types)
      OR EXISTS(SELECT 1 FROM constraints) OR EXISTS(SELECT 1 FROM triggers) AS present,
      (SELECT pg_catalog.count(*)=5 AND pg_catalog.bool_and(nspname='public' AND relname IN('store_order_fulfillment_assignment','sofa_pk','sofa_order_ordinal_uq','sofa_previous_uq','sofa_worklist_idx')) FROM relations)
      AND (SELECT pg_catalog.count(*)=1 AND pg_catalog.bool_and(nspname='public' AND proname='store_order_fulfillment_assignment_immutable_v1') FROM functions)
      AND (SELECT pg_catalog.count(*)=2 AND pg_catalog.bool_and(nspname='public' AND typowner=(SELECT relowner FROM pg_catalog.pg_class WHERE oid=pg_catalog.to_regclass('public.store_order_fulfillment_assignment'))
        AND typname IN('store_order_fulfillment_assignment','_store_order_fulfillment_assignment') AND typisdefined
        AND NOT typnotnull AND typbasetype=0 AND typtypmod=-1 AND typndims=0 AND typcollation=0
        AND (typname='store_order_fulfillment_assignment' AND typtype='c' AND typelem=0
          AND typrelid=pg_catalog.to_regclass('public.store_order_fulfillment_assignment')
          AND typarray=pg_catalog.to_regtype('public._store_order_fulfillment_assignment')
          OR typname='_store_order_fulfillment_assignment' AND typtype='b' AND typcategory='A' AND typrelid=0
          AND typelem=pg_catalog.to_regtype('public.store_order_fulfillment_assignment') AND typarray=0)) FROM types)
      AND NOT EXISTS(SELECT 1 FROM constraints WHERE nspname<>'public' OR conrelid<>pg_catalog.to_regclass('public.store_order_fulfillment_assignment'))
      AND NOT EXISTS(SELECT 1 FROM triggers WHERE tgrelid<>pg_catalog.to_regclass('public.store_order_fulfillment_assignment')) AS safe`);
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
    f.proowner=c.relowner AND f.prosrc=${STORE_ORDER_FULFILLMENT_ASSIGNMENT_IMMUTABLE_BODY}
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
    (SELECT pg_catalog.count(*)=2 AND pg_catalog.bool_and(tgrelid=c.oid AND tgname IN('sofa_immutable_rows','sofa_immutable_truncate'))
      FROM pg_catalog.pg_trigger WHERE tgfoid=f.oid) AS "attachmentsSafe",
    NOT EXISTS(SELECT 1 FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class ic ON ic.oid=i.indexrelid
      WHERE i.indrelid=c.oid AND ic.relowner<>c.relowner) AS "indexOwnersSafe",
    COALESCE((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('name',grantee.rolname,'oid',a.grantee::text,
      'privilege',a.privilege_type,'grantor',a.grantor::text,'delegate',a.is_grantable) ORDER BY a.grantee,a.privilege_type COLLATE pg_catalog."C")
      FROM pg_catalog.aclexplode(COALESCE(c.relacl,pg_catalog.acldefault('r',c.relowner))) a
      LEFT JOIN pg_catalog.pg_roles grantee ON grantee.oid=a.grantee WHERE a.grantee<>c.relowner),'[]'::jsonb) AS acl
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_roles r ON r.oid=c.relowner
    JOIN pg_catalog.pg_proc f ON f.oid=pg_catalog.to_regprocedure('public.store_order_fulfillment_assignment_immutable_v1()')
    JOIN pg_catalog.pg_language l ON l.oid=f.prolang WHERE c.oid=pg_catalog.to_regclass('public.store_order_fulfillment_assignment')`);
  return row;
}

/** Metadata-only leaf; it does not authenticate an HTTP actor or current LOGIN,
 * verify a chain/source HMAC, grant rights, take a business lock or enable a
 * runtime handler. Owner-only is a fresh installation stage, never ready. */
export async function inspectStoreOrderFulfillmentAssignment(tx: Query,
  value?: StoreOrderFulfillmentAssignmentNames): Promise<StoreOrderFulfillmentAssignmentInspection> {
  const names = value === undefined ? undefined : captureNames(value);
  const result: StoreOrderFulfillmentAssignmentInspection = { present: false, ready: false,
    catalogReady: false, ownerOnly: false, binding: null, failures: [] };
  try {
    const inventory = await namespace(tx); result.present = inventory?.present === true;
    if (!result.present) { result.failures.push('absent'); return result; }
    if (inventory?.safe !== true) { result.failures.push('namespace'); return result; }
    const [catalog] = await tx.execute<{ shape: unknown }>(sql.raw(STORE_ORDER_FULFILLMENT_ASSIGNMENT_CATALOG_SQL));
    const row = await metadata(tx);
    if (!row || !catalog?.shape || await outRequestHash(catalog.shape) !== STORE_ORDER_FULFILLMENT_ASSIGNMENT_CATALOG_SHA256
      || !['ownerSafe','namespaceSafe','functionSafe','functionAclSafe','columnAclSafe','attachmentsSafe','indexOwnersSafe'].every(k => row[k] === true)
      || names && row.owner !== names.maintenance) { result.failures.push('canonical_catalog'); return result; }
    result.catalogReady = true;
    const acl = row.acl;
    if (!Array.isArray(acl)) { result.failures.push('acl'); return result; }
    result.ownerOnly = acl.length === 0;
    const admin = names?.admin ?? acl.find(a => a.privilege === 'INSERT')?.name;
    if (typeof admin !== 'string' || admin === MANAGER_RUNTIME_ROLE || admin === row.owner) {
      result.failures.push(result.ownerOnly ? 'owner_only' : 'admin_candidate'); return result;
    }
    pricingIdentifier(admin);
    const roles = await tx.execute<{ name: string; oid: string; safe: boolean }>(sql`SELECT r.rolname AS name,r.oid::text AS oid,
      r.rolcanlogin AND NOT(r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolinherit OR r.rolreplication OR r.rolbypassrls)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members WHERE member=r.oid OR roleid=r.oid)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_shdepend WHERE refclassid='pg_catalog.pg_authid'::regclass AND refobjid=r.oid AND deptype='o')
      AND pg_catalog.has_database_privilege(r.oid,pg_catalog.current_database(),'CONNECT') AND pg_catalog.has_schema_privilege(r.oid,'public','USAGE')
      AND NOT pg_catalog.has_database_privilege(r.oid,pg_catalog.current_database(),'CREATE')
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_namespace WHERE nspname !~ '^pg_' AND nspname<>'information_schema' AND pg_catalog.has_schema_privilege(r.oid,oid,'CREATE'))
      AND NOT pg_catalog.has_parameter_privilege(r.oid,'session_replication_role','SET,ALTER SYSTEM')
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_default_acl d WHERE EXISTS(SELECT 1 FROM pg_catalog.aclexplode(d.defaclacl) a WHERE a.grantee=r.oid)) AS safe
      FROM pg_catalog.pg_roles r WHERE r.rolname IN(${admin},${MANAGER_RUNTIME_ROLE}) ORDER BY r.rolname COLLATE pg_catalog."C"`);
    const a = roles.find(r => r.name === admin), m = roles.find(r => r.name === MANAGER_RUNTIME_ROLE);
    if (roles.length !== 2 || a?.safe !== true || m?.safe !== true) { result.failures.push('restricted_principals'); return result; }
    const binding: StoreOrderFulfillmentAssignmentBinding = { database: row.database, databaseOid: row.databaseOid,
      maintenance: row.owner, maintenanceOid: row.ownerOid, admin, adminOid: a.oid,
      manager: MANAGER_RUNTIME_ROLE, managerOid: m.oid, tableOid: row.tableOid };
    result.binding = Object.freeze(binding);
    if (result.ownerOnly) { result.failures.push('owner_only'); return result; }
    const wanted = [[a.oid,'INSERT'],[a.oid,'SELECT'],[m.oid,'SELECT']].map(v => v.join(':')).sort();
    const actual = acl.map(v => `${v.oid}:${v.privilege}`).sort();
    if (JSON.stringify(actual) !== JSON.stringify(wanted) || acl.some(v => v.delegate !== false || v.grantor !== row.ownerOid)) {
      result.failures.push('acl'); return result;
    }
    const [after] = await tx.execute<{ shape: unknown }>(sql.raw(STORE_ORDER_FULFILLMENT_ASSIGNMENT_CATALOG_SQL));
    if (JSON.stringify(row) !== JSON.stringify(await metadata(tx)) || (await namespace(tx))?.safe !== true
      || !after?.shape || await outRequestHash(after.shape) !== STORE_ORDER_FULFILLMENT_ASSIGNMENT_CATALOG_SHA256) {
      result.failures.push('metadata_changed'); return result;
    }
    result.ready = true; return result;
  } catch { result.failures.push('catalog_query'); return result; }
}
