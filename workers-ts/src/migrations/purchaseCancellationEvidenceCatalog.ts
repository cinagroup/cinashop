/** PG16 metadata-only proof, including the trigger attached to the source order.
 * No receipt/source data is read and no drift is repaired. */
export const PURCHASE_CANCELLATION_CATALOG_SQL = String.raw`
WITH relations AS (
  SELECT c.* FROM pg_catalog.pg_class c WHERE c.oid=pg_catalog.to_regclass('public.store_order_purchase_cancellation')
), components AS (
  SELECT 'store_order_purchase_cancellation'::text AS name,r.oid,r.relowner AS owner,
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
      WHERE a.grantee<>p.proowner)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_trigger t WHERE t.tgfoid=p.oid AND NOT (
      (p.proname='begin_purchase_cancellation_v1' AND t.tgname='sopc_order_transition' AND t.tgrelid=to_regclass('public.store_order'))
      OR (p.proname='capture_purchase_cancellation_v1' AND t.tgname='sopc_capture' AND t.tgrelid=to_regclass('public.store_order_purchase_cancellation'))
      OR (p.proname='validate_purchase_cancellation_v1' AND t.tgname='sopc_validate' AND t.tgrelid=to_regclass('public.store_order_purchase_cancellation'))
      OR (p.proname='protect_purchase_cancellation_v1' AND t.tgname IN ('sopc_no_rewrite','sopc_no_truncate') AND t.tgrelid=to_regclass('public.store_order_purchase_cancellation')))),
    jsonb_build_object('definition',CASE WHEN p.prokind='f' THEN pg_get_functiondef(p.oid) END,
      'support',p.prosupport::text,'binary',p.probin,'argtypes',p.proargtypes::text),'pg_proc'::regclass
  FROM pg_catalog.pg_proc p WHERE p.pronamespace='public'::regnamespace
    AND p.proname IN ('begin_purchase_cancellation_v1','capture_purchase_cancellation_v1','validate_purchase_cancellation_v1','protect_purchase_cancellation_v1')
  UNION ALL
  SELECT 'sopc_order_transition',t.oid,c.relowner,NOT t.tgisinternal,
    jsonb_build_object('definition',pg_get_triggerdef(t.oid,false),'enabled',t.tgenabled::text,
      'deferrable',t.tgdeferrable,'deferred',t.tginitdeferred,'parent',t.tgparentid::text),'pg_trigger'::regclass
  FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid
    WHERE t.tgrelid=to_regclass('public.store_order') AND t.tgname='sopc_order_transition'
)
SELECT name,oid::text AS oid,owner=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=current_user) AS owned,
  safe AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_depend d WHERE d.classid=c.catalog AND d.objid=c.oid
    AND d.deptype IN ('e','x')) AS safe,
  encode(sha256(convert_to(shape::text,'UTF8')),'hex') AS fingerprint
FROM components c ORDER BY name COLLATE "C",oid
`;

/** Fixed only from the reviewed canonical DDL on an owned native PG16 database. */
export const PURCHASE_CANCELLATION_FINGERPRINTS = {
  store_order_purchase_cancellation: 'bd28aae90f21d33e47870f977d5de0d8be8ecf85c35dfe26eccdab9aa47f4729',
  begin_purchase_cancellation_v1: 'f8fa73642f10e09097b498fcd8719de20cb5a902783d95d757dab11e02918c19',
  capture_purchase_cancellation_v1: '5212ccba912454c3cdcd3d53b0e8b6d1ee1272d0df10e01fec534815069c71e2',
  validate_purchase_cancellation_v1: '62e5541fde33a9c6666dc7e382b6b4355777d7c39a82d172afc9288f5879edfc',
  protect_purchase_cancellation_v1: '2666faef1c503cc067a096b147f3070874c2b885ab14a20422bbdb2a430277ec',
  sopc_order_transition: 'aba99ae49b039104eeb7c079426302ffc5bd25fd8baf1797a7eb65ae1723ce15',
} as const;
/** Exact unprotected generated table only; not emptiness or history proof. */
export const PURCHASE_CANCELLATION_ORM_FINGERPRINT = 'fa732b88148e7dc49e486a235fa5875b47696317b84b78e6d416a3ba99ec547d';
export const PURCHASE_CANCELLATION_STATE_SQL = `WITH catalog AS (${PURCHASE_CANCELLATION_CATALOG_SQL}),
  snapshot AS (SELECT count(*) AS n,jsonb_object_agg(name,to_jsonb(catalog)) AS objects FROM catalog)
SELECT CASE WHEN n=0 AND to_regclass('public.sopc_buyer_history') IS NULL
  AND to_regclass('public.store_order_purchase_cancellation_pkey') IS NULL THEN 'fresh'
  WHEN n=6 AND ${Object.entries(PURCHASE_CANCELLATION_FINGERPRINTS).map(([name,fingerprint]) =>
    `(objects->'${name}') @> '${JSON.stringify({ owned:true,safe:true,fingerprint })}'::jsonb`).join(' AND ')} THEN 'v1'
  WHEN n=1 AND (objects->'store_order_purchase_cancellation') @>
    '${JSON.stringify({ owned:true,safe:true,fingerprint:PURCHASE_CANCELLATION_ORM_FINGERPRINT })}'::jsonb
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class c CROSS JOIN LATERAL
      pg_catalog.aclexplode(COALESCE(c.relacl,pg_catalog.acldefault('r',c.relowner))) a
      WHERE c.oid=to_regclass('public.store_order_purchase_cancellation') AND a.grantee<>c.relowner) THEN 'orm-pending'
  ELSE 'drift' END AS state FROM snapshot`;
