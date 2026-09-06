/** Exact mirror of external 0143; no database connection or import-time I/O. */
export const FOREIGN_KEY_NAME_ALIGNMENT_SQL = String.raw`-- DB-009E3: retain twelve foreign keys and their RI triggers; change only reviewed names.
-- Requires a short maintenance transaction; no business DML or constraint rebuild.
DO $foreign_key_name_alignment$
DECLARE
  target_schema text := pg_catalog.current_schema();
  expected constant jsonb := $foreign_key_data$
{
  "columns": [
    {
      "name": "id",
      "table": "city_delivery_callback_event",
      "type": "bigint",
      "notNull": true,
      "identity": "",
      "generated": "",
      "collation": null
    },
    {
      "name": "event_id",
      "table": "city_delivery_callback_outbox",
      "type": "bigint",
      "notNull": true,
      "identity": "",
      "generated": "",
      "collation": null
    },
    {
      "name": "last_event_id",
      "table": "city_delivery_callback_watermark",
      "type": "bigint",
      "notNull": true,
      "identity": "",
      "generated": "",
      "collation": null
    },
    {
      "name": "delivery_order_id",
      "table": "city_delivery_reconciliation_case",
      "type": "integer",
      "notNull": true,
      "identity": "",
      "generated": "",
      "collation": null
    },
    {
      "name": "last_event_id",
      "table": "city_delivery_reconciliation_case",
      "type": "bigint",
      "notNull": false,
      "identity": "",
      "generated": "",
      "collation": null
    },
    {
      "name": "run_id",
      "table": "data_migration_checkpoint",
      "type": "character varying(64)",
      "notNull": true,
      "identity": "",
      "generated": "",
      "collation": "pg_catalog.default"
    },
    {
      "name": "run_id",
      "table": "data_migration_run",
      "type": "character varying(64)",
      "notNull": true,
      "identity": "",
      "generated": "",
      "collation": "pg_catalog.default"
    },
    {
      "name": "id",
      "table": "merchant_shipment_callback_event",
      "type": "bigint",
      "notNull": true,
      "identity": "",
      "generated": "",
      "collation": null
    },
    {
      "name": "event_id",
      "table": "merchant_shipment_callback_outbox",
      "type": "bigint",
      "notNull": true,
      "identity": "",
      "generated": "",
      "collation": null
    },
    {
      "name": "last_event_id",
      "table": "merchant_shipment_callback_watermark",
      "type": "bigint",
      "notNull": true,
      "identity": "",
      "generated": "",
      "collation": null
    },
    {
      "name": "id",
      "table": "payment_callback_event",
      "type": "bigint",
      "notNull": true,
      "identity": "",
      "generated": "",
      "collation": null
    },
    {
      "name": "event_id",
      "table": "payment_callback_outbox",
      "type": "bigint",
      "notNull": true,
      "identity": "",
      "generated": "",
      "collation": null
    },
    {
      "name": "case_id",
      "table": "payment_reconciliation_action",
      "type": "bigint",
      "notNull": true,
      "identity": "",
      "generated": "",
      "collation": null
    },
    {
      "name": "callback_event_id",
      "table": "payment_reconciliation_case",
      "type": "bigint",
      "notNull": false,
      "identity": "",
      "generated": "",
      "collation": null
    },
    {
      "name": "id",
      "table": "payment_reconciliation_case",
      "type": "bigint",
      "notNull": true,
      "identity": "",
      "generated": "",
      "collation": null
    },
    {
      "name": "id",
      "table": "store_delivery_order",
      "type": "integer",
      "notNull": true,
      "identity": "",
      "generated": "",
      "collation": null
    },
    {
      "name": "id",
      "table": "wechat_callback_event",
      "type": "bigint",
      "notNull": true,
      "identity": "",
      "generated": "",
      "collation": null
    },
    {
      "name": "event_id",
      "table": "wechat_callback_outbox",
      "type": "bigint",
      "notNull": true,
      "identity": "",
      "generated": "",
      "collation": null
    },
    {
      "name": "last_event_id",
      "table": "wechat_callback_watermark",
      "type": "bigint",
      "notNull": true,
      "identity": "",
      "generated": "",
      "collation": null
    }
  ],
  "constraints": [
    {
      "table": "city_delivery_callback_outbox",
      "previousName": "city_delivery_callback_outbox_event_id_city_delivery_callback_e",
      "name": "cdcout_event_fk",
      "definition": "FOREIGN KEY (event_id) REFERENCES city_delivery_callback_event(id) ON DELETE RESTRICT",
      "column": "event_id",
      "referenceTable": "city_delivery_callback_event",
      "referenceColumn": "id",
      "primaryKey": "city_delivery_callback_event_pkey",
      "equalityOperator": "pg_catalog.=(bigint,bigint)",
      "onDelete": "r"
    },
    {
      "table": "city_delivery_callback_watermark",
      "previousName": "city_delivery_callback_watermark_last_event_id_city_delivery_ca",
      "name": "cdcwm_event_fk",
      "definition": "FOREIGN KEY (last_event_id) REFERENCES city_delivery_callback_event(id) ON DELETE RESTRICT",
      "column": "last_event_id",
      "referenceTable": "city_delivery_callback_event",
      "referenceColumn": "id",
      "primaryKey": "city_delivery_callback_event_pkey",
      "equalityOperator": "pg_catalog.=(bigint,bigint)",
      "onDelete": "r"
    },
    {
      "table": "city_delivery_reconciliation_case",
      "previousName": "city_delivery_reconciliation_case_delivery_order_id_store_deliv",
      "name": "cdcrc_delivery_order_fk",
      "definition": "FOREIGN KEY (delivery_order_id) REFERENCES store_delivery_order(id) ON DELETE RESTRICT",
      "column": "delivery_order_id",
      "referenceTable": "store_delivery_order",
      "referenceColumn": "id",
      "primaryKey": "store_delivery_order_pkey",
      "equalityOperator": "pg_catalog.=(integer,integer)",
      "onDelete": "r"
    },
    {
      "table": "city_delivery_reconciliation_case",
      "previousName": "city_delivery_reconciliation_case_last_event_id_city_delivery_c",
      "name": "cdcrc_event_fk",
      "definition": "FOREIGN KEY (last_event_id) REFERENCES city_delivery_callback_event(id) ON DELETE RESTRICT",
      "column": "last_event_id",
      "referenceTable": "city_delivery_callback_event",
      "referenceColumn": "id",
      "primaryKey": "city_delivery_callback_event_pkey",
      "equalityOperator": "pg_catalog.=(bigint,bigint)",
      "onDelete": "r"
    },
    {
      "table": "data_migration_checkpoint",
      "previousName": "data_migration_checkpoint_run_id_data_migration_run_run_id_fk",
      "name": "data_migration_checkpoint_run_id_fkey",
      "definition": "FOREIGN KEY (run_id) REFERENCES data_migration_run(run_id) ON DELETE CASCADE",
      "column": "run_id",
      "referenceTable": "data_migration_run",
      "referenceColumn": "run_id",
      "primaryKey": "data_migration_run_pkey",
      "equalityOperator": "pg_catalog.=(text,text)",
      "onDelete": "c"
    },
    {
      "table": "merchant_shipment_callback_outbox",
      "previousName": "merchant_shipment_callback_outbox_event_id_merchant_shipment_ca",
      "name": "mscout_event_fk",
      "definition": "FOREIGN KEY (event_id) REFERENCES merchant_shipment_callback_event(id) ON DELETE RESTRICT",
      "column": "event_id",
      "referenceTable": "merchant_shipment_callback_event",
      "referenceColumn": "id",
      "primaryKey": "merchant_shipment_callback_event_pkey",
      "equalityOperator": "pg_catalog.=(bigint,bigint)",
      "onDelete": "r"
    },
    {
      "table": "merchant_shipment_callback_watermark",
      "previousName": "merchant_shipment_callback_watermark_last_event_id_merchant_shi",
      "name": "mscwm_event_fk",
      "definition": "FOREIGN KEY (last_event_id) REFERENCES merchant_shipment_callback_event(id) ON DELETE RESTRICT",
      "column": "last_event_id",
      "referenceTable": "merchant_shipment_callback_event",
      "referenceColumn": "id",
      "primaryKey": "merchant_shipment_callback_event_pkey",
      "equalityOperator": "pg_catalog.=(bigint,bigint)",
      "onDelete": "r"
    },
    {
      "table": "payment_callback_outbox",
      "previousName": "payment_callback_outbox_event_id_payment_callback_event_id_fk",
      "name": "pco_event_fk",
      "definition": "FOREIGN KEY (event_id) REFERENCES payment_callback_event(id) ON DELETE RESTRICT",
      "column": "event_id",
      "referenceTable": "payment_callback_event",
      "referenceColumn": "id",
      "primaryKey": "payment_callback_event_pkey",
      "equalityOperator": "pg_catalog.=(bigint,bigint)",
      "onDelete": "r"
    },
    {
      "table": "payment_reconciliation_action",
      "previousName": "payment_reconciliation_action_case_id_payment_reconciliation_ca",
      "name": "pra_case_fk",
      "definition": "FOREIGN KEY (case_id) REFERENCES payment_reconciliation_case(id) ON DELETE RESTRICT",
      "column": "case_id",
      "referenceTable": "payment_reconciliation_case",
      "referenceColumn": "id",
      "primaryKey": "payment_reconciliation_case_pkey",
      "equalityOperator": "pg_catalog.=(bigint,bigint)",
      "onDelete": "r"
    },
    {
      "table": "payment_reconciliation_case",
      "previousName": "payment_reconciliation_case_callback_event_id_payment_callback_",
      "name": "prc_callback_event_fk",
      "definition": "FOREIGN KEY (callback_event_id) REFERENCES payment_callback_event(id) ON DELETE RESTRICT",
      "column": "callback_event_id",
      "referenceTable": "payment_callback_event",
      "referenceColumn": "id",
      "primaryKey": "payment_callback_event_pkey",
      "equalityOperator": "pg_catalog.=(bigint,bigint)",
      "onDelete": "r"
    },
    {
      "table": "wechat_callback_outbox",
      "previousName": "wechat_callback_outbox_event_id_wechat_callback_event_id_fk",
      "name": "wcout_event_fk",
      "definition": "FOREIGN KEY (event_id) REFERENCES wechat_callback_event(id) ON DELETE RESTRICT",
      "column": "event_id",
      "referenceTable": "wechat_callback_event",
      "referenceColumn": "id",
      "primaryKey": "wechat_callback_event_pkey",
      "equalityOperator": "pg_catalog.=(bigint,bigint)",
      "onDelete": "r"
    },
    {
      "table": "wechat_callback_watermark",
      "previousName": "wechat_callback_watermark_last_event_id_wechat_callback_event_i",
      "name": "wcwm_event_fk",
      "definition": "FOREIGN KEY (last_event_id) REFERENCES wechat_callback_event(id) ON DELETE RESTRICT",
      "column": "last_event_id",
      "referenceTable": "wechat_callback_event",
      "referenceColumn": "id",
      "primaryKey": "wechat_callback_event_pkey",
      "equalityOperator": "pg_catalog.=(bigint,bigint)",
      "onDelete": "r"
    }
  ]
}
$foreign_key_data$::jsonb;

  item record;
  target record;
  actual record;
  ref_key record;
  old_oid oid;
  new_oid oid;
  target_oid oid;
  ref_oid oid;
  key_number smallint;
  ref_number smallint;
  equality_oid oid;
  phase integer;
  table_name text;
  before_constraint jsonb;
  before_triggers jsonb;
  original_search_path text := pg_catalog.current_setting('search_path');
BEGIN
  IF target_schema IS NULL THEN RAISE EXCEPTION '0143 target schema is missing'; END IF;
  PERFORM pg_catalog.set_config('lock_timeout', '2s', true);
  PERFORM pg_catalog.set_config('search_path',pg_catalog.format('pg_catalog,%I,pg_temp',target_schema),true);
  -- Parent and child table locks are taken in one deterministic order.
  FOR table_name IN SELECT DISTINCT value->>'table'
    FROM pg_catalog.jsonb_array_elements(expected->'columns') ORDER BY 1
  LOOP
    SELECT c.oid INTO target_oid FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=target_schema AND c.relname=table_name AND c.relkind='r'
        AND c.relpersistence='p' AND NOT c.relispartition;
    IF target_oid IS NULL THEN RAISE EXCEPTION '0143 expected permanent ordinary table is missing: %',table_name; END IF;
    EXECUTE pg_catalog.format('LOCK TABLE ONLY %I.%I IN ACCESS EXCLUSIVE MODE',target_schema,table_name);
    IF pg_catalog.to_regclass(pg_catalog.format('%I.%I',target_schema,table_name))::oid IS DISTINCT FROM target_oid
      OR EXISTS(SELECT 1 FROM pg_catalog.pg_inherits WHERE inhrelid=target_oid OR inhparent=target_oid) THEN
      RAISE EXCEPTION '0143 table identity or inheritance drift: %',table_name;
    END IF;
  END LOOP;

  FOR item IN SELECT * FROM pg_catalog.jsonb_to_recordset(expected->'columns')
    AS col("table" text,name text,type text,"notNull" boolean,identity text,generated text,"collation" text)
  LOOP
    SELECT a.attnum,pg_catalog.format_type(a.atttypid,a.atttypmod) AS type,a.attnotnull,
      a.attidentity,a.attgenerated,a.attislocal,a.attinhcount,a.attcollation
      INTO actual FROM pg_catalog.pg_attribute a
      WHERE a.attrelid=pg_catalog.to_regclass(pg_catalog.format('%I.%I',target_schema,item."table"))
        AND a.attname=item.name AND a.attnum>0 AND NOT a.attisdropped;
    IF actual.attnum IS NULL OR actual.type IS DISTINCT FROM item.type OR actual.attnotnull IS DISTINCT FROM item."notNull"
      OR actual.attidentity::text IS DISTINCT FROM item.identity OR actual.attgenerated::text IS DISTINCT FROM item.generated
      OR NOT actual.attislocal OR actual.attinhcount<>0
      OR actual.attcollation IS DISTINCT FROM (CASE WHEN item.collation IS NULL THEN 0::oid ELSE
        pg_catalog.to_regcollation(pg_catalog.format('%I.%I',pg_catalog.split_part(item.collation,'.',1),pg_catalog.split_part(item.collation,'.',2)))::oid END) THEN
      RAISE EXCEPTION '0143 column shape drift or missing: %.%',item."table",item.name;
    END IF;
  END LOOP;

  -- Preflight the entire cohort before any rename, then recheck each rename.
  FOR phase IN 1..2 LOOP
    FOR target IN SELECT * FROM pg_catalog.jsonb_to_recordset(expected->'constraints')
      AS c("table" text,"previousName" text,name text,definition text,"column" text,"referenceTable" text,
        "referenceColumn" text,"primaryKey" text,"equalityOperator" text,"onDelete" text)
    LOOP
      target_oid := pg_catalog.to_regclass(pg_catalog.format('%I.%I',target_schema,target."table"));
      ref_oid := pg_catalog.to_regclass(pg_catalog.format('%I.%I',target_schema,target."referenceTable"));
      SELECT attnum INTO key_number FROM pg_catalog.pg_attribute
        WHERE attrelid=target_oid AND attname=target."column" AND NOT attisdropped;
      SELECT attnum INTO ref_number FROM pg_catalog.pg_attribute
        WHERE attrelid=ref_oid AND attname=target."referenceColumn" AND NOT attisdropped;
      equality_oid := pg_catalog.to_regoperator(target."equalityOperator");
      SELECT c.* INTO ref_key FROM pg_catalog.pg_constraint c
        JOIN pg_catalog.pg_index i ON i.indexrelid=c.conindid
        JOIN pg_catalog.pg_class idx ON idx.oid=i.indexrelid
        WHERE c.conrelid=ref_oid AND c.conname=target."primaryKey" AND c.contype='p'
          AND c.connamespace=pg_catalog.to_regnamespace(target_schema) AND c.contypid=0
          AND c.convalidated AND NOT c.condeferrable AND NOT c.condeferred
          AND c.conislocal AND c.coninhcount=0 AND c.conparentid=0 AND c.connoinherit
          AND c.conkey=ARRAY[ref_number] AND c.conbin IS NULL AND c.conexclop IS NULL
          AND idx.relname=target."primaryKey" AND idx.relkind='i' AND idx.relpersistence='p' AND NOT idx.relispartition
          AND idx.relnamespace=c.connamespace AND i.indrelid=ref_oid
          AND i.indisprimary AND i.indisunique AND i.indimmediate AND i.indisvalid AND i.indisready AND i.indislive
          AND NOT i.indisexclusion AND NOT i.indnullsnotdistinct AND NOT i.indisreplident
          AND i.indnkeyatts=1 AND i.indnatts=1 AND i.indpred IS NULL AND i.indexprs IS NULL
          AND pg_catalog.pg_get_indexdef(i.indexrelid)=pg_catalog.format('CREATE UNIQUE INDEX %I ON %I.%I USING btree (%I)',
            target."primaryKey",target_schema,target."referenceTable",target."referenceColumn");
      IF ref_key.oid IS NULL OR equality_oid IS NULL OR key_number IS NULL OR ref_number IS NULL THEN
        RAISE EXCEPTION '0143 referenced primary key or column drift: %',target."table";
      END IF;
      SELECT c.oid INTO old_oid FROM pg_catalog.pg_constraint c WHERE c.conrelid=target_oid AND c.conname=target."previousName";
      SELECT c.oid INTO new_oid FROM pg_catalog.pg_constraint c WHERE c.conrelid=target_oid AND c.conname=target.name;
      IF (old_oid IS NULL)=(new_oid IS NULL) THEN
        RAISE EXCEPTION '0143 ambiguous or missing foreign key: %.%',target."table",target.name;
      END IF;
      SELECT c.* INTO actual FROM pg_catalog.pg_constraint c WHERE c.oid=COALESCE(old_oid,new_oid);
      IF actual.contype<>'f' OR actual.connamespace<>pg_catalog.to_regnamespace(target_schema) OR actual.contypid<>0
        OR pg_catalog.pg_get_constraintdef(actual.oid,false) IS DISTINCT FROM target.definition
        OR NOT actual.convalidated OR actual.condeferrable OR actual.condeferred
        OR NOT actual.connoinherit OR NOT actual.conislocal OR actual.coninhcount<>0 OR actual.conparentid<>0
        OR actual.conkey IS DISTINCT FROM ARRAY[key_number]
        OR actual.confrelid IS DISTINCT FROM ref_oid OR actual.confkey IS DISTINCT FROM ARRAY[ref_number]
        OR actual.conindid IS DISTINCT FROM ref_key.conindid OR actual.confmatchtype<>'s'
        OR actual.confupdtype<>'a' OR actual.confdeltype::text IS DISTINCT FROM target."onDelete"
        OR actual.confdelsetcols IS NOT NULL OR actual.conexclop IS NOT NULL OR actual.conbin IS NOT NULL
        OR actual.conpfeqop IS DISTINCT FROM ARRAY[equality_oid] OR actual.conppeqop IS DISTINCT FROM ARRAY[equality_oid]
        OR actual.conffeqop IS DISTINCT FROM ARRAY[equality_oid]
        OR EXISTS(SELECT 1 FROM pg_catalog.pg_constraint c WHERE c.conrelid=target_oid AND c.oid<>actual.oid
          AND pg_catalog.pg_get_constraintdef(c.oid,false)=target.definition) THEN
        RAISE EXCEPTION '0143 foreign key definition or validation drift: %.%',target."table",target.name;
      END IF;
      -- conindid for an FK is its parent's index, not a child-owned index.
      -- All four RI triggers must have the exact builtin function and relation roles.
      IF (SELECT count(*) FROM pg_catalog.pg_trigger WHERE tgconstraint=actual.oid)<>4
OR (SELECT count(DISTINCT (t.tgtype,t.tgrelid,t.tgconstrrelid,t.tgfoid)) FROM pg_catalog.pg_trigger t
          JOIN (VALUES
            (5,target_oid,ref_oid,'RI_FKey_check_ins'),
            (17,target_oid,ref_oid,'RI_FKey_check_upd'),
            (9,ref_oid,target_oid,CASE WHEN target."onDelete"='c' THEN 'RI_FKey_cascade_del' ELSE 'RI_FKey_restrict_del' END),
            (17,ref_oid,target_oid,'RI_FKey_noaction_upd')
          ) AS protocol(event_type,own_relation,other_relation,function_name)
            ON t.tgtype=protocol.event_type AND t.tgrelid=protocol.own_relation AND t.tgconstrrelid=protocol.other_relation
            AND t.tgfoid=pg_catalog.to_regprocedure(pg_catalog.format('pg_catalog.%I()',protocol.function_name))
          WHERE t.tgconstraint=actual.oid AND t.tgconstrindid=ref_key.conindid
            AND t.tgisinternal AND t.tgenabled='O' AND t.tgparentid=0 AND NOT t.tgdeferrable AND NOT t.tginitdeferred
            AND t.tgnargs=0 AND pg_catalog.octet_length(t.tgargs)=0 AND t.tgattr::text=''
            AND t.tgqual IS NULL AND t.tgoldtable IS NULL AND t.tgnewtable IS NULL)<>4 THEN
        RAISE EXCEPTION '0143 foreign key trigger drift: %.%',target."table",target.name;
      END IF;
      IF phase=2 AND old_oid IS NOT NULL THEN
        before_constraint := pg_catalog.to_jsonb(actual)-'conname';
        SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(t) ORDER BY t.oid) INTO before_triggers
          FROM pg_catalog.pg_trigger t WHERE t.tgconstraint=old_oid;
        EXECUTE pg_catalog.format('ALTER TABLE ONLY %I.%I RENAME CONSTRAINT %I TO %I',
          target_schema,target."table",target."previousName",target.name);
        SELECT c.* INTO actual FROM pg_catalog.pg_constraint c WHERE c.conrelid=target_oid AND c.conname=target.name;
        IF actual.oid IS DISTINCT FROM old_oid OR (pg_catalog.to_jsonb(actual)-'conname') IS DISTINCT FROM before_constraint
          OR (SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(t) ORDER BY t.oid) FROM pg_catalog.pg_trigger t WHERE t.tgconstraint=old_oid)
            IS DISTINCT FROM before_triggers
          OR EXISTS(SELECT 1 FROM pg_catalog.pg_constraint c WHERE c.conrelid=target_oid AND c.conname=target."previousName") THEN
          RAISE EXCEPTION '0143 renamed foreign key or trigger identity changed: %.%',target."table",target.name;
        END IF;
      END IF;
    END LOOP;
  END LOOP;
  PERFORM pg_catalog.set_config('search_path',original_search_path,true);
END
$foreign_key_name_alignment$;
`;
