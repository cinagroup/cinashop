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

// Actual Out author, ordinary cart and checkout share one owned PG16 database.
import { Hono } from 'hono';
import type { AppVariables, Env } from '@/env';
import { createContainerFromDb, type DbClient } from '@/lib/di';
import { storeProductCategory, storeProductAttrValue, storeProductRelation, outProductWriteReplay, storeOrderCartInfo, user } from '@/models/schema';
import { productCreate, productInfo, productUpdate } from '@/controllers/out/OutApiController';
import { normalizeOutPhysicalProductInput } from '@/services/out/OutProductService';
import { outRequestHash } from '@/services/out/OutIdempotency';
import { StoreCartService } from '@/services/order/StoreCartService';
import { StoreOrderCreateService } from '@/services/order/StoreOrderCreateService';
import { addPresaleCart } from '@/services/activity/PresaleCartService';
import { createPcCheckoutQuoteFixture } from './helpers/pcCheckoutQuoteFixture';
import { sequenceRunnerDatabase, type SequenceRunnerPeer } from './helpers/kefuSequenceRunnerDatabase';
import { completePurchaseOriginEvidenceOrm } from '@/migrations/runPurchaseOriginEvidence';
import { completePurchaseCancellationEvidenceOrm } from '@/migrations/runPurchaseCancellationEvidence';
import { runtimeBusinessPrivilegePlan } from '@/migrations/runtimeBusinessPrivilegePlan';
import { waitForFinanceClock } from './helpers/financePeers';

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('Out member-only product and ordinary purchase on owned PG16', () => {
  let f: Awaited<ReturnType<typeof createPcCheckoutQuoteFixture>>;
  let owned: Awaited<ReturnType<typeof sequenceRunnerDatabase>>;
  let network: ReturnType<typeof vi.spyOn>;
  let sequence = 0;
  const body = { product_type: 0, supplier_id: 0, cate_id: [9], store_name: 'Out member-only product',
    slider_image: ['/isolated.png'], delivery_type: [1], freight: 3, temp_id: 10, spec_type: 1, is_show: 1,
    items: [{ value: '颜色', detail: ['红色'] }, { value: '尺码', detail: ['大号'] }],
    attrs: [{ suk: '红色,大号', detail: { 颜色: '红色', 尺码: '大号' }, unique: 'qared001', price: '10.00', stock: 999, bar_code: 'OUT-A' }] };
  const app = (db: DbClient) => {
    const a = new Hono<{ Bindings: Env; Variables: AppVariables }>();
    a.use('*', async (c, next) => { c.set('container', createContainerFromDb(db));
      c.set('outInfo', { id: 7, appid: 'isolated-out-vip', title: 'isolated', rules: [] }); await next(); });
    a.onError((e, c) => c.json({ status: 400, msg: e.message, data: null }));
    a.post('/outapi/product', productCreate); a.put('/outapi/product/:id', productUpdate); a.get('/outapi/product/:id', productInfo);
    return a;
  };
  beforeEach(async () => {
    sequence = 0; network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Out VIP acceptance forbids external I/O'));
    f = await createPcCheckoutQuoteFixture([], async () => {
      owned = await sequenceRunnerDatabase();
      try { const api = await import('drizzle-kit/api'), schema = await import('@/models/schema');
        await owned.exec((await api.generateMigration(api.generateDrizzleJson({}), api.generateDrizzleJson(schema))).join('\n'));
        await completePurchaseOriginEvidenceOrm(owned.db); await completePurchaseCancellationEvidenceOrm(owned.db); return owned;
      } catch (error) { await owned.close(); throw error; }
    });
    await f.setConfig(Object.fromEntries(Object.keys(f.config).map(key => [key, '0'])));
    await f.setConfig({ member_card_status: '1', svip_price_status: '0' });
    await f.db.update(user).set({ isEverLevel: 0, isMoneyLevel: 0, overdueTime: 0 }).where(eq(user.uid, 11));
    await f.db.insert(storeProductCategory).values({ id: 9, cateName: 'isolated', isShow: 1 });
    await f.db.update(storeProduct).set({ cateId: '9', specType: 1 }).where(eq(storeProduct.id, 70));
    await f.db.update(storeProductAttrValue).set({ barCode: 'OUT-A' }).where(eq(storeProductAttrValue.id, 1));
    await f.db.insert(storeProductRelation).values({ productId: 70, relationId: 9, type: 1, status: 1 });
    await f.exec("SELECT setval(pg_get_serial_sequence('store_cart','id'),1,true)");
  }, 120_000);
  afterEach(async () => { try { expect(network).not.toHaveBeenCalled(); } finally { network?.mockRestore(); await f?.close(); } }, 120_000);
  const request = async (db: DbClient, data?: object, key = crypto.randomUUID(), path = '/outapi/product/70', method = 'PUT') => {
    const response = await app(db).request(path, { method, headers: { 'content-type': 'application/json', 'Idempotency-Key': key },
      ...(data ? { body: JSON.stringify(data) } : {}) }, f.env);
    return response.json() as Promise<{ status: number; msg: string; data: any }>;
  };
  const state = async () => ({ ...await f.snapshot(), replays: await f.db.select().from(outProductWriteReplay), relations: await f.db.select().from(storeProductRelation),
    details: await f.db.select().from(storeOrderCartInfo) });
  const cart = (db = f.db) => new StoreCartService(createContainerFromDb(db), f.env);
  const add = (db = f.db) => cart(db).add({ uid: 11, productId: 70, unique: 'qared001', cartNum: 1, type: 0, isNew: 1 });
  const peers = async (run: (peers: [SequenceRunnerPeer, SequenceRunnerPeer, SequenceRunnerPeer]) => Promise<void>) => {
    const connect = owned.withPeer; if (!connect) throw Error('Dedicated PG16 peers required');
    await connect(a => connect(b => connect(c => run([a, b, c]))));
  };
  const confirm = async (cartId = 1) => {
    const selection = { cartIds: [cartId], type: 0, addressId: 11, shippingType: 1, useIntegral: false };
    const response = await f.app.request('/api/order/confirm', { method: 'POST', headers: { 'content-type': 'application/json', 'x-fixture-user': '11' },
      body: JSON.stringify(selection) }, f.env);
    return { ...(await response.json() as { status: number; msg: string; data: { orderKey: string; quoteToken: string } }), selection };
  };
  const create = (db: DbClient, receipt: Awaited<ReturnType<typeof confirm>>) => StoreOrderCreateService.createWithRuntime(createContainerFromDb(db),
    { CONFIG_KV: f.env.CONFIG_KV, requireConfirmation: true, requirePurchaseOrigin: true, nextOrderId: async () => `out_vip_local_${++sequence}` },
    { ...receipt.selection, uid: 11, key: receipt.data.orderKey, quoteToken: receipt.data.quoteToken, userIp: '127.0.0.1' });
  const member = () => f.db.update(user).set({ isEverLevel: 0, isMoneyLevel: 1, overdueTime: Math.floor(Date.now() / 1000) + 3600 }).where(eq(user.uid, 11));

  it('authors the flag, blocks nonmembers, and permits a real ordinary purchase without requiring member-price discounts', async () => {
    const key = crypto.randomUUID(), data = { ...body, is_vip_product: 1 };
    const saved = await request(f.db, data, key); expect(saved.status, saved.msg).toBe(200);
    const detail = await request(f.db, undefined, crypto.randomUUID(), '/outapi/product/70', 'GET');
    expect(detail.status, detail.msg).toBe(200); expect(detail.data.productInfo.is_vip_product).toBe(1);
    const omitted = await request(f.db, body); expect(omitted.status, omitted.msg).toBe(200);
    expect((await f.db.select().from(storeProduct).where(eq(storeProduct.id, 70)))[0].isVipProduct).toBe(1);
    const before = await state(), sequenceBefore = await f.exec('SELECT last_value,is_called FROM store_cart_id_seq');
    await expect(add()).rejects.toThrow('付费会员'); expect(await state()).toEqual(before);
    expect(await f.exec('SELECT last_value,is_called FROM store_cart_id_seq')).toEqual(sequenceBefore);
    expect((await confirm()).status).not.toBe(200);
    await member(); const selected = await add(); const receipt = await confirm(selected.id); expect(receipt.status, receipt.msg).toBe(200);
    const created = await create(f.db, receipt), after = await state();
    expect(after.orders.find(row => row.orderId === created.orderId)).toMatchObject({ type: 0, paid: 0 });
    expect(after.details).toHaveLength(1);
    const replay = await request(f.db, data, key); expect(replay.status, replay.msg).toBe(200); expect(replay.data.idempotent).toBe(true);
    await f.exec("SELECT setval(pg_get_serial_sequence('store_product','id'),70,true); SELECT setval(pg_get_serial_sequence('store_product_attr_value','id'),1,true)");
    const added = await request(f.db, data, crypto.randomUUID(), '/outapi/product', 'POST'); expect(added.status, added.msg).toBe(200);
    expect((await f.db.select().from(storeProduct).where(eq(storeProduct.id, added.data.id)))[0].isVipProduct).toBe(1);
  }, 30_000);

  it('checks current qualification on ordinary add, quantity and SKU-edit paths and allows cleanup', async () => {
    expect((await request(f.db, { ...body, is_vip_product: 1 })).status).toBe(200);
    await f.db.update(storeCart).set({ isNew: 0 }).where(eq(storeCart.id, 1));
    for (const scenario of ['nonmember', 'expired', 'disabled-feature'] as const) {
      await f.db.update(user).set(scenario === 'nonmember' ? { isEverLevel: 0, isMoneyLevel: 0, overdueTime: 0 }
        : { isEverLevel: 0, isMoneyLevel: 1, overdueTime: Math.floor(Date.now() / 1000) + (scenario === 'expired' ? -60 : 3600) }).where(eq(user.uid, 11));
      await f.setConfig({ member_card_status: scenario === 'disabled-feature' ? '0' : '1' });
      const before = await state();
      await expect(add()).rejects.toThrow();
      await expect(cart().setNum(11, 1, 1)).rejects.toThrow();
      await expect(cart().setProductQuantityLegacy({ uid: 11, productId: 70, unique: 'qared001', cartNum: 1, mode: 1 })).rejects.toThrow();
      await expect(cart().setNormalNumByProductLegacy(11, 70, 1)).rejects.toThrow();
      await expect(cart().resetLegacyV2({ uid: 11, id: 1, productId: 70, unique: 'qared001', cartNum: 1 })).rejects.toThrow();
      expect((await confirm()).status).not.toBe(200); expect(await state()).toEqual(before);
      expect(await cart().list(11, { mode: 'cart' })).toMatchObject([{ id: 1, isValid: false, productInfo: null }]);
      expect(await cart().listLegacyV2(11, { includeInvalid: true })).toMatchObject([{ id: 1, is_valid: 0 }]);
      expect(await cart().listLegacyV2(11)).toEqual([]);
    }
    await f.setConfig({ member_card_status: '1' }); await f.db.update(user).set({ isEverLevel: 1, isMoneyLevel: 0, overdueTime: 0 }).where(eq(user.uid, 11));
    expect(await cart().list(11, { mode: 'cart' })).toMatchObject([{ id: 1, isValid: true }]);
    expect(await cart().listLegacyV2(11, { includeInvalid: true })).toMatchObject([{ id: 1, is_valid: 1 }]);
    expect((await add()).cartNum).toBe(1);
    await f.db.update(user).set({ isEverLevel: 0 }).where(eq(user.uid, 11));
    expect(await cart().setProductQuantityLegacy({ uid: 11, productId: 70, unique: 'qared001', cartNum: 9, mode: 0 })).toMatchObject({ deleted: true });
  }, 30_000);

  it('preserves an already authorized assisted guest cart projection without granting ordinary guest purchase', async () => {
    expect((await request(f.db, { ...body, is_vip_product: 1 })).status).toBe(200);
    const [guest] = await f.db.insert(storeCart).values({ uid: 0, staffId: 101, touristUid: 'isolated-guest',
      productId: 70, productAttrUnique: 'qared001', cartNum: 1, type: 0, isNew: 0, status: 1 }).returning();
    expect(await cart().projectLegacyV2Rows(0, [guest])).toMatchObject([{ id: guest.id, is_valid: 1 }]);
    await expect(cart().add({ uid: 0, productId: 70, unique: 'qared001', cartNum: 1, type: 0, isNew: 1 })).rejects.toThrow('付费会员');
  });

  it('rolls back an ordinary cart update if membership is revoked during a real cart-row wait', async () => {
    await member(); expect((await request(f.db, { ...body, is_vip_product: 1 })).status).toBe(200);
    await f.db.update(storeCart).set({ isNew: 0 }).where(eq(storeCart.id, 1));
    await peers(async ([holder, buyer, editor]) => {
      await holder.exec('BEGIN; SELECT id FROM store_cart WHERE id=1 FOR UPDATE');
      const pending = outcome(cart(buyer.db).add({ uid: 11, productId: 70, unique: 'qared001', cartNum: 1, type: 0, isNew: 0 }));
      let holding = true;
      try {
        await waitForFinanceBlock(f.db, buyer.pid, holder.pid);
        await editor.db.update(user).set({ isMoneyLevel: 0 }).where(eq(user.uid, 11));
        const before = await state(); await holder.exec('COMMIT'); holding = false; const result = await pending;
        expect(result.ok).toBe(false); if (!result.ok) expect(result.error.message).toMatch(/会员|资格/);
        expect(await state()).toEqual(before);
      } finally { if (holding) await holder.exec('ROLLBACK'); await pending; }
    });
  }, 20_000);

  it('reconfirms quotes on either change of the member-only flag and preserves ignored-empty receipt boundaries', async () => {
    await member(); const normal = await confirm(); expect(normal.status, normal.msg).toBe(200);
    expect((await request(f.db, { ...body, is_vip_product: 1 })).status).toBe(200);
    let before = await state(); await expect(create(f.db, normal)).rejects.toThrow(); expect(await state()).toEqual(before);
    const vip = await confirm(); expect(vip.status, vip.msg).toBe(200);
    expect((await request(f.db, { ...body, is_vip_product: 0 })).status).toBe(200);
    before = await state(); await expect(create(f.db, vip)).rejects.toThrow(); expect(await state()).toEqual(before);
    const key = crypto.randomUUID(), old = normalizeOutPhysicalProductInput(body), hash = await outRequestHash({ operation: 'product_update', productId: 70, input: old });
    await f.db.insert(outProductWriteReplay).values({ outAccountId: 7, operation: 'product_update', requestKey: key, requestHash: hash, productId: 70 });
    before = await state(); const conflict = await request(f.db, { ...body, is_vip_product: 0 }, key); expect(conflict.status).not.toBe(200); expect(await state()).toEqual(before);
  }, 30_000);

  it('keeps the established presale membership rule when Out authors both flags', async () => {
    await f.setConfig({ member_card_status: '0' });
    const start = Math.floor(Date.now() / 1000) + 2, end = start + 3600;
    const saved = await request(f.db, { ...body, is_vip_product: 1, is_presale_product: 1, presale_time: [start, end], presale_day: 1 });
    expect(saved.status, saved.msg).toBe(200); await waitForFinanceClock(f.db, start * 1000);
    const selection = { uid: 11, productId: 70, unique: 'qared001', cartNum: 1, type: 6, isNew: 1 };
    const before = await state(); await expect(addPresaleCart(f.container, selection)).rejects.toThrow('付费会员'); expect(await state()).toEqual(before);
    await f.db.update(user).set({ isEverLevel: 1 }).where(eq(user.uid, 11));
    expect((await addPresaleCart(f.container, selection)).cartNum).toBe(1);
  }, 20_000);

  it.each(['revoke', 'disable-feature', 'expire'] as const)('rolls back after a real SKU wait when member eligibility changes: %s', async kind => {
    await member(); expect((await request(f.db, { ...body, is_vip_product: 1 })).status).toBe(200);
    if (kind === 'expire') {
      const [clock] = await f.db.select({ millis: sql<string>`extract(epoch from clock_timestamp()) * 1000` }).from(sql`(VALUES (1)) AS probe(n)`);
      await f.db.update(user).set({ overdueTime: Math.ceil((Number(clock.millis) + 700) / 1000) }).where(eq(user.uid, 11));
    }
    const receipt = await confirm(); expect(receipt.status, receipt.msg).toBe(200);
    await peers(async ([holder, buyer, editor]) => {
      await holder.exec('BEGIN; SELECT id FROM store_product_attr_value WHERE id=1 FOR UPDATE');
      const pending = outcome(create(buyer.db, receipt));
      let holding = true;
      try {
        await waitForFinanceBlock(f.db, buyer.pid, holder.pid);
        if (kind === 'revoke') await editor.db.update(user).set({ isMoneyLevel: 0 }).where(eq(user.uid, 11));
        else if (kind === 'disable-feature') await editor.db.execute(sql`UPDATE system_config SET value='0' WHERE menu_name='member_card_status' AND is_store=0`);
        else { const [account] = await f.db.select({ until: user.overdueTime }).from(user).where(eq(user.uid, 11)); await waitForFinanceClock(f.db, account.until * 1000); }
        const before = await state(); await holder.exec('COMMIT'); holding = false; const result = await pending;
        expect(result.ok).toBe(false); if (!result.ok) expect(result.error.message).toMatch(/会员|资格|重新确认/);
        expect(await state()).toEqual(before);
      } finally { if (holding) await holder.exec('ROLLBACK'); await pending; }
    });
  }, 20_000);

  it('rejects checkout if a separate writer changes the product restriction while its SKU is locked', async () => {
    await member(); const receipt = await confirm(); expect(receipt.status, receipt.msg).toBe(200);
    await peers(async ([holder, buyer, editor]) => {
      await holder.exec('BEGIN; SELECT id FROM store_product_attr_value WHERE id=1 FOR UPDATE');
      const pending = outcome(create(buyer.db, receipt));
      let holding = true;
      try {
        await waitForFinanceBlock(f.db, buyer.pid, holder.pid);
        await editor.db.update(storeProduct).set({ isVipProduct: 1 }).where(eq(storeProduct.id, 70));
        const before = await state(); await holder.exec('COMMIT'); holding = false; const result = await pending;
        expect(result.ok).toBe(false); expect(await state()).toEqual(before);
      } finally { if (holding) await holder.exec('ROLLBACK'); await pending; }
    });
  }, 20_000);

  it('rolls back source and receipt if deferred triggers change or rewrite the flag', async () => {
    const before = await state();
    for (const mutation of ['is_vip_product=0', 'is_vip_product=is_vip_product']) {
      await f.exec(`CREATE FUNCTION test_out_vip_damage() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN UPDATE store_product SET ${mutation} WHERE id=70; RETURN NEW; END $$; CREATE CONSTRAINT TRIGGER test_out_vip_damage AFTER INSERT ON out_product_write_replay DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION test_out_vip_damage()`);
      const failed = await request(f.db, { ...body, is_vip_product: 1 }); expect(failed.status).not.toBe(200); expect(await state()).toEqual(before);
      await f.exec('DROP TRIGGER test_out_vip_damage ON out_product_write_replay; DROP FUNCTION test_out_vip_damage()');
    }
  }, 30_000);

  it('writes, selects and checks out an entitled product with existing restricted App privileges', async () => {
    if (!owned.withRuntimeRole) throw Error('Native restricted LOGIN required');
    await f.db.update(user).set({ isEverLevel: 1 }).where(eq(user.uid, 11));
    await owned.withRuntimeRole(async runtime => {
      const plan = runtimeBusinessPrivilegePlan('app'), quote = (name: string) => {
        if (!/^[a-z_][a-z_0-9]*$/.test(name)) throw Error('Invalid owned grant identifier'); return `"${name}"`;
      };
      const tables = await f.db.execute<{ name: string }>(sql`SELECT relname AS name FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind='r' ORDER BY relname`);
      for (const { name } of tables) { const rights = plan.tables[name]; if (!rights) continue;
        await f.exec(`GRANT ${rights.join(',')} ON public.${quote(name)} TO ${quote(runtime.role)}`);
        const columns = plan.updateColumns[name]; if (columns?.length) await f.exec(`GRANT UPDATE(${columns.map(quote).join(',')}) ON public.${quote(name)} TO ${quote(runtime.role)}`);
      }
      const sequences = await f.db.execute<{ table_name: string; sequence_name: string | null }>(sql`SELECT c.relname AS table_name,
        pg_get_serial_sequence('public.'||quote_ident(c.relname),a.attname) AS sequence_name FROM pg_class c
        JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped WHERE c.relnamespace='public'::regnamespace AND c.relkind='r'`);
      for (const row of sequences) if (row.sequence_name && plan.tables[row.table_name]?.includes('INSERT')) {
        const parts = row.sequence_name.split('.'); if (parts.length !== 2 || parts[0] !== 'public') throw Error('Unexpected owned sequence');
        await f.exec(`GRANT USAGE ON SEQUENCE public.${quote(parts[1])} TO ${quote(runtime.role)}`);
      }
      expect(plan.functions).toContain('checkout_lock_pricing_v1()');
      await f.exec(`GRANT EXECUTE ON FUNCTION public.checkout_lock_pricing_v1() TO ${quote(runtime.role)}`);
      const saved = await request(runtime.db, { ...body, is_vip_product: 1 }); expect(saved.status, saved.msg).toBe(200);
      const selected = await add(runtime.db); expect(selected.cartNum).toBe(1);
      const receipt = await confirm(selected.id); expect(receipt.status, receipt.msg).toBe(200);
      const created = await create(runtime.db, receipt);
      expect((await f.db.select().from(storeOrderCartInfo)).find(row => row.oid > 0)?.oid).toBeGreaterThan(0);
      expect(created.orderId).toContain('out_vip_local_');
      const [rights] = await runtime.db.execute(sql`SELECT current_user=session_user AS direct_login,
        has_table_privilege(current_user,'public.system_config','UPDATE') AS config_write,
        has_table_privilege(current_user,'public.member_right','UPDATE') AS rights_write`);
      expect(rights).toEqual({ direct_login: true, config_write: false, rights_write: false });
    });
  }, 30_000);
});

// Authenticated Out catalogue reads exercise legacy filters on actual PG16.
import { beforeAll, afterAll } from 'vitest';
import { liveGoods, outAccount, outInterface } from '@/models/schema';
import { productList as outProductListController } from '@/controllers/out/OutApiController';
import { outAuthMiddleware } from '@/middleware/out-auth';
import { createToken, md5 } from '@/utils/jwt';
import { OutApiService } from '@/services/out/OutApiService';
import { StoreProductService } from '@/services/product/StoreProductService';

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('authenticated Out product list native PG16', () => {
  let f: Awaited<ReturnType<typeof createPcCheckoutQuoteFixture>>;
  let owned: Awaited<ReturnType<typeof sequenceRunnerDatabase>>;
  let network: ReturnType<typeof vi.spyOn>;
  let app: Hono<{Bindings: Env; Variables: AppVariables}>;
  let testEnv: Env, token: string;
  const ids = (result: {list: Record<string, unknown>[]}) => result.list.map(row => Number(row.id));
  const list = (query: Record<string, unknown> = {}) => new OutApiService(f.container, testEnv).productList(query);
  beforeAll(async () => {
    network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Out catalogue test forbids external I/O'));
    f = await createPcCheckoutQuoteFixture([], async () => {
      owned = await sequenceRunnerDatabase();
      try { const api = await import('drizzle-kit/api'), schema = await import('@/models/schema');
        await owned.exec((await api.generateMigration(api.generateDrizzleJson({}), api.generateDrizzleJson(schema))).join('\n'));
        await completePurchaseOriginEvidenceOrm(owned.db); await completePurchaseCancellationEvidenceOrm(owned.db); return owned;
      } catch (error) { await owned.close(); throw error; }
    });
    await f.db.insert(storeProduct).values([
      {id:71,storeName:'会员预售',isShow:1,isVerify:1,isVipProduct:1,isPresaleProduct:1,sort:71},
      {id:72,storeName:'会员常规',isShow:1,isVerify:1,isVipProduct:1,sort:72},
      {id:73,storeName:'常规预售',isShow:1,isVerify:1,isPresaleProduct:1,sort:73},
      {id:74,storeName:'待审核',isShow:1,isVerify:0,sort:74},
      {id:75,storeName:'已下架',isShow:0,isVerify:1,sort:75},
      {id:76,storeName:'已删除',isShow:1,isVerify:1,isDel:1,sort:76},
      {id:77,storeName:'供应商品',isShow:1,isVerify:1,type:2,relationId:42,sort:77},
    ]);
    await f.db.insert(storeProductCategory).values([
      {id:9,cateName:'一级',pid:0,level:0,path:''}, {id:10,cateName:'二级',pid:9,level:1,path:'9'},
      {id:11,cateName:'三级',pid:10,level:2,path:'9,10'},
    ]);
    await f.db.insert(storeProductRelation).values([
      {productId:70,relationId:9,type:1}, {productId:71,relationId:10,type:1}, {productId:72,relationId:11,type:1},
      {productId:71,relationId:4,type:3}, {productId:72,relationId:4,type:3}, {productId:73,relationId:7,type:3},
    ]);
    await f.db.insert(liveGoods).values([{productId:71,auditStatus:0,isDel:0}, {productId:72,auditStatus:3,isDel:0},
      {productId:73,auditStatus:0,isDel:1}]);
    await f.db.insert(storeProductAttrValue).values({id:2,productId:72,unique:'qlist072',suk:'测试',barCode:'SAMPLE-EXACT'});
    await f.db.insert(outInterface).values({id:1,type:1,method:'GET',url:'/product/list'});
    await f.db.insert(outAccount).values({id:1,appid:'out-catalog-local',appsecret:'fixture-only-catalog-secret',rules:'[1]'});
    testEnv = {...f.env, APP_KEY:'isolated-local-key-not-a-real-credential', TOKEN_BUCKET:{getByName:() => ({consumeRateLimit:async () =>
      ({allowed:true,auditEvent:false,limit:120,remaining:119,resetAt:Date.now()+60000})})}} as unknown as Env;
    token = (await createToken(1,'out',md5('fixture-only-catalog-secret'),testEnv.APP_KEY)).token;
    app = new Hono<{Bindings: Env; Variables: AppVariables}>();
    app.use('*', async (c,next) => {c.set('container', f.container); await next();});
    app.onError((error,c) => c.json({status:400,msg:error.message,data:null}));
    app.get('/outapi/product/list',outAuthMiddleware('GET','/product/list'),outProductListController);
  }, 180_000);
  afterAll(async () => { try { expect(network).not.toHaveBeenCalled(); } finally { network?.mockRestore(); await f?.close(); } }, 60_000);

  it('uses the real token and permission boundary and includes VIP products by default', async () => {
    const denied = await app.request('/outapi/product/list',{},testEnv);
    expect((await denied.json() as {status:number}).status).not.toBe(200);
    const response = await app.request('/outapi/product/list',{headers:{Authorization:`Bearer ${token}`}},testEnv);
    const json = await response.json() as {status:number;msg:string;data:{list:Record<string,unknown>[];count:number;pages_url:string}};
    expect(json.status,json.msg).toBe(200); expect(ids(json.data)).toEqual([77,73,72,71,70]);
    expect(json.data.count).toBe(5); expect(json.data.pages_url).toBe('/pages/goods/goods_list/index');
    expect(json.data.list.find(row => row.id===71)?.pages_url).toBe('/pages/goods_details/index?id=71');
  },30_000);
  it('combines membership, presale, relation labels and live exclusions before counting and pagination', async () => {
    expect(ids(await list({is_vip_product:'1'}))).toEqual([72,71]);
    expect(ids(await list({is_vip_product:'0',is_presale_product:'1'}))).toEqual([73]);
    expect(ids(await list({is_vip_product:'1',store_label_id:'4',is_live:'1'}))).toEqual([72]);
    expect(ids(await list({is_new:'1'}))).toEqual([72,71]);
    const page = await list({store_label_id:'4',page:'2',limit:'1'});
    expect(page.count).toBe(2); expect(ids(page)).toEqual([71]);
  },30_000);
  it('matches category descendants and exact SKU barcode without writing search history', async () => {
    expect(ids(await list({cate_id:'9'}))).toEqual([72,71,70]);
    expect(ids(await list({cate_id:'10'}))).toEqual([72,71]);
    expect(ids(await list({cate_id:'11'}))).toEqual([72]);
    expect(ids(await list({store_name:'SAMPLE-EXACT'}))).toEqual([72]);
    expect(ids(await list({store_name:'SAMPLE'}))).toEqual([]);
    const [history] = await f.db.execute<{count:number}>(sql`SELECT count(*)::int AS count FROM user_search`);
    expect(history.count).toBe(0);
  },30_000);
  it('honours status while preserving the legacy explicit show and delete predicates', async () => {
    expect(ids(await list({type:'0'}))).toEqual([74]);
    expect(ids(await list({type:''}))).toEqual([77,74,73,72,71,70]);
    expect(ids(await list({type:'2'}))).toEqual([]);
  },30_000);
  it('keeps the anonymous storefront restricted while the authenticated Out list includes VIP items', async () => {
    const storefront = await new StoreProductService(f.container,testEnv).getGoodsList({},0);
    expect(ids(storefront)).toEqual([73,70]);
    expect(ids(await list({is_vip_product:'1'}))).toEqual([72,71]);
  },30_000);
  it('performs the actual authenticated read using only the existing App SELECT grants', async () => {
    if (!owned.withRuntimeRole) throw Error('Native restricted LOGIN required');
    await owned.withRuntimeRole(async runtime => {
      const plan = runtimeBusinessPrivilegePlan('app');
      const quote = (name: string) => { if (!/^[a-z_][a-z_0-9]*$/.test(name)) throw Error('Invalid owned grant identifier'); return `"${name}"`; };
      const tables = await f.db.execute<{name:string}>(sql`SELECT relname AS name FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind='r'`);
      for (const {name} of tables) if (plan.tables[name]?.includes('SELECT'))
        await f.exec(`GRANT SELECT ON public.${quote(name)} TO ${quote(runtime.role)}`);
      const restricted = new Hono<{Bindings: Env; Variables: AppVariables}>();
      restricted.use('*',async (c,next) => {c.set('container',createContainerFromDb(runtime.db)); await next();});
      restricted.onError((error,c) => c.json({status:400,msg:error.message,data:null}));
      restricted.get('/outapi/product/list',outAuthMiddleware('GET','/product/list'),outProductListController);
      const response = await restricted.request('/outapi/product/list?is_vip_product=1&is_live=1',
        {headers:{Authorization:`Bearer ${token}`}},testEnv);
      const json = await response.json() as {status:number;msg:string;data:{list:Record<string,unknown>[]}};
      expect(json.status,json.msg).toBe(200); expect(ids(json.data)).toEqual([72]);
      const [rights] = await runtime.db.execute(sql`SELECT current_user=session_user AS direct_login,
        has_table_privilege(current_user,'public.user_search','INSERT') AS history_insert`);
      expect(rights).toEqual({direct_login:true,history_insert:false});
    });
  },30_000);
});

// Complete authenticated Out list projection uses the same owned PG16 snapshot.
describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('Out product list complete projection on owned PG16', () => {
  let f: Awaited<ReturnType<typeof createPcCheckoutQuoteFixture>>;
  let owned: Awaited<ReturnType<typeof sequenceRunnerDatabase>>;
  let network: ReturnType<typeof vi.spyOn>;
  let app: Hono<{Bindings: Env; Variables: AppVariables}>;
  let testEnv: Env, token: string;
  const request = async (db = f.db) => {
    const service = new OutApiService(createContainerFromDb(db),testEnv);
    const result = await service.productList({store_name:'完整报价隔离样本'});
    expect(result.count).toBe(1);
    return result.list[0] as Record<string,any>;
  };
  beforeAll(async () => {
    network = vi.spyOn(globalThis,'fetch').mockRejectedValue(Error('Out projection tests forbid external I/O'));
    f = await createPcCheckoutQuoteFixture([],async () => {
      owned = await sequenceRunnerDatabase();
      try { const api = await import('drizzle-kit/api'), schema = await import('@/models/schema');
        await owned.exec((await api.generateMigration(api.generateDrizzleJson({}),api.generateDrizzleJson(schema))).join('\n'));
        await completePurchaseOriginEvidenceOrm(owned.db); await completePurchaseCancellationEvidenceOrm(owned.db); return owned;
      } catch (error) { await owned.close(); throw error; }
    });
    await f.exec(`INSERT INTO store_product_category(id,cate_name,pid,level,is_show,path) VALUES (9,'根类',0,0,1,''),(10,'子类',9,1,0,'9');
      INSERT INTO store_product_label(id,label_name,type,relation_id,is_show) VALUES (21,'旧标签',0,0,0),(22,'别的归属',2,44,1);
      UPDATE store_product SET cate_id='9,10',store_label_id='21,22',label_id='31,32',ensure_id='8',price='13.25',vip_price='7.50',ot_price='18.00',postage='2.50',cost='3.25',give_integral='1.50',sales=5,ficti=12,custom_form='[{"id":"form"}]',specs='[{"name":"参数"}]',slider_image='["/isolated.png"]',delivery_type='1,2',video_open=0,video_link='/legacy-video.mp4' WHERE id=70;
      INSERT INTO store_product_description(product_id,type,description) VALUES (70,0,'<p>旧版商品描述</p>');
      UPDATE store_product_attr_value SET price='11.23',cost='4.20',disk_info='virtual-reference' WHERE id=1;
      INSERT INTO store_product_attr_value(id,product_id,"unique",suk,is_retired,retired_at,type) VALUES (2,70,'retire02','已退役',1,10,0),(3,70,'other003','活动规格',0,0,1);
      INSERT INTO store_product_virtual(product_id,attr_unique,card_no,card_pwd) VALUES (70,'qared001','fixture-card-number','fixture-card-password')`);
    await f.db.insert(outInterface).values({id:1,type:1,method:'GET',url:'/product/list'});
    await f.db.insert(outAccount).values({id:1,appid:'projection-local',appsecret:'fixture-only-projection-secret',rules:'[1]'});
    testEnv = {...f.env,APP_KEY:'isolated-local-key-not-a-real-credential',TOKEN_BUCKET:{getByName:() => ({consumeRateLimit:async () =>
      ({allowed:true,auditEvent:false,limit:120,remaining:119,resetAt:Date.now()+60000})})}} as unknown as Env;
    token = (await createToken(1,'out',md5('fixture-only-projection-secret'),testEnv.APP_KEY)).token;
    app = new Hono<{Bindings: Env; Variables: AppVariables}>();
    app.use('*',async(c,next)=>{c.set('container',f.container);await next();});
    app.onError((error,c)=>c.json({status:400,msg:error.message,data:null}));
    app.get('/outapi/product/list',outAuthMiddleware('GET','/product/list'),outProductListController);
  },180_000);
  afterAll(async () => {try {expect(network).not.toHaveBeenCalled();} finally {network?.mockRestore();await f?.close();}},60_000);
  it('returns legacy raw product, category, label, description and complete type-0 SKU values through real authorization',async () => {
    const response=await app.request('/outapi/product/list?store_name=%E5%AE%8C%E6%95%B4%E6%8A%A5%E4%BB%B7%E9%9A%94%E7%A6%BB%E6%A0%B7%E6%9C%AC',
      {headers:{Authorization:`Bearer ${token}`}},testEnv);
    const body=await response.json() as {status:number;msg:string;data:{list:Array<Record<string,any>>;count:number}};
    expect(body.status,body.msg).toBe(200); expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(body.data.count).toBe(1);const row=body.data.list[0];
    expect(row).toMatchObject({id:70,price:13.25,vip_price:7.5,ot_price:18,postage:2.5,cost:3.25,give_integral:1.5,
      sales:5,card_sales:17,cate_id:'9,10',cate_name:'根类,根类/子类',label_id:[31,32],store_label_id:[21,22],
      ensure_id:[8],store_label:'旧标签',delivery_type:['1','2'],custom_form:[{id:'form'}],specs:[{name:'参数'}],
      description:'<p>旧版商品描述</p>',video_open:0,video_link:'/legacy-video.mp4'});
    expect(row.attrValue).toHaveLength(1);
    expect(row.attrValue[0]).toMatchObject({id:1,product_id:70,unique:'qared001',price:'11.23',cost:'4.20',disk_info:'virtual-reference',is_retired:0});
    expect(row.retired_attr_value).toMatchObject([{id:2,unique:'retire02',is_retired:1,retired_at:10}]);
    expect(JSON.stringify(row)).not.toContain('other003');
    expect(JSON.stringify(row)).not.toContain('fixture-card-number');expect(JSON.stringify(row)).not.toContain('fixture-card-password');
  },30_000);
  it('uses only actual App SELECT grants and returns the complete projection through the authenticated route',async () => {
    if(!owned.withRuntimeRole) throw Error('Native restricted LOGIN required');
    await owned.withRuntimeRole(async runtime => {
      const plan=runtimeBusinessPrivilegePlan('app'),quote=(name:string)=>{if(!/^[a-z_][a-z_0-9]*$/.test(name))throw Error('invalid identifier');return `"${name}"`;};
      const tables=await f.db.execute<{name:string}>(sql`SELECT relname AS name FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind='r'`);
      for(const {name} of tables) if(plan.tables[name]?.includes('SELECT')) await f.exec(`GRANT SELECT ON public.${quote(name)} TO ${quote(runtime.role)}`);
      await f.exec(`REVOKE ALL ON public.store_product_virtual FROM ${quote(runtime.role)}`);
      const a=new Hono<{Bindings:Env;Variables:AppVariables}>();a.use('*',async(c,next)=>{c.set('container',createContainerFromDb(runtime.db));await next();});
      a.onError((error,c)=>c.json({status:400,msg:error.message,data:null}));a.get('/outapi/product/list',outAuthMiddleware('GET','/product/list'),outProductListController);
      const response=await a.request('/outapi/product/list',{headers:{Authorization:`Bearer ${token}`}},testEnv);
      const body=await response.json() as {status:number;msg:string;data:{list:Array<Record<string,any>>}};
      expect(body.status,body.msg).toBe(200);expect(body.data.list[0]).toMatchObject({cost:3.25,description:'<p>旧版商品描述</p>'});
      expect(body.data.list[0].attrValue).toHaveLength(1);expect(body.data.list[0].retired_attr_value).toHaveLength(1);
      const [rights]=await runtime.db.execute(sql`SELECT current_user=session_user AS direct_login,has_table_privilege(current_user,'public.store_product','UPDATE') AS can_write`);
      expect(rights).toEqual({direct_login:true,can_write:false});
      await expect(runtime.db.execute(sql`SELECT card_no,card_pwd FROM public.store_product_virtual`)).rejects.toThrow();
    });
  },30_000);
  it('keeps product, SKU and description on one repeatable-read snapshot during concurrent replacement',async () => {
    if(!owned.withPeer) throw Error('PG16 peers required');
    await owned.withPeer(holder=>owned.withPeer!(async reader=>{
      await holder.exec('BEGIN; LOCK TABLE store_product_description IN ACCESS EXCLUSIVE MODE');
      const pending=request(reader.db);
      try {
        await waitForFinanceBlock(f.db,reader.pid,holder.pid);
        await holder.exec("UPDATE store_product SET price='99.00' WHERE id=70; UPDATE store_product_attr_value SET price='88.00' WHERE id=1; UPDATE store_product_description SET description='<p>新内容</p>' WHERE product_id=70 AND type=0");
      } finally {await holder.exec('COMMIT');}
      const old=await pending;expect(old.price).toBe(13.25);expect(old.attrValue[0].price).toBe('11.23');expect(old.description).toBe('<p>旧版商品描述</p>');
      const current=await request(reader.db);expect(current.price).toBe(99);expect(current.attrValue[0].price).toBe('88.00');expect(current.description).toBe('<p>新内容</p>');
    }));
  },30_000);
  it('returns null for a missing bound description and empty collections for a product without SKU rows',async () => {
    await f.exec("INSERT INTO store_product(id,store_name,is_show,is_verify) VALUES (71,'无描述规格隔离商品',1,1)");
    try {
      const data=await new OutApiService(f.container,testEnv).productList({store_name:'无描述规格隔离商品'});
      expect(data.count).toBe(1);expect(data.list[0]).toMatchObject({description:null,attrValue:[],retired_attr_value:[],
        cate_name:'',store_label:'',slider_image:null,custom_form:[],specs:[]});
      await f.exec('INSERT INTO store_product_description(product_id,type,description) VALUES (71,0,NULL)');
      const nullDescription=await new OutApiService(f.container,testEnv).productList({store_name:'无描述规格隔离商品'});
      expect(nullDescription.list[0]).toMatchObject({description:null});
    } finally {await f.exec('DELETE FROM store_product_description WHERE product_id=71; DELETE FROM store_product WHERE id=71');}
  },30_000);
  it('rejects an oversized complete response before materializing the description rather than returning a partial list',async () => {
    await f.exec("UPDATE store_product_description SET description=repeat('长',1500000) WHERE product_id=70 AND type=0");
    const response=await app.request('/outapi/product/list',{headers:{Authorization:`Bearer ${token}`}},testEnv);
    const body=await response.json() as {status:number;msg:string;data:unknown};
    expect(body.status).not.toBe(200);expect(body.msg).toContain('容量');expect(body.data).toBeNull();
    const [row]=await f.db.execute<{size:number}>(sql`SELECT octet_length(description)::int AS size FROM store_product_description WHERE product_id=70 AND type=0`);
    expect(row.size).toBe(4500000);
  },30_000);
});

// Out authors and synchronizes ordinary manual virtual products on owned PG16.
import { productSetShow, productStockUpload } from '@/controllers/out/OutApiController';
describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('Out manual virtual product actual author and checkout',()=>{
  let f:Awaited<ReturnType<typeof createPcCheckoutQuoteFixture>>;
  let owned:Awaited<ReturnType<typeof sequenceRunnerDatabase>>;
  let network:ReturnType<typeof vi.spyOn>,testEnv:Env,token:string;
  const input={product_type:3,cate_id:[9],store_name:'手工虚拟测试商品',slider_image:['/isolated.png'],
    delivery_type:[],freight:3,temp_id:999,postage:'99.00',spec_type:0,is_show:1,
    brand_id:[31],ensure_id:[91],store_label_id:[101],label_id:[201],specs_id:301,specs:[{name:'版本',value:'数字'}],
    coupon_ids:[],custom_form:[],system_form_id:0,
    attrs:[{price:'10.00',stock:5,bar_code:'VIRTUAL-ONE'}]};
  const app=(db:DbClient)=>{
    const a=new Hono<{Bindings:Env;Variables:AppVariables}>();
    a.use('*',async(c,next)=>{c.set('container',createContainerFromDb(db));await next();});
    a.onError((e,c)=>c.json({status:400,msg:e.message,data:null}));
    a.post('/outapi/product',outAuthMiddleware('POST','/product'),productCreate);
    a.put('/outapi/product/stock/upload',outAuthMiddleware('PUT','/product/stock/upload'),productStockUpload);
    a.put('/outapi/product/set_show/:id/:is_show',outAuthMiddleware('PUT','/product/set_show/{id}/{is_show}'),productSetShow);
    a.put('/outapi/product/:id',outAuthMiddleware('PUT','/product/{id}'),productUpdate);
    return a;
  };
  const call=async(db:DbClient,path:string,method:string,data:object,key=crypto.randomUUID())=>{
    const response=await app(db).request(path,{method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json','Idempotency-Key':key},body:JSON.stringify(data)},testEnv);
    return response.json() as Promise<{status:number;msg:string;data:any}>;
  };
  const create=async(db=f.db,key=crypto.randomUUID())=>call(db,'/outapi/product','POST',input,key);
  beforeEach(async()=>{
    network=vi.spyOn(globalThis,'fetch').mockRejectedValue(Error('Out manual virtual test forbids external I/O'));
    f=await createPcCheckoutQuoteFixture([],async()=>{
      owned=await sequenceRunnerDatabase();try{const api=await import('drizzle-kit/api'),schema=await import('@/models/schema');
        await owned.exec((await api.generateMigration(api.generateDrizzleJson({}),api.generateDrizzleJson(schema))).join('\n'));
        await completePurchaseOriginEvidenceOrm(owned.db);await completePurchaseCancellationEvidenceOrm(owned.db);return owned;
      }catch(error){await owned.close();throw error;}
    });
    await f.exec(`INSERT INTO store_product_category(id,cate_name,is_show) VALUES (9,'隔离分类',1);
      INSERT INTO store_brand(id,brand_name,is_show) VALUES (31,'隔离品牌',1);
      INSERT INTO store_product_ensure(id,name,status) VALUES (91,'隔离保障',1);
      INSERT INTO category(id,"group",name,is_show) VALUES (300,2,'标签组',1),(301,3,'参数模板',1);
      INSERT INTO store_product_label(id,label_name,label_cate,status,is_show) VALUES (101,'隔离商品标签',300,1,1);
      INSERT INTO user_label(id,name,status) VALUES (201,'隔离用户标签',1);
      INSERT INTO out_interface(id,type,method,url) VALUES (1,1,'POST','/product'),(2,1,'PUT','/product/{id}'),
        (3,1,'PUT','/product/stock/upload'),(4,1,'PUT','/product/set_show/{id}/{is_show}');
      INSERT INTO out_account(id,appid,appsecret,rules) VALUES (1,'manual-local','fixture-manual-secret','[1,2,3,4]');
      SELECT setval(pg_get_serial_sequence('store_product','id'),70,true);
      SELECT setval(pg_get_serial_sequence('store_product_attr_value','id'),1,true);
      SELECT setval(pg_get_serial_sequence('store_cart','id'),1,true)`);
    testEnv={...f.env,APP_KEY:'isolated-local-key-not-a-real-credential',TOKEN_BUCKET:{getByName:()=>({consumeRateLimit:async()=>
      ({allowed:true,auditEvent:false,limit:120,remaining:119,resetAt:Date.now()+60000})})}} as unknown as Env;
    token=(await createToken(1,'out',md5('fixture-manual-secret'),testEnv.APP_KEY)).token;
  },120_000);
  afterEach(async()=>{try{expect(network).not.toHaveBeenCalled();}finally{network?.mockRestore();await f?.close();}},60_000);
  it('creates, replays, updates without replacing stock, synchronizes stock and makes a genuine non-logistics checkout',async()=>{
    const key=crypto.randomUUID(),first=await create(f.db,key);expect(first.status,first.msg).toBe(200);const id=Number(first.data.id);
    const replay=await create(f.db,key);expect(replay.status,replay.msg).toBe(200);expect(replay.data).toMatchObject({id,idempotent:true});
    let [product]=await f.db.execute<any>(sql`SELECT id,product_type,delivery_type,freight,temp_id,postage,stock FROM store_product WHERE id=${id}`);
    let [sku]=await f.db.execute<any>(sql`SELECT id,product_type,"unique",stock,bar_code FROM store_product_attr_value WHERE product_id=${id} AND type=0`);
    expect(product).toMatchObject({product_type:3,delivery_type:'',freight:2,temp_id:0,postage:'0.00',stock:5});
    expect(sku).toMatchObject({product_type:3,stock:5,bar_code:'VIRTUAL-ONE'});
    const relations=await f.db.execute<{type:number;relation_id:number}>(sql`SELECT type,relation_id FROM store_product_relation WHERE product_id=${id} ORDER BY type`);
    expect(relations).toEqual([{type:1,relation_id:9},{type:2,relation_id:31},{type:3,relation_id:101},
      {type:4,relation_id:201},{type:5,relation_id:91},{type:6,relation_id:301}]);
    const edited={...input,store_name:'手工虚拟已编辑',attrs:[{...input.attrs[0],stock:999,unique:sku.unique}]};
    const updated=await call(f.db,`/outapi/product/${id}`,'PUT',edited);expect(updated.status,updated.msg).toBe(200);expect(updated.data.stock_preserved).toBe(true);
    for(const show of [0,1]){const result=await call(f.db,`/outapi/product/set_show/${id}/${show}`,'PUT',{});expect(result.status,result.msg).toBe(200);}
    const synced=await call(f.db,'/outapi/product/stock/upload','PUT',{items:[{bar_code:'VIRTUAL-ONE',qty:7}]});expect(synced.status,synced.msg).toBe(200);
    [product]=await f.db.execute<any>(sql`SELECT product_type,stock FROM store_product WHERE id=${id}`);
    [sku]=await f.db.execute<any>(sql`SELECT product_type,"unique",stock FROM store_product_attr_value WHERE product_id=${id} AND type=0`);
    expect(product).toMatchObject({product_type:3,stock:7});expect(sku).toMatchObject({product_type:3,stock:7});
    const cart=await new StoreCartService(f.container,f.env).add({uid:11,productId:id,unique:sku.unique,cartNum:2,isNew:1,type:0});
    const selection={cartIds:[cart.id],type:0,addressId:11,shippingType:1,useIntegral:false};
    const response=await f.app.request('/api/order/confirm',{method:'POST',headers:{'content-type':'application/json','x-fixture-user':'11'},body:JSON.stringify(selection)},f.env);
    const confirmed=await response.json() as {status:number;msg:string;data:{orderKey:string;quoteToken:string}};expect(confirmed.status,confirmed.msg).toBe(200);
    const order=await StoreOrderCreateService.createWithRuntime(f.container,{CONFIG_KV:f.env.CONFIG_KV,requireConfirmation:true,requirePurchaseOrigin:true,
      nextOrderId:async()=>`manual_virtual_${id}`},{...selection,uid:11,key:confirmed.data.orderKey,quoteToken:confirmed.data.quoteToken,userIp:'127.0.0.1'});
    const [saved]=await f.db.execute<any>(sql`SELECT product_type,shipping_type,pay_postage,paid,total_num FROM store_order WHERE order_id=${order.orderId}`);
    expect(saved).toMatchObject({product_type:3,shipping_type:1,pay_postage:'0.00',paid:0,total_num:2});
    const [finalSku]=await f.db.execute<any>(sql`SELECT stock FROM store_product_attr_value WHERE product_id=${id} AND type=0`);expect(finalSku.stock).toBe(5);
  },30_000);
  it('rejects changes of product type, virtual card data, presale and mismatched replay without changing business rows',async()=>{
    const key=crypto.randomUUID(),created=await create(f.db,key);expect(created.status,created.msg).toBe(200);const id=Number(created.data.id);
    const [sku]=await f.db.execute<any>(sql`SELECT "unique" FROM store_product_attr_value WHERE product_id=${id} AND type=0`);
    const before=await f.snapshot();const [receiptBefore]=await f.db.execute<{n:number}>(sql`SELECT count(*)::int AS n FROM out_product_write_replay`);
    for(const body of [{...input,product_type:0,delivery_type:[1],freight:1}, {...input,is_presale_product:1},
      {...input,attrs:[{...input.attrs[0],virtual_list:[{card_no:'fake'}]}]}, {...input,attrs:[{...input.attrs[0],disk_info:'unsupported'}]}]){
      const result=await call(f.db,`/outapi/product/${id}`,'PUT',{...body,attrs:body.attrs.map(row=>({...row,unique:sku.unique}))});expect(result.status).not.toBe(200);
    }
    const conflict=await call(f.db,'/outapi/product','POST',{...input,store_name:'不同请求'},key);expect(conflict.status).not.toBe(200);
    expect(await f.snapshot()).toEqual(before);const [receiptAfter]=await f.db.execute<{n:number}>(sql`SELECT count(*)::int AS n FROM out_product_write_replay`);expect(receiptAfter).toEqual(receiptBefore);
  },30_000);
  it('rolls back the complete author transaction when a deferred trigger changes fulfillment type',async()=>{
    await f.exec(`CREATE FUNCTION test_out_manual_change() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN UPDATE store_product SET product_type=0 WHERE id=NEW.product_id; RETURN NEW; END $$;
      CREATE CONSTRAINT TRIGGER test_out_manual_change AFTER INSERT ON out_product_write_replay DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION test_out_manual_change()`);
    const before=await f.snapshot(),result=await create();expect(result.status).not.toBe(200);expect(result.msg).toContain('变化');expect(await f.snapshot()).toEqual(before);
    const [receipt]=await f.db.execute<{n:number}>(sql`SELECT count(*)::int AS n FROM out_product_write_replay`);expect(receipt.n).toBe(0);
  },30_000);
  it('rejects an editor race while a peer holds the actual SKU row, without changing business state',async()=>{
    const created=await create();expect(created.status,created.msg).toBe(200);const id=Number(created.data.id);
    const [sku]=await f.db.execute<any>(sql`SELECT id,"unique" FROM store_product_attr_value WHERE product_id=${id} AND type=0`);
    const before=await f.snapshot();if(!owned.withPeer)throw Error('PG16 peers required');
    await owned.withPeer(async peer=>{await peer.exec(`BEGIN; SELECT id FROM store_product_attr_value WHERE id=${Number(sku.id)} FOR UPDATE`);
      try{const result=await call(f.db,`/outapi/product/${id}`,'PUT',{...input,attrs:[{...input.attrs[0],unique:sku.unique}]});expect(result.status).not.toBe(200);expect(result.msg).toContain('变化');}
      finally{await peer.exec('ROLLBACK');}});
    expect(await f.snapshot()).toEqual(before);
  },30_000);
  it('rejects editing a historical manual product whose SKU has a conflicting fulfillment type',async()=>{
    const created=await create();expect(created.status,created.msg).toBe(200);const id=Number(created.data.id);
    const [sku]=await f.db.execute<any>(sql`SELECT id,"unique" FROM store_product_attr_value WHERE product_id=${id} AND type=0`);
    await f.exec(`UPDATE store_product_attr_value SET product_type=0 WHERE id=${Number(sku.id)}`);const before=await f.snapshot();
    const result=await call(f.db,`/outapi/product/${id}`,'PUT',{...input,attrs:[{...input.attrs[0],unique:sku.unique}]});
    expect(result.status).not.toBe(200);expect(result.msg).toContain('不一致');expect(await f.snapshot()).toEqual(before);
  },30_000);
  it('uses the existing restricted App LOGIN to create and synchronize a manual virtual product',async()=>{
    if(!owned.withRuntimeRole)throw Error('Native restricted LOGIN required');
    await owned.withRuntimeRole(async runtime=>{
      const plan=runtimeBusinessPrivilegePlan('app'),quote=(name:string)=>{if(!/^[a-z_][a-z_0-9]*$/.test(name))throw Error('Invalid owned identifier');return `"${name}"`;};
      const tables=await f.db.execute<{name:string}>(sql`SELECT relname AS name FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind='r' ORDER BY relname`);
      for(const {name} of tables){const rights=plan.tables[name];if(!rights)continue;await f.exec(`GRANT ${rights.join(',')} ON public.${quote(name)} TO ${quote(runtime.role)}`);
        const columns=plan.updateColumns[name];if(columns?.length)await f.exec(`GRANT UPDATE(${columns.map(quote).join(',')}) ON public.${quote(name)} TO ${quote(runtime.role)}`);}
      const seqs=await f.db.execute<{table_name:string;sequence_name:string|null}>(sql`SELECT c.relname AS table_name,pg_get_serial_sequence('public.'||quote_ident(c.relname),a.attname) AS sequence_name FROM pg_class c JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped WHERE c.relnamespace='public'::regnamespace AND c.relkind='r'`);
      for(const row of seqs)if(row.sequence_name&&plan.tables[row.table_name]?.includes('INSERT')){const parts=row.sequence_name.split('.');if(parts.length!==2||parts[0]!=='public')throw Error('Unexpected sequence');await f.exec(`GRANT USAGE ON SEQUENCE public.${quote(parts[1])} TO ${quote(runtime.role)}`);}
      const saved=await create(runtime.db);expect(saved.status,saved.msg).toBe(200);
      const sync=await call(runtime.db,'/outapi/product/stock/upload','PUT',{items:[{bar_code:'VIRTUAL-ONE',qty:9}]});expect(sync.status,sync.msg).toBe(200);
      const [row]=await f.db.execute<any>(sql`SELECT product_type,stock,delivery_type,temp_id FROM store_product WHERE id=${Number(saved.data.id)}`);
      expect(row).toMatchObject({product_type:3,stock:9,delivery_type:'',temp_id:0});
      const [identity]=await runtime.db.execute(sql`SELECT current_user=session_user AS direct_login,has_table_privilege(current_user,'public.system_config','UPDATE') AS config_write`);
      expect(identity).toEqual({direct_login:true,config_write:false});
    });
  },30_000);
});
