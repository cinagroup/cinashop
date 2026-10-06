import type { CustomerWorkScopes } from './customerWork';
export type CustomerWorkOperationKind='remark'|'manual_delivery'|'split_delivery'|'electronic_waybill'|'electronic_split_waybill'|'city_delivery'|'city_split_delivery'|'waybill_apply_existing'|'waybill_confirm_issued'|'waybill_confirm_retry'|'waybill_close';
export type CustomerWorkOperationOutcome='remark-saved'|'delivery-recorded'|'provider-admitted'|'job-updated'|'rollback-rejected'|'abandoned';
export interface CustomerWorkAction { available:boolean;reason:string }
export interface CustomerWorkRemarkTarget extends CustomerWorkAction { id:number;order_id:string;remark:string;order_revision:string;fulfillment_revision:string }
export interface CustomerWorkFulfillmentOrder {
  id:number;order_id:string;requested_order_id:number;root_order_id:number;store_id:number;supplier_id:number;customer_uid:number;
  order_revision:string;fulfillment_revision:string;remark:string;real_name:string;user_phone:string;user_address:string;
  paid:number;status:number;shipping_type:number;product_type:number;total_num:number;pay_price:string;
}
export interface CustomerWorkFulfillmentCart { cart_id:string;product_id:number;cart_num:number;surplus_num:number;store_name:string;sku:string;price:string }
export interface CustomerWorkFulfillmentDefaults { config_export_open:0|1;config_export_id:string;express_temp_id:string;to_name:string;to_tel:string;to_add:string;has_cloud_printer:boolean }
export interface CustomerWorkCarrier { id:number;name:string;code:string }
export interface CustomerWorkCourier { uid:number;nickname:string;phone:string }
export interface CustomerWorkWaybillTemplate { title:string;temp_id:string;pic:string }
export type CustomerWorkWaybillStatus='PENDING'|'ENQUEUING'|'ENQUEUED'|'PROCESSING'|'RETRYABLE'|'SENT'|'UNKNOWN'|'DEAD'|'CLOSED';
export interface CustomerWorkWaybillJob {
  id:number;event_key:string;request_key:string;request_hash:string;job_revision:string;order_id:number;order_no:string;root_order_id:number;supplier_id:number;service_id:number;
  actor_type:'customer';actor_id:number;fulfillment_mode:'whole'|'split';carrier_id:number;carrier_code:string;carrier_name:string;template_id:string;has_cloud_printer:boolean;
  status:CustomerWorkWaybillStatus;dispatch_count:number;attempt_count:number;replay_count:number;available_time:number;lease_until:number;
  provider_reference:string;response_code:string;tracking_number:string;label_url:string;payload_hash:string;fulfilled_order_id:number;remaining_order_id:number|null;
  last_error:string;sent_time:number;add_time:number;update_time:number;
}
export interface CustomerWorkWaybillOperation { order_id:number;root_order_id:number;order_revision:string;fulfillment_revision:string }
export type CustomerWorkCityStatus='PENDING'|'PROCESSING'|'ADMITTED'|'UNKNOWN'|'REJECTED'|'REVOKED'|'CANCELLED'|'DELIVERED';
export interface CustomerWorkCityJob { job_id:number;request_key:string;status:CustomerWorkCityStatus;provider:'dada'|'uu';provider_order_id:string;delivery_status:number|null;last_error_code:string;updated_at:number;may_retry:false }
export interface CustomerWorkCityReadiness {
  schema_ready:boolean;providers:{station_type:1|2;provider:'dada'|'uu';available:boolean;reasons:string[]}[];
  station:{type:0|1|2;relation_id:number;name:string;address:string;phone:string;city_name:string}|null;job:CustomerWorkCityJob|null;
}
export interface CustomerWorkFulfillment {
  metric_scopes:CustomerWorkScopes;requested_order_no:string;order:CustomerWorkFulfillmentOrder;remark_target:CustomerWorkRemarkTarget;
  actions:Record<'remark'|'manual_delivery'|'split_delivery'|'electronic_waybill'|'city_delivery',CustomerWorkAction>;
  carts:CustomerWorkFulfillmentCart[];defaults:CustomerWorkFulfillmentDefaults;
  readiness:{operations:{ready:boolean;reason:string};electronic:{ready:boolean;reason:string};city:CustomerWorkCityReadiness};
  jobs?:CustomerWorkWaybillJob[];
}
export interface CustomerWorkOperationBody extends Record<string,unknown> {
  version:'customer-work-operation-v1';scope_key:string;order_id:number;expected_order_revision:string;expected_fulfillment_revision:string;payload:Record<string,unknown>;
}
export interface CustomerWorkOperationReceipt {
  version:'customer-work-operation-v1';request_key:string;request_hash:string;actor_uid:number;service_id:number;order_id:number;kind:CustomerWorkOperationKind;outcome:CustomerWorkOperationOutcome;evidence:Record<string,unknown>;
}
export interface CustomerWorkPendingIntent {
  version:'customer-work-pending-v1';request_key:string;request_hash:string;actor_uid:number;service_id:number;scope_key:string;
  order_no:string;root_order_id:number;kind:CustomerWorkOperationKind;body:CustomerWorkOperationBody;endpoint:string;method:'POST'|'PUT';created_at:number;
}
