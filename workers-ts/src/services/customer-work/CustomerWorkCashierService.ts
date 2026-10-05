import { and, asc, eq, sql } from 'drizzle-orm';
import { withTx, createContainerFromDb, type Container, type DbClient } from '@/lib/di';
import type { Env } from '@/env';
import { storeCart, storeOrder, storeOrderOutbox, storeOrderStatus, user } from '@/models/schema';
import { ValidateException, HttpApiException } from '@/utils/errors';
import { normalizeOutRequestKey, outRequestHash } from '@/services/out/OutIdempotency';
import { authorizeCustomerWorkActor, type CustomerWorkActor } from './CustomerWorkScope';
import { authorizeCustomerOperationOwner, freezeCustomerActor, freezeCustomerJson } from './CustomerWorkOperationRequest';
import { acquireCustomerWorkScopeLock } from '@/migrations/runCustomerWorkScopeLock';
import { assertCashierSecondCardOriginCatalog, cashierSecondCardOriginReadiness } from '@/migrations/runCashierSecondCardOrigin';
import { StoreOrderCreateService, type StoreOrderCreationRuntime, type OrderPricingQuote } from '@/services/order/StoreOrderCreateService';
import { prepareCashierSecondCardCreation } from '@/services/order/CashierSecondCardOrigin';
import { applyStoreOrderPayment } from '@/services/order/StoreOrderPayService';
import { type CheckoutConfirmation, OrderQuoteReconfirmRequired } from '@/services/order/CheckoutConfirmation';
import { lockOrderSettlement } from '@/services/order/OrderBrokerageService';
import { hasInitiatedAssistedProviderPayment } from '@/services/payment/AssistedProviderPaymentClaim';
import { OrderOutboxService } from '@/services/order/OrderOutboxService';

export const CUSTOMER_CASHIER_VERSION='customer-cashier-second-card-v1' as const;
export const CUSTOMER_CASHIER_PAYMENT_VERSION='customer-cashier-second-card-payment-v1' as const;
export interface CustomerCashierInput {
  version:typeof CUSTOMER_CASHIER_VERSION;scope_key:string;buyer_uid:number;tourist_key:string;
  product_id:number;sku_unique:string;quantity:number;real_name:string;user_phone:string;mark:string;
  custom_form:unknown;coupon_id:number;use_integral:boolean;
}
export interface CustomerCashierNativeInput extends CustomerCashierInput {request_key:string;quote_token?:string}
export interface CustomerCashierPaymentInput {request_key:string;version:typeof CUSTOMER_CASHIER_PAYMENT_VERSION;
  scope_key:string;order_id:number;order_no:string;expected_amount:string}
const bodyKeys=['version','scope_key','buyer_uid','tourist_key','product_id','sku_unique','quantity','real_name','user_phone','mark','custom_form','coupon_id','use_integral'];
function object(value:unknown,keys:readonly string[]):Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value)
  ||Object.keys(value).sort().join('|')!==[...keys].sort().join('|'))throw new ValidateException('次卡收银字段不完整');return value as Record<string,unknown>;}
function integer(value:unknown,zero=false,max=2147483647):number{if(typeof value!=='number'||!Number.isSafeInteger(value)||value<(zero?0:1)||value>max)throw new ValidateException('收银身份或数量无效');return value;}
function string(value:unknown,max:number,empty=false):string{if(typeof value!=='string'||value.length>(max)||(!empty&&!value)||value.trim()!==value||/[\u0000-\u001f\u007f]/.test(value))throw new ValidateException('收银文字或标识无效');return value;}
function digest(value:unknown):string{const s=string(value,64);if(!/^[a-f0-9]{64}$/.test(s))throw new ValidateException('收银身份摘要无效');return s;}
function parseInput(value:unknown):CustomerCashierInput{const r=object(value,bodyKeys);if(r.version!==CUSTOMER_CASHIER_VERSION||typeof r.use_integral!=='boolean')throw new ValidateException('收银合同版本或积分选择无效');
  const buyer_uid=integer(r.buyer_uid,true),tourist_key=string(r.tourist_key,50,true),sku_unique=string(r.sku_unique,16);
  if((buyer_uid===0&&!/^[A-Za-z0-9_-]{1,50}$/.test(tourist_key))||(buyer_uid>0&&tourist_key!==''))throw new ValidateException('游客与实名购买身份不能混用');
  return Object.freeze({version:CUSTOMER_CASHIER_VERSION,scope_key:digest(r.scope_key),buyer_uid,tourist_key,
    product_id:integer(r.product_id),sku_unique,quantity:integer(r.quantity,false,32767),real_name:string(r.real_name,32),
    user_phone:string(r.user_phone,20),mark:string(r.mark,512,true),custom_form:freezeCustomerJson(r.custom_form,65536),
    coupon_id:integer(r.coupon_id,true),use_integral:r.use_integral});}
async function admission(db:DbClient,actor:CustomerWorkActor,scopeKey:string){await assertCashierSecondCardOriginCatalog(db);
  if(!(await cashierSecondCardOriginReadiness(db)).ready)throw new HttpApiException('客户次卡收银权限尚未验收',503,503);
  const scope=await authorizeCustomerWorkActor(db,actor);if(scope.scope_key!==scopeKey)throw new HttpApiException('客户收银身份已变化，请重新读取',403,403);return scope;}
async function lockRequest(tx:DbClient,actor:CustomerWorkActor,key:string){await tx.execute(sql`SET LOCAL row_security=off`);
  await tx.execute(sql`SELECT set_config('lock_timeout','1500ms',true),set_config('statement_timeout','5000ms',true)`);
  const h=await outRequestHash([actor.uid,key]);await tx.execute(sql`SELECT pg_advisory_xact_lock(731688::int,${parseInt(h.slice(0,8),16)|0}::int)`);}

/** This mutation creates one actual customer-owned draft cart. Existing Admin
 * cart staff IDs never provide the independent customer draft proof. */
export async function prepareCustomerCashierDraft(container:Container,actorValue:CustomerWorkActor,keyValue:unknown,value:unknown){
  const actor=freezeCustomerActor(actorValue),key=normalizeOutRequestKey(keyValue),input=parseInput(value),request_hash=await outRequestHash(input);
  return withTx(container,async tx=>{await admission(tx,actor,input.scope_key);await lockRequest(tx,actor,key);
    await tx.execute(sql`LOCK TABLE public.cashier_second_card_cart_v1 IN ROW SHARE MODE NOWAIT`);
    await authorizeCustomerOperationOwner(tx,actor);await acquireCustomerWorkScopeLock(tx,actor.uid);await admission(tx,actor,input.scope_key);
    const previous=await tx.execute<{cart_id:number;request_hash:string;buyer_uid:number;tourist_hash:string}>(sql`SELECT cart_id,request_hash,buyer_uid,tourist_hash
      FROM public.cashier_second_card_cart_v1 WHERE actor_uid=${actor.uid} AND request_key=${key}::uuid LIMIT 2`);
    if(previous.length){if(previous.length!==1||previous[0].request_hash!==request_hash||previous[0].buyer_uid!==input.buyer_uid
      ||previous[0].tourist_hash!==await outRequestHash(input.tourist_key))throw new HttpApiException('原收银请求已绑定其他内容',409,409);
      return {cart_id:previous[0].cart_id,request_hash,replayed:true};}
    if(input.buyer_uid>0){const rows=await tx.select({uid:user.uid}).from(user).where(and(eq(user.uid,input.buyer_uid),eq(user.status,1),eq(user.isDel,0),sql`${user.deleteTime} IS NULL`)).limit(1).for('share',{noWait:true});if(rows.length!==1)throw new ValidateException('购买用户已失效');}
    const[cart]=await tx.insert(storeCart).values({uid:input.buyer_uid,touristUid:input.tourist_key,staffId:actor.uid,
      productId:input.product_id,productType:4,productAttrUnique:input.sku_unique,cartNum:input.quantity,type:0,isNew:1,addTime:Math.floor(Date.now()/1000)}).returning();
    if(!cart)throw Error('Actual cashier cart was not persisted');
    await tx.execute(sql`INSERT INTO public.cashier_second_card_cart_v1(actor_uid,buyer_uid,cart_id,request_key,request_hash,tourist_hash)
      VALUES(${actor.uid},${input.buyer_uid},${cart.id},${key}::uuid,${request_hash},${await outRequestHash(input.tourist_key)})`);
    return {cart_id:cart.id,request_hash,replayed:false};});
}
async function cartCapability(container:Container,actor:CustomerWorkActor,key:string,input:CustomerCashierInput,confirmation?:CheckoutConfirmation){
  const request_hash=await outRequestHash(input),rows=await container.db.execute<{cart_id:number;request_hash:string}>(sql`SELECT cart_id,request_hash
    FROM public.cashier_second_card_cart_v1 WHERE actor_uid=${actor.uid} AND request_key=${key}::uuid LIMIT 2`);
  if(rows.length!==1||rows[0].request_hash!==request_hash)throw new ValidateException('原收银购物行或请求内容无法核对');
  const[cart]=await container.db.select().from(storeCart).where(eq(storeCart.id,rows[0].cart_id)).limit(1);
  if(!cart||cart.productId!==input.product_id||cart.productAttrUnique!==input.sku_unique||cart.cartNum!==input.quantity)
    throw new ValidateException('收银购物行选品或数量已变化');
  return {cart_id:cart.id,capability:await prepareCashierSecondCardCreation(container.db,{actor,scope_key:input.scope_key,buyer_uid:input.buyer_uid,
    request_key:key,request_hash,cart_ids:[cart.id],tourist_key:input.tourist_key,confirmation,
    selection:{product_id:input.product_id,sku_unique:input.sku_unique,quantity:input.quantity}})};
}
function coreParams(input:CustomerCashierInput,key:string,cartId:number){return{uid:input.buyer_uid,key:key.replaceAll('-',''),cartIds:[cartId],shippingType:2,storeId:0,type:0,
  realName:input.real_name,userPhone:input.user_phone,mark:input.mark,customForm:input.custom_form,couponId:input.coupon_id,useIntegral:input.use_integral,userIp:'',payType:'cash'};}
const receiptKey=(actor:CustomerWorkActor,key:string,token:string)=>`customer:cashier:quote:v1:${actor.uid}:${key}:${token}`;
async function issueQuote(runtime:StoreOrderCreationRuntime,actor:CustomerWorkActor,key:string,input:CustomerCashierInput,quote:OrderPricingQuote){
  const token=crypto.randomUUID().replaceAll('-',''),expiresAt=Math.floor(Date.now()/1000)+1800;
  await runtime.CONFIG_KV.put(receiptKey(actor,key,token),JSON.stringify({version:CUSTOMER_CASHIER_VERSION,actor_uid:actor.uid,request_key:key,
    request_hash:await outRequestHash(input),scope_key:input.scope_key,fingerprint:quote.confirmationFingerprint,expiresAt}),{expirationTtl:1800});return token;}
async function readQuote(runtime:StoreOrderCreationRuntime,actor:CustomerWorkActor,key:string,input:CustomerCashierInput,token:unknown):Promise<CheckoutConfirmation>{
  if(typeof token!=='string'||!/^[a-f0-9]{32}$/.test(token))throw new OrderQuoteReconfirmRequired(key);
  const text=await runtime.CONFIG_KV.get(receiptKey(actor,key,token));if(!text||text.length>4096)throw new OrderQuoteReconfirmRequired(key);
  let r:Record<string,unknown>;try{r=object(JSON.parse(text),['version','actor_uid','request_key','request_hash','scope_key','fingerprint','expiresAt']);}catch{throw new OrderQuoteReconfirmRequired(key);}
  if(r.version!==CUSTOMER_CASHIER_VERSION||r.actor_uid!==actor.uid||r.request_key!==key||r.request_hash!==await outRequestHash(input)
    ||r.scope_key!==input.scope_key||typeof r.expiresAt!=='number'||!Number.isSafeInteger(r.expiresAt)||r.expiresAt<=Math.floor(Date.now()/1000))throw new OrderQuoteReconfirmRequired(key);
  return{fingerprint:digest(r.fingerprint),expiresAt:r.expiresAt};}
export async function quoteCustomerCashierSecondCard(container:Container,runtime:StoreOrderCreationRuntime,actorValue:CustomerWorkActor,keyValue:unknown,value:unknown){
  const actor=freezeCustomerActor(actorValue),key=normalizeOutRequestKey(keyValue),input=parseInput(value);await admission(container.db,actor,input.scope_key);
  const c=await cartCapability(container,actor,key,input);
  const quote=await StoreOrderCreateService.createWithRuntime(container,{...runtime,cashierSecondCardCreation:c.capability},coreParams(input,key,c.cart_id),{preview:true});
  await admission(container.db,actor,input.scope_key);return{quote,quote_token:await issueQuote(runtime,actor,key,input,quote)};}
export async function createCustomerCashierSecondCard(container:Container,runtime:StoreOrderCreationRuntime,actorValue:CustomerWorkActor,keyValue:unknown,value:unknown,token:unknown){
  const actor=freezeCustomerActor(actorValue),key=normalizeOutRequestKey(keyValue),input=parseInput(value);await admission(container.db,actor,input.scope_key);
  const existing=await container.storeOrderDao.findByUnique(input.buyer_uid,key.replaceAll('-',''));
  const c=await cartCapability(container,actor,key,input,existing?undefined:await readQuote(runtime,actor,key,input,token));
  return StoreOrderCreateService.createWithRuntime(container,{...runtime,requirePurchaseOrigin:true,cashierSecondCardCreation:c.capability},coreParams(input,key,c.cart_id));}
/** Native server adapter exercises the same draft, quote and creation pipeline;
 * no fixture inserts a fabricated paid order or origin receipt. */
export async function createCustomerCashierSecondCardWithRuntime(container:Container,runtime:StoreOrderCreationRuntime,actor:CustomerWorkActor,value:CustomerCashierNativeInput){
  const {request_key,quote_token,...body}=value;await prepareCustomerCashierDraft(container,actor,request_key,body);
  const existing=await container.storeOrderDao.findByUnique(body.buyer_uid,normalizeOutRequestKey(request_key).replaceAll('-',''));
  const token=existing?undefined:quote_token??(await quoteCustomerCashierSecondCard(container,runtime,actor,request_key,body)).quote_token;
  return createCustomerCashierSecondCard(container,runtime,actor,request_key,body,token);
}

/** Request admission, original payment transition and the immutable cashier
 * receipt commit in one outer transaction. Nested core payment uses a savepoint. */
export async function applyCustomerCashierCashPayment(container:Container,actorValue:CustomerWorkActor,value:CustomerCashierPaymentInput){
  const actor=freezeCustomerActor(actorValue),r=object(value,['request_key','version','scope_key','order_id','order_no','expected_amount']);
  if(r.version!==CUSTOMER_CASHIER_PAYMENT_VERSION)throw new ValidateException('次卡收银付款版本无效');
  const key=normalizeOutRequestKey(r.request_key),scopeKey=digest(r.scope_key),orderId=integer(r.order_id),orderNo=string(r.order_no,32),amount=string(r.expected_amount,13);
  if(!/^[A-Za-z0-9_-]+$/.test(orderNo)||!/^(0|[1-9]\d{0,9})\.\d{2}$/.test(amount))throw new ValidateException('付款订单号或金额格式无效');
  const request_hash=await outRequestHash({version:CUSTOMER_CASHIER_PAYMENT_VERSION,scope_key:scopeKey,order_id:orderId,order_no:orderNo,expected_amount:amount});
  return withTx(container,async tx=>{await assertCashierSecondCardOriginCatalog(tx);await lockRequest(tx,actor,key);
    await tx.execute(sql`LOCK TABLE public.cashier_second_card_payment_v1 IN ROW SHARE MODE NOWAIT`);
    await lockOrderSettlement(tx,orderId);const[order]=await tx.select().from(storeOrder).where(eq(storeOrder.id,orderId)).limit(1).for('update');
    await authorizeCustomerOperationOwner(tx,actor);
    const previous=await tx.execute<{request_hash:string;order_id:number;evidence:unknown}>(sql`SELECT request_hash,order_id,evidence
      FROM public.cashier_second_card_payment_v1 WHERE actor_uid=${actor.uid} AND request_key=${key}::uuid LIMIT 2`);
    if(previous.length){if(previous.length!==1||previous[0].request_hash!==request_hash||previous[0].order_id!==orderId)throw new HttpApiException('原付款请求已用于其他内容',409,409);return{evidence:previous[0].evidence,replayed:true,outbox:null};}
    await acquireCustomerWorkScopeLock(tx,actor.uid);const scope=await admission(tx,actor,scopeKey);
    if(!order||order.orderId!==orderNo||order.staffId!==actor.uid||order.payPrice!==amount||order.pid!==0||order.productType!==4
      ||order.shippingType!==2||order.storeId!==0||order.status!==0||order.paid!==0||order.isDel||order.isSystemDel||order.tradeNo!=='')throw new ValidateException('收银订单、实际金额或支付状态已变化');
    const origins=await tx.execute<{origin:Record<string,unknown>;origin_hash:string}>(sql`SELECT origin,origin_hash FROM public.cashier_second_card_origin_v1 WHERE order_id=${orderId} LIMIT 2`);
    if(origins.length!==1||origins[0].origin.creator_uid!==actor.uid||origins[0].origin.root_order_no!==orderNo
      ||await outRequestHash(origins[0].origin)!==origins[0].origin_hash)throw new ValidateException('原客户收银创建来源缺失');
    // Any surviving provider claim, including UNKNOWN, excludes a second cash payment.
    if(await hasInitiatedAssistedProviderPayment(tx,orderNo))throw new ValidateException('扫码支付已发起，请先核对原支付结果');
    const paid=await applyStoreOrderPayment(createContainerFromDb(tx),{orderId,payType:'cash',audit:{changeType:'customer_cashier_paid',changeMessage:`客户 ${actor.uid} 确认次卡收银现金付款`},
      authorizeBeforePayment:async(inner,locked)=>{await admission(inner,actor,scopeKey);if(locked.id!==orderId||locked.orderId!==orderNo||locked.payPrice!==amount||locked.paid!==0)throw new ValidateException('原收银付款条件已变化');}});
    if(paid.outcome!=='paid'||!paid.outbox)throw new ValidateException('收银订单未实际入账');
    const[actual]=await tx.select().from(storeOrder).where(eq(storeOrder.id,orderId)).limit(1),audits=await tx.select().from(storeOrderStatus)
      .where(and(eq(storeOrderStatus.oid,orderId),eq(storeOrderStatus.changeType,'customer_cashier_paid'))).orderBy(asc(storeOrderStatus.id)).limit(2);
    const[event]=await tx.select().from(storeOrderOutbox).where(eq(storeOrderOutbox.id,paid.outbox.id)).limit(1);
    if(!actual||actual.paid!==1||audits.length!==1||!event)throw Error('Actual cashier payment effects are incomplete');
    const evidence=freezeCustomerJson({version:'cashier-second-card-payment-v1',order_id:orderId,order_no:orderNo,buyer_uid:actual.uid,creator_uid:actor.uid,
      paid:1,pay_type:'cash',pay_time:actual.payTime,amount,trade_no:'',status_id:audits[0].id,outbox_id:event.id,event_key:event.eventKey,
      payload_hash:await outRequestHash(event.payload),origin_hash:origins[0].origin_hash},262144),payment_kind=amount==='0.00'?'zero':'cash';
    await tx.execute(sql`INSERT INTO public.cashier_second_card_payment_v1(order_id,actor_uid,service_id,request_key,request_hash,scope_key,amount,payment_kind,order_paid_status_id,outbox_id,evidence)
      VALUES(${orderId},${actor.uid},${scope.service_id},${key}::uuid,${request_hash},${scopeKey},${amount}::numeric,${payment_kind},${audits[0].id},${event.id},${JSON.stringify(evidence)}::jsonb)`);
    return{evidence,replayed:false,outbox:paid.outbox};});
}
export class CustomerWorkCashierService {
  readonly runtime:StoreOrderCreationRuntime;
  constructor(readonly container:Container,readonly env:Env){this.runtime={CONFIG_KV:env.CONFIG_KV,requirePurchaseOrigin:true,nextOrderId:async()=>{
    const seq=env.SEQUENCE.get(env.SEQUENCE.idFromName('seq'));return(await(await seq.fetch('https://internal/next-order-id?prefix=wx')).text()).trim();}};}
  draft(actor:CustomerWorkActor,key:unknown,input:unknown){return prepareCustomerCashierDraft(this.container,actor,key,input);}
  quote(actor:CustomerWorkActor,key:unknown,input:unknown){return quoteCustomerCashierSecondCard(this.container,this.runtime,actor,key,input);}
  create(actor:CustomerWorkActor,key:unknown,input:unknown,token:unknown){return createCustomerCashierSecondCard(this.container,this.runtime,actor,key,input,token);}
  async cash(actor:CustomerWorkActor,input:CustomerCashierPaymentInput){const result=await applyCustomerCashierCashPayment(this.container,actor,input);
    if(result.outbox){try{await new OrderOutboxService(this.container,this.env).dispatchById(result.outbox.id);}catch{/* The durable original event remains available for the existing retry worker. */}}
    return result;}
}
