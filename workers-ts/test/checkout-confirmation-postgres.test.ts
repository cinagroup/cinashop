import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createContainerFromDb, withTx, type DbClient } from '../src/lib/di';
import { StoreOrderCreateService } from '../src/services/order/StoreOrderCreateService';
import { OrderQuoteReconfirmRequired } from '../src/services/order/CheckoutConfirmation';
import { createPcCheckoutQuoteFixture } from './helpers/pcCheckoutQuoteFixture';
import { storeOrderCartInfo, storeOrderStatus, printDocument, storeCouponIssue, storeCouponUser } from '../src/models/schema';
import { outcome, waitForFinanceBlock, waitForFinanceClock, withFinancePeers } from './helpers/financePeers';

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('checkout receipts on independent PostgreSQL backends', () => {
  let f: Awaited<ReturnType<typeof createPcCheckoutQuoteFixture>>;
  let sequence = 0;
  const input = { cartIds: [1], addressId: 11, shippingType: 1 };
  beforeEach(async () => {
    f = await createPcCheckoutQuoteFixture([storeOrderCartInfo, storeOrderStatus, printDocument, storeCouponIssue, storeCouponUser]);
    for (const key of Object.keys(f.config)) f.config[key] = '0';
  }, 30_000);
  afterEach(async () => { vi.restoreAllMocks(); await f?.close(); });
  const quote = async (key?: string, couponId?: number) => {
    const response = await f.app.request(key ? `/api/order/computed/${key}` : '/api/order/confirm', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-fixture-user': '11' }, body: JSON.stringify({ ...input, couponId }),
    }, f.env);
    const result = await response.json() as { status: number; data: { orderKey: string; quoteToken: string } };
    expect(result.status).toBe(200);
    return result.data;
  };
  const create = (db: DbClient, receipt: { orderKey: string; quoteToken: string }, couponId?: number) =>
    StoreOrderCreateService.createWithRuntime(createContainerFromDb(db), {
      CONFIG_KV: f.env.CONFIG_KV, requireConfirmation: true, nextOrderId: async () => `confirmation_pg_${++sequence}`,
    }, { ...input, couponId, uid: 11, key: receipt.orderKey, quoteToken: receipt.quoteToken, userIp: '127.0.0.1' });
  const state = async () => ({ ...await f.snapshot(), details: await f.db.select().from(storeOrderCartInfo),
    statuses: await f.db.select().from(storeOrderStatus), coupons: await f.db.select().from(storeCouponUser) });

  it.each(['minimum', 'invalidated', 'endTime', 'cosmetic'] as const)(
    'rechecks owned-coupon %s after actually waiting for its writer', async variant => {
      const startTime = new Date(Date.now() - 3_600_000), endTime = new Date(Date.now() + 3_600_000);
      await f.db.insert(storeCouponIssue).values({ id: 1, type: 1, couponType: 0 });
      await f.db.insert(storeCouponUser).values({ id: 41, uid: 11, issueCouponId: 1, couponPrice: '1.00', startTime, endTime });
      const receipt = await quote(undefined, 41), before = await state();
      const edit = variant === 'minimum' ? { useMinPrice: '1.00' } : variant === 'invalidated' ? { isFail: 1 }
        : variant === 'endTime' ? { endTime: new Date(endTime.getTime() + 1000) } : { couponTitle: '并发展示编辑' };
      await withFinancePeers(f.db, async ([editor, buyer]) => {
        await editor.exec('BEGIN');
        await editor.db.update(storeCouponUser).set(edit).where(eq(storeCouponUser.id, 41));
        const buying = outcome(create(buyer.db, receipt, 41));
        await waitForFinanceBlock(f.db, buyer.pid, editor.pid);
        await editor.exec('COMMIT');
        const result = await buying;
        expect(result.ok).toBe(variant === 'cosmetic');
        if (!result.ok) expect(result.error).toBeInstanceOf(OrderQuoteReconfirmRequired);
      });
      const after = await state();
      if (variant === 'cosmetic') {
        expect(after.orders).toHaveLength(1); expect(after.orders[0]).toMatchObject({ paid: 0, payPrice: '25.00' });
        expect(after.products[0].stock).toBe(6); expect(after.skus[0].stock).toBe(6);
        expect(after.coupons[0]).toMatchObject({ ...edit, status: 3 });
      } else expect(after).toEqual({ ...before, coupons: before.coupons.map(row => ({ ...row, ...edit })) });
    }, 15_000);

  it('rejects a coupon expiring on the database clock while reservation waits', async () => {
    const [clock] = await f.db.select({ millis: sql<string>`extract(epoch from clock_timestamp()) * 1000` }).from(sql`(values (1)) as probe(n)`);
    // Keep the observed expiry inside the production transaction's 2 s lock bound.
    const deadline = Math.floor(Number(clock.millis)) + 1500;
    await f.db.insert(storeCouponIssue).values({ id: 1, type: 1, couponType: 0 });
    await f.db.insert(storeCouponUser).values({ id: 41, uid: 11, issueCouponId: 1, couponPrice: '1.00', endTime: new Date(deadline) });
    const receipt = await quote(undefined, 41), before = await state();
    await withFinancePeers(f.db, async ([holder, buyer]) => {
      await holder.exec('BEGIN; SELECT id FROM store_coupon_user WHERE id=41 FOR UPDATE');
      const buying = outcome(create(buyer.db, receipt, 41));
      await waitForFinanceBlock(f.db, buyer.pid, holder.pid);
      await waitForFinanceClock(f.db, deadline);
      await holder.exec('COMMIT');
      const result = await buying;
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBeInstanceOf(OrderQuoteReconfirmRequired);
    });
    expect(await state()).toEqual(before);
  }, 15_000);

  it('serializes two immutable valid receipts for the same key into exactly one unpaid order', async () => {
    const a = await quote(), b = await quote(a.orderKey);
    expect(a.quoteToken).not.toBe(b.quoteToken);
    await withFinancePeers(f.db, async ([holder, first, second]) => {
      await holder.exec('BEGIN; SELECT pg_advisory_xact_lock(731642,1)');
      const buying = outcome(withTx(createContainerFromDb(first.db), async tx => {
        const result = await create(tx, a);
        await tx.execute(sql`SELECT pg_advisory_xact_lock(731642,1)`);
        return result;
      }));
      await waitForFinanceBlock(f.db, first.pid, holder.pid);
      const retrying = outcome(create(second.db, b));
      await waitForFinanceBlock(f.db, second.pid, first.pid);
      await holder.exec('COMMIT');
      const firstResult = await buying, secondResult = await retrying;
      expect(firstResult.ok).toBe(true); expect(secondResult).toEqual(firstResult);
    });
    const after = await state();
    expect(after.orders).toHaveLength(1); expect(after.orders[0]).toMatchObject({ paid: 0, payPrice: '26.00' });
    expect(after.products[0].stock).toBe(6); expect(after.skus[0].stock).toBe(6);
    expect(after.details).toHaveLength(1);
  }, 15_000);

  it('rejects expiration while waiting for admission and rolls back every business write', async () => {
    const receipt = await quote(), before = await state();
    const record = JSON.parse([...f.cache.entries()].find(([key]) => key.endsWith(`:${receipt.quoteToken}`))![1]);
    await withFinancePeers(f.db, async ([holder, buyer]) => {
      await holder.exec('BEGIN');
      await holder.db.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`cinashop:create-order:11:${receipt.orderKey}`}, 0::bigint))`);
      const buying = outcome(create(buyer.db, receipt));
      await waitForFinanceBlock(f.db, buyer.pid, holder.pid);
      vi.spyOn(Date, 'now').mockReturnValue(record.expiresAt * 1000);
      await holder.exec('COMMIT');
      const result = await buying;
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBeInstanceOf(OrderQuoteReconfirmRequired);
    });
    expect(await state()).toEqual(before);
  }, 15_000);
});
