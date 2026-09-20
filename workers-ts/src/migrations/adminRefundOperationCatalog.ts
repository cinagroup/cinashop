/** Fixed public-table inspection. No business-row read or caller-supplied SQL. */
export const ADMIN_REFUND_OPERATION_CATALOG_SQL = `
SELECT c.oid IS NOT NULL AS present, c.oid::text AS oid,
  c.relkind='r' AND c.relpersistence='p' AND NOT c.relispartition
  AND NOT c.relrowsecurity AND NOT c.relforcerowsecurity AND c.relreplident='d'
  AND c.reloptions IS NULL AND c.relowner=(SELECT oid FROM pg_roles WHERE rolname=current_user)
  AND c.relchecks=4 AND c.relnatts=7 AND c.relam=(SELECT oid FROM pg_am WHERE amname='heap')
  AND NOT EXISTS(SELECT 1 FROM pg_inherits WHERE inhrelid=c.oid OR inhparent=c.oid)
  AND NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=c.oid)
  AND NOT EXISTS(SELECT 1 FROM pg_rewrite WHERE ev_class=c.oid)
  AND NOT EXISTS(SELECT 1 FROM pg_policy WHERE polrelid=c.oid)
  AND NOT EXISTS(SELECT 1 FROM pg_constraint WHERE confrelid=c.oid)
  AND NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=c.oid AND attnum>0 AND attisdropped)
  AND NOT EXISTS(SELECT 1 FROM aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) a
    WHERE a.grantee<>c.relowner AND (a.grantee=0 OR a.is_grantable OR a.privilege_type NOT IN ('SELECT','INSERT')))
  AND NOT EXISTS(SELECT 1 FROM pg_attribute col CROSS JOIN LATERAL aclexplode(col.attacl) a
    WHERE col.attrelid=c.oid AND a.grantee<>c.relowner
      AND (a.grantee=0 OR a.is_grantable OR a.privilege_type NOT IN ('SELECT','INSERT'))) AS safe,
  jsonb_build_object(
    'columns',(SELECT jsonb_agg(jsonb_build_array(a.attnum,a.attname,format_type(a.atttypid,a.atttypmod),a.attnotnull,
      pg_get_expr(d.adbin,d.adrelid),a.attidentity::text,a.attgenerated::text,
      CASE WHEN a.attcollation=0 THEN NULL ELSE cn.nspname||'.'||co.collname END) ORDER BY a.attnum)
      FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
      LEFT JOIN pg_collation co ON co.oid=a.attcollation LEFT JOIN pg_namespace cn ON cn.oid=co.collnamespace
      WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),
    'constraints',(SELECT jsonb_agg(jsonb_build_array(k.conname,k.contype::text,pg_get_constraintdef(k.oid,false),
      k.convalidated,k.condeferrable,k.condeferred,k.connoinherit,k.conislocal,k.coninhcount,k.conparentid::text)
      ORDER BY k.conname COLLATE "C") FROM pg_constraint k WHERE k.conrelid=c.oid),
    'indexes',(SELECT jsonb_agg(jsonb_build_array(ic.relname,pg_get_indexdef(i.indexrelid),i.indisunique,i.indisprimary,
      i.indisvalid,i.indisready,i.indislive,i.indimmediate,i.indisexclusion,i.indnullsnotdistinct,i.indisreplident,
      i.indnatts,i.indnkeyatts,i.indkey::text,i.indoption::text,ic.reloptions,
      (SELECT k.conname FROM pg_constraint k WHERE k.conindid=i.indexrelid AND k.contype IN ('p','u')))
      ORDER BY ic.relname COLLATE "C") FROM pg_index i JOIN pg_class ic ON ic.oid=i.indexrelid WHERE i.indrelid=c.oid)
  ) AS shape
FROM (VALUES(to_regclass('public.admin_refund_operation'))) target(id)
LEFT JOIN pg_class c ON c.oid=target.id`;

/** PostgreSQL16 canonical shape, tested independently against SQL and ORM DDL. */
export const ADMIN_REFUND_OPERATION_EXPECTED_SHAPE = {
  columns: [
    [1,'admin_id','integer',true,null,'','',null],
    [2,'request_key','uuid',true,null,'','',null],
    [3,'request_hash','character varying(64)',true,null,'','','pg_catalog.default'],
    [4,'refund_id','integer',true,null,'','',null],
    [5,'action','character varying(8)',true,null,'','','pg_catalog.default'],
    [6,'outcome','character varying(24)',true,null,'','','pg_catalog.default'],
    [7,'created_at','timestamp with time zone',true,'clock_timestamp()','','',null],
  ],
  constraints: [
    ['aro_hash_ck','c',"CHECK (((request_hash)::text ~ '^[0-9a-f]{64}$'::text))"],
    ['aro_identity_ck','c','CHECK (((admin_id > 0) AND (refund_id > 0)))'],
    ['aro_key_ck','c',"CHECK (((request_key)::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'::text))"],
    ['aro_outcome_ck','c',"CHECK (((((action)::text = 'return'::text) AND ((outcome)::text = ANY ((ARRAY['return-approved'::character varying, 'abandoned'::character varying])::text[]))) OR (((action)::text = 'refuse'::text) AND ((outcome)::text = ANY ((ARRAY['refused'::character varying, 'abandoned'::character varying])::text[]))) OR (((action)::text = 'refund'::text) AND ((outcome)::text = ANY ((ARRAY['balance-settled'::character varying, 'provider-admitted'::character varying, 'abandoned'::character varying])::text[])))))"],
    ['aro_pk','p','PRIMARY KEY (admin_id, request_key)'],
  ].map(([name,type,definition])=>[name,type,definition,true,false,false,type!=='c',true,0,'0']),
  indexes: [
    ['aro_pk','CREATE UNIQUE INDEX aro_pk ON public.admin_refund_operation USING btree (admin_id, request_key)',
      true,true,true,true,true,true,false,false,false,2,2,'1 2','0 0',null,'aro_pk'],
    ['aro_refund_history','CREATE INDEX aro_refund_history ON public.admin_refund_operation USING btree (refund_id, created_at, admin_id, request_key)',
      false,false,true,true,true,true,false,false,false,4,4,'4 7 1 2','0 0 0 0',null,null],
  ],
};

export const ADMIN_REFUND_OPERATION_COMPATIBILITY_SQL = `SELECT present,oid,
  present AND safe AND shape = $aro_shape$${JSON.stringify(ADMIN_REFUND_OPERATION_EXPECTED_SHAPE)}$aro_shape$::jsonb AS compatible
FROM (${ADMIN_REFUND_OPERATION_CATALOG_SQL}) catalog`;
