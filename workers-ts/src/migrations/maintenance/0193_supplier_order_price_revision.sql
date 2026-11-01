-- Expand only the known event whitelist. No business rows, roles or privileges change.
-- Existing databases must use this standalone upgrade, never the full bootstrap.
SET LOCAL search_path TO pg_catalog, public, pg_temp;
SELECT set_config('statement_timeout', LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='statement_timeout'),0),5000)::text || 'ms',true),
  set_config('lock_timeout', LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='lock_timeout'),0),1000)::text || 'ms',true),
  set_config('idle_in_transaction_session_timeout', LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000)::text || 'ms',true);
DO $supplier_order_price_revision_outbox$
DECLARE
  current_definition text;
  existing_comment text;
  row_count integer;
  virtual_catalog record;
  virtual_successor boolean := false;
BEGIN
  IF current_setting('server_version_num')::integer/10000<>16 OR current_setting('session_replication_role')<>'origin'
    OR current_user<>session_user OR current_schema()<>'pg_catalog' THEN
    RAISE EXCEPTION 'Supplier order price revision requires explicit direct PG16 maintenance';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.oid=to_regclass('public.store_order_outbox')
      AND c.relkind='r' AND c.relpersistence='p' AND NOT c.relrowsecurity AND NOT c.relforcerowsecurity
      AND NOT EXISTS (SELECT 1 FROM pg_inherits WHERE inhparent=c.oid OR inhrelid=c.oid))
    OR EXISTS (SELECT 1 FROM pg_event_trigger WHERE evtenabled<>'D') THEN
    RAISE EXCEPTION 'Supplier order price revision outbox prerequisite drift; no automatic repair';
  END IF;
  LOCK TABLE ONLY public.store_order_outbox IN ACCESS EXCLUSIVE MODE NOWAIT;
  SELECT pg_get_constraintdef(c.oid),obj_description(c.oid,'pg_constraint') INTO current_definition,existing_comment
    FROM pg_constraint c JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attname='event_type'
    WHERE c.conrelid='public.store_order_outbox'::regclass AND c.conname='soob_event_type_ck'
      AND c.contype='c' AND c.convalidated AND NOT c.connoinherit AND c.conislocal AND c.coninhcount=0
      AND c.conkey=ARRAY[a.attnum]::smallint[] AND a.atttypid='varchar'::regtype AND a.atttypmod=68
      AND a.attnotnull AND a.attgenerated='' AND a.attidentity='' AND NOT a.atthasdef
      AND a.attcollation='pg_catalog."default"'::regcollation AND NOT a.attisdropped;
  IF current_definition IN ('CHECK (((event_type)::text = ANY ((ARRAY[''order.paid''::character varying, ''order.delivery.notice''::character varying, ''order.refund.refused.notice''::character varying, ''order.second_card.advent.notice''::character varying, ''order.second_card.expired.notice''::character varying, ''withdrawal.approved.notice''::character varying, ''withdrawal.refused.notice''::character varying, ''withdrawal.applied.notice''::character varying, ''withdrawal.staff.refresh''::character varying, ''order.presale.fulfillment''::character varying, ''order.pink.success.notice''::character varying, ''product.stock.effects''::character varying, ''product.recycle.effects''::character varying, ''product.save.effects''::character varying, ''recharge.paid.shipping''::character varying, ''membership.paid.shipping''::character varying])::text[])))',
      'CHECK (((event_type)::text = ANY ((ARRAY[''order.paid''::character varying, ''order.delivery.notice''::character varying, ''order.refund.refused.notice''::character varying, ''order.second_card.advent.notice''::character varying, ''order.second_card.expired.notice''::character varying, ''withdrawal.approved.notice''::character varying, ''withdrawal.refused.notice''::character varying, ''withdrawal.applied.notice''::character varying, ''withdrawal.staff.refresh''::character varying, ''order.presale.fulfillment''::character varying, ''order.pink.success.notice''::character varying, ''product.stock.effects''::character varying, ''product.recycle.effects''::character varying, ''product.save.effects''::character varying, ''order.price.revision''::character varying, ''recharge.paid.shipping''::character varying, ''membership.paid.shipping''::character varying])::text[])))') THEN
    SELECT * INTO virtual_catalog FROM (WITH
 targets AS (SELECT c.* FROM pg_catalog.pg_class c WHERE c.oid IN
   (pg_catalog.to_regclass('public.order_notification_delivery'),pg_catalog.to_regclass('public.store_order_outbox'))),
 attrs AS (SELECT c.relname,a.*,d.oid AS default_oid FROM targets c JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid
   LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attnum>0 AND NOT a.attisdropped),
 checks AS (SELECT c.relname,k.*,pg_catalog.pg_get_constraintdef(k.oid,false) AS definition
   FROM targets c JOIN pg_catalog.pg_constraint k ON k.conrelid=c.oid),
 named_index AS (SELECT c.*,i.indrelid,i.indisvalid,i.indisready,i.indislive,i.indisunique,i.indisexclusion,i.indexprs,i.indnkeyatts,i.indnatts,
   i.indclass,i.indcollation,i.indoption,
   pg_catalog.pg_get_indexdef(c.oid) AS definition FROM pg_catalog.pg_class c LEFT JOIN pg_catalog.pg_index i ON i.indexrelid=c.oid
   WHERE c.relnamespace='public'::regnamespace AND c.relname LIKE 'ond_virtual%')
 SELECT
 (SELECT pg_catalog.count(*)=2 AND pg_catalog.bool_and(c.relkind='r' AND c.relpersistence='p' AND NOT c.relispartition
   AND NOT c.relrowsecurity AND NOT c.relforcerowsecurity AND c.reloptions IS NULL
   AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_inherits WHERE inhparent=c.oid OR inhrelid=c.oid)) FROM targets c)
   AND (SELECT pg_catalog.count(DISTINCT relowner)=1 FROM targets)
   AND EXISTS(SELECT 1 FROM targets c JOIN pg_catalog.pg_roles r ON r.oid=c.relowner WHERE r.rolsuper AND r.rolcanlogin)
   AND pg_catalog.current_setting('server_version_num')::integer/10000=16
   AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_event_trigger WHERE evtenabled<>'D')
   AND (SELECT pg_catalog.count(*)=2 FROM attrs a WHERE attname='id' AND atttypid='pg_catalog.int4'::regtype AND attnotnull
     AND attgenerated='' AND attidentity='' AND EXISTS(SELECT 1 FROM checks k WHERE k.conrelid=a.attrelid AND k.contype='p'
       AND k.convalidated AND k.conkey=ARRAY[a.attnum]::smallint[])) AS safe,
 (SELECT pg_catalog.pg_get_userbyid(relowner) FROM targets WHERE relname='order_notification_delivery') AS maintenance,
 (SELECT relowner::text FROM targets WHERE relname='order_notification_delivery') AS maintenance_oid,
 (SELECT pg_catalog.count(*)=7 FROM attrs WHERE attgenerated='' AND attidentity='' AND default_oid IS NULL
   AND (atttypid<>'pg_catalog.varchar'::regtype OR attcollation='pg_catalog."default"'::regcollation) AND (
   (relname='order_notification_delivery' AND attname IN('order_id','withdrawal_id') AND atttypid='pg_catalog.int4'::regtype AND NOT attnotnull) OR
   (relname='order_notification_delivery' AND attname='event_key' AND atttypid='pg_catalog.varchar'::regtype AND atttypmod=132 AND attnotnull) OR
   (relname='order_notification_delivery' AND attname='channel' AND atttypid='pg_catalog.varchar'::regtype AND atttypmod=36 AND attnotnull) OR
   (relname='order_notification_delivery' AND attname='notice_mark' AND atttypid='pg_catalog.varchar'::regtype AND atttypmod=54 AND attnotnull) OR
   (relname='store_order_outbox' AND attname='event_type' AND atttypid='pg_catalog.varchar'::regtype AND atttypmod=68 AND attnotnull) OR
   (relname='store_order_outbox' AND attname='event_key' AND atttypid='pg_catalog.varchar'::regtype AND atttypmod=132 AND attnotnull))) AS core,
 (SELECT pg_catalog.count(*) FROM attrs WHERE relname='order_notification_delivery' AND attname LIKE 'subject_%')::integer AS subject_columns,
 (SELECT pg_catalog.count(*)=2 FROM attrs WHERE relname='order_notification_delivery' AND NOT attnotnull
   AND attgenerated='' AND attidentity='' AND default_oid IS NULL AND attacl IS NULL AND (
    (attname='subject_domain' AND atttypid='pg_catalog.varchar'::regtype AND atttypmod=20 AND attcollation='pg_catalog."default"'::regcollation) OR
    (attname='subject_id' AND atttypid='pg_catalog.int4'::regtype))) AS columns_ready,
 (SELECT definition FROM checks WHERE relname='order_notification_delivery' AND conname='ond_subject_ck') AS subject_definition,
 (SELECT contype='c' AND convalidated AND NOT condeferrable AND NOT condeferred AND NOT connoinherit AND conislocal AND coninhcount=0
   FROM checks WHERE relname='order_notification_delivery' AND conname='ond_subject_ck') AS subject_safe,
 (SELECT definition FROM checks WHERE relname='store_order_outbox' AND conname='soob_event_type_ck') AS event_definition,
 (SELECT contype='c' AND convalidated AND NOT condeferrable AND NOT condeferred AND NOT connoinherit AND conislocal AND coninhcount=0
   AND conkey=ARRAY[(SELECT attnum FROM attrs WHERE relname='store_order_outbox' AND attname='event_type')]::smallint[]
   FROM checks WHERE relname='store_order_outbox' AND conname='soob_event_type_ck') AS event_safe,
 (SELECT pg_catalog.count(*) FROM named_index)::integer AS indexes,
 (SELECT pg_catalog.count(*)=1 AND pg_catalog.bool_and(relname='ond_virtual_subject' AND relkind='i' AND relpersistence='p'
   AND relowner=(SELECT relowner FROM targets WHERE relname='order_notification_delivery') AND relacl IS NULL AND reloptions IS NULL
   AND indrelid=pg_catalog.to_regclass('public.order_notification_delivery') AND indisvalid AND indisready AND indislive
   AND NOT indisunique AND NOT indisexclusion AND indexprs IS NULL AND indnkeyatts=3 AND indnatts=3
   AND relam=(SELECT oid FROM pg_catalog.pg_am WHERE amname='btree')
   AND indclass[0]=(SELECT oid FROM pg_catalog.pg_opclass WHERE opcnamespace='pg_catalog'::regnamespace AND opcname='text_ops'
     AND opcmethod=relam AND opcintype='pg_catalog.text'::regtype AND opcdefault AND opckeytype=0)
   AND indclass[1]=(SELECT oid FROM pg_catalog.pg_opclass WHERE opcnamespace='pg_catalog'::regnamespace AND opcname='int4_ops'
     AND opcmethod=relam AND opcintype='pg_catalog.int4'::regtype AND opcdefault AND opckeytype=0)
   AND indclass[2]=indclass[1]
   AND indcollation[0]='pg_catalog."default"'::regcollation AND indcollation[1]=0 AND indcollation[2]=0
   AND indoption::text='0 0 0'
   AND definition='CREATE INDEX ond_virtual_subject ON public.order_notification_delivery USING btree (subject_domain, subject_id, id) WHERE (subject_domain IS NOT NULL)') FROM named_index) AS index_ready) virtual_structure;
    IF NOT COALESCE(virtual_catalog.safe AND virtual_catalog.core AND virtual_catalog.subject_safe AND virtual_catalog.event_safe
      AND virtual_catalog.subject_columns=2 AND virtual_catalog.columns_ready AND virtual_catalog.indexes=1 AND virtual_catalog.index_ready
      AND virtual_catalog.subject_definition='CHECK ((((subject_domain IS NULL) AND (subject_id IS NULL) AND (((withdrawal_id IS NULL) AND (order_id IS NOT NULL)) OR ((withdrawal_id IS NOT NULL) AND (withdrawal_id > 0) AND (order_id IS NULL)))) OR ((subject_domain IS NOT NULL) AND (subject_id IS NOT NULL) AND ((subject_domain)::text = ANY ((ARRAY[''recharge''::character varying, ''membership''::character varying])::text[])) AND (subject_id > 0) AND (order_id IS NULL) AND (withdrawal_id IS NULL) AND ((channel)::text = ''wechat_shipping''::text) AND ((notice_mark)::text = ''paid_virtual_shipping''::text) AND ((event_key)::text = (((subject_domain)::text || ''.paid.shipping:''::text) || (subject_id)::text)))))',false) THEN
      RAISE EXCEPTION 'Supplier order price revision virtual subject prerequisite drift; no automatic repair';
    END IF;
    IF current_definition='CHECK (((event_type)::text = ANY ((ARRAY[''order.paid''::character varying, ''order.delivery.notice''::character varying, ''order.refund.refused.notice''::character varying, ''order.second_card.advent.notice''::character varying, ''order.second_card.expired.notice''::character varying, ''withdrawal.approved.notice''::character varying, ''withdrawal.refused.notice''::character varying, ''withdrawal.applied.notice''::character varying, ''withdrawal.staff.refresh''::character varying, ''order.presale.fulfillment''::character varying, ''order.pink.success.notice''::character varying, ''product.stock.effects''::character varying, ''product.recycle.effects''::character varying, ''product.save.effects''::character varying, ''order.price.revision''::character varying, ''recharge.paid.shipping''::character varying, ''membership.paid.shipping''::character varying])::text[])))' THEN RETURN; END IF;
    virtual_successor := true;
  END IF;
  IF current_definition = 'CHECK (((event_type)::text = ANY ((ARRAY[''order.paid''::character varying, ''order.delivery.notice''::character varying, ''order.refund.refused.notice''::character varying, ''order.second_card.advent.notice''::character varying, ''order.second_card.expired.notice''::character varying, ''withdrawal.approved.notice''::character varying, ''withdrawal.refused.notice''::character varying, ''withdrawal.applied.notice''::character varying, ''withdrawal.staff.refresh''::character varying, ''order.presale.fulfillment''::character varying, ''order.pink.success.notice''::character varying, ''product.stock.effects''::character varying, ''product.recycle.effects''::character varying, ''product.save.effects''::character varying, ''order.price.revision''::character varying])::text[])))' THEN
    RETURN;
  END IF;
  IF NOT virtual_successor AND current_definition IS DISTINCT FROM 'CHECK (((event_type)::text = ANY ((ARRAY[''order.paid''::character varying, ''order.delivery.notice''::character varying, ''order.refund.refused.notice''::character varying, ''order.second_card.advent.notice''::character varying, ''order.second_card.expired.notice''::character varying, ''withdrawal.approved.notice''::character varying, ''withdrawal.refused.notice''::character varying, ''withdrawal.applied.notice''::character varying, ''withdrawal.staff.refresh''::character varying, ''order.presale.fulfillment''::character varying, ''order.pink.success.notice''::character varying, ''product.stock.effects''::character varying, ''product.recycle.effects''::character varying, ''product.save.effects''::character varying])::text[])))' THEN
    RAISE EXCEPTION 'Supplier order price revision outbox event CHECK drift; no automatic repair';
  END IF;
  SELECT count(*) INTO row_count FROM (SELECT 1 FROM public.store_order_outbox LIMIT 10001) bounded;
  IF row_count>10000 THEN RAISE EXCEPTION 'Supplier order price revision outbox maintenance row budget exceeded'; END IF;
  ALTER TABLE public.store_order_outbox DROP CONSTRAINT soob_event_type_ck;
  IF virtual_successor THEN
    ALTER TABLE public.store_order_outbox ADD CONSTRAINT soob_event_type_ck CHECK (
      event_type IN ('order.paid', 'order.delivery.notice', 'order.refund.refused.notice', 'order.second_card.advent.notice', 'order.second_card.expired.notice', 'withdrawal.approved.notice', 'withdrawal.refused.notice', 'withdrawal.applied.notice', 'withdrawal.staff.refresh', 'order.presale.fulfillment', 'order.pink.success.notice', 'product.stock.effects', 'product.recycle.effects', 'product.save.effects', 'order.price.revision', 'recharge.paid.shipping', 'membership.paid.shipping')
    );
  ELSE
  ALTER TABLE public.store_order_outbox ADD CONSTRAINT soob_event_type_ck CHECK (
    event_type IN ('order.paid', 'order.delivery.notice', 'order.refund.refused.notice', 'order.second_card.advent.notice', 'order.second_card.expired.notice', 'withdrawal.approved.notice', 'withdrawal.refused.notice', 'withdrawal.applied.notice', 'withdrawal.staff.refresh', 'order.presale.fulfillment', 'order.pink.success.notice', 'product.stock.effects', 'product.recycle.effects', 'product.save.effects', 'order.price.revision')
  );
  END IF;
  IF existing_comment IS NOT NULL THEN
    EXECUTE format('COMMENT ON CONSTRAINT soob_event_type_ck ON public.store_order_outbox IS %L',existing_comment);
  END IF;
END
$supplier_order_price_revision_outbox$;
