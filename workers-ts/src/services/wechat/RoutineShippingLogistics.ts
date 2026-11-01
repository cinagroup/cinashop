/** Physical fulfillment classification, not account or provider authority.
 * Type 3 is a store-assigned delivery; only explicit type 2 means pickup.
 * Unknown/cashier types never become a guessed pickup or virtual shipment. */
export function routineShippingLogisticsType(shippingType:number,deliveryType:string):1|2|3|4|null {
  if(shippingType===2)return 4;
  if(shippingType!==1&&shippingType!==3)return null;
  if(deliveryType==='express')return 1;
  if(deliveryType==='send'||deliveryType==='city_delivery')return 2;
  if(deliveryType==='fictitious')return 3;
  return null;
}
