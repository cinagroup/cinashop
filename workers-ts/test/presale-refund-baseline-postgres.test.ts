import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import type { OrderMessage } from '@/env';
import { createPcCheckoutQuoteFixture } from './helpers/pcCheckoutQuoteFixture';
import { createContainerFromDb, withTx } from '@/lib/di';
import { withFinancePeers } from './helpers/financePeers';
import { StoreOrderCreateService } from '@/services/order/StoreOrderCreateService';
import { allocatePaidOrderBySupplier } from '@/services/order/OrderSupplierAllocationService';
import { applyOrderRefund, finalizeStoreOrderRefund } from '@/services/order/StoreOrderRefundService';
import { materializeCompletedRefundOrder } from '@/services/order/RefundOrderMaterialization';
import { enqueuePresaleDeliveryIntent } from '@/services/activity/PresaleDeliveryIntent';
import { enqueueOrderPaidEvent, OrderOutboxService } from '@/services/order/OrderOutboxService';
import { recordSupplierPayment } from '@/services/supplier/SupplierFinanceService';
import { assertPresaleSupplierRefundProof } from '@/services/activity/PresaleSupplierRefundProof';
import { orderMembershipSavings } from '@/services/order/OrderMembershipSavings';
import { REFUND_ORDER_SPLIT_SQL } from '@/migrations/refundOrderSplit';
import { agentLevel, printDocument, storeCart, storeOrder, storeOrderCartInfo, storeOrderRefund,
  storeOrderStatus, storeProduct, storeOrderInvoice, storeOrderRefundPayment,
  storeOrderOutbox, orderWaybillJob, userBrokerage, supplierFlowingWater, supplierTransactions,
  storeProductVirtual, storeProductCoupon, storeOrderRefundSplit, systemSupplier, supplierExtract,
  storeProductAttrValue, user, luckLottery, luckLotteryEntitlement, storeCouponIssue, storeCouponUser,
  storeCouponIssueUser, storeOrderProductCouponReward, storeOrderEconomize, shippingTemplates, systemStore } from '@/models/schema';

// Real presale checkout, refund finalizer and materializer. Payment marking is
// explicitly synthetic, and financial/structural refund steps are separate here.
// This is not a provider/callback, atomic-v2 refund, or production LOGIN test.
describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('presale baseline against actual refund materialization', () => {
  let f: Awaited<ReturnType<typeof createPcCheckoutQuoteFixture>>, serial: number, endsAt: number;
  beforeEach(async () => {
    serial = 0;
    f = await createPcCheckoutQuoteFixture([agentLevel, printDocument, storeOrderCartInfo, storeOrderRefund, storeOrderStatus,
      storeOrderInvoice, storeOrderRefundPayment, storeOrderOutbox, orderWaybillJob, userBrokerage,
      supplierFlowingWater, supplierTransactions, storeProductVirtual, storeProductCoupon, systemSupplier, supplierExtract, luckLottery,
      luckLotteryEntitlement, storeCouponIssue, storeCouponUser, storeCouponIssueUser, storeOrderProductCouponReward, storeOrderEconomize]);
    await f.exec(REFUND_ORDER_SPLIT_SQL);
    await f.exec('CREATE UNIQUE INDEX baseline_event_key ON store_order_outbox(event_key)');
    await f.exec('CREATE UNIQUE INDEX baseline_flow_key ON supplier_flowing_water(order_id); CREATE UNIQUE INDEX baseline_transaction_key ON supplier_transactions(order_id)');
    await f.exec('CREATE UNIQUE INDEX baseline_savings_key ON store_order_economize(order_id,uid); CREATE UNIQUE INDEX baseline_lottery_key ON luck_lottery_entitlement(source_key)');
    await f.setConfig(Object.fromEntries(Object.keys(f.config).map(key => [key, '0'])));
    await f.db.update(storeCart).set({ type: 6, productType: 1, cartNum: 3 });
    await f.db.insert(storeProductVirtual).values([1, 2, 3].map(n => ({ productId: 70, attrUnique: 'qared001',
      cardNo: `BASELINE-${n}`, cardPwd: `LOCAL-ONLY-${n}` })));
    const [clock] = await f.db.execute(sql`SELECT floor(extract(epoch FROM clock_timestamp()))::integer AS now`);
    endsAt = Number(clock.now) + 10;
    await f.db.update(storeProduct).set({ productType: 1, freight: 1, isPresaleProduct: 1,
      presaleStartTime: endsAt - 3600, presaleEndTime: endsAt, presaleDay: 7, isLimit: 0 });
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('External I/O forbidden'));
  }, 30000);
  afterEach(async () => { try { expect(fetch).not.toHaveBeenCalled(); } finally { vi.restoreAllMocks(); await f?.close(); } }, 30000);
  const order = async (id: number) => (await f.db.select().from(storeOrder).where(eq(storeOrder.id, id)))[0];
  const carts = (id: number) => f.db.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid, id)).orderBy(storeOrderCartInfo.id);
  async function paid(supplier = false, multiple = false) {
    if (supplier) {
      await f.db.insert(systemSupplier).values({ id: 7, adminId: 7, supplierName: 'Local presale supplier' });
      await f.db.update(storeProduct).set({ type: 2, relationId: 7 });
      await f.db.update(storeProductAttrValue).set({ settlePrice: '2.50', cost: '2.00' });
      await f.db.update(shippingTemplates).set({ ownerType: 2, relationId: 7 }).where(eq(shippingTemplates.id, 10));
    }
    if (multiple) {
      await f.db.insert(systemSupplier).values({ id: 8, adminId: 8, supplierName: 'Local second supplier' });
      const [product] = await f.db.select().from(storeProduct), [sku] = await f.db.select().from(storeProductAttrValue);
      await f.db.insert(storeProduct).values({ ...product, id: 71, relationId: 8 });
      await f.db.insert(storeProductAttrValue).values({ ...sku, id: 2, productId: 71, unique: 'qablue02' });
      await f.db.insert(storeCart).values({ id: 2, uid: 11, productId: 71, productAttrUnique: 'qablue02',
        cartNum: 1, type: 6, productType: 1, isNew: 1, status: 1 });
    }
    const [product] = await f.db.select().from(storeProduct).where(eq(storeProduct.id, 70));
    if (product.productType === 4) await f.db.update(systemStore).set({ isStore: 1 }).where(eq(systemStore.id, 1));
    const created = await StoreOrderCreateService.createWithRuntime(f.container,
      { CONFIG_KV: f.env.CONFIG_KV, nextOrderId: async () => 'baseline_presale_checkout' },
      { uid: 11, key: 'baseline-presale', type: 6, cartIds: multiple ? [1, 2] : [1], addressId: 11, userIp: '127.0.0.1', useIntegral: false,
        ...(product.productType === 4 ? { shippingType: 2, storeId: 1, realName: 'Local pickup fixture', userPhone: '13800000000' } : {}) });
    const [marked] = await f.db.update(storeOrder).set({ paid: 1, payType: 'yue', payTime: endsAt - 10 })
      .where(eq(storeOrder.orderId, created.orderId)).returning();
    const allocated = await withTx(f.container, async tx => {
      const allocation = await allocatePaidOrderBySupplier(tx, marked.id, marked.orderId);
      // Explicit pre-existing supplier accounting, not a completed paid outbox.
      if (supplier) for (const child of allocation.fulfillmentOrders) await recordSupplierPayment(tx, child, endsAt - 10);
      return allocation;
    });
    expect(allocated.fulfillmentOrders).toHaveLength(multiple ? 2 : 1);
    expect(JSON.parse((await carts(marked.id))[0].cartInfo!).presale.endsAt).toBe(endsAt);
    return marked.id;
  }
  async function refund(id: number, quantity: number) {
    const current = await order(id), [cart] = await carts(id);
    const application = await applyOrderRefund(f.container, { uid: 11, orderId: current.orderId, applyType: 1,
      applicationOrderId: `baseline_refund_${++serial}`, refundReason: 'Local baseline', refundExplain: '',
      cartSelections: [{ cartId: Number(cart.cartId), cartNum: quantity }] });
    expect(await finalizeStoreOrderRefund(f.container, application.refundId)).toBe('completed');
    const [completed] = await f.db.select().from(storeOrderRefund).where(eq(storeOrderRefund.id, application.refundId));
    return withTx(f.container, tx => materializeCompletedRefundOrder(tx, completed, Math.floor(Date.now() / 1000)));
  }
  async function enqueue(id: number, rootId: number) {
    const current = await order(id);
    const created = await withTx(f.container, tx => enqueuePresaleDeliveryIntent(tx, { id, orderId: current.orderId }, rootId));
    expect(created.intent).toMatchObject({ version: 'presale-virtual-delivery-v2', dueAt: endsAt });
    return { action: 'processPresaleDeliveryOutbox' as const, outboxId: created.id, eventKey: created.eventKey };
  }
  const queue = {
    async metrics() { throw Error('Unexpected Queue I/O'); },
    async send() { throw Error('Unexpected Queue I/O'); },
    async sendBatch() { throw Error('Unexpected Queue I/O'); },
  } satisfies Queue<OrderMessage>;
  async function waitUntilDue() {
    // The database clock is authoritative; host wall-clock corrections must
    // not shorten the bounded real-time test wait.
    const deadline = performance.now() + 15000;
    while (performance.now() < deadline) {
      const [clock] = await f.db.execute(sql`SELECT clock_timestamp() >= to_timestamp(${endsAt}) AS ready`);
      if (clock.ready === true) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw Error('Owned PostgreSQL presale clock did not reach the deadline');
  }
  it.each(['partial-after', 'whole-after', 'two-before'])('uses actual refund receipts before and after capture: %s', async scenario => {
    const rootId = await paid(), first = await refund(rootId, 1);
    expect(first.remainingOrderId).not.toBeNull();
    const id = first.remainingOrderId!, whole = scenario === 'whole-after';
    if (scenario === 'two-before') await refund(id, 1);
    const message = await enqueue(id, rootId), service = new OrderOutboxService(f.container, { ORDER_QUEUE: queue });
    expect(await service.processMessage(message)).toBe('deferred');
    if (scenario !== 'two-before') {
      const second = await refund(id, whole ? 2 : 1);
      expect(second.remainingOrderId).toBe(whole ? null : id);
    }
    const before = await f.snapshot(), receipts = await f.db.select().from(storeOrderRefundSplit).orderBy(storeOrderRefundSplit.refundId);
    expect(receipts).toHaveLength(2);
    await waitUntilDue();
    expect(await service.processMessage(message)).toBe('completed');
    expect((await f.db.select().from(storeProductVirtual)).filter(card => card.uid === 11)).toHaveLength(whole ? 0 : 1);
    const after = await f.snapshot();
    for (const key of ['users', 'bills', 'products', 'skus'] as const) expect(after[key]).toEqual(before[key]);
    expect(await f.db.select().from(storeOrderRefundSplit).orderBy(storeOrderRefundSplit.refundId)).toEqual(receipts);
    expect(await service.processMessage(message)).toBe('already-completed');
  }, 30000);
  const finance = async () => ({ flows: await f.db.select().from(supplierFlowingWater).orderBy(supplierFlowingWater.id),
    transactions: await f.db.select().from(supplierTransactions).orderBy(supplierTransactions.id), ...await f.snapshot() });
  async function paymentMessage(id: number) {
    const current = await order(id);
    const event = await withTx(f.container, tx => enqueueOrderPaidEvent(tx, current));
    return { action: 'processOrderPaidOutbox' as const, outboxId: event.id, eventKey: event.eventKey };
  }
  const benefits = async () => ({ savings: await f.db.select().from(storeOrderEconomize),
    rewards: await f.db.select().from(storeOrderProductCouponReward), coupons: await f.db.select().from(storeCouponUser),
    issues: await f.db.select().from(storeCouponIssue), grants: await f.db.select().from(storeCouponIssueUser),
    lottery: await f.db.select().from(luckLotteryEntitlement) });
  const delivery = async () => ({ carts: await f.db.select().from(storeOrderCartInfo).orderBy(storeOrderCartInfo.id),
    cards: await f.db.select().from(storeProductVirtual).orderBy(storeProductVirtual.id),
    logs: await f.db.select().from(storeOrderStatus).orderBy(storeOrderStatus.id) });
  async function enableBenefits() {
    await f.setConfig({ member_card_status: '1', svip_price_status: '1' });
    await f.db.insert(storeCouponIssue).values({ id: 1, title: 'Local paid gift', couponPrice: '1.00', totalCount: 10, remainCount: 10, day: 7 });
    await f.db.insert(storeProductCoupon).values({ productId: 70, issueCouponId: 1 });
    await f.db.insert(luckLottery).values({ factor: 3, factorNum: 2, endTime: 2147483647 });
  }
  it.each([false, true].flatMap(supplier => ['partial', 'two-partial', 'whole', 'partial-whole'].map(scenario => ({ supplier, scenario }))))(
    'recovers the real paid outbox after refunds without repeating income: $supplier / $scenario', async ({ supplier, scenario }) => {
      const rootId = await paid(supplier), message = await paymentMessage(rootId);
      const first = await refund(rootId, scenario === 'whole' ? 3 : 1);
      if (scenario === 'two-partial' || scenario === 'partial-whole') await refund(first.remainingOrderId!, scenario === 'two-partial' ? 1 : 2);
      const before = await finance(), service = new OrderOutboxService(f.container, { ORDER_QUEUE: queue });
      expect(await service.processMessage(message)).toBe('completed');
      const after = await finance();
      expect(after.flows).toEqual(before.flows); expect(after.transactions).toEqual(before.transactions);
      expect(after.orders).toEqual(before.orders); expect(after.bills).toEqual(before.bills);
      expect(after.products).toEqual(before.products); expect(after.skus).toEqual(before.skus);
      expect(after.users).toEqual(before.users.map(row => ({ ...row, payCount: row.payCount + 1 })));
      expect((await f.db.select().from(storeOrderStatus)).filter(row => row.changeType === 'pay_success')).toHaveLength(1);
      expect((await f.db.select().from(storeProductVirtual)).filter(card => card.uid === 11)).toHaveLength(0);
      const intents = (await f.db.select().from(storeOrderOutbox)).filter(event => event.eventType === 'order.presale.fulfillment');
      const remaining = scenario === 'partial' ? 2 : scenario === 'two-partial' ? 1 : 0;
      expect(intents).toHaveLength(remaining ? 1 : 0);
      if (remaining) {
        expect(intents[0].aggregateId).toBe(first.remainingOrderId);
        const due = { action: 'processPresaleDeliveryOutbox' as const, outboxId: intents[0].id, eventKey: intents[0].eventKey };
        expect(await service.processMessage(due)).toBe('deferred');
        await waitUntilDue();
        expect(await service.processMessage(due)).toBe('completed');
        expect((await f.db.select().from(storeProductVirtual)).filter(card => card.uid === 11)).toHaveLength(remaining);
        expect(await service.processMessage(due)).toBe('already-completed');
      }
      const once = await finance();
      expect(await service.processMessage(message)).toBe('already-completed');
      expect(await finance()).toEqual(once);
    }, 30000);
  it.each(['quantity', 'contract', 'marker', 'missing-cart', 'child-scope', 'extra-child', 'counter', 'late-payment'])(
    'rolls back the entire paid transaction for damaged recovery evidence: %s', async fault => {
      const rootId = await paid(true), message = await paymentMessage(rootId), first = await refund(rootId, 1);
      const selected = await order(first.selectedOrderId), [cart] = await carts(selected.id);
      if (fault === 'quantity') await f.db.update(storeOrderCartInfo).set({ cartNum: 2 }).where(eq(storeOrderCartInfo.id, cart.id));
      if (fault === 'contract' || fault === 'marker') {
        const info = JSON.parse(cart.cartInfo!);
        if (fault === 'contract') info.presale.endsAt += 1; else delete info.refund_order_generation;
        await f.db.update(storeOrderCartInfo).set({ cartInfo: JSON.stringify(info) }).where(eq(storeOrderCartInfo.id, cart.id));
      }
      if (fault === 'missing-cart') await f.db.delete(storeOrderCartInfo).where(eq(storeOrderCartInfo.id, cart.id));
      if (fault === 'child-scope') await f.db.update(storeOrder).set({ uid: 12 }).where(eq(storeOrder.id, selected.id));
      if (fault === 'extra-child') await f.db.insert(storeOrder).values({ ...selected, id: undefined, orderId: 'unexplained-test-child' });
      if (fault === 'counter') await f.db.update(storeOrderCartInfo).set({ refundNum: 0 }).where(eq(storeOrderCartInfo.id, cart.id));
      if (fault === 'late-payment') await withTx(f.container, async tx => recordSupplierPayment(tx, await order(first.remainingOrderId!), endsAt));
      const before = { finance: await finance(), delivery: await delivery(), benefits: await benefits() };
      await expect(new OrderOutboxService(f.container, { ORDER_QUEUE: queue }).processMessage(message)).rejects.toThrow();
      expect({ finance: await finance(), delivery: await delivery(), benefits: await benefits() }).toEqual(before);
      expect(await f.db.select().from(storeOrderOutbox)).toEqual([expect.objectContaining({ id: message.outboxId, status: 'FAILED' })]);
    }, 30000);
  it.each([0, 2, 3, 4].flatMap(productType => [false, true].map(whole => ({ productType, whole }))))(
    'keeps non-secret presale paid effects separate from fulfillment: $productType / $whole', async ({ productType, whole }) => {
      await f.db.update(storeProduct).set({ productType }); await f.db.update(storeCart).set({ productType });
      if (productType === 4) await f.db.update(storeProductAttrValue).set({ writeValid: 2, writeDays: 7, writeTimes: 5 });
      const rootId = await paid(true), message = await paymentMessage(rootId), first = await refund(rootId, whole ? 3 : 1);
      const before = await finance(), service = new OrderOutboxService(f.container, { ORDER_QUEUE: queue });
      expect(await service.processMessage(message)).toBe('completed');
      const after = await finance();
      expect(after.orders).toEqual(before.orders); expect(after.flows).toEqual(before.flows); expect(after.transactions).toEqual(before.transactions);
      expect(await f.db.select().from(storeOrderOutbox)).toEqual([expect.objectContaining({ status: 'COMPLETED', eventType: 'order.paid' })]);
      expect(after.users[0].payCount).toBe(before.users[0].payCount + 1);
      if (productType === 4) for (const id of [first.selectedOrderId, ...(first.remainingOrderId ? [first.remainingOrderId] : [])]) {
        expect(await carts(id)).toEqual([expect.objectContaining({ writeStart: (await order(rootId)).payTime,
          writeEnd: (await order(rootId)).payTime + 7 * 86400 })]);
      }
      expect(await service.processMessage(message)).toBe('already-completed');
      expect(await finance()).toEqual(after);
    }, 30000);
  it('preserves the real presale checkout prohibition on multiple products', async () => {
    await expect(paid(true, true)).rejects.toThrow('活动订单一次只能购买一种商品');
    expect(await f.db.select().from(storeOrder)).toEqual([]);
    expect(await f.db.select().from(storeOrderOutbox)).toEqual([]);
    expect(await f.db.select().from(supplierFlowingWater)).toEqual([]);
    expect(await f.db.select().from(supplierTransactions)).toEqual([]);
  });
  it.each([false, true])('keeps frozen supplier ownership after the merchant is disabled: whole=%s', async whole => {
    const rootId = await paid(true), message = await paymentMessage(rootId);
    await refund(rootId, whole ? 3 : 1);
    // Frozen allocation remains authoritative after live merchant configuration changes.
    await f.db.update(systemSupplier).set({ isShow: 0, isDel: 1 }).where(eq(systemSupplier.id, 7));
    const before = await finance(), service = new OrderOutboxService(f.container, { ORDER_QUEUE: queue });
    expect(await service.processMessage(message)).toBe('completed');
    expect((await finance()).flows).toEqual(before.flows); expect((await finance()).transactions).toEqual(before.transactions);
    expect((await f.db.select().from(storeOrderOutbox)).filter(event => event.eventType === 'order.presale.fulfillment')).toHaveLength(whole ? 0 : 1);
    expect((await delivery()).cards.every(card => card.uid === 0)).toBe(true);
    expect(await service.processMessage(message)).toBe('already-completed');
  }, 30000);
  it('retries the actual paid transaction after independently-held locks without partial effects', async () => {
    const rootId = await paid(true), message = await paymentMessage(rootId); await refund(rootId, 1);
    const before = { finance: await finance(), delivery: await delivery(), benefits: await benefits() };
    const flowId = before.finance.flows[0].id, cartId = before.delivery.carts[0].id;
    const [receipt] = await f.db.select().from(storeOrderRefundSplit);
    await withFinancePeers(f.db, async ([one, two]) => {
      for (const held of ['root', 'cart', 'buyer', 'refund', 'ledger', 'supplier']) {
        await withTx(createContainerFromDb(one.db), async tx => {
          if (held === 'root') await tx.select().from(storeOrder).where(eq(storeOrder.id, rootId)).for('update');
          if (held === 'cart') await tx.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.id, cartId)).for('update');
          if (held === 'buyer') await tx.select().from(user).where(eq(user.uid, 11)).for('update');
          if (held === 'refund') await tx.select().from(storeOrderRefund).where(eq(storeOrderRefund.id, receipt.refundId)).for('update');
          if (held === 'ledger') await tx.select().from(supplierFlowingWater).where(eq(supplierFlowingWater.id, flowId)).for('update');
          if (held === 'supplier') await tx.execute(sql`SELECT pg_advisory_xact_lock(7::bigint)`);
          await expect(new OrderOutboxService(createContainerFromDb(two.db), { ORDER_QUEUE: queue }).processMessage(message)).rejects.toThrow();
        });
        expect({ finance: await finance(), delivery: await delivery(), benefits: await benefits() }).toEqual(before);
        expect(await f.db.select().from(storeOrderOutbox)).toEqual([expect.objectContaining({ id: message.outboxId, status: 'FAILED' })]);
      }
    });
    expect(await new OrderOutboxService(f.container, { ORDER_QUEUE: queue }).processMessage(message)).toBe('completed');
    expect((await finance()).users[0].payCount).toBe(before.finance.users[0].payCount + 1);
  }, 30000);
  it.each([false, true])('atomically retains original membership/gift/lottery paid facts after refund (whole=%s)', async whole => {
    await enableBenefits();
    const rootId = await paid(true), root = await order(rootId), originalSavings = orderMembershipSavings(root, await carts(rootId));
    expect(originalSavings?.eligible).toBe(true);
    const message = await paymentMessage(rootId); await refund(rootId, whole ? 3 : 1);
    const before = { finance: await finance(), delivery: await delivery(), benefits: await benefits() };
    // Fail the LAST write, after all paid effects and financial proof succeeded.
    await f.exec("ALTER TABLE store_order_outbox ADD CONSTRAINT test_recovery_completion CHECK (status <> 'COMPLETED')");
    const service = new OrderOutboxService(f.container, { ORDER_QUEUE: queue });
    try { await expect(service.processMessage(message)).rejects.toThrow(); }
    finally { await f.exec('ALTER TABLE store_order_outbox DROP CONSTRAINT test_recovery_completion'); }
    expect({ finance: await finance(), delivery: await delivery(), benefits: await benefits() }).toEqual(before);
    expect(await f.db.select().from(storeOrderOutbox)).toEqual([expect.objectContaining({ id: message.outboxId, status: 'FAILED' })]);
    expect(await service.processMessage(message)).toBe('completed');
    const after = await benefits();
    expect(after.savings).toEqual([expect.objectContaining({ orderId: root.orderId, payPrice: root.payPrice,
      memberPrice: originalSavings!.memberPrice, postagePrice: originalSavings!.postagePrice, couponPrice: originalSavings!.couponPrice })]);
    expect(after.rewards).toEqual([expect.objectContaining({ orderId: rootId, uid: 11, productId: 70, issueCouponId: 1 })]);
    expect(after.coupons).toHaveLength(1); expect(after.grants).toHaveLength(1); expect(after.issues[0].remainCount).toBe(9);
    expect(after.lottery).toEqual([expect.objectContaining({ sourceKey: `order:${rootId}`, amount: 2, remaining: 2 })]);
    expect((await finance()).flows).toEqual(before.finance.flows);
    expect((await finance()).transactions).toEqual(before.finance.transactions);
    expect((await delivery()).cards).toEqual(before.delivery.cards);
    expect(await service.processMessage(message)).toBe('already-completed');
    expect(await benefits()).toEqual(after);
  }, 30000);
  it.each(['partial', 'two-partial', 'whole', 'partial-whole'])('proves actual supplier refund lineage without another payment: %s', async scenario => {
    const rootId = await paid(true), first = await refund(rootId, scenario === 'whole' ? 3 : 1);
    if (scenario === 'two-partial' || scenario === 'partial-whole') await refund(first.remainingOrderId!, scenario === 'two-partial' ? 1 : 2);
    const before = await finance();
    const proof = await withTx(f.container, tx => assertPresaleSupplierRefundProof(tx, rootId));
    expect(proof.refundIds.size).toBe(scenario === 'two-partial' || scenario === 'partial-whole' ? 2 : 1);
    expect(proof.coveredOrderIds.has(rootId)).toBe(true);
    expect(await finance()).toEqual(before);
    const active = before.flows.filter(flow => flow.status >= 0 && flow.pm === 1);
    expect(active.reduce((sum, flow) => sum + Number(flow.number), 0)).toBe(7.5);
    const baselineIncome = before.flows.find(flow => flow.orderId.startsWith('P'))!;
    const target = active[0];
    // The receipt table remains protected by the real append-only trigger.
    // Corrupt only test-owned live rows inside transactions which MUST roll back.
    for (const fault of ['amount', 'uid', 'missing-flow', 'missing-payment', 'extra-flow', 'lineage', 'finish-time', 'order-price',
      ...(scenario === 'whole' ? [] : ['late-payment'])]) {
      await expect(withTx(f.container, async tx => {
        if (fault === 'amount') await tx.update(supplierFlowingWater).set({ number: '0.01' }).where(eq(supplierFlowingWater.id, target.id));
        if (fault === 'uid') await tx.update(supplierFlowingWater).set({ uid: 12 }).where(eq(supplierFlowingWater.id, target.id));
        if (fault === 'missing-flow') await tx.delete(supplierFlowingWater).where(eq(supplierFlowingWater.id, target.id));
        if (fault === 'missing-payment') await tx.delete(supplierTransactions).where(eq(supplierTransactions.orderId, baselineIncome.orderId));
        if (fault === 'extra-flow') await tx.insert(supplierFlowingWater).values({ ...target, id: undefined, orderId: `EXTRA-${target.id}` });
        if (fault === 'lineage') await tx.update(supplierFlowingWater).set({ remark: '{}' }).where(eq(supplierFlowingWater.id, target.id));
        if (fault === 'finish-time') await tx.update(supplierFlowingWater).set({ finishTime: 0 }).where(eq(supplierFlowingWater.id, target.id));
        if (fault === 'order-price') await tx.update(storeOrder).set({ payPrice: '0.01' }).where(eq(storeOrder.orderId, target.linkId));
        if (fault === 'late-payment') {
          const linkedOrder = before.orders.find(order => order.orderId === target.linkId)!;
          await recordSupplierPayment(tx, linkedOrder, endsAt);
        }
        await assertPresaleSupplierRefundProof(tx, rootId);
      })).rejects.toThrow();
      expect(await finance()).toEqual(before);
    }
  }, 30000);
  it('keeps proof reads bounded under root, buyer, ledger and supplier contention', async () => {
    const rootId = await paid(true); await refund(rootId, 1);
    const before = await finance(), flowId = before.flows[0].id;
    await expect(assertPresaleSupplierRefundProof(f.db, rootId)).rejects.toThrow();
    await withFinancePeers(f.db, async ([one, two]) => {
      for (const held of ['root', 'buyer', 'ledger', 'supplier']) {
        await withTx(createContainerFromDb(one.db), async tx => {
          if (held === 'root') await tx.select().from(storeOrder).where(eq(storeOrder.id, rootId)).for('update');
          if (held === 'buyer') await tx.select().from(user).where(eq(user.uid, 11)).for('update');
          if (held === 'ledger') await tx.select().from(supplierFlowingWater).where(eq(supplierFlowingWater.id, flowId)).for('update');
          if (held === 'supplier') await tx.execute(sql`SELECT pg_advisory_xact_lock(7::bigint)`);
          await expect(withTx(createContainerFromDb(two.db), tx => assertPresaleSupplierRefundProof(tx, rootId))).rejects.toThrow();
        });
        expect(await finance()).toEqual(before);
        await withTx(f.container, tx => assertPresaleSupplierRefundProof(tx, rootId));
      }
    });
    expect(await finance()).toEqual(before);
  }, 30000);
});
