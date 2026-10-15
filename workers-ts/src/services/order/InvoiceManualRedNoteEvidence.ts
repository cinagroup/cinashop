import {asc,eq,inArray,sql,getTableColumns} from 'drizzle-orm';
import type {DbClient} from '@/lib/di';
import {storeOrder} from '@/models/schema';
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
 if(!('manual_disposition' in value)||!value.manual_disposition||typeof value.manual_disposition!=='object')throw manualRedInvalid();
 const d=value.manual_disposition;
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

