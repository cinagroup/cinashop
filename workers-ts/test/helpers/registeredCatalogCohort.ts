import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { sql } from 'drizzle-orm';
import type { DbClient } from '../../src/lib/di';
import { parseCreateTables } from '../../scripts/data-migration/schema-audit';
import { assertCustomerCityDeliveryReady, installCustomerCityDelivery } from '../../src/migrations/customerCityDelivery';

// Fixed independent 281-table SQL cohort through 0169, before the five reviewed
// additions. Never generate expected table names from the live ORM under test.
const legacyNames: readonly string[] = ["admin_refund_creation","admin_refund_operation","admin_user_write_replay","agent_level","agent_level_task","agent_level_task_record","agreement","article_category","article_content","cache","capital_flow","category","city_area","city_delivery_callback_event","city_delivery_callback_outbox","city_delivery_callback_watermark","city_delivery_reconciliation_case","community","community_comment","community_relevance","community_topic","community_user","data_migration_checkpoint","data_migration_run","delivery_service","division_apply","express_company","kefu_visitor_session","live_anchor","live_goods","live_room","live_room_goods","luck_lottery","luck_lottery_entitlement","luck_lottery_record","luck_prize","member_card","member_card_batch","member_right","member_ship","merchant_shipment_callback_event","merchant_shipment_callback_outbox","merchant_shipment_callback_watermark","notification_template","offline_order_admission","offline_order_balance","offline_order_callback_binding","offline_order_external_payment","offline_order_payment_dispatch","offline_order_payment_selection","offline_order_query_evidence","order_notification_delivery","order_notification_delivery_action","order_print_job","order_print_job_action","order_waybill_job","order_waybill_job_action","other_order","other_order_status","out_account","out_api_audit","out_coupon_write_replay","out_interface","out_product_write_replay","out_user_write_replay","page_category","page_link","payment_callback_event","payment_callback_outbox","payment_reconciliation_action","payment_reconciliation_case","print_document","promoter_apply","qrcode","queue_auxiliary","queue_list","shipping_template_create_replay","shipping_templates","shipping_templates_free","shipping_templates_no_delivery","shipping_templates_region","sms_record","store_activity","store_activity_relation","store_bargain","store_bargain_user","store_bargain_user_help","store_branch_product","store_branch_product_attr_value","store_brand","store_cart","store_combination","store_config","store_coupon_issue","store_coupon_issue_user","store_coupon_product","store_coupon_template","store_coupon_template_issue","store_coupon_user","store_delivery_order","store_discounts","store_discounts_products","store_extract","store_finance_flow","store_integral","store_integral_order","store_integral_order_status","store_newcomer","store_order","store_order_cart_info","store_order_economize","store_order_fulfillment_branch","store_order_invoice","store_order_invoice_allocation","store_order_invoice_evidence","store_order_outbox","store_order_product_coupon_reward","store_order_promotions","store_order_purchase_cancellation","store_order_purchase_origin","store_order_refund","store_order_refund_payment","store_order_refund_split","store_order_status","store_order_writeoff","store_pink","store_product","store_product_attr","store_product_attr_result","store_product_attr_value","store_product_cate","store_product_category","store_product_category_brand","store_product_coupon","store_product_description","store_product_ensure","store_product_label","store_product_label_auxiliary","store_product_log","store_product_relation","store_product_reply","store_product_reply_comment","store_product_rule","store_product_sku_retirement_log","store_product_specs","store_product_stock_record","store_product_unit","store_product_virtual","store_product_words","store_promotions","store_promotions_auxiliary","store_seckill","store_seckill_time","store_service","store_service_feedback","store_service_log","store_service_record","store_service_speechcraft","store_service_transfer","store_user","store_visit","supplier_extract","supplier_flowing_water","supplier_ticket_print","supplier_transactions","system_admin","system_article","system_attachment","system_attachment_category","system_city","system_config","system_config_tab","system_dise","system_file","system_form","system_form_data","system_group","system_group_data","system_log","system_menus","system_message","system_notice","system_notice_admin","system_notification","system_queue_dead_letter","system_role","system_sign_reward","system_storage","system_store","system_store_staff","system_supplier","system_timer","system_user_apply","system_user_level","system_virtual_inventory_export","user","user_address","user_bill","user_brokerage","user_brokerage_frozen","user_card","user_enter","user_extract","user_friends","user_group","user_invoice","user_label","user_label_relation","user_level","user_message","user_money","user_notice","user_notice_see","user_recharge","user_relation","user_search","user_sign","user_spread","user_visit","video","video_comment","wechat_callback_event","wechat_callback_outbox","wechat_callback_watermark","wechat_card","wechat_key","wechat_media","wechat_message","wechat_news_category","wechat_qrcode","wechat_qrcode_cate","wechat_qrcode_record","wechat_reply","wechat_user","work_callback_event","work_callback_outbox","work_callback_watermark","work_channel_code","work_channel_cycle","work_channel_limit","work_client","work_client_current","work_client_follow","work_client_follow_current","work_client_follow_projection_fence","work_client_follow_tag_current","work_client_follow_tags","work_client_projection_fence","work_contact_action_audit","work_contact_action_outbox","work_department","work_department_current","work_department_leader_current","work_department_projection_fence","work_external_tag_current","work_external_tag_group_current","work_external_tag_projection_fence","work_group_chat","work_group_chat_auth","work_group_chat_current","work_group_chat_member","work_group_chat_member_current","work_group_chat_projection_fence","work_group_chat_statistic","work_group_msg_relation","work_group_msg_send_result","work_group_msg_task","work_group_template","work_label","work_media","work_member","work_member_current","work_member_identity_alias","work_member_other","work_member_other_current","work_member_relation","work_member_relation_current","work_moment","work_moment_send_result","work_welcome","work_welcome_relation"];
const additions = {
  "store_order_promotion_gift_coupon_reward": {
    "file": "0170_order_promotion_gift_receipt.sql",
    "sourceSha256": "db9c4c75894a51993bacd4f4c4289481379ea4a8e569c92c1e02df1578e8f7d7",
    "columns": [
      "id",
      "order_id",
      "uid",
      "root_id",
      "tier_id",
      "auxiliary_id",
      "issue_coupon_id",
      "coupon_user_id",
      "add_time"
    ]
  },
  "customer_city_delivery_attempt": {
    "file": "0173_customer_city_delivery.sql",
    "sourceSha256": "ad046ccad234e87fdcaeedf1840c9cb74f3cbcbfde5991fe53ac799fdee02484",
    "columns": [
      "id",
      "job_id",
      "request_key",
      "phase",
      "quote",
      "result",
      "error_code",
      "started_time",
      "issued_time",
      "update_time"
    ]
  },
  "customer_city_delivery_binding": {
    "file": "0173_customer_city_delivery.sql",
    "sourceSha256": "ad046ccad234e87fdcaeedf1840c9cb74f3cbcbfde5991fe53ac799fdee02484",
    "columns": [
      "job_id",
      "attempt_id",
      "delivery_order_id",
      "order_id",
      "root_order_id",
      "customer_uid",
      "store_id",
      "supplier_id",
      "provider",
      "provider_order_id",
      "active",
      "add_time",
      "update_time"
    ]
  },
  "customer_city_delivery_job": {
    "file": "0173_customer_city_delivery.sql",
    "sourceSha256": "ad046ccad234e87fdcaeedf1840c9cb74f3cbcbfde5991fe53ac799fdee02484",
    "columns": [
      "id",
      "actor_uid",
      "service_id",
      "actor_auth_version",
      "actor_expires_at",
      "scope_key",
      "request_key",
      "request_hash",
      "intent_hash",
      "requested_order_id",
      "root_order_id",
      "order_id",
      "customer_uid",
      "store_id",
      "supplier_id",
      "provider",
      "provider_order_id",
      "intent",
      "status",
      "lease_token",
      "lease_until",
      "last_error_code",
      "add_time",
      "update_time"
    ]
  }
} as const;
export const REVIEWED_TABLE_ADDITIONS = Object.keys(additions).sort();
// These are independently installed ledgers, not MigrationService.runAll registrations.
// The schema-audit declaration scan includes every migration source; bind that
// exact reviewed difference without pretending these tables exist after runAll.
const explicitDeclarations = [
  ['cashierSecondCardOrigin.ts','e4a29d5080a0ac40154fb6f80d101fcdd5443c2e797e141f4649f398086318b4', ['cashier_second_card_cart_v1','cashier_second_card_origin_v1','cashier_second_card_payment_v1']],
  ['customerFinancialOperation.ts','11a5094042f0bbbff55afa76cb5312e3b132e1a61095dc193f1b4471f181479b',['customer_financial_operation_request']],
  ['customerProductOperation.ts','2a0111dd62350e205c848356b4b793eed61dc24d928f2a030314426d3bb3379b',['customer_product_operation_request']],
  ['customerUserOperation.ts','9d36e731df3e70ba440740b27850afe311440158f2a03ad66f5380c74e435e4d',['customer_user_operation_request']],
  ['customerWorkOperation.ts','bf5153b56e3095edd28f04695907e934bcfa91283802162ee10dcbd10b2c5626',['customer_work_operation_request']],
  ['customerWriteoffOperation.ts','044d8aa876e686e3e8b238b8cb4233240082f293060fc426ef00b7c5b1d952f0',['customer_writeoff_operation_request']],
  ['deliveryOrderOperation.ts','bb9cae7789a0efde6dd4d9fb6eb62ea4dc369d9d517b21e05e309af95d7328e3',['delivery_order_operation_request']],
  ['managerOrderOperation.ts','a119df84da27f34310094b1441ea3411408dc490beb02763cb309e4853f39ce8',['manager_order_operation_request']],
  ['newcomerCartAddReplay.ts','7406be369eca4574f46dfbc126b2a44e4aed0b28cd948a7af573648c77bdeade',['newcomer_cart_add_replay']],
] as const;
export function reviewedExplicitDeclarationTables() {
  for (const [file,sha256,tables] of explicitDeclarations) {
    const source=readFileSync(resolve(root,'src/migrations',file),'utf8').replace(/\r\n/g,'\n');
    assert.equal(digest(source),sha256,'Complete independently commissioned DDL source changed: '+file);
    assert.deepEqual([...parseCreateTables(source,'postgres').keys()].sort(),[...tables].sort());
  }
  const tables=explicitDeclarations.flatMap(([, , tables])=>[...tables]).sort();
  assert.equal(tables.length,11);assert.equal(new Set(tables).size,11);
  return tables;
}
const externalNames = [...legacyNames,...REVIEWED_TABLE_ADDITIONS].sort();
const embeddedNames = [...legacyNames,'store_order_promotion_gift_coupon_reward'].sort();
const root=resolve(import.meta.dirname,'../..');
const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
export function assertHistoricalCatalogBasis() {
  assert.equal(legacyNames.length,281);
  assert.equal(digest(JSON.stringify(legacyNames)), 'fa9a4f6d3377f150be99c8483b1f12c2b5ea5df8a152e2d3d0caca85df651fde');
  const files=readdirSync(resolve(root,'migrations')).filter(name=>/^\d+.*\.sql$/.test(name)&&name<='0169_coupon_template_catalog.sql'
    &&!['0166_recharge_quota_group_seed.sql','0167_seckill_time_reference_lock.sql'].includes(name)).sort();
  assert.equal(files.length,171);
  const source=files.map(file=>readFileSync(resolve(root,'migrations',file),'utf8')).join('\n');
  assert.deepEqual([...parseCreateTables(source,'postgres').keys()].sort(),legacyNames);
  for(const [table,contract] of Object.entries(additions)) {
    const source=readFileSync(resolve(root,'migrations',contract.file),'utf8').replace(/\r\n/g,'\n');
    assert.equal(digest(source),contract.sourceSha256,'Complete reviewed source changed: '+table);
    assert.deepEqual([...parseCreateTables(source,'postgres').get(table)!.columns.keys()],contract.columns);
  }
}
export function registeredTableNames(path:'external'|'embedded'|'orm') {
  assertHistoricalCatalogBasis(); return path==='embedded'?embeddedNames:externalNames;
}
export function assertRegisteredModelCohort(snapshot:{tables:Record<string,{columns?:Record<string,unknown>}>}) {
  assert.deepEqual(Object.keys(snapshot.tables).sort(),registeredTableNames('orm').map(name=>'public.'+name));
  for(const [table,contract] of Object.entries(additions))
    assert.deepEqual(Object.keys(snapshot.tables['public.'+table].columns??{}),contract.columns);
}
export async function assertRegisteredDatabaseCohort(db:Pick<DbClient,'execute'>,path:'external'|'embedded'|'orm') {
  const rows=await db.execute(sql`SELECT relname AS name FROM pg_catalog.pg_class
    WHERE relnamespace='public'::regnamespace AND relkind IN ('r','p') ORDER BY relname`);
  assert.deepEqual(rows.map(row=>row.name),registeredTableNames(path));
}
export function assertExternalMigrationCohort(files:string[]) {
  assert.equal(files.length,176);
  assert.equal(digest(JSON.stringify(files)),"75756c037d53d9d690b2daaba89973458ea40c1277440b632dd815b40cef6cb0");
  assert.deepEqual(files.filter(file=>!file.startsWith('0006a')&&!/^\d{4}_/.test(file)),[]);
  for(const file of ['0166_recharge_quota_group_seed.sql','0167_seckill_time_reference_lock.sql',
    '0170_order_promotion_gift_receipt.sql','0171_purchase_cancellation_gift_evidence.sql','0173_customer_city_delivery.sql'])
    assert.equal(files.filter(value=>value===file).length,1);
}
// Explicit fixture composition mirrors the approved full nine-path audit.
// Embedded runAll remains 282 tables; it never implicitly installs city tables.
export async function composeExplicitCityCatalog(db:DbClient,path:'external'|'embedded') {
  await assertRegisteredDatabaseCohort(db,path);
  const before=await db.execute(sql`SELECT 'relation' AS kind,oid::text,relfilenode::text,relowner::text,relacl::text AS acl
    FROM pg_class WHERE relnamespace='public'::regnamespace UNION ALL
    SELECT 'function',oid::text,NULL,proowner::text,proacl::text FROM pg_proc WHERE pronamespace='public'::regnamespace
    ORDER BY kind,oid`);
  if(path==='embedded')await installCustomerCityDelivery(db,{maintenance:true});
  await assertCustomerCityDeliveryReady(db,false);
  const after=await db.execute(sql`SELECT 'relation' AS kind,oid::text,relfilenode::text,relowner::text,relacl::text AS acl
    FROM pg_class WHERE relnamespace='public'::regnamespace UNION ALL
    SELECT 'function',oid::text,NULL,proowner::text,proacl::text FROM pg_proc WHERE pronamespace='public'::regnamespace
    ORDER BY kind,oid`);
  assert.deepEqual(after.filter(row=>before.some(old=>old.kind===row.kind&&old.oid===row.oid)),Array.from(before));
  await assertRegisteredDatabaseCohort(db,'external');
  await assert.rejects(installCustomerCityDelivery(db,{maintenance:true}));
  await assertCustomerCityDeliveryReady(db,false);
  const repeat=await db.execute(sql`SELECT 'relation' AS kind,oid::text,relfilenode::text,relowner::text,relacl::text AS acl
    FROM pg_class WHERE relnamespace='public'::regnamespace UNION ALL
    SELECT 'function',oid::text,NULL,proowner::text,proacl::text FROM pg_proc WHERE pronamespace='public'::regnamespace
    ORDER BY kind,oid`);
  assert.deepEqual(Array.from(repeat),Array.from(after));
}
