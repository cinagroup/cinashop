import { PURCHASE_PHYSICAL_ORIGIN_CAPTURE_SQL, PURCHASE_PHYSICAL_ORIGIN_PROTECT_SQL,
  physicalOriginFunctionBody } from './purchasePhysicalOriginEvidence';

const literal=(value:string)=>"'"+value.replaceAll("'","''")+"'";
const expectedColumns=[['order_id','integer'],['buyer_id','integer'],['version','text'],
  ['order_type','smallint'],['total_num','integer'],['lines','jsonb'],['recorded_at','timestamp with time zone']];
const expectedConstraints:Record<string,string>={
  store_order_purchase_physical_origin_pkey:'PRIMARY KEY (order_id)',
  store_order_purchase_physical_origin_order_id_check:'CHECK ((order_id > 0))',
  store_order_purchase_physical_origin_buyer_id_check:'CHECK ((buyer_id >= 0))',
  store_order_purchase_physical_origin_version_check:"CHECK ((version = 'purchase-physical-origin-v1'::text))",
  store_order_purchase_physical_origin_order_type_check:'CHECK (((order_type >= 0) AND (order_type <= 8)))',
  store_order_purchase_physical_origin_total_num_check:'CHECK ((total_num > 0))',
  store_order_purchase_physical_origin_lines_check:"CHECK (((jsonb_typeof(lines) = 'array'::text) AND ((jsonb_array_length(lines) >= 1) AND (jsonb_array_length(lines) <= 200)) AND (octet_length((lines)::text) <= 131072)))",
};
const bodies=[['capture_purchase_physical_origin_v1',physicalOriginFunctionBody(PURCHASE_PHYSICAL_ORIGIN_CAPTURE_SQL)],
  ['protect_purchase_physical_origin_v1',physicalOriginFunctionBody(PURCHASE_PHYSICAL_ORIGIN_PROTECT_SQL)]];

/** Exact declarative native/ORM catalog, including full fixed function bodies.
 * No sampled live fingerprint, business read, repair, DDL or grant is used. */
export const PURCHASE_PHYSICAL_ORIGIN_STATE_SQL=String.raw`WITH owner AS (
  SELECT oid FROM pg_catalog.pg_roles WHERE rolname=current_user
), relation AS (
  SELECT c.* FROM pg_catalog.pg_class c WHERE c.oid=to_regclass('public.store_order_purchase_physical_origin')
), columns_expected AS (SELECT * FROM (VALUES ${expectedColumns.map(([name,type],i)=>`(${i+1},${literal(name)},${literal(type)})`).join(',')}) e(pos,name,typ)),
constraints_expected AS (SELECT * FROM (VALUES ${Object.entries(expectedConstraints).map(([name,definition])=>`(${literal(name)},${literal(definition)})`).join(',')}) e(name,definition)),
functions_expected AS (SELECT * FROM (VALUES ${bodies.map(([name,body])=>`(${literal(name)},${literal(body)})`).join(',')}) e(name,body)),
functions_live AS (SELECT p.* FROM pg_catalog.pg_proc p WHERE p.pronamespace='public'::regnamespace
  AND p.proname IN ('capture_purchase_physical_origin_v1','protect_purchase_physical_origin_v1')),
shape AS (SELECT r.oid,
  r.relowner=(SELECT oid FROM owner) AND r.relkind='r' AND r.relpersistence='p' AND NOT r.relispartition
  AND NOT r.relrowsecurity AND NOT r.relforcerowsecurity AND r.relreplident='d'
  AND r.reloptions IS NULL AND r.reltablespace=0 AND r.relam=(SELECT oid FROM pg_am WHERE amname='heap')
  AND NOT EXISTS(SELECT 1 FROM pg_inherits WHERE inhrelid=r.oid OR inhparent=r.oid)
  AND NOT EXISTS(SELECT 1 FROM pg_policy WHERE polrelid=r.oid)
  AND NOT EXISTS(SELECT 1 FROM pg_rewrite WHERE ev_class=r.oid)
  AND NOT EXISTS(SELECT 1 FROM pg_constraint WHERE confrelid=r.oid)
  AND NOT EXISTS(SELECT 1 FROM pg_depend WHERE classid='pg_class'::regclass AND objid=r.oid AND deptype IN ('e','x'))
  AND NOT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=r.oid AND attnum>0 AND attisdropped)
  AND (SELECT count(*) FROM pg_attribute WHERE attrelid=r.oid AND attnum>0)=7
  AND NOT EXISTS(SELECT 1 FROM columns_expected e LEFT JOIN pg_attribute a ON a.attrelid=r.oid AND a.attnum=e.pos
    LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
    WHERE a.attname IS DISTINCT FROM e.name OR format_type(a.atttypid,a.atttypmod) IS DISTINCT FROM e.typ
      OR NOT a.attnotnull OR a.attgenerated<>'' OR a.attidentity<>'' OR d.oid IS NOT NULL
      OR a.attcollation<>CASE WHEN e.typ='text' THEN 'pg_catalog.default'::regcollation ELSE 0 END)
  AND NOT EXISTS(SELECT 1 FROM pg_attribute a CROSS JOIN LATERAL aclexplode(a.attacl) x
    WHERE a.attrelid=r.oid AND x.grantee<>r.relowner)
  AND NOT EXISTS(SELECT 1 FROM aclexplode(COALESCE(r.relacl,acldefault('r',r.relowner))) a
    WHERE a.grantee<>r.relowner AND (a.grantee=0 OR a.is_grantable OR a.privilege_type NOT IN ('SELECT','INSERT')))
  AND (SELECT count(*) FROM pg_constraint WHERE conrelid=r.oid)=7
  AND NOT EXISTS(SELECT 1 FROM constraints_expected e LEFT JOIN pg_constraint c ON c.conrelid=r.oid AND c.conname=e.name
    WHERE c.oid IS NULL OR pg_get_constraintdef(c.oid,false)<>e.definition OR NOT c.convalidated
      OR c.condeferrable OR c.condeferred OR NOT c.conislocal OR c.coninhcount<>0 OR c.conparentid<>0
      OR c.connoinherit IS DISTINCT FROM (c.contype='p'))
  AND (SELECT count(*) FROM pg_index WHERE indrelid=r.oid)=2
  AND NOT EXISTS(SELECT 1 FROM pg_index i JOIN pg_class idx ON idx.oid=i.indexrelid WHERE i.indrelid=r.oid
    AND (idx.relowner<>r.relowner OR idx.relacl IS NOT NULL OR idx.relkind<>'i' OR idx.relpersistence<>'p'
      OR idx.relispartition OR idx.reltablespace<>0 OR idx.reloptions IS NOT NULL OR i.indisclustered
      OR NOT i.indisvalid OR NOT i.indisready OR NOT i.indislive OR NOT i.indimmediate
      OR i.indisexclusion OR i.indnullsnotdistinct OR i.indisreplident OR i.indpred IS NOT NULL OR i.indexprs IS NOT NULL
      OR idx.relam<>(SELECT oid FROM pg_am WHERE amname='btree')
      OR i.indoption::text<>CASE WHEN i.indisprimary THEN '0' ELSE '0 0' END
      OR i.indclass::text<>CASE WHEN i.indisprimary THEN (SELECT oid::text FROM pg_opclass WHERE opcnamespace='pg_catalog'::regnamespace AND opcname='int4_ops' AND opcmethod=idx.relam)
        ELSE (SELECT oid::text||' '||oid::text FROM pg_opclass WHERE opcnamespace='pg_catalog'::regnamespace AND opcname='int4_ops' AND opcmethod=idx.relam) END
      OR NOT ((idx.relname='store_order_purchase_physical_origin_pkey' AND i.indisprimary AND i.indisunique AND i.indnatts=1 AND i.indnkeyatts=1 AND i.indkey::text='1')
        OR (idx.relname='soppo_buyer_history' AND NOT i.indisprimary AND NOT i.indisunique AND i.indnatts=2 AND i.indnkeyatts=2 AND i.indkey::text='2 1')))) AS table_ready,
  NOT EXISTS(SELECT 1 FROM aclexplode(COALESCE(r.relacl,acldefault('r',r.relowner))) a WHERE a.grantee<>r.relowner) AS owner_only
  FROM relation r),
protection AS (SELECT (SELECT count(*) FROM functions_live)=2
  AND NOT EXISTS(SELECT 1 FROM functions_expected e LEFT JOIN functions_live p ON p.proname=e.name
    WHERE p.oid IS NULL OR p.prosrc<>e.body OR p.proowner<>(SELECT oid FROM owner)
      OR p.prokind<>'f' OR p.pronargs<>0 OR p.pronargdefaults<>0 OR p.prorettype<>'trigger'::regtype OR p.proretset
      OR p.prosecdef OR p.proleakproof OR p.proisstrict OR p.provolatile<>'v' OR p.proparallel<>'u'
      OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog']::text[] OR p.probin IS NOT NULL
      OR p.proargtypes<>''::oidvector OR p.proargdefaults IS NOT NULL OR p.protrftypes IS NOT NULL
      OR p.prosqlbody IS NOT NULL OR p.provariadic<>0 OR p.prosupport<>0 OR p.procost<>100 OR p.prorows<>0 OR p.proargnames IS NOT NULL OR p.proallargtypes IS NOT NULL OR p.proargmodes IS NOT NULL
      OR p.prolang<>(SELECT oid FROM pg_language WHERE lanname='plpgsql')
      OR EXISTS(SELECT 1 FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner)
      OR EXISTS(SELECT 1 FROM pg_depend WHERE classid='pg_proc'::regclass AND objid=p.oid AND deptype IN ('e','x')))
  AND NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgfoid IN(SELECT oid FROM functions_live)
    AND tgrelid IS DISTINCT FROM (SELECT oid FROM relation))
  AND (SELECT count(*) FROM pg_trigger WHERE tgrelid=(SELECT oid FROM relation))=3
  AND NOT EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid=(SELECT oid FROM relation)
    AND (t.tgenabled<>'O' OR t.tgisinternal OR t.tgconstraint<>0 OR t.tgparentid<>0 OR t.tgdeferrable OR t.tginitdeferred
      OR t.tgnargs<>0 OR t.tgattr::text<>'' OR t.tgargs<>''::bytea OR t.tgqual IS NOT NULL OR t.tgoldtable IS NOT NULL OR t.tgnewtable IS NOT NULL
      OR NOT ((t.tgname='soppo_capture' AND t.tgtype=7 AND t.tgfoid=to_regprocedure('public.capture_purchase_physical_origin_v1()'))
        OR (t.tgname='soppo_no_rewrite' AND t.tgtype=27 AND t.tgfoid=to_regprocedure('public.protect_purchase_physical_origin_v1()'))
        OR (t.tgname='soppo_no_truncate' AND t.tgtype=34 AND t.tgfoid=to_regprocedure('public.protect_purchase_physical_origin_v1()'))))) AS ready)
SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM relation) AND NOT EXISTS(SELECT 1 FROM functions_live)
    AND to_regclass('public.soppo_buyer_history') IS NULL AND to_regclass('public.store_order_purchase_physical_origin_pkey') IS NULL THEN 'fresh'
  WHEN (SELECT table_ready FROM shape) AND (SELECT ready FROM protection) THEN 'v1'
  WHEN (SELECT table_ready AND owner_only FROM shape) AND NOT EXISTS(SELECT 1 FROM functions_live)
    AND NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid=(SELECT oid FROM relation)) THEN 'orm-pending'
  ELSE 'drift' END AS state`;
