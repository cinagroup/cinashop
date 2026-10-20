/** Real PG16 bpchar padding and actual ordinary cart/quote/order writers.
 * Confirmation uses the existing labelled HTTP shell, not App/JWT or runtime
 * grant evidence. Fixture sequence gaps are excluded from business snapshots. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import type { DbClient } from '../src/lib/di';
import { storeCart, storeProduct, storeProductAttrValue } from '../src/models/schema';
import { ApiException } from '../src/utils/errors';
import { productPurchaseAdmissionFixture, type ProductAdmissionReceipt } from './helpers/productPurchaseAdmissionFixture';
import { outcome } from './helpers/financePeers';

type Fixture = Awaited<ReturnType<typeof productPurchaseAdmissionFixture>>;
type Confirmation = ProductAdmissionReceipt & {
  cartInfo: Array<Record<string, unknown>>;
  priceGroup: Record<string, string>;
};
const shortUnique = 'short7';

async function assertNativeIdentity(db: DbClient, unique: string, skuId = 1) {
  const [stored] = await db.execute(sql`SELECT "unique" AS raw_unique,
    pg_typeof("unique")::text AS storage_type, octet_length("unique") AS bytes
    FROM public.store_product_attr_value WHERE id=${skuId}`);
  expect(stored).toMatchObject({ raw_unique: unique.padEnd(8, ' '), storage_type: 'character', bytes: 8 });
  // The driver witness is important: ::text would silently discard bpchar padding.
  expect(String(stored.raw_unique)).toHaveLength(8);
}

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('ordinary short SKU on native PostgreSQL16', () => {
  let f: Fixture;
  beforeEach(async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Short SKU tests forbid external I/O'));
    f = await productPurchaseAdmissionFixture();
    await f.db.update(storeProduct).set({ price: '17.00' }).where(eq(storeProduct.id, 70));
    await f.db.update(storeProductAttrValue).set({ unique: shortUnique, price: '10.00' })
      .where(eq(storeProductAttrValue.id, 1));
    await f.db.update(storeCart).set({ productAttrUnique: shortUnique }).where(eq(storeCart.id, 1));
  }, 45_000);
  afterEach(async () => {
    try { expect(fetch).not.toHaveBeenCalled(); }
    finally { vi.restoreAllMocks(); await f?.close(); }
  }, 30_000);

  const confirm = async (ids: number[]): Promise<Confirmation> => {
    const result = await f.confirm(ids);
    expect(result.status, result.msg).toBe(200);
    if (!result.data) throw Error('Actual confirmation did not return its receipt');
    return result.data as Confirmation;
  };
  const readAndCreate = async (id: number, unique: string, reusable = true) => {
    const before = await f.state(), writes = f.writes.length;
    if (reusable) {
      expect((await f.compute([id])).deduction).toMatchObject({ sum_price: 20, pay_price: 20 });
    } else {
      // Budget is intentionally restricted to reusable carts. Direct-buy
      // confirmation/create is a separate, supported selection scope.
      const budget = await outcome(f.compute([id]));
      expect(budget.ok).toBe(false);
      if (!budget.ok) {
        expect(budget.error).toBeInstanceOf(ApiException);
        expect((budget.error as Error).message).toBe('选中商品已失效或不属于当前购物车');
      }
    }
    expect(f.writes).toHaveLength(writes);
    expect(await f.state()).toEqual(before);
    expect(await f.quote([id])).toMatchObject({ rawTotalCents: 2000, totalCents: 2000, payCents: 2000 });
    const receipt = await confirm([id]);
    expect(receipt.priceGroup).toMatchObject({ sumPrice: '20.00', totalPrice: '20.00', pay_price: '20.00' });
    expect(await f.state()).toEqual(before);
    const created = await f.create([id], receipt.orderKey, { receipt });
    const after = await f.state();
    expect(after.orders).toMatchObject([{ orderId: created.orderId, totalNum: 2,
      totalPrice: '20.00', payPrice: '20.00', paid: 0 }]);
    expect(after.products.find(row => row.id === 70)?.stock).toBe(38);
    expect(after.skus.find(row => row.id === 1)?.stock).toBe(38);
    expect(after.skus.find(row => row.id === 2)?.stock).toBe(40);
    expect(after.details).toMatchObject([{ cartId: String(id), productId: 70, skuUnique: unique, cartNum: 2 }]);
    expect(JSON.parse(after.details[0].cartInfo!)).toMatchObject({
      sku: { id: 1, unique, price: '10.00' }, sum_true_price: '20.00' });
    expect(after.origins).toMatchObject([{ total_num: 2,
      lines: [{ skuId: 1, skuUnique: unique, quantity: 2, usedPoints: 0 }] }]);
    expect(after.physicalOrigins).toMatchObject([{ total_num: 2,
      lines: [{ skuId: 1, skuUnique: unique, quantity: 2, kind: 'charged', gift: null }] }]);
    expect(after.users[0].integral).toBe(before.users[0].integral);
    const replaySequence = vi.fn(async () => {});
    const replayKv = { entries: Array.from(f.cache.entries()), writes: f.writes.map(row => ({ ...row })) };
    expect(await f.create([id], receipt.orderKey, { receipt, nextOrderId: replaySequence })).toEqual(created);
    expect(replaySequence).not.toHaveBeenCalled();
    expect(await f.state()).toEqual(after);
    expect({ entries: Array.from(f.cache.entries()), writes: f.writes }).toEqual(replayKv);
  };

  it.each([{ scope: 'reusable cart', isNew: 0 }, { scope: 'direct buy', isNew: 1 }])(
    'prices $scope from the actual short SKU, enforces budget scope and completes origin-bearing checkout', async ({ isNew }) => {
      await assertNativeIdentity(f.db, shortUnique);
      const added = await f.cart().add({ uid: 11, productId: 70, unique: shortUnique, cartNum: 2, type: 0, isNew });
      const before = await f.state();
      const rows = await f.cart().list(11, isNew ? { mode: 'buy', ids: [added.id] } : { mode: 'cart' });
      expect(rows).toMatchObject([{ id: added.id, isValid: true, truePrice: '10.00', trueSumPrice: '20.00',
        productInfo: { price: '10' } }]);
      expect(await f.state()).toEqual(before);
      await readAndCreate(added.id, shortUnique, isNew === 0);
      expect((await f.state()).carts.find(row => row.id === 1)?.isPay).toBe(0);
    }, 30_000);

  it.each([{ label: 'unpadded', cartUnique: shortUnique },
    { label: 'right-padded', cartUnique: shortUnique.padEnd(8, ' ') }])(
    'resolves a $label retained legacyV2 cart to its real SKU rather than the different product fallback price', async ({ cartUnique }) => {
    await assertNativeIdentity(f.db, shortUnique);
    await f.db.update(storeCart).set({ isNew: 0, productAttrUnique: cartUnique }).where(eq(storeCart.id, 1));
    const before = await f.state();
    expect(before.carts[0].productAttrUnique).toBe(cartUnique);
    const rows = await f.cart().listLegacyV2(11);
    expect(rows).toMatchObject([{ id: 1, product_attr_unique: cartUnique, is_valid: 1,
      truePrice: 10, sum_price: 10, productInfo: { price: '17.00',
        attrInfo: { id: 1, price: '10.00', suk: '红色,大号', stock: 40 } } }]);
    expect(await f.state()).toEqual(before);
    await readAndCreate(1, shortUnique);
  }, 30_000);

  it('keeps the existing exact eight-character SKU price and checkout unchanged', async () => {
    const exactUnique = 'qared001';
    await f.db.update(storeProductAttrValue).set({ unique: exactUnique }).where(eq(storeProductAttrValue.id, 1));
    await f.db.update(storeCart).set({ productAttrUnique: exactUnique, isNew: 0 }).where(eq(storeCart.id, 1));
    await assertNativeIdentity(f.db, exactUnique);
    expect(await f.cart().listLegacyV2(11)).toMatchObject([{ id: 1, is_valid: 1, truePrice: 10,
      productInfo: { attrInfo: { id: 1, price: '10.00' } } }]);
    await readAndCreate(1, exactUnique);
  }, 30_000);

  it.each(['wrong product', 'wrong activity type', 'retired'] as const)(
    'does not turn a %s short-key SKU into an eligible ordinary purchase', async state => {
      await f.db.update(storeCart).set({ isNew: 0 }).where(eq(storeCart.id, 1));
      if (state === 'wrong product') {
        await f.db.insert(storeProduct).values({ id: 71, storeName: '另一个真实商品', price: '10.00',
          stock: 40, isShow: 1, isVerify: 1, freight: 1, deliveryType: '1' });
        await f.db.update(storeProductAttrValue).set({ productId: 71 }).where(eq(storeProductAttrValue.id, 1));
      } else if (state === 'wrong activity type') {
        await f.db.update(storeProductAttrValue).set({ type: 4 }).where(eq(storeProductAttrValue.id, 1));
      } else {
        await f.db.update(storeProductAttrValue).set({ isRetired: 1 }).where(eq(storeProductAttrValue.id, 1));
      }
      await assertNativeIdentity(f.db, shortUnique);
      const before = await f.state(), writes = f.writes.length;
      const rejectBusiness = async (work: Promise<unknown>) => {
        const result = await outcome(work);
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error).toBeInstanceOf(ApiException);
      };
      await rejectBusiness(f.cart().add({ uid: 11, productId: 70, unique: shortUnique, cartNum: 2, type: 0 }));
      expect(await f.cart().list(11, { mode: 'cart' })).toMatchObject([{ id: 1, isValid: false }]);
      expect(await f.cart().listLegacyV2(11, { includeInvalid: true })).toMatchObject([{ id: 1, is_valid: 0 }]);
      await rejectBusiness(f.compute([1]));
      await rejectBusiness(f.quote([1]));
      expect((await f.confirm([1])).status).not.toBe(200);
      await rejectBusiness(f.create([1]));
      expect(await f.state()).toEqual(before);
      expect(f.writes).toHaveLength(writes);
    }, 30_000);

  it('rejects a real SKU price edit after confirmation at the write boundary with no retained order or resource claim', async () => {
    const receipt = await confirm([1]);
    let reached = 0, edited: Awaited<ReturnType<Fixture['state']>> | undefined;
    const result = await outcome(f.create([1], receipt.orderKey, { receipt, nextOrderId: async () => {
      reached++;
      await f.db.update(storeProductAttrValue).set({ price: '12.00' }).where(eq(storeProductAttrValue.id, 1));
      edited = await f.state();
    } }));
    expect(reached).toBe(1); expect(edited).toBeDefined();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(ApiException);
    expect(await f.state()).toEqual(edited);
  }, 30_000);
});
