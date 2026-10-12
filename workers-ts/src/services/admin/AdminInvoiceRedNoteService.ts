import {and,asc,eq,sql,getTableColumns} from 'drizzle-orm';
import {withTx,type Container,type DbClient} from '@/lib/di';
import {storeOrder,storeOrderInvoice} from '@/models/schema';
import {storeOrderInvoiceEvidence as evidence} from '@/models/schema/invoice_evidence';
import {storeOrderInvoiceManualRedNote as notes,storeOrderInvoiceManualRedReview as reviews} from '@/models/schema/invoice_manual_red_note';
import {invoiceManualRedNoteReadiness} from '@/migrations/invoiceManualRedNoteCatalog';
import {customerManualGuestIdentityReadiness} from '@/migrations/guestRefundEntityCatalog';
import {ValidateException} from '@/utils/errors';
import {lockOrderSettlement} from '@/services/order/OrderBrokerageService';
import {manualRedInvalid,manualRedRows,readBoundManualRedNote} from '@/services/order/InvoiceManualRedNoteEvidence';
import {INVOICE_MANUAL_RED_NOTE_VERSION,INVOICE_MANUAL_RED_REVIEW_VERSION,manualRedDigest,manualRedId,manualRedJson,manualRedMoney,manualRedUuid,parseManualRedRecordInput,parseManualRedReviewInput,parseManualRedRecordPayload,manualRedRecordIntentHash,manualRedReviewIntentHash,
 type ManualRedSourceIdentity,type ManualRedRecordPayload,type ManualRedReviewPayload,type ManualRedNoteList,type ManualRedOperationReceipt} from '@/services/order/InvoiceManualRedNoteProtocol';
type Order=typeof storeOrder.$inferSelect;
export async function assertAdminInvoiceGuestIdentity(tx:DbClient,order:Pick<Order,'uid'>,write=false){
 if(order.uid!==0)return;if(!(await customerManualGuestIdentityReadiness(tx)).ready)throw new ValidateException('游客发票完整实体保护未就绪');
 const [authority]=await tx.execute<{safe:boolean}>(sql`SELECT current_setting('server_version_num')::integer/10000=16
 AND (SELECT count(*)=2 AND count(DISTINCT relowner)=1 FROM pg_class WHERE oid IN(to_regclass('public.store_order'),to_regclass('public.store_order_invoice')))
 AND has_table_privilege(current_user,'public.store_order','SELECT') AND has_table_privilege(current_user,'public.store_order_invoice','SELECT') AND has_table_privilege(current_user,'public.store_order_invoice_evidence','SELECT')
 AND (NOT ${write} OR has_table_privilege(current_user,'public.store_order_invoice','UPDATE')) AS safe`);
 if(authority?.safe!==true)throw new ValidateException('游客发票实际订单所有权或读写权限未核对');
 const [row]=await tx.execute<{safe:boolean}>(sql`SELECT NOT EXISTS(SELECT 1 FROM public."user" WHERE uid=0) AND NOT EXISTS(SELECT 1 FROM public.user_bill WHERE uid=0) AND NOT EXISTS(SELECT 1 FROM public.user_brokerage WHERE uid=0) AS safe`);
 if(row?.safe!==true)throw new ValidateException('游客不能关联账户、余额或积分记录');
}
function identity(o:Order):ManualRedSourceIdentity{return{id:o.id,order_number:o.orderId,uid:o.uid,pid:o.pid,paid:o.paid,pay_type:o.payType,pay_time:o.payTime,store_id:o.storeId,supplier_id:o.supplierId};}
async function limits(tx:DbClient){await tx.execute(sql`SELECT set_config('statement_timeout','5000ms',true),set_config('lock_timeout','2000ms',true),set_config('idle_in_transaction_session_timeout','5000ms',true)`);}
async function origins(tx:DbClient,invoiceId:number,lock=false){
 const histories=await tx.select({...getTableColumns(evidence),originalAmount:sql<string>`${evidence.snapshot}::jsonb->'invoice'->>'invoice_amount'`}).from(evidence).where(eq(evidence.invoiceId,invoiceId)).orderBy(asc(evidence.documentNumber)).limit(403);
 const [invoice]=await tx.select().from(storeOrderInvoice).where(eq(storeOrderInvoice.id,invoiceId)).limit(1);
 if(histories.length>402||!histories.length&&!invoice)throw manualRedInvalid();
 const orderId=histories[0]?.orderId??invoice!.orderId,uid=histories[0]?.uid??invoice!.uid;
 if(histories.some(e=>e.orderId!==orderId||e.uid!==uid)||invoice&&(invoice.orderId!==orderId||invoice.uid!==uid||invoice.category!=='order'))throw manualRedInvalid();
 const [initial]=await tx.select().from(storeOrder).where(eq(storeOrder.id,orderId)).limit(1);if(!initial)throw manualRedInvalid();
 const rootId=initial.pid>0?initial.pid:initial.id;
 if(lock){await lockOrderSettlement(tx,rootId);await tx.select({id:storeOrder.id}).from(storeOrder).where(eq(storeOrder.id,rootId)).for('update');
 if(rootId!==initial.id){await lockOrderSettlement(tx,initial.id);await tx.select({id:storeOrder.id}).from(storeOrder).where(eq(storeOrder.id,initial.id)).for('update');}
 if(invoice)await tx.select({id:storeOrderInvoice.id}).from(storeOrderInvoice).where(eq(storeOrderInvoice.id,invoiceId)).for('update');}
 const [root]=await tx.select().from(storeOrder).where(eq(storeOrder.id,rootId)).limit(1),[source]=await tx.select().from(storeOrder).where(eq(storeOrder.id,orderId)).limit(1);
 if(!root||!source||root.uid!==uid||source.uid!==uid||source.pid!==initial.pid||source.orderId!==initial.orderId||root.paid!==1||source.paid!==1||root.payType!==source.payType||root.isDel||root.isSystemDel||source.isDel||source.isSystemDel
 ||(source.pid>0&&root.pid!==-1)||(root.supplierId!==source.supplierId&&!(root.supplierId===0&&root.supplierAllocationStatus===2))||(root.storeId!==source.storeId&&root.supplierAllocationStatus!==2))throw manualRedInvalid();
 await assertAdminInvoiceGuestIdentity(tx,source);
 const [unknown]=await tx.execute<{blocked:boolean}>(sql`SELECT EXISTS(SELECT 1 FROM public.store_order_invoice_evidence WHERE order_id IN(${root.id},${source.id}) AND kind='unverified')
 OR EXISTS(SELECT 1 FROM public.store_order_invoice i WHERE i.order_id IN(${root.id},${source.id}) AND NOT EXISTS(SELECT 1 FROM public.store_order_invoice_evidence e WHERE e.invoice_id=i.id AND e.kind='created' AND e.document_number='')) AS blocked`);
 return{source,root,histories,unknown:unknown?.blocked!==false};
}
async function original(tx:DbClient,invoiceId:number,number:string,snapshotHash:string,amount:string,lock=true){
 const context=await origins(tx,invoiceId,lock);if(context.unknown)throw manualRedInvalid();
 const matches=context.histories.filter(e=>e.kind==='issued'&&e.documentNumber===number);
 if(matches.length!==1||await manualRedDigest(matches[0].snapshot)!==snapshotHash)throw manualRedInvalid();
 const e=matches[0];let p:unknown;try{p=JSON.parse(e.snapshot);}catch{throw manualRedInvalid();}
 if(!p||typeof p!=='object'||!('v' in p)||p.v!==1||!('invoice' in p)||!p.invoice||typeof p.invoice!=='object')throw manualRedInvalid();const i=p.invoice;
 if(!('id' in i)||i.id!==invoiceId||!('uid' in i)||i.uid!==context.source.uid||!('order_id' in i)||i.order_id!==context.source.id||!('category' in i)||i.category!=='order'
 ||!('invoice_number' in i)||i.invoice_number!==number||!('invoice_amount' in i)||manualRedMoney(e.originalAmount)!==amount||!('is_pay' in i)||i.is_pay!==1)throw manualRedInvalid();
 return{...context,e};
}
export class AdminInvoiceRedNoteService{
 constructor(private readonly container:Container){}
 async list(invoiceIdInput:unknown):Promise<ManualRedNoteList>{
 const invoiceId=manualRedId(invoiceIdInput);return withTx<ManualRedNoteList>(this.container,async tx=>{
 await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);await limits(tx);const c=await origins(tx,invoiceId),ready=await invoiceManualRedNoteReadiness(tx,'admin-read');
 const records=ready.ready?await manualRedRows(tx,[invoiceId]):[],issues=[...(c.unknown?['存在未核验票据，不能凭红字录入洗白历史']:[]),...(ready.ready?[]:[ready.reason])];
 const issued=[];for(const e of c.histories.filter(e=>e.kind==='issued')){
 let p:unknown;try{p=JSON.parse(e.snapshot);}catch{throw manualRedInvalid();}if(!p||typeof p!=='object'||!('invoice' in p)||!p.invoice||typeof p.invoice!=='object'||!('invoice_amount' in p.invoice))throw manualRedInvalid();
 const snapshot_hash=await manualRedDigest(e.snapshot),rs=records.filter(r=>r.view.original_document_number===e.documentNumber&&r.view.original_snapshot_hash===snapshot_hash).map(r=>r.view);
 issued.push({document_number:e.documentNumber,snapshot_hash,original_amount:manualRedMoney(e.originalAmount),manual_state:rs.some(r=>r.state==='MANUAL_REVIEWED')?'MANUAL_REVIEWED' as const:'UNCOVERED' as const,records:rs});}
 return{invoice_id:invoiceId,source_order_id:c.source.id,payment_order_id:c.root.id,uid:c.source.uid,currency:'CNY',ready:ready.ready,can_record:ready.ready&&!c.unknown&&issued.length>0,issues,issued};
 });}
 private async receipt(tx:DbClient,invoiceId:number,requestId:string,actorId:number,expectedHash?:string):Promise<ManualRedOperationReceipt|null>{
 const nr=await tx.select().from(notes).where(eq(notes.id,requestId)).limit(2),rr=await tx.select().from(reviews).where(eq(reviews.id,requestId)).limit(2);
 if(nr.length+rr.length===0)return null;if(nr.length+rr.length!==1)throw manualRedInvalid();
 const r=nr[0]??rr[0];if(r.invoiceId!==invoiceId||r.actorId!==actorId||expectedHash!==undefined&&r.requestHash!==expectedHash)throw new ValidateException('原请求属于不同管理员、申请或人工操作');
 const record=nr[0]??(await tx.select().from(notes).where(eq(notes.id,rr[0].recordId)).limit(1))[0];if(!record)throw manualRedInvalid();
 const terminal=await tx.select().from(reviews).where(eq(reviews.recordId,record.id)).limit(2);if(terminal.length>1)throw manualRedInvalid();
 const view=await readBoundManualRedNote(record,terminal[0]??null);
 if(rr.length&&view.review?.id!==requestId)throw manualRedInvalid();
 return{version:'invoice-manual-red-operation-v1',request_id:requestId,invoice_id:invoiceId,actor_id:actorId,kind:nr.length?'record':'review',request_hash:r.requestHash,committed:true,idempotent:true,record:view};
 }
 async operation(invoiceIdInput:unknown,requestIdInput:unknown,actorIdInput:number){
 const invoiceId=manualRedId(invoiceIdInput),requestId=manualRedUuid(requestIdInput),actorId=manualRedId(actorIdInput);
 return withTx(this.container,async tx=>{await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);await limits(tx);if(!(await invoiceManualRedNoteReadiness(tx,'admin-read')).ready)throw manualRedInvalid();
 const receipt=await this.receipt(tx,invoiceId,requestId,actorId);if(!receipt)throw new ValidateException('原人工请求未查到已提交凭据，请保留原请求核对');return receipt;});
 }
 async record(invoiceIdInput:unknown,body:Record<string,unknown>,actorIdInput:number):Promise<ManualRedOperationReceipt>{
 const invoiceId=manualRedId(invoiceIdInput),actorId=manualRedId(actorIdInput),input=parseManualRedRecordInput(body),requestHash=await manualRedRecordIntentHash(invoiceId,actorId,input);
 return withTx<ManualRedOperationReceipt>(this.container,async tx=>{
 await limits(tx);if(!(await invoiceManualRedNoteReadiness(tx,'admin-read')).ready)throw manualRedInvalid();
 await tx.execute(sql`SELECT pg_advisory_xact_lock(731702,hashtext(${input.request_id}))`);
 const earlier=await this.receipt(tx,invoiceId,input.request_id,actorId,requestHash);if(earlier){if(earlier.kind!=='record')throw manualRedInvalid();return earlier;}
 if(!(await invoiceManualRedNoteReadiness(tx,'admin-write')).ready)throw manualRedInvalid();
 const c=await original(tx,invoiceId,input.original_document_number,input.original_snapshot_hash,input.original_amount),now=Math.floor(Date.now()/1000);
 if(!(await invoiceManualRedNoteReadiness(tx,'admin-write')).ready)throw manualRedInvalid();
 const existing=await tx.select({id:reviews.id}).from(reviews).where(and(eq(reviews.invoiceId,invoiceId),eq(reviews.originalDocumentNumber,input.original_document_number),eq(reviews.decision,'confirm'))).limit(1);
 if(existing.length)throw new ValidateException('该原票已人工核对整票红冲，请读取原凭据');
 const p:ManualRedRecordPayload={version:INVOICE_MANUAL_RED_NOTE_VERSION,request_id:input.request_id,actor_id:actorId,invoice_id:invoiceId,source_order_id:c.source.id,payment_order_id:c.root.id,uid:c.source.uid,currency:'CNY',
 original:{document_number:input.original_document_number,snapshot_hash:input.original_snapshot_hash,amount:input.original_amount,snapshot:c.e.snapshot},red:{document_number:input.red_document_number,amount:input.red_amount},
 platform:{kind:'manual-tax-platform',content:input.platform_evidence,content_hash:await manualRedDigest(input.platform_evidence)},payment:identity(c.root),source:identity(c.source),created_time:now};
 const json=manualRedJson(p),recordHash=await manualRedDigest(json);
 await tx.insert(notes).values({id:input.request_id,invoiceId,sourceOrderId:c.source.id,paymentOrderId:c.root.id,uid:c.source.uid,actorId,requestHash,recordHash,recordJson:json,createdTime:now});
 const receipt=await this.receipt(tx,invoiceId,input.request_id,actorId,requestHash);if(!receipt||!(await invoiceManualRedNoteReadiness(tx,'admin-write')).ready)throw manualRedInvalid();return{...receipt,idempotent:false};
 });}
 async review(invoiceIdInput:unknown,recordIdInput:unknown,body:Record<string,unknown>,actorIdInput:number):Promise<ManualRedOperationReceipt>{
 const invoiceId=manualRedId(invoiceIdInput),recordId=manualRedUuid(recordIdInput),actorId=manualRedId(actorIdInput),input=parseManualRedReviewInput(body),requestHash=await manualRedReviewIntentHash(invoiceId,recordId,actorId,input);
 return withTx<ManualRedOperationReceipt>(this.container,async tx=>{
 await limits(tx);if(!(await invoiceManualRedNoteReadiness(tx,'admin-read')).ready)throw manualRedInvalid();
 await tx.execute(sql`SELECT pg_advisory_xact_lock(731702,hashtext(${input.request_id}))`);
 const earlier=await this.receipt(tx,invoiceId,input.request_id,actorId,requestHash);if(earlier){if(earlier.kind!=='review'||earlier.record.id!==recordId)throw manualRedInvalid();return earlier;}
 if(!(await invoiceManualRedNoteReadiness(tx,'admin-write')).ready)throw manualRedInvalid();
 const [r]=await tx.select().from(notes).where(eq(notes.id,recordId)).limit(1);if(!r||r.invoiceId!==invoiceId||r.recordHash!==input.record_hash)throw manualRedInvalid();const p=parseManualRedRecordPayload(r.recordJson);
 const context=await original(tx,invoiceId,p.original.document_number,p.original.snapshot_hash,p.original.amount);
 if(!(await invoiceManualRedNoteReadiness(tx,'admin-write')).ready)throw manualRedInvalid();
 for(const [saved,actual] of [[p.payment,context.root],[p.source,context.source]] as const){if(saved.id!==actual.id||saved.uid!==actual.uid||saved.order_number!==actual.orderId||saved.pay_type!==actual.payType||saved.pay_time!==actual.payTime||saved.store_id!==actual.storeId||saved.supplier_id!==actual.supplierId)throw manualRedInvalid();}
 if(input.decision==='confirm'){
 await tx.execute(sql`SELECT pg_advisory_xact_lock(731703,hashtext(${p.red.document_number}))`);
 const conflict=await tx.select({id:reviews.id}).from(reviews).where(and(eq(reviews.decision,'confirm'),sql`(${reviews.redDocumentNumber}=${p.red.document_number} OR (${reviews.invoiceId}=${invoiceId} AND ${reviews.originalDocumentNumber}=${p.original.document_number}))`)).limit(1);
 if(conflict.length)throw new ValidateException('原票或红票已被已核对凭据覆盖，不能重复认定');
 }
 const terminal=await tx.select().from(reviews).where(eq(reviews.recordId,recordId)).limit(1);if(terminal.length)throw new ValidateException('该人工录入已核对，请读取原核对凭据');
 const now=Math.floor(Date.now()/1000),review:ManualRedReviewPayload={version:INVOICE_MANUAL_RED_REVIEW_VERSION,request_id:input.request_id,record_id:recordId,record_hash:r.recordHash,actor_id:actorId,invoice_id:invoiceId,source_order_id:r.sourceOrderId,payment_order_id:r.paymentOrderId,uid:r.uid,
 original_document_number:p.original.document_number,red_document_number:p.red.document_number,decision:input.decision,manual_checked:true,review_note:input.review_note,created_time:now};
 const json=manualRedJson(review,4096),reviewHash=await manualRedDigest(json);
 await tx.insert(reviews).values({id:input.request_id,recordId,invoiceId,sourceOrderId:r.sourceOrderId,paymentOrderId:r.paymentOrderId,uid:r.uid,actorId,decision:input.decision,originalDocumentNumber:p.original.document_number,redDocumentNumber:p.red.document_number,requestHash,recordHash:r.recordHash,reviewHash,reviewJson:json,createdTime:now});
 const receipt=await this.receipt(tx,invoiceId,input.request_id,actorId,requestHash);if(!receipt||!(await invoiceManualRedNoteReadiness(tx,'admin-write')).ready)throw manualRedInvalid();return{...receipt,idempotent:false};
 });}
}

