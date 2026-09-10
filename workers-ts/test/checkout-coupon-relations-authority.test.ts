import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createContainerFromDb, type DbClient } from '../src/lib/di';
import { orderCreate } from '../src/controllers/api/v1/OrderController';
import { StoreOrderCreateService } from '../src/services/order/StoreOrderCreateService';
import { OrderQuoteReconfirmRequired } from '../src/services/order/CheckoutConfirmation';
import { runCouponProductScopeFence } from '../src/migrations/runCouponProductScopeFence';
import { assertCheckoutCouponTemplate, couponTemplateSnapshot } from '../src/services/order/CheckoutCouponTemplateAuthority';
import { ValidateException } from '../src/utils/errors';
import { createPcCheckoutQuoteFixture } from './helpers/pcCheckoutQuoteFixture';
import { outcome, waitForFinanceBlock, withFinancePeers } from './helpers/financePeers';
import { storeCouponIssue, storeCouponProduct, storeCouponUser, storeOrderCartInfo, storeOrderStatus,
  printDocument, shippingTemplatesFree } from '../src/models/schema';

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('coupon relation authority in real checkout transactions', () => {
  let f: Awaited<ReturnType<typeof createPcCheckoutQuoteFixture>>;
  let beforeSequence: (() => Promise<void>) | undefined;
  const input = { cartIds: [1], addressId: 11, couponId: 41, type: 0 };
  beforeEach(async () => {
    beforeSequence = undefined;
    f = await createPcCheckoutQuoteFixture([storeCouponIssue, storeCouponUser, storeCouponProduct, storeOrderCartInfo, storeOrderStatus, printDocument]);
    await f.setConfig(Object.fromEntries(Object.keys(f.config).map(key => [key, '0'])));
    await f.db.insert(storeCouponIssue).values([{ id: 1, type: 1, couponType: 2 }, { id: 2, type: 1, couponType: 2 }]);
    await f.db.insert(storeCouponProduct).values({ couponId: 1, productId: 70 });
    await f.db.insert(storeCouponUser).values({ id: 41, uid: 11, issueCouponId: 1, couponPrice: '1.00', useMinPrice: '0.00' });
    const [row] = await f.db.select({ schema: sql<string>`current_schema()` }).from(sql`(values (1)) as probe(n)`);
    await runCouponProductScopeFence(f.db, row.schema);
    f.app.post('/api/order/create/:key', orderCreate);
    Object.assign(f.env, { SEQUENCE: { idFromName: () => 'isolated', get: () => ({ fetch: async () => {
      await beforeSequence?.(); return new Response('coupon_relations_isolated');
    } }) } });
  });
  afterEach(async () => { await f?.close(); });
  const request = async (path: string, body: object) => {
    const response = await f.app.request(path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-fixture-user': '11' }, body: JSON.stringify(body) }, f.env);
    return response.json() as Promise<{ status: number; msg: string; data: { orderKey: string; quoteToken: string;
      errorCode?: string; pay_price: string; priceGroup: { pay_price: string } } }>;
  };
  const state = async () => ({ ...await f.snapshot(), coupons: await f.db.select().from(storeCouponUser),
    relations: await f.db.select().from(storeCouponProduct).orderBy(storeCouponProduct.couponId, storeCouponProduct.productId),
    details: await f.db.select().from(storeOrderCartInfo), statuses: await f.db.select().from(storeOrderStatus) });
  const create = (db: DbClient, receipt: { orderKey: string; quoteToken: string }) =>
    new StoreOrderCreateService(createContainerFromDb(db), f.env).createOrder({ ...input, uid: 11,
      key: receipt.orderKey, quoteToken: receipt.quoteToken, userIp: '127.0.0.1' });

  const variants = [
    ['expand', 'INSERT INTO store_coupon_product VALUES(1,71)', false],
    ['replace', 'UPDATE store_coupon_product SET product_id=71 WHERE coupon_id=1', false],
    ['last-delete', 'DELETE FROM store_coupon_product WHERE coupon_id=1', false],
    ['transfer-out', 'UPDATE store_coupon_product SET coupon_id=2 WHERE coupon_id=1', false],
    ['first-insert', 'INSERT INTO store_coupon_product VALUES(1,71)', false],
    ['truncate', 'TRUNCATE store_coupon_product', false],
    ['duplicates', 'INSERT INTO store_coupon_product VALUES(1,70),(1,70)', true],
    ['nonpositive-ids', 'INSERT INTO store_coupon_product VALUES(1,0),(1,-1)', true],
    ['unrelated', 'INSERT INTO store_coupon_product VALUES(2,71)', true],
    ['encoding-fallback', 'DELETE FROM store_coupon_product WHERE coupon_id=1', true],
    ['overflow', 'INSERT INTO store_coupon_product SELECT 1,70 FROM generate_series(1,20000)', false],
  ] as const;
  it.each(variants)('rechecks late relation changes after initial validation: %s', async (name, statement, allowed) => {
    if (name === 'first-insert' || name === 'encoding-fallback') {
      await f.db.update(storeCouponIssue).set({ productId: '70' }).where(eq(storeCouponIssue.id, 1));
      if (name === 'first-insert') await f.exec('DELETE FROM store_coupon_product WHERE coupon_id=1');
    }
    const receipt = await request('/api/order/confirm', input); expect(receipt.status, receipt.msg).toBe(200);
    let changed: Awaited<ReturnType<typeof state>> | undefined, calls = 0;
    beforeSequence = async () => { calls++; await f.exec(statement); changed = await state(); };
    const path = `/api/order/create/${receipt.data.orderKey}`;
    const result = await request(path, { ...input, quoteToken: receipt.data.quoteToken });
    expect(calls).toBe(1); expect(changed).toBeDefined();
    if (allowed) {
      expect(result.status, result.msg).toBe(200); const after = await state();
      expect(after.orders).toHaveLength(1); expect(after.orders[0]).toMatchObject({ paid: 0, payPrice: receipt.data.priceGroup.pay_price });
      beforeSequence = undefined; f.cache.clear();
      expect((await request(path, { ...input, quoteToken: receipt.data.quoteToken })).status).toBe(200); expect(await state()).toEqual(after);
    } else {
      expect(result).toMatchObject({ status: 400, data: { errorCode: 'ORDER_QUOTE_RECONFIRM_REQUIRED', orderKey: receipt.data.orderKey } });
      expect(await state()).toEqual(changed);
      if (name === 'expand') {
        beforeSequence = undefined;
        const fresh = await request(`/api/order/computed/${receipt.data.orderKey}`, input); expect(fresh.status, fresh.msg).toBe(200);
        expect(fresh.data.pay_price).toBe(receipt.data.priceGroup.pay_price);
        expect((await request(path, { ...input, quoteToken: fresh.data.quoteToken })).status).toBe(200);
      }
    }
  });
  it.each(['missing', 'disabled', 'body', 'replica-trigger', 'rls', 'nullable', 'inheritance',
    'definer', 'function-path', 'trigger-event', 'trigger-when', 'template-rls', 'deferred-pk'] as const)(
    'refuses an unavailable or drifted protocol: %s', async drift => {
      const receipt = await request('/api/order/confirm', input); expect(receipt.status, receipt.msg).toBe(200);
      if (drift === 'missing') await f.exec('DROP TRIGGER coupon_product_insert_0151 ON store_coupon_product');
      if (drift === 'disabled') await f.exec('ALTER TABLE store_coupon_product DISABLE TRIGGER coupon_product_update_0151');
      if (drift === 'body') await f.exec('CREATE OR REPLACE FUNCTION coupon_product_scope_fence_0151() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN RETURN NULL; END $$');
      if (drift === 'replica-trigger') await f.exec('ALTER TABLE store_coupon_product ENABLE REPLICA TRIGGER coupon_product_delete_0151');
      if (drift === 'rls') await f.exec('ALTER TABLE store_coupon_product ENABLE ROW LEVEL SECURITY');
      if (drift === 'nullable') await f.exec('ALTER TABLE store_coupon_product ALTER COLUMN product_id DROP NOT NULL');
      if (drift === 'inheritance') await f.exec('CREATE TABLE fixture_scope_child() INHERITS(store_coupon_product)');
      if (drift === 'definer') await f.exec('ALTER FUNCTION coupon_product_scope_fence_0151() SECURITY DEFINER');
      if (drift === 'function-path') await f.exec('ALTER FUNCTION coupon_product_scope_fence_0151() SET search_path=public');
      if (drift === 'trigger-event') await f.exec(`DROP TRIGGER coupon_product_update_0151 ON store_coupon_product;
        CREATE TRIGGER coupon_product_update_0151 AFTER INSERT ON store_coupon_product REFERENCING NEW TABLE AS coupon_scope_new
        FOR EACH STATEMENT EXECUTE FUNCTION coupon_product_scope_fence_0151()`);
      if (drift === 'trigger-when') await f.exec(`DROP TRIGGER coupon_product_update_0151 ON store_coupon_product;
        CREATE TRIGGER coupon_product_update_0151 AFTER UPDATE ON store_coupon_product REFERENCING OLD TABLE AS coupon_scope_old NEW TABLE AS coupon_scope_new
        FOR EACH STATEMENT WHEN (false) EXECUTE FUNCTION coupon_product_scope_fence_0151()`);
      if (drift === 'template-rls') await f.exec('ALTER TABLE store_coupon_issue ENABLE ROW LEVEL SECURITY');
      if (drift === 'deferred-pk') await f.exec('ALTER TABLE store_coupon_issue DROP CONSTRAINT store_coupon_issue_pkey; ALTER TABLE store_coupon_issue ADD PRIMARY KEY(id) DEFERRABLE');
      const before = await state();
      expect(await request(`/api/order/create/${receipt.data.orderKey}`, { ...input, quoteToken: receipt.data.quoteToken }))
        .toMatchObject({ status: 400, data: { errorCode: 'ORDER_QUOTE_RECONFIRM_REQUIRED' } });
      expect(await state()).toEqual(before);
    });

  it.each(['INSERT INTO store_coupon_product VALUES(1,71)', 'DELETE FROM store_coupon_product WHERE coupon_id=1',
    'UPDATE store_coupon_product SET coupon_id=2 WHERE coupon_id=1'])('rejects an uncommitted relation writer before a reverse wait: %s', async statement => {
    const receipt = await request('/api/order/confirm', input); expect(receipt.status, receipt.msg).toBe(200);
    const before = await state();
    await withFinancePeers(f.db, async ([editor, buyer]) => {
      await editor.exec(`BEGIN; ${statement}`);
      const result = await outcome(create(buyer.db, receipt.data));
      expect(result.ok).toBe(false); if (!result.ok) expect(result.error).toBeInstanceOf(OrderQuoteReconfirmRequired);
      expect(await state()).toEqual(before); await editor.exec('ROLLBACK');
    });
    expect(await state()).toEqual(before);
  }, 15_000);
  it.each([false, true])('re-reads an independent commit after initial calculation; equivalent=%s', async equivalent => {
    const receipt = await request('/api/order/confirm', input); expect(receipt.status, receipt.msg).toBe(200);
    await withFinancePeers(f.db, async ([holder, buyer, editor]) => {
      await holder.exec('BEGIN; LOCK TABLE store_order_cart_info IN SHARE MODE');
      const buying = outcome(create(buyer.db, receipt.data));
      await waitForFinanceBlock(f.db, buyer.pid, holder.pid);
      await editor.exec(`INSERT INTO store_coupon_product VALUES(1,${equivalent ? 70 : 71})`);
      const changed = await state(); await holder.exec('COMMIT');
      const result = await buying; expect(result.ok).toBe(equivalent);
      if (!result.ok) { expect(result.error).toBeInstanceOf(OrderQuoteReconfirmRequired); expect(await state()).toEqual(changed); }
      else expect((await state()).orders).toHaveLength(1);
    });
  }, 15_000);
  it.each(['commit', 'rollback'] as const)('holds relation writers through actual checkout %s', async ending => {
    const receipt = await request('/api/order/confirm', input); expect(receipt.status, receipt.msg).toBe(200);
    const before = await state();
    await withFinancePeers(f.db, async ([holder, buyer, shippingEditor]) => {
      await holder.exec('BEGIN; LOCK TABLE store_order_cart_info IN SHARE MODE');
      const buying = outcome(create(buyer.db, receipt.data)); await waitForFinanceBlock(f.db, buyer.pid, holder.pid);
      await shippingEditor.exec('BEGIN; LOCK TABLE shipping_templates_free IN ACCESS EXCLUSIVE MODE');
      await holder.exec('COMMIT'); await waitForFinanceBlock(f.db, buyer.pid, shippingEditor.pid);
      const editing = outcome(holder.exec('INSERT INTO store_coupon_product VALUES(1,71)'));
      await waitForFinanceBlock(f.db, holder.pid, buyer.pid);
      if (ending === 'rollback') await shippingEditor.db.insert(shippingTemplatesFree).values({ id: 99, tempId: 10, cityId: 101 });
      await shippingEditor.exec('COMMIT'); const result = await buying; expect(result.ok).toBe(ending === 'commit');
      if (!result.ok) expect(result.error).toBeInstanceOf(OrderQuoteReconfirmRequired);
      expect((await editing).ok).toBe(true); const after = await state();
      if (ending === 'rollback') expect({ ...after, relations: before.relations }).toEqual(before);
      else { expect(after.orders).toHaveLength(1); expect(after.coupons[0].status).toBe(3); }
      expect(after.relations).toContainEqual({ couponId: 1, productId: 71 });
    });
  }, 15_000);
  it('holds a later TRUNCATE until the actual checkout commits', async () => {
    const receipt = await request('/api/order/confirm', input); expect(receipt.status, receipt.msg).toBe(200);
    await withFinancePeers(f.db, async ([holder, buyer, shippingEditor]) => {
      await holder.exec('BEGIN; LOCK TABLE store_order_cart_info IN SHARE MODE');
      const buying = outcome(create(buyer.db, receipt.data)); await waitForFinanceBlock(f.db, buyer.pid, holder.pid);
      await shippingEditor.exec('BEGIN; LOCK TABLE shipping_templates_free IN ACCESS EXCLUSIVE MODE');
      await holder.exec('COMMIT'); await waitForFinanceBlock(f.db, buyer.pid, shippingEditor.pid);
      const truncating = outcome(holder.exec('TRUNCATE store_coupon_product'));
      await waitForFinanceBlock(f.db, holder.pid, buyer.pid); await shippingEditor.exec('COMMIT');
      expect((await buying).ok).toBe(true); expect((await truncating).ok).toBe(true);
    });
    const after = await state(); expect(after.orders).toHaveLength(1); expect(after.relations).toEqual([]);
  }, 15_000);
  it.each(['relation', 'template'] as const)('rejects an incompatible %s table lock immediately after initial validation', async target => {
    const receipt = await request('/api/order/confirm', input); expect(receipt.status, receipt.msg).toBe(200);
    await withFinancePeers(f.db, async ([holder, buyer, editor]) => {
      await holder.exec('BEGIN; LOCK TABLE store_order_cart_info IN SHARE MODE');
      const buying = outcome(create(buyer.db, receipt.data)); await waitForFinanceBlock(f.db, buyer.pid, holder.pid);
      await editor.exec(target === 'relation' ? 'BEGIN; LOCK TABLE store_coupon_product IN ACCESS EXCLUSIVE MODE'
        : 'BEGIN; LOCK TABLE store_coupon_issue IN EXCLUSIVE MODE');
      await holder.exec('COMMIT'); const result = await buying;
      expect(result.ok).toBe(false); if (!result.ok) expect(result.error).toBeInstanceOf(OrderQuoteReconfirmRequired);
      await editor.exec('ROLLBACK');
    });
    expect((await state()).orders).toHaveLength(0);
  }, 15_000);
  it.each(['repeatable read', 'serializable', 'replica'] as const)('rejects an incompatible transaction/session contract: %s', async mode => {
    const [template] = await f.db.select().from(storeCouponIssue).where(eq(storeCouponIssue.id, 1));
    await withFinancePeers(f.db, async ([reader]) => {
      if (mode === 'replica') await reader.exec("SET session_replication_role='replica'");
      const result = await outcome(reader.db.transaction(async tx => assertCheckoutCouponTemplate(tx, couponTemplateSnapshot(template, [70])),
        { isolationLevel: mode === 'replica' ? 'read committed' : mode }));
      expect(result.ok).toBe(false); if (!result.ok) expect(String(result.error)).toContain('保护尚未就绪');
      if (mode === 'replica') await reader.exec("SET session_replication_role='origin'");
    });
  });
  it.each([0, 1, 3] as const)('does not require relation protocol for scope type %s', async scopeType => {
    // Direct guard control: full category/brand checkout requires its own fixtures.
    await f.exec('DROP TRIGGER coupon_product_insert_0151 ON store_coupon_product');
    await f.db.update(storeCouponIssue).set({ couponType: scopeType }).where(eq(storeCouponIssue.id, 1));
    const [template] = await f.db.select().from(storeCouponIssue).where(eq(storeCouponIssue.id, 1));
    await f.db.transaction(async tx => assertCheckoutCouponTemplate(tx, couponTemplateSnapshot(template, [])));
  });
  it('returns an already created order without requiring the relation protocol again', async () => {
    const receipt = await request('/api/order/confirm', input); expect(receipt.status, receipt.msg).toBe(200);
    const path = `/api/order/create/${receipt.data.orderKey}`;
    expect((await request(path, { ...input, quoteToken: receipt.data.quoteToken })).status).toBe(200);
    await f.exec('DROP TRIGGER coupon_product_insert_0151 ON store_coupon_product; TRUNCATE store_coupon_product');
    f.cache.clear(); const before = await state();
    expect((await request(path, { ...input, quoteToken: receipt.data.quoteToken })).status).toBe(200); expect(await state()).toEqual(before);
  });
  it.each(['55P03', '40P01', '57014', '08006'])('preserves error classification in the added relation-lock path: %s', async code => {
    const [template] = await f.db.select().from(storeCouponIssue).where(eq(storeCouponIssue.id, 1));
    const failure = new Error('synthetic relation failure', { cause: { code } });
    const checking = assertCheckoutCouponTemplate({ select: () => { throw new Error('must not query after a failed lock'); },
      execute: () => { throw failure; } }, couponTemplateSnapshot(template, [70]));
    if (code === '55P03') await expect(checking).rejects.toBeInstanceOf(ValidateException);
    else await expect(checking).rejects.toBe(failure);
  });
  it.each(['0', '31ms'])('restores the caller lock timeout after bounded template-relation acquisition: %s', async timeout => {
    const [template] = await f.db.select().from(storeCouponIssue).where(eq(storeCouponIssue.id, 1));
    await f.db.transaction(async tx => {
      await tx.execute(sql`SELECT set_config('lock_timeout',${timeout},true)`);
      await assertCheckoutCouponTemplate(tx, couponTemplateSnapshot(template, [70]));
      const [settings] = await tx.select({ timeout: sql<string>`current_setting('lock_timeout')` }).from(sql`(values (1)) as probe(n)`);
      expect(settings.timeout).toBe(timeout);
    });
  });
});
