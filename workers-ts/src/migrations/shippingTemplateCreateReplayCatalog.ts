/** Fixed public-table catalog query, with no business-row read or SQL supplied by callers. */
export const SHIPPING_CREATE_REPLAY_CATALOG_SQL = `
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
FROM (VALUES(to_regclass('public.shipping_template_create_replay'))) target(id)
LEFT JOIN pg_class c ON c.oid=target.id`;

/** PG16 canonical definitions, independently compared to both SQL and ORM DDL. */
export const SHIPPING_CREATE_REPLAY_EXPECTED_SHAPE = {
  columns: [
    [1, 'owner_type', 'smallint', true, null, '', '', null],
    [2, 'relation_id', 'integer', true, null, '', '', null],
    [3, 'actor_id', 'integer', true, null, '', '', null],
    [4, 'request_key', 'uuid', true, null, '', '', null],
    [5, 'request_hash', 'character varying(64)', true, null, '', '', 'pg_catalog.default'],
    [6, 'template_id', 'integer', true, null, '', '', null],
    [7, 'created_at', 'timestamp with time zone', true, 'clock_timestamp()', '', '', null],
  ],
  constraints: [
    ['stcr_hash_ck', 'c', "CHECK (((request_hash)::text ~ '^[0-9a-f]{64}$'::text))"],
    ['stcr_identity_ck', 'c', 'CHECK (((actor_id > 0) AND (template_id > 0)))'],
    ['stcr_key_ck', 'c', "CHECK (((request_key)::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'::text))"],
    ['stcr_pk', 'p', 'PRIMARY KEY (owner_type, relation_id, actor_id, request_key)'],
    ['stcr_scope_ck', 'c', 'CHECK ((((owner_type = 0) AND (relation_id = 0)) OR ((owner_type = 2) AND (relation_id > 0))))'],
    ['stcr_template_uq', 'u', 'UNIQUE (template_id)'],
  ].map(([name, type, definition]) => [name, type, definition, true, false, false, type !== 'c', true, 0, '0']),
  indexes: [
    ['stcr_pk', 'CREATE UNIQUE INDEX stcr_pk ON public.shipping_template_create_replay USING btree (owner_type, relation_id, actor_id, request_key)',
      true, true, true, true, true, true, false, false, false, 4, 4, '1 2 3 4', '0 0 0 0', null, 'stcr_pk'],
    ['stcr_template_uq', 'CREATE UNIQUE INDEX stcr_template_uq ON public.shipping_template_create_replay USING btree (template_id)',
      true, false, true, true, true, true, false, false, false, 1, 1, '6', '0', null, 'stcr_template_uq'],
  ],
};

export const SHIPPING_CREATE_REPLAY_COMPATIBILITY_SQL = `SELECT present,oid,
  present AND safe AND shape = $stcr_shape$${JSON.stringify(SHIPPING_CREATE_REPLAY_EXPECTED_SHAPE)}$stcr_shape$::jsonb AS compatible
FROM (${SHIPPING_CREATE_REPLAY_CATALOG_SQL}) catalog`;
