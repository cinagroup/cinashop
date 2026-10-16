import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { sql } from 'drizzle-orm';
import type { DbClient } from '../../src/lib/di';
import { parseCreateTables } from '../../scripts/data-migration/schema-audit';
import { assertCustomerCityDeliveryReady, installCustomerCityDelivery } from '../../src/migrations/customerCityDelivery';
import { composeReviewedCashierAbandonCatalog, assertCashierAuditManualRedNoteCatalog } from '../../scripts/data-migration/cashier-abandon-catalog';
import { completeConstructionTableNames, MANUAL_RED_NOTE_ORM_TABLE_NAMES, ERP_ORM_TABLE_NAMES } from './completeConstructionInventory';
import { inspectInvoiceManualRedNote } from '../../src/migrations/invoiceManualRedNoteCatalog';

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
// The append-only abandonment ledger is an explicit external registration;
// runAll and the ORM retain their independently frozen table cohorts.
const externalAdditions = {
  cashier_second_card_abandon_v1: {
    file: '0174_customer_cashier_abandon.sql',
    sourceSha256: '49bc46205953c28e482f76d3e62d044bf719b98466077f22401a69ed375c8899',
    columns: ['actor_uid','request_key','kind','request_hash','scope_key','intent','intent_json','created_at'],
  },
} as const;
// These are independently installed ledgers, not MigrationService.runAll registrations.
// The schema-audit declaration scan includes every migration source; bind that
// exact reviewed difference without pretending these tables exist after runAll.
const explicitDeclarations = [
  ['adminAuthorityOperation.ts','9111696cce90a9a16ddbebec2c7d0dab84d206c2323dd10b7fce969fe4603731',['admin_authority_operation']],
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
const additionalExplicitDeclarations = [
  ['cashierSecondCardAbandon.ts','e91f303bc1786c4eb32da38932eb2b1485aaa3e5ccd63696b570f5ccab856c0c',['cashier_second_card_abandon_v1']],
  ['cashierSecondCardFormImages.ts','a22e5de1110223b6943726f8d59da9c5ae8ddc2fc46659fcd416e8db3b8c77fb',['cashier_second_card_form_session_v1','cashier_second_card_form_upload_v1']],
  ['customerManualRefund.ts','bb7781fd1b070144610ebe7860a594acabaaa31d9d299ac5abc0c8d55cc86c67',['customer_financial_manual_refund_v1']],
] as const;
const manualRedNoteSourceSha256 = 'be8460ba4e331d6db2b23e301a73d31ae787f638e516a1298f2c01a3f8cd8418';
const manualRedNoteColumns = {
  store_order_invoice_manual_red_note: ['id','invoice_id','source_order_id','payment_order_id','uid','actor_id','request_hash','record_hash','record_json','created_time'],
  store_order_invoice_manual_red_review: ['id','record_id','invoice_id','source_order_id','payment_order_id','uid','actor_id','decision','original_document_number','red_document_number','request_hash','record_hash','review_hash','review_json','created_time'],
} as const;
const manualRedNoteExplicitDeclarations = [
  ['invoiceManualRedNote.ts',manualRedNoteSourceSha256,['store_order_invoice_manual_red_note','store_order_invoice_manual_red_review']],
] as const;
// Independently reviewed main ERP model and offline DDL; neither is runAll SQL.
const erpColumns = {"erp_auth_state":["state_hash","connection_id","connection_revision","capability_version","app_key","credential_fingerprint","actor_id","actor_auth_version","actor_expires_at","required_permission","created_at","expires_at","state","code_hash","exchange_lease_hash","lease_expires_at","consumed_at","error_code"],"erp_connection":["id","provider","name","state","revision","app_key","credential_fingerprint","capability_hash","capability_version","rotated_at","bindings","scope_revision","shop_observation_hash","created_by","updated_by","created_at","updated_at","revoked_at","revoke_reason"],"erp_credential":["connection_id","version","app_key","credential_fingerprint","access_token_sealed","refresh_token_sealed","issued_at","expires_at","refresh_after","auth_state_hash","shop_observation_hash","refresh_lease_hash","refresh_lease_expires_at","updated_at","state","error_code"],"erp_operation":["id","connection_id","kind","business_key","provider_event_id","request_hash","source_ts","received_at","connection_revision","capability_version","scope_revision","credential_version","state","lease_hash","lease_expires_at","attempt_count","scope","observation_hash","observed_at","provider_facts","business_result","payment_admission_id","error_code","created_at","updated_at","completed_at"]} as const;
function assertErpSourceBasis() {
  const model=readFileSync(resolve(root,'src/models/erp.ts'),'utf8').replace(/\r\n/g,'\n');
  const ddl=readFileSync(resolve(root,'src/migrations/maintenance/0181_erp_connection_lifecycle.sql'),'utf8').replace(/\r\n/g,'\n');
  assert.equal(digest(model),'553cde9f8091b14c5ffcd2046e20654466844a4837d341a79de2dba4860a22ec','Complete reviewed ERP model changed');
  assert.equal(digest(ddl),'52bd7739a29c966a07b358c240f43898b4c51b21861d27152b1cf8573b433f64','Complete reviewed ERP maintenance DDL changed');
  const parsed=parseCreateTables(ddl,'postgres');
  assert.deepEqual([...parsed.keys()].sort(),[...ERP_ORM_TABLE_NAMES]);
  assert.deepEqual(Object.keys(erpColumns).sort(),[...ERP_ORM_TABLE_NAMES]);
  for(const [table,columns] of Object.entries(erpColumns))
    assert.deepEqual([...parsed.get(table)!.columns.keys()],columns);
}
const ordinaryExplicitDeclarations = [
  ['cashierOrdinary.ts','5da40f39afd13ea03f43865ed5e88d3e7af6a448d0c7042ce9e47091c67d8d79',
    ['cashier_ordinary_cart_v1','cashier_ordinary_draft_v1','cashier_ordinary_operation_v1','cashier_ordinary_origin_v1']],
] as const;
const ordinaryExplicitColumns = {
  cashier_ordinary_cart_v1: ['cart_id','actor_uid','draft_key','product_id','sku_unique','created_quantity','source_json','source_hash','created_at'],
  cashier_ordinary_draft_v1: ['actor_uid','draft_key','buyer_uid','tourist_hash','scope_key','request_hash','intent_json','created_at'],
  cashier_ordinary_operation_v1: ['actor_uid','request_key','kind','request_hash','scope_key','draft_key','order_id','intent_json','evidence_json','evidence_hash','created_at'],
  cashier_ordinary_origin_v1: ['order_id','actor_uid','service_id','buyer_uid','request_key','request_hash','scope_key','origin_json','origin_hash','created_at'],
} as const;
// Product receipts and durable video sessions are independently commissioned
// addons. Declaration scans see them; runAll, root SQL and the ORM do not.
const productExplicitDeclarations = [
  ['supplierProductCopyOperation.ts','6d0340ae87e87d14d3d93bfba248abdbdecf0111c39bb415ba962a22c6275011',['supplier_product_copy_operation_v1']],
  ['adminProductEditorOperation.ts','8c41bd13efce59c6a604d92bb4824374df72e656d3a24d9fdbd38b57175e0fc1',['admin_product_editor_operation_v1']],
  ['adminProductVideoUpload.ts','08e82e9bbd7ca61d9ef210b08eb9a585f7e3f9f294824f7bde6751204cf75fa2',['admin_product_video_upload_v1']],
  ['supplierProductVideoUpload.ts','fccded58af2a05339109bdf06ef87bb40732e6793f0f8b742378a18697a4ae26',['supplier_product_video_upload_v1']],
  ['productVideoGc.ts','fa49727fde6cd174870bcdd816cb3a7472efd8373b2f19c526200946a7d565be',['product_video_gc_state_v1']],
] as const;
const productExplicitColumns = {
  supplier_product_copy_operation_v1: ['operation_id','actor_id','supplier_id','source_id','request_hash','state','result','created_at'],
  admin_product_editor_operation_v1: ['operation_id','actor_id','requested_id','request_hash','state','result','created_at'],
  admin_product_video_upload_v1: ['upload_id','actor_id','request_hash','intent','object_key','state','parts','confirmed','attachment_id','created_at','updated_at','expires_at'],
  product_video_gc_state_v1: ['scope','cursor','maximum','cycle','lease_token','lease_until','last_completed_at','updated_at'],
  supplier_product_video_upload_v1: ['upload_id','actor_id','supplier_id','request_hash','intent','object_key','state','parts','confirmed','attachment_id','created_at','updated_at','expires_at'],
} as const;
const supplierOrderExplicitDeclarations = [
  ['supplierOrderEditOperation.ts','a886f493c24d96496ad6abd4b505af5fc5f226394b3f7ac452811d3241483d00',['supplier_order_edit_operation_v1']],
  ['legacyOrderGainPartition.ts','04713d214c6a2b281a3f4b4545f8da0e23da5448c1a6698e5d3387d02affe79b',['legacy_order_gain_partition_v1']],
] as const;
const supplierOrderExplicitColumns = {
  supplier_order_edit_operation_v1: ['operation_id','actor_id','supplier_id','order_id','request_hash','state','before_hash','after_hash','evidence','result','created_at'],
  legacy_order_gain_partition_v1: ['partition_id','operation_id','source_order_id','child_order_id','buyer_id','supplier_id','kind','source_hash','child_hash','evidence','created_at'],
} as const;
export function reviewedExplicitDeclarationTables(scope:'historical'|'current-ordinary'|'current-product'|'current-supplier-order'='historical') {
  assert.ok(['historical','current-ordinary','current-product','current-supplier-order'].includes(scope),'Unknown independently commissioned declaration scope');
  for (const [file,sha256,tables] of [...explicitDeclarations,...additionalExplicitDeclarations,...manualRedNoteExplicitDeclarations]) {
    const source=readFileSync(resolve(root,'src/migrations',file),'utf8').replace(/\r\n/g,'\n');
    assert.equal(digest(source),sha256,'Complete independently commissioned DDL source changed: '+file);
    assert.deepEqual([...parseCreateTables(source,'postgres').keys()].sort(),[...tables].sort());
  }
  const historicalTables=explicitDeclarations.flatMap(([, , tables])=>[...tables]).sort();
  assert.equal(historicalTables.length,12);assert.equal(new Set(historicalTables).size,12);
  const previousTables=[...historicalTables,...additionalExplicitDeclarations.flatMap(([, , names])=>[...names])].sort();
  assert.equal(previousTables.length,16);assert.equal(new Set(previousTables).size,16);
  const tables: string[]=[...previousTables,...manualRedNoteExplicitDeclarations.flatMap(([, , names])=>[...names])].sort();
  assert.equal(tables.length,18);assert.equal(new Set(tables).size,18);
  // This fixed external registration is present on both declaration sides.
  const historicalOnly=tables.filter(name=>!Object.hasOwn(externalAdditions,name));
  assert.equal(historicalOnly.length,17);assert.equal(new Set(historicalOnly).size,17);
  if(scope==='historical')return historicalOnly;
  for(const [file,sha256,names] of ordinaryExplicitDeclarations){
    const source=readFileSync(resolve(root,'src/migrations',file),'utf8').replace(/\r\n/g,'\n'),parsed=parseCreateTables(source,'postgres');
    assert.equal(digest(source),sha256,'Complete independently commissioned ordinary DDL source changed: '+file);
    assert.deepEqual([...parsed.keys()].sort(),[...names].sort());
    assert.deepEqual(Object.keys(ordinaryExplicitColumns).sort(),[...names].sort());
    for(const name of names)assert.deepEqual([...parsed.get(name)!.columns.keys()],[...ordinaryExplicitColumns[name]]);
  }
  const ordinaryTables=ordinaryExplicitDeclarations.flatMap(([, , names])=>[...names]).sort();
  assert.equal(ordinaryTables.length,4);assert.equal(new Set(ordinaryTables).size,4);
  for(const name of ordinaryTables)assert.ok(!tables.includes(name),'Ordinary declaration must not replace a historical declaration');
  const currentTables=[...tables,...ordinaryTables].sort();
  assert.equal(currentTables.length,22);assert.equal(new Set(currentTables).size,22);
  const currentOnly=currentTables.filter(name=>!Object.hasOwn(externalAdditions,name));
  assert.equal(currentOnly.length,21);assert.equal(new Set(currentOnly).size,21);
  if(scope==='current-ordinary')return currentOnly;
  for(const [file,sha256,names] of productExplicitDeclarations){
    const source=readFileSync(resolve(root,'src/migrations',file),'utf8').replace(/\r\n/g,'\n'),parsed=parseCreateTables(source,'postgres');
    assert.equal(digest(source),sha256,'Complete independently commissioned product DDL source changed: '+file);
    assert.deepEqual([...parsed.keys()].sort(),[...names].sort());
    for(const name of names)assert.deepEqual([...parsed.get(name)!.columns.keys()],[...productExplicitColumns[name]]);
  }
  const productTables=productExplicitDeclarations.flatMap(([, , names])=>[...names]).sort();
  assert.equal(productTables.length,5);assert.equal(new Set(productTables).size,5);
  assert.deepEqual(Object.keys(productExplicitColumns).sort(),productTables);
  for(const name of productTables)assert.ok(!currentTables.includes(name),'Product declaration must not replace a historical or ordinary declaration');
  const productCurrentTables=[...currentTables,...productTables].sort();
  assert.equal(productCurrentTables.length,27);assert.equal(new Set(productCurrentTables).size,27);
  const productCurrentOnly=productCurrentTables.filter(name=>!Object.hasOwn(externalAdditions,name));
  assert.equal(productCurrentOnly.length,26);assert.equal(new Set(productCurrentOnly).size,26);
  if(scope==='current-product')return productCurrentOnly;
  for(const [file,sha256,names] of supplierOrderExplicitDeclarations){
    const source=readFileSync(resolve(root,'src/migrations',file),'utf8').replace(/\r\n/g,'\n'),parsed=parseCreateTables(source,'postgres');
    assert.equal(digest(source),sha256,'Complete independently commissioned Supplier order DDL source changed: '+file);
    assert.deepEqual([...parsed.keys()].sort(),[...names].sort());
    for(const name of names)assert.deepEqual([...parsed.get(name)!.columns.keys()],[...supplierOrderExplicitColumns[name]]);
  }
  const orderTables=supplierOrderExplicitDeclarations.flatMap(([, , names])=>[...names]).sort();
  assert.equal(orderTables.length,2);assert.equal(new Set(orderTables).size,2);
  assert.deepEqual(Object.keys(supplierOrderExplicitColumns).sort(),orderTables);
  for(const name of orderTables)assert.ok(!productCurrentTables.includes(name),'Order declaration must not replace an existing declaration');
  const orderCurrentTables=[...productCurrentTables,...orderTables].sort();
  assert.equal(orderCurrentTables.length,29);assert.equal(new Set(orderCurrentTables).size,29);
  const orderCurrentOnly=orderCurrentTables.filter(name=>!Object.hasOwn(externalAdditions,name));
  assert.equal(orderCurrentOnly.length,28);assert.equal(new Set(orderCurrentOnly).size,28);
  return orderCurrentOnly;
}
const ormNames = [...legacyNames,...REVIEWED_TABLE_ADDITIONS].sort();
const externalNames = [...ormNames,...Object.keys(externalAdditions)].sort();
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
  for(const [table,contract] of Object.entries({...additions,...externalAdditions})) {
    const source=readFileSync(resolve(root,'migrations',contract.file),'utf8').replace(/\r\n/g,'\n');
    assert.equal(digest(source),contract.sourceSha256,'Complete reviewed source changed: '+table);
    assert.deepEqual([...parseCreateTables(source,'postgres').get(table)!.columns.keys()],contract.columns);
  }
}
type RegisteredCatalogScope = 'historical'|'current-bare-orm';
function assertManualRedNoteSourceBasis() {
  const source=readFileSync(resolve(root,'src/migrations/invoiceManualRedNote.ts'),'utf8').replace(/\r\n/g,'\n');
  assert.equal(digest(source),manualRedNoteSourceSha256,'Complete reviewed manual red-note source changed');
  const parsed=parseCreateTables(source,'postgres');
  assert.deepEqual([...parsed.keys()].sort(),[...MANUAL_RED_NOTE_ORM_TABLE_NAMES]);
  assert.deepEqual(Object.keys(manualRedNoteColumns).sort(),[...MANUAL_RED_NOTE_ORM_TABLE_NAMES]);
  for(const [table,columns] of Object.entries(manualRedNoteColumns))
    assert.deepEqual([...parsed.get(table)!.columns.keys()],columns);
}
export function registeredTableNames(path:'external'|'embedded'|'orm',scope:RegisteredCatalogScope=path==='orm'?'current-bare-orm':'historical') {
  assertHistoricalCatalogBasis();
  const historical=path==='embedded'?embeddedNames:path==='external'?externalNames:ormNames;
  if(scope==='historical')return historical;
  assert.equal(path,'orm','Only actual ORM construction may include the bare manual red-note realm');
  assertManualRedNoteSourceBasis(); assertErpSourceBasis();
  const current=[...historical,...MANUAL_RED_NOTE_ORM_TABLE_NAMES,...ERP_ORM_TABLE_NAMES].sort();
  assert.deepEqual(current,completeConstructionTableNames('orm'),'Current ORM must be the independent historical 285 plus exactly the two reviewed manual and four ERP bare tables');
  return current;
}
export function assertRegisteredModelCohort(snapshot:{tables:Record<string,{columns?:Record<string,unknown>}>}) {
  assert.deepEqual(Object.keys(snapshot.tables).sort(),registeredTableNames('orm').map(name=>'public.'+name));
  for(const [table,contract] of Object.entries(additions))
    assert.deepEqual(Object.keys(snapshot.tables['public.'+table].columns??{}),contract.columns);
  for(const [table,columns] of Object.entries({...manualRedNoteColumns,...erpColumns}))
    assert.deepEqual(Object.keys(snapshot.tables['public.'+table].columns??{}),columns);
}
export async function assertRegisteredDatabaseCohort(db:Pick<DbClient,'execute'>,path:'external'|'embedded'|'orm',scope:RegisteredCatalogScope=path==='orm'?'current-bare-orm':'historical') {
  const rows=await db.execute(sql`SELECT relname AS name FROM pg_catalog.pg_class
    WHERE relnamespace='public'::regnamespace AND relkind IN ('r','p') ORDER BY relname`);
  assert.deepEqual(rows.map(row=>row.name),registeredTableNames(path,scope));
  const manual=await inspectInvoiceManualRedNote(db);
  assertCashierAuditManualRedNoteCatalog(manual.rows,scope==='current-bare-orm'?'orm':path==='orm'?'embedded':path);
}
export function assertExternalMigrationCohort(files:string[]) {
  assert.equal(files.length,181);
  assert.equal(digest(JSON.stringify(files)),"c05f257ea765a374894d35542df54a709cdea7935529178f2f139d8562e0cb07");
  // These two registered CHECK successors add no table. Preserve every older
  // directory cohort rather than accepting an arbitrary pair of new files.
  const saveFile='0178_product_save_effects.sql';
  const saveSource=readFileSync(resolve(root,'migrations',saveFile),'utf8').replace(/\r\n?/g,'\n');
  assert.equal(digest(saveSource),'0fcf472e56130811dfdd7812aa718cd4e131cbc010e21d792f9c9e8b442f4319');
  assert.deepEqual([...parseCreateTables(saveSource,'postgres').keys()],[]);
  const throughRecycleFiles=files.filter(file=>file!==saveFile);
  assert.equal(throughRecycleFiles.length,180);
  assert.equal(digest(JSON.stringify(throughRecycleFiles)),"d88e6466bdf25f409a941b00fce53be2472f725abfad2a31ec0c67a86ac85f65");
  const recycleFile='0177_product_recycle_effects.sql';
  const recycleSource=readFileSync(resolve(root,'migrations',recycleFile),'utf8').replace(/\r\n?/g,'\n');
  assert.equal(digest(recycleSource),'bd77226f8f5733e979483f4b0a5999a1c233ecfcdae230e5f8c20126d175b43c');
  assert.deepEqual([...parseCreateTables(recycleSource,'postgres').keys()],[]);
  const throughAutoShelfFiles=throughRecycleFiles.filter(file=>file!==recycleFile);
  assert.equal(throughAutoShelfFiles.length,179);
  assert.equal(digest(JSON.stringify(throughAutoShelfFiles)),"7ab759fe7e80e8320a27bbe77d523907f14beb2b516fa7139dc25abbb07ca4c1");
  const autoShelfFile='0176_product_auto_shelf.sql';
  const autoShelfSource=readFileSync(resolve(root,'migrations',autoShelfFile),'utf8').replace(/\r\n?/g,'\n');
  assert.equal(digest(autoShelfSource),'46b3e860bfafbd29bd17596c88f9b0299c3b04dd776ed81818a919bef92e9f07');
  const throughStockFiles=throughAutoShelfFiles.filter(file=>file!==autoShelfFile);
  assert.equal(throughStockFiles.length,178);
  assert.equal(digest(JSON.stringify(throughStockFiles)),"7a6d7fa097009a425eb3ff3b95eefa55f80aa056c932a031701b99e0c129c676");
  // Main's reviewed stock outbox CHECK upgrade adds one file and no table.
  // Retain both older name-cohort hashes independently of that addition.
  const stockFile='0175_product_stock_effects.sql';
  const stockSource=readFileSync(resolve(root,'migrations',stockFile),'utf8').replace(/\r\n?/g,'\n');
  assert.equal(digest(stockSource),'31e2ec53cd275c77d8add059b89bd71c5d84871c3ce167ff48edc2abb56f35fc');
  const throughAbandonFiles=throughStockFiles.filter(file=>file!==stockFile);
  assert.equal(throughAbandonFiles.length,177);
  assert.equal(digest(JSON.stringify(throughAbandonFiles)),"da361cb50bd8e57dd64dbb36f3189b9df87a88b152d52fc6c9adb8850c04b298");
  const historicalFiles=throughAbandonFiles.filter(file=>file!==externalAdditions.cashier_second_card_abandon_v1.file);
  assert.equal(historicalFiles.length,176);
  assert.equal(digest(JSON.stringify(historicalFiles)),"75756c037d53d9d690b2daaba89973458ea40c1277440b632dd815b40cef6cb0");
  assert.deepEqual(files.filter(file=>!file.startsWith('0006a')&&!/^\d{4}_/.test(file)),[]);
  for(const file of ['0166_recharge_quota_group_seed.sql','0167_seckill_time_reference_lock.sql',
    '0170_order_promotion_gift_receipt.sql','0171_purchase_cancellation_gift_evidence.sql','0173_customer_city_delivery.sql',
    externalAdditions.cashier_second_card_abandon_v1.file,stockFile,autoShelfFile,recycleFile,saveFile])
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
  await assertRegisteredDatabaseCohort(db,path==='external'?'external':'orm','historical');
  await assert.rejects(installCustomerCityDelivery(db,{maintenance:true}));
  await assertCustomerCityDeliveryReady(db,false);
  const repeat=await db.execute(sql`SELECT 'relation' AS kind,oid::text,relfilenode::text,relowner::text,relacl::text AS acl
    FROM pg_class WHERE relnamespace='public'::regnamespace UNION ALL
    SELECT 'function',oid::text,NULL,proowner::text,proacl::text FROM pg_proc WHERE pronamespace='public'::regnamespace
    ORDER BY kind,oid`);
  assert.deepEqual(Array.from(repeat),Array.from(after));
  await composeReviewedCashierAbandonCatalog(db,path,root);
  await assertRegisteredDatabaseCohort(db,'external');
}
