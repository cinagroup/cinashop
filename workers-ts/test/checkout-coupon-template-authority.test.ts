import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { runCouponProductScopeFence } from '../src/migrations/runCouponProductScopeFence';
import { createContainerFromDb, type DbClient } from '../src/lib/di';
import { StoreOrderCreateService } from '../src/services/order/StoreOrderCreateService';
import { OrderQuoteReconfirmRequired } from '../src/services/order/CheckoutConfirmation';
import { assertCheckoutCouponTemplate, couponTemplateSnapshot } from '../src/services/order/CheckoutCouponTemplateAuthority';
import { ValidateException } from '../src/utils/errors';
import { outcome, waitForFinanceBlock, withFinancePeers } from './helpers/financePeers';
import { createPcCheckoutQuoteFixture } from './helpers/pcCheckoutQuoteFixture';
import { orderCreate } from '../src/controllers/api/v1/OrderController';
import { storeCouponIssue, storeCouponUser, storeCouponProduct, storeProduct, storeProductCategory, storeBrand,
  storeOrderCartInfo, storeOrderStatus, printDocument, shippingTemplatesFree } from '../src/models/schema';

type Issue = typeof storeCouponIssue.$inferInsert;
const cases: Array<{ name: string; initial?: Partial<Issue>; change?: Partial<Issue>; remove?: boolean; allowed?: boolean }> = [
  { name: 'discount type', change: { type: 2 } },
  { name: 'scope type at same discount', change: { couponType: 2, productId: '70' } },
  { name: 'legacy products', initial: { couponType: 2, legacyProductIds: '70' }, change: { legacyProductIds: '70,71' } },
  { name: 'product alias', initial: { couponType: 2, productId: '70' }, change: { productId: '70,71' } },
  { name: 'legacy category', initial: { couponType: 1, category_id: '9' }, change: { legacyCategoryId: 10 } },
  { name: 'category alias', initial: { couponType: 1, legacyCategoryId: 9 }, change: { category_id: '10' } },
  { name: 'legacy brand', initial: { couponType: 3, brandId: '9' }, change: { legacyBrandId: 10 } },
  { name: 'brand alias', initial: { couponType: 3, legacyBrandId: 9 }, change: { brandId: '10' } },
  { name: 'missing template', remove: true },
  { name: 'cosmetic and claim-only facts', change: { couponTitle: 'renamed', status: 0, isDel: 1, remainCount: 99,
    couponPrice: '99.00', useMinPrice: '99.00', useEndTime: new Date(0) }, allowed: true },
  { name: 'unused scope fields', change: { productId: '999', category_id: '999', brandId: '999' }, allowed: true },
  { name: 'equivalent encoded products', initial: { couponType: 2, legacyProductIds: '70,71' },
    change: { legacyProductIds: '[71,70,70]', productId: '71' }, allowed: true },
  { name: 'equivalent category aliases', initial: { couponType: 1, legacyCategoryId: 9, category_id: '10' },
    change: { legacyCategoryId: 10, category_id: '9,9' }, allowed: true },
  { name: 'equivalent brand aliases', initial: { couponType: 3, legacyBrandId: 9, brandId: '10' },
    change: { legacyBrandId: 10, brandId: '9,9' }, allowed: true },
];

describe('coupon template authority at actual checkout commit boundary', () => {
  let f: Awaited<ReturnType<typeof createPcCheckoutQuoteFixture>>;
  let beforeSequence: (() => Promise<void>) | undefined;
  const input = { cartIds: [1], addressId: 11, couponId: 41, type: 0 };
  beforeEach(async () => {
    beforeSequence = undefined;
    f = await createPcCheckoutQuoteFixture([storeCouponIssue, storeCouponUser, storeCouponProduct,
      storeProductCategory, storeBrand, storeOrderCartInfo, storeOrderStatus, printDocument]);
    await f.setConfig(Object.fromEntries(Object.keys(f.config).map(key => [key, '0'])));
    await f.db.update(storeProduct).set({ cateId: '9', brandId: 9 }).where(eq(storeProduct.id, 70));
    await f.db.insert(storeProductCategory).values({ id: 9 });
    await f.db.insert(storeBrand).values({ id: 9 });
    await f.db.insert(storeCouponIssue).values({ id: 1, type: 1, couponType: 0 });
    await f.db.insert(storeCouponUser).values({ id: 41, uid: 11, issueCouponId: 1, couponPrice: '1.00', useMinPrice: '0.00' });
    const [identity] = await f.db.select({ schema: sql<string>`current_schema()` }).from(sql`(values (1)) as probe(n)`);
    await runCouponProductScopeFence(f.db, identity.schema);
    f.app.post('/api/order/create/:key', orderCreate);
    Object.assign(f.env, { SEQUENCE: { idFromName: () => 'isolated', get: () => ({ fetch: async () => {
      await beforeSequence?.(); return new Response('coupon_template_isolated');
    } }) } });
  }, 30_000);
  afterEach(async () => { await f?.close(); });
  const request = async (path: string, body: object) => {
    const response = await f.app.request(path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-fixture-user': '11' },
      body: JSON.stringify(body) }, f.env);
    return response.json() as Promise<{ status: number; msg: string; data: { orderKey: string; quoteToken: string;
      errorCode?: string; pay_price: string; priceGroup: { pay_price: string } } }>;
  };
  const state = async () => ({ ...await f.snapshot(), coupons: await f.db.select().from(storeCouponUser),
    templates: await f.db.select().from(storeCouponIssue), details: await f.db.select().from(storeOrderCartInfo),
    statuses: await f.db.select().from(storeOrderStatus) });

  it.each(cases)('$name after initial receipt validation', async variant => {
    if (variant.initial) await f.db.update(storeCouponIssue).set(variant.initial).where(eq(storeCouponIssue.id, 1));
    const receipt = await request('/api/order/confirm', input); expect(receipt.status, receipt.msg).toBe(200);
    let edited: Awaited<ReturnType<typeof state>> | undefined, calls = 0;
    beforeSequence = async () => {
      calls++;
      if (variant.remove) await f.db.delete(storeCouponIssue).where(eq(storeCouponIssue.id, 1));
      else await f.db.update(storeCouponIssue).set(variant.change!).where(eq(storeCouponIssue.id, 1));
      edited = await state();
    };
    const path = `/api/order/create/${receipt.data.orderKey}`;
    const result = await request(path, { ...input, quoteToken: receipt.data.quoteToken });
    expect(calls).toBe(1); expect(edited).toBeDefined();
    if (variant.allowed) {
      expect(result.status, result.msg).toBe(200);
      expect((await state()).orders[0]).toMatchObject({ paid: 0, payPrice: receipt.data.priceGroup.pay_price });
    } else {
      expect(result).toMatchObject({ status: 400, data: { errorCode: 'ORDER_QUOTE_RECONFIRM_REQUIRED', orderKey: receipt.data.orderKey } });
      expect(await state()).toEqual(edited);
      if (variant.remove) return; // Missing template is not silently recreated.
      beforeSequence = undefined;
      const fresh = await request(`/api/order/computed/${receipt.data.orderKey}`, input); expect(fresh.status, fresh.msg).toBe(200);
      if (variant.name !== 'discount type') expect(fresh.data.pay_price).toBe(receipt.data.priceGroup.pay_price);
      expect((await request(path, { ...input, quoteToken: fresh.data.quoteToken })).status).toBe(200);
    }
    beforeSequence = undefined; f.cache.clear(); const beforeReplay = await state();
    expect((await request(path, { ...input, quoteToken: receipt.data.quoteToken })).status).toBe(200);
    expect(await state()).toEqual(beforeReplay);
  });

  it.each(['consistent', 'conflicting'])('reconciles a new encoded alias with the original relation scope (%s)', async mode => {
    await f.db.update(storeCouponIssue).set({ couponType: 2 });
    await f.db.insert(storeCouponProduct).values({ couponId: 1, productId: 70 });
    const receipt = await request('/api/order/confirm', input); expect(receipt.status, receipt.msg).toBe(200);
    beforeSequence = async () => { await f.db.update(storeCouponIssue).set({ productId: mode === 'consistent' ? '70' : '71' }); };
    const result = await request(`/api/order/create/${receipt.data.orderKey}`, { ...input, quoteToken: receipt.data.quoteToken });
    expect(result.status).toBe(mode === 'consistent' ? 200 : 400);
    expect((await state()).orders).toHaveLength(mode === 'consistent' ? 1 : 0);
  });

  it('does not require or lock a template when no coupon is used', async () => {
    const noCoupon = { ...input, couponId: 0 };
    await f.db.delete(storeCouponIssue);
    const receipt = await request('/api/order/confirm', noCoupon); expect(receipt.status, receipt.msg).toBe(200);
    expect((await request(`/api/order/create/${receipt.data.orderKey}`, { ...noCoupon, quoteToken: receipt.data.quoteToken })).status).toBe(200);
  });

  const create = (db: DbClient, receipt: { orderKey: string; quoteToken: string }) =>
    new StoreOrderCreateService(createContainerFromDb(db), f.env).createOrder({ ...input, uid: 11,
      key: receipt.orderKey, quoteToken: receipt.quoteToken, userIp: '127.0.0.1' });

  it.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('rejects an uncommitted independent template writer without a reverse wait', async () => {
    const receipt = await request('/api/order/confirm', input); expect(receipt.status, receipt.msg).toBe(200);
    const before = await state();
    await withFinancePeers(f.db, async ([editor, buyer]) => {
      await editor.exec('BEGIN; UPDATE store_coupon_issue SET type=2 WHERE id=1');
      const buying = await outcome(create(buyer.db, receipt.data));
      expect(buying.ok).toBe(false);
      if (!buying.ok) expect(buying.error).toBeInstanceOf(OrderQuoteReconfirmRequired);
      expect(await state()).toEqual(before); // Writer is still uncommitted.
      await editor.exec('COMMIT');
      expect((await state()).orders).toHaveLength(0);
    });
  }, 15_000);

  it.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL)).each(['commit', 'rollback'] as const)(
    'holds a later template writer through actual checkout %s', async ending => {
      const receipt = await request('/api/order/confirm', input); expect(receipt.status, receipt.msg).toBe(200);
      const before = await state();
      await withFinancePeers(f.db, async ([holder, buyer, shippingEditor]) => {
        await holder.exec('BEGIN; LOCK TABLE store_order_cart_info IN SHARE MODE');
        const buying = outcome(create(buyer.db, receipt.data));
        await waitForFinanceBlock(f.db, buyer.pid, holder.pid);
        await shippingEditor.exec('BEGIN; LOCK TABLE shipping_templates_free IN ACCESS EXCLUSIVE MODE');
        await holder.exec('COMMIT');
        await waitForFinanceBlock(f.db, buyer.pid, shippingEditor.pid);
        // The final coupon guard precedes this shipping SELECT. The holder is
        // now a separate template writer, not a checkout hook or fake timer.
        const editing = outcome(holder.exec('UPDATE store_coupon_issue SET type=2 WHERE id=1'));
        await waitForFinanceBlock(f.db, holder.pid, buyer.pid);
        if (ending === 'rollback') await shippingEditor.db.insert(shippingTemplatesFree).values({ id: 99, tempId: 10, cityId: 101 });
        await shippingEditor.exec('COMMIT');
        const result = await buying; expect(result.ok).toBe(ending === 'commit');
        if (!result.ok) expect(result.error).toBeInstanceOf(OrderQuoteReconfirmRequired);
        expect((await editing).ok).toBe(true);
        const after = await state();
        if (ending === 'rollback') expect({ ...after, templates: before.templates }).toEqual(before);
        else {
          expect(after.orders).toHaveLength(1);
          expect(after.orders[0]).toMatchObject({ paid: 0, couponPrice: '1.00', payPrice: receipt.data.priceGroup.pay_price });
          expect(after.coupons[0].status).toBe(3);
        }
        expect(after.templates[0].type).toBe(2);
      });
    }, 15_000);

  it('rejects a root database rather than releasing its row lock before commit', async () => {
    const [template] = await f.db.select().from(storeCouponIssue);
    await expect(assertCheckoutCouponTemplate(f.db, couponTemplateSnapshot(template, []))).rejects.toThrow('owning transaction');
  });

  it.each(['55P03', '40P01', '57014', '08006'])('only maps NOWAIT lock conflicts, preserving SQL failure %s', async code => {
    const [template] = await f.db.select().from(storeCouponIssue);
    const failure = new Error('synthetic driver error', { cause: { code } });
    const tx: Pick<DbClient, 'select'> = { select: () => { throw failure; } };
    const checking = assertCheckoutCouponTemplate(tx, couponTemplateSnapshot(template, []));
    if (code === '55P03') await expect(checking).rejects.toBeInstanceOf(ValidateException);
    else await expect(checking).rejects.toBe(failure);
  });
});
