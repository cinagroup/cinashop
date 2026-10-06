import { and,asc,desc,eq,getTableColumns,inArray,isNull,sql,type SQL } from 'drizzle-orm';
import {withTx,type Container,type DbClient} from '@/lib/di';
import type { Env } from '@/env';
import { storeOrder,storeOrderCartInfo,storeOrderRefund,storeOrderWriteoff,storePink,systemStore,user } from '@/models/schema';
import { ValidateException,NotFoundException,HttpApiException } from '@/utils/errors';
import { outRequestHash } from '@/services/out/OutIdempotency';
import { merchantOrderRevision } from '@/services/store/StoreManagerScope';
import { readPresaleDispatchReadiness,assertPresaleDispatchReady } from '@/services/activity/PresaleFulfillmentSnapshot';
import { publicProductPictures,renderProductPictures } from '@/services/activity/ProductAssetPolicy';
import { readCashierSecondCardOrigin } from '@/services/order/CashierSecondCardOrigin';
import { customerWriteoffOperationReadiness,inspectCustomerWriteoffOperation } from '@/migrations/runCustomerWriteoffOperation';
import {withCustomerWorkRead,customerWorkId,authorizeCustomerWorkActor,type CustomerWorkActor} from './CustomerWorkScope';
import {writeoffLookup,writeoffNumber,writeoffHash,writeoffId,writeoffText,writeoffInput,CUSTOMER_WRITEOFF_VERSION,type PreparedWriteoff} from './CustomerWorkWriteoffProtocol';
import { customerWriteoffSalePriceProof } from './CustomerWorkWriteoffSalePrice';
import {loadRefundOrderGeneration,currentGenerationRefunds} from '@/services/order/RefundOrderGeneration';
import {planCompletedRefundLineCompensation} from '@/services/order/OrderSplitFinance';
import {freezeCustomerActor} from './CustomerWorkOperationRequest';
import type { CustomerWorkWriteoffTarget,CustomerWorkWriteoffLookup,CustomerWorkWriteoffRecords,CustomerWorkWriteoffOperator } from '../../../../view/common/customerWorkWriteoff';

export type CustomerWriteoffOrder=typeof storeOrder.$inferSelect;
export type CustomerWriteoffCart=typeof storeOrderCartInfo.$inferSelect;
const MAX_CARTS=500,MAX_BYTES=262144,OPEN_REFUNDS=[0,1,2,4,5];
const fact=(ok:boolean,reason:string)=>{if(!ok)throw new ValidateException(reason);};
const cols=getTableColumns(storeOrder),texts=['cartId','virtualInfo','customForm','promotionsGive','giveCoupon','expressDump','refundReasonWapImg'] as const;
const bytes=sql`(${sql.join(texts.map(key=>sql`COALESCE(octet_length(${cols[key]})::bigint,0)`),sql`+`)})`;
const boundedOrder={...cols,...Object.fromEntries(texts.map(key=>[key,sql<string|null>`CASE WHEN ${bytes}<=${MAX_BYTES} THEN ${cols[key]} ELSE NULL END`])),oversized:sql<boolean>`${bytes}>${MAX_BYTES}`} as typeof cols&{oversized:SQL<boolean>};
function checkedOrder(row:CustomerWriteoffOrder&{oversized:boolean}):CustomerWriteoffOrder {fact(!row.oversized,'订单原快照超过完整核对容量');const{oversized:_large,...order}=row;writeoffNumber(order.orderId);return order;}
export async function customerWriteoffOrder(db:DbClient,id:number,number?:string):Promise<CustomerWriteoffOrder>{
 const rows=await db.select(boundedOrder).from(storeOrder).where(number===undefined?eq(storeOrder.id,id):eq(storeOrder.orderId,number)).limit(2);
 if(rows.length!==1||rows[0].id!==id||rows[0].isSystemDel)throw new NotFoundException('真实订单行和原订单号不匹配');return checkedOrder(rows[0]);
}
export async function customerWriteoffRoot(db:DbClient,order:CustomerWriteoffOrder):Promise<CustomerWriteoffOrder>{
 const root=await customerWriteoffOrder(db,order.pid>0?order.pid:order.id),allocated=root.pid===-1&&root.supplierId===0&&root.supplierAllocationStatus===2;
 fact(root.uid===order.uid&&root.payType===order.payType&&(order.pid<=0||root.pid===-1)&&(root.storeId===order.storeId||allocated)&&(root.supplierId===order.supplierId||allocated),'履约单与原支付主单的真实归属不一致');return root;
}
export async function customerWriteoffCarts(db:DbClient,order:CustomerWriteoffOrder,lock=false):Promise<CustomerWriteoffCart[]>{
 const[capacity]=await db.execute<{count:string;bytes:string}>(sql`SELECT count(*)::text AS count,COALESCE(sum(octet_length(${storeOrderCartInfo.cartInfo})::bigint),0)::text AS bytes FROM ${storeOrderCartInfo} WHERE ${storeOrderCartInfo.oid}=${order.id}`);
 fact(!!capacity&&BigInt(capacity.count)<=BigInt(MAX_CARTS)&&BigInt(capacity.bytes)<=BigInt(MAX_BYTES),'核销商品行数或原快照超过完整核对容量');
 const query=db.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid,order.id)).orderBy(asc(storeOrderCartInfo.id)).limit(MAX_CARTS+1),rows=await(lock?query.for('update'):query);
 fact(rows.length<=MAX_CARTS&&rows.length===Number(capacity.count)&&rows.every(row=>row.oid===order.id&&row.uid===order.uid),'核销商品真实归属或读取集合不一致');
 fact(new Set(rows.map(row=>row.cartId)).size===rows.length&&rows.every(row=>{writeoffId(row.id);writeoffText(row.cartId,128);writeoffId(row.cartNum);writeoffId(row.writeTimes,true);writeoffId(row.writeSurplusTimes,true);writeoffId(row.writeStart,true);writeoffId(row.writeEnd,true);return row.writeSurplusTimes<=row.writeTimes&&[0,1].includes(row.isWriteoff)&&(!row.writeEnd||!row.writeStart||row.writeEnd>=row.writeStart);}), '商品标识、剩余次数或有效窗口不一致');return rows;
}
export async function customerWriteoffFacts(db:DbClient,order:CustomerWriteoffOrder,lock=false){
 const root=await customerWriteoffRoot(db,order),carts=await customerWriteoffCarts(db,order,lock);
 const[refundCapacity]=await db.execute<{count:string;bytes:string}>(sql`SELECT count(*)::text AS count,COALESCE(sum(octet_length(${storeOrderRefund.cartInfo})::bigint),0)::text AS bytes FROM ${storeOrderRefund} WHERE ${storeOrderRefund.storeOrderId}=${order.id}`);
 fact(!!refundCapacity&&BigInt(refundCapacity.count)<=200n&&BigInt(refundCapacity.bytes)<=BigInt(MAX_BYTES),'售后快照超过完整核对容量');
 const refundColumns=getTableColumns(storeOrderRefund),refundRows=await db.select({...refundColumns,refundImg:sql<string|null>`NULL`,refundGoodsImg:sql<string|null>`NULL`}).from(storeOrderRefund).where(eq(storeOrderRefund.storeOrderId,order.id)).orderBy(asc(storeOrderRefund.id)).limit(201);
 fact(refundRows.length<=200&&refundRows.every(row=>row.uid===order.uid&&row.storeId===order.storeId&&row.supplierId===order.supplierId),'售后关联超过完整容量或真实归属不一致');
 const refunds=refundRows.map(({refundPhone:_phone,refundImg:_images,refundGoodsImg:_goodsImages,...row})=>row);
 let generationReason='';try{const generation=await loadRefundOrderGeneration(db,order,carts),completed=await currentGenerationRefunds(refundRows.filter(r=>r.refundType===6&&!r.isDel&&!r.isCancel),generation);planCompletedRefundLineCompensation(order,carts,completed);}catch(error){if(!(error instanceof ValidateException))throw error;generationReason=error.message;}
 const pink=order.type===3?await db.select().from(storePink).where(eq(storePink.id,order.pinkId)).limit(2):[];fact(pink.length<=1,'拼团身份不唯一');
 const[records]=await db.execute<{count:string;digest:string}>(sql`SELECT count(*)::text AS count,md5(COALESCE(string_agg(md5(to_jsonb(r)::text),'' ORDER BY r.id),'')) AS digest FROM ${storeOrderWriteoff} r WHERE r.oid=${order.id}`);
 let origin:Awaited<ReturnType<typeof readCashierSecondCardOrigin>>=null,originReason='';
 if(order.shippingType===2&&order.storeId===0){try{origin=await readCashierSecondCardOrigin(db,order,carts,lock);}catch(error){if(!(error instanceof ValidateException||error instanceof HttpApiException))throw error;originReason=error.message;}}
 const prices=await Promise.all(carts.map(async cart=>{try{return await customerWriteoffSalePriceProof(cart);}catch(error){if(!(error instanceof ValidateException))throw error;return{source:'unproven' as const,version:'customer-writeoff-sale-price-v1' as const,snapshot_hash:null,price_hash:null,next_price:null,all_remaining_price:null,reason:error.message};}}));
 return{root,carts,refunds,pink,records,origin,originReason,prices,generationReason};
}
export async function customerWriteoffState(db:DbClient,order:CustomerWriteoffOrder,locked=false){
 const facts=await customerWriteoffFacts(db,order,locked),ledger=await customerWriteoffOperationReadiness(db),now=Math.floor(Date.now()/1000);
 const stores=order.shippingType===2&&order.storeId>0?await db.select({id:systemStore.id}).from(systemStore).where(eq(systemStore.id,order.storeId)).limit(2):[];
 const codeOwners=/^\d{12}$/.test(order.verifyCode)?await db.select({id:storeOrder.id}).from(storeOrder).where(and(eq(storeOrder.verifyCode,order.verifyCode),eq(storeOrder.isDel,0),eq(storeOrder.isSystemDel,0))).limit(2):[];
 let reason='';const pickup=order.shippingType===2&&(order.storeId>0||!!facts.origin),delivery=[1,3].includes(order.shippingType)&&order.deliveryType==='send'&&order.deliveryUid>0;
 if(order.isDel||order.isSystemDel||facts.root.isDel||facts.root.isSystemDel||order.pid<0||order.supplierAllocationStatus===1)reason='订单已删除、拆分或分配，不能核销';
 else if(order.paid!==1||facts.root.paid!==1)reason='订单尚未完成实际支付';
 else if(order.type===4||facts.root.type===4)reason='积分兑换订单不属于普通用户核销范围';
 else if(!pickup&&!delivery)reason=order.shippingType===2&&order.storeId===0?(facts.originReason||'历史现金次卡缺少实际创建支付来源，请人工核对'):'该订单不是可核销的自提或指定配送订单';
 else if(order.uid===0&&!facts.origin)reason='游客订单缺少真实现金创建支付来源';
 else if(order.shippingType===2&&order.storeId>0&&stores.length!==1)reason='订单关联门店不存在或不唯一';
 else if(!(pickup?[0,5]:[1,5]).includes(order.status)||![0,3].includes(order.refundStatus))reason='当前订单状态不允许核销';
 else if(!/^\d{12}$/.test(order.verifyCode))reason='核销码缺失或已失效，请重新读取';
 else if(codeOwners.length!==1||codeOwners[0].id!==order.id)reason='核销码对应的真实订单不唯一，请先人工核对';
 else if(!facts.carts.length||!facts.carts.some(row=>row.writeSurplusTimes>0))reason='订单没有剩余可核销次数';
 else if(facts.prices.some(price=>price.source==='unproven'))reason='原成交价格或商品快照无法完整证明，请先核对';
 else if(facts.generationReason)reason=facts.generationReason;
 else if(facts.refunds.some(row=>!row.isDel&&!row.isCancel&&OPEN_REFUNDS.includes(row.refundType)))reason='订单有待处理售后，不能核销';
 else if(order.type===3&&facts.pink[0]?.status!==2)reason='拼团尚未成功，不能核销';
 else if(!facts.carts.some(row=>row.writeSurplusTimes>0&&(!row.writeStart||row.writeStart<=now)&&(!row.writeEnd||row.writeEnd>=now)))reason='商品没有处于有效窗口内的剩余次数';
 if(!reason){try{await(locked?assertPresaleDispatchReady:readPresaleDispatchReadiness)(db,order,'核销');}catch(error){if(!(error instanceof ValidateException))throw error;reason=error.message;}}
 const readiness={writes:ledger.ready,reason:ledger.ready?'':'核销台账、身份锁及实际权限尚未验收'},actions={writeoff:{available:!reason&&ledger.ready,reason:reason||readiness.reason}};
 const order_revision=await merchantOrderRevision(order),writeoff_revision=await outRequestHash({version:'customer-writeoff-source-v1',order,...facts});
 const target_fingerprint=await outRequestHash({version:'customer-writeoff-target-source-v1',order_id:order.id,order_no:order.orderId,root_order_id:facts.root.id,root_order_no:facts.root.orderId,order_revision,writeoff_revision,actions});
 return{facts,readiness,actions,order_revision,writeoff_revision,target_fingerprint};
}
export async function assertCustomerWriteoffReview(db:DbClient,order:CustomerWriteoffOrder,p:PreparedWriteoff,locked=true){
 const state=await customerWriteoffState(db,order,locked),payload=p.input.payload;
 fact(order.id===p.input.order_id&&order.orderId===payload.order_no&&state.facts.root.id===payload.root_order_id&&state.facts.root.orderId===payload.root_order_no,'核销订单、原支付主单与完整意图不一致');
 fact(state.order_revision===p.input.expected_order_revision&&state.writeoff_revision===p.input.expected_writeoff_revision&&state.target_fingerprint===payload.target_fingerprint,'订单核销依据已变化，请重新读取并确认');
 fact(state.actions.writeoff.available,state.actions.writeoff.reason);fact(order.verifyCode===payload.code,'原核销码已经变化，请核对原请求');return state;
}
const display=(value:unknown)=>typeof value==='string'?Array.from(value.replace(/[\u0000-\u001f\u007f]/g,' ').trim()).slice(0,500).join(''):'';
export class CustomerWorkWriteoffReadService {
 constructor(readonly container:Container,readonly env:Env){}
 private async target(db:DbClient,order:CustomerWriteoffOrder):Promise<CustomerWorkWriteoffTarget>{
  const state=await customerWriteoffState(db,order),products=state.facts.carts.map(cart=>{let value:Record<string,unknown>={};try{value=JSON.parse(cart.cartInfo??'{}');}catch{}const product=(value.product??value.productInfo??{}) as Record<string,unknown>,sku=(value.sku??product.attrInfo??{}) as Record<string,unknown>;return{title:display(product.storeName??product.store_name),sku:display(sku.suk),image:product.image};});
  const refs=await publicProductPictures(db,products.map(product=>({image:product.image,type:order.supplierId>0?2:0,relationId:order.supplierId>0?order.supplierId:0}))),images=await renderProductPictures(this.env.APP_KEY,refs);
  return{version:'customer-work-writeoff-target-v1',requested_order_no:order.orderId,id:order.id,order_no:order.orderId,root_order_id:state.facts.root.id,root_order_no:state.facts.root.orderId,uid:order.uid,store_id:order.storeId,supplier_id:order.supplierId,type:order.type,product_type:order.productType,paid:order.paid,status:order.status,shipping_type:order.shippingType,delivery_type:order.deliveryType,code:/^\d{12}$/.test(order.verifyCode)?order.verifyCode:'',order_revision:state.order_revision,writeoff_revision:state.writeoff_revision,target_fingerprint:state.target_fingerprint,readiness:state.readiness,actions:state.actions,
   cashier_origin:{eligible:!!state.facts.origin,version:state.facts.origin?.version??'',proof_hash:state.facts.origin?.origin_hash??null,reason:state.facts.origin?'':state.facts.originReason||(order.storeId===0&&order.shippingType===2?'历史订单缺少可证明的现金来源':'')},
   carts:state.facts.carts.map((cart,index)=>({cart_row_id:cart.id,cart_id:cart.cartId,cart_num:cart.cartNum,product_id:cart.productId,product_type:cart.productType,product_name:products[index].title,image:images[index]??'',sku:products[index].sku,write_times:cart.writeTimes,write_surplus_times:cart.writeSurplusTimes,is_writeoff:cart.isWriteoff,write_start:cart.writeStart,write_end:cart.writeEnd,sale_price:state.facts.prices[index]}))};
 }
 async order(actor:CustomerWorkActor,idValue:unknown,query:Record<string,string>){if(Object.keys(query).some(key=>!['scope_key','order_no'].includes(key))||!query.scope_key||!query.order_no)throw new ValidateException('核销读取必须同时指定身份、真实订单行和原订单号');const id=customerWorkId(idValue,'订单'),number=writeoffNumber(query.order_no);return withCustomerWorkRead(this.container,actor,writeoffHash(query.scope_key),async db=>this.target(db,await customerWriteoffOrder(db,id,number)));}
 private async resolve(db:DbClient,namespace:ReturnType<typeof writeoffLookup>['namespace'],value:string){
  if(namespace==='legacy-order-id')return{kind:'legacy-order-id' as const,ids:[(await customerWriteoffOrder(db,customerWorkId(value,'订单'))).id]};
  const codeRows=/^\d{12}$/.test(value)?await db.select({id:storeOrder.id}).from(storeOrder).where(and(eq(storeOrder.verifyCode,value),eq(storeOrder.isDel,0),eq(storeOrder.isSystemDel,0))).orderBy(asc(storeOrder.id)).limit(2):[];
  const members=await db.select({uid:user.uid}).from(user).where(and(eq(user.barCode,value),eq(user.status,1),eq(user.isDel,0),isNull(user.deleteTime))).orderBy(asc(user.uid)).limit(2);
  if(namespace==='auto'&&(codeRows.length>1||members.length>1||codeRows.length&&members.length))throw new ValidateException('扫码内容存在订单码或会员码歧义，请明确选择查询类型');
  if(namespace==='order-code'||namespace==='auto'&&codeRows.length){if(codeRows.length!==1)throw new NotFoundException('订单核销码不存在或不唯一');return{kind:'order-code' as const,ids:[codeRows[0].id]};}
  if(members.length!==1)throw new NotFoundException('会员码不存在或对应多个有效会员');
  const orders=await db.select({id:storeOrder.id}).from(storeOrder).where(and(eq(storeOrder.uid,members[0].uid),eq(storeOrder.paid,1),inArray(storeOrder.status,[0,1,5]),inArray(storeOrder.refundStatus,[0,3]),eq(storeOrder.isDel,0),eq(storeOrder.isSystemDel,0),sql`${storeOrder.pid}>=0`)).orderBy(desc(storeOrder.payTime),desc(storeOrder.id)).limit(101);
  if(orders.length>100)throw new ValidateException('会员待核销订单超过完整读取容量，请使用具体订单核销码');return{kind:'member-barcode' as const,ids:orders.map(row=>row.id)};
 }
 async lookup(actor:CustomerWorkActor,value:unknown){const request=writeoffLookup(value);return withCustomerWorkRead(this.container,actor,request.scope_key,async db=>{const resolved=await this.resolve(db,request.namespace,request.value),orders=[];for(const id of resolved.ids)orders.push(await this.target(db,await customerWriteoffOrder(db,id)));return{version:'customer-work-writeoff-lookup-v1',namespace:request.namespace,lookup_kind:resolved.kind,lookup_fingerprint:await outRequestHash({namespace:request.namespace,value:request.value}),orders} satisfies CustomerWorkWriteoffLookup;});}
 async records(actor:CustomerWorkActor,idValue:unknown,query:Record<string,string>){
  if(Object.keys(query).some(key=>!['scope_key','order_no','page','limit'].includes(key))||!query.scope_key||!query.order_no)throw new ValidateException('核销记录须指定当前身份及真实订单');const id=customerWorkId(idValue,'订单'),number=writeoffNumber(query.order_no),page=customerWorkId(query.page??'1','页码'),limit=customerWorkId(query.limit??'20','每页条数');if(limit>100||!Number.isSafeInteger((page-1)*limit)||(page-1)*limit>2147483647)throw new ValidateException('核销分页参数超过容量');
  return withCustomerWorkRead(this.container,actor,writeoffHash(query.scope_key),async db=>{
   const order=await customerWriteoffOrder(db,id,number),root=await customerWriteoffRoot(db,order),[total]=await db.select({count:sql<number>`count(*)::int`}).from(storeOrderWriteoff).where(and(eq(storeOrderWriteoff.oid,id),eq(storeOrderWriteoff.uid,order.uid)));
   const rows=await db.select().from(storeOrderWriteoff).where(and(eq(storeOrderWriteoff.oid,id),eq(storeOrderWriteoff.uid,order.uid))).orderBy(desc(storeOrderWriteoff.addTime),desc(storeOrderWriteoff.id)).offset((page-1)*limit).limit(limit);
   const carts=rows.length?await db.select({id:storeOrderCartInfo.id,cartId:storeOrderCartInfo.cartId,uid:storeOrderCartInfo.uid,productId:storeOrderCartInfo.productId,productType:storeOrderCartInfo.productType}).from(storeOrderCartInfo).where(inArray(storeOrderCartInfo.id,rows.map(row=>row.orderCartId))):[];
   const receipts=(await inspectCustomerWriteoffOperation(db)).complete&&rows.length?await db.execute<{actor_uid:number;service_id:number;request_key:string;request_hash:string;order_id:number;intent:unknown;evidence:Record<string,unknown>}>(sql`SELECT actor_uid,service_id,request_key::text,request_hash,order_id,intent,evidence FROM public.customer_writeoff_operation_request p WHERE order_id=${id} AND outcome IN('partial-writtenoff','written-off') AND EXISTS(SELECT 1 FROM jsonb_array_elements(p.evidence->'writeoff_rows') r WHERE (r->>'writeoff_id')::integer IN(${sql.join(rows.map(row=>sql`${row.id}`),sql`, `)})) LIMIT ${limit+1}`):[];
   for(const receipt of receipts){const input=writeoffInput(receipt.intent);fact(input.order_id===id&&input.payload.order_no===number&&input.payload.root_order_id===root.id&&input.payload.root_order_no===root.orderId&&receipt.request_hash===await outRequestHash({version:CUSTOMER_WRITEOFF_VERSION,actor_uid:receipt.actor_uid,kind:'writeoff',input}),'核销操作者原意图无法完整核对');}
   fact(receipts.length<=limit,'核销操作者证据存在多重归属');const list=[];
   for(const row of rows){const proofs=receipts.flatMap(receipt=>{const evidence=receipt.evidence.writeoff_rows;if(!Array.isArray(evidence))throw new ValidateException('核销回执行证据异常');return evidence.filter(value=>value.writeoff_id===row.id).map(value=>({receipt,value}));});fact(proofs.length<=1,'核销记录的原回执存在冲突');let cartId:string;let operator:CustomerWorkWriteoffOperator={kind:'unknown',actor_uid:null,service_id:null,admin_id:null,staff_id:null,delivery_id:null,request_key:null,request_hash:null};
    if(proofs[0]){const{receipt,value}=proofs[0];fact(receipt.order_id===id&&value.cart_row_id===row.orderCartId&&value.quantity===row.writeoffNum&&value.writeoff_price===row.writeoffPrice&&row.isAdmin===0&&row.adminId===0&&row.staffId===0,'真实记录与原 customer 操作者回执不一致');cartId=writeoffText(value.opaque_cart_id,128);operator={...operator,kind:'customer',actor_uid:writeoffId(receipt.actor_uid),service_id:writeoffId(receipt.service_id),request_key:receipt.request_key,request_hash:receipt.request_hash};}
    else{const cart=carts.find(cart=>cart.id===row.orderCartId);fact(!!cart&&cart.uid===order.uid&&cart.productId===row.productId&&cart.productType===row.productType,'历史核销记录缺少真实商品归属，请人工核对');cartId=writeoffText(cart!.cartId,128);if(row.isAdmin===1&&row.adminId>0&&row.staffId===0)operator={...operator,kind:'admin',admin_id:row.adminId};else if(row.isAdmin===0&&row.adminId===0&&row.staffId>0)operator={...operator,kind:'staff',staff_id:row.staffId};}
    list.push({record_id:row.id,cart_row_id:row.orderCartId,cart_id:cartId,writeoff_num:row.writeoffNum,writeoff_price:row.writeoffPrice,created_at:row.addTime,operator});
   }
   return{version:'customer-work-writeoff-records-v1',order_id:id,order_no:number,root_order_id:root.id,root_order_no:root.orderId,list,count:total.count,page,limit,has_more:page*limit<total.count} satisfies CustomerWorkWriteoffRecords;
  });
 }
 /** Compatibility returns the same bounded legacy projection, but the real
  * UserJWT is separately authorized in this ordinary customer's RR snapshot. */
 private async legacyRead<T>(actorValue:CustomerWorkActor,read:(db:DbClient)=>Promise<T>){const actor=freezeCustomerActor(actorValue),result=await withTx(this.container,async db=>{await db.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);await db.execute(sql`SET LOCAL statement_timeout='5s'`);const scope=await authorizeCustomerWorkActor(db,actor);return{scope,data:await read(db)};});const fresh=await authorizeCustomerWorkActor(this.container.db,actor);fact(fresh.scope_key===result.scope.scope_key,'手机订单核销身份已变化，请重新读取');return result.data;}
 async legacySearch(actor:CustomerWorkActor,lookup:unknown){const text=writeoffText(lookup,32);return this.legacyRead(actor,async db=>{const result=await this.resolve(db,'auto',text),list=[];for(const id of result.ids)list.push(this.legacyProjection(await this.target(db,await customerWriteoffOrder(db,id))));return list;});}
 async legacyInfo(actor:CustomerWorkActor,idValue:unknown){const id=customerWorkId(idValue,'订单');return this.legacyRead(actor,async db=>this.legacyProjection(await this.target(db,await customerWriteoffOrder(db,id))));}
 private legacyProjection(target:CustomerWorkWriteoffTarget){return{id:target.id,order_id:target.order_no,store_id:target.store_id,uid:target.uid,shipping_type:target.shipping_type,delivery_type:target.delivery_type,actor_kind:'customer',status:target.status,total_num:target.carts.reduce((sum,row)=>sum+row.cart_num,0),product_type:target.product_type,write_off:target.carts.reduce((sum,row)=>sum+row.write_times-row.write_surplus_times,0),write_times:target.carts[0]?.write_times??0,cart_count:target.carts.length,writeoff_count:target.carts.reduce((sum,row)=>sum+row.write_times-row.write_surplus_times,0),cart_info:target.carts.map(row=>({id:row.cart_row_id,cart_id:row.cart_id,cart_num:row.cart_num,product_id:row.product_id,product_type:row.product_type,write_times:row.write_times,write_surplus_times:row.write_surplus_times,surplus_num:row.write_surplus_times,is_writeoff:row.is_writeoff,write_start:row.write_start,write_end:row.write_end,cart_info:{productInfo:{id:row.product_id,store_name:row.product_name,image:row.image,attrInfo:{suk:row.sku}}}}))};}
}
