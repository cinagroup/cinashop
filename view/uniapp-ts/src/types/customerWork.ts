export interface CustomerWorkScopes {
  sales: 'global_fulfillment_orders'; order_totals: 'global_fulfillment_orders';
  order_state_counts: 'platform_fulfillment_orders'; refund_counts: 'global_refunds';
  inventory: 'global_products'; visits: 'global_product_visits';
}
export interface CustomerWorkEnvelope<T> {
  version: 'customer-work-read-v1'; actor_uid: number;
  principal: { kind: 'customer-order-manager'; service_id: number; scope: 'global' };
  scope_key: string; consistency_key: string; data: T;
}
export interface CustomerWorkContext {
  metric_scopes: CustomerWorkScopes;
  profile: { uid: number; nickname: string; phone: string; avatar: string };
  capabilities: { statistics: true; orders: true; refunds: true; logistics: true;
    product_management: boolean; user_management: boolean; writeoff_read?: boolean; assisted_order: false; writes: false };
}
export interface CustomerWorkSummary {
  after_price: string; growth_rate: number; increase_time: string; increase_time_status: number;
  after_number: number; after_pay_number: number; today_visits: number;
}
export interface CustomerWorkOverview {
  metric_scopes: CustomerWorkScopes; today: CustomerWorkSummary;
  badges: { unshipped_count: number; refunding_count: number; refunded_count: number;
    refund_count: number; outofstock: number; policeforce: number };
}
export interface CustomerWorkStatistics {
  metric_scopes: CustomerWorkScopes; type: 1 | 7 | 30; summary: CustomerWorkSummary;
  counters: { order_count: number; unpaid_count: number; unshipped_count: number;
    received_count: number; evaluated_count: number; unwritoff_count: number; complete_count: number;
    refunding_count: number; refunded_count: number; refund_count: number; sum_price: string;
    todayPrice: string; todayCount: number; proPrice: string; proCount: number; monthPrice: string; monthCount: number };
}
export interface CustomerWorkTrendPoint { date: string; time: string; num: number; price: string }
export interface CustomerWorkTrend { metric_scopes: CustomerWorkScopes; type: 1 | 7 | 30; list: CustomerWorkTrendPoint[] }
export interface CustomerWorkDailyRow { date: string; time: string; price: string; count: number; visit: number; add_time: number }
export interface CustomerWorkPaged<T> { metric_scopes: CustomerWorkScopes; list: T[]; count: number; page: number; limit: number; has_more: boolean }
export interface CustomerWorkCart {
  id: number; cart_id: string; product_id: number; cart_num: number; refund_num: number;
  surplus_num: number; is_gift: number; truePrice: string; sum_true_price: string;
  productInfo: { store_name: string; image: string; price: string; attrInfo: { suk: string; image: string; price: string } };
}
export interface CustomerWorkRefundLink { id: number; order_id: string; refund_type: number; refund_num: number; refund_price: string }
export interface CustomerWorkOrder {
  metric_scopes?: CustomerWorkScopes; id: number; pid: number; order_id: string; uid: number;
  store_id: number; supplier_id: number; nickname: string; real_name: string; user_phone: string; user_address: string;
  total_num: number; total_price: string; total_postage: string; pay_price: string; pay_postage: string;
  paid: number; status: number; shipping_type: number; pay_type: string; type: number; type_name: string;
  refund_status: number; refund_type: number; delivery_type: string; delivery_name: string; delivery_code: string; delivery_id: string;
  mark: string; remark: string; add_time: number; pay_time: number; _add_time: string; _pay_time: string;
  _status: { _type: number; _title: string; _msg: string; _payType?: string; _deliveryType?: string };
  cartInfo: CustomerWorkCart[]; refund: CustomerWorkRefundLink[]; revision: string; write_available: false;
}
export interface CustomerWorkSplitOrder {
  id: number; pid: number; order_id: string; paid: number; status: number; total_num: number;
  pay_price: string; delivery_type: string; delivery_name: string; delivery_code: string; delivery_id: string;
}
export interface CustomerWorkOrderDetail extends CustomerWorkOrder {
  metric_scopes: CustomerWorkScopes; split: CustomerWorkSplitOrder[];
  customer: { uid: number; nickname: string; avatar: string };
  custom_form: unknown; refund_img: string[]; refund_goods_img: string[];
  vip_true_price: string; refund_reason_wap: string; refund_reason_wap_explain: string; refund_reason_time: number;
}
export interface CustomerWorkRefund {
  metric_scopes?: CustomerWorkScopes; id: number; order_id: string; store_order_id: number; store_order_sn: string;
  uid: number; apply_type: number; refund_type: number; refund_price: string; refunded_price: string; refund_num: number;
  refund_reason: string; refund_explain: string; refuse_reason: string; remark: string;
  add_time: string | number; _add_time: string; _status: { status_name: string };
  cartInfo: CustomerWorkCart[]; write_available: false;
}
export interface CustomerWorkRefundDetail extends CustomerWorkRefund {
  metric_scopes: CustomerWorkScopes; real_name: string; user_phone: string; user_address: string;
  refund_express: string; refund_express_name: string; refund_phone: string;
  refund_img: string[]; refund_goods_img: string[];
}
export interface CustomerWorkTrackingPackage {
  orderId: string; deliveryStatus: string; expressName: string; expressCode: string; expressNo: string;
  trackingState: 'pending' | 'in_transit' | 'delivered' | 'exception' | 'not_configured' | 'temporarily_unavailable';
  trackingSource: 'merchant' | 'carrier' | 'cache'; lastUpdatedAt: number; message: string;
  traces: { time: string; content: string; status: string }[];
}
export interface CustomerWorkLogistics extends CustomerWorkTrackingPackage {
  metric_scopes: CustomerWorkScopes; packages: CustomerWorkTrackingPackage[];
  order: { order_id: string; delivery_id: string; delivery_name: string; delivery_code: string; delivery_type: string };
}
export type { CustomerWorkPage } from '../../../common/customerWorkRoute';
