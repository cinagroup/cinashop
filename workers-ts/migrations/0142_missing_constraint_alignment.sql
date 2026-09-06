-- DB-009E2B: restore 41 reviewed constraints; never rewrite data or auto-VALIDATE.
DO $missing_constraint_alignment$
DECLARE
  target_schema text := current_schema();
  expected jsonb := $constraint_data$
{
  "columns": [
    {"table":"agent_level","name":"one_brokerage","type":"smallint","notNull":true,"identity":"","generated":"","collation":null},
    {"table":"agent_level","name":"two_brokerage","type":"smallint","notNull":true,"identity":"","generated":"","collation":null},
    {"table":"kefu_visitor_session","name":"created_at","type":"integer","notNull":true,"identity":"","generated":"","collation":null},
    {"table":"kefu_visitor_session","name":"expires_at","type":"integer","notNull":true,"identity":"","generated":"","collation":null},
    {"table":"kefu_visitor_session","name":"kefu_uid","type":"integer","notNull":true,"identity":"","generated":"","collation":null},
    {"table":"kefu_visitor_session","name":"last_seen_at","type":"integer","notNull":true,"identity":"","generated":"","collation":null},
    {"table":"kefu_visitor_session","name":"revoked_at","type":"integer","notNull":true,"identity":"","generated":"","collation":null},
    {"table":"kefu_visitor_session","name":"service_id","type":"integer","notNull":true,"identity":"","generated":"","collation":null},
    {"table":"kefu_visitor_session","name":"token_hash","type":"character varying(64)","notNull":true,"identity":"","generated":"","collation":"pg_catalog.default"},
    {"table":"kefu_visitor_session","name":"visitor_uid","type":"integer","notNull":true,"identity":"","generated":"","collation":null},
    {"table":"store_order_cart_info","name":"id","type":"integer","notNull":true,"identity":"","generated":"","collation":null},
    {"table":"store_order_outbox","name":"attempt_count","type":"integer","notNull":true,"identity":"","generated":"","collation":null},
    {"table":"store_order_outbox","name":"available_time","type":"integer","notNull":true,"identity":"","generated":"","collation":null},
    {"table":"store_order_outbox","name":"dispatch_count","type":"integer","notNull":true,"identity":"","generated":"","collation":null},
    {"table":"store_order_outbox","name":"lease_until","type":"integer","notNull":true,"identity":"","generated":"","collation":null},
    {"table":"store_order_outbox","name":"replay_count","type":"integer","notNull":true,"identity":"","generated":"","collation":null},
    {"table":"store_order_outbox","name":"status","type":"character varying(16)","notNull":true,"identity":"","generated":"","collation":"pg_catalog.default"},
    {"table":"store_order_product_coupon_reward","name":"add_time","type":"integer","notNull":true,"identity":"","generated":"","collation":null},
    {"table":"store_order_product_coupon_reward","name":"coupon_user_id","type":"integer","notNull":true,"identity":"","generated":"","collation":null},
    {"table":"store_order_product_coupon_reward","name":"issue_coupon_id","type":"integer","notNull":true,"identity":"","generated":"","collation":null},
    {"table":"store_order_product_coupon_reward","name":"order_id","type":"integer","notNull":true,"identity":"","generated":"","collation":null},
    {"table":"store_order_product_coupon_reward","name":"product_id","type":"integer","notNull":true,"identity":"","generated":"","collation":null},
    {"table":"store_order_product_coupon_reward","name":"uid","type":"integer","notNull":true,"identity":"","generated":"","collation":null},
    {"table":"store_order_refund_payment","name":"provider","type":"character varying(16)","notNull":true,"identity":"","generated":"","collation":"pg_catalog.default"},
    {"table":"store_order_refund_payment","name":"provider_status","type":"character varying(24)","notNull":true,"identity":"","generated":"","collation":"pg_catalog.default"},
    {"table":"store_order_refund_payment","name":"request_amount","type":"integer","notNull":true,"identity":"","generated":"","collation":null},
    {"table":"store_order_refund_payment","name":"total_amount","type":"integer","notNull":true,"identity":"","generated":"","collation":null},
    {"table":"store_product_attr_value","name":"is_retired","type":"smallint","notNull":true,"identity":"","generated":"","collation":null},
    {"table":"store_product_description","name":"type","type":"smallint","notNull":true,"identity":"","generated":"","collation":null},
    {"table":"store_product_reply","name":"order_cart_info_id","type":"integer","notNull":false,"identity":"","generated":"","collation":null},
    {"table":"store_product_stock_record","name":"number","type":"integer","notNull":true,"identity":"","generated":"","collation":null},
    {"table":"store_product_stock_record","name":"pm","type":"smallint","notNull":true,"identity":"","generated":"","collation":null},
    {"table":"store_service_transfer","name":"copied_message_count","type":"integer","notNull":true,"identity":"","generated":"","collation":null},
    {"table":"store_service_transfer","name":"created_at","type":"integer","notNull":true,"identity":"","generated":"","collation":null},
    {"table":"store_service_transfer","name":"customer_uid","type":"integer","notNull":true,"identity":"","generated":"","collation":null},
    {"table":"store_service_transfer","name":"from_kefu_uid","type":"integer","notNull":true,"identity":"","generated":"","collation":null},
    {"table":"store_service_transfer","name":"from_service_id","type":"integer","notNull":true,"identity":"","generated":"","collation":null},
    {"table":"store_service_transfer","name":"is_tourist","type":"smallint","notNull":true,"identity":"","generated":"","collation":null},
    {"table":"store_service_transfer","name":"source_record_id","type":"integer","notNull":true,"identity":"","generated":"","collation":null},
    {"table":"store_service_transfer","name":"target_record_id","type":"integer","notNull":true,"identity":"","generated":"","collation":null},
    {"table":"store_service_transfer","name":"to_kefu_uid","type":"integer","notNull":true,"identity":"","generated":"","collation":null},
    {"table":"store_service_transfer","name":"to_service_id","type":"integer","notNull":true,"identity":"","generated":"","collation":null},
    {"table":"system_menus","name":"access","type":"smallint","notNull":true,"identity":"","generated":"","collation":null},
    {"table":"system_menus","name":"auth_type","type":"smallint","notNull":true,"identity":"","generated":"","collation":null},
    {"table":"system_menus","name":"is_del","type":"smallint","notNull":true,"identity":"","generated":"","collation":null},
    {"table":"system_menus","name":"is_header","type":"smallint","notNull":true,"identity":"","generated":"","collation":null},
    {"table":"system_menus","name":"is_show","type":"smallint","notNull":true,"identity":"","generated":"","collation":null},
    {"table":"system_menus","name":"is_show_path","type":"smallint","notNull":true,"identity":"","generated":"","collation":null},
    {"table":"system_menus","name":"type","type":"smallint","notNull":true,"identity":"","generated":"","collation":null},
    {"table":"system_queue_dead_letter","name":"first_seen_time","type":"integer","notNull":true,"identity":"","generated":"","collation":null},
    {"table":"system_queue_dead_letter","name":"last_seen_time","type":"integer","notNull":true,"identity":"","generated":"","collation":null},
    {"table":"system_queue_dead_letter","name":"message_timestamp_ms","type":"bigint","notNull":true,"identity":"","generated":"","collation":null},
    {"table":"system_queue_dead_letter","name":"replay_lease_until","type":"integer","notNull":true,"identity":"","generated":"","collation":null},
    {"table":"system_queue_dead_letter","name":"replay_requested_time","type":"integer","notNull":true,"identity":"","generated":"","collation":null},
    {"table":"system_queue_dead_letter","name":"replayed_time","type":"integer","notNull":true,"identity":"","generated":"","collation":null},
    {"table":"system_queue_dead_letter","name":"resolved_time","type":"integer","notNull":true,"identity":"","generated":"","collation":null},
    {"table":"work_callback_event","name":"attempt_count","type":"integer","notNull":true,"identity":"","generated":"","collation":null},
    {"table":"work_callback_event","name":"event_key","type":"character varying(64)","notNull":true,"identity":"","generated":"","collation":"pg_catalog.default"},
    {"table":"work_callback_event","name":"event_time","type":"integer","notNull":true,"identity":"","generated":"","collation":null},
    {"table":"work_callback_event","name":"id","type":"integer","notNull":true,"identity":"","generated":"","collation":null},
    {"table":"work_callback_event","name":"lease_until","type":"integer","notNull":true,"identity":"","generated":"","collation":null},
    {"table":"work_callback_event","name":"payload","type":"jsonb","notNull":true,"identity":"","generated":"","collation":null},
    {"table":"work_callback_event","name":"payload_hash","type":"character varying(64)","notNull":true,"identity":"","generated":"","collation":"pg_catalog.default"},
    {"table":"work_callback_event","name":"payload_redacted_time","type":"integer","notNull":true,"identity":"","generated":"","collation":null},
    {"table":"work_callback_event","name":"payload_retained_until","type":"integer","notNull":true,"identity":"","generated":"","collation":null},
    {"table":"work_callback_event","name":"processed_time","type":"integer","notNull":true,"identity":"","generated":"","collation":null},
    {"table":"work_callback_event","name":"projection_status","type":"character varying(16)","notNull":true,"identity":"","generated":"","collation":"pg_catalog.default"},
    {"table":"work_callback_event","name":"received_time","type":"integer","notNull":true,"identity":"","generated":"","collation":null},
    {"table":"work_callback_event","name":"status","type":"character varying(16)","notNull":true,"identity":"","generated":"","collation":"pg_catalog.default"},
    {"table":"work_callback_event","name":"subject_key_hash","type":"character varying(64)","notNull":true,"identity":"","generated":"","collation":"pg_catalog.default"},
    {"table":"work_callback_event","name":"update_time","type":"integer","notNull":true,"identity":"","generated":"","collation":null},
    {"table":"work_callback_outbox","name":"add_time","type":"integer","notNull":true,"identity":"","generated":"","collation":null},
    {"table":"work_callback_outbox","name":"attempt_count","type":"integer","notNull":true,"identity":"","generated":"","collation":null},
    {"table":"work_callback_outbox","name":"available_time","type":"integer","notNull":true,"identity":"","generated":"","collation":null},
    {"table":"work_callback_outbox","name":"dispatch_count","type":"integer","notNull":true,"identity":"","generated":"","collation":null},
    {"table":"work_callback_outbox","name":"enqueued_time","type":"integer","notNull":true,"identity":"","generated":"","collation":null},
    {"table":"work_callback_outbox","name":"event_id","type":"integer","notNull":true,"identity":"","generated":"","collation":null},
    {"table":"work_callback_outbox","name":"event_key","type":"character varying(64)","notNull":true,"identity":"","generated":"","collation":"pg_catalog.default"},
    {"table":"work_callback_outbox","name":"lease_until","type":"integer","notNull":true,"identity":"","generated":"","collation":null},
    {"table":"work_callback_outbox","name":"processed_time","type":"integer","notNull":true,"identity":"","generated":"","collation":null},
    {"table":"work_callback_outbox","name":"status","type":"character varying(16)","notNull":true,"identity":"","generated":"","collation":"pg_catalog.default"},
    {"table":"work_callback_outbox","name":"update_time","type":"integer","notNull":true,"identity":"","generated":"","collation":null},
    {"table":"work_callback_watermark","name":"event_key","type":"character varying(64)","notNull":true,"identity":"","generated":"","collation":"pg_catalog.default"},
    {"table":"work_callback_watermark","name":"event_time","type":"integer","notNull":true,"identity":"","generated":"","collation":null},
    {"table":"work_callback_watermark","name":"subject_key_hash","type":"character varying(64)","notNull":true,"identity":"","generated":"","collation":"pg_catalog.default"},
    {"table":"work_callback_watermark","name":"update_time","type":"integer","notNull":true,"identity":"","generated":"","collation":null},
    {"table":"work_contact_action_audit","name":"actor_id","type":"integer","notNull":true,"identity":"","generated":"","collation":null},
    {"table":"work_contact_action_audit","name":"add_time","type":"integer","notNull":true,"identity":"","generated":"","collation":null},
    {"table":"work_contact_action_audit","name":"from_status","type":"character varying(16)","notNull":true,"identity":"","generated":"","collation":"pg_catalog.default"},
    {"table":"work_contact_action_audit","name":"operation","type":"character varying(24)","notNull":true,"identity":"","generated":"","collation":"pg_catalog.default"},
    {"table":"work_contact_action_audit","name":"provider_reference_hash","type":"character varying(64)","notNull":false,"identity":"","generated":"","collation":"pg_catalog.default"},
    {"table":"work_contact_action_audit","name":"reason","type":"character varying(500)","notNull":true,"identity":"","generated":"","collation":"pg_catalog.default"},
    {"table":"work_contact_action_audit","name":"request_hash","type":"character varying(64)","notNull":true,"identity":"","generated":"","collation":"pg_catalog.default"},
    {"table":"work_contact_action_audit","name":"request_key","type":"character varying(36)","notNull":true,"identity":"","generated":"","collation":"pg_catalog.default"},
    {"table":"work_contact_action_audit","name":"risk_accepted","type":"boolean","notNull":true,"identity":"","generated":"","collation":null},
    {"table":"work_contact_action_audit","name":"to_status","type":"character varying(16)","notNull":true,"identity":"","generated":"","collation":"pg_catalog.default"}
  ],
  "constraints": [
    {"table":"agent_level","name":"al_brokerage_ck","type":"c","definition":"CHECK ((((one_brokerage >= 0) AND (one_brokerage <= 1000)) AND ((two_brokerage >= 0) AND (two_brokerage <= 1000))))","validated":true,"noInherit":false,"columns":["one_brokerage","two_brokerage"],"ddl":"CHECK (\n    \"one_brokerage\" BETWEEN 0 AND 1000 AND \"two_brokerage\" BETWEEN 0 AND 1000\n  )"},
    {"table":"kefu_visitor_session","name":"kvs_positive_ids_ck","type":"c","definition":"CHECK (((visitor_uid >= 1000000000) AND (service_id > 0) AND (kefu_uid > 0)))","validated":true,"noInherit":false,"columns":["visitor_uid","service_id","kefu_uid"],"ddl":"CHECK (\n    \"visitor_uid\" >= 1000000000 AND \"service_id\" > 0 AND \"kefu_uid\" > 0\n  )"},
    {"table":"kefu_visitor_session","name":"kvs_time_ck","type":"c","definition":"CHECK (((created_at > 0) AND (expires_at > created_at) AND (last_seen_at >= created_at) AND (last_seen_at <= expires_at) AND ((revoked_at = 0) OR (revoked_at >= created_at))))","validated":true,"noInherit":false,"columns":["created_at","expires_at","last_seen_at","revoked_at"],"ddl":"CHECK (\n    \"created_at\" > 0 AND \"expires_at\" > \"created_at\"\n    AND \"last_seen_at\" >= \"created_at\" AND \"last_seen_at\" <= \"expires_at\"\n    AND (\"revoked_at\" = 0 OR \"revoked_at\" >= \"created_at\")\n  )"},
    {"table":"kefu_visitor_session","name":"kvs_token_hash_ck","type":"c","definition":"CHECK (((token_hash)::text ~ '^[0-9a-f]{64}$'::text))","validated":true,"noInherit":false,"columns":["token_hash"],"ddl":"CHECK (\"token_hash\" ~ '^[0-9a-f]{64}$')"},
    {"table":"store_order_outbox","name":"soob_count_ck","type":"c","definition":"CHECK (((dispatch_count >= 0) AND (attempt_count >= 0) AND (replay_count >= 0)))","validated":true,"noInherit":false,"columns":["dispatch_count","attempt_count","replay_count"],"ddl":"CHECK (\n    \"dispatch_count\" >= 0 AND \"attempt_count\" >= 0 AND \"replay_count\" >= 0\n  )"},
    {"table":"store_order_outbox","name":"soob_status_ck","type":"c","definition":"CHECK (((status)::text = ANY ((ARRAY['PENDING'::character varying, 'ENQUEUING'::character varying, 'ENQUEUED'::character varying, 'PROCESSING'::character varying, 'COMPLETED'::character varying, 'FAILED'::character varying, 'DEAD'::character varying])::text[])))","validated":true,"noInherit":false,"columns":["status"],"ddl":"CHECK (\n    \"status\" IN ('PENDING', 'ENQUEUING', 'ENQUEUED', 'PROCESSING', 'COMPLETED', 'FAILED', 'DEAD')\n  )"},
    {"table":"store_order_outbox","name":"soob_time_ck","type":"c","definition":"CHECK (((available_time >= 0) AND (lease_until >= 0)))","validated":true,"noInherit":false,"columns":["available_time","lease_until"],"ddl":"CHECK (\"available_time\" >= 0 AND \"lease_until\" >= 0)"},
    {"table":"store_order_product_coupon_reward","name":"sopcr_positive_ids_ck","type":"c","definition":"CHECK (((order_id > 0) AND (uid > 0) AND (product_id > 0) AND (issue_coupon_id > 0) AND (coupon_user_id > 0) AND (add_time >= 0)))","validated":true,"noInherit":false,"columns":["order_id","uid","product_id","issue_coupon_id","coupon_user_id","add_time"],"ddl":"CHECK (\n    \"order_id\" > 0 AND \"uid\" > 0 AND \"product_id\" > 0\n      AND \"issue_coupon_id\" > 0 AND \"coupon_user_id\" > 0 AND \"add_time\" >= 0\n  )"},
    {"table":"store_order_refund_payment","name":"sorp_amount_ck","type":"c","definition":"CHECK (((request_amount >= 0) AND (total_amount >= 0) AND (request_amount <= total_amount)))","validated":true,"noInherit":false,"columns":["request_amount","total_amount"],"ddl":"CHECK (\n    \"request_amount\" >= 0 AND \"total_amount\" >= 0 AND \"request_amount\" <= \"total_amount\"\n  )"},
    {"table":"store_order_refund_payment","name":"sorp_provider_ck","type":"c","definition":"CHECK (((provider)::text = ANY ((ARRAY['wechat'::character varying, 'alipay'::character varying])::text[])))","validated":true,"noInherit":false,"columns":["provider"],"ddl":"CHECK (\"provider\" IN ('wechat', 'alipay'))"},
    {"table":"store_order_refund_payment","name":"sorp_status_ck","type":"c","definition":"CHECK (((provider_status)::text = ANY ((ARRAY['CREATED'::character varying, 'REQUESTING'::character varying, 'PROCESSING'::character varying, 'SUCCESS'::character varying, 'CLOSED'::character varying, 'ABNORMAL'::character varying, 'FAILED'::character varying, 'UNKNOWN'::character varying])::text[])))","validated":true,"noInherit":false,"columns":["provider_status"],"ddl":"CHECK (\n    \"provider_status\" IN ('CREATED', 'REQUESTING', 'PROCESSING', 'SUCCESS', 'CLOSED', 'ABNORMAL', 'FAILED', 'UNKNOWN')\n  )"},
    {"table":"store_product_attr_value","name":"spav_is_retired_ck","type":"c","definition":"CHECK ((is_retired = ANY (ARRAY[0, 1]))) NOT VALID","validated":false,"noInherit":false,"columns":["is_retired"],"ddl":"CHECK (\"is_retired\" IN (0, 1)) NOT VALID"},
    {"table":"store_product_description","name":"spd_type_ck","type":"c","definition":"CHECK (((type >= 0) AND (type <= 7))) NOT VALID","validated":false,"noInherit":false,"columns":["type"],"ddl":"CHECK (\"type\" BETWEEN 0 AND 7) NOT VALID"},
    {"table":"store_product_reply","name":"spr_order_cart_info_fk","type":"f","definition":"FOREIGN KEY (order_cart_info_id) REFERENCES store_order_cart_info(id) NOT VALID","validated":false,"noInherit":true,"columns":["order_cart_info_id"],"reference":{"table":"store_order_cart_info","columns":["id"],"primaryKey":"store_order_cart_info_pkey","onDelete":"a","onUpdate":"a"}},
    {"table":"store_product_stock_record","name":"spsr_number_ck","type":"c","definition":"CHECK ((number >= 0)) NOT VALID","validated":false,"noInherit":false,"columns":["number"],"ddl":"CHECK (\"number\" >= 0) NOT VALID"},
    {"table":"store_product_stock_record","name":"spsr_pm_ck","type":"c","definition":"CHECK (((pm >= 0) AND (pm <= 1))) NOT VALID","validated":false,"noInherit":false,"columns":["pm"],"ddl":"CHECK (\"pm\" BETWEEN 0 AND 1) NOT VALID"},
    {"table":"store_service_transfer","name":"sst_count_time_ck","type":"c","definition":"CHECK (((copied_message_count >= 0) AND (created_at >= 0)))","validated":true,"noInherit":false,"columns":["copied_message_count","created_at"],"ddl":"CHECK (\"copied_message_count\" >= 0 AND \"created_at\" >= 0)"},
    {"table":"store_service_transfer","name":"sst_distinct_kefu_ck","type":"c","definition":"CHECK ((from_kefu_uid <> to_kefu_uid))","validated":true,"noInherit":false,"columns":["from_kefu_uid","to_kefu_uid"],"ddl":"CHECK (\"from_kefu_uid\" <> \"to_kefu_uid\")"},
    {"table":"store_service_transfer","name":"sst_is_tourist_ck","type":"c","definition":"CHECK ((is_tourist = ANY (ARRAY[0, 1])))","validated":true,"noInherit":false,"columns":["is_tourist"],"ddl":"CHECK (\"is_tourist\" IN (0, 1))"},
    {"table":"store_service_transfer","name":"sst_positive_ids_ck","type":"c","definition":"CHECK (((customer_uid > 0) AND (from_kefu_uid > 0) AND (to_kefu_uid > 0) AND (from_service_id > 0) AND (to_service_id > 0) AND (source_record_id > 0) AND (target_record_id > 0)))","validated":true,"noInherit":false,"columns":["customer_uid","from_kefu_uid","to_kefu_uid","from_service_id","to_service_id","source_record_id","target_record_id"],"ddl":"CHECK (\n    \"customer_uid\" > 0 AND \"from_kefu_uid\" > 0 AND \"to_kefu_uid\" > 0\n    AND \"from_service_id\" > 0 AND \"to_service_id\" > 0\n    AND \"source_record_id\" > 0 AND \"target_record_id\" > 0\n  )"},
    {"table":"system_menus","name":"sm_auth_type_ck","type":"c","definition":"CHECK (((auth_type >= 0) AND (auth_type <= 2))) NOT VALID","validated":false,"noInherit":false,"columns":["auth_type"],"ddl":"CHECK (\"auth_type\" BETWEEN 0 AND 2) NOT VALID"},
    {"table":"system_menus","name":"sm_flags_ck","type":"c","definition":"CHECK ((((is_show >= 0) AND (is_show <= 1)) AND ((is_show_path >= 0) AND (is_show_path <= 1)) AND ((access >= 0) AND (access <= 1)) AND ((is_header >= 0) AND (is_header <= 1)) AND ((is_del >= 0) AND (is_del <= 1)))) NOT VALID","validated":false,"noInherit":false,"columns":["is_show","is_show_path","access","is_header","is_del"],"ddl":"CHECK (\n        \"is_show\" BETWEEN 0 AND 1 AND\n        \"is_show_path\" BETWEEN 0 AND 1 AND\n        \"access\" BETWEEN 0 AND 1 AND\n        \"is_header\" BETWEEN 0 AND 1 AND\n        \"is_del\" BETWEEN 0 AND 1\n      ) NOT VALID"},
    {"table":"system_menus","name":"sm_type_ck","type":"c","definition":"CHECK (((type >= 1) AND (type <= 4))) NOT VALID","validated":false,"noInherit":false,"columns":["type"],"ddl":"CHECK (\"type\" BETWEEN 1 AND 4) NOT VALID"},
    {"table":"system_queue_dead_letter","name":"sqdl_time_ck","type":"c","definition":"CHECK (((message_timestamp_ms >= 0) AND (first_seen_time >= 0) AND (last_seen_time >= 0) AND (replay_requested_time >= 0) AND (replayed_time >= 0) AND (resolved_time >= 0) AND (replay_lease_until >= 0)))","validated":true,"noInherit":false,"columns":["message_timestamp_ms","first_seen_time","last_seen_time","replay_requested_time","replayed_time","resolved_time","replay_lease_until"],"ddl":"CHECK (\n    \"message_timestamp_ms\" >= 0 AND \"first_seen_time\" >= 0\n      AND \"last_seen_time\" >= 0 AND \"replay_requested_time\" >= 0\n      AND \"replayed_time\" >= 0 AND \"resolved_time\" >= 0\n      AND \"replay_lease_until\" >= 0\n  )"},
    {"table":"work_callback_event","name":"wce_hashes_ck","type":"c","definition":"CHECK ((((event_key)::text ~ '^[0-9a-f]{64}$'::text) AND ((payload_hash)::text ~ '^[0-9a-f]{64}$'::text) AND ((subject_key_hash)::text ~ '^[0-9a-f]{64}$'::text)))","validated":true,"noInherit":false,"columns":["event_key","payload_hash","subject_key_hash"],"ddl":"CHECK (\n    event_key ~ '^[0-9a-f]{64}$'\n    AND payload_hash ~ '^[0-9a-f]{64}$'\n    AND subject_key_hash ~ '^[0-9a-f]{64}$'\n  )"},
    {"table":"work_callback_event","name":"wce_payload_object_ck","type":"c","definition":"CHECK ((jsonb_typeof(payload) = 'object'::text))","validated":true,"noInherit":false,"columns":["payload"],"ddl":"CHECK (jsonb_typeof(payload) = 'object')"},
    {"table":"work_callback_event","name":"wce_payload_retention_ck","type":"c","definition":"CHECK (((payload_retained_until >= received_time) AND (payload_redacted_time >= 0) AND ((payload_redacted_time = 0) OR (payload_redacted_time >= received_time))))","validated":true,"noInherit":false,"columns":["received_time","payload_retained_until","payload_redacted_time"],"ddl":"CHECK (\n        payload_retained_until >= received_time\n        AND payload_redacted_time >= 0\n        AND (payload_redacted_time = 0 OR payload_redacted_time >= received_time)\n      )"},
    {"table":"work_callback_event","name":"wce_projection_status_ck","type":"c","definition":"CHECK (((projection_status)::text = ANY ((ARRAY['PENDING'::character varying, 'PROCESSING'::character varying, 'REFRESH_REQUIRED'::character varying, 'APPLIED'::character varying, 'APPLIED_NOOP'::character varying, 'SUPERSEDED'::character varying, 'IGNORED'::character varying, 'FAILED'::character varying, 'DEAD'::character varying])::text[])))","validated":true,"noInherit":false,"columns":["projection_status"],"ddl":"CHECK (\n        \"projection_status\" IN (\n          'PENDING','PROCESSING','REFRESH_REQUIRED','APPLIED','APPLIED_NOOP',\n          'SUPERSEDED','IGNORED','FAILED','DEAD'\n        )\n      )"},
    {"table":"work_callback_event","name":"wce_status_ck","type":"c","definition":"CHECK (((status)::text = ANY ((ARRAY['RECEIVED'::character varying, 'PROCESSING'::character varying, 'ORDERED'::character varying, 'APPLIED'::character varying, 'APPLIED_NOOP'::character varying, 'SUPERSEDED'::character varying, 'IGNORED'::character varying, 'FAILED'::character varying, 'DEAD'::character varying])::text[])))","validated":true,"noInherit":false,"columns":["status"],"ddl":"CHECK (\n        \"status\" IN (\n          'RECEIVED','PROCESSING','ORDERED','APPLIED','APPLIED_NOOP',\n          'SUPERSEDED','IGNORED','FAILED','DEAD'\n        )\n      )"},
    {"table":"work_callback_event","name":"wce_time_ck","type":"c","definition":"CHECK (((event_time >= 0) AND (received_time >= 0) AND (processed_time >= 0) AND (update_time >= 0) AND (lease_until >= 0) AND (attempt_count >= 0)))","validated":true,"noInherit":false,"columns":["event_time","attempt_count","lease_until","received_time","processed_time","update_time"],"ddl":"CHECK (\n    event_time >= 0 AND received_time >= 0 AND processed_time >= 0\n    AND update_time >= 0 AND lease_until >= 0 AND attempt_count >= 0\n  )"},
    {"table":"work_callback_outbox","name":"wco_event_id_fk","type":"f","definition":"FOREIGN KEY (event_id) REFERENCES work_callback_event(id) ON DELETE CASCADE","validated":true,"noInherit":true,"columns":["event_id"],"reference":{"table":"work_callback_event","columns":["id"],"primaryKey":"work_callback_event_pkey","onDelete":"c","onUpdate":"a"}},
    {"table":"work_callback_outbox","name":"wco_event_key_ck","type":"c","definition":"CHECK (((event_key)::text ~ '^[0-9a-f]{64}$'::text))","validated":true,"noInherit":false,"columns":["event_key"],"ddl":"CHECK (event_key ~ '^[0-9a-f]{64}$')"},
    {"table":"work_callback_outbox","name":"wco_status_ck","type":"c","definition":"CHECK (((status)::text = ANY ((ARRAY['PENDING'::character varying, 'ENQUEUING'::character varying, 'ENQUEUED'::character varying, 'PROCESSING'::character varying, 'COMPLETED'::character varying, 'FAILED'::character varying, 'DEAD'::character varying])::text[])))","validated":true,"noInherit":false,"columns":["status"],"ddl":"CHECK (\n    status IN ('PENDING','ENQUEUING','ENQUEUED','PROCESSING','COMPLETED','FAILED','DEAD')\n  )"},
    {"table":"work_callback_outbox","name":"wco_time_ck","type":"c","definition":"CHECK (((dispatch_count >= 0) AND (attempt_count >= 0) AND (available_time >= 0) AND (lease_until >= 0) AND (enqueued_time >= 0) AND (processed_time >= 0) AND (add_time >= 0) AND (update_time >= 0)))","validated":true,"noInherit":false,"columns":["dispatch_count","attempt_count","available_time","lease_until","enqueued_time","processed_time","add_time","update_time"],"ddl":"CHECK (\n    dispatch_count >= 0 AND attempt_count >= 0 AND available_time >= 0\n    AND lease_until >= 0 AND enqueued_time >= 0 AND processed_time >= 0\n    AND add_time >= 0 AND update_time >= 0\n  )"},
    {"table":"work_callback_watermark","name":"wcw_hashes_ck","type":"c","definition":"CHECK ((((subject_key_hash)::text ~ '^[0-9a-f]{64}$'::text) AND ((event_key)::text ~ '^[0-9a-f]{64}$'::text)))","validated":true,"noInherit":false,"columns":["subject_key_hash","event_key"],"ddl":"CHECK (\n    subject_key_hash ~ '^[0-9a-f]{64}$' AND event_key ~ '^[0-9a-f]{64}$'\n  )"},
    {"table":"work_callback_watermark","name":"wcw_time_ck","type":"c","definition":"CHECK (((event_time >= 0) AND (update_time >= 0)))","validated":true,"noInherit":false,"columns":["event_time","update_time"],"ddl":"CHECK (event_time >= 0 AND update_time >= 0)"},
    {"table":"work_contact_action_audit","name":"wcaa_actor_reason_ck","type":"c","definition":"CHECK (((actor_id > 0) AND ((char_length(btrim((reason)::text)) >= 8) AND (char_length(btrim((reason)::text)) <= 500)) AND ((reason)::text !~ '[[:cntrl:]]'::text) AND (add_time >= 0)))","validated":true,"noInherit":false,"columns":["actor_id","reason","add_time"],"ddl":"CHECK (\n    actor_id > 0 AND char_length(btrim(reason)) BETWEEN 8 AND 500\n    AND reason !~ '[[:cntrl:]]' AND add_time >= 0\n  )"},
    {"table":"work_contact_action_audit","name":"wcaa_operation_ck","type":"c","definition":"CHECK (((operation)::text = ANY ((ARRAY['CONFIRM_SUCCEEDED'::character varying, 'RETRY_WITH_RISK'::character varying, 'CLOSE'::character varying])::text[])))","validated":true,"noInherit":false,"columns":["operation"],"ddl":"CHECK (\n    operation IN ('CONFIRM_SUCCEEDED','RETRY_WITH_RISK','CLOSE')\n  )"},
    {"table":"work_contact_action_audit","name":"wcaa_request_ck","type":"c","definition":"CHECK ((((request_key)::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'::text) AND ((request_hash)::text ~ '^[0-9a-f]{64}$'::text) AND ((provider_reference_hash IS NULL) OR ((provider_reference_hash)::text ~ '^[0-9a-f]{64}$'::text))))","validated":true,"noInherit":false,"columns":["request_key","request_hash","provider_reference_hash"],"ddl":"CHECK (\n    request_key ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'\n    AND request_hash ~ '^[0-9a-f]{64}$'\n    AND (provider_reference_hash IS NULL OR provider_reference_hash ~ '^[0-9a-f]{64}$')\n  )"},
    {"table":"work_contact_action_audit","name":"wcaa_risk_ck","type":"c","definition":"CHECK ((((operation)::text <> 'RETRY_WITH_RISK'::text) OR risk_accepted))","validated":true,"noInherit":false,"columns":["operation","risk_accepted"],"ddl":"CHECK (\n    operation <> 'RETRY_WITH_RISK' OR risk_accepted\n  )"},
    {"table":"work_contact_action_audit","name":"wcaa_status_ck","type":"c","definition":"CHECK ((((from_status)::text = ANY ((ARRAY['UNKNOWN'::character varying, 'DEAD'::character varying])::text[])) AND ((to_status)::text = ANY ((ARRAY['SUCCEEDED'::character varying, 'RETRYABLE'::character varying, 'CLOSED'::character varying])::text[]))))","validated":true,"noInherit":false,"columns":["from_status","to_status"],"ddl":"CHECK (\n    from_status IN ('UNKNOWN','DEAD')\n    AND to_status IN ('SUCCEEDED','RETRYABLE','CLOSED')\n  )"}
  ]
}
$constraint_data$::jsonb;
item record;
  target record;
  actual record;
  ref record;
  ref_key record;
  phase integer;
  target_oid oid;
  ref_oid oid;
  key_numbers smallint[];
  ref_numbers smallint[];
  original_search_path text := current_setting('search_path');
  table_name text;
BEGIN
  IF target_schema IS NULL THEN RAISE EXCEPTION '0142 target schema is missing'; END IF;
  PERFORM pg_catalog.set_config('lock_timeout', '2s', true);
  -- Resolve built-ins before user schemas and place pg_temp explicitly last.
  PERFORM pg_catalog.set_config('search_path',pg_catalog.format('pg_catalog,%I,pg_temp',target_schema),true);
  FOR table_name IN
    SELECT DISTINCT value->>'table' FROM pg_catalog.jsonb_array_elements(expected->'columns') ORDER BY 1
  LOOP
    SELECT c.oid INTO target_oid FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=target_schema AND c.relname=table_name AND c.relkind='r'
        AND c.relpersistence='p' AND NOT c.relispartition;
    IF target_oid IS NULL THEN RAISE EXCEPTION '0142 expected permanent ordinary table is missing: %',table_name; END IF;
    EXECUTE pg_catalog.format('LOCK TABLE ONLY %I.%I IN ACCESS EXCLUSIVE MODE',target_schema,table_name);
    IF pg_catalog.to_regclass(pg_catalog.format('%I.%I',target_schema,table_name))::oid IS DISTINCT FROM target_oid
      OR EXISTS(SELECT 1 FROM pg_catalog.pg_inherits WHERE inhrelid=target_oid OR inhparent=target_oid) THEN
      RAISE EXCEPTION '0142 table identity or inheritance drift: %',table_name;
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
      RAISE EXCEPTION '0142 column shape drift or missing: %.%',item."table",item.name;
    END IF;
  END LOOP;

  -- Preflight all 41 constraints before adding any. The second pass adds only
  -- missing names and immediately verifies the resulting PostgreSQL metadata.
  FOR phase IN 1..2 LOOP
    FOR target IN SELECT * FROM pg_catalog.jsonb_to_recordset(expected->'constraints')
      AS c("table" text,name text,type text,definition text,ddl text,validated boolean,"noInherit" boolean,columns text[],reference jsonb)
    LOOP
      target_oid := pg_catalog.to_regclass(pg_catalog.format('%I.%I',target_schema,target."table"));
      SELECT ARRAY(SELECT a.attnum FROM pg_catalog.pg_attribute a WHERE a.attrelid=target_oid
        AND a.attname=ANY(target.columns) AND NOT a.attisdropped ORDER BY a.attnum) INTO key_numbers;
      IF pg_catalog.cardinality(key_numbers)<>pg_catalog.cardinality(target.columns) THEN
        RAISE EXCEPTION '0142 constraint column set drift: %.%',target."table",target.name;
      END IF;
      IF target.type='f' THEN
        SELECT * INTO ref FROM pg_catalog.jsonb_to_record(target.reference)
          AS f("table" text,columns text[],"primaryKey" text,"onDelete" text,"onUpdate" text);
        ref_oid := pg_catalog.to_regclass(pg_catalog.format('%I.%I',target_schema,ref."table"));
        SELECT ARRAY(SELECT a.attnum FROM pg_catalog.pg_attribute a WHERE a.attrelid=ref_oid
          AND a.attname=ANY(ref.columns) AND NOT a.attisdropped ORDER BY a.attnum) INTO ref_numbers;
        SELECT c.oid,c.conindid INTO ref_key FROM pg_catalog.pg_constraint c
          JOIN pg_catalog.pg_index i ON i.indexrelid=c.conindid
          JOIN pg_catalog.pg_class idx ON idx.oid=i.indexrelid
          WHERE c.conrelid=ref_oid AND c.conname=ref."primaryKey" AND c.contype='p'
            AND c.convalidated AND NOT c.condeferrable AND NOT c.condeferred
            AND c.conislocal AND c.coninhcount=0 AND c.conparentid=0
            AND c.conkey=ref_numbers AND idx.relname=ref."primaryKey"
            AND i.indisprimary AND i.indisunique AND i.indimmediate AND i.indisvalid AND i.indisready AND i.indislive
            AND i.indnkeyatts=pg_catalog.cardinality(ref.columns) AND i.indnatts=i.indnkeyatts
            AND i.indpred IS NULL AND i.indexprs IS NULL;
        IF ref_key.oid IS NULL OR pg_catalog.cardinality(ref_numbers)<>pg_catalog.cardinality(ref.columns) THEN
          RAISE EXCEPTION '0142 referenced primary key drift: %',ref."table";
        END IF;
      END IF;
      SELECT c.* INTO actual FROM pg_catalog.pg_constraint c WHERE c.conrelid=target_oid AND c.conname=target.name;
      IF actual.oid IS NULL THEN
        IF EXISTS(SELECT 1 FROM pg_catalog.pg_constraint c WHERE c.conrelid=target_oid
          AND pg_catalog.pg_get_constraintdef(c.oid,false)=target.definition) THEN
          RAISE EXCEPTION '0142 equivalent constraint has an unreviewed name: %.%',target."table",target.name;
        END IF;
        IF phase=1 THEN CONTINUE; END IF;
        IF target.type='c' THEN
          EXECUTE pg_catalog.format('ALTER TABLE ONLY %I.%I ADD CONSTRAINT %I %s',target_schema,target."table",target.name,target.ddl);
        ELSIF target.type='f' THEN
          -- The reviewed cohort contains only these single-column PK references.
          IF pg_catalog.cardinality(target.columns)<>1 OR pg_catalog.cardinality(ref.columns)<>1 THEN
            RAISE EXCEPTION '0142 unreviewed composite reference';
          END IF;
          EXECUTE pg_catalog.format('ALTER TABLE ONLY %I.%I ADD CONSTRAINT %I FOREIGN KEY (%I) REFERENCES %I.%I (%I)%s%s',
            target_schema,target."table",target.name,target.columns[1],target_schema,ref."table",ref.columns[1],
            CASE WHEN ref."onDelete"='c' THEN ' ON DELETE CASCADE' ELSE '' END,
            CASE WHEN target.validated THEN '' ELSE ' NOT VALID' END);
        ELSE RAISE EXCEPTION '0142 unreviewed constraint kind'; END IF;
        SELECT c.* INTO actual FROM pg_catalog.pg_constraint c WHERE c.conrelid=target_oid AND c.conname=target.name;
      END IF;
      IF actual.oid IS NULL OR actual.contype::text IS DISTINCT FROM target.type
        OR pg_catalog.pg_get_constraintdef(actual.oid,false) IS DISTINCT FROM target.definition
        OR actual.convalidated IS DISTINCT FROM target.validated OR actual.condeferrable OR actual.condeferred
        OR actual.connoinherit IS DISTINCT FROM target."noInherit" OR NOT actual.conislocal OR actual.coninhcount<>0 OR actual.conparentid<>0
        -- CHECK conkey records expression-reference order, not table-column order.
        -- Compare its column set; retain ordered comparison for foreign keys.
        OR (CASE WHEN target.type='c' THEN ARRAY(SELECT n FROM pg_catalog.unnest(actual.conkey) n ORDER BY n)
          ELSE actual.conkey END) IS DISTINCT FROM key_numbers THEN
        RAISE EXCEPTION '0142 constraint definition or validation drift: %.%',target."table",target.name;
      END IF;
      -- A record must be assigned before PostgreSQL resolves its fields.
      IF target.type='f' THEN
      IF actual.confrelid IS DISTINCT FROM ref_oid OR actual.confkey IS DISTINCT FROM ref_numbers
        OR actual.conindid IS DISTINCT FROM ref_key.conindid OR actual.confmatchtype<>'s'
        OR actual.confupdtype::text IS DISTINCT FROM ref."onUpdate" OR actual.confdeltype::text IS DISTINCT FROM ref."onDelete"
        OR actual.confdelsetcols IS NOT NULL
        OR (SELECT count(*) FROM pg_catalog.pg_trigger t WHERE t.tgconstraint=actual.oid AND t.tgisinternal AND t.tgenabled='O')<>4 THEN
        RAISE EXCEPTION '0142 foreign key reference or trigger drift: %.%',target."table",target.name;
      END IF;
      END IF;
    END LOOP;
  END LOOP;
  PERFORM pg_catalog.set_config('search_path',original_search_path,true);
END
$missing_constraint_alignment$;
