/** Reuse the mature quote/package/full-gift scenario contracts on owned PG16
 * column fixtures. Admin mutations, gift commissioning, checkout, paid outbox
 * and refund services are real. The labelled HTTP user and explicit local paid
 * header are fixture boundaries, not App/JWT/provider/runtime-grant evidence. */
import { eq, sql } from 'drizzle-orm';
import { createContainerFromDb, withTx, type DbClient } from '../../src/lib/di';
import type { OrderMessage } from '../../src/env';
import { AdminFullGiftService } from '../../src/services/admin/AdminFullGiftService';
import { StoreDiscountService } from '../../src/services/activity/StoreDiscountService';
import { StoreOrderCreateService } from '../../src/services/order/StoreOrderCreateService';
import { enqueueOrderPaidEvent, OrderOutboxService } from '../../src/services/order/OrderOutboxService';
import { runOrderPromotionGiftReceipt } from '../../src/migrations/runOrderPromotionGiftReceipt';
import { runPurchaseCancellationEvidenceSchema } from '../../src/migrations/runPurchaseCancellationEvidence';
import { runPurchaseCancellationGiftEvidence } from '../../src/migrations/runPurchaseCancellationGiftEvidence';
import { REFUND_ORDER_SPLIT_SQL } from '../../src/migrations/refundOrderSplit';
import { agentLevel, luckLottery, orderWaybillJob, printDocument, storeCart,
  storeCouponIssue, storeCouponIssueUser, storeCouponProduct, storeCouponUser,
  storeDiscounts, storeDiscountsProducts, storeOrder, storeOrderEconomize,
  storeOrderInvoice, storeOrderOutbox, storeOrderProductCouponReward, storeProductCoupon,
  storeOrderRefund, storeOrderRefundPayment, storeOrderStatus, storeProduct,
  storeProductAttrValue, storeProductCategory, supplierFlowingWater,
  supplierTransactions, systemLog, systemUserLevel, userBrokerage, userLabel,
  userLabelRelation } from '../../src/models/schema';
import { createPcCheckoutQuoteFixture } from './pcCheckoutQuoteFixture';

type QuoteFixture = Awaited<ReturnType<typeof createPcCheckoutQuoteFixture>>;
type Rules = Pick<typeof storeProduct.$inferSelect, 'isLimit' | 'limitType' | 'limitNum'>;
export interface AuthorsReceipt { orderKey: string; quoteToken: string;
  cartInfo: Array<Record<string, unknown>>; priceGroup: Record<string, string> }
const commonTables = [printDocument, storeOrderStatus, storeOrderOutbox,
  storeCouponIssue, storeCouponIssueUser, storeCouponProduct, storeCouponUser, systemUserLevel];
const commonState = ['user', 'store_cart', 'store_product', 'store_product_attr_value',
  'store_order', 'store_order_cart_info', 'store_order_status', 'store_order_outbox', 'user_bill',
  'store_coupon_issue', 'store_coupon_user', 'store_order_purchase_origin'] as const;

function authorHarness(f: QuoteFixture, type: number, extraState: readonly string[]) {
  let orderNumber = 0;
  const limits = async (id: number, patch: Partial<Rules>, db: DbClient = f.db) => {
    // An explicit configuration-state edit, not Admin route authorization proof.
    await db.update(storeProduct).set(patch).where(eq(storeProduct.id, id));
  };
  const state = async (db: DbClient = f.db) => Object.fromEntries(await Promise.all(
    [...commonState, ...extraState].map(async table => [table, Array.from(await db.execute(sql.raw(
      `SELECT to_jsonb(captured) AS row FROM public.${table} AS captured ORDER BY to_jsonb(captured)::text`)))])));
  const quote = (cartIds = [1]) => new StoreOrderCreateService(f.container, f.env)
    .quoteOrder({ uid: 11, cartIds, type, addressId: 11, shippingType: 1 });
  const confirm = async (cartIds = [1]) => {
    const response = await f.app.request('/api/order/confirm', { method: 'POST',
      headers: { 'content-type': 'application/json', 'x-fixture-user': '11' },
      body: JSON.stringify({ cartIds, type, addressId: 11, shippingType: 1, useIntegral: false }),
    }, f.env);
    return response.json<{ status: number; msg: string; data: AuthorsReceipt | null }>();
  };
  const create = (cartIds = [1], options: { db?: DbClient; receipt?: AuthorsReceipt;
    nextOrderId?: () => Promise<void> } = {}) => StoreOrderCreateService.createWithRuntime(
    createContainerFromDb(options.db ?? f.db), { CONFIG_KV: f.env.CONFIG_KV, requirePurchaseOrigin: true,
      ...(options.receipt ? { requireConfirmation: true as const } : {}),
      nextOrderId: async () => { await options.nextOrderId?.(); return `purchase_author_${++orderNumber}`; },
    }, { uid: 11, cartIds, type, key: options.receipt?.orderKey ?? crypto.randomUUID(),
      quoteToken: options.receipt?.quoteToken, addressId: 11, shippingType: 1,
      useIntegral: false, userIp: '127.0.0.1' });
  return { limits, state, quote, confirm, create };
}

async function prepareBase(f: QuoteFixture) {
  await f.setConfig(Object.fromEntries(Object.keys(f.config).map(key => [key, '0'])));
  await f.db.update(storeProduct).set({ isLimit: 0, limitType: 0, limitNum: 0,
    isVip: 0, freight: 1, tempId: 0, deliveryType: '1' }).where(eq(storeProduct.id, 70));
  await f.db.execute(sql`SELECT setval(pg_get_serial_sequence('public.store_cart','id'),
    (SELECT MAX(id) FROM public.store_cart),true)`);
}

export async function productPurchasePackageFixture() {
  if (!process.env.TEST_FINANCE_POSTGRES_URL) throw Error('Package author tests require owned native PG16');
  const f = await createPcCheckoutQuoteFixture(commonTables);
  try {
    await prepareBase(f);
    // Same valid fixed two-product structure as checkout-confirmation-rules and
    // the mature package scenario. Duplicate product entries are forbidden by
    // the actual service and are never fabricated to claim aggregation coverage.
    await f.db.insert(storeDiscounts).values({ id: 40, title: '基础限购套餐', type: 0,
      status: 1, isDel: 0, isSupportRefund: 1, freeShipping: 1 });
    await f.db.insert(storeDiscountsProducts).values([
      { id: 101, discountId: 40, productId: 70 }, { id: 102, discountId: 40, productId: 71 },
    ]);
    await f.db.insert(storeProduct).values({ id: 71, storeName: '第二套餐商品', stock: 8,
      price: '10.00', isShow: 1, isVerify: 1, freight: 1, deliveryType: '1' });
    await f.db.insert(storeProductAttrValue).values([
      { id: 2, productId: 71, type: 0, unique: 'base0071', suk: '标准', stock: 8, price: '10.00' },
      { id: 3, productId: 101, type: 5, unique: 'pack0101', suk: '红色,大号', stock: 8, price: '8.00' },
      { id: 4, productId: 102, type: 5, unique: 'pack0102', suk: '标准', stock: 8, price: '8.00' },
    ]);
    const prepare = () => new StoreDiscountService(f.container).createDirectBuyCarts(11, 40, [
      { entryId: 101, productId: 70, unique: 'pack0101' },
      { entryId: 102, productId: 71, unique: 'pack0102' },
    ]);
    return { ...f, ...authorHarness(f, 5, ['store_discounts', 'store_discounts_products']), prepare };
  } catch (error) { await f.close(); throw error; }
}

function shanghai(hours: number) {
  const date = new Date(Date.now() + (hours + 8) * 3_600_000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} `
    + `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
}

export async function productPurchaseGiftFixture() {
  if (!process.env.TEST_FINANCE_POSTGRES_URL) throw Error('Gift author tests require owned native PG16');
  const f = await createPcCheckoutQuoteFixture([...commonTables, userLabel, userLabelRelation,
    storeProductCategory, systemLog, agentLevel, luckLottery, storeOrderInvoice, storeOrderRefund,
    storeOrderRefundPayment, orderWaybillJob, userBrokerage, supplierFlowingWater,
    supplierTransactions, storeOrderEconomize, storeOrderProductCouponReward, storeProductCoupon]);
  try {
    // Exact existing full-gift checkout/refund scenario commissioning, not a
    // production installer or an unprotected imitation of refund receipts.
    await f.exec('CREATE INDEX soi_order ON store_order_invoice(order_id)');
    await f.exec('CREATE INDEX soi_uid_state_time ON store_order_invoice(uid,is_del,is_refund,add_time)');
    await f.exec('CREATE INDEX soi_issue_state_time ON store_order_invoice(is_pay,is_del,is_invoice,add_time)');
    await f.exec(REFUND_ORDER_SPLIT_SQL);
    await f.exec('CREATE UNIQUE INDEX full_gift_outbox_event ON store_order_outbox(event_key)');
    await f.exec('CREATE INDEX full_gift_status_oid ON store_order_status(oid)');
    await f.exec('CREATE INDEX full_gift_bill_category_type_link ON user_bill(category,type,link_id)');
    await runOrderPromotionGiftReceipt(f.db);
    await runPurchaseCancellationEvidenceSchema(f.db);
    await runPurchaseCancellationGiftEvidence(f.db);
    await prepareBase(f);
    await f.db.insert(storeProduct).values({ id: 71, storeName: '基础限购实物赠品', stock: 20,
      image: '/gift.png', isShow: 1, isVerify: 1, deliveryType: '1' });
    await f.db.insert(storeProductAttrValue).values({ id: 71, productId: 71, type: 0,
      unique: 'gift80', suk: '礼盒', stock: 20 });
    await f.db.insert(storeProduct).values({ id: 72, storeName: '第二活动原价商品', stock: 8,
      price: '10.00', isShow: 1, isVerify: 1, deliveryType: '1', freight: 1, tempId: 0 });
    await f.db.insert(storeProductAttrValue).values({ id: 72, productId: 72, type: 0,
      unique: 'paid0072', suk: '蓝色', stock: 8, price: '10.00' });
    await f.db.insert(userLabel).values({ id: 31, name: '满送成交客户', type: 0, relationId: 0 });
    await f.db.insert(storeCouponIssue).values({ id: 41, couponTitle: '限购赠品伴随券', type: 1,
      couponPrice: '2.00', useMinPrice: '5.00', receiveType: 3, status: 1,
      remainCount: 20, totalCount: 20, day: 7 });
    const campaign = async (productId: number, unique: string) => new AdminFullGiftService(f.container)
      .mutate('create', 0, { name: `基础限购满送${productId}`, section_time: [shanghai(-1), shanghai(24)],
        promotions_cate: 2, threshold_type: 1, promotions: [{ threshold: 10, give_integral: 3,
          give_coupon_id: [{ give_coupon_id: 41, give_coupon_num: 10 }],
          give_product_id: [{ give_product_id: 71, unique: 'gift80', give_product_num: 10 }] }],
        is_label: 1, label_id: [31], product_partake_type: 2,
        product_id: [{ product_id: productId, unique: [unique] }], brand_id: [], store_label_id: [],
        status: 1, sort: 0, request_id: crypto.randomUUID() }, { id: 9 });
    const root = await campaign(70, 'qared001');
    const harness = authorHarness(f, 0, ['store_promotions', 'store_promotions_auxiliary',
      'store_order_refund', 'store_order_refund_payment', 'store_order_refund_split',
      'store_order_fulfillment_branch', 'store_order_purchase_cancellation',
      'store_order_promotion_gift_coupon_reward', 'user_label_relation', 'user_brokerage',
      'supplier_flowing_water', 'supplier_transactions', 'store_order_invoice',
      'store_order_economize', 'store_order_product_coupon_reward']);
    const secondCampaign = async () => {
      const other = await campaign(72, 'paid0072');
      const [cart] = await f.db.insert(storeCart).values({ uid: 11, productId: 72,
        productAttrUnique: 'paid0072', cartNum: 2, status: 1, isNew: 1 }).returning();
      return { rootId: other.id, cartId: cart.id };
    };
    const paid = async () => {
      const confirmation = await harness.confirm();
      if (confirmation.status !== 200 || !confirmation.data) throw Error(`Gift confirmation failed: ${confirmation.msg}`);
      const created = await harness.create([1], { receipt: confirmation.data });
      const now = Math.floor(Date.now() / 1000);
      // Explicit synthetic paid header, followed by the ACTUAL paid outbox and
      // protected gift receipts. No payment provider/callback acceptance claim.
      const event = await withTx(f.container, async tx => {
        const [order] = await tx.update(storeOrder).set({ paid: 1, payType: 'yue', payTime: now })
          .where(eq(storeOrder.orderId, created.orderId)).returning();
        return enqueueOrderPaidEvent(tx, order, now);
      });
      const queue = { sendBatch: async () => ({ successful: 1 }), send: async () => {} };
      const service = new OrderOutboxService(f.container, { ORDER_QUEUE: queue as unknown as Queue<OrderMessage> });
      const processed = await service.processMessage({ action: 'processOrderPaidOutbox', outboxId: event.id, eventKey: event.eventKey });
      if (processed !== 'completed') throw Error(`Actual paid gift outbox did not complete: ${processed}`);
      return (await f.db.select().from(storeOrder).where(eq(storeOrder.orderId, created.orderId)))[0];
    };
    return { ...f, ...harness, rootId: root.id, secondCampaign, paid };
  } catch (error) { await f.close(); throw error; }
}
