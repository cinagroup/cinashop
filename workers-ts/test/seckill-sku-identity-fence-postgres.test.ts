import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { storeActivity, storeSeckillTime, storeSeckill, storeProductAttrValue, storeCart,
  storeOrder, storeOrderCartInfo, storeOrderStatus, printDocument, storeOrderRefund,
  storeOrderRefundPayment, storeOrderInvoice, storeOrderOutbox, userBrokerage, systemStore } from '../src/models/schema';
import { createContainerFromDb } from '../src/lib/di';
import { StoreOrderCreateService, type CreateOrderParams } from '../src/services/order/StoreOrderCreateService';
import { SECKILL_SKU_IDENTITY_FENCE_SQL } from '../src/migrations/seckillSkuIdentityFence';
import { runSeckillSkuIdentityFence } from '../src/migrations/runSeckillSkuIdentityFence';
import { financePostgres } from './helpers/financePostgres';
import { createPcCheckoutQuoteFixture } from './helpers/pcCheckoutQuoteFixture';
import { outcome, waitForFinanceBlock, withFinancePeers } from './helpers/financePeers';

it('keeps external 0166 SQL byte-identical to embedded 0172', () => {
  expect(readFileSync('migrations/0166_seckill_sku_identity_fence.sql', 'utf8').trim())
    .toBe(SECKILL_SKU_IDENTITY_FENCE_SQL.trim());
});

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('active seckill SKU identity on independent PostgreSQL 16 backends', () => {
  let f: Awaited<ReturnType<typeof financePostgres>>;
  beforeEach(async () => {
    f = await financePostgres([storeProductAttrValue], { namespace: 'public' });
    await f.db.insert(storeProductAttrValue).values({ id: 1, productId: 20, type: 1,
      suk: '红色,大号', unique: 'qared001', stock: 8 });
  });
  afterEach(async () => { await f?.close(); });

  const indexRows = async () => Array.from(await f.db.execute(sql`SELECT indexname,indexdef FROM pg_indexes
    WHERE schemaname='public' AND tablename='store_product_attr_value'
      AND indexname IN ('spav_seckill_active_suk_uq','spav_seckill_active_unique_uq')
    ORDER BY indexname`));

  it.each([
    ['suk', 'qablue01', '红色,大号'],
    ['unique', 'qared001', '蓝色,大号'],
  ])('refuses a pre-existing duplicate active %s without changing data or installing either index', async (_label, unique, suk) => {
    await f.db.insert(storeProductAttrValue).values({ id: 2, productId: 20, type: 1, unique, suk });
    const before = await f.db.select().from(storeProductAttrValue);
    await expect(runSeckillSkuIdentityFence(f.db)).rejects.toThrow(/duplicate|重复|ambiguous/i);
    expect(await f.db.select().from(storeProductAttrValue)).toEqual(before);
    expect(await indexRows()).toEqual([]);
  });

  it('enforces both active keys for raw legacy INSERT while allowing a different activity, label and retired replacement', async () => {
    await runSeckillSkuIdentityFence(f.db);
    const installed = await indexRows();
    expect(installed.map(row => row.indexname)).toEqual([
      'spav_seckill_active_suk_uq', 'spav_seckill_active_unique_uq',
    ]);
    expect(installed.every(row => String(row.indexdef).includes('UNIQUE INDEX') && String(row.indexdef).includes('WHERE'))).toBe(true);
    await expect(f.exec(`INSERT INTO store_product_attr_value(id,product_id,type,"unique",suk)
      VALUES (2,20,1,'qablue01','红色,大号')`)).rejects.toMatchObject({ code: '23505' });
    await expect(f.exec(`INSERT INTO store_product_attr_value(id,product_id,type,"unique",suk)
      VALUES (3,20,1,'qared001','蓝色,大号')`)).rejects.toMatchObject({ code: '23505' });
    await f.exec(`INSERT INTO store_product_attr_value(id,product_id,type,"unique",suk) VALUES
      (4,21,1,'qared001','红色,大号'),(5,20,1,'qablue01','蓝色,大号')`);
    await f.exec(`UPDATE store_product_attr_value SET is_retired=1 WHERE id=1`);
    await f.exec(`INSERT INTO store_product_attr_value(id,product_id,type,"unique",suk)
      VALUES (6,20,1,'qared001','红色,大号')`);
    const rows = await f.db.select().from(storeProductAttrValue);
    expect(rows).toHaveLength(4);
    expect(rows.find(row => row.id === 1)?.isRetired).toBe(1);
    expect(rows.find(row => row.id === 6)?.isRetired).toBe(0);
    await runSeckillSkuIdentityFence(f.db);
    expect(await indexRows()).toEqual(installed);
  });

  it('rejects a same-name index with the wrong key instead of silently adopting it', async () => {
    await f.exec(`CREATE INDEX spav_seckill_active_suk_uq ON public.store_product_attr_value(product_id,"unique")`);
    const before = await indexRows();
    await expect(runSeckillSkuIdentityFence(f.db)).rejects.toThrow(/index drift/i);
    expect(await indexRows()).toEqual(before);
  });
});

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('legacy seckill insert after checkout final read', () => {
  let f: Awaited<ReturnType<typeof createPcCheckoutQuoteFixture>>;
  const params: CreateOrderParams = { uid: 11, key: 'sku_phantom_fence', cartIds: [1], type: 1, seckillId: 20,
    shippingType: 2, storeId: 1, realName: '隔离并发样本', userPhone: '00000000000', userIp: '127.0.0.1' };
  beforeEach(async () => {
    f = await createPcCheckoutQuoteFixture([storeActivity, storeSeckillTime, storeSeckill,
      storeOrderCartInfo, storeOrderStatus, printDocument, storeOrderRefund, storeOrderRefundPayment,
      storeOrderInvoice, storeOrderOutbox, userBrokerage]);
    await f.setConfig(Object.fromEntries(Object.keys(f.config).map(key => [key, '0'])));
    await f.db.update(systemStore).set({ isStore: 1 });
    await f.db.update(storeCart).set({ type: 1, activityId: 20 });
    await f.db.insert(storeProductAttrValue).values({ id: 2, productId: 20, type: 1,
      unique: 'qatime01', suk: '红色,大号', stock: 7, quota: 6, price: '6.25' });
    const today = Math.floor((Date.now() + 28_800_000) / 86_400_000) * 86_400 - 28_800;
    await f.db.insert(storeActivity).values({ id: 9, type: 1, status: 1, timeId: '4',
      startDay: today - 86_400, endDay: today + 86_400 });
    await f.db.insert(storeSeckillTime).values({ id: 4, startTime: '0000', endTime: '2400', status: 1 });
    await f.db.insert(storeSeckill).values({ id: 20, productId: 70, activityId: 9, timeId: '4',
      storeName: '隔离秒杀', stock: 7, quota: 6, onceNum: 3, num: 10, status: 1, isShow: 1, isDel: 0 });
    await runSeckillSkuIdentityFence(f.db);
  }, 30_000);
  afterEach(async () => { await f?.close(); });

  it.each([
    ['same suk', 'qaalt001', '红色,大号'],
    ['same unique', 'qatime01', '蓝色,大号'],
  ])('rejects direct SQL %s after buyer passed the last identity read', async (_label, unique, suk) => {
    await withFinancePeers(f.db, async ([holder, buyer, legacy]) => {
      await holder.exec('BEGIN; SELECT id FROM store_cart WHERE id=1 FOR UPDATE');
      let held = true;
      try {
        const pending = outcome(StoreOrderCreateService.createWithRuntime(createContainerFromDb(buyer.db),
          { CONFIG_KV: f.env.CONFIG_KV, nextOrderId: async () => 'isolated_sku_phantom_fence' }, params));
        // Cart claim is after the parent and final active-SKU identity read.
        await waitForFinanceBlock(f.db, buyer.pid, holder.pid);
        await expect(legacy.exec(`INSERT INTO store_product_attr_value(id,product_id,type,"unique",suk)
          VALUES (3,20,1,'${unique}','${suk}')`)).rejects.toMatchObject({ code: '23505' });
        await holder.exec('COMMIT'); held = false;
        expect(await pending).toMatchObject({ ok: true });
      } finally { if (held) await holder.exec('ROLLBACK'); }
    });
    expect(await f.db.select().from(storeOrder)).toHaveLength(1);
    expect((await f.db.select().from(storeProductAttrValue)).map(row => row.id).sort()).toEqual([1, 2]);
    const [cart] = await f.db.select().from(storeCart).where(eq(storeCart.id, 1));
    expect(cart.isPay).toBe(1);
  }, 20_000);
});
