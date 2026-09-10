import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createContainerFromDb, type DbClient } from '../src/lib/di';
import type { Env } from '../src/env';
import * as models from '../src/models/schema';
import { user, userBill, storeProduct, storeProductAttrValue, storeOrder, storeOrderCartInfo,
  storeOrderInvoice, storeOrderOutbox, storeOrderRefund, storeOrderRefundPayment } from '../src/models/schema';
import { runBrokeragePaidOrderFence } from '../src/migrations/runBrokeragePaidOrderFence';
import { applyStoreOrderBalancePayment, applyStoreOrderPayment } from '../src/services/order/StoreOrderPayService';
import { StoreOrderCreateService } from '../src/services/order/StoreOrderCreateService';
import { applyOrderRefund, approveStoreOrderReturn, finalizeStoreOrderRefund,
  StoreOrderRefundService } from '../src/services/order/StoreOrderRefundService';
import { assertCheckoutPaidOrderQualifications } from '../src/services/order/CheckoutPaidOrderAuthority';
import { sequenceRunnerDatabase, type SequenceRunnerPeer } from './helpers/kefuSequenceRunnerDatabase';
import { outcome, waitForFinanceBlock } from './helpers/financePeers';

// Full ORM DDL (including checks, unique indexes and foreign keys), plus the
// real standalone trigger installer. Dedicated random loopback database only.
// Calls the SQL business cores, never payment gateways, queues or host secrets.
describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('paid-order fence with full-schema business transactions', () => {
  let f: Awaited<ReturnType<typeof sequenceRunnerDatabase>>;
  const now = 1_789_000_000;
  const container = (db = f.db) => createContainerFromDb(db);
  const pay = (mode: 'balance' | 'provider', db = f.db, id = 501) => mode === 'balance'
    ? applyStoreOrderBalancePayment(container(db), { uid: 11, orderId: `business-${id}`, now })
    : applyStoreOrderPayment(container(db), { orderId: id, payType: 'weixin', tradeNo: `synthetic-${id}`, now });
  const order = async () => (await f.db.select().from(storeOrder).where(eq(storeOrder.id, 501)))[0];
  const buyer = async () => (await f.db.select().from(user).where(eq(user.uid, 11)))[0];
  const total = async () => {
    const [row] = await f.db.select({ amount: sql<string>`coalesce(sum(pay_price),0)::numeric(14,2)` })
      .from(storeOrder).where(sql`uid=11 AND pid<>-1 AND paid=1 AND is_del=0 AND refund_status IN(0,3)`);
    return row.amount;
  };
  const snapshot = async () => ({
    users: await f.db.select().from(user).orderBy(user.uid),
    orders: await f.db.select().from(storeOrder).orderBy(storeOrder.id),
    carts: await f.db.select().from(storeOrderCartInfo).orderBy(storeOrderCartInfo.id),
    goods: await f.db.select().from(storeProduct).orderBy(storeProduct.id),
    skus: await f.db.select().from(storeProductAttrValue).orderBy(storeProductAttrValue.id),
    refunds: await f.db.select().from(storeOrderRefund).orderBy(storeOrderRefund.id),
    invoices: await f.db.select().from(storeOrderInvoice).orderBy(storeOrderInvoice.id),
    bills: await f.db.select().from(userBill).orderBy(userBill.id),
    outbox: await f.db.select().from(storeOrderOutbox).orderBy(storeOrderOutbox.id),
    status: await f.db.select().from(models.storeOrderStatus).orderBy(models.storeOrderStatus.id),
    brokerage: await f.db.select().from(models.userBrokerage).orderBy(models.userBrokerage.id),
  });
  const apply = (qty = 2, applyType = 1, key = 'first', db = f.db) => applyOrderRefund(container(db), {
    uid: 11, orderId: 'business-501', refundReason: 'isolated QA', refundExplain: '', applyType,
    cartSelections: [{ cartId: 701, cartNum: qty }], applicationOrderId: `business-refund-${key}`,
  });
  const providerSuccess = async (refundId: number, cents: number) => {
    await f.db.insert(storeOrderRefundPayment).values({ refundId, storeOrderId: 501, provider: 'wechat',
      outRefundNo: `synthetic-refund-${refundId}`, providerStatus: 'SUCCESS', requestAmount: cents, totalAmount: 2000 });
  };
  async function peers<T>(run: (p: [SequenceRunnerPeer, SequenceRunnerPeer, SequenceRunnerPeer]) => Promise<T>) {
    if (!f.withPeer) throw new Error('Real PostgreSQL peers required');
    const connect = f.withPeer;
    return connect(a => connect(b => connect(async c => {
      const [observer] = await f.db.select({ pid: sql<number>`pg_backend_pid()` }).from(sql`(values(1)) v(n)`);
      expect(new Set([observer.pid, a.pid, b.pid, c.pid]).size).toBe(4);
      return run([a, b, c]);
    })));
  }
  beforeEach(async () => {
    f = await sequenceRunnerDatabase();
    expect(f.format).toBe('pg16');
    const api = await import('drizzle-kit/api');
    await f.exec((await api.generateMigration(api.generateDrizzleJson({}), api.generateDrizzleJson(models))).join('\n'));
    await runBrokeragePaidOrderFence(f.db);
    await f.db.insert(user).values({ uid: 11, account: 'isolated-buyer', nowMoney: '100.00', integral: 100 });
    await f.db.insert(storeProduct).values({ id: 70, storeName: 'isolated-product', stock: 8, sales: 2 });
    await f.db.insert(storeProductAttrValue).values({ id: 1, productId: 70, unique: 'qa000001', stock: 8, sales: 2, price: '10.00' });
    await f.db.insert(storeOrder).values({ id: 501, uid: 11, orderId: 'business-501', unique: 'business-key',
      totalNum: 2, totalPrice: '20.00', payPrice: '20.00', paid: 0, status: 0, addTime: now });
    await f.db.insert(storeOrderCartInfo).values({ id: 701, oid: 501, uid: 11, cartId: '701', productId: 70,
      cartNum: 2, unique: 'business-cart', skuUnique: 'qa000001',
      cartInfo: JSON.stringify({ sku: { id: 1, price: '10.00' }, sum_true_price: '20.00' }) });
    await f.db.insert(storeOrderInvoice).values({ id: 501, orderId: 501, uid: 11 });
  }, 30_000);
  afterEach(async () => { await f?.close(); });

  it('retains real constraints and installed triggers instead of the column-only fixture', async () => {
    const [row] = await f.db.select({ count: sql<number>`count(*)::int` }).from(sql`pg_constraint`)
      .where(sql`contype='f' AND connamespace='public'::regnamespace`);
    expect(row.count).toBeGreaterThan(0);
    expect((await f.query(`SELECT conname FROM pg_constraint WHERE contype='f' AND conrelid IN
      ('public.store_order'::regclass,'public."user"'::regclass,'public.store_order_refund'::regclass)`)).rows).toEqual([]);
    expect((await f.query(`SELECT tgname FROM pg_trigger WHERE tgrelid='store_order'::regclass AND NOT tgisinternal ORDER BY tgname`)).rows)
      .toEqual(['delete', 'insert', 'update'].map(event => ({ tgname: `brokerage_paid_${event}_0150` })));
    await expect(f.db.insert(storeOrder).values({ uid: 11, orderId: 'business-501', unique: 'different' })).rejects.toThrow();
    await expect(f.db.insert(storeOrderRefundPayment).values({ refundId: 9, storeOrderId: 501, provider: 'wechat',
      outRefundNo: 'bad-amount', requestAmount: 2001, totalAmount: 2000 })).rejects.toThrow();
  });

  it.each(['balance', 'provider'] as const)('commits and replays %s payment exactly once', async mode => {
    expect(await total()).toBe('0.00');
    expect(await pay(mode)).toMatchObject({ outcome: 'paid' });
    expect(await total()).toBe('20.00');
    expect(await buyer()).toMatchObject({ nowMoney: mode === 'balance' ? '80.00' : '100.00', integral: 100 });
    expect((await f.db.select().from(storeOrderInvoice))[0].isPay).toBe(1);
    expect(await f.db.select().from(storeOrderOutbox)).toHaveLength(1);
    const stable = await snapshot();
    expect(await pay(mode)).toEqual({ outcome: 'already-paid', outbox: null });
    expect(await snapshot()).toEqual(stable);
    if (mode === 'provider') {
      await expect(applyStoreOrderPayment(container(), { orderId: 501, payType: 'weixin', tradeNo: 'other' }))
        .rejects.toThrow('支付回调与已入账交易不匹配');
      expect(await snapshot()).toEqual(stable);
    }
  });

  it.each(['balance', 'provider'] as const)('rolls back %s payment, integral, invoice and fence when late outbox insertion fails', async mode => {
    await f.db.update(storeOrder).set({ payIntegral: 10 }).where(eq(storeOrder.id, 501));
    const before = await snapshot();
    await f.exec(`CREATE FUNCTION fail_paid_outbox() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
      RAISE EXCEPTION 'intentional paid outbox fault'; END$$;
      CREATE TRIGGER fail_paid_outbox BEFORE INSERT ON store_order_outbox FOR EACH ROW EXECUTE FUNCTION fail_paid_outbox()`);
    await expect(pay(mode)).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
    expect(await total()).toBe('0.00');
    await f.exec('DROP TRIGGER fail_paid_outbox ON store_order_outbox; DROP FUNCTION fail_paid_outbox()');
    expect(await pay(mode)).toMatchObject({ outcome: 'paid' });
    expect((await buyer()).integral).toBe(90);
    expect(await total()).toBe('20.00');
  });

  it.each(['balance', 'provider'] as const)('applies partial then full %s refund with stock, balance, qualification and replay checks', async mode => {
    await pay(mode);
    for (const [index, money, stock, qualification] of [[1, '90.00', 9, '20.00'], [2, '100.00', 10, '0.00']] as const) {
      const { refundId } = await apply(1, 1, String(index));
      // An application is not a completed refund and does not remove qualification.
      expect(await total()).toBe('20.00');
      if (mode === 'provider') await providerSuccess(refundId, 1000);
      expect(await finalizeStoreOrderRefund(container(), refundId, now)).toBe('completed');
      expect(await total()).toBe(qualification);
      expect(await order()).toMatchObject({ refundStatus: index === 1 ? 3 : 2, refundPrice: `${index * 10}.00` });
      expect((await buyer()).nowMoney).toBe(mode === 'balance' ? money : '100.00');
      expect((await f.db.select().from(storeProduct))[0].stock).toBe(stock);
      expect((await f.db.select().from(storeProductAttrValue))[0].stock).toBe(stock);
      expect((await f.db.select().from(storeOrderCartInfo))[0].refundNum).toBe(index);
      const stable = await snapshot();
      expect(await finalizeStoreOrderRefund(container(), refundId, now)).toBe('already-completed');
      expect(await snapshot()).toEqual(stable);
    }
  });

  it('excludes return approval and restores qualification after refusal without issuing money', async () => {
    await pay('balance');
    await f.db.update(storeOrder).set({ status: 1 }).where(eq(storeOrder.id, 501));
    const { refundId } = await apply(2, 2);
    expect(await total()).toBe('20.00');
    expect(await approveStoreOrderReturn(container(), refundId)).toEqual({ changed: true });
    expect(await total()).toBe('0.00');
    expect(await approveStoreOrderReturn(container(), refundId)).toEqual({ changed: false });
    const service = new StoreOrderRefundService(container(), {} as Env);
    await service.refuseRefund(refundId, 'isolated refusal');
    expect(await total()).toBe('20.00');
    expect((await buyer()).nowMoney).toBe('80.00');
    const stable = await snapshot();
    await service.refuseRefund(refundId, 'isolated refusal');
    expect(await snapshot()).toEqual(stable);
  });

  it('rejects missing or mismatched provider evidence without changing business rows', async () => {
    await pay('provider');
    const { refundId } = await apply();
    const before = await snapshot();
    await expect(finalizeStoreOrderRefund(container(), refundId, now)).rejects.toThrow('支付渠道尚未确认退款成功');
    expect(await snapshot()).toEqual(before);
    await providerSuccess(refundId, 1999);
    await expect(finalizeStoreOrderRefund(container(), refundId, now)).rejects.toThrow('退款金额与支付渠道确认金额不一致');
    expect(await snapshot()).toEqual(before);
  });

  it('rolls back a late refund ledger failure after the qualification and inventory writes', async () => {
    await pay('balance');
    const { refundId } = await apply();
    const before = await snapshot();
    await f.exec(`CREATE FUNCTION fail_refund_bill() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
      IF NEW.type='pay_product_refund' THEN RAISE EXCEPTION 'intentional refund bill fault'; END IF;
      RETURN NEW; END$$;
      CREATE TRIGGER fail_refund_bill BEFORE INSERT ON user_bill FOR EACH ROW EXECUTE FUNCTION fail_refund_bill()`);
    await expect(finalizeStoreOrderRefund(container(), refundId, now)).rejects.toThrow();
    expect(await snapshot()).toEqual(before);
    expect(await total()).toBe('20.00');
    await f.exec('DROP TRIGGER fail_refund_bill ON user_bill; DROP FUNCTION fail_refund_bill()');
    expect(await finalizeStoreOrderRefund(container(), refundId, now)).toBe('completed');
    expect(await total()).toBe('0.00');
    expect((await buyer()).nowMoney).toBe('100.00');
  });

  it.each(['balance', 'provider'] as const)('serializes concurrent duplicate %s payments on independent backends', async mode => {
    await peers(async ([blocker, first, second]) => {
      await blocker.exec('BEGIN; SELECT uid FROM "user" WHERE uid=11 FOR SHARE');
      const a = outcome(pay(mode, first.db));
      await waitForFinanceBlock(f.db, first.pid, blocker.pid);
      const b = outcome(pay(mode, second.db));
      await waitForFinanceBlock(f.db, second.pid, first.pid);
      expect(await total()).toBe('0.00');
      await blocker.exec('COMMIT');
      expect(await a).toMatchObject({ ok: true, value: { outcome: 'paid' } });
      expect(await b).toMatchObject({ ok: true, value: { outcome: 'already-paid' } });
    });
    expect(await total()).toBe('20.00');
    expect(await f.db.select().from(storeOrderOutbox)).toHaveLength(1);
    expect((await buyer()).nowMoney).toBe(mode === 'balance' ? '80.00' : '100.00');
  });

  it.each(['commit', 'rollback'] as const)('holds a real provider payment behind qualification until reader %s', async finish => {
    await peers(async ([reader, payer]) => {
      await reader.exec('BEGIN; INSERT INTO store_order(id,uid,order_id,"unique") VALUES(502,11,\'business-502\',\'reader-key\'); SELECT uid FROM "user" WHERE uid=11 FOR SHARE');
      // This is the production qualification guard inside a real transaction,
      // not an HTTP checkout or provider signature verification claim.
      const txView: Pick<DbClient, 'select'> = { select: reader.db.select.bind(reader.db) };
      await assertCheckoutPaidOrderQualifications(txView, [{ uid: 11, thresholdCents: 1000, eligible: false }]);
      const paying = outcome(pay('provider', payer.db));
      await waitForFinanceBlock(f.db, payer.pid, reader.pid);
      await assertCheckoutPaidOrderQualifications(txView, [{ uid: 11, thresholdCents: 1000, eligible: false }]);
      await reader.exec(finish === 'commit' ? 'COMMIT' : 'ROLLBACK');
      expect(await paying).toMatchObject({ ok: true, value: { outcome: 'paid' } });
    });
    expect(await total()).toBe('20.00');
    expect(await f.db.select().from(storeOrder).where(eq(storeOrder.id, 502))).toHaveLength(finish === 'commit' ? 1 : 0);
  });

  it.each(['same', 'partial'] as const)('serializes %s refund executions after the user lock without double credit', async kind => {
    await pay('balance');
    const firstRefund = await apply(kind === 'same' ? 2 : 1);
    // Deliberately create a second pending partial row to exercise the executor's
    // cumulative guard independently of application admission/reuse policy.
    let secondId = firstRefund.refundId;
    if (kind === 'partial') {
      const [row] = await f.db.insert(storeOrderRefund).values({ uid: 11, storeOrderId: 501, orderId: 'parallel-partial',
        refundNum: 1, refundPrice: '10.00', applyType: 1, cartInfo: JSON.stringify([{ cartId: 701, cartNum: 1 }]) }).returning();
      secondId = row.id;
    }
    await peers(async ([blocker, first, second]) => {
      await blocker.exec('BEGIN; SELECT uid FROM "user" WHERE uid=11 FOR SHARE');
      const a = outcome(finalizeStoreOrderRefund(container(first.db), firstRefund.refundId, now));
      await waitForFinanceBlock(f.db, first.pid, blocker.pid);
      const b = outcome(finalizeStoreOrderRefund(container(second.db), secondId, now));
      await waitForFinanceBlock(f.db, second.pid, first.pid);
      expect(await total()).toBe('20.00');
      await blocker.exec('COMMIT');
      expect(await a).toEqual({ ok: true, value: 'completed' });
      expect(await b).toEqual({ ok: true, value: kind === 'same' ? 'already-completed' : 'completed' });
    });
    expect(await total()).toBe('0.00');
    expect((await buyer()).nowMoney).toBe('100.00');
    expect((await f.db.select().from(storeProduct))[0].stock).toBe(10);
    expect((await f.db.select().from(storeOrderCartInfo))[0].refundNum).toBe(2);
  });

  for (const direction of ['payment-first', 'refund-first'] as const) {
    it.each(['balance', 'provider'] as const)(`integrates actual pink create/payment/promotion with ${direction} %s lock ordering`, async mode => {
      const cache = new Map<string, string>();
      const env = { CONFIG_KV: {
        get: async (key: string) => key.startsWith('cfg_') ? '0' : cache.get(key) ?? null,
        put: async (key: string, value: string) => { cache.set(key, value); },
        delete: async (key: string) => { cache.delete(key); },
      } } as Env;
      await f.db.insert(user).values([22, 33].map(uid => ({ uid, nowMoney: '100.00' })));
      await f.db.update(storeProduct).set({ isShow: 1, isVerify: 1, price: '10.00' });
      await f.db.insert(models.systemStore).values({ id: 1, name: 'isolated pickup', isShow: 1, isStore: 1 });
      await f.db.insert(models.storeCombination).values({ id: 30, productId: 70, people: 6, effectiveTime: 24,
        stock: 20, quota: 20, onceNum: 3, num: 20, price: '6.25' });
      await f.db.insert(storeProductAttrValue).values({ id: 2, productId: 30, type: 3, unique: 'pink-sku',
        stock: 20, quota: 20, price: '6.25' });
      await f.db.insert(models.storeCart).values([1, 2, 3].map(id => ({ id, uid: id * 11, productId: 70,
        productAttrUnique: 'qa000001', cartNum: 1, type: 3, activityId: 30, isNew: 1, status: 1 })));
      const create = async (uid: number, cartId: number, pinkId = 0) => {
        await StoreOrderCreateService.createWithRuntime(container(),
          { CONFIG_KV: env.CONFIG_KV, nextOrderId: async () => `full-pink-${cartId}` },
          { uid, key: `full-pink-key-${cartId}`, cartIds: [cartId], type: 3, combinationId: 30, pinkId,
            shippingType: 2, storeId: 1, realName: 'isolated', userPhone: '00000000000', userIp: '127.0.0.1' });
        return (await f.db.select().from(storeOrder).where(eq(storeOrder.orderId, `full-pink-${cartId}`)))[0];
      };
      const leader = await create(11, 1);
      await applyStoreOrderBalancePayment(container(), { uid: 11, orderId: leader.orderId });
      const leaderPink = (await f.db.select().from(models.storePink).where(eq(models.storePink.uid, 11)))[0];
      const member = await create(22, 2, leaderPink.id);
      await applyStoreOrderBalancePayment(container(), { uid: 22, orderId: member.orderId });
      const successor = (await f.db.select().from(models.storePink).where(eq(models.storePink.uid, 22)))[0];
      const pending = await create(33, 3, leaderPink.id);
      const { refundId } = await applyOrderRefund(container(), { uid: 11, orderId: leader.orderId,
        refundReason: 'isolated pink refund', refundExplain: '', applyType: 1, applicationOrderId: 'full-pink-refund' });
      await peers(async ([blocker, first, second]) => {
        const payer = direction === 'payment-first' ? first : second;
        const refunder = direction === 'refund-first' ? first : second;
        await blocker.exec(`BEGIN; SELECT uid FROM "user" WHERE uid=${direction === 'payment-first' ? 33 : 11} FOR SHARE`);
        const payment = () => outcome(mode === 'balance'
          ? applyStoreOrderBalancePayment(container(payer.db), { uid: 33, orderId: pending.orderId })
          : applyStoreOrderPayment(container(payer.db), { orderId: pending.id, payType: 'weixin', tradeNo: 'synthetic-pink-trade' }));
        const refund = () => outcome(finalizeStoreOrderRefund(container(refunder.db), refundId));
        const a = direction === 'payment-first' ? payment() : refund();
        await waitForFinanceBlock(f.db, first.pid, blocker.pid);
        const b = direction === 'payment-first' ? refund() : payment();
        await waitForFinanceBlock(f.db, second.pid, first.pid);
        await blocker.exec('COMMIT');
        expect(await a).toMatchObject({ ok: true, value: direction === 'payment-first' ? { outcome: 'paid' } : 'completed' });
        expect(await b).toMatchObject({ ok: true, value: direction === 'refund-first' ? { outcome: 'paid' } : 'completed' });
      });
      expect((await f.db.select().from(storeOrder).where(eq(storeOrder.id, pending.id)))[0])
        .toMatchObject({ paid: 1, pinkId: successor.id });
      expect((await f.db.select().from(models.storePink).where(eq(models.storePink.id, successor.id)))[0])
        .toMatchObject({ kId: 0, status: 1, memberCount: 2 });
      expect((await buyer()).nowMoney).toBe('100.00');
      expect(await total()).toBe('0.00');
      expect((await f.db.select().from(storeProduct))[0].stock).toBe(6);
      expect((await f.db.select().from(models.storeCombination))[0]).toMatchObject({ stock: 18, quota: 18, sales: 2 });
      expect(await f.db.select().from(storeOrderOutbox)).toHaveLength(3);
      expect(await finalizeStoreOrderRefund(container(), refundId)).toBe('already-completed');
    }, 30_000);
  }
});
