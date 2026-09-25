/** Reviewed PG16 catalog contract. Reads catalog metadata, never payment payloads.
 * Shared-table fingerprints cover columns/constraints/indexes and this protocol's
 * triggers; unrelated business triggers/ACLs require their own commissioning.
 * Shared columns are compared by name, indexes by full definition, not physical
 * attnum/indkey: historical ALTER order differs from fresh ORM construction.
 * Newly owned ledger columns retain strict physical-position checks. */
export const OFFLINE_TABLES = [
  'offline_order_admission', 'offline_order_payment_selection', 'offline_order_balance',
  'offline_order_query_evidence', 'offline_order_callback_binding', 'offline_order_external_payment',
  'offline_order_payment_dispatch',
] as const;
export const OFFLINE_DEPENDENCIES = [
  'member_right', 'system_config', 'payment_callback_event', 'payment_reconciliation_case',
  'other_order', 'user', 'wechat_user', 'user_money', 'user_bill', 'store_order_economize',
] as const;
export const OFFLINE_FUNCTIONS = [
  'ooa_lock_pricing', 'ooa_guard', 'oops_guard', 'oops_wallet_commit', 'oob_guard',
  'ooqe_guard', 'oocb_guard', 'ooep_guard', 'ooep_paid_commit', 'oopd_guard',
] as const;
export const OFFLINE_DISPATCH_COLUMNS = ['state', 'ticket_payload', 'ticket_hash', 'finished_at', 'display_until'] as const;
const values = (names: readonly string[]) => names.map(name => `('${name}')`).join(',');
const strings = (names: readonly string[]) => names.map(name => `'${name}'`).join(',');

export const OFFLINE_CATALOG_SQL = `
WITH relations AS (
  SELECT name,c.*,name IN (${strings(OFFLINE_TABLES)}) AS ledger
  FROM (VALUES ${values([...OFFLINE_DEPENDENCIES, ...OFFLINE_TABLES])}) names(name)
  LEFT JOIN pg_catalog.pg_class c ON c.oid=pg_catalog.to_regclass('public."'||name||'"')
), tables AS (
  SELECT name,oid,relowner AS owner,
    relkind='r' AND relpersistence='p' AND NOT relispartition
    AND NOT relrowsecurity AND NOT relforcerowsecurity AND relreplident='d' AND reloptions IS NULL
    AND relam=(SELECT oid FROM pg_catalog.pg_am WHERE amname='heap')
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_inherits WHERE inhrelid=r.oid OR inhparent=r.oid)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_policy WHERE polrelid=r.oid)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_rewrite WHERE ev_class=r.oid)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_attribute WHERE attrelid=r.oid AND attnum>0 AND attisdropped)
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_trigger WHERE tgrelid=r.oid AND tgisinternal AND tgenabled<>'O')
    AND (NOT ledger OR (
      NOT EXISTS(SELECT 1 FROM pg_catalog.aclexplode(COALESCE(relacl,pg_catalog.acldefault('r',relowner))) a
        WHERE a.grantee<>relowner AND (a.grantee=0 OR a.is_grantable OR a.privilege_type NOT IN ('SELECT','INSERT')))
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_attribute col CROSS JOIN LATERAL pg_catalog.aclexplode(col.attacl) a
        WHERE col.attrelid=r.oid AND a.grantee<>relowner AND
          (a.grantee=0 OR a.is_grantable OR name<>'offline_order_payment_dispatch'
            OR col.attname NOT IN (${strings(OFFLINE_DISPATCH_COLUMNS)}) OR a.privilege_type<>'UPDATE'))
    )) AS safe,
    jsonb_build_object(
      'columns',(SELECT jsonb_agg(jsonb_build_array(CASE WHEN r.ledger THEN a.attnum END,a.attname,format_type(a.atttypid,a.atttypmod),a.attnotnull,
        pg_get_expr(d.adbin,d.adrelid),a.attidentity::text,a.attgenerated::text,
        CASE WHEN a.attcollation=0 THEN NULL ELSE cn.nspname||'.'||co.collname END)
        ORDER BY CASE WHEN r.ledger THEN a.attnum END,a.attname COLLATE "C")
        FROM pg_catalog.pg_attribute a LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
        LEFT JOIN pg_catalog.pg_collation co ON co.oid=a.attcollation LEFT JOIN pg_catalog.pg_namespace cn ON cn.oid=co.collnamespace
        WHERE a.attrelid=r.oid AND a.attnum>0 AND NOT a.attisdropped),
      'constraints',(SELECT jsonb_agg(jsonb_build_array(k.conname,k.contype::text,pg_get_constraintdef(k.oid,false),
        k.convalidated,k.condeferrable,k.condeferred,k.connoinherit,k.conislocal,k.coninhcount,k.conparentid::text)
        ORDER BY k.conname COLLATE "C") FROM pg_catalog.pg_constraint k WHERE k.conrelid=r.oid),
      'indexes',(SELECT jsonb_agg(jsonb_build_array(ic.relname,pg_get_indexdef(i.indexrelid),i.indisunique,i.indisprimary,
        i.indisvalid,i.indisready,i.indislive,i.indimmediate,i.indisexclusion,i.indnullsnotdistinct,i.indisreplident,
        i.indnatts,i.indnkeyatts,CASE WHEN r.ledger THEN i.indkey::text END,i.indoption::text,ic.reloptions,ic.relpersistence)
        ORDER BY ic.relname COLLATE "C") FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class ic ON ic.oid=i.indexrelid WHERE i.indrelid=r.oid),
      'triggers',(SELECT jsonb_agg(jsonb_build_array(t.tgname,pg_get_triggerdef(t.oid,false),t.tgenabled::text)
        ORDER BY t.tgname COLLATE "C") FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_proc p ON p.oid=t.tgfoid
        WHERE t.tgrelid=r.oid AND NOT t.tgisinternal AND (r.ledger OR p.proname IN (${strings(OFFLINE_FUNCTIONS)})
          OR t.tgname ~ '^(ooa|oops|oob|ooqe|oocb|ooep|oopd)_'))
    ) AS shape
  FROM relations r
), functions AS (
  SELECT name,p.* FROM (VALUES ${values(OFFLINE_FUNCTIONS)}) names(name)
  LEFT JOIN pg_catalog.pg_proc p ON p.pronamespace='public'::regnamespace AND p.proname=name
), components AS (
  SELECT 'table' AS kind,name,oid,owner,safe,shape FROM tables
  UNION ALL
  SELECT 'function',name,oid,proowner,
    prokind='f' AND pronargs=0 AND NOT proretset
    AND prorettype=CASE WHEN name='ooa_lock_pricing' THEN 'void'::regtype ELSE 'trigger'::regtype END
    AND NOT EXISTS(SELECT 1 FROM pg_catalog.aclexplode(COALESCE(proacl,pg_catalog.acldefault('f',proowner))) a
      WHERE a.grantee<>proowner AND (name<>'ooa_lock_pricing' OR a.grantee=0 OR a.is_grantable OR a.privilege_type<>'EXECUTE')),
    jsonb_build_object('definition',CASE WHEN prokind='f' THEN pg_get_functiondef(oid) END,
      'support',prosupport::text,'binary',probin,'argtypes',proargtypes::text)
  FROM functions
)
SELECT kind,name,oid::text AS oid,oid IS NOT NULL AS present,
  owner=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=current_user) AS owned,safe,
  encode(sha256(convert_to(shape::text,'UTF8')),'hex') AS fingerprint
FROM components ORDER BY kind COLLATE "C",name COLLATE "C",oid
`;

// Filled only from independently executed PG16 canonical DDL probes and pinned
// in tests. Never learn or accept the target database's current shape at runtime.
export const OFFLINE_CATALOG_VERSIONS: { fresh: Record<string, string>; v1: Record<string, string> } = {
  fresh: {
    member_right: 'ffed4c38d3893a186f8614d982dd397e0990cf9b068e696b1fd7afe7d5cbb331',
    other_order: '1756e4e38c754862d1c76faac3e4ebbcf105484e09bddcabffc27e26dfbf820b',
    payment_callback_event: '977bf01c7e6aa9af22a11bcc13321cf8ea6496fc53f13bab1bf3e10620f255e1',
    payment_reconciliation_case: 'fe607b08a5f66a653a673aa0ca8626a38d0e3482f4d7fccc618bf64f524ab959',
    store_order_economize: '2383680a0cd0cd12c917c3b5214d4da6ad9facf5bc81f8c3f745656cc02b106c',
    system_config: '10becbd6bf8ae6ed41dba14e474fc8529df4116c61e84365b60c50d11e1b4336',
    user: '9d8390088ef56e1c24f25b892d34cf73a403774e701a0831d189799c9bb33f7b',
    user_bill: '20a4ab84699fafe290e741577d22751bda9bda056c90ac9dcdc15f1b4560b434',
    user_money: '17f28481406ae65e3b6143ed87215cfa75c892050e1814f882e79687dac8fcf2',
    wechat_user: 'fb68f9c18236ea7f757726df87997cab1387479b6ee7690fef6ce38e6adba926',
  },
  v1: {
    ooa_guard: 'c80995492c819e825a4c6a2d8ce5f8bde530395a3b9d514d8cbbdbc41e46f113',
    ooa_lock_pricing: '769c62a6fd1a877cc65936b35cb4dccc410ab56d2e4fe49811eacd678b17f1e4',
    oob_guard: '3fb3bd3d42e4c192cac8b9c1932b51f5fe64dfc33af5f748f2dd7d7ee2e099cc',
    oocb_guard: '3f1da24b0ba0029d08f55b6c8dcda2dc5ee2d40b53cea0a4495cbc1084e8fe1d',
    ooep_guard: '4306e4f1925b75b89453fda45b8d702c3416a28edd4162b1a34344b79385885f',
    ooep_paid_commit: '8022926f11369fa0ea4cd831457583e01f01880c815e7b72b373ba5558788cda',
    oopd_guard: 'e4b7fa82b42e02657d7a1506302a1d745ac93a9502d3100267913ed80b81700d',
    oops_guard: '67439718137fdeb553f6a6cad68ee902c70d5951584c81fe1d59f83d0349ff3b',
    oops_wallet_commit: 'b5573ef82f4949c37bba0eca8ea30dde4ea08498fe98549611fa533689836e34',
    ooqe_guard: 'ad94dd2742c99be1d7bbbe153ec796c5f8961b36bd2530850f2c3d99eb9724c8',
    member_right: 'ffed4c38d3893a186f8614d982dd397e0990cf9b068e696b1fd7afe7d5cbb331',
    offline_order_admission: 'ca8934a5ce2de0e3be7f4e44f7e319bbd403446afce3fcf0ef4b1f183d129dc5',
    offline_order_balance: 'fcb99e1c7e771beae2d0e12f7ea0aef4503bb9388c517ab10922528661233e04',
    offline_order_callback_binding: 'c7bb72246c2b570eb59a6bab216c8407f99fd4bf07c0068dca4d93f1a00950fb',
    offline_order_external_payment: '9af3b51fb27fb019819792631101f8ea0220fbddfbc28b32b307e7872d658fad',
    offline_order_payment_dispatch: '652aa0cacb3623929f786b02e68298291e547118ce3579d944b03f4fafc0f8c2',
    offline_order_payment_selection: '2c1f93e917c14b3c0a369be6d613ccc33672c40e57ea461a799b4fab4dbd0f75',
    offline_order_query_evidence: '7e55d1410febfd9545f3f1694aec7b46ee3465a1b28fb469836d161bddf9e490',
    other_order: '92e3fdeb757cffb0b460329157b265a8be401559655b96f0e94238119ac79d5f',
    payment_callback_event: 'c4533e013200eb3398f043952b87b3751369e1d6c7dcad296454fe703862d53b',
    payment_reconciliation_case: '661c6de1684ecbff9630e049d43e14263f01f60b8cd46ac1bf2aa71a74bd6739',
    store_order_economize: 'af93acc31f1e2011b8c4450064bf7506990768f899229d6153f6882e804a6a19',
    system_config: '10becbd6bf8ae6ed41dba14e474fc8529df4116c61e84365b60c50d11e1b4336',
    user: '9d8390088ef56e1c24f25b892d34cf73a403774e701a0831d189799c9bb33f7b',
    user_bill: '8c28df2335af833c85658983df4e03c1202fdaa612550407122433b049ea19d5',
    user_money: 'fc130d4977144e49c38c190a7949db01c472622a676b88bf525179ebac4d0290',
    wechat_user: 'fb68f9c18236ea7f757726df87997cab1387479b6ee7690fef6ce38e6adba926',
  },
};
/** Independently generated complete ORM schema, before any protection exists. */
export const OFFLINE_ORM_CATALOG_VERSIONS: Record<string, string> = {
  ...OFFLINE_CATALOG_VERSIONS.fresh,
  offline_order_admission: '0c2a9fc2cb738c76b6ac518fa0cc71832e773e1b28328a4e310d8d9b8dc08a94',
  offline_order_balance: '0555c78f98eefbd1392281c7698ca5f930be1ca1ae4f50d805d9ccb59102ce28',
  offline_order_callback_binding: 'ecd8ba1c25926cd6304844d0c3697ebd57e61f96e494870c5c152baaf3cf95f2',
  offline_order_external_payment: '65b9f9beb5b0652e8cf4ecf29325423375b0f62960bf3427032ebadc9112d7ae',
  offline_order_payment_dispatch: 'd92333abf3ab54db25503ece15dec2e4620d7ac063bb3ad3840578ed02aa0529',
  offline_order_payment_selection: '12abd2bff4cb2ec209fb55bac6dcbafa258a9e5fa9ef11c4b3ddb948956ae934',
  offline_order_query_evidence: 'c4b4ea1fbdb70e8b1b8e0131a6dae516c1e78aefd5566f5a24b961ce8a46adf2',
  payment_callback_event: '4ee2a3598865029344ff616079f864732d515805c9f3256c8bf96c4e961ff4f8',
  payment_reconciliation_case: '661c6de1684ecbff9630e049d43e14263f01f60b8cd46ac1bf2aa71a74bd6739',
  user_bill: 'b0390aca3bbc3e790de7581444678f594a65d1778187b05fd2701f2994f2faf9',
  user_money: '7d80098a75e284bc393dd16dc98fb867435cc3fc4f107f43aaa490c2a560e763',
};
// The offline installer runs before member-barcode migration 0173. Retain its
// exact prior catalog versions and recognize the independently verified index
// delta after 0173; the member-code endpoint separately requires that index.
const MEMBER_BARCODE_USER_FINGERPRINT = 'dfb5e16b3b94a8035c0911768c9ce9a9ac155eeb6e8809057b3f1195b1e6c8b1';
export const OFFLINE_BARCODE_CATALOG_VERSIONS: { fresh: Record<string, string>; v1: Record<string, string>; orm: Record<string, string> } = {
  fresh: { ...OFFLINE_CATALOG_VERSIONS.fresh, user: MEMBER_BARCODE_USER_FINGERPRINT },
  v1: { ...OFFLINE_CATALOG_VERSIONS.v1, user: MEMBER_BARCODE_USER_FINGERPRINT },
  orm: { ...OFFLINE_ORM_CATALOG_VERSIONS, user: MEMBER_BARCODE_USER_FINGERPRINT },
};
const matches = (expected: Record<string, string>, missing: readonly string[]) =>
  [...Object.entries(expected).map(([name, fingerprint]) => `(objects->'${name}') @> '${JSON.stringify({ present: true, owned: true, safe: true, fingerprint })}'::jsonb`),
    ...missing.map(name => `(objects->'${name}') @> '{"present":false}'::jsonb`)].join(' AND ') || 'false';
export const OFFLINE_STATE_SQL = `WITH catalog AS (${OFFLINE_CATALOG_SQL}),
  snapshot AS (SELECT count(*) AS components,jsonb_object_agg(name,to_jsonb(catalog)) AS objects FROM catalog)
SELECT CASE WHEN components<>27 THEN 'drift'
  WHEN (${matches(OFFLINE_CATALOG_VERSIONS.fresh, [...OFFLINE_TABLES, ...OFFLINE_FUNCTIONS])}
    OR ${matches(OFFLINE_BARCODE_CATALOG_VERSIONS.fresh, [...OFFLINE_TABLES, ...OFFLINE_FUNCTIONS])}) THEN 'fresh'
  WHEN (${matches(OFFLINE_CATALOG_VERSIONS.v1, [])}
    OR ${matches(OFFLINE_BARCODE_CATALOG_VERSIONS.v1, [])}) THEN 'v1'
  WHEN (${matches(OFFLINE_ORM_CATALOG_VERSIONS, OFFLINE_FUNCTIONS)}
    OR ${matches(OFFLINE_BARCODE_CATALOG_VERSIONS.orm, OFFLINE_FUNCTIONS)}) THEN 'orm-pending'
  ELSE 'drift' END AS state FROM snapshot`;
