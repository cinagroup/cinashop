import { ValidateException } from '@/utils/errors';
import { amountToCents } from '@/services/payment/RefundGateway';
import { freezeCustomerActor, freezeCustomerJson, type CustomerJson } from './CustomerWorkOperationRequest';
import type { CustomerWorkActor } from './CustomerWorkScope';
import { customerWorkId } from './CustomerWorkScope';
import { normalizeOutRequestKey, outRequestHash } from '@/services/out/OutIdempotency';

export const CUSTOMER_FINANCIAL_VERSION = 'customer-work-financial-operation-v1' as const;
export const CUSTOMER_FINANCIAL_QUOTE_VERSION = 'customer-work-financial-refund-quote-v1' as const;
export const CUSTOMER_FINANCIAL_KINDS = ['change_price','confirm_offline','refund_create','refund_return','refund_refuse','refund_execute','refund_remark'] as const;
export type FinancialKind = typeof CUSTOMER_FINANCIAL_KINDS[number];
export type FinancialOutcome = 'price-changed'|'offline-paid'|'refund-created'|'return-approved'|'refused'|'balance-settled'|'provider-admitted'|'refund-remark-saved'|'abandoned'|'rollback-rejected';
export interface FinancialInput { readonly version:typeof CUSTOMER_FINANCIAL_VERSION; readonly scope_key:string; readonly order_id:number; readonly expected_order_revision:string; readonly expected_financial_revision:string; readonly payload:CustomerJson }
export interface FinancialContext { actor:CustomerWorkActor; request_key:string }
export interface PreparedFinancialOperation { readonly actor:CustomerWorkActor; readonly key:string; readonly hash:string; readonly kind:FinancialKind; readonly input:FinancialInput }
export interface FinancialReceipt { version:typeof CUSTOMER_FINANCIAL_VERSION; request_key:string; request_hash:string; actor_uid:number; service_id:number; order_id:number; kind:FinancialKind; outcome:FinancialOutcome; evidence:Record<string,CustomerJson>; created_at:number }
export interface FinancialSelection { cart_row_id:number; cart_num:number }
export interface FinancialCreation { mode:'remaining'|'items'; items:FinancialSelection[]; quoted_price:string; refund_price:string; quote_fingerprint:string; reason:string }
export interface FinancialRefundTarget { refund_id:number; refund_no:string; expected_refund_revision:string; review_fingerprint:string }
export interface FinancialDecision extends FinancialRefundTarget { decision:{apply_type:number;refund_type:number;received:boolean}; reason?:string;refund_price?:string }
export interface FinancialQuoteInput { version:typeof CUSTOMER_FINANCIAL_QUOTE_VERSION;scope_key:string;order_id:number;expected_order_revision:string;expected_financial_revision:string;mode:'remaining'|'items';items:FinancialSelection[] }
export const FINANCIAL_SHA=/^[a-f0-9]{64}$/;
export function financialRecord(value:unknown,keys:readonly string[]):Record<string,unknown> {
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.getPrototypeOf(value)!==Object.prototype||Object.keys(value).sort().join(',')!==[...keys].sort().join(','))throw new ValidateException('财务请求字段不符合固定合同');return value as Record<string,unknown>;
}
export function financialHash(value:unknown):string {if(typeof value!=='string'||!FINANCIAL_SHA.test(value))throw new ValidateException('财务审查版本无效');return value;}
export function financialId(value:unknown,zero=false):number {if(typeof value!=='number'||!Number.isSafeInteger(value)||value<(zero?0:1)||value>2147483647)throw new ValidateException('财务身份或数量无效');return value;}
export function financialText(value:unknown,max=255,required=true):string {
 if(typeof value!=='string'||value!==value.trim()||/[\u0000-\u001f\u007f]/.test(value)||Array.from(value).length>max||required&&!value)throw new ValidateException('财务原因、单号或备注无效');return value;
}
export function financialBusinessNumber(value:unknown,max:number):string {const number=financialText(value,max);if(!/^[A-Za-z0-9_-]+$/.test(number))throw new ValidateException('历史业务单号不符合手机财务身份合同，请从原只读页面核对');return number;}
export function financialMoney(value:unknown):string {if(typeof value!=='string'||!/^(0|[1-9]\d{0,9})\.\d{2}$/.test(value)||amountToCents(value)===null)throw new ValidateException('金额必须是不超过十位整数的两位小数字符串');return value;}
export function financialSelections(mode:unknown,value:unknown):{mode:'remaining'|'items';items:FinancialSelection[]} {
 if(typeof mode!=='string'||!['remaining','items'].includes(mode)||!Array.isArray(value)||value.length>100||(mode==='remaining'?value.length!==0:value.length===0))throw new ValidateException('请选择明确的退款商品及件数');
 const items=value.map(v=>{const row=financialRecord(v,['cart_row_id','cart_num']);return{cart_row_id:financialId(row.cart_row_id),cart_num:financialId(row.cart_num)};});
 if(new Set(items.map(x=>x.cart_row_id)).size!==items.length||items.some((x,i)=>i>0&&items[i-1].cart_row_id>=x.cart_row_id))throw new ValidateException('退款商品必须按真实行标识排序且不能重复');return{mode:mode as 'remaining'|'items',items};
}
export function financialCreation(value:unknown):FinancialCreation {const r=financialRecord(value,['mode','items','quoted_price','refund_price','quote_fingerprint','reason']),selected=financialSelections(r.mode,r.items),quoted_price=financialMoney(r.quoted_price),refund_price=financialMoney(r.refund_price);if(amountToCents(refund_price)!>amountToCents(quoted_price)!)throw new ValidateException('主动退款金额超过已核对的商品报价');return{...selected,quoted_price,refund_price,quote_fingerprint:financialHash(r.quote_fingerprint),reason:financialText(r.reason)};}
export function financialRefundTarget(value:Record<string,unknown>):FinancialRefundTarget {return{refund_id:financialId(value.refund_id),refund_no:financialBusinessNumber(value.refund_no,50),expected_refund_revision:financialHash(value.expected_refund_revision),review_fingerprint:financialHash(value.review_fingerprint)};}
export function financialDecision(kind:FinancialKind,value:unknown):FinancialDecision {
 const keys=['refund_id','refund_no','expected_refund_revision','review_fingerprint','decision',...(kind==='refund_refuse'?['reason']:kind==='refund_execute'?['refund_price']:[])],r=financialRecord(value,keys),d=financialRecord(r.decision,['apply_type','refund_type','received']);
 if(typeof d.apply_type!=='number'||![0,1,2,3,4].includes(d.apply_type)||typeof d.refund_type!=='number'||![0,1,2,4,5].includes(d.refund_type)||typeof d.received!=='boolean')throw new ValidateException('退款决策快照无效');
 if(kind==='refund_return'&&(![2,3].includes(d.apply_type)||![0,1,2].includes(d.refund_type)))throw new ValidateException('当前售后状态不能审批退货');
 if(kind==='refund_execute'&&![1,2,3,4].includes(d.apply_type))throw new ValidateException('历史售后类型缺少可证明的资金执行合同，请核对原申请');
 if(kind==='refund_execute'&&[2,3].includes(d.apply_type)&&(!d.received||d.apply_type===2&&d.refund_type!==5||d.apply_type===3&&![4,5].includes(d.refund_type)))throw new ValidateException('退货退款必须先审批退货并确认已经实际验收');
 return{...financialRefundTarget(r),decision:{apply_type:d.apply_type,refund_type:d.refund_type,received:d.received},...(kind==='refund_refuse'?{reason:financialText(r.reason)}:{}),...(kind==='refund_execute'?{refund_price:financialMoney(r.refund_price)}:{})};
}
export function validateFinancialPayload(kind:FinancialKind,value:unknown) {
 if(kind==='change_price'){const r=financialRecord(value,['price']);return{price:financialMoney(r.price)};}
 if(kind==='confirm_offline')return financialRecord(value,[]);
 if(kind==='refund_create')return financialCreation(value);
 if(kind==='refund_remark'){const r=financialRecord(value,['refund_id','refund_no','expected_refund_revision','review_fingerprint','remark']);return{...financialRefundTarget(r),remark:financialText(r.remark)};}
 return financialDecision(kind,value);
}
export async function prepareFinancialOperation(kind:FinancialKind,context:FinancialContext,value:unknown):Promise<PreparedFinancialOperation> {
 if(!CUSTOMER_FINANCIAL_KINDS.includes(kind))throw new ValidateException('财务操作种类无效');const actor=freezeCustomerActor(context.actor),key=normalizeOutRequestKey(context.request_key),r=financialRecord(freezeCustomerJson(value),['version','scope_key','order_id','expected_order_revision','expected_financial_revision','payload']);
 if(r.version!==CUSTOMER_FINANCIAL_VERSION)throw new ValidateException('财务操作协议无效');validateFinancialPayload(kind,r.payload);
 const input=Object.freeze({version:CUSTOMER_FINANCIAL_VERSION,scope_key:financialHash(r.scope_key),order_id:financialId(r.order_id),expected_order_revision:financialHash(r.expected_order_revision),expected_financial_revision:financialHash(r.expected_financial_revision),payload:r.payload as CustomerJson});
 return Object.freeze({actor,key,kind,input,hash:await outRequestHash({version:CUSTOMER_FINANCIAL_VERSION,actor_uid:actor.uid,kind,input})});
}
export function parseFinancialQuote(value:unknown):FinancialQuoteInput {const r=financialRecord(freezeCustomerJson(value),['version','scope_key','order_id','expected_order_revision','expected_financial_revision','mode','items']);if(r.version!==CUSTOMER_FINANCIAL_QUOTE_VERSION)throw new ValidateException('退款报价协议无效');return{version:CUSTOMER_FINANCIAL_QUOTE_VERSION,scope_key:financialHash(r.scope_key),order_id:financialId(r.order_id),expected_order_revision:financialHash(r.expected_order_revision),expected_financial_revision:financialHash(r.expected_financial_revision),...financialSelections(r.mode,r.items)};}
/** Full UUID bits plus original ordinary actor realm. Never an Admin ID. */
export function customerFinancialRefundNumber(uid:number,key:string):string {customerWorkId(uid);const hex=normalizeOutRequestKey(key).replaceAll('-',''),bytes=hex.match(/../g)!.map(x=>parseInt(x,16)),encoded=btoa(String.fromCharCode(...bytes)).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');return`CR${uid.toString(36)}_${encoded}`;}
