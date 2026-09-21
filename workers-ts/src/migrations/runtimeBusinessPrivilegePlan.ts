/** Reviewed whole-shop v1 profile with independent LOGIN acceptance tests.
 * Commissioning remains an explicit maintenance operation, never startup or
 * missing-permission repair. Runtime audit and business acceptance must still
 * pass on the actual Hyperdrives before switching the application.
 * Application means storefront + supplier + kefu + callbacks + queue workers,
 * not an end-user or tenant role. HTTP authorization remains mandatory.
 * Staff-table DML is conditional on the exact runtimeAdminBoundary protocol.
 * Unlisted objects/operations remain denied; never use ALL/default grants. */
import { pricingIdentifier } from './checkoutPricingLockCatalog';
import { OFFLINE_TABLES, OFFLINE_DISPATCH_COLUMNS } from './offlineOrderCatalog';
import { RUNTIME_TABLE_LOCK_UPDATE } from './runtimeLockOnlyBoundary';

const names = (value: string) => value.trim().split(/\s+/);
const unique = (...groups: readonly string[][]) => [...new Set(groups.flat())].sort();
export const RUNTIME_BUSINESS_PRIVILEGES_COMMISSIONING_READY = true;

// Customer/supplier commerce, durable payment state, fulfillment and messaging.
const sharedInsert = names(`
  agent_level_task_record cache capital_flow community community_comment community_relevance community_user
  delivery_service division_apply kefu_visitor_session luck_lottery_entitlement luck_lottery_record
  category live_anchor live_room store_coupon_issue store_coupon_product store_product_rule store_service_speechcraft
  city_delivery_callback_event city_delivery_callback_outbox city_delivery_callback_watermark city_delivery_reconciliation_case
  merchant_shipment_callback_event merchant_shipment_callback_outbox merchant_shipment_callback_watermark
  order_notification_delivery order_print_job order_print_job_action order_waybill_job order_waybill_job_action other_order other_order_status
  out_api_audit out_coupon_write_replay out_product_write_replay out_user_write_replay
  payment_callback_event payment_callback_outbox payment_reconciliation_case
  promoter_apply qrcode shipping_templates shipping_template_create_replay
  shipping_templates_free shipping_templates_no_delivery shipping_templates_region sms_record
  store_bargain_user store_bargain_user_help store_cart store_config store_coupon_issue_user store_coupon_user
  store_order store_order_cart_info store_order_economize store_order_invoice store_order_invoice_allocation
  store_order_outbox store_order_product_coupon_reward store_order_refund store_order_refund_payment
  store_order_refund_split store_order_fulfillment_branch store_order_status store_order_writeoff store_pink
  store_product store_product_attr store_product_attr_result store_product_attr_value store_product_category
  store_product_coupon store_product_description store_product_log store_product_relation store_product_reply
  store_product_reply_comment store_product_sku_retirement_log store_product_stock_record store_product_virtual
  store_service_feedback store_service_log store_service_record store_service_transfer store_user store_visit
  supplier_extract supplier_flowing_water supplier_transactions system_admin system_role system_attachment
  system_attachment_category system_form_data system_log system_message system_queue_dead_letter system_supplier
  system_user_apply system_virtual_inventory_export user user_address user_bill user_brokerage user_card
  user_extract user_friends user_invoice user_label_relation user_level user_money user_recharge user_relation
  user_search user_sign user_spread user_visit video_comment
  wechat_callback_event wechat_callback_outbox wechat_callback_watermark wechat_message wechat_qrcode_record wechat_user
  work_callback_event work_callback_outbox work_callback_watermark work_client_current work_client_follow_current
  work_client_follow_projection_fence work_client_follow_tag_current work_client_projection_fence
  work_contact_action_audit work_contact_action_outbox work_department_current work_department_leader_current
  work_department_projection_fence work_external_tag_current work_external_tag_group_current work_external_tag_projection_fence
  work_group_chat_current work_group_chat_member_current work_group_chat_projection_fence work_member_current
  work_member_identity_alias work_member_other_current work_member_relation_current
`);
const sharedUpdate = names(`
  cache capital_flow community community_comment community_user delivery_service division_apply kefu_visitor_session
  category live_anchor live_goods live_room store_product_description store_product_rule store_service_speechcraft
  luck_lottery_entitlement luck_lottery_record city_delivery_callback_event city_delivery_callback_outbox
  city_delivery_reconciliation_case merchant_shipment_callback_event merchant_shipment_callback_outbox
  order_notification_delivery order_print_job order_waybill_job other_order payment_callback_event payment_callback_outbox
  payment_reconciliation_case promoter_apply qrcode shipping_templates sms_record store_bargain store_bargain_user
  store_cart store_combination store_config store_coupon_issue store_coupon_user store_delivery_order store_integral
  store_order store_order_cart_info store_order_invoice store_order_outbox store_order_refund store_order_refund_payment
  store_pink store_product store_product_attr_value store_product_category store_product_log store_product_relation
  store_product_reply store_product_reply_comment store_product_virtual store_seckill store_service store_service_feedback
  store_service_log store_service_record store_visit supplier_extract supplier_flowing_water system_admin system_role
  system_attachment system_attachment_category system_message system_queue_dead_letter system_supplier system_user_apply
  system_virtual_inventory_export user user_address user_bill user_brokerage user_card user_extract user_invoice user_level
  user_recharge user_search video video_comment wechat_callback_event wechat_callback_outbox wechat_qrcode wechat_user
  work_callback_outbox work_channel_code work_client_follow work_client_follow_current work_client_follow_projection_fence
  work_client_projection_fence work_contact_action_outbox work_department_current work_department_projection_fence
  work_external_tag_current work_external_tag_group_current work_external_tag_projection_fence work_group_chat_current
  work_group_chat_member_current work_group_chat_projection_fence work_member_current work_member_identity_alias work_member_other_current
`);
const sharedDelete = names(`
  cache category community_relevance store_cart store_product_rule store_service_speechcraft
  shipping_templates_free shipping_templates_no_delivery shipping_templates_region
  store_order_cart_info store_order_invoice store_product_attr store_product_attr_result store_product_category
  store_product_coupon store_product_description store_product_relation store_service_feedback store_service_record
  system_attachment system_attachment_category user_label_relation user_relation
  work_client_follow_tag_current work_department_leader_current work_member_current work_member_relation_current
`);
// These objects are catalog/configuration reads for ordinary application work.
// The narrow UPDATE columns below support row locks/counters, never repricing.
const sharedRead = names(`
  agent_level agent_level_task agreement article_category article_content category city_area community_topic
  express_company live_anchor live_goods live_room live_room_goods luck_lottery luck_prize member_card member_card_batch
  member_right member_ship notification_template out_account out_interface page_category page_link print_document
  store_activity store_branch_product_attr_value store_brand store_coupon_issue store_coupon_product store_discounts
  store_discounts_products store_newcomer store_order_invoice_evidence store_order_promotions store_product_cate
  store_product_category_brand store_product_ensure store_product_label store_product_rule store_product_specs
  store_product_unit store_product_words store_promotions store_promotions_auxiliary store_seckill_time
  store_service_speechcraft system_article system_city system_config system_config_tab system_dise system_form
  system_group system_group_data system_menus system_notification system_sign_reward system_storage system_store
  system_store_staff system_user_level user_enter user_group user_label user_message wechat_card wechat_key wechat_media
  wechat_news_category wechat_qrcode_cate wechat_reply work_client work_client_follow_tags work_group_chat
  work_group_chat_auth work_group_chat_member work_group_msg_send_result work_group_template work_member work_member_other
  work_moment work_moment_send_result work_welcome work_welcome_relation
`);

const sharedColumns: Record<string, readonly string[]> = {
  offline_order_payment_dispatch: OFFLINE_DISPATCH_COLUMNS,
  // Upsert conflict arms update only projection state, never their natural keys.
  city_delivery_callback_watermark: names('last_event_id last_event_key last_state last_rank provider_update_time terminal update_time'),
  merchant_shipment_callback_watermark: names('last_event_id last_event_key last_state last_rank terminal update_time'),
  wechat_callback_watermark: names('last_event_id last_event_key last_event_time last_sequence_rank update_time'),
  work_callback_watermark: names('event_time sequence_rank event_id event_key update_time'),
  // Immutable FK parent identities are intentionally absent from these lists.
  work_client_current: names(`external_userid lifecycle_state profile_complete provider_snapshot_complete uid name avatar type gender
    unionid position corp_name corp_full_name external_profile last_event_id last_event_key last_event_subject_key_hash
    last_event_time last_sequence_rank create_time update_time inactive_time`),
  work_callback_event: names(`payload_hash msg_type event_type change_type payload status projection_status attempt_count lease_until
    lease_token last_error_code received_time processed_time payload_retained_until payload_redacted_time update_time`),
  member_card: ['use_uid','use_time','update_time'], member_card_batch: ['use_num','update_time'],
  system_article: ['visit','likes'], luck_prize: ['total'], store_discounts: ['limit_num'],
  // Lock-only columns are not key-update protection for these ordinary catalogs.
  // Staff-menu changes are additionally rejected by runtimeAdminBoundary.
  system_menus: ['id'], agent_level: ['id'], city_area: ['id'], system_user_level: ['id'],
  system_store: ['id'], store_coupon_product: ['coupon_id'], store_brand: ['id'], store_product_label: ['id'],
  store_product_category_brand: ['id'], store_newcomer: ['id'], supplier_transactions: ['id'],
  system_form: ['id'], store_product_ensure: ['id'],
  luck_lottery: ['id'], member_ship: ['id'], store_order_status: ['id'], store_product_specs: ['id'],
  store_user: ['id'], user_friends: ['id'], user_group: ['id'], user_label: ['id'],
  work_client: ['id'], work_group_chat: ['id'], work_department_leader_current: ['sort_order'],
  work_member_relation_current: ['sort_order'],
};

// Management mutations do not become available to the ordinary LOGIN.
const adminInsert = names(`
  admin_refund_operation admin_refund_creation admin_user_write_replay agent_level_task agreement article_category article_content
  category community_topic express_company live_anchor live_room luck_lottery luck_prize member_card member_card_batch
  member_right member_ship notification_template order_notification_delivery_action order_print_job_action order_waybill_job_action
  out_account page_link payment_reconciliation_action print_document store_bargain store_brand store_combination
  store_coupon_issue store_coupon_product store_discounts store_discounts_products store_integral store_newcomer
  store_product_ensure store_product_label store_product_rule store_product_specs store_product_unit store_product_words
  store_seckill store_seckill_time store_service store_service_speechcraft system_article system_config system_config_tab
  system_dise system_form system_notification system_sign_reward system_store system_store_staff system_user_level
  user_group user_label wechat_key wechat_news_category wechat_qrcode wechat_qrcode_cate wechat_reply
`);
const adminUpdate = names(`
  agent_level_task agreement article_category article_content category community_topic express_company live_anchor live_goods live_room
  luck_lottery luck_prize member_card member_card_batch member_right member_ship notification_template out_account
  print_document store_brand store_discounts store_discounts_products store_newcomer store_product_ensure store_product_label
  store_product_rule store_product_unit store_product_words store_service_speechcraft system_article system_config
  system_config_tab system_dise system_form system_notification system_sign_reward system_store system_store_staff
  system_user_level user_group user_label wechat_news_category wechat_qrcode_cate wechat_reply
`);
const adminDelete = names(`
  category express_company live_room_goods page_link store_coupon_product store_discounts_products store_product_attr_value store_product_ensure
  store_seckill store_combination store_integral
  store_product_label store_product_rule store_product_specs store_service_speechcraft system_config_tab system_sign_reward
  user_group user_label wechat_key wechat_news_category wechat_reply
`);

export interface RuntimePrivilegePlan {
  tables: Record<string, readonly ('SELECT'|'INSERT'|'UPDATE'|'DELETE')[]>;
  updateColumns: Record<string, readonly string[]>;
  functions: readonly string[];
  standaloneSequences: readonly string[];
}
export function runtimeBusinessPrivilegePlan(kind: 'app'|'admin'): RuntimePrivilegePlan {
  if (kind !== 'app' && kind !== 'admin') throw Error('Explicit runtime profile required');
  const insert=unique(sharedInsert,[...OFFLINE_TABLES],kind==='admin'?adminInsert:[]);
  const update=unique(sharedUpdate,RUNTIME_TABLE_LOCK_UPDATE,kind==='admin'?adminUpdate:[]);
  const remove=unique(sharedDelete,kind==='admin'?adminDelete:[]);
  const read=unique(sharedRead,insert,update,remove,Object.keys(sharedColumns),kind==='admin'?['system_timer','queue_list','queue_auxiliary']:[]);
  const result:RuntimePrivilegePlan={tables:{},updateColumns:{...sharedColumns},functions:[],standaloneSequences:['kefu_visitor_uid_seq']};
  for(const table of read){pricingIdentifier(table);result.tables[table]=['SELECT',
    ...(insert.includes(table)?['INSERT' as const]:[]),...(update.includes(table)?['UPDATE' as const]:[]),...(remove.includes(table)?['DELETE' as const]:[])];}
  for(const table of update) delete result.updateColumns[table];
  result.functions=kind==='app'?['checkout_lock_pricing_v1()','ooa_lock_pricing()']:[];
  return result;
}
