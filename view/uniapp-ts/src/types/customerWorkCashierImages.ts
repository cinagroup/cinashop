import type { SystemFormInfo } from './systemForm';

export interface CustomerCashierFormContext {
  version: 'customer-cashier-form-session-v1';
  scope_key: string; buyer_uid: number; tourist_key: string;
  product_id: number; sku_unique: string; quantity: number;
}
export interface CustomerCashierImageMetadata {
  version: 'customer-cashier-form-image-v1'; scope_key: string; session_key: string;
  field_id: string; sha256: string; size: number;
}
export interface CustomerCashierFormSession {
  actor_uid: number; service_id: number; scope_key: string; request_key: string; request_hash: string;
  intent: CustomerCashierFormContext; system_form: SystemFormInfo; scope_digest: string;
  state: 'active' | 'cancelled' | 'frozen' | 'consumed'; created_at: string; cancelled_at: string | null;
  frozen_request_hash: string | null; order_id: number | null; order_no: string | null;
}
export interface CustomerCashierFormImage {
  actor_uid: number; service_id: number; session_key: string; request_key: string; request_hash: string;
  intent: CustomerCashierImageMetadata; field_id: string; sha256: string; size: number;
  mime: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif'; scope_digest: string;
  state: 'reserved' | 'stored'; attachment_id: number | null; reference: string | null;
  created_at: string; stored_at: string | null;
}
export interface CustomerCashierSessionReceipt {
  version: 'customer-cashier-form-session-v1'; actor_uid: number; request_key: string;
  receipt: CustomerCashierFormSession | null;
}
export interface CustomerCashierImageReceipt {
  version: 'customer-cashier-form-image-v1'; actor_uid: number; request_key: string;
  receipt: CustomerCashierFormImage | null;
}
export interface CustomerCashierFormPreviews {
  version: 'customer-cashier-form-preview-v1'; actor_uid: number; session_key: string;
  previews: { reference: string; url: string }[];
}
interface StageBase {
  version: 'customer-cashier-image-pending-v1'; actor_uid: number; service_id: number;
  request_key: string; request_hash: string; created_at: number;
}
export interface CustomerCashierSessionIntent extends StageBase { kind: 'session'; body: CustomerCashierFormContext }
export interface CustomerCashierImageIntent extends StageBase { kind: 'image'; body: CustomerCashierImageMetadata }
export type CustomerCashierImageStageIntent = CustomerCashierSessionIntent | CustomerCashierImageIntent;
