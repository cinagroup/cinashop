import { ValidateException } from '@/utils/errors';
import { outRequestHash,normalizeOutRequestKey } from '@/services/out/OutIdempotency';
import { freezeCustomerActor,freezeCustomerJson,type CustomerJson } from './CustomerWorkOperationRequest';
import type { CustomerWorkActor } from './CustomerWorkScope';

export const CUSTOMER_WRITEOFF_VERSION='customer-work-writeoff-operation-v1' as const;
export const CUSTOMER_WRITEOFF_READ_VERSION='customer-work-writeoff-read-v1' as const;
export const CUSTOMER_WRITEOFF_KIND='writeoff' as const;
export const CUSTOMER_WRITEOFF_REQUEST_NAMESPACE=731678;
export type WriteoffOutcome='partial-writtenoff'|'written-off'|'abandoned'|'rollback-rejected';
export interface WriteoffSelection {cart_row_id:number;writeoff_num:number}
export interface WriteoffPayload {order_no:string;root_order_id:number;root_order_no:string;code:string;target_fingerprint:string;items:WriteoffSelection[]}
export interface WriteoffInput {version:typeof CUSTOMER_WRITEOFF_VERSION;scope_key:string;order_id:number;expected_order_revision:string;expected_writeoff_revision:string;payload:WriteoffPayload}
export interface WriteoffContext {actor:CustomerWorkActor;request_key:string}
export interface PreparedWriteoff {actor:CustomerWorkActor;key:string;hash:string;kind:typeof CUSTOMER_WRITEOFF_KIND;input:WriteoffInput}
export interface WriteoffReceipt {version:typeof CUSTOMER_WRITEOFF_VERSION;request_key:string;request_hash:string;actor_uid:number;service_id:number;order_id:number;kind:typeof CUSTOMER_WRITEOFF_KIND;outcome:WriteoffOutcome;evidence:Record<string,CustomerJson>;created_at:number}
export type WriteoffNamespace='auto'|'order-code'|'member-barcode'|'legacy-order-id';
export const WRITEOFF_SHA=/^[a-f0-9]{64}$/;
export function writeoffRecord(value:unknown,keys:readonly string[]):Record<string,unknown>{
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.getPrototypeOf(value)!==Object.prototype||Object.keys(value).sort().join(',')!==[...keys].sort().join(','))throw new ValidateException('核销请求字段不符合固定合同');return value as Record<string,unknown>;
}
export function writeoffId(value:unknown,zero=false):number{if(typeof value!=='number'||!Number.isSafeInteger(value)||value<(zero?0:1)||value>2147483647)throw new ValidateException('核销身份或数量须为严格整数');return value;}
export function writeoffHash(value:unknown):string{if(typeof value!=='string'||!WRITEOFF_SHA.test(value))throw new ValidateException('核销依据版本无效');return value;}
export function writeoffText(value:unknown,max:number):string{if(typeof value!=='string'||!value||value!==value.trim()||Array.from(value).length>max||/[\u0000-\u001f\u007f]|[\ud800-\udfff]/u.test(value))throw new ValidateException('核销码或商品标识无效');return value;}
export function writeoffNumber(value:unknown):string{const text=writeoffText(value,32);if(!/^[A-Za-z0-9_-]+$/.test(text))throw new ValidateException('原订单业务单号须先核对');return text;}
export function writeoffCode(value:unknown):string{if(typeof value!=='string'||!/^\d{12}$/.test(value))throw new ValidateException('请输入原12位核销码');return value;}
export function writeoffPayload(value:unknown):WriteoffPayload{
 const p=writeoffRecord(value,['order_no','root_order_id','root_order_no','code','target_fingerprint','items']);
 if(!Array.isArray(p.items)||p.items.length<1||p.items.length>200)throw new ValidateException('请选择1至200项真实核销商品');
 const items=p.items.map(value=>{const r=writeoffRecord(value,['cart_row_id','writeoff_num']);return{cart_row_id:writeoffId(r.cart_row_id),writeoff_num:writeoffId(r.writeoff_num)};});
 if(items.some((row,index)=>index>0&&items[index-1].cart_row_id>=row.cart_row_id))throw new ValidateException('核销商品须按真实行标识升序且不能重复');
 return{order_no:writeoffNumber(p.order_no),root_order_id:writeoffId(p.root_order_id),root_order_no:writeoffNumber(p.root_order_no),code:writeoffCode(p.code),target_fingerprint:writeoffHash(p.target_fingerprint),items};
}
export function writeoffInput(value:unknown):WriteoffInput{
 const body=writeoffRecord(freezeCustomerJson(value),['version','scope_key','order_id','expected_order_revision','expected_writeoff_revision','payload']);
 if(body.version!==CUSTOMER_WRITEOFF_VERSION)throw new ValidateException('核销操作协议无效');const payload=writeoffPayload(body.payload);
 const input=freezeCustomerJson({version:CUSTOMER_WRITEOFF_VERSION,scope_key:writeoffHash(body.scope_key),order_id:writeoffId(body.order_id),expected_order_revision:writeoffHash(body.expected_order_revision),expected_writeoff_revision:writeoffHash(body.expected_writeoff_revision),payload}) as unknown as WriteoffInput;
 return input;
}
export async function prepareWriteoff(context:WriteoffContext,value:unknown):Promise<PreparedWriteoff>{
 const actor=freezeCustomerActor(context.actor),key=normalizeOutRequestKey(context.request_key),input=writeoffInput(value);
 return Object.freeze({actor,key,kind:CUSTOMER_WRITEOFF_KIND,input,hash:await outRequestHash({version:CUSTOMER_WRITEOFF_VERSION,actor_uid:actor.uid,kind:CUSTOMER_WRITEOFF_KIND,input})});
}
export function writeoffLookup(value:unknown){const r=writeoffRecord(freezeCustomerJson(value),['version','scope_key','namespace','value']);if(r.version!==CUSTOMER_WRITEOFF_READ_VERSION||typeof r.namespace!=='string'||!['auto','order-code','member-barcode','legacy-order-id'].includes(r.namespace))throw new ValidateException('核销查询协议无效');const namespace=r.namespace as WriteoffNamespace,text=writeoffText(r.value,32);if(namespace==='legacy-order-id'&&(!/^[1-9]\d{0,9}$/.test(text)||Number(text)>2147483647))throw new ValidateException('旧入口必须提供真实订单行标识');if(namespace==='order-code')writeoffCode(text);if(['auto','member-barcode'].includes(namespace)&&!/^[A-Za-z0-9_-]+$/.test(text))throw new ValidateException('核销查询码须为严格ASCII标识');return{version:CUSTOMER_WRITEOFF_READ_VERSION,scope_key:writeoffHash(r.scope_key),namespace,value:text};}
