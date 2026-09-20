/** PG16 catalog-only inspection of the two append-only refund-generation
 * ledgers. No business snapshots are read. Safe SELECT/INSERT grants survive. */
export const REFUND_SPLIT_CATALOG_SQL = `
WITH relations AS (
  SELECT name,c.* FROM (VALUES ('store_order_refund_split'),('store_order_fulfillment_branch')) names(name)
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
      WHERE a.grantee<>relowner AND (a.grantee=0 OR a.is_grantable OR a.privilege_type NOT IN ('SELECT','INSERT')))
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
  SELECT name,p.* FROM (VALUES('protect_refund_order_split')) names(name)
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

/** PG16.15 native SQL and independent ORM probes produce these same shapes. */
export const REFUND_SPLIT_CATALOG_VERSIONS = {
  bareSplit: '6e243dbfc5ad50b83b1b8f4ad35ac6160162fc726b42421252d3edf7b38dfcfd',
  bareBranch: '8e43b49efa6a271d648ae00547f0b33de26f37450d3263ff035edde131ec4927',
  split: '896ba119f78638caa9db3cd9b52d0023dd21bce0dbef91fc67406767aab40ef4',
  branch: '52b82ca8221ca45b7700eb3db940cc036dddd956142e3c6716e79dbc58f6bb9c',
  protect: 'c514fe34f9887575b9b8e3dcb162a3ef437bb1d95a545a28aef6578c450b3b38',
} as const;
const exact=(name: string,key: keyof typeof REFUND_SPLIT_CATALOG_VERSIONS)=>
  `(objects->'${name}') @> '${JSON.stringify({present:true,owned:true,safe:true,fingerprint:REFUND_SPLIT_CATALOG_VERSIONS[key]})}'::jsonb`;
const absent=(name: string)=>`(objects->'${name}') @> '{"present":false}'::jsonb`;
export const REFUND_SPLIT_STATE_SQL = `WITH catalog AS (${REFUND_SPLIT_CATALOG_SQL}),
  snapshot AS (SELECT count(*) AS components,jsonb_object_agg(name,to_jsonb(catalog)) AS objects FROM catalog)
SELECT CASE WHEN components<>3 THEN 'drift'
  WHEN ${absent('store_order_refund_split')} AND ${absent('store_order_fulfillment_branch')}
    AND ${absent('protect_refund_order_split')} THEN 'fresh'
  WHEN ${exact('store_order_refund_split','split')} AND ${exact('store_order_fulfillment_branch','branch')}
    AND ${exact('protect_refund_order_split','protect')} THEN 'v1'
  WHEN ${exact('store_order_refund_split','bareSplit')} AND ${exact('store_order_fulfillment_branch','bareBranch')}
    AND ${absent('protect_refund_order_split')} THEN 'orm-pending'
  ELSE 'drift' END AS state FROM snapshot`;
