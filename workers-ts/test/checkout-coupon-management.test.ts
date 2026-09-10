import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { eq, sql } from 'drizzle-orm';
import type { AppVariables, Env } from '../src/env';
import { createContainerFromDb, type DbClient } from '../src/lib/di';
import { orderCreate } from '../src/controllers/api/v1/OrderController';
import { adminCouponSave, adminCategorySave, adminCategoryDel, adminBrandSave } from '../src/controllers/api/v1/AdminCrudController';
import { couponCreate, couponStatus, couponDelete } from '../src/controllers/out/OutApiController';
import { runCouponProductScopeFence } from '../src/migrations/runCouponProductScopeFence';
import { createPcCheckoutQuoteFixture } from './helpers/pcCheckoutQuoteFixture';
import { waitForFinanceBlock, withFinancePeers, type FinancePeer } from './helpers/financePeers';
import { sequenceRunnerDatabase } from './helpers/kefuSequenceRunnerDatabase';
import { storeCouponIssue, storeCouponProduct, storeCouponUser, storeCouponIssueUser, storeProduct, storeProductCategory, storeBrand,
  storeOrderCartInfo, storeOrderStatus, printDocument, shippingTemplatesFree, outCouponWriteReplay,
  storeProductCoupon, luckPrize, luckLottery, storePromotions, storePromotionsAuxiliary, systemConfig } from '../src/models/schema';

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL)).each(['columns', 'orm'] as const)('real coupon management HTTP handlers versus checkout (%s)', schemaMode => {
  let f: Awaited<ReturnType<typeof createPcCheckoutQuoteFixture>>;
  let fullDatabase: Awaited<ReturnType<typeof sequenceRunnerDatabase>> | undefined;
  let beforeSequence: (() => Promise<void>) | undefined;
  const input = { cartIds: [1], addressId: 11, couponId: 41, type: 0 };
  const adminBody = { id: 1, title: 'managed coupon', type: 2, coupon_type: 1, product_id: '70', coupon_price: '1.00', use_min_price: '0.00' };
  const outBody = { coupon_title: 'out isolated coupon', coupon_price: '1.00', use_min_price: '0.00', coupon_time: 7,
    receive_type: 1, is_permanent: 1, type: 2, product_id: '70', coupon_type: 1, status: 0 };
  const withPeers = async (run: (peers: [FinancePeer, FinancePeer, FinancePeer]) => Promise<void>) => {
    if (!fullDatabase) return withFinancePeers(f.db, run);
    const connect = fullDatabase.withPeer;
    if (!connect) throw new Error('Full schema tests require dedicated PostgreSQL peers');
    await connect(first => connect(second => connect(async third => {
      const [observer] = await f.db.select({ pid: sql<number>`pg_backend_pid()` }).from(sql`(values (1)) as probe(n)`);
      if (new Set([observer.pid, first.pid, second.pid, third.pid]).size !== 4) throw new Error('Expected four distinct full-schema backends');
      await run([first, second, third]);
    })));
  };
  const application = (db: DbClient) => {
    const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
    app.use('*', async (c, next) => {
      c.set('container', createContainerFromDb(db)); c.set('uid', 11); c.set('adminId', 1);
      // Identity/KV/Sequence are synthetic; controller/service/DAO and SQL are real.
      // This suite does not claim to exercise production authentication middleware.
      c.set('outInfo', { id: 7, appid: 'isolated', title: 'local test', rules: [] }); await next();
    });
    app.onError((error, c) => c.json({ status: 400, msg: error.message, data: null }));
    app.post('/api/order/create/:key', orderCreate);
    app.post('/admin/coupon/save', adminCouponSave);
    app.post('/admin/category/save', adminCategorySave); app.delete('/admin/category/:id', adminCategoryDel);
    app.post('/admin/brand/save', adminBrandSave);
    app.post('/outapi/coupon', couponCreate); app.put('/outapi/coupon/status/:id/:status', couponStatus); app.delete('/outapi/coupon/:id', couponDelete);
    return app;
  };
  beforeEach(async () => {
    beforeSequence = undefined;
    fullDatabase = undefined;
    const createFullDatabase = async () => {
      const owned = await sequenceRunnerDatabase();
      try {
        const api = await import('drizzle-kit/api'), models = await import('../src/models/schema');
        await owned.exec((await api.generateMigration(api.generateDrizzleJson({}), api.generateDrizzleJson(models))).join('\n'));
        fullDatabase = owned;
        return owned;
      } catch (error) { await owned.close(); throw error; }
    };
    f = await createPcCheckoutQuoteFixture([storeCouponIssue, storeCouponUser, storeCouponProduct, storeCouponIssueUser,
      storeProductCategory, storeBrand, storeOrderCartInfo, storeOrderStatus, printDocument, outCouponWriteReplay,
      storeProductCoupon, luckPrize, luckLottery, storePromotions, storePromotionsAuxiliary, systemConfig], schemaMode === 'orm' ? createFullDatabase : undefined);
    await f.setConfig(Object.fromEntries(Object.keys(f.config).map(key => [key, '0'])));
    await f.db.update(storeProduct).set({ cateId: '9', brandId: 9 }).where(eq(storeProduct.id, 70));
    await f.db.insert(storeProduct).values({ id: 71, storeName: 'unrelated eligible scope item', isShow: 1, isVerify: 1 });
    await f.db.insert(storeProductCategory).values({ id: 9 }); await f.db.insert(storeBrand).values({ id: 9 });
    await f.db.insert(storeCouponIssue).values({ id: 1, type: 1, couponType: 2, productId: '70', legacyProductIds: '70',
      couponTitle: 'managed coupon', title: 'managed coupon', couponPrice: '1.00', day: 7, status: 0, receiveType: 1, isPermanent: 1 });
    await f.db.insert(storeCouponProduct).values({ couponId: 1, productId: 70 });
    await f.db.insert(storeCouponUser).values({ id: 41, uid: 11, issueCouponId: 1, couponPrice: '1.00', useMinPrice: '0.00' });
    await f.exec("SELECT setval(pg_get_serial_sequence('store_coupon_issue','id'),100,true)");
    const [identity] = await f.db.select({ schema: sql<string>`current_schema()` }).from(sql`(values (1)) as probe(n)`);
    await runCouponProductScopeFence(f.db, identity.schema);
    Object.assign(f.env, { SEQUENCE: { idFromName: () => 'isolated', get: () => ({ fetch: async () => {
      await beforeSequence?.(); return new Response('coupon_management_isolated');
    } }) } });
  }, 120_000);
  // Full ORM database disposal can wait for a server-wide disk checkpoint.
  // Await bounded cleanup; keep the SQL and business-test timeouts unchanged.
  afterEach(async () => { await f?.close(); }, 120_000);
  const request = async (app: ReturnType<typeof application>, path: string, body?: object, method = 'POST', key?: string) => {
    const response = await app.request(path, { method, headers: { 'content-type': 'application/json', 'x-fixture-user': '11',
      ...(key ? { 'Idempotency-Key': key } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }, f.env);
    return response.json() as Promise<{ status: number; msg: string; data: { id: number; idempotent: boolean; errorCode?: string;
      orderKey: string; quoteToken: string; pay_price: string; priceGroup: { pay_price: string }; preserved_usage: { issued_rows: number; reserved_rows: number } } }>;
  };
  const confirm = async () => { const result = await request(f.app, '/api/order/confirm', input); expect(result.status, result.msg).toBe(200); return result.data; };
  const buy = (db: DbClient, receipt: Awaited<ReturnType<typeof confirm>>) =>
    request(application(db), `/api/order/create/${receipt.orderKey}`, { ...input, quoteToken: receipt.quoteToken });
  const state = async () => ({ ...await f.snapshot(), coupons: await f.db.select().from(storeCouponUser),
    templates: await f.db.select().from(storeCouponIssue).orderBy(storeCouponIssue.id),
    relations: await f.db.select().from(storeCouponProduct).orderBy(storeCouponProduct.couponId, storeCouponProduct.productId),
    categories: await f.db.select().from(storeProductCategory).orderBy(storeProductCategory.id),
    brands: await f.db.select().from(storeBrand).orderBy(storeBrand.id),
    replays: await f.db.select().from(outCouponWriteReplay).orderBy(outCouponWriteReplay.id),
    details: await f.db.select().from(storeOrderCartInfo), statuses: await f.db.select().from(storeOrderStatus) });

  it.each(['expand', 'equivalent', 'universal'] as const)('rechecks an actual admin save after calculation (%s)', async change => {
    const receipt = await confirm(); let edited: Awaited<ReturnType<typeof state>> | undefined;
    beforeSequence = async () => {
      const result = await request(application(f.db), '/admin/coupon/save', { ...adminBody,
        product_id: change === 'expand' ? '70,71' : '70,70', type: change === 'universal' ? 0 : 2 });
      expect(result.status, result.msg).toBe(200); edited = await state();
    };
    const result = await buy(f.db, receipt); expect(edited).toBeDefined();
    expect(result.status, result.msg).toBe(change === 'equivalent' ? 200 : 400);
    if (change !== 'equivalent') {
      expect(result.data.errorCode).toBe('ORDER_QUOTE_RECONFIRM_REQUIRED'); expect(await state()).toEqual(edited);
      beforeSequence = undefined;
      const fresh = await request(f.app, `/api/order/computed/${receipt.orderKey}`, input); expect(fresh.status, fresh.msg).toBe(200);
      expect(fresh.data.pay_price).toBe(receipt.priceGroup.pay_price);
      expect((await buy(f.db, { ...receipt, quoteToken: fresh.data.quoteToken })).status).toBe(200);
    }
  });

  it('rejects checkout while a real admin save owns the template and waits to replace relations', async () => {
    const receipt = await confirm(), before = await state();
    await withPeers(async ([holder, admin, buyer]) => {
      await holder.exec('BEGIN; LOCK TABLE store_coupon_product IN SHARE MODE');
      const saving = request(application(admin.db), '/admin/coupon/save', { ...adminBody, product_id: '70,71' });
      await waitForFinanceBlock(f.db, admin.pid, holder.pid);
      expect(await buy(buyer.db, receipt)).toMatchObject({ status: 400, data: { errorCode: 'ORDER_QUOTE_RECONFIRM_REQUIRED' } });
      expect(await state()).toEqual(before);
      await holder.exec('COMMIT'); expect((await saving).status).toBe(200);
    });
    expect((await state()).relations).toEqual([{ couponId: 1, productId: 70 }, { couponId: 1, productId: 71 }]);
  }, 15_000);

  it.each(['commit', 'rollback'] as const)('holds real admin replacement until checkout %s', async ending => {
    const receipt = await confirm(), before = await state();
    await withPeers(async ([holder, buyer, shippingEditor]) => {
      await holder.exec('BEGIN; LOCK TABLE store_order_cart_info IN SHARE MODE');
      const buying = buy(buyer.db, receipt); await waitForFinanceBlock(f.db, buyer.pid, holder.pid);
      await shippingEditor.exec('BEGIN; LOCK TABLE shipping_templates_free IN ACCESS EXCLUSIVE MODE');
      await holder.exec('COMMIT'); await waitForFinanceBlock(f.db, buyer.pid, shippingEditor.pid);
      const saving = request(application(holder.db), '/admin/coupon/save', { ...adminBody, product_id: '70,71' });
      await waitForFinanceBlock(f.db, holder.pid, buyer.pid);
      if (ending === 'rollback') await shippingEditor.db.insert(shippingTemplatesFree).values({ id: 99, tempId: 10, cityId: 101 });
      await shippingEditor.exec('COMMIT'); const result = await buying;
      expect(result.status, result.msg).toBe(ending === 'commit' ? 200 : 400); expect((await saving).status).toBe(200);
      const after = await state(); expect(after.relations).toHaveLength(2);
      if (ending === 'rollback') expect({ ...after, templates: before.templates, relations: before.relations }).toEqual(before);
      else expect(after.orders).toHaveLength(1);
    });
  }, 15_000);

  it.each([false, true])('rolls back real admin template and relations after a relation insert error (new=%s)', async isNew => {
    await f.exec("CREATE FUNCTION test_reject_relation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'isolated relation write failure'; END $$; CREATE TRIGGER test_reject_relation BEFORE INSERT ON store_coupon_product FOR EACH ROW EXECUTE FUNCTION test_reject_relation()");
    const before = await state();
    const result = await request(application(f.db), '/admin/coupon/save', { ...adminBody, id: isNew ? undefined : 1, product_id: '70,71', title: 'must roll back' });
    expect(result.status).toBe(400); expect(result.msg).toContain('store_coupon_product'); expect(await state()).toEqual(before);
  });

  it.each(['commit', 'rollback'] as const)('Out creation waits for checkout inventory until %s and replays once', async ending => {
    const receipt = await confirm(), key = crypto.randomUUID(), before = await state();
    await withPeers(async ([holder, buyer, shippingEditor]) => {
      await holder.exec('BEGIN; LOCK TABLE store_order_cart_info IN SHARE MODE');
      const buying = buy(buyer.db, receipt); await waitForFinanceBlock(f.db, buyer.pid, holder.pid);
      await shippingEditor.exec('BEGIN; LOCK TABLE shipping_templates_free IN ACCESS EXCLUSIVE MODE');
      await holder.exec('COMMIT'); await waitForFinanceBlock(f.db, buyer.pid, shippingEditor.pid);
      const creating = request(application(holder.db), '/outapi/coupon', outBody, 'POST', key);
      await waitForFinanceBlock(f.db, holder.pid, buyer.pid);
      if (ending === 'rollback') await shippingEditor.db.insert(shippingTemplatesFree).values({ id: 99, tempId: 10, cityId: 101 });
      await shippingEditor.exec('COMMIT'); expect((await buying).status).toBe(ending === 'commit' ? 200 : 400);
      const created = await creating; expect(created.status, created.msg).toBe(200);
      const after = await state(); expect(after.templates).toHaveLength(2); expect(after.replays).toHaveLength(1);
      expect(after.relations).toContainEqual({ couponId: created.data.id, productId: 70 });
      expect(after.orders).toHaveLength(ending === 'commit' ? 1 : 0);
      if (ending === 'rollback') expect({ ...after, templates: before.templates, relations: before.relations, replays: before.replays }).toEqual(before);
      expect(await request(application(holder.db), '/outapi/coupon', outBody, 'POST', key)).toMatchObject({ status: 200, data: { id: created.data.id, idempotent: true } });
      expect(await state()).toEqual(after);
    });
  }, 15_000);

  it('checkout waits for the real Out creation ledger commit without a self-lock failure', async () => {
    const receipt = await confirm(), key = crypto.randomUUID();
    await withPeers(async ([holder, out, buyer]) => {
      await holder.exec('BEGIN; LOCK TABLE out_coupon_write_replay IN SHARE MODE');
      const creating = request(application(out.db), '/outapi/coupon', outBody, 'POST', key);
      await waitForFinanceBlock(f.db, out.pid, holder.pid);
      const buying = buy(buyer.db, receipt); await waitForFinanceBlock(f.db, buyer.pid, out.pid);
      await holder.exec('COMMIT'); expect((await creating).status).toBe(200); expect((await buying).status).toBe(200);
    });
    const after = await state(); expect(after.templates).toHaveLength(2); expect(after.replays).toHaveLength(1); expect(after.orders).toHaveLength(1);
  }, 15_000);

  it('rolls back Out template, relations and replay together on a final ledger error, then retries once', async () => {
    await f.exec("CREATE FUNCTION test_reject_replay() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'isolated ledger failure'; END $$; CREATE TRIGGER test_reject_replay BEFORE INSERT ON out_coupon_write_replay FOR EACH ROW EXECUTE FUNCTION test_reject_replay()");
    const before = await state(), key = crypto.randomUUID(), app = application(f.db);
    const failed = await request(app, '/outapi/coupon', outBody, 'POST', key);
    expect(failed.status).toBe(400); expect(failed.msg).toContain('out_coupon_write_replay'); expect(await state()).toEqual(before);
    await f.exec('DROP TRIGGER test_reject_replay ON out_coupon_write_replay; DROP FUNCTION test_reject_replay()');
    const created = await request(app, '/outapi/coupon', outBody, 'POST', key); expect(created.status, created.msg).toBe(200);
    expect(await request(app, '/outapi/coupon', outBody, 'POST', key)).toMatchObject({ status: 200, data: { id: created.data.id, idempotent: true } });
    const after = await state(); expect(after.templates).toHaveLength(2); expect(after.relations).toHaveLength(2); expect(after.replays).toHaveLength(1);
  });

  it('breaks the real Out-enable template-to-inventory reverse wait by refusing checkout', async () => {
    const receipt = await confirm(), key = crypto.randomUUID(), before = await state();
    await withPeers(async ([holder, buyer, out]) => {
      await holder.exec('BEGIN; LOCK TABLE store_order_cart_info IN SHARE MODE');
      const buying = buy(buyer.db, receipt); await waitForFinanceBlock(f.db, buyer.pid, holder.pid);
      const enabling = request(application(out.db), '/outapi/coupon/status/1/1', undefined, 'PUT', key);
      await waitForFinanceBlock(f.db, out.pid, buyer.pid);
      await holder.exec('COMMIT'); expect(await buying).toMatchObject({ status: 400, data: { errorCode: 'ORDER_QUOTE_RECONFIRM_REQUIRED' } });
      const result = await enabling; expect(result.status, result.msg).toBe(200);
    });
    const after = await state(); expect(after.templates[0].status).toBe(1); expect(after.replays).toHaveLength(1);
    expect({ ...after, templates: before.templates, replays: before.replays }).toEqual(before);
  }, 15_000);

  it.each(['commit', 'rollback'] as const)('Out deletion waits through checkout %s and preserves issued scope', async ending => {
    const receipt = await confirm(), key = crypto.randomUUID();
    await withPeers(async ([holder, buyer, shippingEditor]) => {
      await holder.exec('BEGIN; LOCK TABLE store_order_cart_info IN SHARE MODE');
      const buying = buy(buyer.db, receipt); await waitForFinanceBlock(f.db, buyer.pid, holder.pid);
      await shippingEditor.exec('BEGIN; LOCK TABLE shipping_templates_free IN ACCESS EXCLUSIVE MODE');
      await holder.exec('COMMIT'); await waitForFinanceBlock(f.db, buyer.pid, shippingEditor.pid);
      const deleting = request(application(holder.db), '/outapi/coupon/1', undefined, 'DELETE', key);
      await waitForFinanceBlock(f.db, holder.pid, buyer.pid);
      const [locks] = await f.db.select({ held: sql<number>`count(*)::int` }).from(sql`pg_locks`)
        .where(sql`pid = ${holder.pid} AND relation = 'system_config'::regclass AND granted
          AND mode IN ('ShareRowExclusiveLock', 'ExclusiveLock', 'AccessExclusiveLock')`);
      expect(locks.held).toBe(0);
      if (ending === 'rollback') await shippingEditor.db.insert(shippingTemplatesFree).values({ id: 99, tempId: 10, cityId: 101 });
      await shippingEditor.exec('COMMIT'); const bought = await buying;
      expect(bought.status, bought.msg).toBe(ending === 'commit' ? 200 : 400);
      const deleted = await deleting; expect(deleted.status, deleted.msg).toBe(200);
      expect(deleted.data.preserved_usage).toMatchObject({ issued_rows: 1, reserved_rows: ending === 'commit' ? 1 : 0 });
      const after = await state(); expect(after.relations).toEqual([{ couponId: 1, productId: 70 }]);
      expect(after.templates[0]).toMatchObject({ isDel: 1, status: -1 }); expect(after.replays).toHaveLength(1);
      expect(await request(application(holder.db), '/outapi/coupon/1', undefined, 'DELETE', key)).toMatchObject({ status: 200, data: { idempotent: true } });
      expect(await state()).toEqual(after);
    });
  }, 15_000);
  it('refuses deletion under a held config write lock and releases its coupon lock', async () => {
    const key = crypto.randomUUID(), before = await state();
    await withPeers(async ([holder, out]) => {
      await holder.exec("BEGIN; LOCK TABLE system_config IN ROW EXCLUSIVE MODE");
      const deleted = await request(application(out.db), '/outapi/coupon/1', undefined, 'DELETE', key);
      expect(deleted).toMatchObject({ status: 400, msg: '优惠券发放配置正在更新，请稍后重试' });
      expect(await state()).toEqual(before);
      // The failed transaction released its coupon lock too.
      await holder.exec('SELECT id FROM store_coupon_issue WHERE id=1 FOR UPDATE NOWAIT; COMMIT');
      expect((await request(application(out.db), '/outapi/coupon/1', undefined, 'DELETE', key)).status).toBe(200);
      expect((await state()).replays).toHaveLength(1);
    });
  }, 15_000);

  it.each(['category-change', 'category-delete', 'category-cosmetic', 'brand-cosmetic'] as const)(
    'rechecks actual reference management after calculation (%s)', async operation => {
      const brand = operation === 'brand-cosmetic';
      expect((await request(application(f.db), '/admin/coupon/save', { ...adminBody, type: brand ? 3 : 1,
        category_id: '9', brand_id: '9' })).status).toBe(200);
      const receipt = await confirm(); let edited: Awaited<ReturnType<typeof state>> | undefined;
      beforeSequence = async () => {
        const result = operation === 'category-delete'
          ? await request(application(f.db), '/admin/category/9', undefined, 'DELETE')
          : await request(application(f.db), brand ? '/admin/brand/save' : '/admin/category/save', {
            id: 9, pid: operation === 'category-change' ? 3 : 0, cate_name: 'renamed', brand_name: 'renamed', is_show: 0,
          });
        expect(result.status, result.msg).toBe(200); edited = await state();
      };
      const result = await buy(f.db, receipt), allowed = operation.endsWith('cosmetic');
      expect(result.status, result.msg).toBe(allowed ? 200 : 400);
      if (!allowed) { expect(result.data.errorCode).toBe('ORDER_QUOTE_RECONFIRM_REQUIRED'); expect(await state()).toEqual(edited); }
    });

  it.each([
    ['category', 'commit'], ['category', 'rollback'], ['brand', 'commit'], ['brand', 'rollback'],
  ] as const)('holds the real %s save until checkout %s', async (target, ending) => {
    const isBrand = target === 'brand';
    expect((await request(application(f.db), '/admin/coupon/save', { ...adminBody, type: isBrand ? 3 : 1, category_id: '9', brand_id: '9' })).status).toBe(200);
    const receipt = await confirm(), before = await state();
    await withPeers(async ([holder, buyer, shippingEditor]) => {
      await holder.exec('BEGIN; LOCK TABLE store_order_cart_info IN SHARE MODE');
      const buying = buy(buyer.db, receipt); await waitForFinanceBlock(f.db, buyer.pid, holder.pid);
      await shippingEditor.exec('BEGIN; LOCK TABLE shipping_templates_free IN ACCESS EXCLUSIVE MODE');
      await holder.exec('COMMIT'); await waitForFinanceBlock(f.db, buyer.pid, shippingEditor.pid);
      const saving = request(application(holder.db), isBrand ? '/admin/brand/save' : '/admin/category/save',
        { id: 9, pid: 3, brand_name: 'later brand', cate_name: 'later category' });
      await waitForFinanceBlock(f.db, holder.pid, buyer.pid);
      if (ending === 'rollback') await shippingEditor.db.insert(shippingTemplatesFree).values({ id: 99, tempId: 10, cityId: 101 });
      await shippingEditor.exec('COMMIT'); expect((await buying).status).toBe(ending === 'commit' ? 200 : 400);
      expect((await saving).status).toBe(200); const after = await state();
      if (ending === 'rollback') expect({ ...after, categories: before.categories, brands: before.brands }).toEqual(before);
      else expect(after.orders).toHaveLength(1);
      if (isBrand) expect(after.brands[0].brandName).toBe('later brand'); else expect(after.categories[0].pid).toBe(3);
    });
  }, 15_000);

  it.each([1, 2])('applies a coupon created through the real Out HTTP chain (scope=%s)', async scopeType => {
    const key = crypto.randomUUID(), app = application(f.db);
    const created = await request(app, '/outapi/coupon', { ...outBody, type: scopeType, category_id: '9' }, 'POST', key);
    expect(created.status, created.msg).toBe(200);
    // Synthetic already-issued wallet row; issuance/authentication are separate contracts.
    await f.db.update(storeCouponUser).set({ issueCouponId: created.data.id }).where(eq(storeCouponUser.id, 41));
    const receipt = await confirm(); expect((await buy(f.db, receipt)).status).toBe(200);
    const after = await state(); expect(after.orders[0]).toMatchObject({ couponId: 41, couponPrice: '1.00', paid: 0 });
    expect(after.coupons[0].status).toBe(3); expect(after.replays).toHaveLength(1);
  });

  it('concurrent real Out requests with the same key create one template, scope and replay', async () => {
    const key = crypto.randomUUID();
    await withPeers(async ([holder, first, second]) => {
      await holder.exec('BEGIN; LOCK TABLE out_coupon_write_replay IN SHARE MODE');
      const creating = request(application(first.db), '/outapi/coupon', outBody, 'POST', key);
      await waitForFinanceBlock(f.db, first.pid, holder.pid);
      const retrying = request(application(second.db), '/outapi/coupon', outBody, 'POST', key);
      await waitForFinanceBlock(f.db, second.pid, first.pid);
      await holder.exec('COMMIT'); const a = await creating, b = await retrying;
      expect(a.status, a.msg).toBe(200); expect(b).toMatchObject({ status: 200, data: { id: a.data.id, idempotent: true } });
    });
    const after = await state(); expect(after.templates).toHaveLength(2); expect(after.relations).toHaveLength(2); expect(after.replays).toHaveLength(1);
  }, 15_000);
});
