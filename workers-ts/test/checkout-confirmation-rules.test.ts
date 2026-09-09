import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createContainerFromDb, type DbClient } from '../src/lib/di';
import { StoreOrderCreateService } from '../src/services/order/StoreOrderCreateService';
import { OrderQuoteReconfirmRequired } from '../src/services/order/CheckoutConfirmation';
import { outcome, waitForFinanceBlock, withFinancePeers } from './helpers/financePeers';
import { createPcCheckoutQuoteFixture } from './helpers/pcCheckoutQuoteFixture';
import { createBargainSelectionFixture } from './helpers/bargainSelectionFixture';
import { orderCreate } from '../src/controllers/api/v1/OrderController';
import { storeOrderCartInfo, storeOrderStatus, printDocument, storeCouponIssue, storeCouponUser, storeCouponProduct,
  storeDiscounts, storeDiscountsProducts, storeProduct, storeProductAttrValue, storeCart, storeBargain,
  storeSeckill, storeSeckillTime, storeActivity, storeCombination, storePink, storeIntegral, storeNewcomer, user } from '../src/models/schema';

for (const kind of ['coupon', 'package', 'bargain', 'seckill', 'combination', 'integral', 'newcomer'] as const) describe(`cross-request ${kind} semantic rules`, () => {
  let f: Awaited<ReturnType<typeof createPcCheckoutQuoteFixture>>;
  let beforeSequence: (() => Promise<void>) | undefined;
  const input = kind === 'coupon' ? { cartIds: [1], addressId: 11, couponId: 41, type: 0 }
    : kind === 'package' ? { cartIds: [1, 2], addressId: 11, type: 5 }
    : kind === 'bargain' ? { cartIds: [10], addressId: 11, type: 2, bargainUserId: 80 }
    : { cartIds: [1], addressId: 11, type: { seckill: 1, combination: 3, integral: 4, newcomer: 7 }[kind],
      ...(kind === 'seckill' ? { seckillId: 40 } : kind === 'combination' ? { combinationId: 40 } : {}) };
  beforeEach(async () => {
    beforeSequence = undefined;
    const extra = [storeOrderCartInfo, storeOrderStatus, printDocument];
    if (kind === 'bargain') {
      f = await createBargainSelectionFixture(extra);
      await f.db.update(storeBargain).set({ deliveryType: '1,2' });
      await f.db.insert(storeCart).values({ id: 10, uid: 11, productId: 70, productAttrUnique: 'qared001', cartNum: 1,
        type: 2, activityId: 40, bargainUserId: 80, isNew: 1, status: 1 });
    } else {
      f = await createPcCheckoutQuoteFixture([...extra, storeCouponIssue, storeCouponUser, storeCouponProduct, storeDiscounts, storeDiscountsProducts,
        storeSeckill, storeSeckillTime, storeActivity, storeCombination, storePink, storeIntegral, storeNewcomer]);
      for (const key of Object.keys(f.config)) f.config[key] = '0';
      if (kind === 'coupon') {
        await f.db.insert(storeCouponIssue).values({ id: 1, type: 1, couponType: 0 });
        await f.db.insert(storeCouponUser).values({ id: 41, uid: 11, issueCouponId: 1, couponPrice: '1.00', useMinPrice: '0.00' });
      } else if (kind === 'package') {
        await f.db.insert(storeDiscounts).values({ id: 40, type: 0, isSupportRefund: 1, freeShipping: 1 });
        await f.db.insert(storeDiscountsProducts).values([{ id: 101, discountId: 40, productId: 70 }, { id: 102, discountId: 40, productId: 71 }]);
        await f.db.insert(storeProduct).values({ id: 71, storeName: '第二套餐商品', stock: 8, price: '10.00', isShow: 1, freight: 1 });
        await f.db.insert(storeProductAttrValue).values([
          { id: 2, productId: 71, type: 0, unique: 'base0071', suk: '标准', stock: 8, price: '10.00' },
          { id: 3, productId: 101, type: 5, unique: 'pack0101', suk: '红色,大号', stock: 8, price: '8.00' },
          { id: 4, productId: 102, type: 5, unique: 'pack0102', suk: '标准', stock: 8, price: '8.00' },
        ]);
        await f.db.update(storeCart).set({ type: 5, activityId: 40, cartNum: 1 });
        await f.db.insert(storeCart).values({ id: 2, uid: 11, productId: 71, productAttrUnique: 'base0071', cartNum: 1, type: 5, activityId: 40, isNew: 1, status: 1 });
      } else {
        await f.db.update(storeCart).set({ type: input.type, activityId: 40, cartNum: 1 });
        await f.db.update(storeProduct).set({ freight: 1, tempId: 0 });
        await f.db.insert(storeProductAttrValue).values({ id: 2, productId: 40, type: input.type, unique: 'act00040',
          suk: '红色,大号', price: '8.00', stock: 8, quota: 8, integral: kind === 'integral' ? 10 : 0 });
        const activity = { id: 40, productId: 70, stock: 8, quota: 8, num: 8, onceNum: 3, freight: 1 };
        if (kind === 'seckill') {
          await f.db.insert(storeSeckillTime).values({ id: 1, startTime: '00:00', endTime: '24:00' });
          await f.db.insert(storeSeckill).values({ ...activity, timeId: '1' });
        } else if (kind === 'combination') await f.db.insert(storeCombination).values({ ...activity, people: 2, effectiveTime: 3600 });
        else if (kind === 'integral') await f.db.insert(storeIntegral).values(activity);
        else {
          await f.db.insert(storeNewcomer).values({ id: 40, productId: 70 });
          await f.db.update(user).set({ addTime: Math.floor(Date.now() / 1000) });
          Object.assign(f.config, { newcomer_status: '1', register_price_status: '1' });
        }
      }
    }
    f.app.post('/api/order/create/:key', orderCreate);
    Object.assign(f.env, { SEQUENCE: { idFromName: () => 'isolated', get: () => ({ fetch: async () => {
      await beforeSequence?.();
      return new Response(`rules_${kind}`);
    } }) } });
  }, 30_000);
  afterEach(async () => { await f?.close(); });
  const request = async (path: string, body: object) => {
    const response = await f.app.request(path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-fixture-user': '11' }, body: JSON.stringify(body) }, f.env);
    return response.json() as Promise<{ status: number; msg: string; data: { orderKey: string; quoteToken: string; errorCode?: string; pay_price?: string; priceGroup: { pay_price: string } } }>;
  };
  const state = async () => ({ ...await f.snapshot(),
    details: await f.db.select().from(storeOrderCartInfo), statuses: await f.db.select().from(storeOrderStatus),
    ...(kind === 'coupon' ? { coupons: await f.db.select().from(storeCouponUser) } : {}),
    ...(kind === 'package' ? { packages: await f.db.select().from(storeDiscounts), entries: await f.db.select().from(storeDiscountsProducts) } : {}),
    ...(kind === 'seckill' ? { seckills: await f.db.select().from(storeSeckill), slots: await f.db.select().from(storeSeckillTime),
      parents: await f.db.select().from(storeActivity) } : {}),
  });
  if (kind === 'bargain' || kind === 'combination' || kind === 'integral' || kind === 'seckill') {
    const activityState = async (db: DbClient) => kind === 'bargain' ? { bargains: await db.select().from(storeBargain) }
      : kind === 'combination' ? { combinations: await db.select().from(storeCombination) }
      : kind === 'integral' ? { integrals: await db.select().from(storeIntegral) }
      : { seckills: await db.select().from(storeSeckill) };
    const businessState = async () => ({ ...await state(), ...await activityState(f.db) });
    const editRules = async (db: DbClient, variant: 'primary' | 'secondary' | 'cosmetic' | 'inventory') => {
      // Simulate an independent stock adjustment while leaving enough stock for this purchase.
      if (variant === 'inventory') {
        const counters = { stock: 9, quota: 9, sales: 1 };
        if (kind === 'bargain') await db.update(storeBargain).set(counters).where(eq(storeBargain.id, 40));
        else if (kind === 'combination') await db.update(storeCombination).set(counters).where(eq(storeCombination.id, 40));
        else if (kind === 'integral') await db.update(storeIntegral).set(counters).where(eq(storeIntegral.id, 40));
        else await db.update(storeSeckill).set(counters).where(eq(storeSeckill.id, 40));
        return;
      }
      if (kind === 'bargain') await db.update(storeBargain).set(variant === 'primary' ? { num: 9 }
        : variant === 'secondary' ? { stopTime: new Date(Date.now() + 7_200_000) } : { title: '仅改活动标题' }).where(eq(storeBargain.id, 40));
      else if (kind === 'combination') await db.update(storeCombination).set(variant === 'primary' ? { people: 3 }
        : variant === 'secondary' ? { effectiveTime: 7200 } : { sort: 9 }).where(eq(storeCombination.id, 40));
      else if (kind === 'integral') await db.update(storeIntegral).set(variant === 'primary' ? { onceNum: 4 }
        : variant === 'secondary' ? { num: 9 } : { sort: 9 }).where(eq(storeIntegral.id, 40));
      else await db.update(storeSeckill).set(variant === 'primary' ? { deliveryType: '1' }
        : variant === 'secondary' ? { isSupportRefund: 0 } : { sort: 9 }).where(eq(storeSeckill.id, 40));
    };
    it.each(['primary', 'secondary'] as const)('rejects late scalar activity %s facts with full rollback and explicit same-price reconfirmation', async variant => {
      const a = await request('/api/order/confirm', input); expect(a.status, a.msg).toBe(200);
      let calls = 0, edited: Awaited<ReturnType<typeof businessState>> | undefined;
      beforeSequence = async () => { calls++; await editRules(f.db, variant); edited = await businessState(); };
      const path = `/api/order/create/${a.data.orderKey}`;
      expect(await request(path, { ...input, quoteToken: a.data.quoteToken })).toMatchObject({ status: 400,
        data: { errorCode: 'ORDER_QUOTE_RECONFIRM_REQUIRED', orderKey: a.data.orderKey } });
      expect(calls).toBe(1); expect(edited).toBeDefined(); expect(await businessState()).toEqual(edited);
      beforeSequence = undefined;
      const b = await request(`/api/order/computed/${a.data.orderKey}`, input); expect(b.status, b.msg).toBe(200);
      expect(b.data.pay_price).toBe(a.data.priceGroup.pay_price);
      expect((await request(path, { ...input, quoteToken: b.data.quoteToken })).status).toBe(200);
    });
    it.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL)).each(['primary', 'secondary', 'cosmetic', 'inventory'] as const)(
      'checks scalar activity %s facts after a real PostgreSQL writer wait', async variant => {
        const a = await request('/api/order/confirm', input); expect(a.status, a.msg).toBe(200);
        const before = await businessState();
        await withFinancePeers(f.db, async ([editor, buyer]) => {
          await editor.exec('BEGIN'); await editRules(editor.db, variant);
          const edited = { ...before, ...await activityState(editor.db) };
          const buying = outcome(StoreOrderCreateService.createWithRuntime(createContainerFromDb(buyer.db), {
            CONFIG_KV: f.env.CONFIG_KV, requireConfirmation: true, nextOrderId: async () => `scalar_peer_${kind}`,
          }, { ...input, uid: 11, key: a.data.orderKey, quoteToken: a.data.quoteToken, userIp: '127.0.0.1' }));
          await waitForFinanceBlock(f.db, buyer.pid, editor.pid); await editor.exec('COMMIT');
          const permitted = variant === 'cosmetic' || variant === 'inventory';
          const result = await buying; expect(result.ok).toBe(permitted);
          if (!result.ok) expect(result.error).toBeInstanceOf(OrderQuoteReconfirmRequired);
          const after = await businessState();
          if (permitted) {
            expect(after.orders).toHaveLength(1); expect(after.orders[0]).toMatchObject({ paid: 0, payPrice: a.data.priceGroup.pay_price });
            if (variant === 'inventory') {
              const rows = Object.values(await activityState(f.db))[0];
              expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({ stock: 8, quota: 8, sales: 2 });
            }
          } else expect(after).toEqual(edited);
        });
      }, 15_000);
  }
  if (kind === 'coupon') {
    it.each(['minimum', 'ineligible', 'invalidated', 'value', 'issue', 'starts', 'ends'] as const)(
      'rolls back when owned-coupon %s changes after initial receipt validation', async variant => {
        const startTime = new Date(Date.now() - 3_600_000), endTime = new Date(Date.now() + 3_600_000);
        await f.db.insert(storeCouponIssue).values({ id: 2, type: 1, couponType: 0 });
        await f.db.update(storeCouponUser).set({ startTime, endTime });
        const a = await request('/api/order/confirm', input); expect(a.status, a.msg).toBe(200);
        let calls = 0, edited: Awaited<ReturnType<typeof state>> | undefined;
        beforeSequence = async () => {
          calls++;
          await f.db.update(storeCouponUser).set(variant === 'minimum' ? { useMinPrice: '1.00' }
            : variant === 'ineligible' ? { useMinPrice: '999.00' }
            : variant === 'invalidated' ? { isFail: 1 }
            : variant === 'value' ? { couponPrice: '2.00' }
            : variant === 'issue' ? { issueCouponId: 2 }
            : variant === 'starts' ? { startTime: new Date(startTime.getTime() + 1000) }
            : { endTime: new Date(endTime.getTime() + 1000) }).where(eq(storeCouponUser.id, 41));
          edited = await state();
        };
        expect(await request(`/api/order/create/${a.data.orderKey}`, { ...input, quoteToken: a.data.quoteToken })).toMatchObject({
          status: 400, data: { errorCode: 'ORDER_QUOTE_RECONFIRM_REQUIRED', orderKey: a.data.orderKey },
        });
        expect(calls).toBe(1); expect(edited).toBeDefined(); expect(await state()).toEqual(edited);
      });
    it('permits a late cosmetic edit to a still-valid dated coupon', async () => {
      await f.db.update(storeCouponUser).set({ startTime: new Date(Date.now() - 3_600_000), endTime: new Date(Date.now() + 3_600_000) });
      const a = await request('/api/order/confirm', input); expect(a.status, a.msg).toBe(200);
      let calls = 0;
      beforeSequence = async () => { calls++; await f.db.update(storeCouponUser).set({ couponTitle: '晚到的展示编辑' }); };
      const result = await request(`/api/order/create/${a.data.orderKey}`, { ...input, quoteToken: a.data.quoteToken });
      expect(result.status, result.msg).toBe(200); expect(calls).toBe(1);
      expect((await state()).orders[0]).toMatchObject({ paid: 0, payPrice: a.data.priceGroup.pay_price });
    });
  }
  if (kind === 'package' || kind === 'seckill') {
    it.each(['window', 'membership'] as const)('rejects late %s rules even when purchase remains valid at the same price', async variant => {
      if (kind === 'seckill') await f.db.insert(storeSeckillTime).values({ id: 2, startTime: '00:00', endTime: '24:00' });
      const a = await request('/api/order/confirm', input); expect(a.status, a.msg).toBe(200);
      let calls = 0, edited: Awaited<ReturnType<typeof state>> | undefined;
      beforeSequence = async () => {
        calls++;
        if (kind === 'package') {
          if (variant === 'window') await f.db.update(storeDiscounts).set({ stopTime: Math.floor(Date.now() / 1000) + 86400 });
          else await f.db.update(storeDiscountsProducts).set({ type: 1 }).where(eq(storeDiscountsProducts.id, 101));
        } else await f.db.update(storeSeckill).set(variant === 'window'
          ? { stopTime: new Date(Date.now() + 86_400_000) } : { timeId: '1,2' });
        edited = await state();
      };
      const path = `/api/order/create/${a.data.orderKey}`;
      expect(await request(path, { ...input, quoteToken: a.data.quoteToken })).toMatchObject({ status: 400,
        data: { errorCode: 'ORDER_QUOTE_RECONFIRM_REQUIRED', orderKey: a.data.orderKey } });
      expect(calls).toBe(1); expect(edited).toBeDefined(); expect(await state()).toEqual(edited);
      beforeSequence = undefined;
      const b = await request(`/api/order/computed/${a.data.orderKey}`, input); expect(b.status, b.msg).toBe(200);
      expect(b.data.pay_price).toBe(a.data.priceGroup.pay_price);
      expect((await request(path, { ...input, quoteToken: b.data.quoteToken })).status).toBe(200);
    });
    const peerVariants = kind === 'package' ? ['window', 'membership', 'cosmetic', 'append'] as const
      : ['window', 'membership', 'cosmetic', 'parent'] as const;
    it.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL)).each(peerVariants)(
      'checks %s after a real PostgreSQL rule-writer lock wait', async variant => {
        if (kind === 'seckill') {
          await f.db.insert(storeSeckillTime).values({ id: 2, startTime: '00:00', endTime: '24:00' });
          const today = Math.floor((Date.now() + 28_800_000) / 86_400_000) * 86_400 - 28_800;
          await f.db.insert(storeActivity).values({ id: 9, type: 1, status: 1, startDay: today, endDay: today + 86400, timeId: '1,2' });
          await f.db.update(storeSeckill).set({ activityId: 9 });
        } else if (variant === 'append') {
          await f.db.update(storeDiscounts).set({ type: 1 });
          await f.db.update(storeDiscountsProducts).set({ type: 1 }).where(eq(storeDiscountsProducts.id, 101));
          await f.db.insert(storeProduct).values({ id: 72, storeName: '未选可选商品', stock: 8, price: '10.00', isShow: 1, freight: 1 });
        }
        const a = await request('/api/order/confirm', input); expect(a.status, a.msg).toBe(200);
        const before = await state();
        let edited = before;
        await withFinancePeers(f.db, async ([editor, buyer]) => {
          await editor.exec('BEGIN');
          if (kind === 'package') {
            if (variant === 'membership') await editor.db.update(storeDiscountsProducts).set({ type: 1 }).where(eq(storeDiscountsProducts.id, 101));
            else if (variant === 'append') {
              // The production admin save locks the parent before inserting/removing members.
              await editor.exec('SELECT id FROM store_discounts WHERE id=40 FOR UPDATE');
              await editor.db.insert(storeDiscountsProducts).values({ id: 103, discountId: 40, productId: 72, type: 0 });
            }
            else await editor.db.update(storeDiscounts).set(variant === 'window'
              ? { stopTime: Math.floor(Date.now() / 1000) + 86400 } : { title: '并发仅改标题' }).where(eq(storeDiscounts.id, 40));
            edited = { ...before, packages: await editor.db.select().from(storeDiscounts), entries: await editor.db.select().from(storeDiscountsProducts) };
          } else {
            if (variant === 'parent') await editor.db.update(storeActivity).set({ endDay: before.parents![0].endDay + 86400 }).where(eq(storeActivity.id, 9));
            else await editor.db.update(storeSeckill).set(variant === 'window'
              ? { stopTime: new Date(Date.now() + 86_400_000) } : variant === 'membership' ? { timeId: '1,2' } : { sort: 9 }).where(eq(storeSeckill.id, 40));
            edited = { ...before, seckills: await editor.db.select().from(storeSeckill), parents: await editor.db.select().from(storeActivity) };
          }
          const buying = outcome(StoreOrderCreateService.createWithRuntime(createContainerFromDb(buyer.db), {
            CONFIG_KV: f.env.CONFIG_KV, requireConfirmation: true, nextOrderId: async () => `rules_peer_${kind}`,
          }, { ...input, uid: 11, key: a.data.orderKey, quoteToken: a.data.quoteToken, userIp: '127.0.0.1' }));
          await waitForFinanceBlock(f.db, buyer.pid, editor.pid);
          await editor.exec('COMMIT');
          const result = await buying;
          expect(result.ok).toBe(variant === 'cosmetic');
          if (!result.ok) expect(result.error).toBeInstanceOf(OrderQuoteReconfirmRequired);
        });
        const after = await state();
        if (variant === 'cosmetic') {
          expect(after.orders).toHaveLength(1); expect(after.orders[0]).toMatchObject({ paid: 0, payPrice: a.data.priceGroup.pay_price });
        } else {
          // Retain the independently committed edit while rolling back every checkout write.
          expect(after).toEqual(edited);
        }
      }, 15_000);
  }
  it('preserves a valid confirmed order and idempotent replay after removing receipts', async () => {
    const a = await request('/api/order/confirm', input); expect(a.status, a.msg).toBe(200);
    const path = `/api/order/create/${a.data.orderKey}`;
    const created = await request(path, { ...input, quoteToken: a.data.quoteToken }); expect(created.status, created.msg).toBe(200);
    expect((await state()).orders[0]).toMatchObject({ paid: 0, payPrice: a.data.priceGroup.pay_price });
    f.cache.clear(); const before = await state();
    expect((await request(path, { quoteToken: 'corrupt' })).status).toBe(200); expect(await state()).toEqual(before);
  });
  it('allows cosmetic edits and sufficient remaining inventory without invalidating purchase terms', async () => {
    const a = await request('/api/order/confirm', input); expect(a.status, a.msg).toBe(200);
    if (kind === 'coupon') await f.db.update(storeCouponUser).set({ couponTitle: '只改展示名称' });
    else if (kind === 'package') await f.db.update(storeDiscounts).set({ title: '只改展示名称', limitNum: 7 });
    else if (kind === 'bargain') await f.db.update(storeBargain).set({ title: '只改展示名称', stock: 7, quota: 7 });
    else if (kind === 'seckill') await f.db.update(storeSeckill).set({ sort: 9, stock: 7, quota: 7 });
    else if (kind === 'combination') await f.db.update(storeCombination).set({ sort: 9, stock: 7, quota: 7 });
    else if (kind === 'integral') await f.db.update(storeIntegral).set({ sort: 9, stock: 7, quota: 7 });
    else await f.db.update(storeNewcomer).set({ updateTime: Math.floor(Date.now() / 1000) });
    await f.db.update(storeProduct).set({ stock: 7 });
    await f.db.update(storeProductAttrValue).set({ stock: 7 });
    const result = await request(`/api/order/create/${a.data.orderKey}`, { ...input, quoteToken: a.data.quoteToken });
    expect(result.status, result.msg).toBe(200);
    expect((await state()).orders[0]).toMatchObject({ paid: 0, payPrice: a.data.priceGroup.pay_price });
  });
  it.each(['primary', 'scope'] as const)('rejects changed %s rules at an identical amount, then permits explicit reconfirmation', async variant => {
    const a = await request('/api/order/confirm', input); expect(a.status, a.msg).toBe(200);
    if (kind === 'coupon') {
      if (variant === 'primary') await f.db.update(storeCouponUser).set({ useMinPrice: '1.00' }).where(eq(storeCouponUser.id, 41));
      else { await f.db.update(storeCouponIssue).set({ couponType: 2 }); await f.db.insert(storeCouponProduct).values({ couponId: 1, productId: 70 }); }
    } else if (kind === 'package') {
      if (variant === 'primary') await f.db.update(storeDiscounts).set({ isSupportRefund: 0 });
      else await f.db.update(storeDiscountsProducts).set({ type: 1 }).where(eq(storeDiscountsProducts.id, 101));
    } else if (kind === 'bargain') await f.db.update(storeBargain).set(variant === 'primary' ? { deliveryType: '1' } : { stopTime: new Date(Date.now() + 7_200_000) });
    else if (kind === 'seckill') await f.db.update(storeSeckill).set(variant === 'primary' ? { onceNum: 4 } : { stopTime: new Date(Date.now() + 86_400_000) });
    else if (kind === 'combination') await f.db.update(storeCombination).set(variant === 'primary' ? { people: 3 } : { effectiveTime: 7200 });
    else if (kind === 'integral') await f.db.update(storeIntegral).set(variant === 'primary' ? { onceNum: 4 } : { num: 9 });
    else Object.assign(f.config, { newcomer_limit_status: '1', newcomer_limit_time: variant === 'primary' ? '30' : '60' });
    const before = await state(), path = `/api/order/create/${a.data.orderKey}`;
    expect(await request(path, { ...input, quoteToken: a.data.quoteToken })).toMatchObject({ status: 400,
      data: { errorCode: 'ORDER_QUOTE_RECONFIRM_REQUIRED', orderKey: a.data.orderKey } });
    expect(await state()).toEqual(before);
    const b = await request(`/api/order/computed/${a.data.orderKey}`, input); expect(b.status, b.msg).toBe(200);
    expect(b.data.pay_price).toBe(a.data.priceGroup.pay_price); expect(b.data.quoteToken).not.toBe(a.data.quoteToken);
    expect((await request(path, { ...input, quoteToken: b.data.quoteToken })).status).toBe(200);
    expect((await state()).orders).toHaveLength(1);
  });
});
