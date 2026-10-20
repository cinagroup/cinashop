/** Actual type4 writers and Admin cap controller on an owned native PG16
 * column fixture. Historical count probes deliberately seed labelled legacy
 * headers, not fabricated payment/origin coverage. No provider or production
 * authentication/grant/complete-history claim. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import type { DbClient } from '../src/lib/di';
import { storeCart, storeIntegral, storeOrder,
  storeProduct, storeProductAttrValue, user, userBill } from '../src/models/schema';
import { ValidateException } from '../src/utils/errors';
import { cancelStoreOrder } from '../src/services/order/StoreOrderCreateService';
import { applyOrderRefund, finalizeStoreOrderRefund } from '../src/services/order/StoreOrderRefundService';
import { integralPurchaseLimitsFixture, type IntegralAuthor } from './helpers/integralPurchaseLimitsFixture';
import { outcome, waitForFinanceBlock, withFinancePeers } from './helpers/financePeers';

type Fixture = Awaited<ReturnType<typeof integralPurchaseLimitsFixture>>;
const authors = ['direct', 'create'] as const;
function rejected(value: Awaited<ReturnType<typeof outcome>>) {
  expect(value.ok).toBe(false);
  if (!value.ok) expect(value.error).toBeInstanceOf(ValidateException);
}

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('shared retained-root integral activity admission on native PostgreSQL16', () => {
  let f: Fixture;
  beforeEach(async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('External I/O forbidden in integral limits fixture'));
    f = await integralPurchaseLimitsFixture();
  }, 45_000);
  afterEach(async () => {
    try { expect(fetch).not.toHaveBeenCalled(); }
    finally { vi.restoreAllMocks(); await f?.close(); }
  }, 30_000);

  it.each(authors)('serializes a %s winner and the other author with different keys before any cart/resource mutation', async winner => {
    const loser: IntegralAuthor = winner === 'direct' ? 'create' : 'direct';
    const firstIntent = await f.prepare(winner), secondIntent = await f.prepare(loser);
    expect(firstIntent.key).not.toBe(secondIntent.key);
    await f.caps(-1, 1);
    const before = await f.state();
    const results = await withFinancePeers(f.db, async ([first, second, blocker]) => {
      await blocker.exec('BEGIN'); let open = true;
      await blocker.db.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`cinashop:integral-order:11:${f.integralId}`},0::bigint))`);
      try {
        const one = outcome(f.run(firstIntent, first.db));
        await waitForFinanceBlock(f.db, first.pid, blocker.pid);
        const two = outcome(f.run(secondIntent, second.db));
        await waitForFinanceBlock(f.db, second.pid, first.pid);
        const waiting = await f.db.execute(sql`SELECT pid FROM pg_locks WHERE locktype='advisory'
          AND NOT granted AND pid IN(${first.pid},${second.pid}) ORDER BY pid`);
        expect(waiting.map(row => row.pid).sort()).toEqual([first.pid, second.pid].sort());
        expect(await f.state()).toEqual(before);
        await blocker.exec('COMMIT'); open = false;
        return Promise.all([one, two]);
      } finally { if (open) await blocker.exec('ROLLBACK'); }
    });
    expect(results[0].ok).toBe(true); rejected(results[1]);
    expect(await f.retained()).toBe('1');
    const orders = await f.db.select().from(storeOrder);
    expect(orders).toHaveLength(1); expect(orders[0]).toMatchObject({ type: 4, totalNum: 1, paid: winner === 'direct' ? 1 : 0 });
    expect(await f.db.execute(sql`SELECT order_id FROM public.store_order_purchase_origin`)).toHaveLength(1);
    expect((await f.db.select().from(storeProduct).where(eq(storeProduct.id, 70)))[0]).toMatchObject({ stock: 19, sales: 1 });
    expect((await f.db.select().from(storeProductAttrValue).where(eq(storeProductAttrValue.id, 81)))[0]).toMatchObject({ stock: 11, sales: 1 });
    expect((await f.db.select().from(user).where(eq(user.uid, 11)))[0].integral).toBe(winner === 'direct' ? 90 : 100);
    const intent = firstIntent.cartId ? firstIntent : secondIntent;
    expect((await f.db.select().from(storeCart).where(eq(storeCart.id, intent.cartId!)))[0].isPay).toBe(winner === 'create' ? 1 : 0);
  }, 30_000);

  it.each(authors.flatMap(author => [{ author, cap: 'once' as const }, { author, cap: 'total' as const }]))
   ('rejects $author when the explicit PHP $cap cap is zero without consuming any resource', async ({ author, cap }) => {
      const intent = await f.prepare(author);
      await f.caps(cap === 'once' ? 0 : -1, cap === 'total' ? 0 : -1);
      const before = await f.state(); rejected(await outcome(f.run(intent)));
      expect(await f.state()).toEqual(before);
    }, 30_000);

  it.each(authors)('preserves cloned PHP zero defaults and permits repeated %s purchases only after explicit -1 configuration', async author => {
    expect(f.originalBatchCaps).toEqual({ onceNum: 0, num: 0 });
    await f.caps(-1, -1);
    await f.run(await f.prepare(author)); await f.run(await f.prepare(author));
    expect(await f.retained()).toBe('2');
    expect(await f.db.select().from(storeOrder)).toHaveLength(2);
    expect((await f.db.select().from(storeIntegral).where(eq(storeIntegral.id, f.integralId)))[0]).toMatchObject({ onceNum: -1, num: -1 });
  }, 30_000);

  it.each(authors)('enforces a finite exact %s boundary rather than treating zero or finite caps as unlimited', async author => {
    const tooMany = await f.prepare(author, 3), exact = await f.prepare(author, 2);
    await f.caps(2, 2);
    const before = await f.state(); rejected(await outcome(f.run(tooMany))); expect(await f.state()).toEqual(before);
    await f.run(exact); expect(await f.retained()).toBe('2');
    const order = (await f.db.select().from(storeOrder))[0]; expect(order.totalNum).toBe(2);
  }, 30_000);

  it.each(authors)('fails closed for a legacy invalid stored negative cap on the %s author', async author => {
    const intent = await f.prepare(author);
    await f.db.update(storeIntegral).set({ num: -2 }).where(eq(storeIntegral.id, f.integralId));
    const before = await f.state(); rejected(await outcome(f.run(intent))); expect(await f.state()).toEqual(before);
  }, 30_000);

  it('validates actual Admin cap edits as exact -1/0..int32 integers before SQL mutation', async () => {
    for (const patch of [{ onceNum: -2 }, { num: -2 }, { onceNum: 1.5 }, { num: '2' },
      { onceNum: null }, { num: 2147483648 }]) {
      const before = await f.state(), result = await f.adminCaps(patch);
      expect(result.status).toBe(400); expect(result.msg).not.toContain('Failed query');
      expect(await f.state()).toEqual(before);
    }
    expect((await f.adminCaps({ onceNum: 0, num: 0 })).status).toBe(200);
    expect((await f.adminCaps({ onceNum: -1, num: 2147483647 })).status).toBe(200);
  }, 30_000);

  it.each(authors)('counts hidden paid and active unpaid roots once on %s, excluding fulfillment children and foreign scopes', async author => {
    const intent = await f.prepare(author), second = await f.prepare(author);
    // Deliberate retained PHP/header fixtures. No payment, origin, allocation
    // or coverage certificate is fabricated for these legacy rows.
    const headers = [
      { id: 2001, paid: 1, isDel: 1, isSystemDel: 1, totalNum: 2 },
      { id: 2002, pid: -1, paid: 1, totalNum: 1, refundStatus: 2, refundType: 6 },
      { id: 2003, pid: 2002, paid: 1, totalNum: 99 },
      { id: 2004, paid: 0, isDel: 0, isSystemDel: 1, totalNum: 1 },
      { id: 2005, paid: 0, isDel: 1, totalNum: 88 },
      { id: 2006, paid: 1, uid: 22, totalNum: 77 },
      { id: 2007, paid: 1, activityId: f.integralId + 1000, totalNum: 66 },
      { id: 2008, paid: 1, type: 0, totalNum: 55 },
    ];
    await f.db.insert(storeOrder).values(headers.map(row => ({ uid: 11, type: 4,
      activityId: f.integralId, orderId: `legacy_cap_${row.id}`, unique: `legacy_cap_${row.id}`, ...row })));
    expect(await f.retained()).toBe('4'); await f.caps(-1, 5);
    await f.run(intent); expect(await f.retained()).toBe('5');
    const full = await f.state(); rejected(await outcome(f.run(second))); expect(await f.state()).toEqual(full);
    expect(await f.retained()).toBe('5');
  }, 30_000);

  it('releases an actually cancelled unpaid root but keeps a fully refunded paid root in PHP activity totals', async () => {
    const unpaidIntent = await f.prepare('create'), laterIntent = await f.prepare('create');
    await f.caps(-1, 1);
    const unpaid = await f.run(unpaidIntent); expect(await f.retained()).toBe('1');
    await cancelStoreOrder(f.container, { uid: 11, orderId: unpaid.orderId }); expect(await f.retained()).toBe('0');
    const paid = await f.run(await f.prepare('direct'));
    const [order] = await f.db.select().from(storeOrder).where(eq(storeOrder.orderId, paid.orderId));
    const original = await f.db.execute(sql`SELECT * FROM public.store_order_purchase_origin WHERE order_id=${order.id}`);
    const refund = await applyOrderRefund(f.container, { uid: 11, orderId: paid.orderId,
      applyType: 1, refundReason: 'owned PHP activity cap refund', refundExplain: '', applicationOrderId: 'activity_cap_refund' });
    expect(await finalizeStoreOrderRefund(f.container, refund.refundId)).toBe('completed');
    expect(await f.retained()).toBe('1');
    const before = await f.state(); rejected(await outcome(f.run(laterIntent))); expect(await f.state()).toEqual(before);
    expect(await f.db.execute(sql`SELECT * FROM public.store_order_purchase_origin WHERE order_id=${order.id}`)).toEqual(original);
    expect((await f.db.select().from(user).where(eq(user.uid, 11)))[0].integral).toBe(100);
    expect((await f.db.select().from(userBill)).filter(row => row.type === 'order_integral_refund')).toMatchObject([{ number: '10.00' }]);
  }, 30_000);

  it.each(authors)('rechecks actual Admin cap changes after %s has reached the shared admission wait', async author => {
    const intent = await f.prepare(author);
    await withFinancePeers(f.db, async ([buyer, admin, blocker]) => {
      await blocker.exec('BEGIN'); let open = true;
      await blocker.db.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`cinashop:integral-order:11:${f.integralId}`},0::bigint))`);
      try {
        const attempted = outcome(f.run(intent, buyer.db));
        await waitForFinanceBlock(f.db, buyer.pid, blocker.pid);
        expect((await f.adminCaps({ onceNum: -1, num: 0 }, admin.db)).status).toBe(200);
        const afterAdmin = await f.state();
        await blocker.exec('COMMIT'); open = false;
        rejected(await attempted); expect(await f.state()).toEqual(afterAdmin);
      } finally { if (open) await blocker.exec('ROLLBACK'); }
    });
  }, 30_000);

  it.each(authors)('rolls back a %s admission and origin when actual later SQL fails, leaving its finite slot reusable', async author => {
    const intent = await f.prepare(author); await f.caps(-1, 1); const before = await f.state();
    let observed = false;
    const transaction = f.db.transaction.bind(f.db);
    const intercept: typeof f.db.transaction = (fn, config) => transaction(async tx => {
      const result = await fn(tx);
      expect(await tx.execute(sql`SELECT total_num FROM public.store_order_purchase_origin`)).toMatchObject([{ total_num: 1 }]);
      const [count] = await tx.execute(sql`SELECT COALESCE(SUM(total_num),0)::text AS n FROM public.store_order
        WHERE uid=11 AND type=4 AND activity_id=${f.integralId} AND pid IN(0,-1) AND (paid=1 OR (paid=0 AND is_del=0))`);
      expect(count.n).toBe('1'); observed = true;
      await tx.execute(sql`SELECT 1/0`); return result;
    }, config);
    const failing = new Proxy(f.db, { get(target, key, receiver) { return key === 'transaction' ? intercept : Reflect.get(target, key, receiver); } }) as DbClient;
    expect((await outcome(f.run(intent, failing))).ok).toBe(false); expect(observed).toBe(true);
    expect(await f.state()).toEqual(before); expect(await f.retained()).toBe('0');
    await f.run(intent); expect(await f.retained()).toBe('1');
  }, 30_000);

  it.each(authors)('returns the acknowledged %s intent after caps close without a new admission or stock/points write', async author => {
    const intent = await f.prepare(author), first = await f.run(intent);
    await f.caps(0, 0); const before = await f.state();
    expect(await f.run(intent)).toEqual(first); expect(await f.state()).toEqual(before);
    expect(await f.retained()).toBe('1');
    expect(await f.db.select().from(storeOrder)).toHaveLength(1);
  }, 30_000);

  it.each(authors)('rejects an over-int32 retained total on %s as business capacity exhaustion without integer-cast overflow', async author => {
    const intent = await f.prepare(author);
    await f.db.insert(storeOrder).values([1, 2].map(n => ({ id: 3000 + n, uid: 11, type: 4,
      activityId: f.integralId, paid: 1, totalNum: 2147483647, orderId: `large_retained_${n}`, unique: `large_retained_${n}` })));
    expect(await f.retained()).toBe('4294967294'); await f.caps(-1, 2147483647);
    const before = await f.state(); rejected(await outcome(f.run(intent))); expect(await f.state()).toEqual(before);
  }, 30_000);
});
