import { Buffer } from 'node:buffer';
import { shippingInteger, routineShippingUnavailable } from './RoutineShippingAccount';

/** Both actual delivery and paid pickup describe physical cart quantities,
 * never mutable remaining writeoff counts or the latest product title. */
export function routineShippingItemTitle(value:string|null,quantity:number):string {
  if(!shippingInteger(quantity)||!value||Buffer.byteLength(value,'utf8')>65536)return routineShippingUnavailable();
  let parsed:unknown;try{parsed=JSON.parse(value);}catch{return routineShippingUnavailable();}
  if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))return routineShippingUnavailable();
  const record=parsed as Record<string,unknown>,canonical=Object.hasOwn(record,'product');
  const info=canonical?record.product:record.productInfo;
  if(!info||typeof info!=='object'||Array.isArray(info))return routineShippingUnavailable();
  const name=(info as Record<string,unknown>)[canonical?'storeName':'store_name'];
  if(typeof name!=='string'||!name.length||Buffer.byteLength(name,'utf8')>4096||/[\u0000-\u001f\u007f]/u.test(name))return routineShippingUnavailable();
  return `${name} * ${quantity}`;
}

export function routineShippingItemDescription(lines:readonly {cartInfo:string|null;cartNum:number}[]):string {
  if(!lines.length||lines.length>200)return routineShippingUnavailable();
  return Array.from(lines.map(line=>routineShippingItemTitle(line.cartInfo,line.cartNum)).join('；')).slice(0,120).join('');
}
