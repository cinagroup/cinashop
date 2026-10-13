import type { CustomerCashierRecordDetail } from './customerWorkCashierRead';
import type { SystemFormInfo } from './systemForm';
export interface CustomerCashierInput {
  version:'customer-cashier-second-card-v1';scope_key:string;buyer_uid:number;tourist_key:string;
  product_id:number;sku_unique:string;quantity:number;real_name:string;user_phone:string;mark:string;
  custom_form:unknown;coupon_id:number;use_integral:boolean;
}
export interface CustomerCashierPaymentInput {
  version:'customer-cashier-second-card-payment-v1';scope_key:string;order_id:number;order_no:string;expected_amount:string;
}
interface PendingBase {version:'customer-cashier-pending-v1';actor_uid:number;service_id:number;request_key:string;request_hash:string;created_at:number}
export interface CustomerCashierCreationIntent extends PendingBase {kind:'creation';body:CustomerCashierInput}
export interface CustomerCashierPaymentIntent extends PendingBase {kind:'payment';body:CustomerCashierPaymentInput;buyer_uid:number;origin_hash:string;creation_key:string}
export type CustomerCashierIntent=CustomerCashierCreationIntent|CustomerCashierPaymentIntent;
export interface CustomerCashierAbandonDecision {
  version:'customer-cashier-abandon-pending-v1';actor_uid:number;request_key:string;kind:'creation'|'payment';request_hash:string;intent:CustomerCashierIntent;
}
export interface CustomerCashierAbandonment {
  version:'customer-cashier-abandon-v1';actor_uid:number;request_key:string;kind:'creation'|'payment';request_hash:string;scope_key:string;
  intent:CustomerCashierInput|CustomerCashierPaymentInput;created_at:string;
}
export interface CustomerCashierCard {
  product_id:number;sku_unique:string;quantity:number;unit_write_times:number;total_write_times:number;
  write_valid:1|2|3;write_days:number;write_start:number;write_end:number;
}
export interface CustomerCashierQuote {
  card:CustomerCashierCard;system_form:SystemFormInfo|null;pricing:{amount:string;total:string;quantity:number};
  quote_token:string;quote:{card:CustomerCashierCard;confirmationFingerprint:string;systemFormId:number;rawTotalCents:number;totalCents:number;payCents:number;
    couponPriceCents:number;firstOrderPriceCents:number;deductionCents:number;usedIntegralPoints:number;surplusIntegralPoints:number;
    memberDiscountCents:number;promotionSavingsCents:number;totalNum:number;items:{cartId:number;totalPriceCents:number}[]};
}
export interface CustomerCashierReceipt {
  version:'customer-cashier-receipt-v1';request_key:string;actor_uid:number;kind:'creation'|'payment';
  receipt:null|{order_id:number;request_hash:string;origin_hash?:string;evidence:Record<string,unknown>};
  abandonment:CustomerCashierAbandonment|null;
}
export interface CustomerCashierState {checked:boolean;receipt:CustomerCashierReceipt|null;detail:CustomerCashierRecordDetail|null;error:string}
