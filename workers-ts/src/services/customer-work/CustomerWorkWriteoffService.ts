import {and,asc,eq,inArray,sql} from 'drizzle-orm';
import {withTx,createContainerFromDb,type Container,type DbClient} from '@/lib/di';
import type {Env} from '@/env';
import {storeOrderWriteoff,storeOrderStatus,storeOrderOutbox,userBill,userBrokerage,user,supplierFlowingWater} from '@/models/schema';
import {ValidateException,NotFoundException,HttpApiException} from '@/utils/errors';
import {outRequestHash,normalizeOutRequestKey} from '@/services/out/OutIdempotency';
import {StoreOrderWriteoffService} from '@/services/order/StoreOrderWriteoffService';
import {lockOrderSettlementUsers} from '@/services/order/OrderBrokerageService';
import {loadRefundLineCompensation} from '@/services/order/RefundLineCompensation';
import {freezeCustomerActor,freezeCustomerJson,authorizeCustomerOperationOwner,lockCustomerWorkOrder,type CustomerJson} from './CustomerWorkOperationRequest';
import type {CustomerWorkActor} from './CustomerWorkScope';
import {prepareWriteoff,writeoffRecord,type PreparedWriteoff,type WriteoffContext,type WriteoffReceipt} from './CustomerWorkWriteoffProtocol';
import {CustomerWorkWriteoffOperationRequest,checkWriteoffRequest,authorizeWriteoffOperation,appendWriteoffOperation,sameWriteoffReceipt,lockWriteoffRequest} from './CustomerWorkWriteoffOperationRequest';
import {CustomerWorkWriteoffReadService,assertCustomerWriteoffReview,customerWriteoffState,customerWriteoffOrder,customerWriteoffRoot,customerWriteoffCarts,type CustomerWriteoffOrder,type CustomerWriteoffCart} from './CustomerWorkWriteoffReadService';
import {orderPaidEventKey} from '@/services/order/OrderOutboxService';
import {storeOrderRefundSplit} from '@/models/schema/order_refund_split';
import {loadRefundOrderGeneration} from '@/services/order/RefundOrderGeneration';
import {customerWriteoffLinePrice,customerWriteoffSalePriceProof} from './CustomerWorkWriteoffSalePrice';
import type {CustomerWorkWriteoffResult,CustomerWorkWriteoffExecution,CustomerWorkWriteoffSettlement,CustomerWorkWriteoffRowEvidence} from '../../../../view/common/customerWorkWriteoff';

const fact=(ok:unknown,message='实际核销效果无法完整核对')=>{if(!ok)throw new ValidateException(message);};
const cents=(v:string)=>{fact(/^(0|[1-9]\d{0,9})\.\d{2}$/.test(v),'结算金额超出完整核对范围');return BigInt(v.replace('.',''));};
const signed=(r:{pm:number;number:string})=>{fact([0,1].includes(r.pm));return cents(r.number)*(r.pm===1?1n:-1n);};
const accountColumns={uid:user.uid,integral:user.integral,exp:user.exp,brokerage:user.brokeragePrice};
const billColumns={id:userBill.id,uid:userBill.uid,linkId:userBill.linkId,category:userBill.category,type:userBill.type,eventKey:userBill.eventKey,pm:userBill.pm,number:userBill.number,balance:userBill.balance,status:userBill.status};
const brokerageColumns={id:userBrokerage.id,uid:userBrokerage.uid,linkId:userBrokerage.linkId,type:userBrokerage.type,sourceType:userBrokerage.sourceType,pm:userBrokerage.pm,number:userBrokerage.number,balance:userBrokerage.balance,status:userBrokerage.status};
const supplierColumns={id:supplierFlowingWater.id,supplierId:supplierFlowingWater.supplierId,uid:supplierFlowingWater.uid,linkId:supplierFlowingWater.linkId,type:supplierFlowingWater.type,pm:supplierFlowingWater.pm,number:supplierFlowingWater.number,status:supplierFlowingWater.status,isDel:supplierFlowingWater.isDel,finishTime:supplierFlowingWater.finishTime};
async function paidIdentity(order:CustomerWriteoffOrder){return{order_id:order.id,order_no:order.orderId,uid:order.uid,pay_type:order.payType,pay_price:order.payPrice,paid:1 as const,identity_hash:await outRequestHash({version:'customer-writeoff-paid-root-v1',order_id:order.id,order_no:order.orderId,uid:order.uid,pay_type:order.payType,pay_price:order.payPrice,paid:order.paid})};}
async function paymentRows(db:DbClient,order:{id:number;orderId:string}){const rows=await db.select({id:storeOrderOutbox.id,eventKey:storeOrderOutbox.eventKey,eventType:storeOrderOutbox.eventType,payload:storeOrderOutbox.payload,aggregateType:storeOrderOutbox.aggregateType,aggregateId:storeOrderOutbox.aggregateId}).from(storeOrderOutbox).where(and(eq(storeOrderOutbox.aggregateId,order.id),eq(storeOrderOutbox.eventType,'order.paid'))).orderBy(asc(storeOrderOutbox.id)).limit(201);fact(rows.length<=1);return Promise.all(rows.map(async row=>{const payload=writeoffRecord(row.payload,['orderId','orderNo']);fact(row.aggregateType==='order'&&row.aggregateId===order.id&&row.eventKey===orderPaidEventKey(order.id)&&payload.orderId===order.id&&payload.orderNo===order.orderId,'原支付事件与真实支付主单不一致');return{row_id:row.id,event_key:row.eventKey,event_type:'order.paid' as const,payload_hash:await outRequestHash(row.payload)};}));}
async function capture(db:DbClient,order:CustomerWriteoffOrder,links:string[],uids:number[]){
 const [bills,brokerage,supplier,accounts,statuses,root]=await Promise.all([
  db.select(billColumns).from(userBill).where(inArray(userBill.linkId,links)).orderBy(asc(userBill.id)).limit(401),
  db.select(brokerageColumns).from(userBrokerage).where(inArray(userBrokerage.linkId,links)).orderBy(asc(userBrokerage.id)).limit(401),
  db.select(supplierColumns).from(supplierFlowingWater).where(and(eq(supplierFlowingWater.supplierId,order.supplierId),eq(supplierFlowingWater.linkId,order.orderId),inArray(supplierFlowingWater.type,[1,2]),eq(supplierFlowingWater.isDel,0))).orderBy(asc(supplierFlowingWater.id)).limit(201),
  db.select(accountColumns).from(user).where(inArray(user.uid,uids)).orderBy(asc(user.uid)),
  db.select({id:storeOrderStatus.id,changeType:storeOrderStatus.changeType,changeMessage:storeOrderStatus.changeMessage,changeTime:storeOrderStatus.changeTime}).from(storeOrderStatus).where(and(eq(storeOrderStatus.oid,order.id),inArray(storeOrderStatus.changeType,['take_delivery','customer_order_writeoff']))).orderBy(asc(storeOrderStatus.id)).limit(1001),customerWriteoffRoot(db,order)
 ]);
 fact(bills.length<=400&&brokerage.length<=400&&supplier.length<=200&&accounts.length<=70&&statuses.length<=1000,'结算原账或状态超过完整核对容量');
 fact(accounts.every(a=>a.uid>0),'游客订单不能伪造用户账户');
 return{bills,brokerage,supplier,accounts,statuses,paid:await paidIdentity(root),outbox:await paymentRows(db,root)};
}
type Effects=Awaited<ReturnType<typeof capture>>;
async function unchanged(a:unknown,b:unknown){return await outRequestHash(a)===await outRequestHash(b);}
async function originalReceiptCart(db:DbClient,order:CustomerWriteoffOrder,carts:CustomerWriteoffCart[],row:CustomerWorkWriteoffRowEvidence):Promise<CustomerWriteoffCart|null>{
 const current=carts.find(c=>c.id===row.cart_row_id);if(!current)return null;
 const matches=async(cart:CustomerWriteoffCart)=>{const proof=await customerWriteoffSalePriceProof({...cart,writeSurplusTimes:row.before_remaining});return proof.snapshot_hash===row.snapshot_hash&&proof.price_hash===row.sale_price_hash&&customerWriteoffLinePrice({...cart,writeSurplusTimes:row.before_remaining},row.quantity)===row.writeoff_price;};
 if(await matches(current))return current;
 // Later materialization preserves the physical remaining row while stamping
 // a new generation snapshot. Recover the actual admitted preimage only from
 // the current, protected refund chain; neither row/time cutoffs nor today's
 // counter are authority for a historical execution.
 const generation=await loadRefundOrderGeneration(db,order,carts);if(!generation?.materialized.size)return null;
 const ids=[...generation.materialized.keys()],[capacity]=await db.execute<{count:string;bytes:string}>(sql`SELECT count(*)::text AS count,COALESCE(sum((SELECT octet_length(x::text)::bigint FROM jsonb_array_elements(${storeOrderRefundSplit.sourceSnapshot}::jsonb->'carts') x WHERE x->>'id'=${String(row.cart_row_id)} LIMIT 1)),0)::text AS bytes FROM ${storeOrderRefundSplit} WHERE ${storeOrderRefundSplit.sourceOrderId}=${order.id} AND ${storeOrderRefundSplit.refundId} IN(${sql.join(ids.map(id=>sql`${id}`),sql`, `)})`);
 if(!capacity||BigInt(capacity.count)>201n||BigInt(capacity.bytes)>262144n)return null;
 const records=await db.select({refundId:storeOrderRefundSplit.refundId,fingerprint:storeOrderRefundSplit.fingerprint,uid:storeOrderRefundSplit.uid,storeId:storeOrderRefundSplit.storeId,supplierId:storeOrderRefundSplit.supplierId,sourceOrderId:storeOrderRefundSplit.sourceOrderId,paymentOrderId:storeOrderRefundSplit.paymentOrderId,remainingOrderId:storeOrderRefundSplit.remainingOrderId,
  source:sql<unknown>`jsonb_build_object('version',${storeOrderRefundSplit.sourceSnapshot}::jsonb->'version','id',${storeOrderRefundSplit.sourceSnapshot}::jsonb->'source'->'id','orderId',${storeOrderRefundSplit.sourceSnapshot}::jsonb->'source'->'orderId','uid',${storeOrderRefundSplit.sourceSnapshot}::jsonb->'source'->'uid')`,
  cart:sql<unknown>`(SELECT x FROM jsonb_array_elements(${storeOrderRefundSplit.sourceSnapshot}::jsonb->'carts') x WHERE x->>'id'=${String(row.cart_row_id)} LIMIT 1)`,
  part:sql<unknown>`(SELECT x FROM jsonb_array_elements(${storeOrderRefundSplit.partitions}::jsonb) x WHERE x->>'sourceRowId'=${String(row.cart_row_id)} LIMIT 1)`
 }).from(storeOrderRefundSplit).where(and(eq(storeOrderRefundSplit.sourceOrderId,order.id),inArray(storeOrderRefundSplit.refundId,[...generation.materialized.keys()]))).orderBy(asc(storeOrderRefundSplit.refundId)).limit(202);
 if(records.length>201||new TextEncoder().encode(JSON.stringify(records)).length>262144)return null;
 const candidates:CustomerWriteoffCart[]=[];for(const record of records){const source=record.source as Record<string,unknown>|null,cart=record.cart as CustomerWriteoffCart|null,part=record.part as Record<string,unknown>|null;
  if(record.fingerprint!==generation.materialized.get(record.refundId)||record.uid!==order.uid||record.storeId!==order.storeId||record.supplierId!==order.supplierId||record.paymentOrderId!==(order.pid>0?order.pid:order.id)||record.remainingOrderId!==order.id||!source||source.version!=='refund-order-materialization-v1'||source.id!==order.id||source.orderId!==order.orderId||source.uid!==order.uid||!cart||!part||cart.id!==row.cart_row_id||cart.oid!==order.id||cart.uid!==order.uid||cart.cartId!==row.opaque_cart_id||part.sourceRowId!==cart.id||part.sourceCartId!==cart.cartId||part.remainingRowId!==cart.id||part.selectedNum!==0||part.remainingNum!==cart.cartNum)continue;
  if(await matches(cart))candidates.push(cart);
 }
 return candidates.length===1?candidates[0]:null;
}
async function settlement(before:Effects,after:Effects,completed:boolean,actorUid:number,serviceId:number,recordTime:number):Promise<CustomerWorkWriteoffSettlement|null>{
 fact(await unchanged(before.paid,after.paid)&&await unchanged(before.outbox,after.outbox),'核销改变了原支付主单或重复创建支付事件');
 const rewards=after.bills.filter(r=>!before.bills.some(b=>b.id===r.id)),brokerage=after.brokerage.filter(r=>!before.brokerage.some(b=>b.id===r.id)),newStatuses=after.statuses.filter(r=>!before.statuses.some(b=>b.id===r.id));
 const audits=newStatuses.filter(r=>r.changeType==='customer_order_writeoff');
 fact(rewards.length<=200&&brokerage.length<=200&&newStatuses.length===(completed?2:1)&&audits.length===1&&audits[0].changeMessage===`手机订单用户 ${actorUid}，经营身份 ${serviceId} 完成${completed?'全部':'部分'}核销`&&audits[0].changeTime===recordTime,'真实核销操作者审计与原执行不一致');
 fact(await unchanged(before.statuses,after.statuses.filter(r=>before.statuses.some(b=>b.id===r.id))),'既有核销或收货审计被改写');
 fact(await unchanged(before.bills,after.bills.filter(r=>before.bills.some(b=>b.id===r.id)))&&await unchanged(before.brokerage,after.brokerage.filter(r=>before.brokerage.some(b=>b.id===r.id))),'既有积分经验或佣金账被改写');
 fact(before.accounts.length===after.accounts.length&&before.accounts.every((a,i)=>a.uid===after.accounts[i].uid));
 if(!completed){fact(!rewards.length&&!brokerage.length&&!newStatuses.some(r=>r.changeType==='take_delivery')&&await unchanged(before.accounts,after.accounts)&&await unchanged(before.supplier,after.supplier),'部分核销提前结算了账款或奖励');return null;}
 const take=newStatuses.filter(r=>r.changeType==='take_delivery');fact(take.length===1&&take[0].changeMessage==='手机订单用户完成订单核销'&&take[0].changeTime===recordTime,'最终核销缺少实际收货结算状态');
 const account_deltas=before.accounts.map((a,i)=>{const b=after.accounts[i],r=rewards.filter(r=>r.uid===a.uid),c=brokerage.filter(r=>r.uid===a.uid);fact(Number.isSafeInteger(a.integral)&&Number.isSafeInteger(b.integral)&&a.integral>=0&&b.integral>=0);const integral=r.filter(r=>r.category==='integral').reduce((n,r)=>n+signed(r),0n),exp=r.filter(r=>r.category==='exp').reduce((n,r)=>n+signed(r),0n),commission=c.reduce((n,r)=>n+signed(r),0n);fact(BigInt(b.integral-a.integral)*100n===integral&&cents(b.exp)-cents(a.exp)===exp&&cents(b.brokerage)-cents(a.brokerage)===commission,'实际账户变更与积分、经验、佣金原账不一致');return{uid:a.uid,integral_before:a.integral,integral_after:b.integral,exp_before:a.exp,exp_after:b.exp,brokerage_before:a.brokerage,brokerage_after:b.brokerage};});
 fact([...rewards,...brokerage].every(r=>r.uid>0&&r.status===1&&account_deltas.some(a=>a.uid===r.uid)),'实际入账接收人与已锁定账户不一致');
 const supplier_rows=after.supplier.map(r=>{const original=before.supplier.find(b=>b.id===r.id);fact(original&&original.supplierId===r.supplierId&&original.uid===r.uid&&r.uid===after.paid.uid&&original.linkId===r.linkId&&original.type===r.type&&original.pm===r.pm&&original.number===r.number&&[0,1].includes(original.status)&&r.status===1&&(original.status!==0||r.finishTime>0),'供应商结算原账与完成状态不一致');return{row_id:r.id,before_status:original!.status,after_status:1 as const,amount:r.number,pm:r.pm,type:r.type};});fact(supplier_rows.length===before.supplier.length);
 return{version:'customer-writeoff-settlement-v1',take_delivery_status_id:take[0].id,supplier_rows,reward_rows:rewards.map(r=>{fact(['integral','exp'].includes(r.category));return{row_id:r.id,uid:r.uid,link_id:r.linkId,category:r.category as 'integral'|'exp',event_key:r.eventKey,type:r.type,pm:r.pm,amount:r.number,balance:r.balance};}),brokerage_rows:brokerage.map(r=>({row_id:r.id,uid:r.uid,link_id:r.linkId,type:r.type,source_type:r.sourceType,pm:r.pm,amount:r.number,balance:r.balance})),account_deltas,paid_root:after.paid,paid_outbox_rows:after.outbox,new_paid_outbox_count:0};
}

export class CustomerWorkWriteoffService {
 readonly ledger:CustomerWorkWriteoffOperationRequest;readonly reader:CustomerWorkWriteoffReadService;
 constructor(readonly container:Container,readonly env:Env){this.ledger=new CustomerWorkWriteoffOperationRequest(container);this.reader=new CustomerWorkWriteoffReadService(container,env);}
 async execute(context:WriteoffContext,value:unknown):Promise<CustomerWorkWriteoffResult>{
  const p=await prepareWriteoff(context,value);let replayed=false,written:WriteoffReceipt|null=null;
  try{written=await withTx(this.container,async tx=>{
   const prior=await checkWriteoffRequest(tx,p);if(prior){await authorizeCustomerOperationOwner(tx,p.actor);replayed=true;return null;}
   const order=await lockCustomerWorkOrder(tx,p.input.order_id);
   // Match code rotation globally, and fence new cart/refund/pink rows before
   // user locks. NOWAIT makes foreign lock order contention bounded.
   await tx.execute(sql`SELECT pg_advisory_xact_lock(63843,0)`);
   await tx.execute(sql`LOCK TABLE store_order_cart_info,store_order_refund,store_pink IN SHARE MODE NOWAIT`);
   const compensation=Number(order.refundPrice)>0?await loadRefundLineCompensation(tx,order.id):null;
   await lockOrderSettlementUsers(tx,order,compensation?.earnedIncome?.orderId,[p.actor.uid]);
   const scope=await authorizeWriteoffOperation(tx,p),review=await assertCustomerWriteoffReview(tx,order,p,true),carts=review.facts.carts;
   const links=[...new Set([String(order.id),String(compensation?.earnedIncome?.orderId??order.id)])];
   const history=await tx.select({uid:userBrokerage.uid}).from(userBrokerage).where(inArray(userBrokerage.linkId,links)).limit(65);fact(history.length<=64);
   const uids=[...new Set([p.actor.uid,order.uid,order.spreadUid,order.spreadTwoUid,order.divisionId,order.divisionAgentId,order.divisionStaffId,...history.map(r=>r.uid)].filter(id=>id>0))].sort((a,b)=>a-b);fact(uids.length<=70);
   const selected=p.input.payload.items.map(item=>{const cart=carts.find(c=>c.id===item.cart_row_id);fact(cart&&item.writeoff_num<=cart.writeSurplusTimes,'核销商品不属于当前订单或剩余次数不足');return{cart:cart!,quantity:item.writeoff_num,price:customerWriteoffLinePrice(cart!,item.writeoff_num),proof:review.facts.prices[carts.indexOf(cart!)]};});
   const before=await capture(tx,order,links,uids),recordBefore=await tx.select({id:storeOrderWriteoff.id}).from(storeOrderWriteoff).where(eq(storeOrderWriteoff.oid,order.id));
   const result=await new StoreOrderWriteoffService(createContainerFromDb(tx),this.env).execute({kind:'customer',uid:p.actor.uid,actor:p.actor,serviceId:scope.service_id,scopeKey:scope.scope_key,authorize:async(db,current,actual)=>{const authority=await authorizeWriteoffOperation(db,p);fact(authority.service_id===scope.service_id&&current.id===order.id&&actual.length===carts.length&&actual.every((c,i)=>c.id===carts[i].id&&c.cartInfo===carts[i].cartInfo&&c.writeSurplusTimes===carts[i].writeSurplusTimes));await assertCustomerWriteoffReview(db,current,p,true);}}, {code:p.input.payload.code,items:p.input.payload.items.map(i=>({orderCartId:i.cart_row_id,quantity:i.writeoff_num}))});
   const actual=await customerWriteoffOrder(tx,order.id,p.input.payload.order_no),post=await customerWriteoffState(tx,actual,true),ids=result.record_ids;
   fact(Array.isArray(ids)&&ids.length===selected.length&&new Set(ids).size===ids.length&&result.order_id===actual.orderId&&actual.clerkId===p.actor.uid&&actual.status===(result.completed?2:5)&&actual.verifyCode===(result.completed?'':actual.verifyCode)&&(!result.completed?/^\d{12}$/.test(actual.verifyCode)&&actual.verifyCode!==order.verifyCode:post.facts.carts.every(c=>c.writeSurplusTimes===0)));
   const records=await tx.select().from(storeOrderWriteoff).where(eq(storeOrderWriteoff.oid,order.id)).orderBy(asc(storeOrderWriteoff.id));fact(records.length===recordBefore.length+selected.length&&records.filter(r=>!recordBefore.some(b=>b.id===r.id)).every(r=>ids!.includes(r.id)));
   const writeoff_rows:CustomerWorkWriteoffRowEvidence[]=selected.map(({cart,quantity,price,proof})=>{const row=records.find(r=>ids!.includes(r.id)&&r.orderCartId===cart.id),after=post.facts.carts.find(r=>r.id===cart.id);fact(row&&after&&row.oid===order.id&&row.uid===order.uid&&row.productId===cart.productId&&row.productType===cart.productType&&row.type===cart.type&&row.relationId===cart.relationId&&row.writeoffNum===quantity&&row.writeoffPrice===price&&row.writeoffCode===order.verifyCode&&row.isAdmin===0&&row.adminId===0&&row.staffId===0&&after.writeSurplusTimes===cart.writeSurplusTimes-quantity&&after.isWriteoff===(after.writeSurplusTimes===0?1:0)&&after.staffId===0&&after.deliveryId===0&&proof.snapshot_hash&&proof.price_hash);return{writeoff_id:row!.id,cart_row_id:cart.id,opaque_cart_id:cart.cartId,quantity,before_remaining:cart.writeSurplusTimes,after_remaining:after!.writeSurplusTimes,writeoff_price:price,snapshot_hash:proof.snapshot_hash!,sale_price_hash:proof.price_hash!};});
   fact(post.facts.carts.length===carts.length&&post.facts.carts.every(c=>{const b=carts.find(b=>b.id===c.id);return !!b&&c.cartInfo===b.cartInfo&&c.cartId===b.cartId&&c.writeTimes===b.writeTimes&&c.writeSurplusTimes===b.writeSurplusTimes-(selected.find(s=>s.cart.id===c.id)?.quantity??0);}));
   const actualRecords=records.filter(r=>ids!.includes(r.id));fact(actualRecords.every(r=>r.addTime===actualRecords[0].addTime));
   const financial=await settlement(before,await capture(tx,actual,links,uids),result.completed,p.actor.uid,scope.service_id,actualRecords[0].addTime),evidence=freezeCustomerJson({verified:true,order_completed:result.completed,status:actual.status,physical_order_id:actual.id,root_order_id:post.facts.root.id,writeoff_rows,before_code_hash:await outRequestHash(order.verifyCode),after_code_hash:await outRequestHash(actual.verifyCode),post_order_revision:post.order_revision,post_writeoff_revision:post.writeoff_revision,settlement:financial},262144);
   const appended=await appendWriteoffOperation(tx,p,scope.service_id,result.completed?'written-off':'partial-writtenoff',evidence as Record<string,CustomerJson>);
   fact(await this.committed(tx,appended,p),'同事务回执与实际核销记录不一致');return appended;
  });}catch(error){const original=await this.ledger.original(p.actor,p.key);if(original){sameWriteoffReceipt(original.receipt,p);return this.status(p.actor,p.key,true);}const rejected=await this.ledger.reject(p,error);if(rejected)return rejected;throw error;}
  // Only the outer transaction's successful COMMIT acknowledgement admits this
  // result. Recovery and replay still authenticate the original owner afresh.
  // A later request can lock that account immediately after our commit; it must
  // not turn this already verified transaction into an apparent failed write.
  if(written)return{receipt:written,replayed:false,execution:{version:'customer-work-writeoff-execution-v1',request_key:written.request_key,request_hash:written.request_hash,order_id:written.order_id,state:'SQL_COMMITTED',committed:true,verified:true,order_completed:written.outcome==='written-off',reason:''}};
  return this.status(p.actor,p.key,replayed);
 }
 private async committed(db:DbClient,receipt:WriteoffReceipt,p:PreparedWriteoff):Promise<boolean>{
  const e=receipt.evidence,raw=e.writeoff_rows;if(!Array.isArray(raw)||!raw.length||raw.length!==p.input.payload.items.length||e.verified!==true||e.physical_order_id!==p.input.order_id||e.root_order_id!==p.input.payload.root_order_id||e.before_code_hash!==await outRequestHash(p.input.payload.code))return false;
  const expected=raw as unknown as CustomerWorkWriteoffRowEvidence[],rows=await db.select().from(storeOrderWriteoff).where(inArray(storeOrderWriteoff.id,expected.map(r=>r.writeoff_id))).orderBy(asc(storeOrderWriteoff.id));
  const physical=await customerWriteoffOrder(db,receipt.order_id,p.input.payload.order_no),root=await customerWriteoffRoot(db,physical),carts=await customerWriteoffCarts(db,physical);
  if(root.id!==p.input.payload.root_order_id||root.orderId!==p.input.payload.root_order_no||rows.length!==expected.length)return false;
  for(const[rIndex,r]of expected.entries()){
   const cart=carts.find(c=>c.id===r.cart_row_id),record=rows.find(a=>a.id===r.writeoff_id);if(!cart||!record||r.cart_row_id!==p.input.payload.items[rIndex].cart_row_id||r.quantity!==p.input.payload.items[rIndex].writeoff_num||r.before_remaining-r.after_remaining!==r.quantity||cart.cartId!==r.opaque_cart_id||record.oid!==receipt.order_id||record.uid!==physical.uid||record.orderCartId!==r.cart_row_id||record.productId!==cart.productId||record.productType!==cart.productType||record.type!==cart.type||record.relationId!==cart.relationId||record.writeoffNum!==r.quantity||record.writeoffPrice!==r.writeoff_price||record.writeoffCode!==p.input.payload.code||record.staffId!==0||record.isAdmin!==0||record.adminId!==0)return false;
   // The admitted purchase snapshot stays immutable through later writeoffs.
   // Reconstruct this receipt's prefix instead of trusting today's counter.
   const admitted=await originalReceiptCart(db,physical,carts,r);if(!admitted)return false;const original={...admitted,writeSurplusTimes:r.before_remaining},proof=await customerWriteoffSalePriceProof(original);
   if(proof.snapshot_hash!==r.snapshot_hash||proof.price_hash!==r.sale_price_hash||customerWriteoffLinePrice(original,r.quantity)!==r.writeoff_price)return false;
  }
  const audits=await db.select({message:storeOrderStatus.changeMessage,time:storeOrderStatus.changeTime}).from(storeOrderStatus).where(and(eq(storeOrderStatus.oid,receipt.order_id),eq(storeOrderStatus.changeType,'customer_order_writeoff'),eq(storeOrderStatus.changeMessage,`手机订单用户 ${receipt.actor_uid}，经营身份 ${receipt.service_id} 完成${receipt.outcome==='written-off'?'全部':'部分'}核销`),eq(storeOrderStatus.changeTime,rows[0].addTime))).limit(1);if(audits.length!==1||!rows.every(r=>r.addTime===rows[0].addTime))return false;
  if(receipt.outcome==='partial-writtenoff')return e.order_completed===false&&e.status===5&&e.settlement===null&&typeof e.after_code_hash==='string'&&e.after_code_hash!==e.before_code_hash&&e.after_code_hash!==await outRequestHash('');
  if(receipt.outcome!=='written-off'||e.order_completed!==true||e.status!==2||e.after_code_hash!==await outRequestHash('')||!e.settlement||typeof e.settlement!=='object'||Array.isArray(e.settlement))return false;
  const s=e.settlement as unknown as CustomerWorkWriteoffSettlement,take=await db.select({id:storeOrderStatus.id}).from(storeOrderStatus).where(and(eq(storeOrderStatus.id,s.take_delivery_status_id),eq(storeOrderStatus.oid,receipt.order_id),eq(storeOrderStatus.changeType,'take_delivery'),eq(storeOrderStatus.changeMessage,'手机订单用户完成订单核销'),eq(storeOrderStatus.changeTime,rows[0].addTime))).limit(2);if(take.length!==1||!await unchanged(s.paid_root,await paidIdentity(root)))return false;
  const reward=s.reward_rows.length?await db.select(billColumns).from(userBill).where(inArray(userBill.id,s.reward_rows.map(r=>r.row_id))):[],brokerage=s.brokerage_rows.length?await db.select(brokerageColumns).from(userBrokerage).where(inArray(userBrokerage.id,s.brokerage_rows.map(r=>r.row_id))):[],supplier=s.supplier_rows.length?await db.select(supplierColumns).from(supplierFlowingWater).where(inArray(supplierFlowingWater.id,s.supplier_rows.map(r=>r.row_id))):[];
  return reward.length===s.reward_rows.length&&brokerage.length===s.brokerage_rows.length&&supplier.length===s.supplier_rows.length&&s.reward_rows.every(r=>reward.some(a=>a.id===r.row_id&&a.uid===r.uid&&a.linkId===r.link_id&&a.category===r.category&&a.type===r.type&&a.eventKey===r.event_key&&a.pm===r.pm&&a.number===r.amount&&a.balance===r.balance&&a.status===1))&&s.brokerage_rows.every(r=>brokerage.some(a=>a.id===r.row_id&&a.uid===r.uid&&a.linkId===r.link_id&&a.type===r.type&&a.sourceType===r.source_type&&a.pm===r.pm&&a.number===r.amount&&a.balance===r.balance&&a.status===1))&&s.supplier_rows.every(r=>supplier.some(a=>a.id===r.row_id&&a.supplierId===physical.supplierId&&a.linkId===p.input.payload.order_no&&a.uid===physical.uid&&a.pm===r.pm&&a.type===r.type&&a.number===r.amount&&a.status===1&&a.isDel===0))&&s.paid_root.order_id===p.input.payload.root_order_id&&s.paid_root.order_no===p.input.payload.root_order_no&&await unchanged(s.paid_outbox_rows,await paymentRows(db,root));
 }
 /** Minimal authenticated original-owner read, including after a role revoke.
  * It verifies immutable SQL rows; it never invokes payment/notification I/O. */
 async status(actorValue:CustomerWorkActor,keyValue:unknown,replayed=false):Promise<CustomerWorkWriteoffResult>{const actor=freezeCustomerActor(actorValue),key=normalizeOutRequestKey(keyValue),original=await this.ledger.original(actor,key);if(!original)return{receipt:null,replayed,execution:null};const{receipt,p}=original;if(!['partial-writtenoff','written-off'].includes(receipt.outcome))return{receipt,replayed,execution:null};
  return withTx(this.container,async db=>{await db.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`);await lockWriteoffRequest(db,actor.uid,key,false);await authorizeCustomerOperationOwner(db,actor);let verified=false;try{verified=await this.committed(db,receipt,p);}catch(error){if(!(error instanceof ValidateException||error instanceof NotFoundException))throw error;}const execution:CustomerWorkWriteoffExecution={version:'customer-work-writeoff-execution-v1',request_key:key,request_hash:receipt.request_hash,order_id:receipt.order_id,state:verified?'SQL_COMMITTED':'UNKNOWN',committed:verified,verified,order_completed:verified&&receipt.outcome==='written-off',reason:verified?'':'原核销回执与实际不可变记录暂无法完整核对，请保留原编号核对'};return{receipt,replayed,execution};});
 }
 async abandon(actor:CustomerWorkActor,keyValue:unknown,value:unknown,header:unknown){const key=normalizeOutRequestKey(keyValue);if(normalizeOutRequestKey(header)!==key)throw new HttpApiException('放弃核销必须核对原请求编号',409,409);const body=writeoffRecord(value,['kind','input']);if(body.kind!=='writeoff')throw new ValidateException('原核销操作类型无效');const result=await this.ledger.abandon({actor,request_key:key},body.input);return result.receipt.outcome==='abandoned'?result:this.status(actor,key,true);}
}
