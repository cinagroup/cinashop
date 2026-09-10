import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createContainerFromDb, type DbClient } from '../src/lib/di';
import { orderCreate } from '../src/controllers/api/v1/OrderController';
import { StoreOrderCreateService } from '../src/services/order/StoreOrderCreateService';
import { OrderQuoteReconfirmRequired } from '../src/services/order/CheckoutConfirmation';
import { assertCheckoutCouponTemplate, couponTemplateSnapshot } from '../src/services/order/CheckoutCouponTemplateAuthority';
import { assertCheckoutCouponItems } from '../src/services/order/CheckoutCouponItemAuthority';
import { prepareCouponScope } from '../src/services/activity/OrderCouponService';
import { ValidateException } from '../src/utils/errors';
import { runCouponProductScopeFence } from '../src/migrations/runCouponProductScopeFence';
import { createPcCheckoutQuoteFixture } from './helpers/pcCheckoutQuoteFixture';
import { sequenceRunnerDatabase } from './helpers/kefuSequenceRunnerDatabase';
import { outcome, waitForFinanceBlock, withFinancePeers } from './helpers/financePeers';
import { storeCouponIssue, storeCouponProduct, storeCouponUser, storeProduct, storeProductCategory, storeBrand, storeCart, storeProductAttrValue,
  storeOrderCartInfo, storeOrderStatus, printDocument, shippingTemplatesFree } from '../src/models/schema';

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('coupon item scope authority in actual checkout', () => {
  let f: Awaited<ReturnType<typeof createPcCheckoutQuoteFixture>>;
  let beforeSequence: (() => Promise<void>) | undefined;
  const input = { cartIds: [1], addressId: 11, couponId: 41, type: 0 };
  beforeEach(async () => {
    beforeSequence = undefined;
    f = await createPcCheckoutQuoteFixture([storeCouponIssue, storeCouponUser, storeCouponProduct,
      storeProductCategory, storeBrand, storeOrderCartInfo, storeOrderStatus, printDocument]);
    await f.setConfig(Object.fromEntries(Object.keys(f.config).map(key => [key, '0'])));
    await f.db.update(storeProduct).set({ cateId: '9', brandId: 9 }).where(eq(storeProduct.id, 70));
    await f.db.insert(storeProductCategory).values([{ id: 9, pid: 1, path: '1,2' }, { id: 10, pid: 1, path: '1,2' }]);
    await f.db.insert(storeBrand).values([{ id: 9, pid: 1, fid: '1,2' }, { id: 10, pid: 1, fid: '1,2' }]);
    await f.db.insert(storeCouponIssue).values({ id: 1, type: 1, couponType: 1, category_id: '9,10,1', brandId: '9,10,1', productId: '70,71' });
    await f.db.insert(storeCouponUser).values({ id: 41, uid: 11, issueCouponId: 1, couponPrice: '1.00', useMinPrice: '0.00' });
    const [identity] = await f.db.select({ schema: sql<string>`current_schema()` }).from(sql`(values (1)) as probe(n)`);
    await runCouponProductScopeFence(f.db, identity.schema);
    f.app.post('/api/order/create/:key', orderCreate);
    Object.assign(f.env, { SEQUENCE: { idFromName: () => 'isolated', get: () => ({ fetch: async () => {
      await beforeSequence?.(); return new Response('coupon_item_scope_isolated');
    } }) } });
  });
  afterEach(async () => { await f?.close(); });
  const request = async (path: string, body: object) => {
    const response = await f.app.request(path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-fixture-user': '11' }, body: JSON.stringify(body) }, f.env);
    return response.json() as Promise<{ status: number; msg: string; data: { orderKey: string; quoteToken: string;
      errorCode?: string; pay_price: string; priceGroup: { pay_price: string } } }>;
  };
  const state = async () => ({ ...await f.snapshot(), coupons: await f.db.select().from(storeCouponUser),
    categories: await f.db.select().from(storeProductCategory).orderBy(storeProductCategory.id),
    brands: await f.db.select().from(storeBrand).orderBy(storeBrand.id),
    details: await f.db.select().from(storeOrderCartInfo), statuses: await f.db.select().from(storeOrderStatus) });
  const create = (db: DbClient, receipt: { orderKey: string; quoteToken: string }) =>
    new StoreOrderCreateService(createContainerFromDb(db), f.env).createOrder({ ...input, uid: 11,
      key: receipt.orderKey, quoteToken: receipt.quoteToken, userIp: '127.0.0.1' });
  const dependency = async () => {
    const [template] = await f.db.select().from(storeCouponIssue), [product] = await f.db.select().from(storeProduct);
    const scope = await prepareCouponScope(f.container, [{ cart: { cartNum: 2 }, product, unitPriceCents: 1000 }], [template]);
    return couponTemplateSnapshot(template, scope.related.get(template.id) ?? [], scope.items);
  };

  const variants = [
    ['product parent', 2, 'UPDATE store_product SET pid=71 WHERE id=70', false],
    ['universal receipt parent', 0, 'UPDATE store_product SET pid=71 WHERE id=70', false],
    ['product direct category', 1, "UPDATE store_product SET cate_id='10' WHERE id=70", false],
    ['product category expansion same discount', 1, "UPDATE store_product SET cate_id='9,10' WHERE id=70", false],
    ['product direct brand', 3, 'UPDATE store_product SET brand_id=10 WHERE id=70', false],
    ['category parent', 1, 'UPDATE store_product_category SET pid=3 WHERE id=9', false],
    ['category path', 1, "UPDATE store_product_category SET path='1,3' WHERE id=9", false],
    ['category deletion', 1, 'DELETE FROM store_product_category WHERE id=9', false],
    ['brand parent', 3, 'UPDATE store_brand SET pid=3 WHERE id=9', false],
    ['brand ancestors', 3, "UPDATE store_brand SET fid='1,3' WHERE id=9", false],
    ['brand deletion', 3, 'DELETE FROM store_brand WHERE id=9', false],
    ['equivalent product parent fallback', 2, 'UPDATE store_product SET pid=70 WHERE id=70', true],
    ['equivalent category encoding', 1, "UPDATE store_product SET cate_id='[9,9,0,-1]' WHERE id=70", true],
    ['equivalent category ancestry', 1, "UPDATE store_product_category SET pid=2,path='[2,1,1]' WHERE id=9", true],
    ['equivalent brand ancestry', 3, "UPDATE store_brand SET pid=2,fid='[2,1,1]' WHERE id=9", true],
    ['category metadata', 1, "UPDATE store_product_category SET cate_name='renamed',is_show=0 WHERE id=9", true],
    ['brand metadata', 3, "UPDATE store_brand SET brand_name='renamed',is_del=1 WHERE id=9", true],
    ['unrelated category', 1, "UPDATE store_product_category SET path='3' WHERE id=10", true],
    ['unrelated brand', 3, "UPDATE store_brand SET fid='3' WHERE id=10", true],
    ['unused product scope fields', 0, "UPDATE store_product SET cate_id='999',brand_id=999 WHERE id=70", true],
  ] as const;
  it.each(variants)('%s after initial calculation', async (_name, scopeType, change, allowed) => {
    await f.db.update(storeCouponIssue).set({ couponType: scopeType });
    const receipt = await request('/api/order/confirm', input); expect(receipt.status, receipt.msg).toBe(200);
    let edited: Awaited<ReturnType<typeof state>> | undefined, calls = 0;
    beforeSequence = async () => { calls++; await f.exec(change); edited = await state(); };
    const path = `/api/order/create/${receipt.data.orderKey}`;
    const result = await request(path, { ...input, quoteToken: receipt.data.quoteToken });
    expect(calls).toBe(1); expect(edited).toBeDefined();
    if (allowed) {
      expect(result.status, result.msg).toBe(200);
      expect((await state()).orders[0]).toMatchObject({ paid: 0, payPrice: receipt.data.priceGroup.pay_price });
      beforeSequence = undefined; f.cache.clear(); const beforeReplay = await state();
      expect((await request(path, { ...input, quoteToken: receipt.data.quoteToken })).status).toBe(200);
      expect(await state()).toEqual(beforeReplay);
    } else {
      expect(result).toMatchObject({ status: 400, data: { errorCode: 'ORDER_QUOTE_RECONFIRM_REQUIRED', orderKey: receipt.data.orderKey } });
      expect(await state()).toEqual(edited);
    }
  });

  it.each([1, 3])('fails closed on a missing positive scope reference (%s)', async scopeType => {
    await f.db.update(storeCouponIssue).set({ couponType: scopeType });
    if (scopeType === 1) await f.db.delete(storeProductCategory).where(eq(storeProductCategory.id, 9));
    else await f.db.delete(storeBrand).where(eq(storeBrand.id, 9));
    // Quoting is read-only and retains its old contract; create cannot lock a missing row.
    const receipt = await request('/api/order/confirm', input); expect(receipt.status, receipt.msg).toBe(200);
    const before = await state();
    expect(await request(`/api/order/create/${receipt.data.orderKey}`, { ...input, quoteToken: receipt.data.quoteToken }))
      .toMatchObject({ status: 400, data: { errorCode: 'ORDER_QUOTE_RECONFIRM_REQUIRED' } });
    expect(await state()).toEqual(before);
  });

  it.each([1, 3])('rejects an independent uncommitted reference update (%s)', async scopeType => {
    await f.db.update(storeCouponIssue).set({ couponType: scopeType });
    const receipt = await request('/api/order/confirm', input); expect(receipt.status, receipt.msg).toBe(200);
    const before = await state();
    await withFinancePeers(f.db, async ([editor, buyer]) => {
      await editor.exec(`BEGIN; UPDATE ${scopeType === 1 ? 'store_product_category' : 'store_brand'} SET pid=3 WHERE id=9`);
      const result = await outcome(create(buyer.db, receipt.data));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBeInstanceOf(OrderQuoteReconfirmRequired);
      expect(await state()).toEqual(before); // Writer is still open, not released by a timeout hook.
      await editor.exec('COMMIT');
    });
  }, 15_000);

  it.each([1, 3])('observes an independent reference commit after calculation (%s)', async scopeType => {
    await f.db.update(storeCouponIssue).set({ couponType: scopeType });
    const receipt = await request('/api/order/confirm', input); expect(receipt.status, receipt.msg).toBe(200);
    await withFinancePeers(f.db, async ([holder, buyer, editor]) => {
      await holder.exec('BEGIN; LOCK TABLE store_order_cart_info IN SHARE MODE');
      const buying = outcome(create(buyer.db, receipt.data));
      await waitForFinanceBlock(f.db, buyer.pid, holder.pid);
      await editor.exec(`UPDATE ${scopeType === 1 ? 'store_product_category' : 'store_brand'} SET pid=3 WHERE id=9`);
      const edited = await state();
      await holder.exec('COMMIT');
      const result = await buying; expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBeInstanceOf(OrderQuoteReconfirmRequired);
      expect(await state()).toEqual(edited);
    });
  }, 15_000);

  it.each([
    [1, 'category', 'commit'], [1, 'category', 'rollback'],
    [3, 'brand', 'commit'], [3, 'brand', 'rollback'],
    [2, 'product', 'commit'], [2, 'product', 'rollback'],
  ] as const)('holds a later writer through actual checkout %s/%s/%s', async (scopeType, target, ending) => {
    await f.db.update(storeCouponIssue).set({ couponType: scopeType });
    const receipt = await request('/api/order/confirm', input); expect(receipt.status, receipt.msg).toBe(200);
    const before = await state();
    await withFinancePeers(f.db, async ([holder, buyer, shippingEditor]) => {
      await holder.exec('BEGIN; LOCK TABLE store_order_cart_info IN SHARE MODE');
      const buying = outcome(create(buyer.db, receipt.data));
      await waitForFinanceBlock(f.db, buyer.pid, holder.pid);
      await shippingEditor.exec('BEGIN; LOCK TABLE shipping_templates_free IN ACCESS EXCLUSIVE MODE');
      await holder.exec('COMMIT');
      await waitForFinanceBlock(f.db, buyer.pid, shippingEditor.pid);
      const table = target === 'category' ? 'store_product_category' : target === 'brand' ? 'store_brand' : 'store_product';
      const editing = outcome(holder.exec(`UPDATE ${table} SET pid=3 WHERE id=${target === 'product' ? 70 : 9}`));
      await waitForFinanceBlock(f.db, holder.pid, buyer.pid);
      if (ending === 'rollback') await shippingEditor.db.insert(shippingTemplatesFree).values({ id: 99, tempId: 10, cityId: 101 });
      await shippingEditor.exec('COMMIT');
      const result = await buying; expect(result.ok).toBe(ending === 'commit');
      if (!result.ok) expect(result.error).toBeInstanceOf(OrderQuoteReconfirmRequired);
      expect((await editing).ok).toBe(true);
      const after = await state();
      const changed = target === 'category' ? 'categories' : target === 'brand' ? 'brands' : 'products';
      expect(after[changed].find(row => row.id === (target === 'product' ? 70 : 9))?.pid).toBe(3);
      if (ending === 'rollback') {
        const restored = after[changed].map(row => ({ ...row, pid: before[changed].find(original => original.id === row.id)!.pid }));
        expect({ ...after, [changed]: restored }).toEqual(before);
      } else {
        expect(after.orders).toHaveLength(1); expect(after.coupons[0].status).toBe(3);
        expect(after.orders[0].payPrice).toBe(receipt.data.priceGroup.pay_price);
      }
    });
  }, 15_000);

  it.each([1, 3])('bounds an incompatible reference relation lock (%s)', async scopeType => {
    await f.db.update(storeCouponIssue).set({ couponType: scopeType });
    const receipt = await request('/api/order/confirm', input); expect(receipt.status, receipt.msg).toBe(200);
    await withFinancePeers(f.db, async ([holder, buyer, editor]) => {
      await holder.exec('BEGIN; LOCK TABLE store_order_cart_info IN SHARE MODE');
      const buying = outcome(create(buyer.db, receipt.data));
      await waitForFinanceBlock(f.db, buyer.pid, holder.pid);
      await editor.exec(`BEGIN; LOCK TABLE ${scopeType === 1 ? 'store_product_category' : 'store_brand'} IN ACCESS EXCLUSIVE MODE`);
      await holder.exec('COMMIT');
      const result = await buying; expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBeInstanceOf(OrderQuoteReconfirmRequired);
      await editor.exec('COMMIT');
      expect((await state()).orders).toHaveLength(0);
    });
  }, 15_000);

  it.each([false, true])('checks a product edit committed after waiting at inventory (equivalent=%s)', async equivalent => {
    await f.db.update(storeCouponIssue).set({ couponType: 2 });
    const receipt = await request('/api/order/confirm', input); expect(receipt.status, receipt.msg).toBe(200);
    const before = await state();
    await withFinancePeers(f.db, async ([editor, buyer]) => {
      await editor.exec(`BEGIN; UPDATE store_product SET pid=${equivalent ? 70 : 71} WHERE id=70`);
      const buying = outcome(create(buyer.db, receipt.data));
      await waitForFinanceBlock(f.db, buyer.pid, editor.pid);
      await editor.exec('COMMIT');
      const result = await buying; expect(result.ok).toBe(equivalent);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(OrderQuoteReconfirmRequired);
        expect(await state()).toEqual({ ...before, products: before.products.map(row => ({ ...row, pid: 71 })) });
      } else expect((await state()).orders).toHaveLength(1);
    });
  }, 15_000);

  it.each([[1, false], [1, true], [3, false], [3, true]] as const)(
    'locks a formerly missing reference created after calculation (%s/equivalent=%s)', async (scopeType, equivalent) => {
      await f.db.update(storeCouponIssue).set({ couponType: scopeType });
      const table = scopeType === 1 ? storeProductCategory : storeBrand;
      await f.db.delete(table).where(eq(table.id, 9));
      const receipt = await request('/api/order/confirm', input); expect(receipt.status, receipt.msg).toBe(200);
      let edited: Awaited<ReturnType<typeof state>> | undefined;
      beforeSequence = async () => { await f.db.insert(table).values({ id: 9, pid: equivalent ? 0 : 3 }); edited = await state(); };
      const result = await request(`/api/order/create/${receipt.data.orderKey}`, { ...input, quoteToken: receipt.data.quoteToken });
      expect(result.status, result.msg).toBe(equivalent ? 200 : 400);
      if (!equivalent) {
        expect(result.data.errorCode).toBe('ORDER_QUOTE_RECONFIRM_REQUIRED');
        expect(await state()).toEqual(edited);
      }
    });

  it.each(['0', '31ms'])('restores caller lock_timeout=%s after scope validation', async timeout => {
    const expected = await dependency();
    await f.db.transaction(async tx => {
      await tx.execute(sql`SELECT set_config('lock_timeout',${timeout},true)`);
      await assertCheckoutCouponTemplate(tx, expected);
      const [setting] = await tx.select({ value: sql<string>`current_setting('lock_timeout')` }).from(sql`(VALUES (1)) AS setting(n)`);
      expect(setting.value).toBe(timeout);
    });
  });

  it.each(['repeatable read', 'serializable'] as const)('rejects stale-snapshot isolation %s', async isolationLevel => {
    const expected = await dependency();
    await expect(f.db.transaction(tx => assertCheckoutCouponTemplate(tx, expected), { isolationLevel })).rejects.toThrow('READ COMMITTED');
  });

  it('rejects root/select-only item authority calls', async () => {
    const expected = await dependency();
    await expect(assertCheckoutCouponItems(f.db, expected.items!, expected.scopeType)).rejects.toThrow('事务内');
    await expect(assertCheckoutCouponItems({ select: f.db.select }, expected.items!, expected.scopeType)).rejects.toThrow('事务内');
  });

  it.each(['55P03', '40P01', '57014', '08006'])('only classifies NOWAIT failures from the item phase (%s)', async code => {
    const expected = await dependency(), failure = new Error('synthetic item phase driver failure', { cause: { code } });
    const checking = f.db.transaction(async tx => {
      let selects = 0;
      const proxy = new Proxy(tx, { get(target, key, receiver) {
        if (key === 'select') return (...args: Parameters<typeof tx.select>) => {
          if (++selects === 2) throw failure; // First SELECT actually locks the template; second starts item verification.
          return target.select(...args);
        };
        return Reflect.get(target, key, receiver);
      } });
      return assertCheckoutCouponTemplate(proxy, expected);
    });
    if (code === '55P03') await expect(checking).rejects.toBeInstanceOf(ValidateException);
    else await expect(checking).rejects.toBe(failure);
  });

  it('allows changed direct category IDs when the complete effective set is equivalent', async () => {
    await f.db.update(storeProductCategory).set({ path: '1,2,9,10' });
    const receipt = await request('/api/order/confirm', input); expect(receipt.status, receipt.msg).toBe(200);
    beforeSequence = async () => { await f.db.update(storeProduct).set({ cateId: '10' }); };
    expect((await request(`/api/order/create/${receipt.data.orderKey}`, { ...input, quoteToken: receipt.data.quoteToken })).status).toBe(200);
  });

  it.each([1, 3])('checks every item including a second non-eligible product (%s)', async scopeType => {
    await f.db.update(storeCouponIssue).set({ couponType: scopeType });
    await f.db.insert(storeProduct).values({ id: 71, storeName: 'second isolated item', cateId: '20', brandId: 20,
      stock: 8, price: '10.00', isShow: 1, isVerify: 1, freight: 3, tempId: 10 });
    await f.db.insert(storeProductAttrValue).values({ id: 2, productId: 71, unique: 'qared002', type: 0, stock: 8, price: '10.00' });
    await f.db.insert(storeCart).values({ id: 2, uid: 11, productId: 71, productAttrUnique: 'qared002', cartNum: 1, isNew: 1, status: 1 });
    await f.db.insert(storeProductCategory).values({ id: 20 }); await f.db.insert(storeBrand).values({ id: 20 });
    const multi = { ...input, cartIds: [2, 1] };
    const receipt = await request('/api/order/confirm', multi); expect(receipt.status, receipt.msg).toBe(200);
    let edited: Awaited<ReturnType<typeof state>> | undefined;
    beforeSequence = async () => {
      await f.exec(`UPDATE ${scopeType === 1 ? 'store_product_category' : 'store_brand'} SET pid=3 WHERE id=20`);
      edited = await state();
    };
    expect(await request(`/api/order/create/${receipt.data.orderKey}`, { ...multi, quoteToken: receipt.data.quoteToken }))
      .toMatchObject({ status: 400, data: { errorCode: 'ORDER_QUOTE_RECONFIRM_REQUIRED' } });
    expect(await state()).toEqual(edited);
  });

  it('requires explicit same-price reconfirmation and preserves successful replay after reference deletion', async () => {
    const receipt = await request('/api/order/confirm', input); expect(receipt.status, receipt.msg).toBe(200);
    beforeSequence = async () => { await f.db.update(storeProductCategory).set({ pid: 3 }).where(eq(storeProductCategory.id, 9)); };
    const path = `/api/order/create/${receipt.data.orderKey}`;
    expect(await request(path, { ...input, quoteToken: receipt.data.quoteToken }))
      .toMatchObject({ status: 400, data: { errorCode: 'ORDER_QUOTE_RECONFIRM_REQUIRED' } });
    beforeSequence = undefined;
    const fresh = await request(`/api/order/computed/${receipt.data.orderKey}`, input); expect(fresh.status, fresh.msg).toBe(200);
    expect(fresh.data.pay_price).toBe(receipt.data.priceGroup.pay_price); expect(fresh.data.quoteToken).not.toBe(receipt.data.quoteToken);
    expect((await request(path, { ...input, quoteToken: fresh.data.quoteToken })).status).toBe(200);
    await f.db.delete(storeProductCategory); f.cache.clear(); const before = await state();
    expect((await request(path, { ...input, quoteToken: receipt.data.quoteToken })).status).toBe(200);
    expect(await state()).toEqual(before); expect(before.orders).toHaveLength(1);
  });
});

it.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL)).each([1, 3])(
  'validates actual nonowner column grants and scope locks on the full ORM schema (%s)', async scopeType => {
    const f = await sequenceRunnerDatabase();
    try {
      const api = await import('drizzle-kit/api'), models = await import('../src/models/schema');
      await f.exec((await api.generateMigration(api.generateDrizzleJson({}), api.generateDrizzleJson(models))).join('\n'));
      await f.db.insert(storeProduct).values({ id: 70, cateId: '9', brandId: 9 });
      await f.db.insert(storeProductCategory).values({ id: 9, pid: 1, path: '1,2' });
      await f.db.insert(storeBrand).values({ id: 9, pid: 1, fid: '1,2' });
      await f.db.insert(storeCouponIssue).values({ id: 1, couponType: scopeType, type: 1, category_id: '9', brandId: '9' });
      const [template] = await f.db.select().from(storeCouponIssue), [product] = await f.db.select().from(storeProduct);
      const scope = await prepareCouponScope(createContainerFromDb(f.db), [{ cart: { cartNum: 2 }, product, unitPriceCents: 1000 }], [template]);
      const expected = couponTemplateSnapshot(template, [], scope.items);
      if (!f.withRuntimeRole || !f.withPeer) throw new Error('Dedicated PostgreSQL runtime peers required');
      await f.withRuntimeRole(async runtime => {
        await f.exec(`GRANT SELECT ON store_coupon_issue,store_product,store_product_category,store_brand TO "${runtime.role}";
          GRANT UPDATE(title) ON store_coupon_issue TO "${runtime.role}"`);
        const denied = async () => {
          const result = await outcome(runtime.db.transaction(tx => assertCheckoutCouponTemplate(tx, expected)));
          expect(result.ok).toBe(false);
          if (!result.ok) {
            let cause: unknown = result.error, code: unknown;
            for (let i = 0; i < 8 && cause && typeof cause === 'object'; i++) {
              if ('code' in cause) code = cause.code;
              if (!('cause' in cause) || cause.cause === cause) break;
              cause = cause.cause;
            }
            expect(code).toBe('42501');
          }
        };
        await denied(); // Template permissions alone do not allow product FOR SHARE.
        await f.exec(`GRANT UPDATE(store_name) ON store_product TO "${runtime.role}"`);
        await denied(); // Referenced category/brand still needs a single UPDATE column.
        const table = scopeType === 1 ? 'store_product_category' : 'store_brand';
        await f.exec(`GRANT UPDATE(${scopeType === 1 ? 'cate_name' : 'brand_name'}) ON ${table} TO "${runtime.role}"`);
        await f.withPeer!(async writer => {
          let writing: ReturnType<typeof outcome> | undefined;
          try {
            await runtime.db.transaction(async tx => {
              await assertCheckoutCouponTemplate(tx, expected);
              writing = outcome(writer.exec(`UPDATE ${table} SET pid=3 WHERE id=9`));
              await waitForFinanceBlock(f.db, writer.pid, runtime.pid);
            });
            expect(writing).toBeDefined(); expect((await writing)?.ok).toBe(true);
          } finally { await writing; }
        });
        await expect(runtime.db.transaction(tx => assertCheckoutCouponTemplate(tx, expected))).rejects.toThrow('范围已变化');
      });
    } finally { await f.close(); }
  }, 120_000);
