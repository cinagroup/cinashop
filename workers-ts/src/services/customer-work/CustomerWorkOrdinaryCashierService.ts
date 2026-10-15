import { and, eq, sql } from 'drizzle-orm';
import { createContainerFromDb, withTx, type Container, type DbClient } from '@/lib/di';
import type { Env } from '@/env';
import { storeOrder, storeOrderStatus, storeOrderOutbox } from '@/models/schema';
import { ValidateException, HttpApiException } from '@/utils/errors';
import { normalizeOutRequestKey, outRequestHash } from '@/services/out/OutIdempotency';
import { StoreOrderCreateService, type StoreOrderCreationRuntime, type OrderPricingQuote } from '@/services/order/StoreOrderCreateService';
import { prepareCashierOrdinaryCreation, readCashierOrdinaryUnpaidOrigin } from '@/services/order/CashierOrdinaryOrigin';
import { OrderQuoteReconfirmRequired, type CheckoutConfirmation } from '@/services/order/CheckoutConfirmation';
import { applyStoreOrderPayment } from '@/services/order/StoreOrderPayService';
import { lockOrderSettlement } from '@/services/order/OrderBrokerageService';
import { hasInitiatedAssistedProviderPayment } from '@/services/payment/AssistedProviderPaymentClaim';
import { OrderOutboxService } from '@/services/order/OrderOutboxService';
import type { OrderCouponPage } from '@/services/activity/OrderCouponService';
import { cashierOrdinaryReadiness } from '@/migrations/runCashierOrdinary';
import { authorizeCustomerWorkActor, type CustomerWorkActor } from './CustomerWorkScope';
import { freezeCustomerActor } from './CustomerWorkOperationRequest';
import { CUSTOMER_ORDINARY_CASHIER_VERSION, parseOrdinaryCashierIntent, parseOrdinaryCashierPayment, ordinaryCashierObject,
  ordinaryCashierHash, type OrdinaryCashierIntent } from './CustomerOrdinaryCashierContract';
import { lockOrdinaryCashierRequest, authorizeOrdinaryCashierWrite, authorizeOrdinaryCashierReceiptOwner, readOrdinaryCashierOperation,
  priorOrdinaryCashierOperation, appendOrdinaryCashierOperation, prepareOrdinaryCashierDraft, changeOrdinaryCashierRows,
  readOrdinaryCashierDraft, assertOrdinaryDraftIntent, ordinaryCashierJson, type OrdinaryCashierOperationReceipt } from './CustomerOrdinaryCashierLedger';
import { appendOrdinaryCashierRows } from './CustomerOrdinaryCashierLedger';
import { assertOrdinaryBuyer } from './CustomerOrdinaryCashierLedger';
import { abandonOrdinaryCashierOperation } from './CustomerOrdinaryCashierLedger';
import { publicOrdinaryCashierForm } from './CustomerOrdinaryCashierForm';

const TTL = 1800;
function result(receipt: OrdinaryCashierOperationReceipt, replayed: boolean) {
  return { version: 'customer-cashier-ordinary-result-v1' as const, actor_uid: receipt.actor_uid, request_key: receipt.request_key,
    request_hash: receipt.request_hash, kind: receipt.kind, replayed, receipt };
}
function coreParams(intent: OrdinaryCashierIntent, key: string, cartIds: readonly number[]) {
  return { uid: intent.buyer_uid, key: key.replaceAll('-', ''), cartIds: [...cartIds], shippingType: intent.shipping_type, storeId: intent.store_id,
    addressId: intent.address_id, manualAddress: intent.manual_address ?? undefined, realName: intent.real_name, userPhone: intent.user_phone,
    mark: intent.mark, customForm: intent.custom_form, couponId: intent.coupon_id, useIntegral: intent.use_integral, type: 0, payType: 'cash', userIp: '' };
}
const quoteKey = (actorUid: number, requestKey: string, token: string) => `customer:cashier:ordinary:quote:v1:${actorUid}:${requestKey}:${token}`;
interface QuoteReceipt {
  version: typeof CUSTOMER_ORDINARY_CASHIER_VERSION; actor_uid: number; request_key: string; request_hash: string;
  intent: OrdinaryCashierIntent; fingerprint: string; created_at: number; expires_at: number;
}
async function readQuote(runtime: StoreOrderCreationRuntime, actor: CustomerWorkActor, key: string, token: unknown): Promise<QuoteReceipt> {
  if (typeof token !== 'string' || !/^[a-f0-9]{32}$/.test(token)) throw new OrderQuoteReconfirmRequired(key);
  const raw = await runtime.CONFIG_KV.get(quoteKey(actor.uid, key, token));
  if (!raw || new TextEncoder().encode(raw).length > 131072) throw new OrderQuoteReconfirmRequired(key);
  let r: Record<string, unknown>; try { r = ordinaryCashierObject(JSON.parse(raw), ['version','actor_uid','request_key','request_hash','intent','fingerprint','created_at','expires_at']); }
  catch { throw new OrderQuoteReconfirmRequired(key); }
  const intent = parseOrdinaryCashierIntent(r.intent), now = Math.floor(Date.now() / 1000);
  if (r.version !== CUSTOMER_ORDINARY_CASHIER_VERSION || r.actor_uid !== actor.uid || r.request_key !== key
    || r.request_hash !== await outRequestHash(intent) || typeof r.created_at !== 'number' || !Number.isSafeInteger(r.created_at)
    || r.created_at > now || r.expires_at !== r.created_at + TTL || Number(r.expires_at) <= now) throw new OrderQuoteReconfirmRequired(key);
  return { version: CUSTOMER_ORDINARY_CASHIER_VERSION, actor_uid: actor.uid, request_key: key, request_hash: String(r.request_hash), intent,
    fingerprint: ordinaryCashierHash(r.fingerprint), created_at: r.created_at, expires_at: Number(r.expires_at) };
}
function pricing(q: OrderPricingQuote) {
  const money = (n: number) => { if (!Number.isSafeInteger(n) || n < 0) throw new ValidateException('普通收银实际报价金额无效'); return (n / 100).toFixed(2); };
  return { currency: 'CNY', amount: money(q.payCents), total: money(q.totalCents), raw_total: money(q.rawTotalCents), quantity: q.totalNum,
    postage: money(q.payPostageCents), raw_postage: money(q.totalPostageCents), coupon_discount: money(q.couponPriceCents),
    integral_discount: money(q.deductionCents), first_order_discount: money(q.firstOrderPriceCents), membership_discount: money(q.memberDiscountCents),
    promotion_discount: money(q.promotionSavingsCents), used_integral: q.usedIntegralPoints, remaining_integral: q.surplusIntegralPoints,
    integral_policy: { enabled: q.integralPolicy.enabled, ratio: q.integralPolicy.ratio }, gives_integral: (q.productIntegral??0)+q.giveIntegral,
    product_gives_integral: q.productIntegral??0,promotion_gives_integral:q.giveIntegral };
}
function coupons(page:OrderCouponPage|undefined){
  return {list:(page?.list??[]).map(row=>({id:row.id,cid:row.cid,title:row.title,discount_type:row.coupon_type,scope_type:row.applicable_type,
    coupon_price:row.coupon_price,use_min_price:row.use_min_price,start_time:row.start_time,end_time:row.end_time,
    availability:row.availability,availability_message:row.availability_message,rule:row.rule,rule_truncated:row.rule_truncated,
    estimated_discount:row.estimated_discount,eligible_subtotal:row.eligible_subtotal})),next_cursor:page?.nextCursor??null};
}
async function readEnvelope<T>(container: Container, actorValue: CustomerWorkActor, scopeKey: string | undefined, callback: (db: DbClient) => Promise<T>) {
  const actor = freezeCustomerActor(actorValue), snapshot = await withTx(container, async tx => {
    await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
    const scope = await authorizeCustomerWorkActor(tx, actor);
    if (scopeKey !== undefined && scope.scope_key !== scopeKey) throw new HttpApiException('普通收银经营资格已变化', 403, 403);
    const data = await callback(tx);
    return { version: 'customer-cashier-ordinary-read-v1' as const, actor_uid: actor.uid,
      principal: { kind: 'customer-order-manager' as const, service_id: scope.service_id, scope: 'global' as const }, scope_key: scope.scope_key,
      consistency_key: await outRequestHash({ scope_key: scope.scope_key, data }), data };
  });
  if ((await authorizeCustomerWorkActor(container.db, actor)).scope_key !== snapshot.scope_key) throw new HttpApiException('普通收银经营资格已变化', 403, 403);
  return snapshot;
}
export { readEnvelope as withOrdinaryCashierRead };
export class CustomerWorkOrdinaryCashierService {
  readonly runtime: StoreOrderCreationRuntime;
  constructor(readonly container: Container, readonly env: Env, runtime?: StoreOrderCreationRuntime) {
    this.runtime = runtime ?? { CONFIG_KV: env.CONFIG_KV, requirePurchaseOrigin: true, nextOrderId: async () => {
      const sequence = env.SEQUENCE.get(env.SEQUENCE.idFromName('seq'));
      return (await (await sequence.fetch('https://internal/next-order-id?prefix=wx')).text()).trim();
    } };
  }
  async draft(actor: CustomerWorkActor, key: unknown, value: unknown) { const r = await prepareOrdinaryCashierDraft(this.container, actor, key, value); return result(r.receipt, r.replayed); }
  async quantity(actor: CustomerWorkActor, key: unknown, value: unknown) { const r = await changeOrdinaryCashierRows(this.container, actor, key, 'quantity', value); return result(r.receipt, r.replayed); }
  async remove(actor: CustomerWorkActor, key: unknown, value: unknown) { const r = await changeOrdinaryCashierRows(this.container, actor, key, 'remove', value); return result(r.receipt, r.replayed); }
  async rows(actor: CustomerWorkActor, key: unknown, value: unknown) { const r = await appendOrdinaryCashierRows(this.container, actor, key, value); return result(r.receipt, r.replayed); }
  async abandon(actor:CustomerWorkActor,key:unknown,value:unknown){const r=await abandonOrdinaryCashierOperation(this.container,actor,key,value);return result(r.receipt,r.replayed);}
  readDraft(actor: CustomerWorkActor, keyValue: unknown, scopeKey?: string) {
    const key = normalizeOutRequestKey(keyValue);
    return readEnvelope(this.container, actor, scopeKey, async db => {
      const draft=await readOrdinaryCashierDraft(db,actor.uid,key),state=await cashierOrdinaryReadiness(db);
      return {draft,readiness:{writes:state.ready,reason:state.reason}};
    });
  }
  readiness(actor: CustomerWorkActor, scopeKey?: string) { return readEnvelope(this.container, actor, scopeKey, async db => {
    const state = await cashierOrdinaryReadiness(db); return { writes: state.ready, reason: state.reason, product_types: [0], max_rows: 200,
      payments: { cash: state.ready, zero: state.ready, weixin: false, alipay: false } };
  }); }
  async operation(actorValue: CustomerWorkActor, keyValue: unknown) {
    const actor = freezeCustomerActor(actorValue), key = normalizeOutRequestKey(keyValue), receipt = await withTx(this.container, async tx => {
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
      await authorizeOrdinaryCashierReceiptOwner(tx, actor); return readOrdinaryCashierOperation(tx, actor.uid, key);
    });
    await authorizeOrdinaryCashierReceiptOwner(this.container.db, actor);
    return { version: 'customer-cashier-ordinary-receipt-v1' as const, actor_uid: actor.uid, request_key: key, receipt };
  }
  async quote(actorValue: CustomerWorkActor, keyValue: unknown, value: unknown) {
    const actor = freezeCustomerActor(actorValue), key = normalizeOutRequestKey(keyValue), intent = parseOrdinaryCashierIntent(value);
    if(key===intent.draft_key)throw new ValidateException('创建编号不能复用原草稿操作编号');
    const quoted = await readEnvelope(this.container, actor, intent.scope_key, async db => {
      const capability = await prepareCashierOrdinaryCreation(db, actor, key, intent), draft = await readOrdinaryCashierDraft(db, actor.uid, intent.draft_key);
      const q = await StoreOrderCreateService.createWithRuntime(createContainerFromDb(db), { ...this.runtime, cashierOrdinaryCreation: capability },
        coreParams(intent, key, draft.rows.filter(r => !r.removed && !r.consumed).map(r => r.cart_id)), { preview: true, couponQuery: { limit: 20, before: 0, unpaged: false } });
      return { draft, q };
    });
    assertOrdinaryDraftIntent(await readOrdinaryCashierDraft(this.container.db, actor.uid, intent.draft_key), intent);
    const token = crypto.randomUUID().replaceAll('-', ''), now = Math.floor(Date.now() / 1000), request_hash = await outRequestHash(intent), q = quoted.data.q;
    const record: QuoteReceipt = { version: CUSTOMER_ORDINARY_CASHIER_VERSION, actor_uid: actor.uid, request_key: key, request_hash, intent,
      fingerprint: q.confirmationFingerprint, created_at: now, expires_at: now + TTL };
    await this.runtime.CONFIG_KV.put(quoteKey(actor.uid, key, token), ordinaryCashierJson(record), { expirationTtl: TTL });
    const data = { request_key: key, request_hash, draft_key: intent.draft_key, draft_hash: intent.draft_hash, quote_token: token, quote_fingerprint:q.confirmationFingerprint, expires_at: record.expires_at,
      pricing: pricing(q), items: q.items.map(item => ({ cart_id: item.cartId, raw_unit_price: (item.rawUnitPriceCents / 100).toFixed(2),
        unit_price: (item.unitPriceCents / 100).toFixed(2), total_price: (item.totalPriceCents / 100).toFixed(2), discount: (item.discountCents / 100).toFixed(2), price_type: item.priceType })),
      system_form: publicOrdinaryCashierForm(q.systemForm ?? null), coupons: coupons(q.couponPage),
      promotion_gifts:{integral:q.giveIntegral,coupons:q.giveCouponInfo.map(c=>({issue_id:c.id,title:c.title,price:c.price,min_price:c.minPrice})),
        products:q.giveCartInfo.map(p=>({cart_id:p.cartId,product_id:p.productId,sku_unique:p.skuUnique,quantity:p.quantity,promotion_id:p.promotionId})),
          promotions:q.promotionsDetail.map(p=>{if(p.thresholdType!==1&&p.thresholdType!==2)throw new ValidateException('普通报价活动门槛来源无法核对');
            return{id:p.id,tier_id:p.tierId,name:p.name,threshold:p.threshold,threshold_type:p.thresholdType,repetitions:p.repetitions};})} };
    return { ...quoted, data, consistency_key: await outRequestHash({ scope_key: intent.scope_key, data }) };
  }
  async coupons(actorValue: CustomerWorkActor, keyValue: unknown, token: unknown, scopeKey: string, limit: number, before: number) {
    const actor = freezeCustomerActor(actorValue), key = normalizeOutRequestKey(keyValue), receipt = await readQuote(this.runtime, actor, key, token);
    if (receipt.intent.scope_key !== scopeKey || !Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(before) || before < 0)
      throw new ValidateException('原报价或优惠券分页无效');
    return readEnvelope(this.container, actor, scopeKey, async db => {
      const capability = await prepareCashierOrdinaryCreation(db, actor, key, receipt.intent), draft = await readOrdinaryCashierDraft(db, actor.uid, receipt.intent.draft_key);
      const q = await StoreOrderCreateService.createWithRuntime(createContainerFromDb(db), { ...this.runtime, cashierOrdinaryCreation: capability },
        coreParams(receipt.intent, key, draft.rows.filter(r => !r.removed && !r.consumed).map(r => r.cart_id)), { preview: true, couponQuery: { limit, before, unpaged: false } });
      if (q.confirmationFingerprint !== receipt.fingerprint) throw new OrderQuoteReconfirmRequired(key);
      return { request_key: key, quote_token: token, coupons: coupons(q.couponPage) };
    });
  }
  async create(actorValue: CustomerWorkActor, keyValue: unknown, value: unknown, token: unknown) {
    const actor = freezeCustomerActor(actorValue), key = normalizeOutRequestKey(keyValue), intent = parseOrdinaryCashierIntent(value), original = await this.operation(actor, key);
    if (original.receipt) {
      if ((original.receipt.kind !== 'creation'&&!(original.receipt.kind==='abandon'&&original.receipt.evidence.original_kind==='creation')) || original.receipt.request_hash !== await outRequestHash(intent)) throw new HttpApiException('原创建请求已绑定其他内容', 409, 409);
      if ((await authorizeCustomerWorkActor(this.container.db, actor)).scope_key !== intent.scope_key) throw new HttpApiException('收银经营资格已变化，请查询原编号', 403, 403);
      return result(original.receipt, true);
    }
    const receipt = await readQuote(this.runtime, actor, key, token);
    if (receipt.request_hash !== await outRequestHash(intent)) throw new OrderQuoteReconfirmRequired(key);
    const confirmation: CheckoutConfirmation = { fingerprint: receipt.fingerprint, expiresAt: receipt.expires_at };
    return withTx(this.container, async tx => {
      await lockOrdinaryCashierRequest(tx, actor.uid, key, intent.draft_key); await authorizeOrdinaryCashierWrite(tx, actor, intent.scope_key);
      const prior = await priorOrdinaryCashierOperation(tx, actor.uid, key, 'creation', intent); if (prior) return result(prior, true);
      const capability = await prepareCashierOrdinaryCreation(tx, actor, key, intent, confirmation), draft = await readOrdinaryCashierDraft(tx, actor.uid, intent.draft_key);
      const created = await StoreOrderCreateService.createWithRuntime(createContainerFromDb(tx), { ...this.runtime, requirePurchaseOrigin: true, cashierOrdinaryCreation: capability },
        coreParams(intent, key, draft.rows.filter(r => !r.removed && !r.consumed).map(r => r.cart_id)));
      const actual = await priorOrdinaryCashierOperation(tx, actor.uid, key, 'creation', intent);
      if (!actual || (actual.evidence.order as Record<string,unknown>)?.order_no !== created.orderId) throw new ValidateException('原普通收银创建结果无法核对，请保留原编号');
      return result(actual, false);
    });
  }
  async cash(actorValue: CustomerWorkActor, keyValue: unknown, value: unknown) {
    const actor = freezeCustomerActor(actorValue), key = normalizeOutRequestKey(keyValue), intent = parseOrdinaryCashierPayment(value);
    const paid = await withTx(this.container, async tx => {
      await lockOrdinaryCashierRequest(tx, actor.uid, key);
      const prior = await priorOrdinaryCashierOperation(tx, actor.uid, key, 'payment', intent);
      if (prior) { await authorizeOrdinaryCashierWrite(tx, actor, intent.scope_key); return { receipt: prior, replayed: true, outbox: null }; }
      await lockOrderSettlement(tx, intent.order_id);
      const [order] = await tx.select().from(storeOrder).where(eq(storeOrder.id, intent.order_id)).limit(1).for('update');
      await authorizeOrdinaryCashierWrite(tx, actor, intent.scope_key);
      if (!order || order.orderId !== intent.order_no || order.payPrice !== intent.expected_amount || order.type !== 0 || order.productType !== 0
        || order.pid !== 0 || order.paid !== 0 || order.status !== 0 || order.isDel || order.isSystemDel || order.tradeNo !== '')
        throw new ValidateException('原普通收银订单、实际金额或付款状态已变化');
      const source = await readCashierOrdinaryUnpaidOrigin(tx, order);
      await assertOrdinaryBuyer(tx, order.uid, true);
      if (await hasInitiatedAssistedProviderPayment(tx, order.orderId)) throw new ValidateException('扫码支付已有原请求，请先核对渠道结果');
      const actual = await applyStoreOrderPayment(createContainerFromDb(tx), { orderId: order.id, payType: 'cash',
        audit: { changeType: 'customer_ordinary_cashier_paid', changeMessage: `客户 ${actor.uid} 确认普通商品收银现金付款` },
        authorizeBeforePayment: async (inner, locked) => {
          await authorizeOrdinaryCashierWrite(inner, actor, intent.scope_key);
          if (locked.id !== order.id || locked.orderId !== order.orderId || locked.payPrice !== intent.expected_amount || locked.paid !== 0) throw new ValidateException('原现金付款条件已变化');
        } });
      if (actual.outcome !== 'paid' || !actual.outbox) throw new ValidateException('普通收银订单未实际入账');
      const [stored] = await tx.select().from(storeOrder).where(eq(storeOrder.id, order.id)).limit(1);
      const audits = await tx.select().from(storeOrderStatus).where(and(eq(storeOrderStatus.oid, order.id), eq(storeOrderStatus.changeType, 'customer_ordinary_cashier_paid'))).limit(2);
      const events = await tx.select().from(storeOrderOutbox).where(eq(storeOrderOutbox.id, actual.outbox.id)).limit(2), event = events[0];
      if (!stored || stored.paid !== 1 || stored.payType !== 'cash' || stored.payPrice !== intent.expected_amount || stored.payTime <= 0
        || audits.length !== 1 || audits[0].changeTime !== stored.payTime || events.length !== 1 || event.eventKey !== `order.paid:${order.id}`
        || event.aggregateId !== order.id || event.eventType !== 'order.paid') throw new ValidateException('实际付款审计与原订单事件不一致');
      const evidence = { outcome: stored.payPrice === '0.00' ? 'zero-paid' : 'cash-paid', payment: { order_id: order.id, order_no: order.orderId,
        buyer_uid: stored.uid, creator_uid: source.origin.creator_uid, payer_uid: actor.uid, paid: 1, pay_type: 'cash', pay_time: stored.payTime,
        amount: stored.payPrice, origin_hash: source.origin_hash, status_id: audits[0].id, outbox: { id: event.id, event_key: event.eventKey,
          event_type: event.eventType, payload_hash: await outRequestHash(event.payload) } } };
      const receipt = await appendOrdinaryCashierOperation(tx, actor.uid, key, 'payment', intent as unknown as Record<string,unknown>, evidence, null, order.id);
      return { receipt, replayed: false, outbox: actual.outbox };
    });
    if (paid.outbox) { try { await new OrderOutboxService(this.container, this.env).dispatchById(paid.outbox.id); } catch { /* Original durable outbox remains retryable. */ } }
    return result(paid.receipt, paid.replayed);
  }
}
