/** Actual type0 cart/budget/checkout behavior on owned native PG16. Confirmation
 * uses the existing labelled controller shell; this is not JWT, production
 * grants, provider, full historical coverage or all-writer deadlock evidence. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { storeCart, storeProduct } from '../src/models/schema';
import { ApiException } from '../src/utils/errors';
import { productPurchaseAdmissionFixture, type ProductAdmissionReceipt } from './helpers/productPurchaseAdmissionFixture';
import { outcome, waitForFinanceBlock, withFinancePeers } from './helpers/financePeers';

type Fixture = Awaited<ReturnType<typeof productPurchaseAdmissionFixture>>;
type Rules = Pick<typeof storeProduct.$inferSelect, 'isLimit' | 'limitType' | 'limitNum'>;
const perOrder = (limitNum: number): Rules => ({ isLimit: 1, limitType: 1, limitNum });

async function businessRejection(work: Promise<unknown>, message?: RegExp) {
  const result = await outcome(work);
  expect(result.ok).toBe(false);
  if (!result.ok) {
    // A missing table, wrong transaction or raw constraint/query error must not
    // masquerade as successful enforcement of a business purchase contract.
    expect(result.error).toBeInstanceOf(ApiException);
    if (message) expect((result.error as Error).message).toMatch(message);
  }
}

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('base-product single-purchase admission on native PostgreSQL16', () => {
  let f: Fixture;
  beforeEach(async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Product admission tests forbid external I/O'));
    f = await productPurchaseAdmissionFixture();
  }, 45_000);
  afterEach(async () => {
    try { expect(fetch).not.toHaveBeenCalled(); }
    finally { vi.restoreAllMocks(); await f?.close(); }
  }, 30_000);
  const add = (quantity: number, unique = 'qared001', isNew = 0) => f.cart().add({
    uid: 11, productId: 70, unique, cartNum: quantity, isNew, type: 0,
  });
  const receipt = async (ids: number[]): Promise<ProductAdmissionReceipt> => {
    const result = await f.confirm(ids);
    expect(result.status, result.msg).toBe(200);
    if (!result.data) throw Error('Actual confirmation did not return its receipt');
    return result.data;
  };

  it('allows disabled rules through real add, read-only budget, confirmation and origin-bearing unpaid checkout', async () => {
    await f.limits({ isLimit: 0, limitType: 2, limitNum: 0 });
    const row = await add(3), before = await f.state(), kvWrites = f.writes.length;
    const budget = await f.compute([row.id]);
    expect(budget.deduction).toMatchObject({ type: 0, sum_price: 30, pay_price: 30 });
    expect(await f.state()).toEqual(before); expect(f.writes).toHaveLength(kvWrites);
    const confirmed = await receipt([row.id]);
    expect(await f.state()).toEqual(before);
    const created = await f.create([row.id], confirmed.orderKey, { receipt: confirmed });
    const after = await f.state();
    expect(after.orders).toMatchObject([{ orderId: created.orderId, type: 0, paid: 0, totalNum: 3, payPrice: '30.00' }]);
    expect(after.products[0].stock).toBe(37); expect(after.skus[0].stock).toBe(37);
    expect(after.details).toMatchObject([{ productId: 70, cartNum: 3 }]);
    expect(after.origins).toHaveLength(1);
    expect(after.origins[0]).toMatchObject({ order_id: after.orders[0].id, total_num: 3 });
    expect(after.carts.find(cart => cart.id === row.id)?.isPay).toBe(1);
    expect(after.carts.find(cart => cart.id === 1)?.isPay).toBe(0);
    expect(after.users[0].integral).toBe(100);
  }, 30_000);

  it('permits the finite exact quantity and rejects a larger direct-buy intent before any business write', async () => {
    await f.limits(perOrder(2));
    const before = await f.state();
    await businessRejection(add(3, 'qared001', 1), /限购|单次/);
    expect(await f.state()).toEqual(before);
    const created = await f.create([1]);
    const after = await f.state();
    expect(after.orders).toMatchObject([{ orderId: created.orderId, totalNum: 2 }]);
    expect(after.products[0].stock).toBe(38);
    expect(after.details).toMatchObject([{ productId: 70, cartNum: 2 }]);
  }, 30_000);

  it.each([{ label: 'different SKUs', unique: 'qablue02' }, { label: 'separate direct rows of the same SKU', unique: 'qared001' }])(
    'aggregates $label for selected-row reads, quotes and the final order instead of admitting each row separately', async ({ unique }) => {
      await f.limits(perOrder(3));
      const second = await add(2, unique, 1);
      expect(second.id).not.toBe(1);
      const ids = [1, second.id], before = await f.state();
      // The existing direct-buy scope rejects invalid selections as a whole;
      // ordinary cart mode below preserves the unavailable-row projection.
      await businessRejection(f.cart().list(11, { mode: 'buy', ids }));
      await businessRejection(f.quote(ids));
      const invalid = await f.confirm(ids); expect(invalid.status).not.toBe(200);
      await businessRejection(f.create(ids));
      expect(await f.state()).toEqual(before);
      await f.cart().setNum(11, second.id, 1);
      const confirmed = await receipt(ids);
      await f.create(ids, confirmed.orderKey, { receipt: confirmed });
      const after = await f.state();
      expect(after.orders).toMatchObject([{ totalNum: 3, paid: 0 }]);
      expect(after.details.reduce((sum, row) => sum + row.cartNum, 0)).toBe(3);
      expect(after.products[0].stock).toBe(37);
    }, 30_000);

  it('uses only the selected reusable rows for budgets, including a changed cap and two SKU rows', async () => {
    await f.db.update(storeCart).set({ isNew: 0 }).where(eq(storeCart.id, 1));
    await f.limits(perOrder(4));
    const second = await add(2, 'qablue02');
    expect((await f.compute([1, second.id])).deduction.sum_price).toBe(40);
    await f.limits(perOrder(3));
    const before = await f.state();
    expect((await f.compute([1])).deduction.sum_price).toBe(20);
    await businessRejection(f.compute([1, second.id]));
    expect(await f.state()).toEqual(before);
    await f.cart().setNum(11, second.id, 1);
    expect((await f.compute([1, second.id])).budget.selection.map(row => row.cartNum)).toEqual([2, 1]);
  }, 30_000);

  it('adds existing quantities across SKUs and replaces rather than adds the old quantity during set', async () => {
    await f.limits(perOrder(4));
    const first = await add(2), second = await add(2, 'qablue02');
    const full = await f.state();
    await businessRejection(add(1), /限购|单次/); expect(await f.state()).toEqual(full);
    await f.cart().setNum(11, first.id, 1);
    expect((await f.state()).carts.find(row => row.id === first.id)?.cartNum).toBe(1);
    const reduced = await f.state();
    await businessRejection(f.cart().setNum(11, second.id, 4), /限购|单次/);
    expect(await f.state()).toEqual(reduced);
    await f.cart().setNum(11, first.id, 2);
    expect((await f.state()).carts.filter(row => row.isNew === 0).reduce((sum, row) => sum + row.cartNum, 0)).toBe(4);
  }, 30_000);

  it('excludes foreign, paid, deleted, inactive, old-direct and other actor/store/type rows from the reusable basket', async () => {
    await f.limits(perOrder(2));
    const excluded = await Promise.all([
      { uid: 22 }, { isPay: 1 }, { isDel: 1 }, { status: 0 }, { isNew: 1 },
      { staffId: 91 }, { touristUid: 'other-tourist' }, { storeId: 7 }, { type: 4, activityId: 9 },
    ].map(patch => f.insertCart({ cartNum: 20, ...patch })));
    // No existing public reusable row: lookup must not accidentally merge a
    // same-SKU assisted/store row even though admission excluded its quantity.
    const current = await add(1);
    expect(excluded.map(row => row.id)).not.toContain(current.id);
    expect((await f.state()).carts.find(row => row.id === current.id))
      .toMatchObject({ uid: 11, staffId: 0, touristUid: '', storeId: 0, cartNum: 1, isNew: 0 });
    const merged = await add(1);
    expect(merged).toMatchObject({ id: current.id, cartNum: 2 });
    await f.cart().setNum(11, current.id, 2);
    const listed = await f.cart().list(11, { mode: 'cart' }) as Array<{ id: number; isValid: boolean }>;
    expect(listed.find(row => row.id === current.id)).toMatchObject({ isValid: true });
    expect((await f.compute([current.id])).deduction.sum_price).toBe(20);
    const before = await f.state();
    await businessRejection(add(1), /限购|单次/); expect(await f.state()).toEqual(before);
    for (const row of excluded) expect(before.carts.find(value => value.id === row.id)?.cartNum).toBe(20);
  }, 30_000);

  it('rejects cumulative mode at actual add, set, budget, quote, confirm and create while listing it as unavailable', async () => {
    await f.db.update(storeCart).set({ isNew: 0 }).where(eq(storeCart.id, 1));
    await f.limits({ isLimit: 1, limitType: 2, limitNum: 100 });
    const before = await f.state();
    await businessRejection(add(1), /累计限购/);
    await businessRejection(f.cart().setNum(11, 1, 1), /累计限购/);
    const listed = await f.cart().list(11, { mode: 'cart' }) as Array<{ isValid: boolean; productInfo: unknown }>;
    expect(listed).toMatchObject([{ isValid: false, productInfo: null }]);
    await businessRejection(f.compute([1]));
    await businessRejection(f.quote([1]), /累计限购/);
    expect((await f.confirm([1])).status).not.toBe(200);
    await businessRejection(f.create([1]), /累计限购/);
    expect(await f.state()).toEqual(before);
  }, 30_000);

  it('does not silently disable a persisted malformed enabled cap on write or calculation paths', async () => {
    await f.db.update(storeCart).set({ isNew: 0 }).where(eq(storeCart.id, 1));
    await f.limits({ isLimit: 1, limitType: 1, limitNum: 0 });
    const before = await f.state();
    await businessRejection(add(1), /限购配置/);
    await businessRejection(f.cart().setNum(11, 1, 1), /限购配置/);
    await businessRejection(f.compute([1]));
    await businessRejection(f.quote([1]), /限购配置/);
    await businessRejection(f.create([1]), /限购配置/);
    expect(await f.state()).toEqual(before);
  }, 30_000);

  it.each([
    { label: 'enable isLimit', initial: { isLimit: 0, limitType: 0, limitNum: 0 }, patch: perOrder(5) },
    { label: 'disable isLimit', initial: perOrder(5), patch: { isLimit: 0 } },
    { label: 'change limitType', initial: perOrder(5), patch: { limitType: 2 } },
    { label: 'change limitNum while quantity still fits', initial: perOrder(5), patch: { limitNum: 4 } },
  ])('rolls back every business write after a quoted $label edit at the nextOrderId boundary', async ({ initial, patch }) => {
    await f.limits(initial);
    const confirmed = await receipt([1]);
    let reached = 0, afterEdit: Awaited<ReturnType<Fixture['state']>> | undefined;
    await businessRejection(f.create([1], confirmed.orderKey, { receipt: confirmed, nextOrderId: async () => {
      reached++; await f.limits(patch); afterEdit = await f.state();
    } }));
    expect(reached).toBe(1); expect(afterEdit).toBeDefined();
    expect(await f.state()).toEqual(afterEdit);
  }, 30_000);

  it('keeps a disabled quote valid when only inactive legacy type and quantity residues change', async () => {
    const confirmed = await receipt([1]);
    await f.create([1], confirmed.orderKey, { receipt: confirmed,
      nextOrderId: async () => { await f.limits({ limitType: 2, limitNum: 1 }); } });
    expect((await f.state()).orders).toMatchObject([{ totalNum: 2, paid: 0 }]);
  }, 30_000);

  it('rechecks the product rules after a real product-row lock wait and rolls back any earlier claims', async () => {
    await f.limits(perOrder(5));
    const confirmed = await receipt([1]), before = await f.state();
    await withFinancePeers(f.db, async ([editor, buyer]) => {
      let open = false;
      const buying = outcome(f.create([1], confirmed.orderKey, { db: buyer.db, receipt: confirmed,
        nextOrderId: async () => {
          await editor.exec('BEGIN'); open = true;
          await f.limits({ limitNum: 4 }, editor.db);
        } }));
      try {
        await waitForFinanceBlock(f.db, buyer.pid, editor.pid);
        const [waiting] = await f.db.execute(sql`SELECT cardinality(pg_blocking_pids(${buyer.pid}::int))>0 AS blocked`);
        expect(waiting.blocked).toBe(true);
        await editor.exec('COMMIT'); open = false;
        const result = await buying;
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error).toBeInstanceOf(ApiException);
      } finally { if (open) await editor.exec('ROLLBACK'); }
    });
    expect(await f.state()).toEqual({ ...before, products: before.products.map(row => ({ ...row, limitNum: 4 })) });
  }, 30_000);

  it('replays the original successful order without a new claim after the product changes to cumulative mode', async () => {
    await f.limits(perOrder(2));
    const confirmed = await receipt([1]);
    const created = await f.create([1], confirmed.orderKey, { receipt: confirmed });
    await f.limits({ isLimit: 1, limitType: 2, limitNum: 1 });
    const before = await f.state(), sequence = vi.fn(async () => {});
    expect(await f.create([1], confirmed.orderKey, { receipt: confirmed, nextOrderId: sequence })).toEqual(created);
    expect(sequence).not.toHaveBeenCalled(); expect(await f.state()).toEqual(before);
  }, 30_000);

  it('serializes different-SKU reusable adds on the same product before mutation on independent backends', async () => {
    await f.limits(perOrder(1));
    const before = await f.state();
    const results = await withFinancePeers(f.db, async ([first, second, holder]) => {
      await holder.exec('BEGIN'); let open = true;
      await holder.db.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${'cinashop:product-cart:11:0::70:0'},0::bigint))`);
      try {
        const one = outcome(f.cart(first.db).add({ uid: 11, productId: 70, unique: 'qared001', cartNum: 1, isNew: 0, type: 0 }));
        await waitForFinanceBlock(f.db, first.pid, holder.pid);
        const two = outcome(f.cart(second.db).add({ uid: 11, productId: 70, unique: 'qablue02', cartNum: 1, isNew: 0, type: 0 }));
        await waitForFinanceBlock(f.db, second.pid, first.pid);
        const waiting = await f.db.execute(sql`SELECT pid FROM pg_locks WHERE locktype='advisory' AND NOT granted
          AND pid IN(${first.pid},${second.pid}) ORDER BY pid`);
        expect(waiting.map(row => row.pid).sort()).toEqual([first.pid, second.pid].sort());
        expect(await f.state()).toEqual(before);
        await holder.exec('COMMIT'); open = false;
        return Promise.all([one, two]);
      } finally { if (open) await holder.exec('ROLLBACK'); }
    });
    expect(results[0].ok).toBe(true); expect(results[1].ok).toBe(false);
    if (!results[1].ok) expect(results[1].error).toBeInstanceOf(ApiException);
    const after = await f.state(), basket = after.carts.filter(row => row.isNew === 0 && row.isPay === 0);
    expect(basket).toHaveLength(1); expect(basket[0]).toMatchObject({ productAttrUnique: 'qared001', cartNum: 1 });
    expect(after.products).toEqual(before.products); expect(after.skus).toEqual(before.skus);
    expect(after.orders).toEqual([]); expect(after.origins).toEqual([]);
  }, 30_000);

  it('applies the same product aggregate to actual assisted add and replacement quantities', async () => {
    await f.limits(perOrder(3));
    const scoped = { adminId: 91, uid: 11, touristUid: '', productId: 70, isNew: 0 };
    const first = await f.cart().addAssisted({ ...scoped, unique: 'qared001', cartNum: 2 });
    const second = await f.cart().addAssisted({ ...scoped, unique: 'qablue02', cartNum: 1 });
    await f.cart().setAssistedNum({ ...scoped, id: first.cartId, cartNum: 1 });
    await f.cart().setAssistedNum({ ...scoped, id: second.cartId, cartNum: 2 });
    const before = await f.state();
    await businessRejection(f.cart().addAssisted({ ...scoped, unique: 'qared001', cartNum: 1 }), /限购|单次/);
    await businessRejection(f.cart().setAssistedNum({ ...scoped, id: second.cartId, cartNum: 3 }), /限购|单次/);
    expect(await f.state()).toEqual(before);
    expect(before.carts.filter(row => row.staffId === 91).reduce((sum, row) => sum + row.cartNum, 0)).toBe(3);
  }, 30_000);

  it('keeps distinct assisted tourist baskets separate instead of sharing the uid0 quota', async () => {
    await f.limits(perOrder(2));
    const scoped = { adminId: 91, uid: 0, productId: 70, unique: 'qared001', cartNum: 2, isNew: 0 };
    const first = await f.cart().addAssisted({ ...scoped, touristUid: 'guest-one' });
    const second = await f.cart().addAssisted({ ...scoped, touristUid: 'guest-two' });
    expect(first.cartId).not.toBe(second.cartId);
    const before = await f.state();
    await businessRejection(f.cart().addAssisted({ ...scoped, touristUid: 'guest-one', unique: 'qablue02', cartNum: 1 }), /限购|单次/);
    expect(await f.state()).toEqual(before);
    expect(before.carts.filter(row => row.uid === 0)).toMatchObject([
      { touristUid: 'guest-one', cartNum: 2 }, { touristUid: 'guest-two', cartNum: 2 },
    ]);
  }, 30_000);

  it('confirms only the newly selected direct-buy intent after a cap reduction, excluding the old unpurchased intent', async () => {
    await f.limits(perOrder(2));
    const old = await add(2, 'qared001', 1), current = await add(1, 'qared001', 1);
    expect(old.id).not.toBe(current.id);
    await f.limits({ limitNum: 1 });
    const before = await f.state();
    const sequences = () => f.db.execute(sql`SELECT sequencename,last_value FROM pg_sequences
      WHERE schemaname='public' ORDER BY sequencename`);
    const beforeSequences = Array.from(await sequences());
    const confirm = async (cartIds: number[]) => {
      const response = await f.app.request('/api/order/confirm', { method: 'POST',
        headers: { 'content-type': 'application/json', 'x-fixture-user': '11' },
        body: JSON.stringify({ cartIds, type: 0, addressId: 11, shippingType: 1, useIntegral: false }),
      }, f.env);
      return response.json<{ status: number; msg: string; data: null | {
        priceGroup: { pay_price: string }; cartInfo: Array<{ id: string | number; cartNum: number }>;
      } }>();
    };
    const selected = await confirm([current.id]);
    expect(selected.status, selected.msg).toBe(200);
    expect(selected.data?.priceGroup.pay_price).toBe('10.00');
    expect(selected.data?.cartInfo).toHaveLength(1);
    expect(Number(selected.data?.cartInfo[0].id)).toBe(current.id);
    expect(selected.data?.cartInfo[0].cartNum).toBe(1);
    expect(await f.state()).toEqual(before); expect(Array.from(await sequences())).toEqual(beforeSequences);
    const all = await confirm([old.id, current.id]);
    expect(all.status).toBe(400); expect(all.msg).toMatch(/单次购买不能超过1件|限购|商品.*失效|重新选择/);
    const after = await f.state();
    expect(after).toEqual(before); expect(Array.from(await sequences())).toEqual(beforeSequences);
    expect(after.carts.find(row => row.id === old.id)).toMatchObject({ cartNum: 2, isNew: 1, isPay: 0 });
    expect(after.carts.find(row => row.id === current.id)).toMatchObject({ cartNum: 1, isNew: 1, isPay: 0 });
  }, 30_000);

  it('preserves the legacy200 selected-checkout boundary while buy mode remains limited to100 rows', async () => {
    await f.limits(perOrder(150));
    await f.db.update(storeProduct).set({ stock: 200 }).where(eq(storeProduct.id, 70));
    await f.db.execute(sql`UPDATE public.store_product_attr_value SET stock=200 WHERE product_id=70 AND type=0`);
    const ids: number[] = [];
    for (let index = 0; index < 101; index++) ids.push((await add(1, 'qared001', 1)).id);
    expect(new Set(ids).size).toBe(101);
    const before = await f.state();
    const sequences = () => f.db.execute(sql`SELECT sequencename,last_value FROM pg_sequences
      WHERE schemaname='public' ORDER BY sequencename`);
    const beforeSequences = Array.from(await sequences());
    const response = await f.app.request('/api/order/confirm', { method: 'POST',
      headers: { 'content-type': 'application/json', 'x-fixture-user': '11' },
      body: JSON.stringify({ cartIds: ids, type: 0, addressId: 11, shippingType: 1, useIntegral: false }),
    }, f.env);
    const selected = await response.json<{ status: number; msg: string; data: null | {
      priceGroup: { pay_price: string }; cartInfo: Array<{ cartNum: number }>;
    } }>();
    expect(selected.status, selected.msg).toBe(200);
    expect(selected.data?.priceGroup.pay_price).toBe('1010.00');
    expect(selected.data?.cartInfo).toHaveLength(101);
    expect(selected.data?.cartInfo.every(row => row.cartNum === 1)).toBe(true);
    await businessRejection(f.cart().list(11, { mode: 'buy', ids }), /请选择有效的立即购买商品/);
    // The missing IDs are intentional: length201 must be rejected before a
    // database existence/ownership result could be mistaken for this boundary.
    const oversized = [...ids, ...Array.from({ length: 100 }, (_, index) => 10_000 + index)];
    expect(oversized).toHaveLength(201);
    await businessRejection(f.cart().list(11, { mode: 'checkout', ids: oversized }), /请选择有效的立即购买商品/);
    expect(await f.state()).toEqual(before);
    expect(Array.from(await sequences())).toEqual(beforeSequences);
  }, 30_000);
});
