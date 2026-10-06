import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core';
import { createPcCheckoutQuoteFixture } from './helpers/pcCheckoutQuoteFixture';
import { withFinancePeers, waitForFinanceBlock, waitForFinanceClock, outcome, type FinancePeer } from './helpers/financePeers';
import { createContainerFromDb, type Container, type DbClient } from '../src/lib/di';
import type { OrderMessage } from '../src/env';
import { StoreOrderCreateService } from '../src/services/order/StoreOrderCreateService';
import { applyStoreOrderBalancePayment, applyStoreOrderPayment } from '../src/services/order/StoreOrderPayService';
import { applyOrderRefund, ensureAutomaticOrderRefund, finalizeStoreOrderRefund } from '../src/services/order/StoreOrderRefundService';
import { PinkTimeoutService } from '../src/services/activity/PinkTimeoutService';
import { ScheduledMaintenanceService, createScheduledRunMessages } from '../src/services/order/ScheduledMaintenanceService';
import { WechatPayService } from '../src/services/wechat/WechatPayService';
import { storeCombination, storePink, storeOrder, storeOrderCartInfo, storeOrderRefund, storeOrderRefundPayment,
  storeOrderInvoice, storeOrderOutbox, storeOrderStatus, storeCart, storeProduct, storeProductAttrValue,
  user, userBrokerage, printDocument, systemStore } from '../src/models/schema';

// Actual order creation, balance ledger, paid activation, timeout and refund SQL.
// The finite model-column fixture installs the real outbox CHECK and uniqueness.
// Only explicit WeChat transport results are substituted; there is no provider,
// host binding, runtime grant fallback, mocked transaction or fabricated paid row.
describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('virtual pink completion and late charged payment on PG16', () => {
  let f: Awaited<ReturnType<typeof createPcCheckoutQuoteFixture>>;
  let leaderOrder: typeof storeOrder.$inferSelect;
  let memberOrder: typeof storeOrder.$inferSelect;
  const noticeType = 'order.pink.success.notice';
  const create = async (uid: number, cartId: number, pinkId = 0, container: Container = f.container) => {
    await StoreOrderCreateService.createWithRuntime(container,
      { CONFIG_KV: f.env.CONFIG_KV, nextOrderId: async () => `virtual-pink-${cartId}` },
      { uid, key: `virtual-pink-key-${cartId}`, cartIds: [cartId], type: 3, combinationId: 30, pinkId,
        shippingType: 2, storeId: 1, realName: '隔离拼团', userPhone: '00000000000', userIp: '127.0.0.1' });
    return (await container.db.select().from(storeOrder).where(eq(storeOrder.orderId, `virtual-pink-${cartId}`)))[0];
  };
  const readOrder = async (id: number) => (await f.db.select().from(storeOrder).where(eq(storeOrder.id, id)))[0];
  const expire = (id = leaderOrder.pinkId, peer?: FinancePeer, now?: number) => new PinkTimeoutService(
    peer ? createContainerFromDb(peer.db) : f.container, f.env).expireGroup(id, now);
  const age = () => f.db.update(storePink).set({ stopTime: new Date(0) }).where(eq(storePink.id, leaderOrder.pinkId));
  const notices = () => f.db.select().from(storeOrderOutbox).where(eq(storeOrderOutbox.eventType, noticeType)).orderBy(storeOrderOutbox.id);
  const pinks = () => f.db.select().from(storePink).orderBy(storePink.id);
  const financial = async () => ({ ...(await f.snapshot()),
    combinations: await f.db.select().from(storeCombination).orderBy(storeCombination.id),
    details: await f.db.select().from(storeOrderCartInfo).orderBy(storeOrderCartInfo.id),
    refunds: await f.db.select().from(storeOrderRefund).orderBy(storeOrderRefund.id),
    refundPayments: await f.db.select().from(storeOrderRefundPayment).orderBy(storeOrderRefundPayment.id),
    statuses: await f.db.select().from(storeOrderStatus).orderBy(storeOrderStatus.id),
  });
  beforeEach(async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('External network prohibited in isolated fixture'));
    try {
    f = await createPcCheckoutQuoteFixture([storeCombination, storePink, storeOrderCartInfo, storeOrderRefund,
      storeOrderRefundPayment, storeOrderInvoice, storeOrderOutbox, storeOrderStatus, userBrokerage, printDocument]);
    const dialect = new PgDialect();
    for (const check of getTableConfig(storeOrderOutbox).checks) {
      await f.exec(`ALTER TABLE store_order_outbox ADD CONSTRAINT "${check.name}" CHECK (${dialect.sqlToQuery(check.value).sql})`);
    }
    await f.exec('CREATE UNIQUE INDEX fixture_virtual_pink_event ON store_order_outbox(event_key)');
    await f.setConfig(Object.fromEntries(Object.keys(f.config).map(key => [key, '0'])));
    // This positive checkout fixture disables discounts, while SQL pickup authority remains enabled.
    await f.setConfig({ store_func_status: '1', store_self_mention: '1' });
    await f.db.update(systemStore).set({ isStore: 1 });
    await f.db.update(user).set({ nowMoney: '100.00' });
    await f.db.insert(user).values([22, 33].map(uid => ({ uid, nickname: `真实团员${uid}`, nowMoney: '100.00' })));
    await f.db.update(storeProduct).set({ stock: 100 }).where(eq(storeProduct.id, 70));
    await f.db.update(storeProductAttrValue).set({ stock: 100 }).where(eq(storeProductAttrValue.id, 1));
    await f.db.update(storeCart).set({ type: 3, activityId: 30, cartNum: 1 });
    await f.db.insert(storeCart).values([2, 3].map(id => ({ id, uid: id * 11, productId: 70,
      productAttrUnique: 'qared001', cartNum: 1, type: 3, activityId: 30, isNew: 1, status: 1 })));
    await f.db.insert(storeCombination).values({ id: 30, productId: 70, people: 3, effectiveTime: 24, virtual: 66,
      stock: 100, quota: 100, quotaShow: 100, onceNum: 3, num: 100, price: '6.25' });
    await f.db.insert(storeProductAttrValue).values({ id: 2, productId: 30, type: 3, unique: 'virtred1',
      suk: '红色,大号', stock: 100, quota: 100, price: '6.25' });
    const leader = await create(11, 1);
    await applyStoreOrderBalancePayment(f.container, { uid: 11, orderId: leader.orderId });
    leaderOrder = await readOrder(leader.id);
    const member = await create(22, 2, leaderOrder.pinkId);
    await applyStoreOrderBalancePayment(f.container, { uid: 22, orderId: member.orderId });
    memberOrder = await readOrder(member.id);
    } catch (error) {
      try { await f?.close(); } finally { throw error; }
    }
  }, 30_000);
  afterEach(async () => {
    try { expect(globalThis.fetch).not.toHaveBeenCalled(); }
    finally { vi.restoreAllMocks(); await f?.close(); }
  });

  it.each([[1, true], [50, true], [66, true], [67, false], [100, false], [0, false], [-1, false], [101, false]] as const)(
    'uses exact truncated 2/3 threshold at virtual=%s (success=%s)', async (virtual, success) => {
      await f.db.update(storeCombination).set({ virtual }); await age();
      const before = await financial();
      const result = await expire();
      if (success) {
        expect(result).toMatchObject({ completed: true, expired: false, orders: 0 });
        expect(await financial()).toEqual(before);
        const rows = await pinks();
        expect(rows).toHaveLength(3);
        expect(rows.every(row => row.status === 2)).toBe(true);
        expect(rows.find(row => row.kId === 0)).toMatchObject({ memberCount: 3 });
        expect(rows.find(row => row.isVirtual === 1)).toMatchObject({ uid: 0, orderId: '0', orderIdKey: '0',
          totalNum: 0, totalPrice: '0.00', price: '0.00', isTpl: 1, isRefund: 0, kId: leaderOrder.pinkId });
        expect((await notices()).map(row => row.eventKey).sort()).toEqual([leaderOrder.id, memberOrder.id].map(id => `${noticeType}:${id}`).sort());
        const committed = { pinks: await pinks(), notices: await notices(), financial: await financial() };
        expect(await expire()).toMatchObject({ expired: false, orders: 0 });
        expect({ pinks: await pinks(), notices: await notices(), financial: await financial() }).toEqual(committed);
      } else {
        expect(result).toMatchObject({ expired: true, completedRefunds: 2, pendingRefunds: 0 });
        expect((await pinks()).some(row => row.isVirtual === 1)).toBe(false);
        expect(await notices()).toHaveLength(0);
        expect((await f.snapshot()).users.map(row => row.nowMoney)).toEqual(['100.00', '100.00', '100.00']);
        expect((await f.snapshot()).bills.filter(row => row.type === 'pay_product_refund')).toHaveLength(2);
      }
    });
  it('allows 100 only when a legacy active group already has every real paid participant', async () => {
    await f.db.update(storeCombination).set({ virtual: 100, people: 2 });
    await f.db.update(storePink).set({ people: 2 }); await age();
    const before = await financial();
    expect(await expire()).toMatchObject({ completed: true });
    expect(await pinks()).toHaveLength(2); expect(await notices()).toHaveLength(2);
    expect(await financial()).toEqual(before);
  });
  it('commits ordinary immediate real completion and one durable notice per real order', async () => {
    const pending = await create(33, 3, leaderOrder.pinkId);
    expect(await applyStoreOrderBalancePayment(f.container, { uid: 33, orderId: pending.orderId })).toMatchObject({ outcome: 'paid' });
    expect((await pinks()).every(row => row.status === 2 && row.isVirtual === 0)).toBe(true);
    expect(await notices()).toHaveLength(3);
    const before = { financial: await financial(), pinks: await pinks(), notices: await notices() };
    expect(await applyStoreOrderBalancePayment(f.container, { uid: 33, orderId: pending.orderId })).toMatchObject({ outcome: 'already-paid' });
    expect(await expire()).toMatchObject({ expired: false });
    expect({ financial: await financial(), pinks: await pinks(), notices: await notices() }).toEqual(before);
  });
  it('does not count or charge an unpaid reserved position', async () => {
    const pending = await create(33, 3, leaderOrder.pinkId);
    await f.db.update(storeCombination).set({ virtual: 67 }); await age();
    expect(await expire()).toMatchObject({ expired: true, orders: 2, completedRefunds: 2 });
    expect(await readOrder(pending.id)).toMatchObject({ paid: 0, refundStatus: 0 });
    expect((await f.db.select().from(user).where(eq(user.uid, 33)))[0].nowMoney).toBe('100.00');
    expect(await notices()).toHaveLength(0);
  });
  it('excludes a genuinely fully refunded member and never revives it', async () => {
    const { refundId } = await ensureAutomaticOrderRefund(f.container, { uid: 22, orderId: memberOrder.orderId, applyType: 1, refundReason: 'Local member refund', refundExplain: '' });
    expect(await finalizeStoreOrderRefund(f.container, refundId)).toBe('completed'); await age();
    expect(await expire()).toMatchObject({ expired: true, completedRefunds: 2 });
    expect((await pinks()).find(row => row.uid === 22)).toMatchObject({ status: 3, isVirtual: 0, isRefund: leaderOrder.pinkId });
    expect((await f.snapshot()).bills.filter(row => row.type === 'pay_product_refund')).toHaveLength(2);
    expect(await notices()).toHaveLength(0);
  });
  it('does not override a genuinely accepted but unexecuted refund intent', async () => {
    await ensureAutomaticOrderRefund(f.container, { uid: 11, orderId: leaderOrder.orderId, applyType: 1, refundReason: 'Accepted refund before deadline', refundExplain: '' });
    await age();
    expect(await expire()).toMatchObject({ expired: true, completedRefunds: 2 });
    expect(await notices()).toHaveLength(0);
    expect((await pinks()).some(row => row.isVirtual === 1)).toBe(false);
  });
  it.each(['key', 'number', 'product', 'uid', 'mixed-status', 'oversize'] as const)('rejects inconsistent active paid identity/configuration: %s', async fault => {
    const member = (await pinks()).find(row => row.uid === 22)!;
    if (fault === 'key') await f.db.update(storePink).set({ orderIdKey: String(leaderOrder.id) }).where(eq(storePink.id, member.id));
    if (fault === 'number') await f.db.update(storePink).set({ orderId: leaderOrder.orderId }).where(eq(storePink.id, member.id));
    if (fault === 'product') await f.db.update(storePink).set({ productId: 71 }).where(eq(storePink.id, member.id));
    if (fault === 'uid') await f.db.update(storePink).set({ uid: 11 }).where(eq(storePink.id, member.id));
    if (fault === 'mixed-status') await f.db.update(storePink).set({ status: 2 }).where(eq(storePink.id, member.id));
    if (fault === 'oversize') { await f.db.update(storePink).set({ people: 501 }); await f.db.update(storeCombination).set({ people: 501, virtual: 1 }); }
    await age();
    expect(await expire()).toMatchObject({ expired: true, completedRefunds: 2 });
    expect(await notices()).toHaveLength(0); expect((await pinks()).some(row => row.isVirtual === 1)).toBe(false);
  });
  it('fills a bounded 500-person group only after five actual paid members reach the 1 percent threshold', async () => {
    await f.db.update(storeCombination).set({ people: 500, virtual: 1 });
    await f.db.update(storePink).set({ people: 500 });
    await f.db.insert(user).values([44, 55].map(uid => ({ uid, nowMoney: '100.00' })));
    await f.db.insert(storeCart).values([4, 5].map(id => ({ id, uid: id * 11, productId: 70,
      productAttrUnique: 'qared001', cartNum: 1, type: 3, activityId: 30, isNew: 1, status: 1 })));
    for (const id of [3, 4, 5]) {
      const order = await create(id * 11, id, leaderOrder.pinkId);
      expect(await applyStoreOrderBalancePayment(f.container, { uid: id * 11, orderId: order.orderId })).toMatchObject({ outcome: 'paid' });
    }
    await age(); const before = await financial();
    expect(await expire()).toMatchObject({ completed: true });
    const rows = await pinks(); expect(rows).toHaveLength(500);
    expect(rows.filter(row => row.isVirtual === 1)).toHaveLength(495); expect(await notices()).toHaveLength(5);
    expect(await financial()).toEqual(before);
  });
  it('does not count a pre-existing zero-UID virtual row as a paid participant', async () => {
    await f.db.insert(storePink).values({ uid: 0, kId: leaderOrder.pinkId, combinationId: 30, productId: 70, people: 3, isVirtual: 1 });
    await f.db.update(storeCombination).set({ virtual: 100 }); await age();
    expect(await expire()).toMatchObject({ expired: true, orders: 2, completedRefunds: 2 });
    expect(await notices()).toHaveLength(0);
    expect((await f.db.select().from(storeOrder)).every(row => row.uid > 0)).toBe(true);
    expect((await f.snapshot()).bills.every(row => row.uid > 0)).toBe(true);
  });
  it('does not turn a previously failed group into success after its threshold changes', async () => {
    await f.db.update(storePink).set({ status: 3, stopTime: new Date(0) });
    await f.db.update(storeCombination).set({ virtual: 1 });
    expect(await expire()).toMatchObject({ expired: true, completedRefunds: 2 });
    expect(await notices()).toHaveLength(0); expect((await pinks()).every(row => row.status === 3)).toBe(true);
    const before = await financial(); await expire(); expect(await financial()).toEqual(before);
  });
  it('keeps paid successful status 2 protected and preserves orphan cleanup', async () => {
    await f.db.update(storePink).set({ status: 2, stopTime: new Date(0) });
    const before = { financial: await financial(), pinks: await pinks() };
    expect(await expire()).toMatchObject({ expired: false });
    expect({ financial: await financial(), pinks: await pinks() }).toEqual(before);
    await f.db.insert(storePink).values({ combinationId: 30, productId: 70, people: 3, status: 2 });
    const orphan = (await pinks()).find(row => row.uid === 0)!;
    expect(await expire(orphan.id)).toMatchObject({ expired: true, orders: 0 });
    expect((await pinks()).find(row => row.id === orphan.id)).toMatchObject({ status: 3 });
  });
  it('rolls back virtual rows, terminal state and notice events when late notice persistence fails', async () => {
    await age();
    await f.exec("CREATE FUNCTION fixture_reject_pink_notice() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_type='order.pink.success.notice' THEN RAISE EXCEPTION 'fixture notice failure'; END IF; RETURN NEW; END $$");
    await f.exec('CREATE TRIGGER fixture_reject_pink_notice BEFORE INSERT ON store_order_outbox FOR EACH ROW EXECUTE FUNCTION fixture_reject_pink_notice()');
    const before = { financial: await financial(), pinks: await pinks(), notices: await notices() };
    const failed = await outcome(expire());
    expect(failed.ok).toBe(false);
    if (!failed.ok) {
      const cause: unknown = failed.error.cause;
      expect(cause).toMatchObject({ code: 'P0001', message: 'fixture notice failure' });
    }
    expect({ financial: await financial(), pinks: await pinks(), notices: await notices() }).toEqual(before);
    await f.exec('DROP TRIGGER fixture_reject_pink_notice ON store_order_outbox');
    expect(await expire()).toMatchObject({ completed: true }); expect(await notices()).toHaveLength(2);
  });
  it('does not promote a synthetic member after the only remaining real leader refunds', async () => {
    const { refundId } = await ensureAutomaticOrderRefund(f.container, { uid: 22, orderId: memberOrder.orderId, applyType: 1, refundReason: 'Local member refund', refundExplain: '' });
    await finalizeStoreOrderRefund(f.container, refundId);
    await f.db.update(storeCombination).set({ virtual: 1 }); await age();
    expect(await expire()).toMatchObject({ completed: true });
    const leaderRefund = await ensureAutomaticOrderRefund(f.container, { uid: 11, orderId: leaderOrder.orderId, applyType: 1, refundReason: 'Local leader refund', refundExplain: '' });
    expect(await finalizeStoreOrderRefund(f.container, leaderRefund.refundId)).toBe('completed');
    expect((await pinks()).filter(row => row.uid === 0).every(row => row.kId === leaderOrder.pinkId)).toBe(true);
    expect((await pinks()).some(row => row.uid === 0 && row.kId === 0)).toBe(false);
    expect((await f.snapshot()).bills.every(row => row.uid > 0)).toBe(true);
  });

  it.each(['closed', 'deleted', 'hidden', 'ended', 'future', 'invalid-people', 'oversize-people', 'invalid-duration'] as const)(
    'rolls back wallet but records charged external payment in a recoverable failed group: %s', async reason => {
      const pending = await create(33, 3, leaderOrder.pinkId);
      const patch = reason === 'closed' ? { status: 0 } : reason === 'deleted' ? { isDel: 1 } : reason === 'hidden' ? { isShow: 0 }
        : reason === 'ended' ? { stopTime: new Date(0) } : reason === 'future' ? { startTime: new Date(Date.now() + 86_400_000) }
        : reason === 'invalid-people' ? { people: 1 } : reason === 'oversize-people' ? { people: 501 } : { effectiveTime: 0 };
      await f.db.update(storeCombination).set(patch);
      const before = { financial: await financial(), pinks: await pinks(), notices: await notices(), outbox: await f.db.select().from(storeOrderOutbox) };
      await expect(applyStoreOrderBalancePayment(f.container, { uid: 33, orderId: pending.orderId })).rejects.toThrow('拼团活动已结束或配置无效');
      expect({ financial: await financial(), pinks: await pinks(), notices: await notices(), outbox: await f.db.select().from(storeOrderOutbox) }).toEqual(before);
      const input = { orderId: pending.id, payType: 'weixin', tradeNo: 'isolated-already-charged' };
      expect(await applyStoreOrderPayment(f.container, input)).toMatchObject({ outcome: 'paid' });
      const paid = await readOrder(pending.id);
      expect(paid).toMatchObject({ paid: 1, tradeNo: input.tradeNo, payType: 'weixin' });
      expect(paid.pinkId).not.toBe(leaderOrder.pinkId);
      expect((await pinks()).find(row => row.id === paid.pinkId)).toMatchObject({ status: 3, uid: 33, isVirtual: 0 });
      expect(await applyStoreOrderPayment(f.container, input)).toMatchObject({ outcome: 'already-paid' });
      expect(await notices()).toHaveLength(0);
      const messages: unknown[] = [];
      f.env.ORDER_QUEUE = { send: vi.fn(async (message: OrderMessage) => { messages.push(message); return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } }; }),
        sendBatch: vi.fn(async (batch: Iterable<MessageSendRequest<OrderMessage>>) => { messages.push(...Array.from(batch, item => item.body)); return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } }; }),
        metrics: vi.fn(async () => ({ backlogCount: 0, backlogBytes: 0 })) };
      const run = createScheduledRunMessages(Date.now()).find(message => message.job === 'pink_timeout')!;
      await new ScheduledMaintenanceService(f.container, f.env).processMaintenance(run);
      expect(messages).toEqual(expect.arrayContaining([expect.objectContaining({ action: 'processPinkTimeout', pinkId: paid.pinkId })]));
      const request = vi.spyOn(WechatPayService.prototype, 'requestRefund').mockResolvedValue({ status: 'PROCESSING' });
      const query = vi.spyOn(WechatPayService.prototype, 'queryRefund').mockResolvedValue({ status: 'SUCCESS' });
      expect(await expire(paid.pinkId)).toMatchObject({ expired: true, orders: 1, pendingRefunds: 1 });
      expect(await readOrder(paid.id)).toMatchObject({ paid: 1, refundStatus: 0 });
      expect(await expire(paid.pinkId)).toMatchObject({ expired: true, orders: 1, completedRefunds: 1 });
      expect(await readOrder(paid.id)).toMatchObject({ paid: 1, refundStatus: 2 });
      expect(request).toHaveBeenCalledTimes(1); expect(query).toHaveBeenCalledTimes(1);
      expect(query.mock.calls[0][0]).toEqual(request.mock.calls[0][0]);
      expect((await f.db.select().from(user).where(eq(user.uid, 33)))[0].nowMoney).toBe('100.00');
      const committed = await financial(); await expire(paid.pinkId); expect(await financial()).toEqual(committed);
    });

  it('serializes two timeout workers and their virtual rows/notices once with exact backend blockers', async () => {
    await age();
    await withFinancePeers(f.db, async ([blocker, first, second]) => {
      await blocker.exec(`BEGIN; SELECT id FROM store_order WHERE id=${leaderOrder.id} FOR UPDATE`);
      const a = outcome(expire(leaderOrder.pinkId, first));
      await waitForFinanceBlock(f.db, first.pid, blocker.pid);
      const b = outcome(expire(leaderOrder.pinkId, second));
      await waitForFinanceBlock(f.db, second.pid, first.pid);
      await blocker.exec('COMMIT');
      expect(await a).toMatchObject({ ok: true, value: { completed: true } });
      expect(await b).toMatchObject({ ok: true, value: { expired: false } });
    });
    expect(await pinks()).toHaveLength(3); expect(await notices()).toHaveLength(2);
  }, 20_000);
  it('allows an earlier paid activation to finish before timeout waits for its order, without a group/order cycle', async () => {
    const pending = await create(33, 3, leaderOrder.pinkId);
    const deadline = (await pinks()).find(row => row.id === leaderOrder.pinkId)!.stopTime!;
    await withFinancePeers(f.db, async ([blocker, payer, maintainer]) => {
      await blocker.exec('BEGIN; SELECT uid FROM "user" WHERE uid=33 FOR UPDATE');
      const paying = outcome(applyStoreOrderBalancePayment(createContainerFromDb(payer.db), { uid: 33, orderId: pending.orderId }));
      await waitForFinanceBlock(f.db, payer.pid, blocker.pid);
      const expiring = outcome(expire(leaderOrder.pinkId, maintainer, Math.ceil(deadline.getTime() / 1000)));
      await waitForFinanceBlock(f.db, maintainer.pid, payer.pid);
      await blocker.exec('COMMIT');
      expect(await paying).toMatchObject({ ok: true, value: { outcome: 'paid' } });
      expect(await expiring).toMatchObject({ ok: true, value: { expired: false } });
    });
    expect((await pinks()).every(row => row.status === 2 && row.isVirtual === 0)).toBe(true); expect(await notices()).toHaveLength(3);
  }, 20_000);
  it.each(['external', 'wallet'] as const)('orders a later %s payment after committed virtual completion', async mode => {
    const pending = await create(33, 3, leaderOrder.pinkId); await age();
    await withFinancePeers(f.db, async ([blocker, maintainer, payer]) => {
      await blocker.exec(`BEGIN; SELECT id FROM store_pink WHERE id=${leaderOrder.pinkId} FOR UPDATE`);
      const expiring = outcome(expire(leaderOrder.pinkId, maintainer));
      await waitForFinanceBlock(f.db, maintainer.pid, blocker.pid);
      const container = createContainerFromDb(payer.db);
      const paying = outcome(mode === 'external'
        ? applyStoreOrderPayment(container, { orderId: pending.id, payType: 'weixin', tradeNo: 'isolated-late-group' })
        : applyStoreOrderBalancePayment(container, { uid: 33, orderId: pending.orderId }));
      await waitForFinanceBlock(f.db, payer.pid, maintainer.pid);
      await blocker.exec('COMMIT');
      expect(await expiring).toMatchObject({ ok: true, value: { completed: true } });
      expect((await paying).ok).toBe(mode === 'external');
    });
    expect(await notices()).toHaveLength(2);
    const paid = await readOrder(pending.id);
    expect(paid.paid).toBe(mode === 'external' ? 1 : 0);
    if (mode === 'external') { expect(paid.pinkId).not.toBe(leaderOrder.pinkId); expect((await pinks()).find(row => row.id === paid.pinkId)).toMatchObject({ status: 1, uid: 33 }); }
    expect((await f.db.select().from(user).where(eq(user.uid, 33)))[0].nowMoney).toBe('100.00');
  }, 20_000);
  it('lets a prior actual leader refund finish and sees its promoted successor without virtual revival', async () => {
    const application = await ensureAutomaticOrderRefund(f.container, { uid: 11, orderId: leaderOrder.orderId, applyType: 1, refundReason: 'Local race refund', refundExplain: '' });
    await age();
    await withFinancePeers(f.db, async ([blocker, refunder, maintainer]) => {
      await blocker.exec('BEGIN; SELECT uid FROM "user" WHERE uid=11 FOR UPDATE');
      const refunding = outcome(finalizeStoreOrderRefund(createContainerFromDb(refunder.db), application.refundId));
      await waitForFinanceBlock(f.db, refunder.pid, blocker.pid);
      const expiring = outcome(expire(leaderOrder.pinkId, maintainer));
      await waitForFinanceBlock(f.db, maintainer.pid, refunder.pid);
      await blocker.exec('COMMIT');
      expect(await refunding).toEqual({ ok: true, value: 'completed' });
      expect(await expiring).toMatchObject({ ok: true, value: { expired: true, completedRefunds: 1 } });
    });
    expect(await notices()).toHaveLength(0); expect((await pinks()).some(row => row.isVirtual === 1)).toBe(false);
    expect(await readOrder(memberOrder.id)).toMatchObject({ paid: 1, refundStatus: 0 });
  }, 20_000);
  it('sees cancellation intent committed before its activity boundary, instead of overriding it with success', async () => {
    await age();
    await withFinancePeers(f.db, async ([writer, maintainer]) => {
      const pending = await writer.db.transaction(async tx => {
        await tx.select({ id: storeCombination.id }).from(storeCombination).where(eq(storeCombination.id, 30)).for('no key update');
        // Use the actual application's quote and durable quantity reservation.
        // Its nested transaction is a real SAVEPOINT; the outer writer still
        // holds the intent, order and activity locks until this callback exits.
        const locked = tx as unknown as DbClient;
        const application = await applyOrderRefund(createContainerFromDb(locked), {
          uid: 11, orderId: leaderOrder.orderId, applyType: 1,
          refundReason: 'Cancellation intent before timeout', refundExplain: '',
        });
        const [claim] = await tx.select().from(storeOrderRefund).where(eq(storeOrderRefund.id, application.refundId));
        expect(claim.cartInfo).toContain('quantityReservation');
        const work = outcome(expire(leaderOrder.pinkId, maintainer));
        await waitForFinanceBlock(f.db, maintainer.pid, writer.pid);
        return { work };
      });
      const result = await pending.work;
      if (!result.ok) throw result.error;
      expect(result).toMatchObject({ ok: true, value: { expired: true, completedRefunds: 2 } });
    });
    expect(await notices()).toHaveLength(0);
  }, 20_000);
  it('rechecks a close after the provider waits for KEY SHARE and commits paid evidence into a failed group', async () => {
    const pending = await create(33, 3, leaderOrder.pinkId);
    await withFinancePeers(f.db, async ([closer, payer]) => {
      await closer.exec('BEGIN; SELECT id FROM store_combination WHERE id=30 FOR UPDATE; UPDATE store_combination SET status=0 WHERE id=30');
      const paying = outcome(applyStoreOrderPayment(createContainerFromDb(payer.db), { orderId: pending.id, payType: 'weixin', tradeNo: 'isolated-close-race' }));
      await waitForFinanceBlock(f.db, payer.pid, closer.pid);
      await closer.exec('COMMIT');
      expect(await paying).toMatchObject({ ok: true, value: { outcome: 'paid' } });
    });
    const paid = await readOrder(pending.id);
    expect(paid).toMatchObject({ paid: 1, tradeNo: 'isolated-close-race' });
    expect((await pinks()).find(row => row.id === paid.pinkId)).toMatchObject({ status: 3 });
    expect(await notices()).toHaveLength(0);
  }, 20_000);
  it('uses post-lock millisecond clock if the activity ends while the charged callback is waiting', async () => {
    const pending = await create(33, 3, leaderOrder.pinkId);
    const deadline = Date.now() + 800;
    await f.db.update(storeCombination).set({ stopTime: new Date(deadline) });
    await withFinancePeers(f.db, async ([blocker, payer]) => {
      await blocker.exec('BEGIN; SELECT id FROM store_combination WHERE id=30 FOR UPDATE');
      const paying = outcome(applyStoreOrderPayment(createContainerFromDb(payer.db), { orderId: pending.id, payType: 'weixin', tradeNo: 'isolated-expiry-race' }));
      await waitForFinanceBlock(f.db, payer.pid, blocker.pid);
      await waitForFinanceClock(f.db, deadline);
      await blocker.exec('COMMIT');
      expect(await paying).toMatchObject({ ok: true, value: { outcome: 'paid' } });
    });
    const paid = await readOrder(pending.id);
    expect((await pinks()).find(row => row.id === paid.pinkId)).toMatchObject({ status: 3 });
  }, 20_000);
});
