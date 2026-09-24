/** PG16 catalog-only proof. Never read or repair saved purchase data. */
export const PURCHASE_ORIGIN_CATALOG_SQL = String.raw`
WITH relations AS (
  SELECT c.* FROM pg_catalog.pg_class c WHERE c.oid=pg_catalog.to_regclass('public.store_order_purchase_origin')
), components AS (
  SELECT 'store_order_purchase_origin'::text AS name,r.oid,r.relowner AS owner,
    r.relkind='r' AND r.relpersistence='p' AND NOT r.relispartition AND NOT r.relrowsecurity
    AND NOT r.relforcerowsecurity AND r.relreplident='d' AND r.reloptions IS NULL AND r.reltablespace=0
    AND r.relam=(SELECT oid FROM pg_catalog.pg_am WHERE amname='heap')
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_inherits WHERE inhrelid=r.oid OR inhparent=r.oid)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_policy WHERE polrelid=r.oid)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_rewrite WHERE ev_class=r.oid)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_constraint WHERE confrelid=r.oid)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_attribute WHERE attrelid=r.oid AND attnum>0 AND attisdropped)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.aclexplode(COALESCE(r.relacl,pg_catalog.acldefault('r',r.relowner))) a
      WHERE a.grantee<>r.relowner AND (a.grantee=0 OR a.is_grantable OR a.privilege_type NOT IN ('SELECT','INSERT')))
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_attribute col CROSS JOIN LATERAL pg_catalog.aclexplode(col.attacl) a
      WHERE col.attrelid=r.oid AND a.grantee<>r.relowner)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class ic ON ic.oid=i.indexrelid
      WHERE i.indrelid=r.oid AND (ic.relowner<>r.relowner OR ic.relacl IS NOT NULL OR ic.reltablespace<>0
        OR ic.relkind<>'i' OR ic.relispartition OR i.indisclustered)) AS safe,
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
    ) AS shape,'pg_class'::regclass AS catalog FROM relations r
  UNION ALL
  SELECT p.proname,p.oid,p.proowner,
    p.prokind='f' AND p.pronargs=0 AND p.prorettype='trigger'::regtype AND NOT p.proretset
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a
      WHERE a.grantee<>p.proowner),
    jsonb_build_object('definition',CASE WHEN p.prokind='f' THEN pg_get_functiondef(p.oid) END,
      'support',p.prosupport::text,'binary',p.probin,'argtypes',p.proargtypes::text),'pg_proc'::regclass
  FROM pg_catalog.pg_proc p WHERE p.pronamespace='public'::regnamespace
    AND p.proname IN ('capture_purchase_origin_v1','protect_purchase_origin_v1')
)
SELECT name,oid::text AS oid,owner=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=current_user) AS owned,
  safe AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_depend d WHERE d.classid=c.catalog AND d.objid=c.oid
    AND d.deptype IN ('e','x')) AS safe,
  encode(sha256(convert_to(shape::text,'UTF8')),'hex') AS fingerprint
FROM components c ORDER BY name COLLATE "C",oid
`;

/** Populated only from a reviewed fresh native PG16 catalog, never from live drift. */
export const PURCHASE_ORIGIN_FINGERPRINTS = {
  store_order_purchase_origin: '80624f4306e5068e29049378ed60fee74d9be400141683617dd64fc4a35aaa47',
  capture_purchase_origin_v1: '20636b669b73811823258b6077253f10a927d26e408b4bdba0a535534a438da5',
  protect_purchase_origin_v1: 'd47c48808b41485c83f90f1e52f8e33d2358f4de73cf4b0dbe362319c5fe841a',
} as const;
/** Catalog of the exact generated ORM table, without any trigger or function.
 * This says nothing about emptiness or historical provenance. */
export const PURCHASE_ORIGIN_ORM_FINGERPRINT = 'b57659ad3d188f54bc2554a3a6c9265b93d0dca084a2fd6d26367d84b73ef47f';
export const PURCHASE_ORIGIN_STATE_SQL = `WITH catalog AS (${PURCHASE_ORIGIN_CATALOG_SQL}),
  snapshot AS (SELECT count(*) AS n,jsonb_object_agg(name,to_jsonb(catalog)) AS objects FROM catalog)
SELECT CASE WHEN n=0 AND to_regclass('public.sopo_buyer_history') IS NULL
  AND to_regclass('public.store_order_purchase_origin_pkey') IS NULL THEN 'fresh'
  WHEN n=3 AND ${Object.entries(PURCHASE_ORIGIN_FINGERPRINTS).map(([name, fingerprint]) =>
    `(objects->'${name}') @> '${JSON.stringify({ owned: true, safe: true, fingerprint })}'::jsonb`).join(' AND ')} THEN 'v1'
  WHEN n=1 AND (objects->'store_order_purchase_origin') @>
    '${JSON.stringify({ owned: true, safe: true, fingerprint: PURCHASE_ORIGIN_ORM_FINGERPRINT })}'::jsonb
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class c
      CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(c.relacl,pg_catalog.acldefault('r',c.relowner))) a
      WHERE c.oid=to_regclass('public.store_order_purchase_origin') AND a.grantee<>c.relowner) THEN 'orm-pending'
  ELSE 'drift' END AS state FROM snapshot`;
