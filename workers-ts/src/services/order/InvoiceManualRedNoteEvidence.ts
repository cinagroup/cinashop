import {asc,eq,inArray,sql,getTableColumns} from 'drizzle-orm';
import type {DbClient} from '@/lib/di';
import {storeOrder,storeOrderInvoice,storeOrderRefund} from '@/models/schema';
import {storeOrderRefundSplit} from '@/models/schema/order_refund_split';
import {assertSupplierProactiveRefundReady} from '@/migrations/supplierProactiveRefund';
import {outRequestHash} from '@/services/out/OutIdempotency';
import {refundOrderSplitFingerprint} from './RefundOrderSplitIdentity';
import {readRefundQuantityReservation,refundClaimCartKey} from './RefundQuantityReservation';
import {storeOrderInvoiceEvidence} from '@/models/schema/invoice_evidence';
import {storeOrderInvoiceManualRedNote as notes,storeOrderInvoiceManualRedReview as reviews} from '@/models/schema/invoice_manual_red_note';
import {invoiceManualRedNoteReadiness} from '@/migrations/invoiceManualRedNoteCatalog';
import {ValidateException} from '@/utils/errors';
import {manualRedDigest,manualRedJson,manualRedMoney,manualRedObject,exactKeys,manualRedId,manualRedUuid,parseManualRedRecordPayload,parseManualRedReviewPayload,manualRedRecordIntentHash,manualRedReviewIntentHash,type ManualRedRecordView} from './InvoiceManualRedNoteProtocol';
import {amountToCents} from '@/services/payment/RefundGateway';
type RecordRow=typeof notes.$inferSelect;type ReviewRow=typeof reviews.$inferSelect;
export const manualRedInvalid=()=>new ValidateException('原票与人工红字票据未完整核对，不能退款或拆单');
export async function readBoundManualRedNote(record:RecordRow,review:ReviewRow|null):Promise<ManualRedRecordView>{
 const p=parseManualRedRecordPayload(record.recordJson);
 if(record.id!==p.request_id||record.invoiceId!==p.invoice_id||record.sourceOrderId!==p.source_order_id||record.paymentOrderId!==p.payment_order_id||record.uid!==p.uid||record.actorId!==p.actor_id||record.createdTime!==p.created_time
 ||await manualRedDigest(record.recordJson)!==record.recordHash||await manualRedDigest(p.original.snapshot)!==p.original.snapshot_hash||await manualRedDigest(p.platform.content)!==p.platform.content_hash
 ||record.requestHash!==await manualRedRecordIntentHash(p.invoice_id,p.actor_id,{request_id:p.request_id,original_document_number:p.original.document_number,original_snapshot_hash:p.original.snapshot_hash,original_amount:p.original.amount,currency:p.currency,red_document_number:p.red.document_number,red_amount:p.red.amount,platform_evidence:p.platform.content}))throw manualRedInvalid();
 let projected:ManualRedRecordView['review']=null;
 if(review){const v=parseManualRedReviewPayload(review.reviewJson);
  if(review.id!==v.request_id||review.recordId!==record.id||review.recordHash!==record.recordHash||v.record_id!==record.id||v.record_hash!==record.recordHash
   ||review.invoiceId!==record.invoiceId||review.sourceOrderId!==record.sourceOrderId||review.paymentOrderId!==record.paymentOrderId||review.uid!==record.uid
   ||v.invoice_id!==record.invoiceId||v.source_order_id!==record.sourceOrderId||v.payment_order_id!==record.paymentOrderId||v.uid!==record.uid
   ||review.actorId!==v.actor_id||review.decision!==v.decision||review.createdTime!==v.created_time||review.originalDocumentNumber!==p.original.document_number||review.redDocumentNumber!==p.red.document_number
   ||v.original_document_number!==p.original.document_number||v.red_document_number!==p.red.document_number||await manualRedDigest(review.reviewJson)!==review.reviewHash
   ||review.requestHash!==await manualRedReviewIntentHash(v.invoice_id,v.record_id,v.actor_id,{request_id:v.request_id,record_hash:v.record_hash,decision:v.decision,manual_checked:v.manual_checked,review_note:v.review_note}))throw manualRedInvalid();
  projected={id:review.id,review_hash:review.reviewHash,actor_id:review.actorId,created_time:review.createdTime,decision:review.decision as 'confirm'|'reject',manual_checked:true,review_note:v.review_note};
 }
 return{id:record.id,record_hash:record.recordHash,actor_id:record.actorId,created_time:record.createdTime,original_document_number:p.original.document_number,original_snapshot_hash:p.original.snapshot_hash,original_amount:p.original.amount,currency:'CNY',
 red_document_number:p.red.document_number,red_amount:p.red.amount,platform_evidence:p.platform.content,platform_evidence_hash:p.platform.content_hash,state:projected?projected.decision==='confirm'?'MANUAL_REVIEWED':'REJECTED':'RECORDED',review:projected};
}
export async function manualRedRows(tx:DbClient,invoiceIds:readonly number[]){
 if(!invoiceIds.length)return[];
 const headers=await tx.select({id:notes.id,bytes:sql<number>`octet_length(${notes.recordJson})`}).from(notes).where(inArray(notes.invoiceId,[...invoiceIds])).orderBy(asc(notes.id)).limit(201);
 if(headers.length>200||headers.some(r=>r.bytes<=0||r.bytes>65536))throw manualRedInvalid();
 const records=headers.length?await tx.select().from(notes).where(inArray(notes.id,headers.map(r=>r.id))).orderBy(asc(notes.id)):[];
 const rs=records.length?await tx.select().from(reviews).where(inArray(reviews.recordId,records.map(r=>r.id))).orderBy(asc(reviews.id)).limit(201):[];
 if(records.length!==headers.length||rs.length>records.length)throw manualRedInvalid();
 return Promise.all(records.map(async record=>{const matching=rs.filter(r=>r.recordId===record.id);if(matching.length>1)throw manualRedInvalid();return{record,view:await readBoundManualRedNote(record,matching[0]??null)};}));
}
export interface ManualInvoiceDisposition {version:'invoice-manual-disposition-v1';coverage_hash:string;coverage_count:number;invoice_ids:number[];review_ids:string[]}
/** Only a fully checked new disposition changes financial review hashes. An
 * ordinary deployment with no new maintenance tables retains its v1 input. */
export async function financialManualInvoiceDisposition(tx:DbClient,source:typeof storeOrder.$inferSelect):Promise<ManualInvoiceDisposition|null>{
 const ids=source.pid>0?[source.pid,source.id]:[source.id];
 const [present]=await tx.execute<{present:boolean}>(sql`SELECT to_regclass('public.store_order_invoice_manual_red_note') IS NOT NULL
  AND to_regclass('public.store_order_invoice_manual_red_review') IS NOT NULL AS present`);
 if(present?.present!==true||!(await invoiceManualRedNoteReadiness(tx)).ready)return null;
 const [permission]=await tx.execute<{safe:boolean}>(sql`SELECT has_table_privilege(current_user,'public.store_order_invoice_evidence','SELECT') AS safe`);
 if(permission?.safe!==true)return null;
 const [candidate]=await tx.execute<{candidate:boolean}>(sql`SELECT EXISTS(SELECT 1 FROM public.store_order_invoice_evidence WHERE order_id IN(${sql.join(ids.map(n=>sql`${n}`),sql`,`)}) AND kind='issued') AS candidate`);
 if(candidate?.candidate!==true)return null;
 try{return await readInvoiceManualDisposition(tx,source);}catch(error){if(error instanceof ValidateException)return null;throw error;}
}
export async function readInvoiceManualDisposition(tx:DbClient,source:typeof storeOrder.$inferSelect):Promise<ManualInvoiceDisposition>{
 // The additional manual realm is optional for mature unissued allocation.
 // Check its fixed public metadata and reader authority before touching its
 // original-document rows; an unavailable realm is a business rejection.
 if(!(await invoiceManualRedNoteReadiness(tx)).ready)throw manualRedInvalid();
 const ids=source.pid>0?[source.pid,source.id]:[source.id];
 const [unknown]=await tx.execute<{blocked:boolean}>(sql`SELECT EXISTS(SELECT 1 FROM public.store_order_invoice_evidence e WHERE e.order_id IN(${sql.join(ids.map(n=>sql`${n}`),sql`,`)}) AND e.kind='unverified')
  OR EXISTS(SELECT 1 FROM public.store_order_invoice i WHERE i.order_id IN(${sql.join(ids.map(n=>sql`${n}`),sql`,`)}) AND NOT EXISTS(SELECT 1 FROM public.store_order_invoice_evidence e WHERE e.invoice_id=i.id AND e.kind='created' AND e.document_number='')) AS blocked`);
 if(unknown?.blocked!==false)throw manualRedInvalid();
 const issued=await tx.select({...getTableColumns(storeOrderInvoiceEvidence),originalAmount:sql<string>`${storeOrderInvoiceEvidence.snapshot}::jsonb->'invoice'->>'invoice_amount'`}).from(storeOrderInvoiceEvidence).where(inArray(storeOrderInvoiceEvidence.orderId,ids)).orderBy(asc(storeOrderInvoiceEvidence.invoiceId),asc(storeOrderInvoiceEvidence.documentNumber)).limit(403);
 const actual=issued.filter(r=>r.kind==='issued');if(issued.length>402||!actual.length||!(await invoiceManualRedNoteReadiness(tx)).ready)throw manualRedInvalid();
 const records=await manualRedRows(tx,[...new Set(actual.map(r=>r.invoiceId))]);
 const coverage:Array<{invoice_id:number;document_number:string;snapshot_hash:string;record_id:string;record_hash:string;review_id:string;review_hash:string}>=[];
 const [root]=await tx.select().from(storeOrder).where(eq(storeOrder.id,source.pid>0?source.pid:source.id)).limit(1);
 if(!root||root.uid!==source.uid||root.paid!==1||root.payType!==source.payType)throw manualRedInvalid();
 for(const e of actual){
  const snapshotHash=await manualRedDigest(e.snapshot),matching=records.filter(r=>r.view.state==='MANUAL_REVIEWED'&&r.record.invoiceId===e.invoiceId&&r.view.original_document_number===e.documentNumber&&r.view.original_snapshot_hash===snapshotHash);
  if(e.uid!==source.uid||matching.length!==1)throw manualRedInvalid();const {record,view}=matching[0],p=parseManualRedRecordPayload(record.recordJson);
  let snapshot:unknown;try{snapshot=JSON.parse(e.snapshot);}catch{throw manualRedInvalid();}
  if(!snapshot||typeof snapshot!=='object'||!('invoice' in snapshot)||!snapshot.invoice||typeof snapshot.invoice!=='object'||!('invoice_amount' in snapshot.invoice))throw manualRedInvalid();
  if(record.sourceOrderId!==e.orderId||record.paymentOrderId!==root.id||record.uid!==source.uid||p.original.snapshot!==e.snapshot||manualRedMoney(e.originalAmount)!==view.original_amount||view.red_amount!==view.original_amount
   ||p.payment.id!==root.id||p.payment.uid!==root.uid||p.payment.order_number!==root.orderId||p.payment.pay_type!==root.payType||p.payment.pay_time!==root.payTime||p.payment.store_id!==root.storeId||p.payment.supplier_id!==root.supplierId||!view.review)throw manualRedInvalid();
  const [actualSource]=await tx.select().from(storeOrder).where(eq(storeOrder.id,e.orderId)).limit(1);
  if(!actualSource||p.source.id!==actualSource.id||p.source.uid!==actualSource.uid||p.source.order_number!==actualSource.orderId||p.source.pay_type!==actualSource.payType||p.source.pay_time!==actualSource.payTime||p.source.store_id!==actualSource.storeId||p.source.supplier_id!==actualSource.supplierId)throw manualRedInvalid();
  coverage.push({invoice_id:e.invoiceId,document_number:e.documentNumber,snapshot_hash:snapshotHash,record_id:record.id,record_hash:record.recordHash,review_id:view.review.id,review_hash:view.review.review_hash});
 }
 return{version:'invoice-manual-disposition-v1',coverage_hash:await manualRedDigest(manualRedJson(coverage,262144)),coverage_count:coverage.length,invoice_ids:[...new Set(coverage.map(r=>r.invoice_id))],review_ids:coverage.map(r=>r.review_id)};
}
/** Verify only the frozen original coverage. Later legitimate issuance does not
 * rewrite the source of a completed refund, and missing/changed frozen evidence
 * can never turn into another payment. */
export async function assertStoredManualInvoiceAllocation(tx:DbClient,text:string,uid:number,paymentOrderId:number,mode:'reader'|'admin-read'='reader'):Promise<void>{
 let value:unknown;try{value=JSON.parse(text);}catch{throw manualRedInvalid();}
 if(value&&typeof value==='object'&&'version' in value&&value.version===SUPPLIER_WHOLE_INVOICE_VERSION){
  await assertStoredSupplierProactiveInvoiceAllocation(tx,text,uid,paymentOrderId,mode);return;
 }
 if(!value||typeof value!=='object'||!('version' in value)||value.version!=='refund-invoice-allocation-manual-red-v2')return;
 const allocation=manualRedObject(manualRedJson(value));exactKeys(allocation,['version','sourceOrderId','paymentOrderId','original','manual_disposition','selected','remaining']);
 const original=manualRedObject(manualRedJson(allocation.original));
 if(manualRedId(allocation.paymentOrderId)!==paymentOrderId||manualRedId(original.orderId)!==manualRedId(allocation.sourceOrderId)||original.uid!==uid)throw manualRedInvalid();
 const targets=[manualRedObject(manualRedJson(allocation.selected)),...(allocation.remaining===null?[]:[manualRedObject(manualRedJson(allocation.remaining))])];
 let sum=0;
 for(const target of targets){exactKeys(target,['invoiceId','orderId','amount']);const invoiceId=manualRedId(target.invoiceId),orderId=manualRedId(target.orderId),amount=manualRedMoney(target.amount);
 const [created]=await tx.select({uid:storeOrderInvoiceEvidence.uid,orderId:storeOrderInvoiceEvidence.orderId,amount:sql<string>`${storeOrderInvoiceEvidence.snapshot}::jsonb->'invoice'->>'invoice_amount'`}).from(storeOrderInvoiceEvidence).where(sql`${storeOrderInvoiceEvidence.invoiceId}=${invoiceId} AND ${storeOrderInvoiceEvidence.kind}='created' AND ${storeOrderInvoiceEvidence.documentNumber}=''`).limit(1);
 if(!created||created.uid!==uid||created.orderId!==orderId||created.amount!==amount)throw manualRedInvalid();sum+=amountToCents(amount)!;}
 if(sum!==amountToCents(manualRedMoney(original.invoiceAmount)))throw manualRedInvalid();
 await assertStoredManualInvoiceDisposition(tx,allocation.manual_disposition,uid,paymentOrderId,mode);
}
/** Verify a frozen full original-document disposition without manufacturing a
 * v2 allocation or another red-note success. Historical v2 uses the same checks. */
export async function assertStoredManualInvoiceDisposition(tx:DbClient,value:unknown,uid:number,paymentOrderId:number,mode:'reader'|'admin-read'='reader'):Promise<void>{
 if(!value||typeof value!=='object'||Array.isArray(value))throw manualRedInvalid();
 const d=value;
 exactKeys(manualRedObject(manualRedJson(d)),['version','coverage_hash','coverage_count','invoice_ids','review_ids']);
 if(!('version' in d)||d.version!=='invoice-manual-disposition-v1'||!('coverage_hash' in d)||typeof d.coverage_hash!=='string'||!/^[a-f0-9]{64}$/.test(d.coverage_hash)
 ||!('coverage_count' in d)||typeof d.coverage_count!=='number'||!Number.isSafeInteger(d.coverage_count)||d.coverage_count<1||d.coverage_count>200
 ||!('review_ids' in d)||!Array.isArray(d.review_ids)||d.review_ids.length!==d.coverage_count||d.review_ids.some(id=>typeof id!=='string'||!/^[a-f0-9-]{36}$/.test(id))||new Set(d.review_ids).size!==d.review_ids.length
 ||!('invoice_ids' in d)||!Array.isArray(d.invoice_ids)||d.invoice_ids.some(id=>typeof id!=='number'||!Number.isSafeInteger(id)||id<1)||new Set(d.invoice_ids).size!==d.invoice_ids.length
 ||!(await invoiceManualRedNoteReadiness(tx,mode)).ready)throw manualRedInvalid();
 const frozenReviews=await tx.select().from(reviews).where(inArray(reviews.id,d.review_ids as string[])).limit(201);
 for(const id of d.review_ids)manualRedUuid(id);
 if(frozenReviews.length!==d.coverage_count)throw manualRedInvalid();
 const frozenRecords=await tx.select().from(notes).where(inArray(notes.id,frozenReviews.map(r=>r.recordId))).limit(201);
 const coverage=[];
 for(const id of d.review_ids){const review=frozenReviews.find(r=>r.id===id),record=review&&frozenRecords.find(r=>r.id===review.recordId);
 if(!review||!record||review.decision!=='confirm'||record.uid!==uid||record.paymentOrderId!==paymentOrderId)throw manualRedInvalid();
 const view=await readBoundManualRedNote(record,review),p=parseManualRedRecordPayload(record.recordJson);
 const [issued]=await tx.select().from(storeOrderInvoiceEvidence).where(sql`${storeOrderInvoiceEvidence.invoiceId}=${record.invoiceId} AND ${storeOrderInvoiceEvidence.kind}='issued' AND ${storeOrderInvoiceEvidence.documentNumber}=${view.original_document_number}`).limit(1);
 if(!issued||issued.uid!==uid||issued.orderId!==record.sourceOrderId||issued.snapshot!==p.original.snapshot||await manualRedDigest(issued.snapshot)!==view.original_snapshot_hash)throw manualRedInvalid();
 coverage.push({invoice_id:record.invoiceId,document_number:view.original_document_number,snapshot_hash:view.original_snapshot_hash,record_id:record.id,record_hash:record.recordHash,review_id:review.id,review_hash:review.reviewHash});}
 if(await manualRedDigest(manualRedJson(coverage,262144))!==d.coverage_hash||manualRedJson([...new Set(coverage.map(r=>r.invoice_id))])!==manualRedJson(d.invoice_ids))throw manualRedInvalid();
}
export async function invoiceHasReportedHistory(tx:DbClient,source:typeof storeOrder.$inferSelect){
 const ids=source.pid>0?[source.pid,source.id]:[source.id];
 // Use the same original evidence relation as the existing invoice readers.
 // Only the new manual realm is fixed to public; this probe also runs in the
 // separately owned source schema with its established SELECT-only grant.
 const reported=tx.select({id:storeOrderInvoiceEvidence.invoiceId}).from(storeOrderInvoiceEvidence)
  .where(sql`${storeOrderInvoiceEvidence.orderId} IN(${sql.join(ids.map(n=>sql`${n}`),sql`,`)}) AND ${storeOrderInvoiceEvidence.kind} IN('issued','unverified')`).limit(1);
 const [row]=await tx.execute<{reported:boolean}>(sql`SELECT EXISTS(${reported}) AS reported`);
 return row?.reported===true;
}


/** Whole-goods concessions retain the complete original tax document. This
 * version never means that a provider issued or red-noted a document. */
export const SUPPLIER_WHOLE_INVOICE_VERSION='refund-invoice-allocation-supplier-whole-v3' as const;
const proactiveHash=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
// Purchase/payment identity survives this whole-goods materialization. Refund
// totals/status and later delivery/remark fields deliberately are not identity.
const proactiveOrderIdentityFields=[
 'id','pid','orderId','uid','supplierId','storeId','type','productType','activityId','pinkId',
 'paid','payType','payTime','tradeNo','totalNum','payPrice','totalPrice','totalPostage','payPostage','freightPrice',
 'payIntegral','deductionPrice','couponId','couponPrice','promotionsPrice','firstOrderPrice','changePrice',
 'gainIntegral','useIntegral','cost','spreadUid','spreadTwoUid','oneBrokerage','twoBrokerage',
 'divisionId','divisionBrokerage','divisionAgentId','divisionAgentBrokerage','divisionStaffId','divisionStaffBrokerage',
 'addTime','unique',
] as const satisfies readonly (keyof typeof storeOrder.$inferSelect)[];
export function assertSupplierProactiveInvoiceOrderIdentity(original:unknown,current:unknown):void{
 const before=proactiveObject(original),after=proactiveObject(current);
 if(proactiveOrderIdentityFields.some(key=>!Object.hasOwn(before,key)||!Object.hasOwn(after,key)||before[key]!==after[key]))throw manualRedInvalid();
}

function proactiveObject(value:unknown):Record<string,unknown>{
 if(!value||typeof value!=='object'||Array.isArray(value))throw manualRedInvalid();return value as Record<string,unknown>;
}
function proactiveCents(value:unknown):number{const result=amountToCents(manualRedMoney(value));if(result===null||result<0)throw manualRedInvalid();return result;}
function proactiveUuid(value:unknown):string{
 if(typeof value!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value))throw manualRedInvalid();return value;
}
function proactiveJson(text:unknown,max:number):Record<string,unknown>{
 if(typeof text!=='string'||new TextEncoder().encode(text).length>max)throw manualRedInvalid();
 try{return proactiveObject(JSON.parse(text));}catch{throw manualRedInvalid();}
}
interface ProactiveOperationRow extends Record<string,unknown>{
 operation_id:string;actor_id:number;supplier_id:number;order_id:number;state:string;kind:string;request_hash:string;
 intent:unknown;intent_json:string;source:unknown;source_json:string;source_hash:string;result:unknown;
}
export interface SupplierWholeInvoiceBinding {
 operationId:string;actorId:number;supplierId:number;orderId:number;refundId:number;requestHash:string;
 firstRefunded:string;original:object;sourceHash?:string;
}
/** Read the actual immutable admission by its original UUID. The execution
 * phase source has legitimate reservation changes and is not its source hash. */
export async function readSupplierProactiveInvoiceOperation(tx:DbClient,binding:SupplierWholeInvoiceBinding){
 if(Object.hasOwn(tx,'$client'))throw manualRedInvalid();
 proactiveUuid(binding.operationId);const expectedInvoice=proactiveObject(binding.original);await assertSupplierProactiveRefundReady(tx,'read');
 const rows=await tx.execute<ProactiveOperationRow>(sql`SELECT operation_id::text,actor_id,supplier_id,order_id,state,kind,request_hash,
  intent,intent_json,source,source_json,source_hash,result FROM public.supplier_proactive_refund_operation_v1
  WHERE operation_id=${binding.operationId}::uuid AND octet_length(intent_json)<=16384 AND octet_length(source_json)<=16777216 LIMIT 2`);
 if(rows.length!==1)throw manualRedInvalid();const row=rows[0];
 const intent=proactiveJson(row.intent_json,16384),source=proactiveJson(row.source_json,16777216),result=proactiveObject(row.result);
 if(row.operation_id!==binding.operationId||row.actor_id!==binding.actorId||row.supplier_id!==binding.supplierId||row.order_id!==binding.orderId
  ||row.state!=='committed'||row.kind!=='goods'||row.request_hash!==binding.requestHash||!proactiveHash(row.source_hash)
  ||binding.sourceHash!==undefined&&binding.sourceHash!==row.source_hash||result.refund_id!==binding.refundId
  ||await manualRedDigest(row.intent_json)!==row.request_hash||await outRequestHash(intent)!==row.request_hash||await outRequestHash(row.intent)!==row.request_hash
  ||await manualRedDigest(row.source_json)!==row.source_hash||await outRequestHash(source)!==row.source_hash||await outRequestHash(row.source)!==row.source_hash
  ||intent.version!=='supplier-proactive-refund-intent-v1'||intent.operation_id!==row.operation_id||intent.actor_id!==row.actor_id
  ||intent.supplier_id!==row.supplier_id||intent.order_id!==row.order_id||intent.type!==1||intent.refund_price!==binding.firstRefunded
  ||source.version!=='supplier-proactive-refund-source-v1'||!Array.isArray(source.invoices)||source.invoices.length>200
  ||!Array.isArray(source.carts)||!source.carts.length||source.carts.length>200)throw manualRedInvalid();
 const order=proactiveObject(source.order),invoices=source.invoices.map(proactiveObject),original=invoices.filter(r=>r.id===expectedInvoice.id);
 // Hash agreement authenticates bytes, not a different protocol shape. Check
 // the closed stored intent without inventing a live Supplier actor or
 // claiming to re-evaluate the historical authVersion-bound revision MAC.
 exactKeys(intent,['version','operation_id','actor_id','supplier_id','order_id','revision','refund_price','type',
  ...(Object.hasOwn(intent,'cash_returned')?['cash_returned']:[])]);
 const channel=order.payType,cash=channel==='cash'||channel==='offline',hasCash=Object.hasOwn(intent,'cash_returned');
 if(!proactiveHash(intent.revision)||manualRedMoney(intent.refund_price)!==binding.firstRefunded
  ||!['cash','offline','yue','weixin','alipay','integral'].includes(String(channel))
  ||(cash&&proactiveCents(binding.firstRefunded)>0?(!hasCash||intent.cash_returned!==true):hasCash))throw manualRedInvalid();

 if(order.id!==binding.orderId||order.supplierId!==binding.supplierId||order.uid!==expectedInvoice.uid||order.paid!==1
  ||expectedInvoice.orderId!==order.id
  ||order.payPrice!==expectedInvoice.invoiceAmount||original.length!==1||await outRequestHash(original[0])!==await outRequestHash(binding.original)
  ||invoices.filter(r=>r.isDel===0).length!==1)throw manualRedInvalid();
 return {sourceHash:row.source_hash,source,order,carts:source.carts.map(proactiveObject)};
}

/** Durable readers require both immutable admission and terminal decision.
 * A serialized flag, a provider callback or today's invoice alone cannot
 * authorize the special full-document / smaller-cash allocation. */
export async function assertStoredSupplierProactiveInvoiceAllocation(tx:DbClient,text:string,uid:number,paymentOrderId:number,
 mode:'reader'|'admin-read'='reader'):Promise<void>{
 const a=proactiveJson(text,16384);exactKeys(a,['version','operation_id','actor_id','supplier_id','request_hash','source_hash',
  'sourceOrderId','paymentOrderId','refundId','fingerprint','original','after_hash','selected','remaining','goods_quantity',
  'first_refunded','unreturned_payment','manual_disposition']);
 if(a.version!==SUPPLIER_WHOLE_INVOICE_VERSION||a.paymentOrderId!==paymentOrderId||!proactiveHash(a.request_hash)
  ||!proactiveHash(a.source_hash)||!proactiveHash(a.fingerprint)||!proactiveHash(a.after_hash)||a.remaining!==null)throw manualRedInvalid();
 const operationId=proactiveUuid(a.operation_id),actorId=manualRedId(a.actor_id),supplierId=manualRedId(a.supplier_id),orderId=manualRedId(a.sourceOrderId),refundId=manualRedId(a.refundId);
 const original=proactiveObject(a.original),chosen=proactiveObject(a.selected);exactKeys(chosen,['invoiceId','orderId','amount']);
 const invoiceId=manualRedId(original.id),firstRefunded=manualRedMoney(a.first_refunded),unreturned=manualRedMoney(a.unreturned_payment),amount=manualRedMoney(original.invoiceAmount);
 if(original.uid!==uid||original.orderId!==orderId||original.category!=='order'||original.isPay!==1||original.isDel!==0||original.isRefund!==0
  ||![-1,0,1].includes(Number(original.isInvoice))||typeof original.invoiceNumber!=='string'||chosen.invoiceId!==invoiceId||chosen.orderId!==orderId||chosen.amount!==amount
  ||!Number.isSafeInteger(a.goods_quantity)||Number(a.goods_quantity)<1||proactiveCents(firstRefunded)+proactiveCents(unreturned)!==proactiveCents(amount))throw manualRedInvalid();
 const bound=await readSupplierProactiveInvoiceOperation(tx,{operationId,actorId,supplierId,orderId,refundId,requestHash:a.request_hash,
  sourceHash:a.source_hash,firstRefunded,original});
 if((bound.order.pid||bound.order.id)!==paymentOrderId||bound.order.totalNum!==a.goods_quantity)throw manualRedInvalid();
 const [refund]=await tx.select().from(storeOrderRefund).where(eq(storeOrderRefund.id,refundId)).limit(1),
  [record]=await tx.select().from(storeOrderRefundSplit).where(eq(storeOrderRefundSplit.refundId,refundId)).limit(1);
 if(!refund||!record||refund.uid!==uid||refund.supplierId!==supplierId||refund.storeOrderId!==orderId||refund.refundType!==6
  ||refund.isDel||refund.isCancel||refund.refundPrice!==firstRefunded||refund.refundedPrice!==firstRefunded||refund.refundNum!==a.goods_quantity
  ||record.invoiceAllocation!==text||record.disposition!=='whole'||record.sourceOrderId!==orderId||record.selectedOrderId!==orderId||record.remainingOrderId!==null
  ||record.paymentOrderId!==paymentOrderId||record.uid!==uid||record.supplierId!==supplierId||record.fingerprint!==a.fingerprint
  ||record.fingerprint!==await refundOrderSplitFingerprint(refund))throw manualRedInvalid();
 const archived=proactiveJson(record.sourceSnapshot,16777216);
 if(archived.version!=='refund-order-materialization-v1')throw manualRedInvalid();
 const [selectedOrder]=await tx.select().from(storeOrder).where(eq(storeOrder.id,record.selectedOrderId)).limit(1);
 if(!selectedOrder)throw manualRedInvalid();
 assertSupplierProactiveInvoiceOrderIdentity(bound.order,archived.source);
 assertSupplierProactiveInvoiceOrderIdentity(bound.order,selectedOrder);
 const claim=readRefundQuantityReservation(refund);
 if(!claim||claim.items.length!==bound.carts.length||claim.items.some(item=>{const c=bound.carts.find(row=>row.id===item.rowId);
  return !c||c.oid!==orderId||c.uid!==uid||c.cartId!==refundClaimCartKey(item)||c.cartNum!==item.totalNum||item.cartNum!==item.totalNum||item.beforeRefundNum!==0;}))throw manualRedInvalid();
 const decisions=await tx.execute<{actor_id:number;supplier_id:number;order_id:number;kind:string;outcome:string;request_hash:string;evidence:unknown;evidence_json:string;evidence_hash:string}>(sql`
  SELECT actor_id,supplier_id,order_id,kind,outcome,request_hash,evidence,evidence_json,evidence_hash
  FROM public.supplier_proactive_refund_decision_v1 WHERE operation_id=${operationId}::uuid AND octet_length(evidence_json)<=16777216 LIMIT 2`);
 if(decisions.length!==1)throw manualRedInvalid();const decision=decisions[0],evidence=proactiveJson(decision.evidence_json,16777216);
 if(decision.actor_id!==actorId||decision.supplier_id!==supplierId||decision.order_id!==orderId||decision.kind!=='goods'
  ||decision.outcome!==(['weixin','alipay'].includes(String(bound.order.payType))?'provider-admitted':'local-settled')
  ||decision.request_hash!==a.request_hash||evidence.refund_id!==refundId
  ||!proactiveHash(decision.evidence_hash)||await manualRedDigest(decision.evidence_json)!==decision.evidence_hash
  ||await outRequestHash(evidence)!==decision.evidence_hash||await outRequestHash(decision.evidence)!==decision.evidence_hash)throw manualRedInvalid();
 const invoices=await tx.select().from(storeOrderInvoice).where(sql`${storeOrderInvoice.orderId} IN(${orderId},${paymentOrderId}) AND ${storeOrderInvoice.isDel}=0`).limit(3);
 const after={...original,isRefund:1};
 if(invoices.length!==1||invoices[0].id!==invoiceId||await outRequestHash(invoices[0])!==await outRequestHash(after)
  ||await outRequestHash(after)!==a.after_hash)throw manualRedInvalid();
 const [created]=await tx.select().from(storeOrderInvoiceEvidence).where(sql`${storeOrderInvoiceEvidence.invoiceId}=${invoiceId}
  AND ${storeOrderInvoiceEvidence.kind}='created' AND ${storeOrderInvoiceEvidence.documentNumber}=''`).limit(1);
 if(!created||created.uid!==uid||created.orderId!==orderId)throw manualRedInvalid();
 if(a.manual_disposition===null){
  if(![0,-1].includes(Number(original.isInvoice))||original.invoiceNumber!=='')throw manualRedInvalid();
  const reported=await tx.select({id:storeOrderInvoiceEvidence.invoiceId}).from(storeOrderInvoiceEvidence)
   .where(sql`${storeOrderInvoiceEvidence.orderId} IN(${orderId},${paymentOrderId}) AND ${storeOrderInvoiceEvidence.kind} IN('issued','unverified')`).limit(1);
  if(reported.length)throw manualRedInvalid();
 }else{
  await assertStoredManualInvoiceDisposition(tx,a.manual_disposition,uid,paymentOrderId,mode);
  const disposition=proactiveObject(a.manual_disposition);
  if((original.isInvoice===1||original.invoiceNumber!=='')&&(!Array.isArray(disposition.invoice_ids)||!disposition.invoice_ids.includes(invoiceId)))throw manualRedInvalid();
 }
}
