import { and, desc, eq, sql } from 'drizzle-orm';
import type { DB } from '@/dao/BaseDao';
import { storeOrderCartInfo, storeOrderOutbox, storeOrderStatus, type storeOrder } from '@/models/schema';
import { assertSupplierOrderEditOperationReadable } from '@/migrations/supplierOrderEditOperation';
import { outRequestHash } from '@/services/out/OutIdempotency';
import { ValidateException } from '@/utils/errors';
import { gainEditSha256, legacyGainIntegralState } from './UnpaidOrderGainIntegralProof';

type Cart = typeof storeOrderCartInfo.$inferSelect;
export type CashierEditOrder = Pick<typeof storeOrder.$inferSelect,
  'id'|'orderId'|'uid'|'supplierId'|'paid'|'payTime'|'payPrice'|'changePrice'|'gainIntegral'>;
export interface CashierEditOriginCart {
  cart_row_id:number; opaque_cart_id:string; product_id:number; product_type:number;
  owner_type:number; owner_id:number; sku_unique:string; purchase_quantity:number;
  snapshot_hash:string; is_gift?:number; write_times?:number;
}
declare const cashierEditBrand: unique symbol;
export interface CashierEditProof { readonly [cashierEditBrand]:true }
const issued = new WeakMap<object, Map<number,{row:string;originHash:string}>>();
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA=/^[a-f0-9]{64}$/;
const invalid=()=>new ValidateException('收银原始购买快照与受保护订单编辑链不一致');
function object(value:unknown):Record<string,unknown>{
  if(!value||typeof value!=='object'||Array.isArray(value))throw invalid();return value as Record<string,unknown>;
}
function integer(value:unknown,zero=false):number{
  if(typeof value!=='number'||!Number.isSafeInteger(value)||value<(zero?0:1)||value>2_147_483_647)throw invalid();return value;
}
function points(value:unknown):number{
  if((typeof value!=='string'&&typeof value!=='number')||!/^(0|[1-9]\d{0,9})(\.00)?$/.test(String(value)))throw invalid();
  const n=Number(value);if(!Number.isSafeInteger(n)||n>9_999_999_999)throw invalid();return n;
}
function cash(value:unknown,signed=false):string{
  if(typeof value!=='string'||!(signed?/^-?(0|[1-9]\d{0,5})\.\d{2}$/:/^(0|[1-9]\d{0,9})\.\d{2}$/).test(value)||value==='-0.00')throw invalid();return value;
}
const cents=(value:string)=>BigInt(value.replace('.',''));
function digest(value:unknown):string{if(typeof value!=='string'||!SHA.test(value))throw invalid();return value;}
function uuid(value:unknown):string{if(typeof value!=='string'||!UUID.test(value))throw invalid();return value;}
interface Operation {operation_id:string;actor_id:number;supplier_id:number;order_id:number;state:string;
  request_hash:string;before_hash:string;after_hash:string;evidence:unknown;result:unknown;created_at:number}
async function operation(db:DB,id:string,order:CashierEditOrder){
  const rows=await db.execute(sql`SELECT operation_id::text,actor_id,supplier_id,order_id,state,request_hash,before_hash,after_hash,
    CASE WHEN octet_length(evidence::text)<=196608 THEN evidence ELSE NULL END AS evidence,result,created_at
    FROM public.supplier_order_edit_operation_v1 WHERE operation_id=${uuid(id)}::uuid`) as unknown as Operation[];
  if(rows.length!==1)throw invalid();const row=rows[0],evidence=object(row.evidence),source=object(evidence.source),result=object(row.result);
  integer(row.actor_id);integer(row.created_at);digest(row.request_hash);digest(row.before_hash);digest(row.after_hash);
  if(row.operation_id!==id||row.order_id!==order.id||row.supplier_id!==order.supplierId||row.state!=='committed'
    ||evidence.version!=='supplier-unpaid-gain-edit-v1'||evidence.operation_id!==id
    ||!['checkout','legacy-php'].includes(String(evidence.source_format))
    ||source.order_id!==order.id||source.buyer_id!==order.uid||source.supplier_id!==order.supplierId
    ||result.id!==order.id||result.order_id!==order.orderId||result.changed!==true||Object.keys(result).length!==6
    ||!Array.isArray(evidence.lines)||!evidence.lines.length||evidence.lines.length>200)throw invalid();
  integer(evidence.status_id);if(evidence.before_status_id!==null)integer(evidence.before_status_id);
  if(evidence.previous_operation_id!==null)uuid(evidence.previous_operation_id);
  digest(evidence.before_state_sha256);digest(evidence.after_state_sha256);
  const beforeCash=object(evidence.before_cash);
  if(Object.keys(beforeCash).sort().join(',')!=='change_price,pay_price')throw invalid();
  cash(beforeCash.pay_price);cash(beforeCash.change_price,true);cash(result.pay_price);cash(result.change_price,true);
  if(cents(String(beforeCash.pay_price))+cents(String(beforeCash.change_price))!==cents(String(result.pay_price))+cents(String(result.change_price))
    ||points(evidence.after_total)!==points(result.gain_integral))throw invalid();
  return{row,evidence,result,beforeCash};
}

/** Existing aggregate index locates an untrusted UUID reference. Only the
 * immutable receipt, actual latest status and complete purchase hashes confer
 * authority; a mutable outbox cannot manufacture a successful edit. */
async function latestOperation(db:DB,order:CashierEditOrder){
  const events=await db.select({id:storeOrderOutbox.id,eventKey:storeOrderOutbox.eventKey,eventType:storeOrderOutbox.eventType,
    payload:sql<unknown>`CASE WHEN octet_length(${storeOrderOutbox.payload}::text)<=4096 THEN ${storeOrderOutbox.payload} ELSE NULL END`})
    .from(storeOrderOutbox).where(and(eq(storeOrderOutbox.aggregateType,'order'),eq(storeOrderOutbox.aggregateId,order.id),
      eq(storeOrderOutbox.eventType,'order.price.revision'))).orderBy(desc(storeOrderOutbox.id)).limit(1002);
  // Paid/delivery/refund consumers may legitimately append unrelated events
  // after the final edit. Only the editor's bounded edit family is inspected.
  if(events.length>1001)throw invalid();
  const event=events.find(row=>row.eventType==='order.price.revision');if(!event)throw invalid();
  const payload=object(event.payload),id=uuid(payload.operationId);
  if(Object.keys(payload).sort().join(',')!=='operationId,orderId'||payload.orderId!==order.id
    ||event.eventKey!==`order.price.revision:${order.id}:${id}`)throw invalid();
  const [status]=await db.select({id:storeOrderStatus.id}).from(storeOrderStatus)
    .where(and(eq(storeOrderStatus.oid,order.id),eq(storeOrderStatus.changeType,'order_edit'))).orderBy(desc(storeOrderStatus.id)).limit(1);
  if(!status)throw invalid();return{id,statusId:status.id};
}

/** An unchanged origin adds no new catalog/grant dependency. For an edited
 * cashier purchase every committed transition is checked, newest to oldest,
 * without rewriting the origin or retaining secret purchase JSON in a receipt. */
export async function loadUnpaidOrderCashierEditProof(db:DB,order:CashierEditOrder,rows:readonly Cart[],
  origin:readonly CashierEditOriginCart[],creationPayPrice?:string):Promise<CashierEditProof|null>{
  if(!rows.length||rows.length>200||rows.length!==origin.length||new Set(rows.map(row=>row.id)).size!==rows.length)throw invalid();
  const currentHashes=new Map<number,string>();
  for(const row of rows){const fact=origin.find(value=>value.cart_row_id===row.id);
    if(!fact||row.oid!==order.id||row.uid!==order.uid||row.cartId!==fact.opaque_cart_id||row.productId!==fact.product_id
      ||row.productType!==fact.product_type||row.type!==fact.owner_type||row.relationId!==fact.owner_id||row.skuUnique!==fact.sku_unique
      ||row.cartNum!==fact.purchase_quantity||fact.is_gift!==undefined&&row.isGift!==fact.is_gift
      ||fact.write_times!==undefined&&row.writeTimes!==fact.write_times||typeof row.cartInfo!=='string')throw invalid();
    currentHashes.set(row.id,await outRequestHash(row.cartInfo));
  }
  const same=origin.every(fact=>currentHashes.get(fact.cart_row_id)===fact.snapshot_hash);
  if(same&&(creationPayPrice===undefined?order.changePrice==='0.00':order.payPrice===creationPayPrice&&order.changePrice==='0.00'))return null;
  integer(order.supplierId);if(rows.some(row=>row.type!==2||row.relationId!==order.supplierId))throw invalid();
  await assertSupplierOrderEditOperationReadable(db);
  const latest=await latestOperation(db,order),current=await legacyGainIntegralState(order,rows);
  let id=latest.id,expectedStatus:number|null=latest.statusId,expectedState=current.hash;
  let expectedPay=cash(order.payPrice),expectedChange=cash(order.changePrice,true),expectedPoints=points(order.gainIntegral);
  const expectedRaw=new Map(await Promise.all(rows.map(async row=>[row.id,await gainEditSha256(row.cartInfo!)] as const)));
  const expectedOrigin=new Map(currentHashes),seen=new Set<string>();
  for(let depth=0;;depth++){
    if(depth>=1000||seen.has(id))throw invalid();seen.add(id);
    const item=await operation(db,id,order),e=item.evidence,lines=e.lines as unknown[];
    if(e.status_id!==expectedStatus||e.after_state_sha256!==expectedState||item.result.pay_price!==expectedPay
      ||item.result.change_price!==expectedChange||points(item.result.gain_integral)!==expectedPoints||lines.length!==rows.length)throw invalid();
    const lineIds=new Set<number>();let beforeTotal=0,afterTotal=0;
    for(const value of lines){const line=object(value),row=rows.find(candidate=>candidate.id===line.row_id);
      if(!row||lineIds.has(row.id)||line.cart_id!==row.cartId||line.product_id!==row.productId||line.quantity!==row.cartNum
        ||line.is_gift!==row.isGift||digest(line.after_sha256)!==expectedRaw.get(row.id)
        ||digest(line.after_origin_hash)!==expectedOrigin.get(row.id))throw invalid();
      lineIds.add(row.id);beforeTotal+=points(line.before_gain_integral);afterTotal+=points(line.after_gain_integral);
      expectedRaw.set(row.id,digest(line.before_sha256));expectedOrigin.set(row.id,digest(line.before_origin_hash));
    }
    if(beforeTotal!==points(e.before_total)||afterTotal!==points(e.after_total))throw invalid();
    expectedState=digest(e.before_state_sha256);expectedPay=cash(item.beforeCash.pay_price);expectedChange=cash(item.beforeCash.change_price,true);
    expectedPoints=points(e.before_total);expectedStatus=e.before_status_id as number|null;
    if(e.previous_operation_id===null){
      if(expectedChange!=='0.00'||creationPayPrice!==undefined&&expectedPay!==creationPayPrice
        ||origin.some(fact=>expectedOrigin.get(fact.cart_row_id)!==fact.snapshot_hash))throw invalid();break;
    }
    if(expectedStatus===null||integer(expectedStatus)>=integer(e.status_id))throw invalid();id=uuid(e.previous_operation_id);
  }
  const proof=Object.freeze({}) as CashierEditProof;
  issued.set(proof,new Map(rows.map(row=>[row.id,{row:JSON.stringify(row),originHash:origin.find(fact=>fact.cart_row_id===row.id)!.snapshot_hash}])));
  return proof;
}
export function cashierEditedSnapshotMatches(proof:CashierEditProof|null,row:Cart,originHash:string):boolean{
  const value=proof&&issued.get(proof)?.get(row.id);return!!value&&value.row===JSON.stringify(row)&&value.originHash===originHash;
}
