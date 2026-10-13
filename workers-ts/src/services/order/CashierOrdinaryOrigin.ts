import { and, asc, eq, sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import type { DB } from '@/dao/BaseDao';
import { storeOrder, storeOrderCartInfo, storeOrderStatus, storeOrderOutbox } from '@/models/schema';
import { ValidateException } from '@/utils/errors';
import { outRequestHash, normalizeOutRequestKey } from '@/services/out/OutIdempotency';
import { authorizeCustomerWorkActor, type CustomerWorkActor } from '@/services/customer-work/CustomerWorkScope';
import { freezeCustomerActor } from '@/services/customer-work/CustomerWorkOperationRequest';
import { assertCashierOrdinaryReady, inspectCashierOrdinary } from '@/migrations/runCashierOrdinary';
import { authorizeOrdinaryCashierWrite, assertOrdinaryBuyer, readOrdinaryCashierDraft, assertOrdinaryDraftIntent,
  appendOrdinaryCashierOperation, ordinaryCashierJson, readOrdinaryCashierOperation } from '@/services/customer-work/CustomerOrdinaryCashierLedger';
import { ordinaryCashierHash, ordinaryCashierInteger, ordinaryCashierObject, ordinaryCashierText,
  type OrdinaryCashierIntent } from '@/services/customer-work/CustomerOrdinaryCashierContract';
import { readOrderPromotionGiftIntent } from '@/services/activity/OrderPromotionGiftSnapshot';
import type { CheckoutConfirmation } from './CheckoutConfirmation';
import type { CreateOrderParams } from './StoreOrderCreateService';

type Order = typeof storeOrder.$inferSelect;
type Cart = typeof storeOrderCartInfo.$inferSelect;
declare const ordinaryCapability: unique symbol;
export interface CashierOrdinaryCreationCapability { readonly [ordinaryCapability]: true }
export interface CashierOrdinaryCreationFacts {
  actor: CustomerWorkActor; service_id: number; request_key: string; request_hash: string;
  intent: OrdinaryCashierIntent; cart_ids: readonly number[]; confirmation?: CheckoutConfirmation;
}
const issued = new WeakMap<object, CashierOrdinaryCreationFacts>();
const invalid = () => new ValidateException('普通收银实际创建、付款或购物来源无法核对');
export function cashierOrdinaryCreationFacts(value: CashierOrdinaryCreationCapability | undefined) {
  if (value === undefined) return null;
  const facts = issued.get(value); if (!facts) throw invalid(); return facts;
}
export async function prepareCashierOrdinaryCreation(db: DbClient, actorValue: CustomerWorkActor, requestKey: string,
  intent: OrdinaryCashierIntent, confirmation?: CheckoutConfirmation): Promise<CashierOrdinaryCreationCapability> {
  const actor = freezeCustomerActor(actorValue), request_key = normalizeOutRequestKey(requestKey);
  await assertCashierOrdinaryReady(db);
  const scope = await authorizeCustomerWorkActor(db, actor);
  if (scope.scope_key !== intent.scope_key) throw invalid();
  await assertOrdinaryBuyer(db, intent.buyer_uid);
  const draft = await readOrdinaryCashierDraft(db, actor.uid, intent.draft_key);
  assertOrdinaryDraftIntent(draft, intent);
  const capability = Object.freeze({}) as CashierOrdinaryCreationCapability;
  issued.set(capability, Object.freeze({ actor, service_id: scope.service_id, request_key, request_hash: await outRequestHash(intent), intent,
    cart_ids: Object.freeze(draft.rows.filter(r => !r.removed && !r.consumed).map(r => r.cart_id)), confirmation }));
  return capability;
}
export function assertCashierOrdinaryParams(facts: CashierOrdinaryCreationFacts, params: CreateOrderParams) {
  const input = facts.intent;
  if (params.assisted || params.uid !== input.buyer_uid || params.key !== facts.request_key.replaceAll('-', '')
    || params.cartIds.length !== facts.cart_ids.length || [...params.cartIds].sort((a,b)=>a-b).join(',') !== [...facts.cart_ids].sort((a,b)=>a-b).join(',')
    || params.type !== 0 || params.shippingType !== input.shipping_type || params.storeId !== input.store_id || params.addressId !== input.address_id
    || ordinaryCashierJson(params.manualAddress ?? null) !== ordinaryCashierJson(input.manual_address)
    || (params.couponId ?? 0) !== input.coupon_id || params.useIntegral !== input.use_integral || params.payType !== 'cash'
    || params.realName !== input.real_name || params.userPhone !== input.user_phone || params.mark !== input.mark
    || ordinaryCashierJson(params.customForm) !== ordinaryCashierJson(input.custom_form)) throw invalid();
}
export async function authorizeCashierOrdinaryCreation(tx: DbClient, value: CashierOrdinaryCreationCapability) {
  const facts = cashierOrdinaryCreationFacts(value)!;
  const scope = await authorizeOrdinaryCashierWrite(tx, facts.actor, facts.intent.scope_key);
  if (scope.service_id !== facts.service_id) throw invalid();
  await assertOrdinaryBuyer(tx, facts.intent.buyer_uid, true);
  assertOrdinaryDraftIntent(await readOrdinaryCashierDraft(tx, facts.actor.uid, facts.intent.draft_key, true), facts.intent);
}
interface OrdinaryOriginCart {
  cart_row_id: number; opaque_cart_id: string; product_id: number; product_type: 0; owner_type: number; owner_id: number;
  sku_unique: string; purchase_quantity: number; is_gift: 0 | 1; snapshot_hash: string;
}
export interface CashierOrdinaryOrigin {
  version: 'cashier-ordinary-origin-v1'; creator_uid: number; service_id: number; buyer_uid: number; scope_key: string;
  root_order_id: number; root_order_no: string; creation_key: string; creation_hash: string; draft_key: string; draft_hash: string;
  quote_fingerprint: string; form_snapshot_hash: string; creation_status_id: number; shipping_type: 1 | 2; store_id: number; cart_facts: OrdinaryOriginCart[];
  creation_pay_price:string;creation_total_num:number;
}
export function parseCashierOrdinaryOrigin(value: unknown): CashierOrdinaryOrigin {
  const r = ordinaryCashierObject(value, ['version','creator_uid','service_id','buyer_uid','scope_key','root_order_id','root_order_no',
    'creation_key','creation_hash','draft_key','draft_hash','quote_fingerprint','form_snapshot_hash','creation_status_id','shipping_type','store_id','cart_facts','creation_pay_price','creation_total_num']);
  if (r.version !== 'cashier-ordinary-origin-v1' || ![1,2].some(value => value === r.shipping_type) || !Array.isArray(r.cart_facts)
    || !r.cart_facts.length || r.cart_facts.length > 200) throw invalid();
  const cart_facts = r.cart_facts.map(value => {
    const c = ordinaryCashierObject(value, ['cart_row_id','opaque_cart_id','product_id','product_type','owner_type','owner_id','sku_unique','purchase_quantity','is_gift','snapshot_hash']);
    if (c.product_type !== 0 || ![0,1,2].some(value => value === c.owner_type) || ![0,1].some(value => value === c.is_gift)) throw invalid();
    return { cart_row_id: ordinaryCashierInteger(c.cart_row_id), opaque_cart_id: ordinaryCashierText(c.opaque_cart_id,64), product_id: ordinaryCashierInteger(c.product_id),
      product_type: 0 as const, owner_type: ordinaryCashierInteger(c.owner_type,true), owner_id: ordinaryCashierInteger(c.owner_id,true),
      sku_unique: ordinaryCashierText(c.sku_unique,16), purchase_quantity: ordinaryCashierInteger(c.purchase_quantity,false,32767),
      is_gift: c.is_gift as 0|1, snapshot_hash: ordinaryCashierHash(c.snapshot_hash) };
  });
  if (new Set(cart_facts.map(c=>c.cart_row_id)).size !== cart_facts.length || new Set(cart_facts.map(c=>c.opaque_cart_id)).size !== cart_facts.length) throw invalid();
  const creation_pay_price=ordinaryCashierText(r.creation_pay_price,13);if(!/^(0|[1-9]\d{0,9})\.\d{2}$/.test(creation_pay_price))throw invalid();
  return { version:'cashier-ordinary-origin-v1',creator_uid:ordinaryCashierInteger(r.creator_uid),service_id:ordinaryCashierInteger(r.service_id),
    buyer_uid:ordinaryCashierInteger(r.buyer_uid,true),scope_key:ordinaryCashierHash(r.scope_key),root_order_id:ordinaryCashierInteger(r.root_order_id),
    root_order_no:ordinaryCashierText(r.root_order_no,32),creation_key:normalizeOutRequestKey(r.creation_key),creation_hash:ordinaryCashierHash(r.creation_hash),
    draft_key:normalizeOutRequestKey(r.draft_key),draft_hash:ordinaryCashierHash(r.draft_hash),quote_fingerprint:ordinaryCashierHash(r.quote_fingerprint),
    form_snapshot_hash:ordinaryCashierHash(r.form_snapshot_hash),creation_status_id:ordinaryCashierInteger(r.creation_status_id),shipping_type:r.shipping_type as 1|2,store_id:ordinaryCashierInteger(r.store_id,true),cart_facts,
    creation_pay_price,creation_total_num:ordinaryCashierInteger(r.creation_total_num) };
}
export async function readCashierOrdinaryOrigin(db: DB, order: Order): Promise<{ origin: CashierOrdinaryOrigin; origin_hash: string } | null> {
  // Legacy form/label readers run under the mature app profile, which has no
  // new-realm grants. Permission metadata precedes any protected-table SELECT.
  const[rights]=await db.execute<{readable:boolean}>(sql`SELECT count(*)=4 AND bool_and(has_table_privilege(current_user,c.oid,'SELECT')) AS readable
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname IN('cashier_ordinary_draft_v1','cashier_ordinary_cart_v1','cashier_ordinary_operation_v1','cashier_ordinary_origin_v1')`);
  if(rights?.readable!==true)return null;
  if (!(await inspectCashierOrdinary(db)).complete) return null;
  const rows = await db.execute<{ actor_uid:number;service_id:number;buyer_uid:number;request_key:string;request_hash:string;scope_key:string;origin_json:string|null;origin_hash:string }>(sql`
    SELECT actor_uid,service_id,buyer_uid,request_key::text,request_hash,scope_key,
      CASE WHEN octet_length(origin_json)<=262144 THEN origin_json END AS origin_json,origin_hash FROM public.cashier_ordinary_origin_v1 WHERE order_id=${order.id} LIMIT 2`);
  if (!rows.length) return null;
  if (rows.length !== 1 || !rows[0].origin_json) throw invalid();
  const row=rows[0]; let origin:CashierOrdinaryOrigin;try{origin=parseCashierOrdinaryOrigin(JSON.parse(row.origin_json!));}catch{throw invalid();}
  if (ordinaryCashierJson(origin)!==row.origin_json || await outRequestHash(origin)!==row.origin_hash || origin.root_order_id!==order.id
    || origin.root_order_no!==order.orderId || origin.creator_uid!==row.actor_uid || origin.service_id!==row.service_id || origin.buyer_uid!==row.buyer_uid
    || origin.creation_key!==row.request_key || origin.creation_hash!==row.request_hash || origin.scope_key!==row.scope_key
    || order.uid!==origin.buyer_uid || order.staffId!==origin.creator_uid || order.isChannel!==2 || order.productType!==0 || order.type!==0
    || order.shippingType!==origin.shipping_type || order.storeId!==origin.store_id || ![0,-1].includes(order.pid)
    ||order.payPrice!==origin.creation_pay_price||order.totalNum!==origin.creation_total_num
    || await outRequestHash(order.customForm)!==origin.form_snapshot_hash) throw invalid();
  return { origin,origin_hash:row.origin_hash };
}
export async function assertCashierOrdinaryCreationReplay(db:DbClient,value:CashierOrdinaryCreationCapability,order:Order) {
  const facts=cashierOrdinaryCreationFacts(value)!,scope=await authorizeCustomerWorkActor(db,facts.actor),saved=await readCashierOrdinaryOrigin(db,order);
  if(scope.scope_key!==facts.intent.scope_key||!saved||saved.origin.creator_uid!==facts.actor.uid||saved.origin.creation_key!==facts.request_key
    ||saved.origin.creation_hash!==facts.request_hash||saved.origin.draft_key!==facts.intent.draft_key||saved.origin.draft_hash!==facts.intent.draft_hash)throw invalid();
}
export async function captureCashierOrdinaryCreation(tx:DbClient,value:CashierOrdinaryCreationCapability,order:Order,fingerprint:string) {
  const facts=cashierOrdinaryCreationFacts(value)!;
  const scope=await authorizeOrdinaryCashierWrite(tx,facts.actor,facts.intent.scope_key);
  if(scope.service_id!==facts.service_id||order.uid!==facts.intent.buyer_uid||order.staffId!==facts.actor.uid||order.isChannel!==2
    ||order.productType!==0||order.type!==0||order.pid!==0||order.paid!==0||order.status!==0||order.shippingType!==facts.intent.shipping_type||order.storeId!==facts.intent.store_id)throw invalid();
  const carts=await tx.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid,order.id)).orderBy(asc(storeOrderCartInfo.id)).limit(201);
  const purchased=carts.filter(c=>c.isGift===0),gift=readOrderPromotionGiftIntent(order.promotionsGive),giftRows=gift?.promotions.flatMap(p=>p.products)??[];
  if(carts.length>200||purchased.length!==facts.cart_ids.length||purchased.some(c=>!facts.cart_ids.includes(Number(c.cartId)))
    ||carts.some(c=>c.uid!==order.uid||c.productType!==0||c.cartNum<1||c.cartNum>32767||c.isGift!==0&&c.isGift!==1)
    ||carts.filter(c=>c.isGift===1).some(c=>!giftRows.some(g=>g.cart_id===c.cartId&&g.product_id===c.productId&&g.unique===c.skuUnique&&g.quantity===c.cartNum)))throw invalid();
  const draft=await readOrdinaryCashierDraft(tx,facts.actor.uid,facts.intent.draft_key);
  const active=draft.rows.filter(r=>!r.removed);
  if(active.length!==purchased.length||active.some(r=>!r.consumed||!purchased.some(c=>c.cartId===String(r.cart_id)&&c.productId===r.product_id
    &&c.skuUnique===r.sku_unique&&c.cartNum===r.quantity)))throw invalid();
  const[status]=await tx.insert(storeOrderStatus).values({oid:order.id,changeType:'customer_ordinary_cashier_create',changeMessage:'客户管理创建普通商品收银订单',changeTime:Math.floor(Date.now()/1000)}).returning({id:storeOrderStatus.id});
  if(!status)throw invalid();
  const cart_facts:OrdinaryOriginCart[]=await Promise.all(carts.map(async c=>({cart_row_id:c.id,opaque_cart_id:c.cartId,product_id:c.productId,product_type:0,
    owner_type:c.type,owner_id:c.relationId,sku_unique:c.skuUnique,purchase_quantity:c.cartNum,is_gift:c.isGift as 0|1,snapshot_hash:await outRequestHash(c.cartInfo)})));
  const origin=parseCashierOrdinaryOrigin({version:'cashier-ordinary-origin-v1',creator_uid:facts.actor.uid,service_id:facts.service_id,buyer_uid:order.uid,
    scope_key:facts.intent.scope_key,root_order_id:order.id,root_order_no:order.orderId,creation_key:facts.request_key,creation_hash:facts.request_hash,
    draft_key:facts.intent.draft_key,draft_hash:facts.intent.draft_hash,quote_fingerprint:fingerprint,form_snapshot_hash:await outRequestHash(order.customForm),creation_status_id:status.id,
    shipping_type:order.shippingType,store_id:order.storeId,cart_facts,creation_pay_price:order.payPrice,creation_total_num:order.totalNum});
  const origin_hash=await outRequestHash(origin);
  await tx.execute(sql`INSERT INTO public.cashier_ordinary_origin_v1(order_id,actor_uid,service_id,buyer_uid,request_key,request_hash,scope_key,origin_json,origin_hash)
    VALUES(${order.id},${facts.actor.uid},${facts.service_id},${order.uid},${facts.request_key}::uuid,${facts.request_hash},${facts.intent.scope_key},${ordinaryCashierJson(origin)},${origin_hash})`);
  return appendOrdinaryCashierOperation(tx,facts.actor.uid,facts.request_key,'creation',facts.intent as unknown as Record<string,unknown>,
    {outcome:'order-created',order:{order_id:order.id,order_no:order.orderId,buyer_uid:order.uid,creator_uid:facts.actor.uid,pay_price:order.payPrice,
      paid:0,pay_type:order.payType,shipping_type:order.shippingType,store_id:order.storeId,total_num:order.totalNum},origin_hash,quote_fingerprint:fingerprint},facts.intent.draft_key,order.id);
}
/** Original payment provenance is global financial evidence. Its creator is
 * observed, never a creator-only grant for later customer-work refunds. */
export async function readCashierOrdinaryPaidOrigin(db:DbClient,root:Order,carts:readonly Cart[]) {
  const saved=await readCashierOrdinaryOrigin(db,root);
  if(!saved||root.paid!==1||root.payType!=='cash'||root.payTime<=0||root.tradeNo!==''||carts.length!==saved.origin.cart_facts.length)throw invalid();
  await assertOrdinaryCreationSource(db,root,saved,carts);
  const payments=await db.execute<{evidence_json:string;intent_json:string;actor_uid:number;request_key:string}>(sql`SELECT evidence_json,intent_json,actor_uid,request_key::text FROM public.cashier_ordinary_operation_v1 WHERE order_id=${root.id} AND kind='payment' LIMIT 2`);
  if(payments.length!==1)throw invalid();
  const receipt=await readOrdinaryCashierOperation(db,payments[0].actor_uid,payments[0].request_key),p=receipt?.evidence.payment as Record<string,unknown>|undefined;
  const events=await db.select().from(storeOrderOutbox).where(eq(storeOrderOutbox.eventKey,`order.paid:${root.id}`)).limit(2),event=events[0];
  if(!p||p.order_id!==root.id||p.order_no!==root.orderId||p.buyer_uid!==root.uid||p.creator_uid!==saved.origin.creator_uid||p.payer_uid!==receipt?.actor_uid
    ||p.origin_hash!==saved.origin_hash||p.amount!==root.payPrice||p.pay_time!==root.payTime||p.pay_type!==root.payType||p.paid!==1
    ||events.length!==1||event.aggregateType!=='order'||event.aggregateId!==root.id||event.eventType!=='order.paid'||event.status!=='COMPLETED')throw invalid();
  const payload=event.payload as {orderId?:unknown;orderNo?:unknown};
  if(payload?.orderId!==root.id||payload.orderNo!==root.orderId)throw invalid();
  const outbox=p.outbox as Record<string,unknown>|undefined;
  if(!outbox||outbox.id!==event.id||outbox.event_key!==event.eventKey||outbox.event_type!==event.eventType||outbox.payload_hash!==await outRequestHash(event.payload))throw invalid();
  const paid=await db.select().from(storeOrderStatus).where(and(eq(storeOrderStatus.id,ordinaryCashierInteger(p.status_id)),eq(storeOrderStatus.oid,root.id),eq(storeOrderStatus.changeType,'customer_ordinary_cashier_paid'))).limit(2);
  if(paid.length!==1||paid[0].changeTime!==root.payTime||paid[0].changeMessage!==`客户 ${receipt!.actor_uid} 确认普通商品收银现金付款`)throw invalid();
  return saved;
}
async function assertOrdinaryCreationSource(db:DB,root:Order,saved:{origin:CashierOrdinaryOrigin;origin_hash:string},carts:readonly Cart[]){
  if(carts.length!==saved.origin.cart_facts.length||carts.length>200||carts.reduce((n,c)=>n+c.cartNum,0)!==saved.origin.creation_total_num)throw invalid();
  for(const c of carts){const f=saved.origin.cart_facts.find(f=>f.cart_row_id===c.id);
    if(!f||c.oid!==root.id||c.uid!==root.uid||c.cartId!==f.opaque_cart_id||c.productId!==f.product_id||c.productType!==0
      ||c.type!==f.owner_type||c.relationId!==f.owner_id||c.skuUnique!==f.sku_unique||c.cartNum!==f.purchase_quantity||c.isGift!==f.is_gift
      ||await outRequestHash(c.cartInfo)!==f.snapshot_hash)throw invalid();}
  const audits=await db.select().from(storeOrderStatus).where(and(eq(storeOrderStatus.id,saved.origin.creation_status_id),eq(storeOrderStatus.oid,root.id),eq(storeOrderStatus.changeType,'customer_ordinary_cashier_create'))).limit(2);
  const creation=await readOrdinaryCashierOperation(db,saved.origin.creator_uid,saved.origin.creation_key),order=creation?.evidence.order as Record<string,unknown>|undefined;
  if(audits.length!==1||audits[0].changeMessage!=='客户管理创建普通商品收银订单'||creation?.kind!=='creation'||creation.request_hash!==saved.origin.creation_hash
    ||creation.evidence.origin_hash!==saved.origin_hash||creation.evidence.quote_fingerprint!==saved.origin.quote_fingerprint||!order||order.order_id!==root.id
    ||order.order_no!==root.orderId||order.pay_price!==saved.origin.creation_pay_price||order.total_num!==saved.origin.creation_total_num||order.creator_uid!==saved.origin.creator_uid||order.buyer_uid!==root.uid)throw invalid();
}
export async function readCashierOrdinaryUnpaidOrigin(db:DB,root:Order){
  const saved=await readCashierOrdinaryOrigin(db,root);if(!saved||root.paid!==0||root.pid!==0||root.payType!==''||root.payTime!==0)throw invalid();
  const carts=await db.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid,root.id)).orderBy(asc(storeOrderCartInfo.id)).limit(201);
  await assertOrdinaryCreationSource(db,root,saved,carts);return saved;
}
/** The original paid consumer has not marked its outbox COMPLETED yet. This
 * capability verifies creation provenance only, never certifies payment finish. */
export async function readCashierOrdinaryConsumerOrigin(db:DB,root:Order){
  const saved=await readCashierOrdinaryOrigin(db,root);if(!saved)return null;
  if(root.paid!==1||root.pid>0)throw invalid();
  const carts=await db.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid,root.id)).orderBy(asc(storeOrderCartInfo.id)).limit(201);
  await assertOrdinaryCreationSource(db,root,saved,carts);return saved;
}
