/** Delivery operations have their own actor-owned durable namespace. */
export const DELIVERY_OPERATION_VERSION = 'delivery-writeoff-operation-v1' as const;
export type DeliveryOperationJson = null | boolean | number | string | DeliveryOperationJson[] | { [key: string]: DeliveryOperationJson };
export interface DeliveryWriteoffPayload { readonly code: string; readonly items: readonly { readonly order_cart_id: number; readonly quantity: number }[] }
export interface DeliveryOperationInput {
  readonly version: typeof DELIVERY_OPERATION_VERSION;
  readonly scope_kind: 'platform' | 'store';
  readonly delivery_id: number;
  readonly store_id: number;
  readonly scope_key: string;
  readonly order_id: number;
  readonly expected_order_revision: string;
  readonly payload: DeliveryOperationJson;
}
export type DeliveryOperationOutcome = 'partial-delivered' | 'delivered' | 'abandoned' | 'rollback-rejected';
export interface DeliveryOperationReceipt {
  readonly version: typeof DELIVERY_OPERATION_VERSION;
  readonly request_key: string;
  readonly request_hash: string;
  readonly actor_uid: number;
  readonly scope_kind: 'platform' | 'store';
  readonly delivery_id: number;
  readonly store_id: number;
  readonly order_id: number;
  readonly outcome: DeliveryOperationOutcome;
  readonly evidence: Readonly<Record<string, DeliveryOperationJson>>;
}
export interface DeliveryOperationResult { readonly receipt: DeliveryOperationReceipt; readonly replayed: boolean }
export interface DeliveryWriteoffCart {
  id: number; cart_id: string; cart_num: number; product_id: number; product_type: number; is_gift: number;
  write_times: number; write_surplus_times: number; write_start: number; write_end: number;
  cart_info: { productInfo: { id: number; store_name: string; image: string; attrInfo: { suk: string; image: string; price: string } } };
}
export interface DeliveryWriteoffPreview {
  id: number; order_id: string; store_id: number; revision: string; verify_code: string;
  status: number; total_num: number; product_type: number; writeoff_count: number;
  cart_info: DeliveryWriteoffCart[]; actions: { writeoff: { available: boolean; reason: string } };
}
export interface DeliveryWriteoffPreviews { list: DeliveryWriteoffPreview[]; lookup_kind: 'order-code' | 'member-barcode' | 'order-id' }
export interface DeliveryWriteoffRecord {
  id: number; order_cart_id: number; writeoff_num: number; writeoff_price: string; add_time: number; time: string;
  cart_info: DeliveryWriteoffCart['cart_info']; operator: { kind: 'delivery' | 'staff' | 'admin' | 'kefu' | 'unknown'; delivery_id: number | null };
}
