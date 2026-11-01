import { Buffer } from 'node:buffer';
import { asc, eq, inArray, sql } from 'drizzle-orm';
import type { Env } from '@/env';
import type { DbClient } from '@/lib/di';
import { storeOrder, storeOrderCartInfo, storeOrderRefund, storeOrderRefundPayment } from '@/models/schema';
import { assertRoutineRefundReadInTx, inspectRoutineRefundCatalog } from '@/migrations/routineRefund';
import { refundEntityAcceptedPairSql } from '@/migrations/guestRefundEntityCatalog';
import { assertRoutineShippingReadTx, inspectRoutineShippingCatalog } from '@/migrations/routineShipping';
import { loadRefundOrderGeneration } from '@/services/order/RefundOrderGeneration';
import { loadRefundFulfillmentBranch } from '@/services/order/RefundFulfillmentBranch';
import { readRefundGenerationMarker } from '@/services/order/RefundGenerationMarker';
import { assertAtomicRefundCompleted } from '@/services/order/RefundAtomicMaterialization';
import { readMaterializedRefundSnapshot } from '@/services/order/RefundReadSnapshot';
import { refundOrderSplitFingerprint } from '@/services/order/RefundOrderSplitIdentity';
import { amountToCents } from './RefundGateway';
import { assertRoutineRefundProjectionTx } from './RoutineRefundProvider';
import { captureRoutineShippingEnv, routineShippingUnavailable, shippingEqual, shippingMac, shippingObject, shippingSame } from './RoutineShippingAccount';

type Signing=Pick<Env,'APP_KEY'>;
type Order=typeof storeOrder.$inferSelect;
type Cart=typeof storeOrderCartInfo.$inferSelect;
type Dict=Record<string,unknown>;
interface Payment {rootId:number;buyerUid:number;orderNo:string;transactionId:string;totalAmount:number}
interface RefundRef {refundId:number;fingerprint:string;sourceOrderId:number;selectedOrderId:number;remainingOrderId:number|null;previousRefundId:number;baseBranchId:string|null;receiptDigest:string}
interface BranchRef {branchId:string;sourceBranchId:string|null;sourceRefundId:number;sourceOrderId:number;childOrderId:number;receiptDigest:string}
export interface RoutineShippingRefundGeneration {
 readonly format:1;
 readonly payment:Readonly<Payment>;
 readonly refunds:readonly Readonly<RefundRef>[];
 readonly branches:readonly Readonly<BranchRef>[];
 readonly activeOrderIds:readonly number[];
 readonly retiredOrderIds:readonly number[];
 readonly generationDigest:string;
}
interface Line {id:number;cartId:string;quantity:number;productId:number;skuUnique:string;marker:unknown}
interface Part {sourceRowId:number;sourceCartId:string;selectedRowId:number|null;remainingRowId:number|null;selectedNum:number;remainingNum:number}
interface HistoryRow extends Record<string,unknown> {
 refundId:number;fingerprint:string;uid:number;supplierId:number;storeId:number;sourceOrderId:number;paymentOrderId:number;
 selectedOrderId:number;remainingOrderId:number|null;disposition:string;previousRefundId:number;baseBranchId:string|null;
 invoiceAllocation:string;partitions:unknown;archive:unknown;receiptDigest:string;
}
interface BranchRow extends Record<string,unknown> {
 id:string;sourceBranchId:string|null;sourceRefundId:number;sourceOrderId:number;paymentOrderId:number;childOrderId:number;
 uid:number;supplierId:number;storeId:number;partitions:unknown;receiptDigest:string;
}
const fail=routineShippingUnavailable;
const positive=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>0&&v<=2147483647;
const nonnegative=(v:unknown):v is number=>v===0||positive(v);
const hex=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/u.test(v);
const branchId=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{32}$/u.test(v);
const optionalBranch=(v:unknown):v is string|null=>v===null||branchId(v);
const token=(v:unknown,max:number):v is string=>typeof v==='string'&&new RegExp(`^[A-Za-z0-9_-]{1,${max}}$`,'u').test(v);
function freeze<T>(v:T):T {if(v&&typeof v==='object'){for(const d of Object.values(Object.getOwnPropertyDescriptors(v)))if('value'in d)freeze(d.value);Object.freeze(v);}return v;}
function object(v:unknown):Dict {if(!v||typeof v!=='object'||Array.isArray(v))return fail();return v as Dict;}
function sortedIds(v:unknown):number[]{
 if(!Array.isArray(v)||v.length>64)return fail();
 const result:number[]=[];for(const id of v){if(!positive(id)||result.length&&id<=result[result.length-1])return fail();result.push(id);}return result;
}
/** A signed immutable description only. This parser neither reads current
 * rows nor authorizes an upload; the caller's format3 envelope pins its scope. */
export function parseRoutineShippingRefundGeneration(env:Signing,raw:unknown):Readonly<RoutineShippingRefundGeneration>{
 const p=shippingObject(raw,['format','payment','refunds','branches','activeOrderIds','retiredOrderIds','generationDigest']);
 const payment=shippingObject(p.payment,['rootId','buyerUid','orderNo','transactionId','totalAmount']);
 if(p.format!==1||!positive(payment.rootId)||!positive(payment.buyerUid)||!token(payment.orderNo,64)||payment.orderNo.length<2
  ||!token(payment.transactionId,100)||!positive(payment.totalAmount)||!hex(p.generationDigest)
  ||!Array.isArray(p.refunds)||!p.refunds.length||p.refunds.length>201||!Array.isArray(p.branches)||p.branches.length>201)return fail();
 const active=sortedIds(p.activeOrderIds),retired=sortedIds(p.retiredOrderIds),all=new Set([...active,...retired]);
 if(all.size!==active.length+retired.length||all.size>64)return fail();
 const refunds:RefundRef[]=[],branches:BranchRef[]=[];
 for(const rawRef of p.refunds){
  const r=shippingObject(rawRef,['refundId','fingerprint','sourceOrderId','selectedOrderId','remainingOrderId','previousRefundId','baseBranchId','receiptDigest']);
  if(!positive(r.refundId)||refunds.length&&r.refundId<=refunds[refunds.length-1].refundId||!hex(r.fingerprint)||!hex(r.receiptDigest)
   ||!positive(r.sourceOrderId)||!positive(r.selectedOrderId)||!(r.remainingOrderId===null||positive(r.remainingOrderId))
   ||!nonnegative(r.previousRefundId)||r.previousRefundId>=r.refundId||!optionalBranch(r.baseBranchId)
   ||!retired.includes(r.selectedOrderId)||r.remainingOrderId!==null&&!all.has(r.remainingOrderId)
   ||r.sourceOrderId!==payment.rootId&&!all.has(r.sourceOrderId)
   ||(r.remainingOrderId===null?r.selectedOrderId!==r.sourceOrderId:r.selectedOrderId===r.sourceOrderId||r.selectedOrderId===r.remainingOrderId))return fail();
  refunds.push({refundId:r.refundId,fingerprint:r.fingerprint,sourceOrderId:r.sourceOrderId,selectedOrderId:r.selectedOrderId,
   remainingOrderId:r.remainingOrderId,previousRefundId:r.previousRefundId,baseBranchId:r.baseBranchId,receiptDigest:r.receiptDigest});
 }
 if(new Set(refunds.map(r=>r.selectedOrderId)).size!==refunds.length||retired.some(id=>!refunds.some(r=>r.selectedOrderId===id)))return fail();
 for(const rawRef of p.branches){
  const r=shippingObject(rawRef,['branchId','sourceBranchId','sourceRefundId','sourceOrderId','childOrderId','receiptDigest']);
  if(!branchId(r.branchId)||branches.length&&r.branchId<=branches[branches.length-1].branchId||!optionalBranch(r.sourceBranchId)
   ||r.sourceBranchId===r.branchId||!nonnegative(r.sourceRefundId)||!r.sourceRefundId&&r.sourceBranchId===null
   ||!positive(r.sourceOrderId)||!positive(r.childOrderId)||!all.has(r.sourceOrderId)||!all.has(r.childOrderId)||!hex(r.receiptDigest))return fail();
  branches.push({branchId:r.branchId,sourceBranchId:r.sourceBranchId,sourceRefundId:r.sourceRefundId,
   sourceOrderId:r.sourceOrderId,childOrderId:r.childOrderId,receiptDigest:r.receiptDigest});
 }
 for(const r of refunds)if(r.previousRefundId&&!refunds.some(p=>p.refundId===r.previousRefundId)
  ||r.baseBranchId!==null&&!branches.some(b=>b.branchId===r.baseBranchId))return fail();
 for(const b of branches)if(b.sourceRefundId&&!refunds.some(r=>r.refundId===b.sourceRefundId)
  ||b.sourceBranchId!==null&&!branches.some(p=>p.branchId===b.sourceBranchId))return fail();
 const visited=new Set<string>(),visiting=new Set<string>();
 function dependency(key:string):void{
  if(visited.has(key))return;if(visiting.has(key)||visiting.size>402)return fail();visiting.add(key);
  if(key.startsWith('r:')){const r=refunds.find(v=>v.refundId===Number(key.slice(2)));if(!r)return fail();
   if(r.previousRefundId){const previous=refunds.find(v=>v.refundId===r.previousRefundId);if(!previous||previous.remainingOrderId!==r.sourceOrderId||previous.baseBranchId!==r.baseBranchId)return fail();dependency('r:'+previous.refundId);}
   if(r.baseBranchId){const b=branches.find(v=>v.branchId===r.baseBranchId);if(!b||b.childOrderId!==r.sourceOrderId)return fail();dependency('b:'+b.branchId);}
  }else{const b=branches.find(v=>v.branchId===key.slice(2));if(!b)return fail();
   if(b.sourceRefundId){const r=refunds.find(v=>v.refundId===b.sourceRefundId);if(!r||r.remainingOrderId!==b.sourceOrderId||r.baseBranchId!==b.sourceBranchId)return fail();dependency('r:'+r.refundId);}
   if(b.sourceBranchId){const previous=branches.find(v=>v.branchId===b.sourceBranchId);if(!previous||previous.childOrderId!==b.sourceOrderId)return fail();dependency('b:'+previous.branchId);}
   const siblings=branches.filter(v=>v.sourceOrderId===b.sourceOrderId&&v.sourceRefundId===b.sourceRefundId&&v.sourceBranchId===b.sourceBranchId);
   if(siblings.length!==2||new Set(siblings.map(v=>v.childOrderId)).size!==2||!siblings.some(v=>v.childOrderId===b.sourceOrderId))return fail();
  }visiting.delete(key);visited.add(key);
 }
 for(const r of refunds)dependency('r:'+r.refundId);for(const b of branches)dependency('b:'+b.branchId);
 const body={format:1 as const,payment:{rootId:payment.rootId,buyerUid:payment.buyerUid,orderNo:payment.orderNo,
  transactionId:payment.transactionId,totalAmount:payment.totalAmount},refunds,branches,activeOrderIds:active,retiredOrderIds:retired};
 if(Buffer.byteLength(JSON.stringify(body),'utf8')>65536||!shippingEqual(p.generationDigest,shippingMac(env,'refund-generation-v1',body)))return fail();
 return freeze({...body,generationDigest:p.generationDigest});
}
function marker(info:string|null):unknown{
 if(info===null||!info.includes('refund_order_generation')&&!info.includes('refund-order-line-finance-v1'))return null;
 if(Buffer.byteLength(info,'utf8')>65536)return fail();
 let parsed:unknown;try{parsed=JSON.parse(info);}catch{return fail();}
 const p=object(parsed);if(!Object.hasOwn(p,'refund_order_generation'))return fail();
 if(p.financial_version!=='refund-order-line-finance-v1')return fail();return readRefundGenerationMarker(p.refund_order_generation);
}
function line(raw:unknown):Line{
 const r=object(raw);
 if(!positive(r.id)||typeof r.cartId!=='string'||!r.cartId||r.cartId!==r.cartId.trim()||Array.from(r.cartId).length>128
  ||!positive(r.cartNum)||!positive(r.productId)||typeof r.skuUnique!=='string'||r.skuUnique.length>255
  ||r.cartInfo!==null&&typeof r.cartInfo!=='string')return fail();
 return{id:r.id,cartId:r.cartId,quantity:r.cartNum,productId:r.productId,skuUnique:r.skuUnique,marker:marker(r.cartInfo)};
}
function sameLines(expected:readonly Line[],actual:readonly Line[],checkMarker=true):void{
 const byId=new Map(expected.map(r=>[r.id,r]));
 if(!actual.length||actual.length>200||byId.size!==expected.length||expected.length!==actual.length
  ||new Set(actual.map(r=>r.id)).size!==actual.length||new Set(actual.map(r=>r.cartId)).size!==actual.length)return fail();
 for(const r of actual){const e=byId.get(r.id);if(!e||e.cartId!==r.cartId||e.quantity!==r.quantity||e.productId!==r.productId
  ||e.skuUnique!==r.skuUnique||checkMarker&&!shippingSame(e.marker,r.marker))return fail();}
}
function parts(raw:unknown):Part[]{
 if(!Array.isArray(raw)||!raw.length||raw.length>200)return fail();
 const result:Part[]=[];const sources=new Set<number>(),targets=new Set<number>();
 for(const value of raw){const p=shippingObject(value,['sourceRowId','sourceCartId','selectedRowId','remainingRowId','selectedNum','remainingNum']);
  if(!positive(p.sourceRowId)||sources.has(p.sourceRowId)||typeof p.sourceCartId!=='string'||!p.sourceCartId
   ||!nonnegative(p.selectedNum)||!nonnegative(p.remainingNum)||!positive(p.selectedNum+p.remainingNum)
   ||(p.selectedNum>0?!positive(p.selectedRowId):p.selectedRowId!==null)
   ||(p.remainingNum>0?!positive(p.remainingRowId):p.remainingRowId!==null))return fail();
  const selectedRowId=p.selectedRowId,remainingRowId=p.remainingRowId;
  if(selectedRowId!==null&&!positive(selectedRowId)||remainingRowId!==null&&!positive(remainingRowId))return fail();
  for(const id of[selectedRowId,remainingRowId])if(id!==null){if(targets.has(id))return fail();targets.add(id);}
  sources.add(p.sourceRowId);result.push({sourceRowId:p.sourceRowId,sourceCartId:p.sourceCartId,selectedRowId,
   remainingRowId,selectedNum:p.selectedNum,remainingNum:p.remainingNum});
 }return result;
}
/** Caller already owns the actual payment root, every family row and carts in
 * its writing transaction. This helper only SELECTs: no refund mutex, new row
 * lock, DDL, materialization, financial finalizer, registry or provider call. */
export async function readRoutineShippingRefundGenerationTx(tx:DbClient,signing:Signing,input:{root:Order;family:readonly Order[];carts:readonly Cart[]}):Promise<Readonly<RoutineShippingRefundGeneration>|null>{
 const env=captureRoutineShippingEnv({APP_KEY:signing.APP_KEY}),root={...input.root},family=input.family.map(r=>({...r})),carts=input.carts.map(r=>({...r}));
 try{
  const marked=carts.some(c=>marker(c.cartInfo)!==null),retiredFlag=family.some(o=>o.refundStatus===2||o.refundStatus===3||o.refundType===6);
  if(Object.hasOwn(tx,'$client')||!positive(root.id)||!positive(root.uid)||family.length>65||!family.length||carts.length>200)return fail();
  if(!await assertRoutineShippingReadTx(tx))return fail();
  const [context]=await tx.execute<{ready:boolean;splitPresent:boolean;branchPresent:boolean}>(sql`SELECT pg_catalog.current_setting('transaction_isolation')='read committed'
   AND pg_catalog.current_setting('transaction_read_only')='off' AND pg_catalog.current_schema()='public'
   AND NOT EXISTS(SELECT 1 FROM(VALUES('store_order'),('store_order_cart_info'),('store_order_refund'),('store_order_refund_payment'),
    ('store_order_refund_split'),('store_order_fulfillment_branch'),('store_order_invoice'),('store_order_invoice_evidence'),('store_order_invoice_allocation')) n(name)
    WHERE pg_catalog.to_regclass(n.name) IS DISTINCT FROM pg_catalog.to_regclass('public.'||n.name)) AS ready,
   pg_catalog.to_regclass('public.store_order_refund_split') IS NOT NULL AS "splitPresent",
   pg_catalog.to_regclass('public.store_order_fulfillment_branch') IS NOT NULL AS "branchPresent"`);
  if(context?.ready!==true)return fail();
  if(context.splitPresent!==context.branchPresent)return fail();
  if(!context.splitPresent){if(marked||retiredFlag)return fail();return null;}
  const orders=new Map(family.map(o=>[o.id,o])),total=amountToCents(root.payPrice);
  if(orders.size!==family.length||!shippingSame(orders.get(root.id),root)||![0,-1].includes(root.pid)
   ||root.paid!==1||root.payType!=='weixin'||!token(root.orderId,64)||!token(root.tradeNo,100)||total===null||!positive(total))return fail();
  const leaves=root.pid===0?[root]:family.filter(o=>o.pid===root.id),leafIds=new Set(leaves.map(o=>o.id));
  if(!leaves.length||leaves.length>64||family.length!==(root.pid===0?1:leaves.length+1)
   ||leaves.some(o=>o.uid!==root.uid||o.paid!==1||o.payType!=='weixin'||o.tradeNo!==''&&o.tradeNo!==root.tradeNo)
   ||carts.some(c=>!orders.has(c.oid)||c.uid!==root.uid))return fail();
  const shippingCatalog=await inspectRoutineShippingCatalog(tx),binding=shippingCatalog.binding;
  if(!shippingCatalog.ready||!binding)return fail();
  const entityPair=await tx.execute<{profile:string}>(sql.raw(refundEntityAcceptedPairSql(true)));
  const [owners]=await tx.execute<{ready:boolean}>(sql`SELECT pg_catalog.count(*)=5 AND pg_catalog.bool_and(c.relowner=${binding.maintenanceOid}::oid) AS ready
   FROM pg_catalog.pg_class c WHERE c.oid IN('public.store_order_invoice'::regclass,'public.store_order_invoice_evidence'::regclass,
    'public.store_order_invoice_allocation'::regclass,'public.store_order_refund_split'::regclass,'public.store_order_fulfillment_branch'::regclass)`);
  if(entityPair.length!==1||!['legacy','guest'].includes(entityPair[0].profile)||owners?.ready!==true)return fail();
  const records=await tx.execute<HistoryRow>(sql`WITH sample AS MATERIALIZED (
   SELECT * FROM public.store_order_refund_split WHERE payment_order_id=${root.id} ORDER BY refund_id LIMIT 202
  ), saved AS MATERIALIZED (
   SELECT t.*,pg_catalog.sum(pg_catalog.octet_length(t.source_snapshot)::bigint) OVER() AS archive_bytes,
    pg_catalog.sum(pg_catalog.octet_length(t.partitions)::bigint) OVER() AS partition_bytes
   FROM sample t
  ) SELECT refund_id AS "refundId",fingerprint,uid,supplier_id AS "supplierId",store_id AS "storeId",source_order_id AS "sourceOrderId",
   payment_order_id AS "paymentOrderId",selected_order_id AS "selectedOrderId",remaining_order_id AS "remainingOrderId",disposition,
   previous_refund_id AS "previousRefundId",base_branch_id AS "baseBranchId",invoice_allocation AS "invoiceAllocation",
   CASE WHEN partition_bytes<=8388608 AND pg_catalog.octet_length(partitions)<=131072 THEN partitions::jsonb END AS partitions,
   CASE WHEN archive_bytes<=16777216 AND pg_catalog.octet_length(source_snapshot)<=16777216 THEN
    pg_catalog.jsonb_build_object('version',source_snapshot::jsonb->'version','source',
     (SELECT pg_catalog.jsonb_object_agg(k,v) FROM pg_catalog.jsonb_each(source_snapshot::jsonb->'source') e(k,v)
      WHERE k IN('id','pid','uid','supplierId','storeId','orderId','tradeNo','payPrice','payType','paid','totalNum','type','payIntegral')),
     'payment',source_snapshot::jsonb->'payment','carts',
     (SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id',c->'id','oid',c->'oid','uid',c->'uid','cartId',c->'cartId',
      'cartNum',c->'cartNum','productId',c->'productId','skuUnique',c->'skuUnique','cartInfo',c->'cartInfo'))
      FROM pg_catalog.jsonb_array_elements(source_snapshot::jsonb->'carts') c)) END AS archive,
   CASE WHEN archive_bytes<=16777216 AND partition_bytes<=8388608 THEN pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
    (pg_catalog.to_jsonb(saved)-'archive_bytes'-'partition_bytes')::text,'UTF8')),'hex') END AS "receiptDigest"
   FROM saved ORDER BY refund_id`);
  if(records.length>201)return fail();
  const applications=await tx.select().from(storeOrderRefund).where(inArray(storeOrderRefund.storeOrderId,family.map(o=>o.id))).orderBy(asc(storeOrderRefund.id)).limit(202);
  if(applications.length>201)return fail();
  if(!records.length){if(marked||retiredFlag||applications.some(r=>r.refundType===6&&!r.isCancel))return fail();return null;}
  const requiresProvider=records.some(r=>{const a=applications.find(v=>v.id===r.refundId);return !a||amountToCents(a.refundPrice)!==0;});
  if(requiresProvider&&!await assertRoutineRefundReadInTx(tx,'app'))return fail();
  const refundCatalog=await inspectRoutineRefundCatalog(tx),refundBinding=refundCatalog.binding;
  if(refundCatalog.present&&(!refundCatalog.ready||!refundBinding||binding.maintenance!==refundBinding.maintenance
   ||binding.maintenanceOid!==refundBinding.maintenanceOid||binding.app!==refundBinding.app||binding.appOid!==refundBinding.appOid))return fail();
  const branchRows=await tx.execute<BranchRow>(sql`SELECT id,source_branch_id AS "sourceBranchId",source_refund_id AS "sourceRefundId",
   source_order_id AS "sourceOrderId",payment_order_id AS "paymentOrderId",child_order_id AS "childOrderId",uid,
   supplier_id AS "supplierId",store_id AS "storeId",CASE WHEN pg_catalog.octet_length(partitions)<=32768
    AND pg_catalog.sum(pg_catalog.octet_length(partitions)::bigint) OVER()<=8388608 THEN partitions::jsonb END AS partitions,
   pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.to_jsonb(t)::text,'UTF8')),'hex') AS "receiptDigest"
   FROM public.store_order_fulfillment_branch t WHERE payment_order_id=${root.id} ORDER BY id LIMIT 202`);
  if(branchRows.length>201||Buffer.byteLength(JSON.stringify([records,branchRows]),'utf8')>8388608)return fail();
  const byRefund=new Map(records.map(r=>[r.refundId,r])),byBranch=new Map(branchRows.map(b=>[b.id,b]));
  if(byRefund.size!==records.length||byBranch.size!==branchRows.length)return fail();
  for(const r of applications){
   if(!r.isCancel&&!r.isDel&&[0,1,2,4,5].includes(r.refundType))return fail();
   if(r.refundType===6&&!r.isCancel&&!byRefund.has(r.id))return fail();
  }
  const sourceLines=new Map<number,Line[]>(),partitionMap=new Map<number,Part[]>(),selectedByOrder=new Map<number,HistoryRow>();
  for(const r of records){
   const refund=applications.find(v=>v.id===r.refundId),source=orders.get(r.sourceOrderId),selected=orders.get(r.selectedOrderId);
   if(!positive(r.refundId)||!hex(r.fingerprint)||!hex(r.receiptDigest)||r.paymentOrderId!==root.id||r.uid!==root.uid||!source||!selected
    ||r.supplierId!==source.supplierId||r.storeId!==source.storeId||selected.supplierId!==r.supplierId||selected.storeId!==r.storeId||!leafIds.has(r.selectedOrderId)||selectedByOrder.has(r.selectedOrderId)
    ||!refund||refund.refundType!==6||refund.isCancel||amountToCents(refund.refundedPrice)!==amountToCents(refund.refundPrice)
    ||await refundOrderSplitFingerprint(refund)!==r.fingerprint||refund.storeOrderId!==r.sourceOrderId)return fail();
   const archive=shippingObject(r.archive,['version','source','payment','carts']),savedSource=object(archive.source),payment=shippingObject(archive.payment,['id','orderId','tradeNo','payPrice','payType']);
   if(archive.version!=='refund-order-materialization-v1'||savedSource.id!==source.id||savedSource.uid!==root.uid||savedSource.supplierId!==source.supplierId
    ||savedSource.storeId!==source.storeId||savedSource.paid!==1||savedSource.payType!=='weixin'||savedSource.tradeNo!==source.tradeNo
    ||savedSource.orderId!==source.orderId||savedSource.pid!==(source.id===root.id?0:root.id)||!positive(savedSource.totalNum)
    ||typeof savedSource.payPrice!=='string'||amountToCents(savedSource.payPrice)===null
    ||payment.id!==root.id||payment.orderId!==root.orderId||payment.tradeNo!==root.tradeNo||payment.payType!=='weixin'||typeof payment.payPrice!=='string'||amountToCents(payment.payPrice)!==total
    ||!Array.isArray(archive.carts)||!archive.carts.length||archive.carts.length>200)return fail();
   const lines=archive.carts.map(v=>{const c=object(v);if(c.oid!==source.id||c.uid!==root.uid)return fail();return line(c);}),ps=parts(r.partitions);
   if(new Set(lines.map(v=>v.id)).size!==lines.length||ps.length!==lines.length||lines.reduce((n,l)=>n+l.quantity,0)!==savedSource.totalNum)return fail();
   for(const p of ps){const l=lines.find(v=>v.id===p.sourceRowId);if(!l||p.sourceCartId!==l.cartId||p.selectedNum+p.remainingNum!==l.quantity)return fail();}
   if(r.disposition==='whole'?(r.remainingOrderId!==null||r.selectedOrderId!==r.sourceOrderId||ps.some(p=>p.remainingNum!==0||p.selectedRowId!==p.sourceRowId)):
    r.disposition!=='split'||!positive(r.remainingOrderId)||!leafIds.has(r.remainingOrderId)||r.selectedOrderId===r.sourceOrderId
     ||r.selectedOrderId===r.remainingOrderId||orders.get(r.remainingOrderId)?.supplierId!==r.supplierId
     ||orders.get(r.remainingOrderId)?.storeId!==r.storeId||!ps.some(p=>p.selectedNum>0)||!ps.some(p=>p.remainingNum>0))return fail();
   await assertAtomicRefundCompleted(tx,refund);
   const history=await readMaterializedRefundSnapshot(tx,refund);if(!history||history.physicalOrderId!==r.selectedOrderId)return fail();
   const payments=await tx.select().from(storeOrderRefundPayment).where(eq(storeOrderRefundPayment.refundId,r.refundId)).limit(2);
   const refunded=amountToCents(refund.refundPrice);if(refunded===null||refunded<0)return fail();
   // The ordinary positively priced WeChat author rejects zero refunds. Only
   // its mature pure-integral exception is evidenced by the pre-refund archive;
   // current point totals may already have been partitioned by materialization.
   if(refunded===0){if(payments.length||savedSource.type!==4||amountToCents(String(savedSource.payPrice))!==0||!positive(savedSource.payIntegral)
    ||source.type!==4||selected.type!==4||amountToCents(source.payPrice)!==0||amountToCents(selected.payPrice)!==0)return fail();}
   else if(payments.length!==1||payments[0].provider!=='wechat'||payments[0].providerStatus!=='SUCCESS'
    ||payments[0].storeOrderId!==source.id||payments[0].requestAmount!==refunded||payments[0].totalAmount!==total
    ||!await assertRoutineRefundProjectionTx(tx,env,r.refundId))return fail();
   sourceLines.set(r.refundId,lines);partitionMap.set(r.refundId,ps);selectedByOrder.set(r.selectedOrderId,r);
  }
  for(const b of branchRows){const order=orders.get(b.childOrderId);
   if(!order||!leafIds.has(b.childOrderId)||b.paymentOrderId!==root.id||b.uid!==root.uid||b.supplierId!==order.supplierId
    ||b.storeId!==order.storeId||orders.get(b.sourceOrderId)?.supplierId!==b.supplierId||orders.get(b.sourceOrderId)?.storeId!==b.storeId||!hex(b.receiptDigest))return fail();await loadRefundFulfillmentBranch(tx,order,b.id);
  }
  const memo=new Map<string,Line[]>(),visiting=new Set<string>();
  function resolved(key:string,work:()=>Line[]):Line[]{
   const prior=memo.get(key);if(prior)return prior;if(visiting.has(key)||visiting.size>402)return fail();
   visiting.add(key);try{const value=work();memo.set(key,value);return value;}finally{visiting.delete(key);}
  }
  function refundInput(r:HistoryRow):Line[]{return resolved('input:'+r.refundId,()=>{
   const lines=sourceLines.get(r.refundId);if(!lines)return fail();
   if(r.previousRefundId){const previous=byRefund.get(r.previousRefundId);if(!previous||previous.refundId>=r.refundId||previous.remainingOrderId!==r.sourceOrderId
     ||previous.baseBranchId!==r.baseBranchId)return fail();sameLines(refundOutput(previous,false),lines);
   }else if(r.baseBranchId){const b=byBranch.get(r.baseBranchId);if(!b||b.childOrderId!==r.sourceOrderId)return fail();sameLines(branchOutput(b),lines);
   }else if(lines.some(l=>l.marker!==null)||r.sourceOrderId!==root.id&&root.supplierAllocationStatus!==2)return fail();
   return lines;
  });}
  function refundOutput(r:HistoryRow,selected:boolean):Line[]{return resolved((selected?'selected:':'remaining:')+r.refundId,()=>{
   const inputLines=refundInput(r),ps=partitionMap.get(r.refundId);if(!ps||!selected&&r.remainingOrderId===null)return fail();
   const output:Line[]=[];for(const p of ps){const quantity=selected?p.selectedNum:p.remainingNum,id=selected?p.selectedRowId:p.remainingRowId;
    if(!quantity)continue;const from=inputLines.find(l=>l.id===p.sourceRowId);if(!from||id===null)return fail();
    output.push({...from,id,quantity,cartId:r.disposition==='whole'?from.cartId:selected||r.sourceOrderId===root.id?String(id):from.cartId,
     marker:r.disposition==='whole'?from.marker:{refundId:r.refundId,role:selected?'selected':'remaining'}});
   }return output;
  });}
  function branchOutput(b:BranchRow):Line[]{return resolved('branch:'+b.id,()=>{
   const inputLines=b.sourceRefundId?(()=>{const r=byRefund.get(b.sourceRefundId);if(!r||r.remainingOrderId!==b.sourceOrderId||r.baseBranchId!==b.sourceBranchId)return fail();return refundOutput(r,false);})():
    (()=>{const previous=b.sourceBranchId&&byBranch.get(b.sourceBranchId);if(!previous||previous.childOrderId!==b.sourceOrderId)return fail();return branchOutput(previous);})();
   const group=branchRows.filter(v=>v.sourceOrderId===b.sourceOrderId&&v.sourceRefundId===b.sourceRefundId&&v.sourceBranchId===b.sourceBranchId);
   if(group.length!==2||new Set(group.map(v=>v.childOrderId)).size!==2||!group.some(v=>v.childOrderId===b.sourceOrderId))return fail();
   const totals=new Map<number,number>(),targets=new Set<number>();let output:Line[]=[];
   for(const sibling of group){if(!Array.isArray(sibling.partitions)||!sibling.partitions.length||sibling.partitions.length>200)return fail();const current:Line[]=[];
    for(const raw of sibling.partitions){const p=shippingObject(raw,['sourceRowId','rowId','cartId','quantity']),from=inputLines.find(l=>l.id===p.sourceRowId);
     if(!from||!positive(p.rowId)||targets.has(p.rowId)||!positive(p.quantity)||typeof p.cartId!=='string'||!p.cartId)return fail();
     targets.add(p.rowId);totals.set(from.id,(totals.get(from.id)??0)+p.quantity);current.push({...from,id:p.rowId,cartId:p.cartId,quantity:p.quantity,marker:{branchId:sibling.id,role:'remaining'}});
    }if(sibling.id===b.id)output=current;
   }
   if(totals.size!==inputLines.length||inputLines.some(l=>totals.get(l.id)!==l.quantity))return fail();return output;
  });}
  for(const r of records){refundInput(r);refundOutput(r,true);if(r.remainingOrderId!==null)refundOutput(r,false);}
  for(const b of branchRows)branchOutput(b);
  const active:number[]=[],retired:number[]=[];
  for(const order of leaves){const rows=carts.filter(c=>c.oid===order.id),lines=rows.map(line),selected=selectedByOrder.get(order.id);
   if(!rows.length||rows.reduce((n,c)=>n+c.cartNum,0)!==order.totalNum)return fail();
   if(selected){if(![2,3].includes(order.refundStatus)||order.refundType!==6)return fail();sameLines(refundOutput(selected,true),lines);retired.push(order.id);continue;}
   if(order.isDel||order.isSystemDel||[2,3].includes(order.refundStatus)||order.refundType===6)return fail();
   const m=lines[0].marker;if(lines.some(l=>!shippingSame(l.marker,m)))return fail();
   const generation=await loadRefundOrderGeneration(tx,order,rows);
   if(m!==null){const value=object(m);
    if('refundId'in value){const r=typeof value.refundId==='number'&&byRefund.get(value.refundId);if(!r||r.remainingOrderId!==order.id||value.role!=='remaining'||generation?.refundId!==r.refundId)return fail();sameLines(refundOutput(r,false),lines);}
    else{const b=typeof value.branchId==='string'&&byBranch.get(value.branchId);if(!b||b.childOrderId!==order.id||generation?.baseBranchId!==b.id)return fail();sameLines(branchOutput(b),lines);}
   }else if(generation||records.some(r=>r.remainingOrderId===order.id||r.sourceOrderId===order.id)||branchRows.some(b=>b.childOrderId===order.id)
    ||root.supplierAllocationStatus!==2)return fail();
   active.push(order.id);
  }
  if(leaves.some(o=>{const price=amountToCents(o.payPrice);return price===null||price<0;})
   ||leaves.reduce((n,o)=>n+(amountToCents(o.payPrice)??NaN),0)!==total||leaves.reduce((n,o)=>n+o.totalNum,0)!==root.totalNum)return fail();
  const refunds:RefundRef[]=records.map(r=>({refundId:r.refundId,fingerprint:r.fingerprint,sourceOrderId:r.sourceOrderId,selectedOrderId:r.selectedOrderId,
   remainingOrderId:r.remainingOrderId,previousRefundId:r.previousRefundId,baseBranchId:r.baseBranchId,receiptDigest:r.receiptDigest}));
  const branches:BranchRef[]=branchRows.map(b=>({branchId:b.id,sourceBranchId:b.sourceBranchId,sourceRefundId:b.sourceRefundId,
   sourceOrderId:b.sourceOrderId,childOrderId:b.childOrderId,receiptDigest:b.receiptDigest}));
  const body={format:1 as const,payment:{rootId:root.id,buyerUid:root.uid,orderNo:root.orderId,transactionId:root.tradeNo,totalAmount:total},
   refunds,branches,activeOrderIds:active.sort((a,b)=>a-b),retiredOrderIds:retired.sort((a,b)=>a-b)};
  return parseRoutineShippingRefundGeneration(env,{...body,generationDigest:shippingMac(env,'refund-generation-v1',body)});
 }catch{return fail();}
}
