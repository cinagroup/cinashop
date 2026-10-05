/** User-token store management. Every mutation must keep its original request key. */
export const MERCHANT_MANAGEMENT_VERSION = 'merchant-management-v1' as const;
export type MerchantOrderSelector = '' | -4 | -3 | -2 | -1 | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
export interface MerchantStoreIdentity { store_id: number; staff_id: number; name: string }
export interface MerchantActionAvailability { available: boolean; reason: string }
export interface MerchantCapabilities {
  remark: boolean; change_price: boolean; confirm_offline: boolean;
  manual_delivery: boolean; split_delivery: boolean; electronic_waybill: boolean;
  refund_create: boolean; refund_decide: boolean; tracking: boolean; writeoff: boolean;
}
export type MerchantOrderAction = 'remark' | 'change_price' | 'confirm_offline' | 'manual_delivery' | 'split_delivery' | 'electronic_waybill' | 'refund_create' | 'refund_decide' | 'tracking' | 'writeoff';
export type MerchantOrderActions = Record<MerchantOrderAction, MerchantActionAvailability>;
export interface MerchantManagementEnvelope<T> {
  version: typeof MERCHANT_MANAGEMENT_VERSION; actor_uid: number; store_id: number | null;
  scope_key: string; consistency_key: string; data: T; issues: string[];
}
export interface MerchantManagementContext {
  stores: MerchantStoreIdentity[]; selected_store_id: number | null; capabilities: MerchantCapabilities;
}
export interface MerchantOrderStatistics {
  order_count: number; sum_price: string; unpaid_count: number; unshipped_count: number;
  received_count: number; evaluated_count: number; unwritoff_count: number; complete_count: number;
  refunding_count: number; refunded_count: number; refund_count: number;
  todayPrice: string; todayCount: number; proPrice: string; proCount: number; monthPrice: string; monthCount: number;
  yue_pay_status: 1 | 2; pay_weixin_open: 0 | 1; ali_pay_status: boolean;
  metric_scope: 'current_store_fulfillments_pid_gte_0';
}
export interface MerchantOrderPeriod {
  type: 1 | 7 | 30; start: number; end_exclusive: number; previous_start: number;
  after_price: string; growth_rate: number; increase_time: string; increase_time_status: 1 | 2;
  after_number: number; after_pay_number: number; today_visits: number;
  visit_scope: 'current_store_product_visit_events';
}
export interface MerchantOrderChartPoint { date: string; time: string; num: number; price: string }
export interface MerchantOrderDailyRow { date: string; time: string; price: string; count: number; visit: number; add_time: number }
export interface MerchantPaged<T> { list: T[]; count: number; page: number; limit: number; has_more: boolean }
export interface MerchantOrderCart {
  id: number; unique: string; cart_id: string; product_id: number; product_type: number;
  cart_num: number; refund_num: number; surplus_num: number; split_surplus_num: number;
  is_gift: number; is_support_refund: number; truePrice: string; vip_truePrice: string;
  vip_sum_truePrice: string; sum_true_price: string; postage_price: string; coupon_price: string;
  integral_price: string; promotions_true_price: string;
  is_writeoff: number; write_times: number; write_surplus_times: number; write_start: number; write_end: number;
  productInfo: { id: number; store_name: string; image: string; price: string; attrInfo: { suk: string; image: string; price: string } };
}
export interface MerchantRefundSummary { id: number; order_id: string; refund_type: number; refund_num: number; refund_price: string }
export interface MerchantOrderListItem {
  id: number; pid: number; order_id: string; uid: number; store_id: number; supplier_id: number;
  real_name: string; user_phone: string; user_address: string; nickname: string;
  total_num: number; total_price: string; total_postage: string; pay_price: string; pay_postage: string;
  coupon_price: string; deduction_price: string; promotions_price: string; first_order_price: string;
  pay_integral: number; paid: number; status: number; shipping_type: number; pay_type: string;
  add_time: number; pay_time: number; _add_time: string; _pay_time: string;
  refund_status: number; refund_type: number; refund_price: string;
  delivery_type: string; delivery_name: string; delivery_code: string; delivery_id: string;
  type: number; type_name: string; pink_id: number; product_type: number; mark: string; remark: string;
  _status: { _type: number; _title: string; _msg: string; _class: string; _payType: string; _deliveryType: string };
  cartInfo: MerchantOrderCart[]; refund: MerchantRefundSummary[]; is_all_refund: boolean;
  actions: MerchantOrderActions; revision: string;
}
export interface MerchantOrderReview {
  uid: number; storeOrderId: number; storeId: number; supplierId: number; orderId: string;
  payPrice: string; paid: number; rawStatus: number; refundStatus: number; payType: string;
}
export interface MerchantOrderDetail extends MerchantOrderListItem {
  review: MerchantOrderReview; customer: { uid: number; nickname: string; avatar: string; level_name: string; vip_discount: string; pay_vip_status: boolean };
  vip_true_price: string; promotions_detail: Array<{ promotions_id: number; product_id: number; promotions_price: string; title: string }>;
  give_coupon: Array<{ id: number; coupon_title: string }>; give_integral: number;
  custom_form: unknown[] | Record<string, unknown> | null; virtual_info: string; fictitious_content: string;
  pinkStatus: number | null; invoice: { id: number; status: number; is_refund: number } | null;
  refund_reason_wap_explain: string; refund_reason_wap: string; refund_reason: string; refund_reason_time: number;
  refund_img: string[]; refund_goods_img: string[]; stop_time: number;
  split: Array<{ id: number; pid: number; order_id: string; paid: number; status: number; total_num: number; pay_price: string; delivery_type: string; delivery_name: string; delivery_code: string; delivery_id: string }>;
  store: { id: number; name: string; phone: string; address: string; detailed_address: string };
}
export interface MerchantDeliveryDefaults {
  express_temp_id: string; to_name: string; config_export_id: string; to_tel: string; to_add: string;
  config_export_open: 0 | 1; city_delivery_status: boolean; self_delivery_status: boolean;
  dada_delivery_status: boolean; uu_delivery_status: boolean;
}
export interface MerchantDeliveryAgent { uid: number; nickname: string; phone: string }
export interface MerchantCarrier { id: number; name: string; code: string }
export interface MerchantDeliveryGain { id:number; order_id:string; real_name:string; user_phone:string; user_address:string; revision:string }
export interface MerchantTrackingPackage {
  orderId:string; deliveryStatus:string; expressName:string; expressCode:string; expressNo:string;
  trackingState:'pending'|'in_transit'|'delivered'|'exception'|'not_configured'|'temporarily_unavailable';
  trackingSource:'merchant'|'carrier'|'cache'; message:string; lastUpdatedAt:number;
  traces:Array<{time:string;content:string;status:string}>;
}
export interface MerchantExpressResult extends MerchantTrackingPackage {
  packages:MerchantTrackingPackage[]; express:Array<{time:string;status:string}>;
  order:{order_id:string;delivery_id:string;delivery_name:string;delivery_code:string;delivery_type:string};
}
export interface MerchantOperationReceipt {
  version:'merchant-order-operation-v1'; order_id:number;
  request_key: string; request_hash: string; actor_uid: number; staff_id: number; store_id: number;
  kind: MerchantOperationKind; outcome: MerchantOperationOutcome; evidence:Readonly<Record<string,MerchantJson>>;
}
export type MerchantOperationKind='remark'|'manual_delivery'|'split_delivery'|'change_price'|'confirm_offline'|'refund_create'|'return_approve'|'refund_refuse'|'refund_execute';
export type MerchantOperationOutcome='remark-saved'|'delivery-recorded'|'price-changed'|'offline-paid'|'application-created'|'return-approved'|'refused'|'balance-settled'|'provider-admitted'|'abandoned'|'rollback-rejected';
export type MerchantJson=null|boolean|number|string|MerchantJson[]|{[key:string]:MerchantJson};
export interface MerchantOperationInput { version:'merchant-order-operation-v1';store_id:number;scope_key:string;order_id:number;expected_order_revision:string;payload:MerchantJson }
export interface MerchantOperationResult { receipt:MerchantOperationReceipt;replayed:boolean;execution?:{completed:boolean;status:string}|null }
export interface MerchantRefundQuoteInput { version:'merchant-refund-quote-v1';store_id:number;scope_key:string;order_id:number;expected_order_revision:string;mode:'remaining'|'items';items:Array<{cart_id:number;cart_num:number}> }
export interface MerchantRefundQuote extends MerchantRefundQuoteInput { actor_uid:number;quoted_price:string;quote_fingerprint:string;refund_time_days:number }
export interface MerchantRefundCreationPayload { mode:'remaining'|'items';items:Array<{cart_id:number;cart_num:number}>;quoted_price:string;refund_price:string;quote_fingerprint:string;reason:string }
export interface MerchantRefundReviewInput { version:'merchant-refund-review-v1';store_id:number;scope_key:string;order_id:number;refund_id:number }
export interface MerchantRefundReview extends MerchantRefundReviewInput {
  actor_uid:number;expected_order_revision:string;refund_order_id:string;refund_price:string;refunded_price:string;
  apply_type:number;refund_type:number;review_fingerprint:string;requires_received_confirmation:boolean;
  actions:Record<'return_approve'|'refund_refuse'|'refund_execute',MerchantActionAvailability>;
  refund_reason:string;refund_explain:string;add_time:number;refunded_time:number;refuse_reason:string;
  return_logistics:{express:string;express_name:string;phone:string;explain:string};
  return_images:Array<{url:string;src:string}>;return_images_error:string;
  request_images:Array<{url:string;src:string}>;request_images_error:string;
  refund_reason_wap_explain:string;refund_reason_time:number;
}
export interface MerchantRefundDecisionPayload { action:'return'|'refuse'|'refund';refund_id:number;review_fingerprint:string;decision:{apply_type:number;refund_type:number;received:boolean};reason?:string }
export function isMerchantEnvelope(value: unknown): value is MerchantManagementEnvelope<unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row=value as Record<string,unknown>;
  return row.version===MERCHANT_MANAGEMENT_VERSION && Number.isSafeInteger(row.actor_uid) && Number(row.actor_uid)>0
    && (row.store_id===null || Number.isSafeInteger(row.store_id)&&Number(row.store_id)>0)
    && typeof row.scope_key==='string' && /^[a-f0-9]{64}$/.test(row.scope_key)
    && typeof row.consistency_key==='string' && /^[a-f0-9]{64}$/.test(row.consistency_key)
    && Array.isArray(row.issues) && row.issues.every(item=>typeof item==='string') && Object.hasOwn(row,'data');
}
