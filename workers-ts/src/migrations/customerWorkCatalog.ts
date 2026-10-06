import { pricingIdentifier } from './checkoutPricingLockCatalog';
/** Fixed PG16 structural inspection, excluding database-specific OIDs and
 * runtime row contents. Index ordering/operator/collation differences matter. */
export function customerWorkCatalogSql(table:string) {
  pricingIdentifier(table);
  return `SELECT jsonb_build_object(
 'table',jsonb_build_object('kind',c.relkind,'persistence',c.relpersistence,'rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity,'rules',c.relhasrules,'partition',c.relispartition),
 'columns',(SELECT jsonb_agg(jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'not_null',a.attnotnull,'identity',a.attidentity,'generated',a.attgenerated,'dimensions',a.attndims,'collation',CASE WHEN a.attcollation=0 THEN NULL ELSE a.attcollation::regcollation::text END,'default',pg_get_expr(d.adbin,d.adrelid)) ORDER BY a.attnum) FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),
 'constraints',(SELECT jsonb_agg(jsonb_build_object('name',k.conname,'type',k.contype,'validated',k.convalidated,'definition',pg_get_constraintdef(k.oid)) ORDER BY k.conname) FROM pg_constraint k WHERE k.conrelid=c.oid),
 'indexes',(SELECT jsonb_agg(jsonb_build_object('name',ic.relname,'unique',i.indisunique,'keys',i.indkey::text,'ordering',i.indoption::text,'opclasses',ARRAY(SELECT n.nspname||'.'||o.opcname FROM unnest(i.indclass::oid[]) WITH ORDINALITY x(oid,ord) JOIN pg_opclass o ON o.oid=x.oid JOIN pg_namespace n ON n.oid=o.opcnamespace ORDER BY x.ord),'collations',ARRAY(SELECT CASE WHEN x=0 THEN NULL ELSE x::regcollation::text END FROM unnest(i.indcollation::oid[]) x),'nulls_not_distinct',i.indnullsnotdistinct,'immediate',i.indimmediate,'valid',i.indisvalid,'ready',i.indisready,'live',i.indislive,'predicate',pg_get_expr(i.indpred,i.indrelid),'expression',pg_get_expr(i.indexprs,i.indrelid),'method',am.amname,'options',ic.reloptions) ORDER BY ic.relname) FROM pg_index i JOIN pg_class ic ON ic.oid=i.indexrelid JOIN pg_am am ON am.oid=ic.relam WHERE i.indrelid=c.oid),
 'triggers',(SELECT count(*) FROM pg_trigger t WHERE t.tgrelid=c.oid),
 'parents',(SELECT count(*) FROM pg_inherits h WHERE h.inhrelid=c.oid OR h.inhparent=c.oid)
) AS shape FROM pg_class c WHERE c.oid=to_regclass('public.${table}')`;
}
export function compositeCustomerWorkCatalogSql(tables:Readonly<Record<string,string>>) {
  const pairs=Object.entries(tables).map(([key,table])=>{pricingIdentifier(key);return `'${key}',(${customerWorkCatalogSql(table).replace(' AS shape FROM',' FROM')})`;});
  if(!pairs.length)throw Error('Empty customer catalog');return `SELECT jsonb_build_object(${pairs.join(',')}) AS shape`;
}
