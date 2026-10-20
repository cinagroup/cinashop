import {sql} from 'drizzle-orm';
import type {DbClient} from '@/lib/di';

/** Actual type0 checkout, member/guest delivery, upload, coupon, points and
 * original paid consumer capabilities. Metadata checks never repair grants. */
export const CASHIER_ORDINARY_SOURCE_READ_TABLES = [
 'user','user_address','user_level','user_relation','user_label','user_label_relation','user_group','category','user_bill','user_brokerage',
 'store_service','store_product','store_product_attr_value','store_product_relation','store_product_coupon',
 'store_cart','store_order','store_order_cart_info','store_order_status','store_order_outbox','store_order_economize','store_order_promotions',
 'store_order_purchase_origin','store_order_purchase_physical_origin','store_order_product_coupon_reward','store_order_promotion_gift_coupon_reward',
 'store_coupon_issue','store_coupon_user','store_coupon_product','store_coupon_issue_user','store_product_category','store_product_label','store_brand','store_promotions','store_promotions_auxiliary',
 'store_discounts','store_discounts_products','system_config','member_right','system_user_level','agent_level','agent_level_task','agent_level_task_record',
 'shipping_templates','shipping_templates_region','shipping_templates_free','shipping_templates_no_delivery','city_area','system_store',
 'system_store_staff','system_supplier','system_form','system_form_data','system_attachment','payment_reconciliation_case',
] as const;
export const CASHIER_ORDINARY_SOURCE_INSERT_TABLES = [
 'store_cart','store_order','store_order_cart_info','store_order_status','store_order_outbox','store_order_economize','store_order_promotions',
 'store_order_purchase_origin','store_order_purchase_physical_origin','store_order_product_coupon_reward','store_order_promotion_gift_coupon_reward','store_coupon_user','store_coupon_issue_user',
 'user_bill','user_brokerage','user_level','user_label_relation','agent_level_task_record','system_form_data',
] as const;
const fullUpdates = ['store_cart','store_order','store_order_cart_info','store_order_outbox','store_product','store_product_attr_value','user','user_level','store_coupon_user'] as const;
// The mature application profile already grants these exact lock columns.
// Brand-scoped coupons retain their mature id lock privilege. Taxonomies are
// SELECT-only and use the two fully audited NOLOGIN catalog-lock routines.
const columns = [['system_attachment','att_id'],['system_form','id'],['store_order_promotions','id'],['store_promotions_auxiliary','surplus_num'],['store_brand','id']] as const;
export const CASHIER_ORDINARY_SOURCE_FUNCTIONS=['public.checkout_lock_pricing_v1()','public.customer_work_lock_scope_v1(integer)','public.customer_product_lock_catalog_v1(text,integer[])','public.customer_user_lock_catalog_v1(text,integer[])'] as const;
export async function inspectCashierOrdinarySourceRights(db:Pick<DbClient,'execute'>){
 const required=[...CASHIER_ORDINARY_SOURCE_READ_TABLES.map(table=>({table,privilege:'SELECT'})),
  ...CASHIER_ORDINARY_SOURCE_INSERT_TABLES.map(table=>({table,privilege:'INSERT'})),...fullUpdates.map(table=>({table,privilege:'UPDATE'}))];
 const rows=await db.execute<{missing_tables:unknown;missing_columns:unknown;missing_sequences:unknown;missing_functions:unknown;ready:boolean}>(sql`
 WITH required AS(SELECT * FROM jsonb_to_recordset(${JSON.stringify(required)}::jsonb) AS x("table" text,privilege text)),
 source AS(SELECT r.*,c.oid,c.relkind,c.relrowsecurity,c.relforcerowsecurity FROM required r LEFT JOIN pg_catalog.pg_namespace n ON n.nspname='public'
  LEFT JOIN pg_catalog.pg_class c ON c.relnamespace=n.oid AND c.relname=r."table"),
 missing AS(SELECT "table",privilege FROM source WHERE oid IS NULL OR relkind<>'r' OR relrowsecurity OR relforcerowsecurity
  OR NOT pg_catalog.has_table_privilege(current_user,oid,privilege)),
 required_columns AS(SELECT * FROM jsonb_to_recordset(${JSON.stringify(columns.map(([table,column])=>({table,column})))}::jsonb) AS x("table" text,"column" text)),
 missing_columns AS(SELECT r.* FROM required_columns r LEFT JOIN pg_catalog.pg_namespace n ON n.nspname='public'
  LEFT JOIN pg_catalog.pg_class c ON c.relnamespace=n.oid AND c.relname=r."table"
  LEFT JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid AND a.attname=r."column" AND a.attnum>0 AND NOT a.attisdropped
  WHERE a.attnum IS NULL OR NOT pg_catalog.has_column_privilege(current_user,c.oid,a.attnum,'UPDATE')),
 insert_relations AS(SELECT * FROM source WHERE privilege='INSERT'),
 sequence_fields AS(SELECT c."table",a.attname,pg_catalog.pg_get_serial_sequence(pg_catalog.format('%I.%I','public',c."table"),a.attname)::regclass AS oid
  FROM insert_relations c JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
  LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum WHERE a.attidentity<>'' OR pg_catalog.pg_get_expr(d.adbin,d.adrelid) LIKE 'nextval(%'),
 missing_sequences AS(SELECT "table",attname FROM sequence_fields WHERE oid IS NULL OR NOT pg_catalog.has_sequence_privilege(current_user,oid,'USAGE')),
 required_functions AS(SELECT jsonb_array_elements_text(${JSON.stringify(CASHIER_ORDINARY_SOURCE_FUNCTIONS)}::jsonb) AS signature),
 missing_functions AS(SELECT signature FROM required_functions WHERE to_regprocedure(signature) IS NULL OR NOT pg_catalog.has_function_privilege(current_user,to_regprocedure(signature),'EXECUTE'))
 SELECT (SELECT COALESCE(jsonb_agg(to_jsonb(m)), '[]'::jsonb) FROM missing m) AS missing_tables,
  (SELECT COALESCE(jsonb_agg(to_jsonb(m)), '[]'::jsonb) FROM missing_columns m) AS missing_columns,
  (SELECT COALESCE(jsonb_agg(to_jsonb(m)), '[]'::jsonb) FROM missing_sequences m) AS missing_sequences,
  (SELECT COALESCE(jsonb_agg(to_jsonb(m)), '[]'::jsonb) FROM missing_functions m) AS missing_functions,
  NOT EXISTS(SELECT 1 FROM missing) AND NOT EXISTS(SELECT 1 FROM missing_columns) AND NOT EXISTS(SELECT 1 FROM missing_sequences) AND NOT EXISTS(SELECT 1 FROM missing_functions) AS ready`);
 return {ready:rows.length===1&&rows[0].ready===true,privileges:rows[0]??null};
}
