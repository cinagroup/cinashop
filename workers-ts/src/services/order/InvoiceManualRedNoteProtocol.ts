import { ValidateException } from '@/utils/errors';
export const INVOICE_MANUAL_RED_NOTE_VERSION='invoice-manual-red-note-v1' as const;
export const INVOICE_MANUAL_RED_REVIEW_VERSION='invoice-manual-red-review-v1' as const;
export const MANUAL_RED_PLATFORM_EVIDENCE_MAX=4096;
export const MANUAL_RED_REVIEW_NOTE_MAX=1024;
export type ManualRedDecision='confirm'|'reject';
export type ManualRedState='RECORDED'|'MANUAL_REVIEWED'|'REJECTED';
export interface ManualRedRecordInput {
 request_id:string;original_document_number:string;original_snapshot_hash:string;original_amount:string;currency:'CNY';
 red_document_number:string;red_amount:string;platform_evidence:string;
}
export interface ManualRedReviewInput {
 request_id:string;record_hash:string;decision:ManualRedDecision;manual_checked:true;review_note:string;
}
export interface ManualRedSourceIdentity {id:number;order_number:string;uid:number;pid:number;paid:number;pay_type:string;pay_time:number;store_id:number;supplier_id:number}
export interface ManualRedRecordPayload {
 version:typeof INVOICE_MANUAL_RED_NOTE_VERSION;request_id:string;actor_id:number;invoice_id:number;source_order_id:number;payment_order_id:number;uid:number;
 currency:'CNY';original:{document_number:string;snapshot_hash:string;amount:string;snapshot:string};
 red:{document_number:string;amount:string};platform:{kind:'manual-tax-platform';content:string;content_hash:string};
 payment:ManualRedSourceIdentity;source:ManualRedSourceIdentity;created_time:number;
}
export interface ManualRedReviewPayload {
 version:typeof INVOICE_MANUAL_RED_REVIEW_VERSION;request_id:string;record_id:string;record_hash:string;actor_id:number;
 invoice_id:number;source_order_id:number;payment_order_id:number;uid:number;original_document_number:string;red_document_number:string;
 decision:ManualRedDecision;manual_checked:true;review_note:string;created_time:number;
}
export interface ManualRedRecordView {
 id:string;record_hash:string;actor_id:number;created_time:number;original_document_number:string;original_snapshot_hash:string;original_amount:string;currency:'CNY';
 red_document_number:string;red_amount:string;platform_evidence:string;platform_evidence_hash:string;state:ManualRedState;
 review:null|{id:string;review_hash:string;actor_id:number;created_time:number;decision:ManualRedDecision;manual_checked:true;review_note:string};
}
export interface ManualRedNoteList {
 invoice_id:number;source_order_id:number;payment_order_id:number;uid:number;currency:'CNY';ready:boolean;can_record:boolean;issues:string[];
 issued:Array<{document_number:string;snapshot_hash:string;original_amount:string;manual_state:'UNCOVERED'|'MANUAL_REVIEWED';records:ManualRedRecordView[]}>;
}
export interface ManualRedOperationReceipt {
 version:'invoice-manual-red-operation-v1';request_id:string;invoice_id:number;actor_id:number;kind:'record'|'review';request_hash:string;
 committed:true;idempotent:boolean;record:ManualRedRecordView;
}
const invalid=()=>new ValidateException('人工红字票据参数或证据不一致，请重新核对');
export function exactKeys(value:Record<string,unknown>,names:readonly string[]){if(Object.keys(value).length!==names.length||names.some(n=>!Object.hasOwn(value,n)))throw invalid();}
export function manualRedId(value:unknown,guest=false):number{const n=typeof value==='number'?value:typeof value==='string'&&/^(0|[1-9]\d*)$/.test(value)?Number(value):NaN;if(!Number.isSafeInteger(n)||n<(guest?0:1)||n>2147483647)throw invalid();return n;}
export function manualRedUuid(value:unknown):string{if(typeof value!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value))throw invalid();return value;}
export function manualRedHash(value:unknown):string{if(typeof value!=='string'||!/^[a-f0-9]{64}$/.test(value))throw invalid();return value;}
export function manualRedMoney(value:unknown):string{if(typeof value!=='string'||!/^(0|[1-9]\d{0,9})\.\d{2}$/.test(value))throw invalid();return value;}
export function manualRedText(value:unknown,max:number,required=true):string{if(typeof value!=='string'||value!==value.trim()||required&&!value||new TextEncoder().encode(value).length>max||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value))throw invalid();for(let i=0;i<value.length;i++){const n=value.charCodeAt(i);if(n>=0xd800&&n<=0xdbff){const next=value.charCodeAt(++i);if(!(next>=0xdc00&&next<=0xdfff))throw invalid();}else if(n>=0xdc00&&n<=0xdfff)throw invalid();}return value;}
function document(value:unknown):string{if(typeof value!=='string'||!/^\d{8,20}$/.test(value))throw invalid();return value;}
/** Preserve the actual legacy issued identifier. A red-note input must not
 * normalize or invent another identifier for an existing blue document. */
export function manualRedOriginalDocument(value:unknown):string{if(typeof value!=='string'||!value.trim()||Array.from(value).length>50||/[\u0000-\u001f\u007f]/.test(value))throw invalid();return value;}
export function parseManualRedRecordInput(body:Record<string,unknown>):ManualRedRecordInput{
 exactKeys(body,['request_id','original_document_number','original_snapshot_hash','original_amount','currency','red_document_number','red_amount','platform_evidence']);
 if(body.currency!=='CNY')throw invalid();
 const input={request_id:manualRedUuid(body.request_id),original_document_number:manualRedOriginalDocument(body.original_document_number),original_snapshot_hash:manualRedHash(body.original_snapshot_hash),
 original_amount:manualRedMoney(body.original_amount),currency:'CNY' as const,red_document_number:document(body.red_document_number),red_amount:manualRedMoney(body.red_amount),platform_evidence:manualRedText(body.platform_evidence,MANUAL_RED_PLATFORM_EVIDENCE_MAX)};
 if(input.original_amount!==input.red_amount||input.original_document_number===input.red_document_number)throw invalid();return input;
}
export function parseManualRedReviewInput(body:Record<string,unknown>):ManualRedReviewInput{
 exactKeys(body,['request_id','record_hash','decision','manual_checked','review_note']);
 if((body.decision!=='confirm'&&body.decision!=='reject')||body.manual_checked!==true)throw invalid();
 return{request_id:manualRedUuid(body.request_id),record_hash:manualRedHash(body.record_hash),decision:body.decision as ManualRedDecision,manual_checked:true,review_note:manualRedText(body.review_note,MANUAL_RED_REVIEW_NOTE_MAX)};
}
export async function manualRedDigest(text:string){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)))].map(n=>n.toString(16).padStart(2,'0')).join('');}
export function manualRedRecordIntentHash(invoiceId:number,actorId:number,input:ManualRedRecordInput){return manualRedDigest(JSON.stringify(['invoice-manual-red-record-intent-v1',invoiceId,actorId,input.original_document_number,input.original_snapshot_hash,input.original_amount,input.currency,input.red_document_number,input.red_amount,input.platform_evidence]));}
export function manualRedReviewIntentHash(invoiceId:number,recordId:string,actorId:number,input:ManualRedReviewInput){return manualRedDigest(JSON.stringify(['invoice-manual-red-review-intent-v1',invoiceId,recordId,actorId,input.record_hash,input.decision,input.manual_checked,input.review_note]));}
export function manualRedJson(value:unknown,max=65536){const text=JSON.stringify(value);if(typeof text!=='string'||new TextEncoder().encode(text).length>max)throw invalid();return text;}
export function manualRedObject(text:string):Record<string,unknown>{let value:unknown;try{value=JSON.parse(text);}catch{throw invalid();}if(!value||typeof value!=='object'||Array.isArray(value))throw invalid();return value as Record<string,unknown>;}
function payloadId(value:unknown,guest=false):number{if(typeof value!=='number')throw invalid();return manualRedId(value,guest);}
function payloadIdentity(value:unknown):ManualRedSourceIdentity{
 const o=manualRedObject(manualRedJson(value));exactKeys(o,['id','order_number','uid','pid','paid','pay_type','pay_time','store_id','supplier_id']);
 if(typeof o.pid!=='number'||!Number.isSafeInteger(o.pid)||o.pid<-1||o.pid>2147483647||o.paid!==1)throw invalid();
 return{id:payloadId(o.id),order_number:manualRedText(o.order_number,50),uid:payloadId(o.uid,true),pid:o.pid,paid:1,
  pay_type:manualRedText(o.pay_type,30),pay_time:payloadId(o.pay_time,true),store_id:payloadId(o.store_id,true),supplier_id:payloadId(o.supplier_id,true)};
}
export function parseManualRedRecordPayload(text:string):ManualRedRecordPayload{
 const p=manualRedObject(text);exactKeys(p,['version','request_id','actor_id','invoice_id','source_order_id','payment_order_id','uid','currency','original','red','platform','payment','source','created_time']);
 if(p.version!==INVOICE_MANUAL_RED_NOTE_VERSION||p.currency!=='CNY')throw invalid();
 const original=manualRedObject(manualRedJson(p.original)),red=manualRedObject(manualRedJson(p.red)),platform=manualRedObject(manualRedJson(p.platform));
 exactKeys(original,['document_number','snapshot_hash','amount','snapshot']);exactKeys(red,['document_number','amount']);exactKeys(platform,['kind','content','content_hash']);
 const input=parseManualRedRecordInput({request_id:p.request_id,original_document_number:original.document_number,original_snapshot_hash:original.snapshot_hash,original_amount:original.amount,currency:p.currency,red_document_number:red.document_number,red_amount:red.amount,platform_evidence:platform.content});
 if(platform.kind!=='manual-tax-platform')throw invalid();
 const payment=payloadIdentity(p.payment),source=payloadIdentity(p.source),uid=payloadId(p.uid,true),source_order_id=payloadId(p.source_order_id),payment_order_id=payloadId(p.payment_order_id);
 if(payment.uid!==uid||source.uid!==uid||payment.id!==payment_order_id||source.id!==source_order_id)throw invalid();
 return{version:INVOICE_MANUAL_RED_NOTE_VERSION,request_id:input.request_id,actor_id:payloadId(p.actor_id),invoice_id:payloadId(p.invoice_id),source_order_id,payment_order_id,uid,currency:'CNY',
  original:{document_number:input.original_document_number,snapshot_hash:input.original_snapshot_hash,amount:input.original_amount,snapshot:manualRedText(original.snapshot,16384)},
  red:{document_number:input.red_document_number,amount:input.red_amount},platform:{kind:'manual-tax-platform',content:input.platform_evidence,content_hash:manualRedHash(platform.content_hash)},payment,source,created_time:payloadId(p.created_time)};
}
export function parseManualRedReviewPayload(text:string):ManualRedReviewPayload{
 const p=manualRedObject(text);exactKeys(p,['version','request_id','record_id','record_hash','actor_id','invoice_id','source_order_id','payment_order_id','uid','original_document_number','red_document_number','decision','manual_checked','review_note','created_time']);
 if(p.version!==INVOICE_MANUAL_RED_REVIEW_VERSION)throw invalid();
 const input=parseManualRedReviewInput({request_id:p.request_id,record_hash:p.record_hash,decision:p.decision,manual_checked:p.manual_checked,review_note:p.review_note});
 return{version:INVOICE_MANUAL_RED_REVIEW_VERSION,request_id:input.request_id,record_id:manualRedUuid(p.record_id),record_hash:input.record_hash,actor_id:payloadId(p.actor_id),invoice_id:payloadId(p.invoice_id),
  source_order_id:payloadId(p.source_order_id),payment_order_id:payloadId(p.payment_order_id),uid:payloadId(p.uid,true),original_document_number:manualRedOriginalDocument(p.original_document_number),red_document_number:document(p.red_document_number),
  decision:input.decision,manual_checked:true,review_note:input.review_note,created_time:payloadId(p.created_time)};
}


