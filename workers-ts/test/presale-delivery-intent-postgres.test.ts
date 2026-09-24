import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createContainerFromDb, withTx, type DbClient } from '@/lib/di';
import { storeOrder, storeOrderCartInfo, storeOrderOutbox, storeOrderStatus, storeOrderRefundSplit } from '@/models/schema';
import { enqueuePresaleDeliveryIntent, preparePresaleDeliveryClaim, presaleDeliveryContractDigest,
  PRESALE_DELIVERY_EVENT, presaleDeliveryEventKey, readPresaleDeliveryIntent } from '@/services/activity/PresaleDeliveryIntent';
import { financePostgres } from './helpers/financePostgres';
import { outcome, waitForFinanceBlock, withFinancePeers } from './helpers/financePeers';

const snapshot = (end = 2_147_483_647, diskInfo = '') => JSON.stringify({
  presale: { version: 'presale-full-payment-v1', productId: 70, startsAt: 0, endsAt: end,
    shippingDaysAfterEnd: 7, paidMemberOnly: false, perOrderLimit: null },
  sku: { disk_info: diskInfo },
});
const intent = () => ({ version: 'presale-virtual-delivery-v1', orderId: 1, orderNo: 'PRESALE-INTENT',
  paymentOrderId: 1, buyerId: 11, supplierId: 0, storeId: 0, dueAt: 100, lines: [{ cartInfoId: 1, productId: 70, skuUnique: 'sku00001',
    quantity: 2, endsAt: 100, contractDigest: 'a'.repeat(64) }] });
const native = Boolean(process.env.TEST_FINANCE_POSTGRES_URL);

describe('presale delivery intent contract', () => {
  it('accepts canonical references but rejects invalid event IDs', () => {
    expect(readPresaleDeliveryIntent(intent(), 1)).toEqual(intent());
    expect(presaleDeliveryEventKey(1)).toBe('order.presale.fulfillment:1');
    for (const id of [0, -1, 1.5, NaN, Infinity, 2_147_483_648]) expect(() => presaleDeliveryEventKey(id)).toThrow();
  });
  it('requires an explicit bounded v2 refund baseline; v1 cannot hide or inherit one', () => {
    const upgraded = { ...intent(), version: 'presale-virtual-delivery-v2', baseline: { refundId: 3, historyDigest: 'b'.repeat(64) } };
    expect(readPresaleDeliveryIntent(upgraded, 1)).toEqual(upgraded);
    for (const baseline of [undefined, null, {}, { refundId: 0, historyDigest: 'b'.repeat(64) },
      { refundId: 3, historyDigest: 'B'.repeat(64) }, { refundId: 3, historyDigest: 'b'.repeat(64), cutoff: 3 }]) {
      expect(() => readPresaleDeliveryIntent({ ...upgraded, baseline }, 1)).toThrow();
    }
    expect(() => readPresaleDeliveryIntent({ ...upgraded, version: 'presale-virtual-delivery-v1' }, 1)).toThrow();
    const { baseline: _baseline, ...missing } = upgraded;
    expect(() => readPresaleDeliveryIntent(missing, 1)).toThrow();
  });
  it.each([
    null, [], {}, { ...intent(), version: 'unknown' }, { ...intent(), extra: 'unexpected' },
    { ...intent(), orderId: 2 }, { ...intent(), orderNo: ' x ' }, { ...intent(), orderNo: 'x\n' },
    { ...intent(), paymentOrderId: 0 }, { ...intent(), dueAt: 99 }, { ...intent(), lines: [] },
    { ...intent(), buyerId: 0 }, { ...intent(), supplierId: -1 }, { ...intent(), storeId: '0' },
    { ...intent(), lines: [intent().lines[0], intent().lines[0]] },
    ...[{ quantity: 0 }, { quantity: 32768 }, { endsAt: '100' }, { productId: 0 },
      { skuUnique: 'sku 1' }, { contractDigest: 'A'.repeat(64) }, { secret: 'must not persist' }]
      .map(patch => ({ ...intent(), lines: [{ ...intent().lines[0], ...patch }] })),
  ])('rejects malformed, mismatched or unbounded metadata %#', value => {
    expect(() => readPresaleDeliveryIntent(value, 1)).toThrow('意图或订单凭据不一致');
  });
  it('hashes immutable delivery identity/content, not quantity or refund financial metadata', async () => {
    const base = await presaleDeliveryContractDigest(snapshot(100, 'local-test-secret'), 70, 'sku00001');
    expect(base).toMatch(/^[a-f0-9]{64}$/);
    expect(base).not.toContain('local-test-secret');
    const changedFinance = JSON.stringify({ ...JSON.parse(snapshot(100, 'local-test-secret')),
      cart_num: 1, financial_version: 'refund-order-line-finance-v1', refund_order_generation: { refundId: 1, role: 'remaining' } });
    expect(await presaleDeliveryContractDigest(changedFinance, 70, 'sku00001')).toBe(base);
    for (const [end, disk, sku] of [[101, 'local-test-secret', 'sku00001'], [100, 'other', 'sku00001'],
      [100, '', 'sku00001'], [100, 'local-test-secret', 'sku00002']] as const) {
      expect(await presaleDeliveryContractDigest(snapshot(end, disk), 70, sku)).not.toBe(base);
    }
    await expect(presaleDeliveryContractDigest(snapshot(), 71, 'sku00001')).rejects.toThrow();
  });
});

describe('presale intent transaction primitives', () => {
  let f: Awaited<ReturnType<typeof financePostgres>>;
  const tx = <T>(fn: (db: DbClient) => Promise<T>, db = f.db) => withTx(createContainerFromDb(db), fn);
  const enqueue = (db = f.db) => tx(db => enqueuePresaleDeliveryIntent(db, { id: 1, orderId: 'PRESALE-INTENT' }, 1), db);
  const prepare = (event: { id: number; eventKey: string }, db = f.db) =>
    tx(db => preparePresaleDeliveryClaim(db, { outboxId: event.id, eventKey: event.eventKey }), db);
  const state = async () => ({ orders: await f.db.select().from(storeOrder), carts: await f.db.select().from(storeOrderCartInfo),
    events: await f.db.select().from(storeOrderOutbox), statuses: await f.db.select().from(storeOrderStatus) });
  const setEnd = (end: number) => f.db.update(storeOrderCartInfo).set({ cartInfo: snapshot(end) });
  beforeAll(async () => {
    f = await financePostgres([storeOrder, storeOrderCartInfo, storeOrderOutbox, storeOrderStatus, storeOrderRefundSplit]);
    await f.exec('CREATE UNIQUE INDEX presale_intent_test_key ON store_order_outbox(event_key)');
    // Minimal helper fixture; the forward migration and real ORM CHECK are
    // exercised independently by the migration and end-to-end outbox suites.
    await f.exec("ALTER TABLE store_order_outbox ADD CONSTRAINT presale_intent_test_type CHECK (event_type IN ('order.presale.fulfillment','order.paid'))");
  });
  afterAll(async () => { await f?.close(); });
  beforeEach(async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('External requests forbidden'));
    await f.reset();
    await f.db.insert(storeOrder).values({ orderId: 'PRESALE-INTENT', uid: 11, type: 6, productType: 1,
      paid: 1, totalNum: 2, supplierAllocationStatus: 2 });
    await f.db.insert(storeOrderCartInfo).values({ oid: 1, uid: 11, productId: 70, productType: 1,
      skuUnique: 'sku00001', cartId: '1', cartNum: 2, cartInfo: snapshot() });
  });
  afterEach(() => { try { expect(fetch).not.toHaveBeenCalled(); } finally { vi.restoreAllMocks(); } });

  it('persists a distinct due event, no secrets/paid facts/Queue work; repeat creation is a no-op', async () => {
    await f.db.update(storeOrderCartInfo).set({ cartInfo: snapshot(2_147_483_647, 'local-test-secret') });
    const created = await enqueue();
    expect(created.intent).toMatchObject({ dueAt: 2_147_483_647, lines: [{ quantity: 2 }] });
    const before = await state();
    expect(await enqueue()).toEqual(created);
    expect(await state()).toEqual(before);
    expect(before.events[0]).toMatchObject({ eventType: PRESALE_DELIVERY_EVENT, aggregateType: 'order',
      status: 'PENDING', attemptCount: 0, availableTime: 2_147_483_647 });
    expect(JSON.stringify(before.events)).not.toContain('local-test-secret');
    expect(before.orders[0].status).toBe(0);
    expect(before.statuses).toEqual([]);
  });
  it('keeps reserved-refund quantity in original intent, not mistaken for a completed refund', async () => {
    await f.db.update(storeOrderCartInfo).set({ refundNum: 1 });
    expect((await enqueue()).intent.lines[0].quantity).toBe(2);
  });
  it('pins buyer/supplier/store and the verified allocated payment root for a child intent', async () => {
    await f.db.insert(storeOrder).values({ orderId: 'PRESALE-ROOT', uid: 11, type: 6, productType: 1,
      pid: -1, paid: 1, totalNum: 2, supplierAllocationStatus: 2 });
    await f.db.update(storeOrder).set({ pid: 2, supplierId: 7, storeId: 9 }).where(eq(storeOrder.id, 1));
    const create = () => tx(db => enqueuePresaleDeliveryIntent(db, { id: 1, orderId: 'PRESALE-INTENT' }, 2));
    expect((await create()).intent).toMatchObject({ orderId: 1, paymentOrderId: 2, buyerId: 11, supplierId: 7, storeId: 9 });
    await f.db.update(storeOrder).set({ uid: 12 }).where(eq(storeOrder.id, 2));
    await expect(create()).rejects.toThrow();
    expect((await state()).events).toHaveLength(1);
  });
  it('rejects a child with an absent payment root, never inferring it from an order number', async () => {
    await f.db.update(storeOrder).set({ pid: 99 });
    await expect(tx(db => enqueuePresaleDeliveryIntent(db, { id: 1, orderId: 'PRESALE-INTENT' }, 99))).rejects.toThrow();
    expect((await state()).events).toEqual([]);
  });
  it('rejects the 201st line before persisting any event', async () => {
    await f.db.insert(storeOrderCartInfo).values(Array.from({ length: 200 }, (_, index) => ({
      oid: 1, uid: 11, productId: 70, productType: 1, skuUnique: 'sku00001', cartId: String(index + 2),
      cartNum: 1, cartInfo: snapshot(),
    })));
    await f.db.update(storeOrder).set({ totalNum: 202 });
    await expect(enqueue()).rejects.toThrow();
    expect((await state()).events).toEqual([]);
  });
  it('uses the latest line end without adding one second or shipping promise days', async () => {
    await setEnd(100);
    await f.db.update(storeOrder).set({ totalNum: 3 });
    await f.db.insert(storeOrderCartInfo).values({ oid: 1, uid: 11, productId: 70, productType: 1,
      skuUnique: 'sku00002', cartId: '2', cartNum: 1, cartInfo: snapshot(200) });
    expect((await enqueue()).intent).toMatchObject({ dueAt: 200, lines: [{ endsAt: 100 }, { endsAt: 200 }] });
  });
  it('accepts evidence-bearing historical PHP snapshots without live product/SKU tables', async () => {
    await f.db.update(storeOrderCartInfo).set({ cartInfo: JSON.stringify({ productInfo: {
      id: '70', presale_end_time: '100', attrInfo: { disk_info: '' } } }) });
    expect((await enqueue()).intent.dueAt).toBe(100);
  });
  it.each([{ type: 0 }, { productType: 0 }, { paid: 0 }, { status: 1 }, { isDel: 1 },
    { isSystemDel: 1 }, { supplierAllocationStatus: 1 }, { pid: -1 }, { pid: 2 }, { totalNum: 3 }, { uid: 12 }])
    ('rejects wrong order identity/state/scope before inserting %#', async patch => {
      await f.db.update(storeOrder).set(patch);
      await expect(enqueue()).rejects.toThrow();
      expect((await state()).events).toEqual([]);
    });
  it.each([{ uid: 12 }, { productType: 0 }, { cartInfo: '{}' }, { cartInfo: snapshot().replace('"endsAt":2147483647', '"endsAt":null') },
    { cartInfo: snapshot().replace('"sku":{"disk_info":""}', '"sku":{}') }, { cartInfo: snapshot() + ' '.repeat(65_537) }])
    ('rejects malformed or foreign line evidence before inserting %#', async patch => {
      await f.db.update(storeOrderCartInfo).set(patch);
      await expect(enqueue()).rejects.toThrow();
      expect((await state()).events).toEqual([]);
    });
  it('rejects missing lines and refuses an autocommit database', async () => {
    await f.db.delete(storeOrderCartInfo);
    await expect(enqueue()).rejects.toThrow();
    await expect(enqueuePresaleDeliveryIntent(f.db, { id: 1, orderId: 'PRESALE-INTENT' }, 1)).rejects.toThrow('caller-owned transaction');
  });
  it('rejects a changed contract at the same event key instead of overwriting the intent', async () => {
    await enqueue(); const before = (await state()).events;
    await setEnd(100);
    await expect(enqueue()).rejects.toThrow('意图或订单凭据不一致');
    expect((await state()).events).toEqual(before);
  });
  it('rolls back intent with the caller payment-effects transaction on a later SQL failure', async () => {
    const before = await state();
    await expect(tx(async db => {
      await enqueuePresaleDeliveryIntent(db, { id: 1, orderId: 'PRESALE-INTENT' }, 1);
      await db.insert(storeOrderStatus).values({ oid: 1, changeType: 'pay_success' });
      await db.execute(sql`SELECT 1 / 0`);
    })).rejects.toThrow();
    expect(await state()).toEqual(before);
  });
  it('old event whitelist rejects a new intent atomically until the forward migration runs', async () => {
    const condition = "event_type IN ('order.paid','order.delivery.notice','order.refund.refused.notice')";
    await f.exec(`ALTER TABLE store_order_outbox ADD CONSTRAINT presale_current_whitelist CHECK (${condition})`);
    try {
      const before = await state();
      await expect(tx(async db => {
        await db.insert(storeOrderStatus).values({ oid: 1, changeType: 'pay_success' });
        await enqueuePresaleDeliveryIntent(db, { id: 1, orderId: 'PRESALE-INTENT' }, 1);
      })).rejects.toThrow();
      expect(await state()).toEqual(before);
    } finally { await f.exec('ALTER TABLE store_order_outbox DROP CONSTRAINT presale_current_whitelist'); }
  });
  it.each(['PENDING', 'FAILED', 'ENQUEUING', 'ENQUEUED', 'PROCESSING'])('early %s messages do not consume attempts or leak leases', async status => {
    const event = await enqueue();
    await f.db.update(storeOrderOutbox).set({ status, attemptCount: 3, availableTime: 0,
      leaseUntil: 1, leaseToken: 'old-expired-lease' });
    for (let i = 0; i < 12; i++) expect(await prepare(event)).toEqual({ kind: 'deferred' });
    expect((await state()).events[0]).toMatchObject({ status: 'PENDING', attemptCount: 3,
      availableTime: 2_147_483_647, leaseUntil: 0, leaseToken: '' });
  });
  it('honors retry backoff and immutable deadline even when an administrative replay resets availability', async () => {
    await setEnd(100); const event = await enqueue();
    await f.db.update(storeOrderOutbox).set({ status: 'FAILED', availableTime: 2_147_483_647 });
    expect(await prepare(event)).toEqual({ kind: 'deferred' });
    await f.db.update(storeOrderOutbox).set({ availableTime: 0 });
    const ready = await prepare(event);
    expect(ready).toMatchObject({ kind: 'ready', intent: { dueAt: 100 } });
    expect((await state()).events[0].attemptCount).toBe(0);
  });
  it.each(['COMPLETED', 'DEAD', 'PROCESSING'])('does not reset terminal/unexpired %s state', async status => {
    const event = await enqueue();
    await f.db.update(storeOrderOutbox).set({ status, leaseUntil: 2_147_483_647, leaseToken: 'active-lease' });
    const before = await state();
    expect(await prepare(event)).toEqual({ kind: status === 'COMPLETED' ? 'already-completed' : status === 'DEAD' ? 'dead' : 'busy' });
    expect(await state()).toEqual(before);
  });
  it('rejects mismatched message/event identity and malformed stored payload without writes', async () => {
    const event = await enqueue(); const before = await state();
    await expect(prepare({ ...event, eventKey: 'order.paid:1' })).rejects.toThrow();
    expect(await state()).toEqual(before);
    await f.db.update(storeOrderOutbox).set({ payload: { orderId: 1, orderNo: 'PRESALE-INTENT' } });
    const broken = await state(); await expect(prepare(event)).rejects.toThrow();
    expect(await state()).toEqual(broken);
  });

  it.skipIf(!native)('uses PostgreSQL clock even when application Date.now is beyond the end', async () => {
    const event = await enqueue();
    vi.spyOn(Date, 'now').mockReturnValue(2_147_483_648_000);
    expect(await prepare(event)).toEqual({ kind: 'deferred' });
    expect((await state()).events[0].attemptCount).toBe(0);
  });
  it.skipIf(!native)('refuses an already-held non-key snapshot write lock with NOWAIT', async () => {
    await withFinancePeers(f.db, async ([writer, producer]) => {
      await writer.exec('BEGIN');
      try {
        await writer.db.update(storeOrderCartInfo).set({ cartInfo: snapshot(100) }).where(eq(storeOrderCartInfo.id, 1));
        expect((await outcome(enqueue(producer.db))).ok).toBe(false);
        expect((await state()).events).toEqual([]);
      } finally { await writer.exec('ROLLBACK'); }
    });
  });
  it.skipIf(!native)('keeps snapshot protected until intent transaction commits', async () => {
    await withFinancePeers(f.db, async ([producer, writer]) => {
      let release!: () => void, captured!: () => void;
      const latch = new Promise<void>(resolve => { release = resolve; });
      const signal = new Promise<void>(resolve => { captured = resolve; });
      const pending = outcome(tx(async db => {
        await enqueuePresaleDeliveryIntent(db, { id: 1, orderId: 'PRESALE-INTENT' }, 1); captured(); await latch;
      }, producer.db));
      let update: ReturnType<typeof outcome> | undefined;
      try {
        await signal;
        update = outcome(writer.db.update(storeOrderCartInfo).set({ cartInfo: snapshot(100) }).where(eq(storeOrderCartInfo.id, 1)));
        await waitForFinanceBlock(f.db, writer.pid, producer.pid);
      } finally { release(); }
      expect((await pending).ok).toBe(true);
      expect((await update!).ok).toBe(true);
      expect((await state()).events[0].availableTime).toBe(2_147_483_647);
    });
  });
  it.skipIf(!native)('holds the outbox row through the caller claim so a second consumer cannot also claim', async () => {
    await setEnd(100); const event = await enqueue();
    await withFinancePeers(f.db, async ([first, second]) => {
      let release!: () => void, captured!: () => void;
      const latch = new Promise<void>(resolve => { release = resolve; });
      const signal = new Promise<void>(resolve => { captured = resolve; });
      const pending = outcome(tx(async db => {
        expect(await preparePresaleDeliveryClaim(db, { outboxId: event.id, eventKey: event.eventKey })).toMatchObject({ kind: 'ready' });
        captured(); await latch;
        await db.update(storeOrderOutbox).set({ status: 'PROCESSING', attemptCount: 1, leaseUntil: 2_147_483_647, leaseToken: 'test-owned-lease' });
      }, first.db));
      try {
        await signal; expect((await outcome(prepare(event, second.db))).ok).toBe(false);
      } finally { release(); }
      expect((await pending).ok).toBe(true);
      expect(await prepare(event, second.db)).toEqual({ kind: 'busy' });
    });
  });
});
