import { and, asc, eq, sql } from 'drizzle-orm';
import type { DbClient } from '@/lib/di';
import { storeCart, storeOrder, storeOrderCartInfo, storeOrderOutbox, storeOrderStatus, user } from '@/models/schema';
import { AuthException, HttpApiException, ValidateException } from '@/utils/errors';
import { outRequestHash, normalizeOutRequestKey } from '@/services/out/OutIdempotency';
import { acquireCustomerWorkScopeLock } from '@/migrations/runCustomerWorkScopeLock';
import { inspectCashierSecondCardOrigin, assertCashierSecondCardOriginCatalog, cashierSecondCardOriginReadiness } from '@/migrations/runCashierSecondCardOrigin';
import { authorizeCustomerWorkActor, type CustomerWorkActor } from '@/services/customer-work/CustomerWorkScope';
import { freezeCustomerActor, freezeCustomerJson, authorizeCustomerOperationOwner } from '@/services/customer-work/CustomerWorkOperationRequest';
import { parseSecondCardValiditySnapshot, resolveSecondCardValidityAtPayment } from './SecondCardValidityService';
import type { CheckoutConfirmation } from './CheckoutConfirmation';
import { loadRefundOrderGeneration } from './RefundOrderGeneration';
import { planOrderFinancialSplit } from './OrderSplitFinance';
import { storeOrderRefundSplit } from '@/models/schema/order_refund_split';
import { storeOrderRefund } from '@/models/schema';
import { refundOrderSplitFingerprint } from './RefundOrderSplitIdentity';

export const CASHIER_SECOND_CARD_ORIGIN_VERSION = 'cashier-second-card-origin-v1' as const;
type Order = typeof storeOrder.$inferSelect;
type Cart = typeof storeOrderCartInfo.$inferSelect;
export interface CashierSecondCardCartFact {
  cart_row_id: number; opaque_cart_id: string; product_id: number; product_type: 4;
  owner_type: number; owner_id: number; sku_unique: string; purchase_quantity: number;
  write_times: number; snapshot_hash: string;
}
export interface CashierSecondCardCreationFact {
  version: typeof CASHIER_SECOND_CARD_ORIGIN_VERSION;
  creator_kind: 'customer'; creator_uid: number; service_id: number; buyer_uid: number;
  scope_key: string; root_order_id: number; root_order_no: string; creation_key: string;
  creation_hash: string; quote_fingerprint: string; creation_status_id: number;
  cart_facts: CashierSecondCardCartFact[];
}
export interface CashierSecondCardOriginProof {
  version: typeof CASHIER_SECOND_CARD_ORIGIN_VERSION; origin_hash: string;
  creator_kind: 'customer'; creator_id: number; root_order_id: number; root_order_no: string;
  cart_facts: CashierSecondCardCartFact[];
  payment_facts: { outbox_id: number; event_key: string; payload_hash: string; pay_type: string; paid_at: number };
}
export interface CashierSecondCardCreationInput {
  actor: CustomerWorkActor; scope_key: string; buyer_uid: number; request_key: string;
  request_hash: string; cart_ids: readonly number[]; tourist_key: string;
  selection:Readonly<{product_id:number;sku_unique:string;quantity:number}>;
  /** Resolved by the authenticated cashier adapter, never a serialized capability. */
  confirmation?: CheckoutConfirmation;
}
declare const cashierCapability: unique symbol;
export interface CashierSecondCardCreationCapability { readonly [cashierCapability]: true }
interface CapabilityFacts extends CashierSecondCardCreationInput { service_id: number }
const issued = new WeakMap<object, CapabilityFacts>();
declare const zeroRefundCapability: unique symbol;
export interface CashierZeroRefundCapability { readonly [zeroRefundCapability]: true }
interface ZeroRefundFacts {
  actor:CustomerWorkActor;scope_key:string;order_id:number;order_no:string;buyer_uid:number;
  origin_hash:string;cart_hash:string;
}
const zeroRefunds=new WeakMap<object,ZeroRefundFacts>();
const id = (value: unknown, zero = false): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < (zero ? 0 : 1) || value > 2147483647)
    throw new ValidateException('收银次卡身份或数量无效');
  return value;
};
const hash = (value: unknown): string => {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new ValidateException('收银次卡来源摘要无效');
  return value;
};
function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join('|') !== [...keys].sort().join('|'))
    throw new ValidateException('收银次卡来源结构不完整');
  return value as Record<string, unknown>;
}
function text(value: unknown, maximum: number): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > maximum
    || value.trim() !== value || /[\u0000-\u001f\u007f]/.test(value)) throw new ValidateException('收银次卡来源标识无效');
  return value;
}
function parseFact(value: unknown): CashierSecondCardCreationFact {
  const r = exact(value, ['version','creator_kind','creator_uid','service_id','buyer_uid','scope_key',
    'root_order_id','root_order_no','creation_key','creation_hash','quote_fingerprint','creation_status_id','cart_facts']);
  if (r.version !== CASHIER_SECOND_CARD_ORIGIN_VERSION || r.creator_kind !== 'customer'
    || !Array.isArray(r.cart_facts) || r.cart_facts.length !== 1) throw new ValidateException('收银次卡来源类型无效');
  const row = exact(r.cart_facts[0], ['cart_row_id','opaque_cart_id','product_id','product_type','owner_type',
    'owner_id','sku_unique','purchase_quantity','write_times','snapshot_hash']);
  if (row.product_type !== 4 || ![0,1,2].includes(id(row.owner_type, true))) throw new ValidateException('收银次卡商品来源无效');
  const fact: CashierSecondCardCartFact = { cart_row_id:id(row.cart_row_id), opaque_cart_id:text(row.opaque_cart_id,64),
    product_id:id(row.product_id), product_type:4, owner_type:id(row.owner_type,true), owner_id:id(row.owner_id,true),
    sku_unique:text(row.sku_unique,64), purchase_quantity:id(row.purchase_quantity), write_times:id(row.write_times),
    snapshot_hash:hash(row.snapshot_hash) };
  const root_order_no = text(r.root_order_no,32);
  if (!/^[A-Za-z0-9_-]+$/.test(root_order_no) || fact.write_times % fact.purchase_quantity !== 0)
    throw new ValidateException('收银次卡购买数量与次数证明不一致');
  return { version:CASHIER_SECOND_CARD_ORIGIN_VERSION, creator_kind:'customer', creator_uid:id(r.creator_uid),
    service_id:id(r.service_id), buyer_uid:id(r.buyer_uid,true), scope_key:hash(r.scope_key),
    root_order_id:id(r.root_order_id), root_order_no, creation_key:normalizeOutRequestKey(r.creation_key),
    creation_hash:hash(r.creation_hash), quote_fingerprint:hash(r.quote_fingerprint),
    creation_status_id:id(r.creation_status_id), cart_facts:[fact] };
}

/** An internal quantity return for a genuine zero cash purchase. This is never
 * selected by request JSON, ordinary refund entry, or a payment-method flag. */
export async function prepareCashierZeroRefund(db:DbClient,actorInput:CustomerWorkActor,
  scopeKey:string,orderId:number):Promise<CashierZeroRefundCapability>{
  const actor=freezeCustomerActor(actorInput),scope_key=hash(scopeKey),order_id=id(orderId);
  const scope=await authorizeCustomerWorkActor(db,actor);
  if(scope.scope_key!==scope_key)throw new AuthException('次卡退回经营资格已变化');
  const [order]=await db.select().from(storeOrder).where(eq(storeOrder.id,order_id)).limit(1);
  if(!order)throw new ValidateException('零元次卡真实订单不存在');
  const carts=await db.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid,order_id)).orderBy(asc(storeOrderCartInfo.id)).limit(201);
  const proof=await assertCashierZeroRefundOrigin(db,order,carts);
  if(proof.creator_id!==actor.uid)throw new AuthException('仅原收银经营用户可退回零元次卡');
  const capability=Object.freeze({}) as CashierZeroRefundCapability;
  zeroRefunds.set(capability,{actor,scope_key,order_id,order_no:order.orderId,buyer_uid:order.uid,
    origin_hash:proof.origin_hash,cart_hash:await outRequestHash(carts)});
  return capability;
}

export function assertCashierZeroRefundRequest(capability:CashierZeroRefundCapability,uid:number,orderNo:string):void{
  const facts=zeroRefunds.get(capability);
  if(!facts||facts.buyer_uid!==uid||facts.order_no!==orderNo)throw new ValidateException('零元次卡退回缺少真实服务器授权');
}

/** Revalidate after the shared application has acquired order/cart locks. */
export async function authorizeCashierZeroRefund(db:DbClient,capability:CashierZeroRefundCapability,
  order:Order,carts:Cart[]):Promise<void>{
  if(Object.hasOwn(db,'$client'))throw Error('Zero cashier return requires the caller transaction');
  const facts=zeroRefunds.get(capability);
  if(!facts||facts.order_id!==order.id||facts.order_no!==order.orderId||facts.buyer_uid!==order.uid)
    throw new ValidateException('零元次卡退回授权与真实订单不一致');
  await authorizeCustomerOperationOwner(db,facts.actor);
  await acquireCustomerWorkScopeLock(db,facts.actor.uid);
  const scope=await authorizeCustomerWorkActor(db,facts.actor);
  if(scope.scope_key!==facts.scope_key)throw new AuthException('次卡退回经营资格已变化');
  const proof=await assertCashierZeroRefundOrigin(db,order,carts,true);
  if(proof.creator_id!==facts.actor.uid||proof.origin_hash!==facts.origin_hash
    ||await outRequestHash(carts)!==facts.cart_hash)throw new ValidateException('零元次卡退回原购买事实已变化');
}

/** The persisted materialized claim is still bound to the original receipt at
 * finalization. Guests and nonzero roots cannot acquire this quantity policy. */
export async function assertCashierZeroRefundOrigin(db:DbClient,order:Order,carts:Cart[],lock=false):Promise<CashierSecondCardOriginProof>{
  if(order.uid<=0||order.payPrice!=='0.00'||order.payType!=='cash'||order.paid!==1||order.isDel||order.isSystemDel
    ||order.pid<0||![0,1,2,3].includes(order.status)||!carts.length||carts.length>200)
    throw new ValidateException('仅真实会员零元现金次卡允许按商品数量退回');
  const rootId=order.pid>0?order.pid:order.id;
  const [root]=rootId===order.id?[order]:await db.select().from(storeOrder).where(eq(storeOrder.id,rootId)).limit(1);
  if(!root||root.payPrice!=='0.00'||root.payType!=='cash'||root.uid!==order.uid)
    throw new ValidateException('零元次卡原付款金额或身份不一致');
  const proof=await readCashierSecondCardOrigin(db,order,carts,lock);
  if(!proof||proof.payment_facts.pay_type!=='cash')throw new ValidateException('零元次卡缺少原收银创建和支付证明');
  return proof;
}

/** Only a live server-issued object reaches the creation core. A JSON flag, a
 * serialized token or an ordinary checkout runtime cannot acquire this realm. */
export async function prepareCashierSecondCardCreation(db: DbClient, value: CashierSecondCardCreationInput): Promise<CashierSecondCardCreationCapability> {
  const actor = freezeCustomerActor(value.actor), buyer_uid=id(value.buyer_uid,true), scope_key=hash(value.scope_key);
  const request_key=normalizeOutRequestKey(value.request_key), request_hash=hash(value.request_hash);
  if (!Array.isArray(value.cart_ids) || value.cart_ids.length!==1) throw new ValidateException('次卡收银一次只能选择一个真实商品规格');
  const cart_ids=Object.freeze(value.cart_ids.map(v=>id(v)));
  const selected=exact(value.selection,['product_id','sku_unique','quantity']);
  const selection=Object.freeze({product_id:id(selected.product_id),sku_unique:text(selected.sku_unique,16),quantity:id(selected.quantity)});
  const tourist_key=buyer_uid===0?text(value.tourist_key,50):'';
  if (buyer_uid===0 && !/^[A-Za-z0-9_-]+$/.test(tourist_key) || buyer_uid>0 && value.tourist_key!=='')
    throw new ValidateException('次卡收银游客身份不一致');
  const scope=await authorizeCustomerWorkActor(db,actor);
  if(scope.scope_key!==scope_key)throw new AuthException('收银客户管理身份已变化，请重新确认');
  await assertCashierSecondCardOriginCatalog(db);
  if (!(await cashierSecondCardOriginReadiness(db)).ready) throw new HttpApiException('客户次卡收银来源权限尚未验收',503,503);
  // The separate draft realm binds customer-owned carts. staff_id alone also
  // occurs in Admin assisted checkout and is never sufficient for this proof.
  const drafts=await db.execute<{actor_uid:number;buyer_uid:number;cart_id:number;request_hash:string;tourist_hash:string}>(sql`
    SELECT actor_uid,buyer_uid,cart_id,request_hash,tourist_hash FROM public.cashier_second_card_cart_v1
    WHERE actor_uid=${actor.uid} AND request_key=${request_key}::uuid ORDER BY cart_id LIMIT 2`);
  if(drafts.length!==1 || drafts[0].buyer_uid!==buyer_uid || drafts[0].cart_id!==cart_ids[0]
    || drafts[0].request_hash!==request_hash || drafts[0].tourist_hash!==await outRequestHash(tourist_key))
    throw new ValidateException('收银购物行缺少独立客户来源，请重新选品');
  const capability=Object.freeze({}) as CashierSecondCardCreationCapability;
  const confirmation=value.confirmation?Object.freeze({fingerprint:hash(value.confirmation.fingerprint),expiresAt:id(value.confirmation.expiresAt)}):undefined;
  issued.set(capability,Object.freeze({actor,scope_key,buyer_uid,request_key,request_hash,cart_ids,tourist_key,selection,confirmation,service_id:scope.service_id}));
  return capability;
}
export function cashierSecondCardCreationFacts(value: unknown): Readonly<CapabilityFacts> | null {
  if(value===undefined)return null;
  const result=value && typeof value==='object'?issued.get(value):undefined;
  if(!result)throw new ValidateException('次卡收银只能由实际客户管理入口创建');
  return result;
}
export async function authorizeCashierSecondCardCreation(tx:DbClient, capability:CashierSecondCardCreationCapability):Promise<void> {
  const facts=cashierSecondCardCreationFacts(capability)!;
  await assertCashierSecondCardOriginCatalog(tx);
  await tx.execute(sql`LOCK TABLE public.cashier_second_card_cart_v1 IN ROW SHARE MODE NOWAIT`);
  if (!(await cashierSecondCardOriginReadiness(tx)).ready) throw new HttpApiException('客户次卡收银来源权限尚未验收',503,503);
  const drafts=await tx.execute<{buyer_uid:number;cart_id:number;request_hash:string;tourist_hash:string}>(sql`
    SELECT buyer_uid,cart_id,request_hash,tourist_hash FROM public.cashier_second_card_cart_v1
    WHERE actor_uid=${facts.actor.uid} AND request_key=${facts.request_key}::uuid LIMIT 2`);
  if(drafts.length!==1||drafts[0].buyer_uid!==facts.buyer_uid||drafts[0].cart_id!==facts.cart_ids[0]
    ||drafts[0].request_hash!==facts.request_hash||drafts[0].tourist_hash!==await outRequestHash(facts.tourist_key))
    throw new ValidateException('客户收银购物行来源已变化');
  await authorizeCustomerOperationOwner(tx,facts.actor);
  await acquireCustomerWorkScopeLock(tx,facts.actor.uid);
  const scope=await authorizeCustomerWorkActor(tx,facts.actor);
  if(scope.scope_key!==facts.scope_key||scope.service_id!==facts.service_id)throw new AuthException('收银客户管理身份已变化');
  if(facts.buyer_uid>0){const buyer=await tx.select({uid:user.uid}).from(user).where(and(eq(user.uid,facts.buyer_uid),eq(user.status,1),eq(user.isDel,0),sql`${user.deleteTime} IS NULL`)).limit(1).for('update',{noWait:true});if(buyer.length!==1)throw new ValidateException('收银购买用户已失效');}
  const carts=await tx.select().from(storeCart).where(eq(storeCart.id,facts.cart_ids[0])).limit(1).for('update');
  const cart=carts[0];
  if(!cart||cart.uid!==facts.buyer_uid||cart.staffId!==facts.actor.uid||cart.touristUid!==facts.tourist_key
    ||cart.productType!==4||cart.type!==0||cart.isDel!==0||cart.status!==1
    ||cart.productId!==facts.selection.product_id||cart.productAttrUnique!==facts.selection.sku_unique||cart.cartNum!==facts.selection.quantity)
    throw new ValidateException('收银次卡购物行归属已变化');
}
export async function assertCashierSecondCardCreationReplay(db:DbClient,capability:CashierSecondCardCreationCapability,order:Order):Promise<void>{
  const facts=cashierSecondCardCreationFacts(capability)!;
  const scope=await authorizeCustomerWorkActor(db,facts.actor);
  if(scope.scope_key!==facts.scope_key||scope.service_id!==facts.service_id)throw new AuthException('收银客户管理身份已变化');
  await assertCashierSecondCardOriginCatalog(db);
  const rows=await db.execute<{origin:unknown;origin_hash:string}>(sql`SELECT origin,origin_hash FROM public.cashier_second_card_origin_v1 WHERE order_id=${order.id} LIMIT 2`);
  if(rows.length!==1)throw new ValidateException('原收银创建回执缺失，不能用其他订单替代');
  const origin=parseFact(rows[0].origin);
  if(await outRequestHash(origin)!==rows[0].origin_hash||origin.root_order_id!==order.id||origin.root_order_no!==order.orderId
    ||origin.creator_uid!==facts.actor.uid||origin.creation_key!==facts.request_key||origin.creation_hash!==facts.request_hash
    ||origin.scope_key!==facts.scope_key||origin.buyer_uid!==facts.buyer_uid||order.uid!==facts.buyer_uid
    ||order.staffId!==facts.actor.uid||order.isChannel!==2||order.shippingType!==2||order.storeId!==0||order.productType!==4)
    throw new ValidateException('原收银请求身份或内容不一致');
}
export async function captureCashierSecondCardCreation(tx:DbClient, capability:CashierSecondCardCreationCapability, order:Order, quoteFingerprint:string):Promise<CashierSecondCardCreationFact> {
  const facts=cashierSecondCardCreationFacts(capability)!;
  await authorizeCashierSecondCardCreation(tx,capability);
  if(order.uid!==facts.buyer_uid||order.productType!==4||order.type!==0||order.shippingType!==2||order.storeId!==0
    ||order.staffId!==facts.actor.uid||order.isChannel!==2||order.pid!==0||order.paid!==0||order.status!==0)
    throw new ValidateException('收银次卡创建结果与固定来源不一致');
  const carts=await tx.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid,order.id)).orderBy(asc(storeOrderCartInfo.id)).limit(2);
  if(carts.length!==1||carts[0].uid!==order.uid||carts[0].productType!==4||carts[0].cartId!==String(facts.cart_ids[0])
    ||carts[0].writeTimes<=0||carts[0].writeSurplusTimes!==carts[0].writeTimes||carts[0].cartNum<=0)
    throw new ValidateException('收银次卡实际购物快照或库存认领不完整');
  const [status]=await tx.insert(storeOrderStatus).values({oid:order.id,changeType:'customer_cashier_create',
    changeMessage:'客户管理创建次卡收银订单',changeTime:Math.floor(Date.now()/1000)}).returning({id:storeOrderStatus.id});
  if(!status)throw Error('Actual cashier creation audit was not persisted');
  const cart=carts[0],origin=parseFact({version:CASHIER_SECOND_CARD_ORIGIN_VERSION,creator_kind:'customer',creator_uid:facts.actor.uid,
    service_id:facts.service_id,buyer_uid:order.uid,scope_key:facts.scope_key,root_order_id:order.id,root_order_no:order.orderId,
    creation_key:facts.request_key,creation_hash:facts.request_hash,quote_fingerprint:hash(quoteFingerprint),creation_status_id:status.id,
    cart_facts:[{cart_row_id:cart.id,opaque_cart_id:cart.cartId,product_id:cart.productId,product_type:4,owner_type:cart.type,
      owner_id:cart.relationId,sku_unique:cart.skuUnique,purchase_quantity:cart.cartNum,write_times:cart.writeTimes,
      snapshot_hash:await outRequestHash(cart.cartInfo)}]});
  const origin_hash=await outRequestHash(origin);
  await tx.execute(sql`INSERT INTO public.cashier_second_card_origin_v1(order_id,actor_uid,service_id,buyer_uid,request_key,request_hash,scope_key,origin_hash,origin)
    VALUES(${order.id},${facts.actor.uid},${facts.service_id},${order.uid},${facts.request_key}::uuid,${facts.request_hash},${facts.scope_key},${origin_hash},${JSON.stringify(freezeCustomerJson(origin,262144))}::jsonb)`);
  return origin;
}

/** The origin is permanent evidence; a current paid bit or a product_type flag
 * alone cannot turn an ordinary store-zero order into a cashier entitlement. */
export async function readCashierSecondCardOrigin(db:DbClient,order:Order,carts:readonly Cart[],lock=false):Promise<CashierSecondCardOriginProof|null> {
  if(order.shippingType!==2||order.storeId!==0||order.productType!==4)return null;
  if(!(await inspectCashierSecondCardOrigin(db)).complete)return null;
  if(lock){if(Object.hasOwn(db,'$client'))throw Error('Cashier origin lock requires caller-owned transaction');await db.execute(sql`LOCK TABLE public.cashier_second_card_origin_v1 IN ROW SHARE MODE NOWAIT`);await assertCashierSecondCardOriginCatalog(db);}
  const rootId=order.pid>0?order.pid:order.id;
  const roots=order.id===rootId?[order]:await db.select().from(storeOrder).where(eq(storeOrder.id,rootId)).limit(2);
  if(roots.length!==1)throw new ValidateException('收银次卡原付款订单不唯一');
  const root=roots[0];
  const rows=await db.execute<{origin:unknown;origin_hash:string;actor_uid:number;service_id:number;buyer_uid:number;request_hash:string;request_key:string}>(sql`
    SELECT origin,origin_hash,actor_uid,service_id,buyer_uid,request_hash,request_key::text FROM public.cashier_second_card_origin_v1
    WHERE order_id=${rootId} LIMIT 2`);
  if(rows.length===0)return null;
  if(rows.length!==1)throw new HttpApiException('收银次卡来源重复，请人工核对',503,503);
  const saved=rows[0],origin=parseFact(saved.origin);
  if(await outRequestHash(origin)!==saved.origin_hash||origin.root_order_id!==root.id||origin.root_order_no!==root.orderId
    ||origin.buyer_uid!==order.uid||saved.buyer_uid!==order.uid||origin.creator_uid!==saved.actor_uid
    ||origin.service_id!==saved.service_id||origin.creation_key!==saved.request_key||origin.creation_hash!==saved.request_hash
    ||order.staffId!==origin.creator_uid||root.staffId!==origin.creator_uid||order.isChannel!==2||root.isChannel!==2
    ||![0,-1].includes(root.pid)||order.pid<0&&order.id!==root.id||root.uid!==order.uid||order.paid!==1||root.paid!==1
    ||order.payTime<=0||root.payTime!==order.payTime||root.payType!==order.payType||root.shippingType!==2||root.storeId!==0||root.productType!==4)
    throw new ValidateException('次卡收银真实创建或付款来源无法核对');
  const audits=await db.select({id:storeOrderStatus.id}).from(storeOrderStatus).where(and(eq(storeOrderStatus.id,origin.creation_status_id),
    eq(storeOrderStatus.oid,root.id),eq(storeOrderStatus.changeType,'customer_cashier_create'))).limit(2);
  if(audits.length!==1||carts.length!==origin.cart_facts.length)throw new ValidateException('收银次卡原始创建记录不完整');
  const generation=await loadRefundOrderGeneration(db,order,[...carts]);
  for(const original of carts){let cart=original,oid=order.id,visited=new Set<number>();
    for(let depth=0;;depth++){
      const fact=origin.cart_facts.find(f=>f.cart_row_id===cart.id&&oid===root.id);
      if(fact){if(cart.oid!==root.id||cart.uid!==root.uid||cart.cartId!==fact.opaque_cart_id||cart.productId!==fact.product_id
        ||cart.productType!==4||cart.type!==fact.owner_type||cart.relationId!==fact.owner_id||cart.skuUnique!==fact.sku_unique
        ||cart.cartNum!==fact.purchase_quantity||cart.writeTimes!==fact.write_times||await outRequestHash(cart.cartInfo)!==fact.snapshot_hash)
          throw new ValidateException('收银次卡原始购物快照不一致');break;}
      if(!generation||depth>=200)throw new ValidateException('收银次卡购物行代际缺少完整原来源链');
      const splits=await db.select({refundId:storeOrderRefundSplit.refundId,sourceOrderId:storeOrderRefundSplit.sourceOrderId,
        paymentOrderId:storeOrderRefundSplit.paymentOrderId,fingerprint:storeOrderRefundSplit.fingerprint,partitions:storeOrderRefundSplit.partitions,
        sourceSnapshot:sql<string|null>`CASE WHEN octet_length(${storeOrderRefundSplit.sourceSnapshot})<=16777216 THEN ${storeOrderRefundSplit.sourceSnapshot} ELSE NULL END`})
        .from(storeOrderRefundSplit).where(eq(storeOrderRefundSplit.remainingOrderId,oid)).orderBy(sql`${storeOrderRefundSplit.refundId} DESC`).limit(201);
      const record=splits.find(r=>!visited.has(r.refundId)&&generation.covered.get(r.refundId)===r.fingerprint);
      if(!record||record.paymentOrderId!==root.id||!record.sourceSnapshot)throw new ValidateException('收银次卡退款实体来源缺失或超过容量');
      visited.add(record.refundId);
      const applications=await db.select().from(storeOrderRefund).where(eq(storeOrderRefund.id,record.refundId)).limit(2);
      if(applications.length!==1||applications[0].refundType!==6||applications[0].isCancel||applications[0].isDel
        ||await refundOrderSplitFingerprint(applications[0])!==record.fingerprint)throw new ValidateException('收银次卡退款原申请来源不一致');
      let savedSource:Record<string,unknown>,parts:unknown;try{savedSource=JSON.parse(record.sourceSnapshot);parts=JSON.parse(record.partitions);}catch{throw new ValidateException('收银次卡退款实体快照无法核对');}
      if(savedSource.version!=='refund-order-materialization-v1'||!Array.isArray(savedSource.carts)||!Array.isArray(parts)
        ||!parts.length||parts.length>200||savedSource.carts.length!==parts.length)
        throw new ValidateException('收银次卡退款实体快照结构不完整');
      const frozenOrder=savedSource.source as Order|undefined,frozenCarts=savedSource.carts as Cart[];
      if(!frozenOrder||frozenOrder.id!==record.sourceOrderId||frozenOrder.uid!==root.uid
        ||frozenOrder.payType!==root.payType||frozenOrder.staffId!==origin.creator_uid||frozenOrder.isChannel!==2
        ||frozenOrder.shippingType!==2||frozenOrder.storeId!==0||frozenOrder.productType!==4
        ||(frozenOrder.pid>0?frozenOrder.pid:frozenOrder.id)!==root.id)
        throw new ValidateException('收银次卡退款原订单归属不一致');
      const selections=new Map<string,number>(),sourceIds=new Set<number>();
      for(const raw of parts){
        if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new ValidateException('收银次卡退款商品分配不完整');
        const p=raw as Record<string,unknown>,sourceId=id(p.sourceRowId),selected=id(p.selectedNum,true);
        const row=frozenCarts.find(c=>c.id===sourceId);
        if(!row||sourceIds.has(sourceId)||row.oid!==frozenOrder.id||row.uid!==frozenOrder.uid
          ||row.cartId!==p.sourceCartId||selected+id(p.remainingNum,true)!==row.cartNum)
          throw new ValidateException('收银次卡退款原商品分配不一致');
        sourceIds.add(sourceId);if(selected)selections.set(row.cartId,selected);
      }
      // Reuse the mature planner, including its gain_integral normalization and
      // monetary conservation. A hand-written partition differs from creation.
      const financialPlan=planOrderFinancialSplit({...frozenOrder,refundPrice:'0.00',backIntegral:'0.00'},
        frozenCarts.map(c=>({...c,refundNum:0,splitStatus:0,splitSurplusNum:c.cartNum})),selections);
      if(!financialPlan)throw new ValidateException('收银次卡退款完整金额分割来源缺失');
      const part=parts.find(p=>p&&typeof p==='object'&&(p as Record<string,unknown>).remainingRowId===cart.id) as Record<string,unknown>|undefined;
      const source=part?savedSource.carts.find(c=>c&&typeof c==='object'&&(c as Cart).id===part.sourceRowId) as Cart|undefined:undefined;
      if(!part||!source||typeof source.cartInfo!=='string'||typeof cart.cartInfo!=='string'
        ||source.oid!==record.sourceOrderId||source.uid!==root.uid||part.sourceCartId!==source.cartId
        ||part.remainingNum!==cart.cartNum||id(part.selectedNum,true)+cart.cartNum!==source.cartNum
        ||cart.uid!==source.uid||cart.productId!==source.productId||cart.skuUnique!==source.skuUnique||cart.productType!==4
        ||cart.type!==source.type||cart.relationId!==source.relationId||cart.writeStart!==source.writeStart||cart.writeEnd!==source.writeEnd)
          throw new ValidateException('收银次卡退款前后实体数量或规格不一致');
      const partition=financialPlan.carts.get(source.cartId);
      if(!partition?.remaining)throw new ValidateException('收银次卡退款金额分割来源不完整');
      const parsed=JSON.parse(partition.remaining),expected={...parsed,id:cart.cartId,financial_version:'refund-order-line-finance-v1',
        refund_order_generation:{refundId:record.refundId,role:'remaining'}};
      if(await outRequestHash(JSON.parse(cart.cartInfo))!==await outRequestHash(expected)
        ||source.writeTimes%source.cartNum!==0||cart.writeTimes!==cart.cartNum*(source.writeTimes/source.cartNum))
          throw new ValidateException('收银次卡退款分割快照或购买单位次数不一致');
      cart=source;oid=record.sourceOrderId;
    }
    const immutableWindow=parseSecondCardValiditySnapshot(original.cartInfo);
    if(!immutableWindow)throw new ValidateException('原收银次卡有效期购买快照缺失');
    const window=resolveSecondCardValidityAtPayment(immutableWindow,order.payTime,{writeStart:0,writeEnd:0});
    if(window.writeStart!==original.writeStart||window.writeEnd!==original.writeEnd)throw new ValidateException('收银次卡真实支付后的有效期尚未激活');
  }
  const events=await db.select().from(storeOrderOutbox).where(and(eq(storeOrderOutbox.eventKey,`order.paid:${root.id}`),
    eq(storeOrderOutbox.eventType,'order.paid'),eq(storeOrderOutbox.aggregateId,root.id))).limit(2);
  const event=events[0];
  const payload=event?.payload as {orderId?:unknown;orderNo?:unknown}|undefined;
  if(events.length!==1||event.aggregateType!=='order'||payload?.orderId!==root.id||payload.orderNo!==root.orderId)
    throw new ValidateException('收银次卡付款事件与实际订单不一致');
  const payments=await db.execute<{evidence:Record<string,unknown>;order_paid_status_id:number;outbox_id:number}>(sql`SELECT evidence,order_paid_status_id,outbox_id
    FROM public.cashier_second_card_payment_v1 WHERE order_id=${root.id} LIMIT 2`),receipt=payments[0];
  if(payments.length!==1||receipt.outbox_id!==event.id||receipt.evidence.origin_hash!==saved.origin_hash
    ||receipt.evidence.creator_uid!==origin.creator_uid||receipt.evidence.buyer_uid!==root.uid||receipt.evidence.order_no!==root.orderId
    ||receipt.evidence.amount!==root.payPrice||receipt.evidence.pay_time!==root.payTime||receipt.evidence.pay_type!==root.payType
    ||receipt.evidence.payload_hash!==await outRequestHash(event.payload))throw new ValidateException('原收银现金付款回执与订单事件不一致');
  const paidAudits=await db.select({id:storeOrderStatus.id}).from(storeOrderStatus).where(and(eq(storeOrderStatus.id,receipt.order_paid_status_id),
    eq(storeOrderStatus.oid,root.id),eq(storeOrderStatus.changeType,'customer_cashier_paid'))).limit(2);
  if(paidAudits.length!==1)throw new ValidateException('原收银付款操作记录缺失');
  return{version:CASHIER_SECOND_CARD_ORIGIN_VERSION,origin_hash:saved.origin_hash,creator_kind:'customer',creator_id:origin.creator_uid,
    root_order_id:root.id,root_order_no:root.orderId,cart_facts:origin.cart_facts,
    payment_facts:{outbox_id:event.id,event_key:event.eventKey,payload_hash:await outRequestHash(event.payload),pay_type:order.payType,paid_at:order.payTime}};
}
