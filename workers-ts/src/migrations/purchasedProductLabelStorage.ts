/** Prospective, owner-only storage. No runtime author is commissioned here.
 * Logical shape, owner/ACL and namespace are separate closed checks. */
import { sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { outRequestHash } from '@/services/out/OutIdempotency';
import { pricingIdentifier } from './checkoutPricingLockCatalog';
import { PURCHASED_LABEL_IMMUTABLE_BODY } from './purchasedProductLabelContract';

type Query = Pick<DbClient, 'execute'>;
export const PURCHASED_LABEL_STORAGE_GATE = [731953, 0] as const;
export const PURCHASED_LABEL_CATALOG_SQL = `SELECT pg_catalog.jsonb_build_object(
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
  'foreignKeyTriggers',(SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'constraint',k.conname,'type',t.tgtype,'enabled',t.tgenabled,'internal',t.tgisinternal,
    'tableSchema',tn.nspname,'table',tc.relname,'functionSchema',pn.nspname,'function',p.proname,
    'deferrable',t.tgdeferrable,'deferred',t.tginitdeferred,'arguments',t.tgnargs,'argumentBytes',pg_catalog.encode(t.tgargs,'hex'),
    'qual',pg_catalog.pg_get_expr(t.tgqual,t.tgrelid,false),'columns',t.tgattr::text,
    'oldTable',t.tgoldtable,'newTable',t.tgnewtable)
    ORDER BY k.conname COLLATE pg_catalog."C",tn.nspname COLLATE pg_catalog."C",tc.relname COLLATE pg_catalog."C",t.tgtype,p.proname COLLATE pg_catalog."C")
    FROM pg_catalog.pg_constraint k JOIN pg_catalog.pg_trigger t ON t.tgconstraint=k.oid
    JOIN pg_catalog.pg_class tc ON tc.oid=t.tgrelid JOIN pg_catalog.pg_namespace tn ON tn.oid=tc.relnamespace
    JOIN pg_catalog.pg_proc p ON p.oid=t.tgfoid JOIN pg_catalog.pg_namespace pn ON pn.oid=p.pronamespace
    WHERE k.conrelid=c.oid AND k.contype='f'),
  'triggers',(SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('name',CASE WHEN t.tgisinternal THEN tk.conname||':'||t.tgtype::text||':'||p.proname ELSE t.tgname END,'type',t.tgtype,
    'internal',t.tgisinternal,'enabled',t.tgenabled,'arguments',t.tgnargs,'argumentBytes',pg_catalog.encode(t.tgargs,'hex'),
    'qual',pg_catalog.pg_get_expr(t.tgqual,t.tgrelid,false),'constraint',tk.conname,'columns',t.tgattr::text,
    'oldTable',t.tgoldtable,'newTable',t.tgnewtable,'functionSchema',n.nspname,'function',p.proname)
    ORDER BY (CASE WHEN t.tgisinternal THEN tk.conname||':'||t.tgtype::text||':'||p.proname ELSE t.tgname END) COLLATE pg_catalog."C") FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_proc p ON p.oid=t.tgfoid
    JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace LEFT JOIN pg_catalog.pg_constraint tk ON tk.oid=t.tgconstraint WHERE t.tgrelid=c.oid)
) AS shape FROM pg_catalog.pg_class c JOIN pg_catalog.pg_am am ON am.oid=c.relam
WHERE c.relnamespace='public'::regnamespace AND c.relname IN('purchased_product_label_intent','purchased_product_label_state','purchased_product_label_result') ORDER BY c.relname COLLATE pg_catalog."C"`;
// Owned PG16 capture; the read-only inspector never learns an expected shape.
export const PURCHASED_LABEL_CATALOG_SHA256 = '07c2843b4efd96edb224030fcff3505c5fea6e0d2668b9712679c8cc0b0d19c1';
export interface PurchasedLabelStorageTarget { database: string; maintenance: string }
export function capturePurchasedLabelStorageTarget(value: PurchasedLabelStorageTarget): Readonly<PurchasedLabelStorageTarget> {
  if (!value || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || Reflect.ownKeys(value).length !== 2) throw Error('Exact purchased label storage target required');
  const captured: Record<string, string> = {};
  for (const key of ['database', 'maintenance']) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (!d?.enumerable || !('value' in d) || typeof d.value !== 'string') throw Error('Data-only purchased label target required');
    pricingIdentifier(d.value); captured[key] = d.value;
  }
  return Object.freeze({ database: captured.database!, maintenance: captured.maintenance! });
}
export interface PurchasedLabelStorageInspection {
  present: boolean; storageReady: boolean; readonly runtimeReady: false; failures: string[];
}

/** Full local namespace, not just successful to_regclass lookups. Objects in
 * other user schemas, detached prefix objects and extra dependencies refuse.
 * The owner-only stage grants nothing to App/Admin/Manager/Financial/PUBLIC. */
export async function inspectPurchasedLabelStorage(tx: Query, input: PurchasedLabelStorageTarget): Promise<PurchasedLabelStorageInspection> {
  const target = capturePurchasedLabelStorageTarget(input);
  const result: PurchasedLabelStorageInspection = { present: false, storageReady: false, runtimeReady: false, failures: [] };
  const [inventory] = await tx.execute<{ present: boolean; namespace: boolean }>(sql`WITH
    relations AS(SELECT c.*,n.nspname FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname<>'information_schema' AND n.nspname !~ '^pg_' AND
      (c.relname ~ '^(purchased_product_label|ppli_|ppls_|pplr_)')),
    functions AS(SELECT p.*,n.nspname FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname<>'information_schema' AND n.nspname !~ '^pg_' AND p.proname ~ '^(purchased_product_label|ppli_|ppls_|pplr_)'),
    types AS(SELECT t.*,n.nspname FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid=t.typnamespace
      WHERE n.nspname<>'information_schema' AND n.nspname !~ '^pg_' AND t.typname ~ '^(_?purchased_product_label|_?ppli_|_?ppls_|_?pplr_)'),
    constraints AS(SELECT k.*,n.nspname FROM pg_catalog.pg_constraint k JOIN pg_catalog.pg_namespace n ON n.oid=k.connamespace
      WHERE n.nspname<>'information_schema' AND n.nspname !~ '^pg_' AND k.conname ~ '^(purchased_product_label|ppli_|ppls_|pplr_)'),
    triggers AS(SELECT t.*,n.nspname FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid
      JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname<>'information_schema' AND n.nspname !~ '^pg_'
      AND t.tgname ~ '^(purchased_product_label|ppli_|ppls_|pplr_)')
    SELECT EXISTS(SELECT 1 FROM relations) OR EXISTS(SELECT 1 FROM functions) OR EXISTS(SELECT 1 FROM types)
      OR EXISTS(SELECT 1 FROM constraints) OR EXISTS(SELECT 1 FROM triggers) AS present,
    (SELECT count(*)=13 AND bool_and(nspname='public' AND relname IN(
      'purchased_product_label_intent','purchased_product_label_state','purchased_product_label_result',
      'ppli_pk','ppli_key_uq','ppli_source_uq','ppli_payment_idx','ppli_customer_idx',
      'ppls_pk','ppls_pending_idx','ppls_lease_idx','pplr_pk','pplr_source_idx')) FROM relations)
    AND (SELECT count(*)=1 AND bool_and(nspname='public' AND proname='purchased_product_label_immutable_v1') FROM functions)
    AND (SELECT count(*)=6 AND bool_and(nspname='public' AND typname IN(
      'purchased_product_label_intent','_purchased_product_label_intent','purchased_product_label_state',
      '_purchased_product_label_state','purchased_product_label_result','_purchased_product_label_result')) FROM types)
    AND NOT EXISTS(SELECT 1 FROM constraints WHERE nspname<>'public' OR conrelid NOT IN(
      pg_catalog.to_regclass('public.purchased_product_label_intent'),pg_catalog.to_regclass('public.purchased_product_label_state'),pg_catalog.to_regclass('public.purchased_product_label_result')))
    AND NOT EXISTS(SELECT 1 FROM triggers WHERE nspname<>'public' OR tgrelid NOT IN(
      pg_catalog.to_regclass('public.purchased_product_label_intent'),pg_catalog.to_regclass('public.purchased_product_label_state'),pg_catalog.to_regclass('public.purchased_product_label_result'))) AS namespace`);
  result.present = inventory?.present === true;
  if (!result.present) { result.failures.push('absent'); return result; }
  if (inventory?.namespace !== true) { result.failures.push('namespace'); return result; }
  const shapes = await tx.execute<{ shape: unknown }>(sql.raw(PURCHASED_LABEL_CATALOG_SQL));
  if (shapes.length !== 3 || await outRequestHash(shapes.map(r => r.shape)) !== PURCHASED_LABEL_CATALOG_SHA256) {
    result.failures.push('logical_catalog'); return result;
  }
  const [metadata] = await tx.execute<{ safe: boolean }>(sql`SELECT pg_catalog.current_database()=${target.database}
    AND pg_catalog.current_setting('server_version_num')::integer/10000=16
    AND r.rolsuper AND r.rolcanlogin
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_event_trigger WHERE evtenabled<>'D')
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_publication WHERE puballtables)
    AND (SELECT count(*)=13 AND bool_and(c.relowner=r.oid AND NOT c.relrowsecurity AND NOT c.relforcerowsecurity
      AND NOT c.relispartition AND NOT c.relhasrules AND c.relpersistence='p'
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.aclexplode(COALESCE(c.relacl,pg_catalog.acldefault('r',c.relowner))) a
        WHERE a.grantee<>r.oid OR a.grantor<>r.oid)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND a.attacl IS NOT NULL)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_inherits i WHERE i.inhrelid=c.oid OR i.inhparent=c.oid)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_rewrite w WHERE w.ev_class=c.oid)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_policy p WHERE p.polrelid=c.oid)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_publication_rel p WHERE p.prrelid=c.oid)
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_depend d WHERE d.classid='pg_catalog.pg_class'::regclass AND d.objid=c.oid AND d.deptype='e'))
      FROM pg_catalog.pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relname ~ '^(purchased_product_label|ppli_|ppls_|pplr_)')
    AND (SELECT count(*)=6 AND bool_and(t.typowner=r.oid AND t.typacl IS NULL AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_depend d
       WHERE d.classid='pg_catalog.pg_type'::regclass AND d.objid=t.oid AND d.deptype='e'))
      FROM pg_catalog.pg_type t WHERE t.typnamespace='public'::regnamespace AND t.typname ~ '^_?purchased_product_label')
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_constraint k WHERE k.confrelid IN(
      pg_catalog.to_regclass('public.purchased_product_label_intent'),pg_catalog.to_regclass('public.purchased_product_label_state'),pg_catalog.to_regclass('public.purchased_product_label_result'))
      AND NOT(k.connamespace='public'::regnamespace AND k.conname IN('ppls_intent_fk','pplr_intent_fk')))
    AND f.proowner=r.oid AND f.prosrc=${PURCHASED_LABEL_IMMUTABLE_BODY}
    AND f.prorettype='pg_catalog.trigger'::regtype AND f.pronargs=0 AND f.proargtypes::text=''
    AND NOT f.prosecdef AND NOT f.proleakproof AND f.provolatile='v' AND f.prokind='f'
    AND f.proconfig=ARRAY['search_path=pg_catalog']::text[] AND NOT f.proisstrict AND NOT f.proretset
    AND f.proparallel='u' AND f.prosupport=0 AND f.provariadic=0 AND f.pronargdefaults=0
    AND f.proargdefaults IS NULL AND f.proallargtypes IS NULL AND f.proargmodes IS NULL AND f.proargnames IS NULL
    AND f.probin IS NULL AND f.prosqlbody IS NULL AND f.procost=100 AND f.prorows=0
    AND l.lanname='plpgsql' AND l.lanpltrusted
    AND (SELECT count(*)=4 AND bool_and(t.tgname IN('ppli_immutable_rows','ppli_immutable_truncate','pplr_immutable_rows','pplr_immutable_truncate')
      AND t.tgrelid IN(pg_catalog.to_regclass('public.purchased_product_label_intent'),pg_catalog.to_regclass('public.purchased_product_label_result')))
      FROM pg_catalog.pg_trigger t WHERE t.tgfoid=f.oid)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.aclexplode(COALESCE(f.proacl,pg_catalog.acldefault('f',f.proowner))) a
      WHERE a.grantee<>r.oid OR a.grantor<>r.oid)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_depend d WHERE d.classid='pg_catalog.pg_proc'::regclass AND d.objid=f.oid AND d.deptype='e') AS safe
    FROM pg_catalog.pg_roles r JOIN pg_catalog.pg_proc f ON f.pronamespace='public'::regnamespace
      AND f.proname='purchased_product_label_immutable_v1'
    JOIN pg_catalog.pg_language l ON l.oid=f.prolang WHERE r.rolname=${target.maintenance}`);
  if (metadata?.safe !== true) { result.failures.push('owner_or_dependencies'); return result; }
  result.storageReady = true;
  return result;
}
