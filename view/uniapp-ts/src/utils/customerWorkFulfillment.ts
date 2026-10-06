import { customerWorkCanonicalJson,isCustomerWorkPendingIntent,customerWorkUuid } from './customerWorkFulfillmentContract';
import type { CustomerWorkPendingIntent } from '../types/customerWorkFulfillment';
export * from './customerWorkFulfillmentContract';
function assert(value:unknown,message:string):asserts value{if(!value)throw Error(message);}
export const CUSTOMER_WORK_PENDING_STORAGE='customer_work_pending_intents_v1';
export function customerWorkPendingIntents():CustomerWorkPendingIntent[]{const saved=uni.getStorageSync(CUSTOMER_WORK_PENDING_STORAGE);if(saved===undefined||saved===null||saved==='')return [];assert(Array.isArray(saved)&&saved.length<=100&&saved.every(isCustomerWorkPendingIntent)&&new Set(saved.map(row=>row.request_key)).size===saved.length,'原操作记录损坏，请保留记录并核对原结果');return JSON.parse(customerWorkCanonicalJson(saved));}
export function retainCustomerWorkIntent(intent:CustomerWorkPendingIntent){assert(isCustomerWorkPendingIntent(intent),'原操作记录无效，尚未提交');const saved=customerWorkPendingIntents(),prior=saved.find(row=>row.request_key===intent.request_key);if(prior){assert(customerWorkCanonicalJson(prior)===customerWorkCanonicalJson(intent),'同一原请求编号不能替换操作内容');return;}assert(saved.length<100,'原操作待核对记录过多，请先查询');const next=JSON.parse(customerWorkCanonicalJson([...saved,intent]));uni.setStorageSync(CUSTOMER_WORK_PENDING_STORAGE,next);assert(customerWorkCanonicalJson(customerWorkPendingIntents())===customerWorkCanonicalJson(next),'原操作保存未确认，尚未提交');}
export function releaseCustomerWorkIntent(key:string){assert(customerWorkUuid(key),'原操作编号无效');const next=customerWorkPendingIntents().filter(row=>row.request_key!==key);uni.setStorageSync(CUSTOMER_WORK_PENDING_STORAGE,next);assert(customerWorkCanonicalJson(customerWorkPendingIntents())===customerWorkCanonicalJson(next),'原操作记录关闭失败，请继续核对');}
export async function customerWorkRequestKey():Promise<string>{
  const format=(bytes:Uint8Array)=>{assert(bytes.length===16,'安全原请求编号生成失败');bytes[6]=(bytes[6]!&15)|64;bytes[8]=(bytes[8]!&63)|128;const h=Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;};
  // #ifdef H5
  if(typeof globalThis.crypto?.getRandomValues==='function')return format(globalThis.crypto.getRandomValues(new Uint8Array(16)));
  // #endif
  if(typeof uni.getRandomValues==='function')return new Promise((resolve,reject)=>uni.getRandomValues({length:16,success:result=>{try{resolve(format(new Uint8Array(result.randomValues)));}catch(error){reject(error);}},fail:()=>reject(Error('安全原请求编号生成失败，尚未提交'))}));
  throw Error('当前环境缺少安全随机数，尚未提交');
}
