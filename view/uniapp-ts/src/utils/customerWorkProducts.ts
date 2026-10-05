import { customerWorkCanonicalJson,isCustomerWorkProductIntent,customerWorkUuid } from './customerWorkProductsContract';
import { customerWorkRequestKey } from './customerWorkFulfillment';
import type { CustomerWorkProductIntent } from '../types/customerWorkProducts';
export * from './customerWorkProductsContract';
export { customerWorkRequestKey };
export const CUSTOMER_WORK_PRODUCT_STORAGE='customer_work_product_pending_v1';
function assert(value:unknown,message:string):asserts value{if(!value)throw Error(message);}
export function customerWorkProductPending():CustomerWorkProductIntent[]{const value=uni.getStorageSync(CUSTOMER_WORK_PRODUCT_STORAGE);if(value===undefined||value===null||value==='')return[];assert(Array.isArray(value)&&value.length<=100&&value.every(isCustomerWorkProductIntent)&&new Set(value.map(row=>row.request_key)).size===value.length,'原商品操作记录损坏，请保留记录并核对');return JSON.parse(customerWorkCanonicalJson(value));}
export function retainCustomerWorkProductIntent(intent:CustomerWorkProductIntent){assert(isCustomerWorkProductIntent(intent),'原商品意图无效，尚未提交');const previous=customerWorkProductPending(),known=previous.find(row=>row.request_key===intent.request_key);if(known){assert(customerWorkCanonicalJson(known)===customerWorkCanonicalJson(intent),'同一商品请求编号不能替换内容');return;}assert(previous.length<100,'待核对商品操作过多，请先查询');const next=JSON.parse(customerWorkCanonicalJson([...previous,intent]));uni.setStorageSync(CUSTOMER_WORK_PRODUCT_STORAGE,next);assert(customerWorkCanonicalJson(customerWorkProductPending())===customerWorkCanonicalJson(next),'原商品意图保存未确认，尚未提交');}
export function releaseCustomerWorkProductIntent(key:string){assert(customerWorkUuid(key),'原商品请求编号无效');const next=customerWorkProductPending().filter(row=>row.request_key!==key);uni.setStorageSync(CUSTOMER_WORK_PRODUCT_STORAGE,next);assert(customerWorkCanonicalJson(customerWorkProductPending())===customerWorkCanonicalJson(next),'关闭原商品记录失败，请继续核对');}
