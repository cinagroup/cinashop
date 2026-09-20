/** PG16 catalog-only inspection. Fixed public objects; no invoice content read.
 * Fingerprints cover complete definitions, not just the existence of names.
 * Owners/ACLs are evaluated separately so safe runtime grants survive upgrades. */
export const INVOICE_EVIDENCE_CATALOG_SQL = `
WITH relations AS (
  SELECT name,c.* FROM (VALUES ('store_order_invoice'),('store_order_invoice_evidence'),
    ('store_order_invoice_allocation')) names(name)
  LEFT JOIN pg_catalog.pg_class c ON c.oid=pg_catalog.to_regclass('public.'||name)
), relation_shapes AS (
  SELECT name,oid,relowner,
    relkind='r' AND relpersistence='p' AND NOT relispartition
    AND NOT relrowsecurity AND NOT relforcerowsecurity AND relreplident='d' AND reloptions IS NULL
    AND relam=(SELECT oid FROM pg_catalog.pg_am WHERE amname='heap')
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_inherits WHERE inhrelid=r.oid OR inhparent=r.oid)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_policy WHERE polrelid=r.oid)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_rewrite WHERE ev_class=r.oid)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_constraint WHERE confrelid=r.oid)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_attribute WHERE attrelid=r.oid AND attnum>0 AND attisdropped)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.aclexplode(COALESCE(relacl,pg_catalog.acldefault('r',relowner))) a
      WHERE a.grantee<>relowner AND (a.grantee=0 OR a.is_grantable OR NOT (a.privilege_type=ANY(
        CASE name WHEN 'store_order_invoice' THEN ARRAY['SELECT','INSERT','UPDATE','DELETE']
        WHEN 'store_order_invoice_evidence' THEN ARRAY['SELECT'] ELSE ARRAY['SELECT','INSERT'] END))))
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_attribute col CROSS JOIN LATERAL pg_catalog.aclexplode(col.attacl) a
      WHERE col.attrelid=r.oid AND a.grantee<>relowner) AS safe,
    pg_catalog.jsonb_build_object(
      'columns',(SELECT jsonb_agg(jsonb_build_array(a.attnum,a.attname,format_type(a.atttypid,a.atttypmod),a.attnotnull,
        pg_get_expr(d.adbin,d.adrelid),a.attidentity::text,a.attgenerated::text,
        CASE WHEN a.attcollation=0 THEN NULL ELSE cn.nspname||'.'||co.collname END) ORDER BY a.attnum)
        FROM pg_catalog.pg_attribute a LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
        LEFT JOIN pg_catalog.pg_collation co ON co.oid=a.attcollation LEFT JOIN pg_catalog.pg_namespace cn ON cn.oid=co.collnamespace
        WHERE a.attrelid=r.oid AND a.attnum>0 AND NOT a.attisdropped),
      'constraints',(SELECT jsonb_agg(jsonb_build_array(k.conname,k.contype::text,pg_get_constraintdef(k.oid,false),
        k.convalidated,k.condeferrable,k.condeferred,k.connoinherit,k.conislocal,k.coninhcount,k.conparentid::text)
        ORDER BY k.conname COLLATE "C") FROM pg_catalog.pg_constraint k WHERE k.conrelid=r.oid),
      'indexes',(SELECT jsonb_agg(jsonb_build_array(ic.relname,pg_get_indexdef(i.indexrelid),i.indisunique,i.indisprimary,
        i.indisvalid,i.indisready,i.indislive,i.indimmediate,i.indisexclusion,i.indnullsnotdistinct,i.indisreplident,
        i.indnatts,i.indnkeyatts,i.indkey::text,i.indoption::text,ic.reloptions,ic.relpersistence)
        ORDER BY ic.relname COLLATE "C") FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class ic ON ic.oid=i.indexrelid WHERE i.indrelid=r.oid),
      'triggers',(SELECT jsonb_agg(jsonb_build_array(t.tgname,pg_get_triggerdef(t.oid,false),t.tgenabled::text,t.tgisinternal)
        ORDER BY t.tgname COLLATE "C") FROM pg_catalog.pg_trigger t WHERE t.tgrelid=r.oid)
    ) AS shape
  FROM relations r
), functions AS (
  SELECT name,p.* FROM (VALUES('capture_invoice_evidence'),('protect_invoice_evidence')) names(name)
  LEFT JOIN pg_catalog.pg_proc p ON p.pronamespace='public'::regnamespace AND p.proname=name
), components AS (
  SELECT 'table' AS kind,name,oid,relowner AS owner,safe,shape FROM relation_shapes
  UNION ALL
  SELECT 'function',name,oid,proowner,
    prokind='f' AND pronargs=0 AND prorettype='trigger'::regtype AND NOT proretset
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.aclexplode(COALESCE(proacl,pg_catalog.acldefault('f',proowner))) a WHERE a.grantee<>proowner),
    jsonb_build_object('definition',CASE WHEN prokind='f' THEN pg_get_functiondef(oid) END,
      'support',prosupport::text,'binary',probin,'argtypes',proargtypes::text)
  FROM functions
)
SELECT kind,name,oid::text AS oid,oid IS NOT NULL AS present,
  owner=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=current_user) AS owned,safe,
  encode(sha256(convert_to(shape::text,'UTF8')),'hex') AS fingerprint
FROM components ORDER BY kind COLLATE "C",name COLLATE "C",oid
`;

/** Canonical PG16 definitions, generated from reviewed DDL and independently
 * checked by native migration tests. Any changed digest requires schema review. */
export const INVOICE_CATALOG_VERSIONS = {
  base: 'c4935a11f9ce4219938899eb14fda907f1355249df4183524e4c2aff7c1059e8',
  capturedBase: 'fa5ac803acadd40ea817c927c552a1e31e69e898620045f48a225a65ff7dc646',
  history: 'b0948eea8f5f31e09e969cae8127ee52187c389205be0b9e5fc3b2439ff51451',
  allocation: 'c5da015774eb7f8fa42c4c5ab6e08c49a34491adea620f5ddde475da913606f9',
  capture: '4118143bcefedacec3a6c83bea3094320e0165455a5fcd27f9f97b4c7c8e34c7',
  protect: 'b2fe7d071ed75d2e734a2f40b8cf091219e7280de6bf5700af866306385b0056',
  bareHistory: '1cef40804ed5cfeeb232718495b26a3b48e26925a72da258ac7391ebdbcb7572',
  bareAllocation: 'ce4a3c7b55138db7dfdabc06ff6e86e692cab769ff092fea6e8cc9fe86dad810',
} as const;

const exact = (name: string, key: keyof typeof INVOICE_CATALOG_VERSIONS) =>
  `(objects->'${name}') @> '${JSON.stringify({present:true,owned:true,safe:true,fingerprint:INVOICE_CATALOG_VERSIONS[key]})}'::jsonb`;
const absent = (name: string) => `(objects->'${name}') @> '{"present":false}'::jsonb`;
const noFunctions = `${absent('capture_invoice_evidence')} AND ${absent('protect_invoice_evidence')}`;
const validHistory = `${exact('store_order_invoice','capturedBase')} AND ${exact('store_order_invoice_evidence','history')}
  AND ${exact('capture_invoice_evidence','capture')} AND ${exact('protect_invoice_evidence','protect')}`;

/** One state machine shared by SQL migrations, the offline CLI and inspection. */
export const INVOICE_EVIDENCE_STATE_SQL = `WITH catalog AS (${INVOICE_EVIDENCE_CATALOG_SQL}),
  snapshot AS (SELECT count(*) AS components,jsonb_object_agg(name,to_jsonb(catalog)) AS objects FROM catalog)
SELECT CASE WHEN components<>5 THEN 'drift'
  WHEN ${noFunctions} AND ${exact('store_order_invoice','base')}
    AND ${absent('store_order_invoice_evidence')} AND ${absent('store_order_invoice_allocation')} THEN 'fresh'
  WHEN ${validHistory} AND ${absent('store_order_invoice_allocation')} THEN 'v1'
  WHEN ${validHistory} AND ${exact('store_order_invoice_allocation','allocation')} THEN 'v2'
  WHEN ${noFunctions} AND ${exact('store_order_invoice','base')}
    AND ${exact('store_order_invoice_evidence','bareHistory')} AND ${exact('store_order_invoice_allocation','bareAllocation')} THEN 'orm-pending'
  ELSE 'drift' END AS state FROM snapshot`;
