-- DB-009E4: eight validation flags and one event-list ordering, with unchanged write rules.
-- CHECK cannot be changed back to NOT VALID using supported ALTER syntax.
-- Reviewed same-name replacement changes the target CHECK OID; it must not touch rows.
-- Outbox stays VALIDATED, so its ADD scans existing rows under ACCESS EXCLUSIVE.
-- Execute only in a separately approved maintenance transaction, not at application startup.
DO $check_state_alignment$
DECLARE
  target_schema text := pg_catalog.current_schema();
  original_search_path text := pg_catalog.current_setting('search_path');
  original_lock_timeout text := pg_catalog.current_setting('lock_timeout');
  expected constant jsonb := $check_state_data$
{
  "columns": [
    {
      "name": "status",
      "table": "division_apply",
      "type": "smallint",
      "notNull": true,
      "default": "0",
      "identity": "",
      "generated": "",
      "collation": null
    },
    {
      "name": "division_agent_brokerage",
      "table": "store_order",
      "type": "numeric(12,2)",
      "notNull": true,
      "default": "0.00",
      "identity": "",
      "generated": "",
      "collation": null
    },
    {
      "name": "division_brokerage",
      "table": "store_order",
      "type": "numeric(12,2)",
      "notNull": true,
      "default": "0.00",
      "identity": "",
      "generated": "",
      "collation": null
    },
    {
      "name": "division_staff_brokerage",
      "table": "store_order",
      "type": "numeric(12,2)",
      "notNull": true,
      "default": "0.00",
      "identity": "",
      "generated": "",
      "collation": null
    },
    {
      "name": "supplier_allocation_status",
      "table": "store_order",
      "type": "smallint",
      "notNull": true,
      "default": "0",
      "identity": "",
      "generated": "",
      "collation": null
    },
    {
      "name": "split_status",
      "table": "store_order_cart_info",
      "type": "smallint",
      "notNull": true,
      "default": "0",
      "identity": "",
      "generated": "",
      "collation": null
    },
    {
      "name": "split_surplus_num",
      "table": "store_order_cart_info",
      "type": "integer",
      "notNull": true,
      "default": "0",
      "identity": "",
      "generated": "",
      "collation": null
    },
    {
      "name": "event_type",
      "table": "store_order_outbox",
      "type": "character varying(64)",
      "notNull": true,
      "default": null,
      "identity": "",
      "generated": "",
      "collation": "pg_catalog.default"
    },
    {
      "name": "delivery_score",
      "table": "store_product_reply",
      "type": "smallint",
      "notNull": true,
      "default": "5",
      "identity": "",
      "generated": "",
      "collation": null
    },
    {
      "name": "logistics_score",
      "table": "store_product_reply",
      "type": "smallint",
      "notNull": true,
      "default": "5",
      "identity": "",
      "generated": "",
      "collation": null
    },
    {
      "name": "product_score",
      "table": "store_product_reply",
      "type": "smallint",
      "notNull": true,
      "default": "5",
      "identity": "",
      "generated": "",
      "collation": null
    },
    {
      "name": "reply_score",
      "table": "store_product_reply",
      "type": "smallint",
      "notNull": true,
      "default": "3",
      "identity": "",
      "generated": "",
      "collation": null
    },
    {
      "name": "service_score",
      "table": "store_product_reply",
      "type": "smallint",
      "notNull": true,
      "default": "5",
      "identity": "",
      "generated": "",
      "collation": null
    },
    {
      "name": "division_percent",
      "table": "user",
      "type": "integer",
      "notNull": true,
      "default": "0",
      "identity": "",
      "generated": "",
      "collation": null
    },
    {
      "name": "division_status",
      "table": "user",
      "type": "integer",
      "notNull": true,
      "default": "0",
      "identity": "",
      "generated": "",
      "collation": null
    },
    {
      "name": "division_type",
      "table": "user",
      "type": "integer",
      "notNull": true,
      "default": "0",
      "identity": "",
      "generated": "",
      "collation": null
    }
  ],
  "constraints": [
    {
      "table": "division_apply",
      "name": "da_status_ck",
      "columns": [
        "status"
      ],
      "previousDefinition": "CHECK (((status >= 0) AND (status <= 2)))",
      "definition": "CHECK (((status >= 0) AND (status <= 2))) NOT VALID",
      "validated": false,
      "clause": "CONSTRAINT \"da_status_ck\"\n      CHECK (\"status\" BETWEEN 0 AND 2) NOT VALID"
    },
    {
      "table": "store_order",
      "name": "so_division_brokerage_ck",
      "columns": [
        "division_brokerage",
        "division_agent_brokerage",
        "division_staff_brokerage"
      ],
      "previousDefinition": "CHECK (((division_brokerage >= (0)::numeric) AND (division_agent_brokerage >= (0)::numeric) AND (division_staff_brokerage >= (0)::numeric)))",
      "definition": "CHECK (((division_brokerage >= (0)::numeric) AND (division_agent_brokerage >= (0)::numeric) AND (division_staff_brokerage >= (0)::numeric))) NOT VALID",
      "validated": false,
      "clause": "CONSTRAINT \"so_division_brokerage_ck\"\n      CHECK (\"division_brokerage\" >= 0 AND \"division_agent_brokerage\" >= 0 AND \"division_staff_brokerage\" >= 0) NOT VALID"
    },
    {
      "table": "store_order",
      "name": "so_supplier_allocation_status_ck",
      "columns": [
        "supplier_allocation_status"
      ],
      "previousDefinition": "CHECK (((supplier_allocation_status >= 0) AND (supplier_allocation_status <= 2)))",
      "definition": "CHECK (((supplier_allocation_status >= 0) AND (supplier_allocation_status <= 2))) NOT VALID",
      "validated": false,
      "clause": "CONSTRAINT \"so_supplier_allocation_status_ck\"\n      CHECK (\"supplier_allocation_status\" BETWEEN 0 AND 2) NOT VALID"
    },
    {
      "table": "store_order_cart_info",
      "name": "soci_split_state_ck",
      "columns": [
        "split_surplus_num",
        "split_status"
      ],
      "previousDefinition": "CHECK ((((split_status >= 0) AND (split_status <= 2)) AND (split_surplus_num >= 0)))",
      "definition": "CHECK ((((split_status >= 0) AND (split_status <= 2)) AND (split_surplus_num >= 0))) NOT VALID",
      "validated": false,
      "clause": "CONSTRAINT \"soci_split_state_ck\"\n      CHECK (\"split_status\" BETWEEN 0 AND 2 AND \"split_surplus_num\" >= 0) NOT VALID"
    },
    {
      "table": "store_order_outbox",
      "name": "soob_event_type_ck",
      "columns": [
        "event_type"
      ],
      "previousDefinition": "CHECK (((event_type)::text = ANY ((ARRAY['order.paid'::character varying, 'order.delivery.notice'::character varying, 'order.refund.refused.notice'::character varying, 'order.second_card.advent.notice'::character varying, 'order.second_card.expired.notice'::character varying, 'withdrawal.approved.notice'::character varying, 'withdrawal.applied.notice'::character varying, 'withdrawal.staff.refresh'::character varying, 'withdrawal.refused.notice'::character varying])::text[])))",
      "definition": "CHECK (((event_type)::text = ANY ((ARRAY['order.paid'::character varying, 'order.delivery.notice'::character varying, 'order.refund.refused.notice'::character varying, 'order.second_card.advent.notice'::character varying, 'order.second_card.expired.notice'::character varying, 'withdrawal.approved.notice'::character varying, 'withdrawal.refused.notice'::character varying, 'withdrawal.applied.notice'::character varying, 'withdrawal.staff.refresh'::character varying])::text[])))",
      "validated": true,
      "clause": "CONSTRAINT \"soob_event_type_ck\" CHECK (\n  \"event_type\" IN ('order.paid', 'order.delivery.notice', 'order.refund.refused.notice',\n    'order.second_card.advent.notice', 'order.second_card.expired.notice',\n    'withdrawal.approved.notice', 'withdrawal.refused.notice', 'withdrawal.applied.notice',\n    'withdrawal.staff.refresh')\n)"
    },
    {
      "table": "store_product_reply",
      "name": "spr_scores_ck",
      "columns": [
        "reply_score",
        "product_score",
        "service_score",
        "logistics_score",
        "delivery_score"
      ],
      "previousDefinition": "CHECK ((((product_score >= 1) AND (product_score <= 5)) AND ((service_score >= 1) AND (service_score <= 5)) AND ((logistics_score >= 1) AND (logistics_score <= 5)) AND ((delivery_score >= 1) AND (delivery_score <= 5)) AND ((reply_score >= 1) AND (reply_score <= 3))))",
      "definition": "CHECK ((((product_score >= 1) AND (product_score <= 5)) AND ((service_score >= 1) AND (service_score <= 5)) AND ((logistics_score >= 1) AND (logistics_score <= 5)) AND ((delivery_score >= 1) AND (delivery_score <= 5)) AND ((reply_score >= 1) AND (reply_score <= 3)))) NOT VALID",
      "validated": false,
      "clause": "CONSTRAINT \"spr_scores_ck\"\n      CHECK (\n        \"product_score\" BETWEEN 1 AND 5\n        AND \"service_score\" BETWEEN 1 AND 5\n        AND \"logistics_score\" BETWEEN 1 AND 5\n        AND \"delivery_score\" BETWEEN 1 AND 5\n        AND \"reply_score\" BETWEEN 1 AND 3\n      ) NOT VALID"
    },
    {
      "table": "user",
      "name": "user_division_percent_ck",
      "columns": [
        "division_percent"
      ],
      "previousDefinition": "CHECK (((division_percent >= 0) AND (division_percent <= 100)))",
      "definition": "CHECK (((division_percent >= 0) AND (division_percent <= 100))) NOT VALID",
      "validated": false,
      "clause": "CONSTRAINT \"user_division_percent_ck\" CHECK (\"division_percent\" BETWEEN 0 AND 100) NOT VALID"
    },
    {
      "table": "user",
      "name": "user_division_status_ck",
      "columns": [
        "division_status"
      ],
      "previousDefinition": "CHECK (((division_status >= 0) AND (division_status <= 1)))",
      "definition": "CHECK (((division_status >= 0) AND (division_status <= 1))) NOT VALID",
      "validated": false,
      "clause": "CONSTRAINT \"user_division_status_ck\" CHECK (\"division_status\" BETWEEN 0 AND 1) NOT VALID"
    },
    {
      "table": "user",
      "name": "user_division_type_ck",
      "columns": [
        "division_type"
      ],
      "previousDefinition": "CHECK (((division_type >= 0) AND (division_type <= 3)))",
      "definition": "CHECK (((division_type >= 0) AND (division_type <= 3))) NOT VALID",
      "validated": false,
      "clause": "CONSTRAINT \"user_division_type_ck\" CHECK (\"division_type\" BETWEEN 0 AND 3) NOT VALID"
    }
  ]
}
$check_state_data$::jsonb;
  item record;
  target record;
  actual record;
  target_oid oid;
  old_oid oid;
  table_name text;
  key_numbers smallint[];
  phase integer;
  already_aligned boolean;
  before_metadata jsonb;
  before_dependencies jsonb;
  before_comment text;
  before_expression text;
BEGIN
  IF target_schema IS NULL THEN RAISE EXCEPTION '0144 target schema is missing'; END IF;
  PERFORM pg_catalog.set_config('lock_timeout','2s',true);
  PERFORM pg_catalog.set_config('search_path',pg_catalog.format('pg_catalog,%I,pg_temp',target_schema),true);
  FOR table_name IN SELECT DISTINCT value->>'table'
    FROM pg_catalog.jsonb_array_elements(expected->'columns') ORDER BY 1
  LOOP
    SELECT c.oid INTO target_oid FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=target_schema AND c.relname=table_name AND c.relkind='r'
        AND c.relpersistence='p' AND NOT c.relispartition;
    IF target_oid IS NULL THEN RAISE EXCEPTION '0144 expected permanent ordinary table is missing: %',table_name; END IF;
    EXECUTE pg_catalog.format('LOCK TABLE ONLY %I.%I IN ACCESS EXCLUSIVE MODE',target_schema,table_name);
    IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class c
      WHERE c.oid=pg_catalog.to_regclass(pg_catalog.format('%I.%I',target_schema,table_name))
        AND c.oid=target_oid AND c.relkind='r' AND c.relpersistence='p' AND NOT c.relispartition)
      OR EXISTS(SELECT 1 FROM pg_catalog.pg_inherits WHERE inhrelid=target_oid OR inhparent=target_oid) THEN
      RAISE EXCEPTION '0144 table identity or inheritance drift: %',table_name;
    END IF;
  END LOOP;
  FOR item IN SELECT * FROM pg_catalog.jsonb_to_recordset(expected->'columns')
    AS col("table" text,name text,type text,"notNull" boolean,"default" text,identity text,generated text,"collation" text)
  LOOP
    SELECT a.attnum,pg_catalog.format_type(a.atttypid,a.atttypmod) AS type,a.attnotnull,
      a.attidentity,a.attgenerated,a.attislocal,a.attinhcount,a.attcollation,
      pg_catalog.pg_get_expr(d.adbin,d.adrelid,false) AS default_expression
      INTO actual FROM pg_catalog.pg_attribute a
      LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
      WHERE a.attrelid=pg_catalog.to_regclass(pg_catalog.format('%I.%I',target_schema,item."table"))
        AND a.attname=item.name AND a.attnum>0 AND NOT a.attisdropped;
    IF actual.attnum IS NULL OR actual.type IS DISTINCT FROM item.type OR actual.attnotnull IS DISTINCT FROM item."notNull"
      OR actual.default_expression IS DISTINCT FROM item."default"
      OR actual.attidentity::text IS DISTINCT FROM item.identity OR actual.attgenerated::text IS DISTINCT FROM item.generated
      OR NOT actual.attislocal OR actual.attinhcount<>0
      OR actual.attcollation IS DISTINCT FROM (CASE WHEN item.collation IS NULL THEN 0::oid ELSE
        pg_catalog.to_regcollation(pg_catalog.format('%I.%I',pg_catalog.split_part(item.collation,'.',1),pg_catalog.split_part(item.collation,'.',2)))::oid END) THEN
      RAISE EXCEPTION '0144 column shape drift or missing: %.%',item."table",item.name;
    END IF;
  END LOOP;

  -- The complete cohort is checked before the first DROP; there is no CASCADE.
  FOR phase IN 1..2 LOOP
    FOR target IN SELECT * FROM pg_catalog.jsonb_to_recordset(expected->'constraints')
      AS c("table" text,name text,columns text[],"previousDefinition" text,definition text,validated boolean,clause text)
    LOOP
      target_oid := pg_catalog.to_regclass(pg_catalog.format('%I.%I',target_schema,target."table"));
      SELECT pg_catalog.array_agg(a.attnum ORDER BY a.attnum) INTO key_numbers FROM pg_catalog.pg_attribute a
        WHERE a.attrelid=target_oid AND a.attname=ANY(target.columns) AND a.attnum>0 AND NOT a.attisdropped;
      SELECT c.* INTO actual FROM pg_catalog.pg_constraint c WHERE c.conrelid=target_oid AND c.conname=target.name;
      IF actual.oid IS NULL THEN RAISE EXCEPTION '0144 missing CHECK: %.%',target."table",target.name; END IF;
      already_aligned := pg_catalog.pg_get_constraintdef(actual.oid,false)=target.definition
        AND actual.convalidated=target.validated;
      IF actual.contype<>'c' OR actual.connamespace<>pg_catalog.to_regnamespace(target_schema)
        OR actual.contypid<>0 OR actual.conindid<>0 OR actual.confrelid<>0 OR actual.conparentid<>0
        OR actual.condeferrable OR actual.condeferred OR actual.connoinherit OR NOT actual.conislocal OR actual.coninhcount<>0
        OR actual.confkey IS NOT NULL OR actual.conexclop IS NOT NULL OR actual.conbin IS NULL
        OR actual.conpfeqop IS NOT NULL OR actual.conppeqop IS NOT NULL OR actual.conffeqop IS NOT NULL
        OR actual.confdelsetcols IS NOT NULL OR actual.confmatchtype<>' ' OR actual.confupdtype<>' ' OR actual.confdeltype<>' '
        OR COALESCE(pg_catalog.to_jsonb(actual)->>'conenforced','true')<>'true'
        OR COALESCE(pg_catalog.to_jsonb(actual)->>'conperiod','false')<>'false'
        OR (SELECT pg_catalog.array_agg(k ORDER BY k) FROM pg_catalog.unnest(actual.conkey) k) IS DISTINCT FROM key_numbers
        OR pg_catalog.cardinality(key_numbers)<>pg_catalog.cardinality(target.columns)
        OR NOT (already_aligned OR (pg_catalog.pg_get_constraintdef(actual.oid,false)=target."previousDefinition" AND actual.convalidated))
        OR EXISTS(SELECT 1 FROM pg_catalog.pg_constraint c WHERE c.conrelid=target_oid AND c.oid<>actual.oid
          AND pg_catalog.pg_get_constraintdef(c.oid,false) IN (target.definition,target."previousDefinition")) THEN
        RAISE EXCEPTION '0144 CHECK definition or validation drift: %.%',target."table",target.name;
      END IF;
      -- Only two self-table attribute dependencies per column (automatic + normal).
      -- Custom operators/functions, inbound/shared dependencies and security labels fail closed.
      IF (SELECT count(*) FROM pg_catalog.pg_depend d WHERE d.classid='pg_catalog.pg_constraint'::regclass AND d.objid=actual.oid)
          <>2*pg_catalog.cardinality(key_numbers)
        OR (SELECT count(DISTINCT (d.refobjsubid,d.deptype)) FROM pg_catalog.pg_depend d
          WHERE d.classid='pg_catalog.pg_constraint'::regclass AND d.objid=actual.oid AND d.objsubid=0
            AND d.refclassid='pg_catalog.pg_class'::regclass AND d.refobjid=target_oid
            AND d.refobjsubid=ANY(key_numbers) AND d.deptype IN ('a','n'))<>2*pg_catalog.cardinality(key_numbers)
        OR EXISTS(SELECT 1 FROM pg_catalog.pg_depend d WHERE d.refclassid='pg_catalog.pg_constraint'::regclass AND d.refobjid=actual.oid)
        OR EXISTS(SELECT 1 FROM pg_catalog.pg_shdepend d WHERE d.classid='pg_catalog.pg_constraint'::regclass AND d.objid=actual.oid
          AND d.dbid=(SELECT oid FROM pg_catalog.pg_database WHERE datname=pg_catalog.current_database()))
        OR EXISTS(SELECT 1 FROM pg_catalog.pg_seclabel s WHERE s.classoid='pg_catalog.pg_constraint'::regclass AND s.objoid=actual.oid) THEN
        RAISE EXCEPTION '0144 CHECK dependency or label drift: %.%',target."table",target.name;
      END IF;
      IF phase=2 AND NOT already_aligned THEN
        old_oid := actual.oid;
        before_metadata := pg_catalog.to_jsonb(actual)-ARRAY['oid','convalidated','conbin'];
        -- PG16 stores parser source offsets; PG18 nodeToString omits them.
        -- Ignore only :location integers, not operator OIDs, constants, casts or tree shape.
        before_expression := pg_catalog.regexp_replace(actual.conbin::text,' :location -?[0-9]+(?=[ )}])',' :location -1','g');
        before_comment := pg_catalog.obj_description(old_oid,'pg_constraint');
        SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(d)-'objid' ORDER BY d.refobjsubid,d.deptype)
          INTO before_dependencies FROM pg_catalog.pg_depend d WHERE d.classid='pg_catalog.pg_constraint'::regclass AND d.objid=old_oid;
        EXECUTE pg_catalog.format('ALTER TABLE ONLY %I.%I DROP CONSTRAINT %I RESTRICT',target_schema,target."table",target.name);
        EXECUTE pg_catalog.format('ALTER TABLE ONLY %I.%I ADD %s',target_schema,target."table",target.clause);
        EXECUTE pg_catalog.format('COMMENT ON CONSTRAINT %I ON %I.%I IS %L',target.name,target_schema,target."table",before_comment);
        SELECT c.* INTO actual FROM pg_catalog.pg_constraint c WHERE c.conrelid=target_oid AND c.conname=target.name;
        IF actual.oid IS NULL OR actual.oid=old_oid
          OR (pg_catalog.to_jsonb(actual)-ARRAY['oid','convalidated','conbin']) IS DISTINCT FROM before_metadata
          OR pg_catalog.pg_get_constraintdef(actual.oid,false) IS DISTINCT FROM target.definition
          OR actual.convalidated IS DISTINCT FROM target.validated
          OR (NOT target.validated AND pg_catalog.regexp_replace(actual.conbin::text,' :location -?[0-9]+(?=[ )}])',' :location -1','g') IS DISTINCT FROM before_expression)
          OR pg_catalog.obj_description(actual.oid,'pg_constraint') IS DISTINCT FROM before_comment
          OR (SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(d)-'objid' ORDER BY d.refobjsubid,d.deptype)
            FROM pg_catalog.pg_depend d WHERE d.classid='pg_catalog.pg_constraint'::regclass AND d.objid=actual.oid)
            IS DISTINCT FROM before_dependencies
          OR EXISTS(SELECT 1 FROM pg_catalog.pg_depend d WHERE d.refclassid='pg_catalog.pg_constraint'::regclass AND d.refobjid=actual.oid)
          OR EXISTS(SELECT 1 FROM pg_catalog.pg_constraint WHERE oid=old_oid) THEN
          RAISE EXCEPTION '0144 replacement postcondition failed: %.%',target."table",target.name;
        END IF;
      END IF;
    END LOOP;
  END LOOP;
  PERFORM pg_catalog.set_config('search_path',original_search_path,true);
  PERFORM pg_catalog.set_config('lock_timeout',original_lock_timeout,true);
END
$check_state_alignment$;
