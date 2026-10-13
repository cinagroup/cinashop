import type { SystemFormComponent } from './systemForm';

export interface CustomerCashierRecordForm {
  session_key: string; system_form_id: number; components: SystemFormComponent[];
  previews: { reference: string; url: string }[];
}
export interface CustomerCashierRecord {
  id: number; order_no: string; buyer_uid: number; creator_uid: number; real_name: string; user_phone: string;
  amount: string; quantity: number; paid: 0 | 1; pay_type: string; pay_time: number; created_at: number;
  status: number; refund_status: number; root_retired: boolean; origin_hash: string;
}
export interface CustomerCashierRecordList {
  scope: 'own-second-card-creations'; list: CustomerCashierRecord[]; limit: number;
  has_more: boolean; next_cursor: string | null;
}
export interface CustomerCashierRecordDetail {
  scope: 'own-second-card-creations'; record: CustomerCashierRecord;
  creation: { request_key: string; request_hash: string; origin_hash: string; service_id: number; created_at: string };
  items: { product_id: number; sku_unique: string; quantity: number; write_times: number; name: string; sku: string }[];
  payment: null | { request_key: string; amount: string; payment_kind: 'zero' | 'cash'; paid_at: number; outbox_id: number; origin_hash: string };
  /** Older orders without a proven consumed form session have no projected form. */
  form?: CustomerCashierRecordForm | null;
}
export interface CustomerCashierReadEnvelope<T> {
  version: 'customer-work-cashier-read-v1'; actor_uid: number;
  principal: { kind: 'customer-order-manager'; service_id: number; scope: 'global' };
  scope_key: string; consistency_key: string; data: T;
}
