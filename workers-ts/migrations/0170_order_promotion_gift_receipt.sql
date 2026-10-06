DO $gift_preflight$
BEGIN
 IF current_setting('transaction_isolation')<>'read committed' OR current_setting('transaction_read_only')<>'off' THEN
 RAISE EXCEPTION 'Promotion gift receipt requires a READ COMMITTED write transaction'; END IF;
 PERFORM set_config('search_path','public,pg_temp',true);
 PERFORM set_config('statement_timeout',LEAST(COALESCE(NULLIF((SELECT setting::int FROM pg_settings WHERE name='statement_timeout'),0),5000),5000)::text,true);
 PERFORM set_config('lock_timeout',LEAST(COALESCE(NULLIF((SELECT setting::int FROM pg_settings WHERE name='lock_timeout'),0),1000),1000)::text,true);
 PERFORM set_config('idle_in_transaction_session_timeout',LEAST(COALESCE(NULLIF((SELECT setting::int FROM pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000),5000)::text,true);
 IF NOT pg_try_advisory_xact_lock(731627,4) THEN RAISE EXCEPTION 'Promotion gift receipt maintenance is busy'; END IF;
 IF EXISTS(SELECT 1 FROM pg_event_trigger WHERE evtenabled<>'D') THEN RAISE EXCEPTION 'Promotion gift receipt event-trigger review required'; END IF;
 IF to_regclass('public.user_bill') IS NULL THEN RAISE EXCEPTION 'Promotion gift points bill prerequisite missing'; END IF;
END $gift_preflight$;
LOCK TABLE ONLY public.user_bill IN SHARE ROW EXCLUSIVE MODE;
DO $gift_create$
BEGIN
 IF to_regclass('public.store_order_promotion_gift_coupon_reward') IS NULL THEN
 
CREATE TABLE public.store_order_promotion_gift_coupon_reward (
      id SERIAL PRIMARY KEY, order_id INTEGER NOT NULL, uid INTEGER NOT NULL,
      root_id INTEGER NOT NULL, tier_id INTEGER NOT NULL, auxiliary_id INTEGER NOT NULL,
      issue_coupon_id INTEGER NOT NULL, coupon_user_id INTEGER NOT NULL,
      add_time INTEGER DEFAULT 0 NOT NULL,
      CONSTRAINT sopgcr_positive_ids_ck CHECK (order_id>0 AND uid>0 AND root_id>0
        AND tier_id>0 AND auxiliary_id>0 AND issue_coupon_id>0 AND coupon_user_id>0 AND add_time>=0)
    );
    CREATE UNIQUE INDEX sopgcr_order_aux_uq ON public.store_order_promotion_gift_coupon_reward(order_id,auxiliary_id);
    CREATE UNIQUE INDEX sopgcr_coupon_user_uq ON public.store_order_promotion_gift_coupon_reward(coupon_user_id);
    CREATE INDEX sopgcr_uid_order ON public.store_order_promotion_gift_coupon_reward(uid,order_id,id);
REVOKE ALL ON public.store_order_promotion_gift_coupon_reward FROM PUBLIC;
REVOKE ALL ON SEQUENCE public.store_order_promotion_gift_coupon_reward_id_seq FROM PUBLIC;

 END IF;
 IF to_regclass('public.ub_order_promotion_gift_uq') IS NULL THEN
 IF EXISTS(SELECT 1 FROM public.user_bill WHERE event_key='order_promotions_give_integral'
 GROUP BY uid,link_id HAVING count(*)>1 LIMIT 1) THEN RAISE EXCEPTION 'Promotion gift points duplicate legacy evidence'; END IF;
 CREATE UNIQUE INDEX ub_order_promotion_gift_uq ON public.user_bill(uid,link_id,event_key) WHERE event_key='order_promotions_give_integral';
 END IF;
END $gift_create$;
LOCK TABLE ONLY public.store_order_promotion_gift_coupon_reward IN SHARE ROW EXCLUSIVE MODE;
DO $gift_validate$
DECLARE checked record;
BEGIN
 WITH expected_columns(table_name,column_name,type_name,default_expr) AS (VALUES
('store_order_promotion_gift_coupon_reward','id','integer','nextval(''store_order_promotion_gift_coupon_reward_id_seq''::regclass)'),
('store_order_promotion_gift_coupon_reward','order_id','integer',NULL),
('store_order_promotion_gift_coupon_reward','uid','integer',NULL),
('store_order_promotion_gift_coupon_reward','root_id','integer',NULL),
('store_order_promotion_gift_coupon_reward','tier_id','integer',NULL),
('store_order_promotion_gift_coupon_reward','auxiliary_id','integer',NULL),
('store_order_promotion_gift_coupon_reward','issue_coupon_id','integer',NULL),
('store_order_promotion_gift_coupon_reward','coupon_user_id','integer',NULL),
('store_order_promotion_gift_coupon_reward','add_time','integer','0')
), expected_constraints(table_name,name,definition) AS (VALUES
('store_order_promotion_gift_coupon_reward','store_order_promotion_gift_coupon_reward_pkey','PRIMARY KEY (id)'),
('store_order_promotion_gift_coupon_reward','sopgcr_positive_ids_ck','CHECK (((order_id > 0) AND (uid > 0) AND (root_id > 0) AND (tier_id > 0) AND (auxiliary_id > 0) AND (issue_coupon_id > 0) AND (coupon_user_id > 0) AND (add_time >= 0)))')
), expected_indexes(table_name,name,definition) AS (VALUES
('store_order_promotion_gift_coupon_reward','store_order_promotion_gift_coupon_reward_pkey','CREATE UNIQUE INDEX store_order_promotion_gift_coupon_reward_pkey ON public.store_order_promotion_gift_coupon_reward USING btree (id)'),
('store_order_promotion_gift_coupon_reward','sopgcr_order_aux_uq','CREATE UNIQUE INDEX sopgcr_order_aux_uq ON public.store_order_promotion_gift_coupon_reward USING btree (order_id, auxiliary_id)'),
('store_order_promotion_gift_coupon_reward','sopgcr_coupon_user_uq','CREATE UNIQUE INDEX sopgcr_coupon_user_uq ON public.store_order_promotion_gift_coupon_reward USING btree (coupon_user_id)'),
('store_order_promotion_gift_coupon_reward','sopgcr_uid_order','CREATE INDEX sopgcr_uid_order ON public.store_order_promotion_gift_coupon_reward USING btree (uid, order_id, id)')
), target_tables AS (
  SELECT c.* FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND c.relname IN ('store_order_promotion_gift_coupon_reward')
), actual_columns AS (
  SELECT c.relname AS table_name,a.attname AS column_name,pg_catalog.format_type(a.atttypid,a.atttypmod) AS type_name,
    pg_catalog.pg_get_expr(d.adbin,d.adrelid) AS default_expr,
    a.attnotnull AND NOT a.attisdropped AND a.attidentity='' AND a.attgenerated='' AND a.attislocal AND a.attinhcount=0
      AND (a.attcollation=0 OR a.attcollation='pg_catalog."default"'::regcollation) AS safe
  FROM target_tables c JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid AND a.attnum>0
  LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
), actual_constraints AS (
  SELECT t.relname AS table_name,c.conname AS name,pg_catalog.pg_get_constraintdef(c.oid) AS definition,
    c.convalidated AND NOT c.condeferrable AND NOT c.condeferred AND (c.contype<>'c' OR NOT c.connoinherit) AND c.conislocal AND c.coninhcount=0 AS safe
  FROM target_tables t JOIN pg_catalog.pg_constraint c ON c.conrelid=t.oid WHERE c.contype<>'n'
), actual_indexes AS (
  SELECT t.relname AS table_name,c.relname AS name,pg_catalog.pg_get_indexdef(i.indexrelid) AS definition,
    i.indisvalid AND i.indisready AND i.indislive AND NOT i.indisexclusion AS safe
  FROM target_tables t JOIN pg_catalog.pg_index i ON i.indrelid=t.oid JOIN pg_catalog.pg_class c ON c.oid=i.indexrelid
)
SELECT (SELECT count(*)=1 AND bool_and(relkind='r' AND relpersistence='p' AND NOT relrowsecurity AND NOT relforcerowsecurity AND NOT relispartition) FROM target_tables)
  AND NOT EXISTS(SELECT 1 FROM target_tables t JOIN pg_catalog.pg_inherits i ON i.inhrelid=t.oid OR i.inhparent=t.oid)
  AND NOT EXISTS(SELECT 1 FROM target_tables t JOIN pg_catalog.pg_trigger g ON g.tgrelid=t.oid WHERE NOT g.tgisinternal)
  AND NOT EXISTS(SELECT 1 FROM target_tables t JOIN pg_catalog.pg_rewrite r ON r.ev_class=t.oid)
  AND NOT EXISTS(SELECT 1 FROM target_tables t CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(t.relacl,pg_catalog.acldefault('r',t.relowner))) a
    WHERE a.grantee<>t.relowner AND (a.grantee=0 OR a.is_grantable OR a.privilege_type NOT IN ('SELECT','INSERT')))
  AND NOT EXISTS(SELECT 1 FROM target_tables t JOIN pg_catalog.pg_attribute c ON c.attrelid=t.oid
    CROSS JOIN LATERAL pg_catalog.aclexplode(c.attacl) a WHERE a.grantee<>t.relowner)
  AND NOT EXISTS(SELECT 1 FROM expected_columns e FULL JOIN actual_columns a USING(table_name,column_name)
    WHERE e.table_name IS NULL OR a.table_name IS NULL OR NOT a.safe OR e.type_name IS DISTINCT FROM a.type_name OR e.default_expr IS DISTINCT FROM a.default_expr)
  AND NOT EXISTS(SELECT 1 FROM expected_constraints e FULL JOIN actual_constraints a USING(table_name,name)
    WHERE e.table_name IS NULL OR a.table_name IS NULL OR NOT a.safe OR e.definition IS DISTINCT FROM a.definition)
  AND NOT EXISTS(SELECT 1 FROM expected_indexes e FULL JOIN actual_indexes a USING(table_name,name)
    WHERE e.table_name IS NULL OR a.table_name IS NULL OR NOT a.safe OR e.definition IS DISTINCT FROM a.definition) AS catalog_ready,
  EXISTS(SELECT 1 FROM pg_catalog.pg_class s JOIN pg_catalog.pg_namespace n ON n.oid=s.relnamespace
    JOIN pg_catalog.pg_sequence q ON q.seqrelid=s.oid
    JOIN pg_catalog.pg_depend d ON d.classid='pg_catalog.pg_class'::regclass AND d.objid=s.oid AND d.deptype='a'
    JOIN pg_catalog.pg_attribute a ON a.attrelid=d.refobjid AND a.attnum=d.refobjsubid
    WHERE n.nspname='public' AND s.relname='store_order_promotion_gift_coupon_reward_id_seq' AND s.relkind='S' AND s.relpersistence='p'
      AND d.refclassid='pg_catalog.pg_class'::regclass AND d.refobjid=to_regclass('public.store_order_promotion_gift_coupon_reward') AND a.attname='id'
      AND q.seqtypid='integer'::regtype AND q.seqstart=1 AND q.seqincrement=1 AND q.seqmin=1 AND q.seqmax=2147483647
      AND q.seqcache=1 AND NOT q.seqcycle
      AND NOT EXISTS(SELECT 1 FROM pg_catalog.aclexplode(COALESCE(s.relacl,pg_catalog.acldefault('S',s.relowner))) x
        WHERE x.grantee<>s.relowner AND (x.grantee=0 OR x.is_grantable OR x.privilege_type<>'USAGE'))
      AND CASE WHEN to_regclass('public.store_order_promotion_gift_coupon_reward') IS NOT NULL THEN pg_catalog.pg_get_serial_sequence('public.store_order_promotion_gift_coupon_reward','id') END='public.store_order_promotion_gift_coupon_reward_id_seq') AS sequence_ready,
 EXISTS(SELECT 1 FROM pg_catalog.pg_index i WHERE i.indexrelid=to_regclass('public.ub_order_promotion_gift_uq')
 AND i.indrelid=to_regclass('public.user_bill') AND i.indisunique AND i.indisvalid AND i.indisready AND i.indislive AND NOT i.indisexclusion
 AND pg_catalog.pg_get_indexdef(i.indexrelid)='CREATE UNIQUE INDEX ub_order_promotion_gift_uq ON public.user_bill USING btree (uid, link_id, event_key) WHERE ((event_key)::text = ''order_promotions_give_integral''::text)') AS points_ready INTO checked;
 IF checked.catalog_ready IS DISTINCT FROM true OR checked.sequence_ready IS DISTINCT FROM true OR checked.points_ready IS DISTINCT FROM true
 OR EXISTS(SELECT 1 FROM pg_catalog.pg_class WHERE relnamespace='public'::regnamespace
 AND relname IN ('store_order_promotion_gift_coupon_reward','store_order_promotion_gift_coupon_reward_id_seq','user_bill','ub_order_promotion_gift_uq')
 AND relowner<>(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=current_user)) THEN
 RAISE EXCEPTION 'Promotion gift receipt exact catalog drift; no automatic repair'; END IF;
END $gift_validate$;
