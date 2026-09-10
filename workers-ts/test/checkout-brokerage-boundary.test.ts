import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createContainerFromDb, type DbClient } from '../src/lib/di';
import { orderCreate } from '../src/controllers/api/v1/OrderController';
import { OrderQuoteReconfirmRequired } from '../src/services/order/CheckoutConfirmation';
import { StoreOrderCreateService } from '../src/services/order/StoreOrderCreateService';
import { agentLevel, printDocument, storeOrderCartInfo, storeOrderStatus, storeProduct, storeProductAttrValue,
  user, userBrokerage } from '../src/models/schema';
import { createPcCheckoutQuoteFixture } from './helpers/pcCheckoutQuoteFixture';
import { outcome, waitForFinanceBlock, withFinancePeers } from './helpers/financePeers';

describe('checkout product/SKU brokerage boundary', () => {
  let f: Awaited<ReturnType<typeof createPcCheckoutQuoteFixture>>;
  let beforeSequence: (() => Promise<void>) | undefined;
  const input = { cartIds: [1], addressId: 11, type: 0 };
  beforeEach(async () => {
    f = await createPcCheckoutQuoteFixture([agentLevel, storeOrderCartInfo, storeOrderStatus, printDocument, userBrokerage]);
    beforeSequence = undefined;
    await f.setConfig(Object.fromEntries(Object.keys(f.config).map(key => [key, '0'])));
    Object.assign(f.config, { brokerage_func_status: '1', store_brokerage_statu: '1', brokerage_level: '2',
      brokerage_compute_type: '1', store_brokerage_ratio: '10', store_brokerage_two: '5', division_status: '0' });
    await f.db.update(user).set({ spreadUid: 22 }).where(eq(user.uid, 11));
    await f.db.insert(user).values([
      { uid: 22, account: 'local-first', isPromoter: 1, spreadOpen: 1, status: 1, spreadUid: 33 },
      { uid: 33, account: 'local-second', isPromoter: 1, spreadOpen: 1, status: 1 },
    ]);
    await f.db.update(storeProduct).set({ isSub: 1 }).where(eq(storeProduct.id, 70));
    await f.db.update(storeProductAttrValue).set({ brokerage: '0.30', brokerageTwo: '0.10' }).where(eq(storeProductAttrValue.id, 1));
    f.app.post('/api/order/create/:key', orderCreate);
    Object.assign(f.env, { SEQUENCE: { idFromName: () => 'isolated', get: () => ({ fetch: async () => {
      await beforeSequence?.(); return new Response('brokerage_boundary_order');
    } }) } });
  }, 30_000);
  afterEach(async () => { await f?.close(); });
  const request = async (path: string, body: object) => {
    const response = await f.app.request(path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-fixture-user': '11' }, body: JSON.stringify(body) }, f.env);
    return response.json() as Promise<{ status: number; msg: string; data: { orderKey: string; quoteToken: string; errorCode?: string; pay_price?: string; priceGroup: { pay_price: string } } }>;
  };
  const state = async () => ({ ...await f.snapshot(), details: await f.db.select().from(storeOrderCartInfo),
    statuses: await f.db.select().from(storeOrderStatus), brokerageRows: await f.db.select().from(userBrokerage) });
  const variants = ['one', 'two', 'zero-one', 'enable', 'disable', 'not-specified', 'disabled-feature',
    'disabled-second', 'ineligible-first', 'ineligible-both', 'division-switch', 'division-unused-amount'] as const;
  type Variant = typeof variants[number];
  const permitted = (variant: Variant) => ['not-specified', 'disabled-feature', 'disabled-second',
    'ineligible-first', 'ineligible-both', 'division-unused-amount'].includes(variant);
  const changesProduct = (variant: Variant) => ['enable', 'disable', 'disabled-feature', 'ineligible-both', 'division-switch'].includes(variant);
  const prepare = async (variant: Variant) => {
    if (variant === 'enable' || variant === 'not-specified') await f.db.update(storeProduct).set({ isSub: 0 }).where(eq(storeProduct.id, 70));
    if (variant === 'disabled-feature') f.config.brokerage_func_status = '0';
    if (variant === 'disabled-second') f.config.brokerage_level = '1';
    if (variant.startsWith('ineligible') || variant.startsWith('division')) await f.db.update(user).set({ isPromoter: 0 }).where(eq(user.uid, 22));
    if (variant === 'ineligible-both' || variant.startsWith('division')) await f.db.update(user).set({ isPromoter: 0 }).where(eq(user.uid, 33));
    if (variant.startsWith('division')) {
      Object.assign(f.config, { division_status: '1', store_brokerage_ratio: '0', store_brokerage_two: '0' });
      await f.db.update(user).set({ divisionId: 44 }).where(eq(user.uid, 11));
      await f.db.insert(user).values({ uid: 44, account: 'local-division', divisionType: 1, divisionStatus: 1,
        divisionPercent: 20, divisionEndTime: Math.floor(Date.now() / 1000) + 3600 });
    }
  };
  const edit = async (db: DbClient, variant: Variant) => {
    if (changesProduct(variant)) await db.update(storeProduct).set({ isSub: variant === 'enable' ? 1 : 0 }).where(eq(storeProduct.id, 70));
    else await db.update(storeProductAttrValue).set(variant === 'two' || variant === 'disabled-second'
      ? { brokerageTwo: '0.25' } : { brokerage: variant === 'zero-one' ? '0.00' : '0.75' }).where(eq(storeProductAttrValue.id, 1));
  };
  const assertOrder = async (variant: Variant, price: string | undefined) => {
    const after = await state(); expect(after.orders).toHaveLength(1);
    const one = variant === 'one' ? '1.50' : variant === 'disable' || variant === 'not-specified' ? '2.00'
      : ['zero-one', 'disabled-feature', 'ineligible-first', 'ineligible-both', 'division-switch', 'division-unused-amount'].includes(variant) ? '0.00' : '0.60';
    const two = variant === 'two' ? '0.50' : variant === 'disable' || variant === 'not-specified' ? '1.00'
      : ['disabled-feature', 'disabled-second', 'ineligible-both', 'division-switch', 'division-unused-amount'].includes(variant) ? '0.00' : '0.20';
    expect(after.orders[0]).toMatchObject({ paid: 0, payPrice: price, oneBrokerage: one, twoBrokerage: two,
      divisionBrokerage: variant === 'division-switch' ? '4.00' : '0.00' });
    expect(after.brokerageRows).toEqual([]);
    expect(after.users.every(account => account.brokeragePrice === '0.00')).toBe(true);
  };
  for (const phase of ['between', 'late'] as const) it.each(variants)(`${phase} HTTP brokerage %s`, async variant => {
    await prepare(variant);
    const receipt = await request('/api/order/confirm', input); expect(receipt.status, receipt.msg).toBe(200);
    let edited: Awaited<ReturnType<typeof state>> | undefined;
    const editing = async () => { await edit(f.db, variant); edited = await state(); };
    if (phase === 'between') await editing(); else beforeSequence = editing;
    const path = `/api/order/create/${receipt.data.orderKey}`;
    const result = await request(path, { ...input, quoteToken: receipt.data.quoteToken, oneBrokerage: '9999', twoBrokerage: '9999' });
    if (phase === 'late' && !permitted(variant)) {
      expect(result).toMatchObject({ status: 400, data: { errorCode: 'ORDER_QUOTE_RECONFIRM_REQUIRED', orderKey: receipt.data.orderKey } });
      expect(edited).toBeDefined(); expect(await state()).toEqual(edited);
      beforeSequence = undefined;
      const refreshed = await request(`/api/order/computed/${receipt.data.orderKey}`, input); expect(refreshed.status, refreshed.msg).toBe(200);
      expect(refreshed.data.pay_price).toBe(receipt.data.priceGroup.pay_price);
      expect((await request(path, { ...input, quoteToken: refreshed.data.quoteToken })).status).toBe(200);
    } else expect(result.status, result.msg).toBe(200);
    await assertOrder(variant, receipt.data.priceGroup.pay_price);
    await f.db.update(storeProduct).set({ isSub: 0 }).where(eq(storeProduct.id, 70));
    await f.db.update(storeProductAttrValue).set({ brokerage: '9.00', brokerageTwo: '9.00' }).where(eq(storeProductAttrValue.id, 1));
    beforeSequence = undefined; f.cache.clear(); const beforeReplay = await state();
    expect((await request(path, { ...input, quoteToken: receipt.data.quoteToken })).status).toBe(200);
    expect(await state()).toEqual(beforeReplay);
  });
  it.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL)).each(variants)('independent PostgreSQL brokerage writer %s', async variant => {
    await prepare(variant);
    const receipt = await request('/api/order/confirm', input); expect(receipt.status, receipt.msg).toBe(200);
    const before = await state();
    await withFinancePeers(f.db, async ([editor, buyer]) => {
      await editor.exec('BEGIN'); await edit(editor.db, variant);
      const edited = { ...before, products: await editor.db.select().from(storeProduct), skus: await editor.db.select().from(storeProductAttrValue) };
      const buying = outcome(new StoreOrderCreateService(createContainerFromDb(buyer.db), f.env).createOrder({ ...input,
        uid: 11, key: receipt.data.orderKey, quoteToken: receipt.data.quoteToken, userIp: '127.0.0.1' }));
      await waitForFinanceBlock(f.db, buyer.pid, editor.pid); await editor.exec('COMMIT');
      const result = await buying;
      if (permitted(variant)) { expect(result.ok).toBe(true); await assertOrder(variant, receipt.data.priceGroup.pay_price); }
      else { expect(result.ok).toBe(false); if (!result.ok) expect(result.error).toBeInstanceOf(OrderQuoteReconfirmRequired); expect(await state()).toEqual(edited); }
    });
  }, 15_000);
  it.each(['one', 'disable'] as const)('HTTP integral-locked recalculation retains brokerage dependencies (%s)', async variant => {
    await f.setConfig({ integral_ratio_status: '1', integral_ratio: '0.01', integral_max_type: '1', integral_max_num: '50' });
    const selection = { ...input, useIntegral: true };
    const receipt = await request('/api/order/confirm', selection); expect(receipt.status, receipt.msg).toBe(200);
    let edited: Awaited<ReturnType<typeof state>> | undefined;
    beforeSequence = async () => { await edit(f.db, variant); edited = await state(); };
    const path = `/api/order/create/${receipt.data.orderKey}`;
    expect(await request(path, { ...selection, quoteToken: receipt.data.quoteToken })).toMatchObject({
      status: 400, data: { errorCode: 'ORDER_QUOTE_RECONFIRM_REQUIRED' },
    });
    expect(edited).toBeDefined(); expect(await state()).toEqual(edited);
    beforeSequence = undefined;
    const refreshed = await request(`/api/order/computed/${receipt.data.orderKey}`, selection); expect(refreshed.status, refreshed.msg).toBe(200);
    expect((await request(path, { ...selection, quoteToken: refreshed.data.quoteToken })).status).toBe(200);
    await assertOrder(variant, refreshed.data.pay_price);
    const after = await state();
    expect(after.orders[0].useIntegral).toBe('50.00');
    expect(after.users.find(account => account.uid === 11)?.integral).toBe(50);
  });
  it.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL)).each(['one', 'disable'] as const)(
    'independent PostgreSQL integral-locked brokerage recalculation (%s)', async variant => {
      await f.setConfig({ integral_ratio_status: '1', integral_ratio: '0.01', integral_max_type: '1', integral_max_num: '50' });
      const selection = { ...input, useIntegral: true };
      const receipt = await request('/api/order/confirm', selection); expect(receipt.status, receipt.msg).toBe(200);
      const before = await state();
      await withFinancePeers(f.db, async ([editor, buyer]) => {
        await editor.exec('BEGIN'); await edit(editor.db, variant);
        const edited = { ...before, products: await editor.db.select().from(storeProduct), skus: await editor.db.select().from(storeProductAttrValue) };
        const buying = outcome(new StoreOrderCreateService(createContainerFromDb(buyer.db), f.env).createOrder({ ...selection,
          uid: 11, key: receipt.data.orderKey, quoteToken: receipt.data.quoteToken, userIp: '127.0.0.1' }));
        await waitForFinanceBlock(f.db, buyer.pid, editor.pid); await editor.exec('COMMIT');
        const result = await buying; expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error).toBeInstanceOf(OrderQuoteReconfirmRequired);
        expect(await state()).toEqual(edited);
      });
    }, 15_000);
});
