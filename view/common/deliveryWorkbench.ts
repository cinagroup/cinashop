/** User-token delivery workbench. A context is always selected explicitly. */
import type { MerchantOrderCart } from './merchantManagement';
export const DELIVERY_WORKBENCH_VERSION='delivery-workbench-v1' as const;
export type DeliveryScopeKind='platform'|'store';
export interface DeliveryContextSelection { kind:DeliveryScopeKind;store_id:number;delivery_id:number }
export interface DeliveryContextIdentity extends DeliveryContextSelection { name:string;nickname:string;phone:string;avatar:string }
export interface DeliveryIdentityConflict { kind:DeliveryScopeKind;store_id:number;delivery_ids:number[] }
export interface DeliveryWorkbenchEnvelope<T> {
  version:typeof DELIVERY_WORKBENCH_VERSION;actor_uid:number;scope_key:string;
  scope:DeliveryContextSelection|null;consistency_key:string;data:T;issues:string[];
}
export interface DeliveryWorkbenchContext {
  contexts:DeliveryContextIdentity[];conflicts:DeliveryIdentityConflict[];selected:DeliveryContextSelection|null;
}
export interface DeliveryWorkbenchStatistics { unsend:number;send:number;send_price:string }
export interface DeliveryDailyRow { date:string;time:string;price:string;count:number }
export interface DeliveryPaged<T> { list:T[];count:number;page:number;limit:number;has_more:boolean }
export type DeliveryOrderCart=MerchantOrderCart;
export interface DeliveryAvailability { available:boolean;reason:string }
export interface DeliveryOrderActions { writeoff:DeliveryAvailability }
export interface DeliveryOrderStore { id:number;name:string;phone:string;address:string;detailed_address:string;latitude:number|null;longitude:number|null }
export interface DeliveryOrderStatus { _type:number;_title:string;_msg:string;_class:string;_payType:string;_deliveryType:string }
export interface DeliveryOrderItem {
  id:number;pid:number;order_id:string;store_id:number;supplier_id:number;delivery_uid:number;
  real_name:string;nickname:string;user_phone:string;user_address:string;
  total_num:number;total_price:string;total_postage:string;pay_price:string;promotions_price:string;first_order_price:string;pay_integral:number;paid:number;status:number;refund_status:number;
  shipping_type:number;delivery_type:string;delivery_name:string;delivery_id:string;product_type:number;
  add_time:number;pay_time:number;mark:string;cartInfo:DeliveryOrderCart[];_status:DeliveryOrderStatus;
  store:DeliveryOrderStore|null;revision:string;actions:DeliveryOrderActions;
}
export interface DeliveryOrderDetail extends DeliveryOrderItem {
  pay_type:string;_pay_time:string;_add_time:string;pay_postage:string;coupon_price:string;deduction_price:string;vip_true_price:string;
  give_integral:number;give_coupon:Array<{id:number;coupon_title:string}>;
  promotions_detail:Array<{promotions_id:number;product_id:number;promotions_price:string;title:string}>;
  custom_form:unknown[]|Record<string,unknown>|null;verify_code:string;
  latitude:number|null;longitude:number|null;
}
export interface DeliveryOrdersPage extends DeliveryPaged<DeliveryOrderItem> { unsend:number;send:number }
export function isDeliveryWorkbenchEnvelope(value:unknown):value is DeliveryWorkbenchEnvelope<unknown>{
  if(!value||typeof value!=='object'||Array.isArray(value))return false;
  const row=value as Record<string,unknown>,scope=row.scope as Record<string,unknown>|null;
  return row.version===DELIVERY_WORKBENCH_VERSION&&Number.isSafeInteger(row.actor_uid)&&Number(row.actor_uid)>0
    &&typeof row.scope_key==='string'&&/^[a-f0-9]{64}$/.test(row.scope_key)
    &&typeof row.consistency_key==='string'&&/^[a-f0-9]{64}$/.test(row.consistency_key)
    &&(scope===null||!!scope&&typeof scope==='object'&&!Array.isArray(scope)&&(scope.kind==='platform'||scope.kind==='store')
      &&Number.isSafeInteger(scope.delivery_id)&&Number(scope.delivery_id)>0&&Number.isSafeInteger(scope.store_id)
      &&(scope.kind==='platform'?scope.store_id===0:Number(scope.store_id)>0))
    &&Array.isArray(row.issues)&&row.issues.every(issue=>typeof issue==='string')&&Object.hasOwn(row,'data');
}
