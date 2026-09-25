import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { eq, sql } from 'drizzle-orm';
import type { AppVariables, Env } from '../src/env';
import { createContainerFromDb, withTx, type DbClient } from '../src/lib/di';
import { adminActivitySave } from '../src/controllers/api/v1/AdminCrudController';
import { saveAdminShippingTemplate } from '../src/services/admin/AdminShippingTemplateService';
import { readAdminShippingSnapshot } from '../src/services/admin/AdminShippingTemplateSnapshot';
import { StoreOrderCreateService, type CreateOrderParams } from '../src/services/order/StoreOrderCreateService';
import {
  printDocument, shippingTemplatesRegion, storeActivity, storeCart,
  storeOrderCartInfo, storeOrderOutbox, storeOrderPurchaseOrigin, storeOrderStatus,
  storeProductAttrValue, storeSeckill, storeSeckillTime, systemConfig,
} from '../src/models/schema';
import { createPcCheckoutQuoteFixture } from './helpers/pcCheckoutQuoteFixture';
import { sequenceRunnerDatabase } from './helpers/kefuSequenceRunnerDatabase';
import { installShippingTemplateLifecycleCandidate } from './helpers/shippingTemplateLifecycleCandidate';
import { outcome, waitForFinanceBlock } from './helpers/financePeers';
import { completePurchaseOriginEvidenceOrm } from '../src/migrations/runPurchaseOriginEvidence';
import { completePurchaseCancellationEvidenceOrm } from '../src/migrations/runPurchaseCancellationEvidence';

// The full ORM and installed shipping lifecycle trigger matter here: the
// selected-table checkout fixture alone cannot reveal the Admin/checkout lock
// interaction when an existing seckill retains a shipping template.
describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('seckill Admin and shared-rule locks on native PostgreSQL 16', () => {
  let owned: Awaited<ReturnType<typeof sequenceRunnerDatabase>>;
  let f: Awaited<ReturnType<typeof createPcCheckoutQuoteFixture>>;
  const params: CreateOrderParams = {
    uid: 11, key: 'seckill_shared', cartIds: [1], type: 1, seckillId: 20,
    shippingType: 1, addressId: 11, cityId: 101,
    realName: '本地买家', userPhone: '00000000000', userIp: '127.0.0.1',
  };

  beforeEach(async () => {
    f = await createPcCheckoutQuoteFixture([
      storeActivity, storeSeckillTime, storeSeckill, storeOrderCartInfo,
      storeOrderStatus, storeOrderOutbox, storeOrderPurchaseOrigin, printDocument,
    ], async () => {
      owned = await sequenceRunnerDatabase();
      try {
        if (owned.format !== 'pg16') throw new Error('Independent PostgreSQL 16 backends required');
        const api = await import('drizzle-kit/api'), schema = await import('../src/models/schema');
        await owned.exec((await api.generateMigration(api.generateDrizzleJson({}), api.generateDrizzleJson(schema))).join('\n'));
        await completePurchaseOriginEvidenceOrm(owned.db);
        await completePurchaseCancellationEvidenceOrm(owned.db);
        await installShippingTemplateLifecycleCandidate(owned.db);
        return owned;
      } catch (error) { await owned.close(); throw error; }
    });
    await f.setConfig(Object.fromEntries(Object.keys(f.config).map(key => [key, '0'])));
    await f.db.update(storeCart).set({ type: 1, activityId: 20 });
    await f.db.insert(storeProductAttrValue).values({ id: 2, productId: 20, type: 1,
      unique: 'qatime01', suk: '红色,大号', stock: 7, quota: 6, price: '6.25' });
    const today = Math.floor((Date.now() + 28_800_000) / 86_400_000) * 86_400 - 28_800;
    await f.db.insert(storeActivity).values({ id: 9, type: 1, status: 1,
      timeId: '4', startDay: today - 86_400, endDay: today + 86_400 });
    await f.db.insert(storeSeckillTime).values({ id: 4, startTime: '0000', endTime: '2400', status: 1 });
    await f.db.insert(storeSeckill).values({ id: 20, productId: 70, activityId: 9, timeId: '4',
      storeName: '本地秒杀', stock: 7, quota: 6, onceNum: 3, num: 10,
      status: 1, isShow: 1, isDel: 0, freight: 3, tempId: 10 });
    const triggers = await owned.query("SELECT tgname FROM pg_trigger WHERE tgrelid='store_seckill'::regclass AND tgname='shipping_lifecycle_child' AND tgenabled='O'");
    expect(triggers.rows).toHaveLength(1);
  }, 120_000);

  afterEach(async () => { await f?.close(); }, 120_000);

  const create = (db: DbClient, key: string) => StoreOrderCreateService.createWithRuntime(
    createContainerFromDb(db),
    { CONFIG_KV: f.env.CONFIG_KV, nextOrderId: async () => `isolated_${key}` },
    { ...params, key },
  );
  const businessState = async () => ({ ...await f.snapshot(),
    children: await f.db.select().from(storeSeckill),
    lines: await f.db.select().from(storeOrderCartInfo),
    statuses: await f.db.select().from(storeOrderStatus),
    outbox: await f.db.select().from(storeOrderOutbox),
    origins: await f.db.select().from(storeOrderPurchaseOrigin),
    prints: await f.db.select().from(printDocument),
  });

  it('buyer holds the seckill child: real Admin save refuses NOWAIT before release and holds no source/template lock', async () => {
    const peer = owned.withPeer;
    if (!peer) throw new Error('Independent PostgreSQL 16 peers required');
    const before = await businessState();
    await peer(holder => peer(buyer => peer(async editor => {
      const admin = new Hono<{ Bindings: Env; Variables: AppVariables }>();
      admin.use('*', async (c, next) => { c.set('container', createContainerFromDb(editor.db)); await next(); });
      admin.onError((error, c) => c.json({ status: 400, msg: error.message, data: null }));
      admin.post('/activity/save', adminActivitySave);
      await holder.exec('BEGIN; SELECT id FROM store_cart WHERE id=1 FOR UPDATE');
      let pending = true;
      try {
        const buying = outcome(create(buyer.db, 'buyer_first'));
        await waitForFinanceBlock(f.db, buyer.pid, holder.pid);
        const response = await admin.request('/activity/save', { method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ type: 'seckill', id: 20, num: 1 }),
        }, f.env);
        const result = await response.json() as { status: number; msg: string };
        expect(result.status).toBe(400);
        expect(result.msg).toBe('运费模板正在更新，请稍后重试');
        // The buyer still owns the schedule. A separate transaction can take
        // both source and template locks after Admin's failed save returns.
        await editor.exec('BEGIN; SELECT id FROM store_product WHERE id=70 FOR UPDATE NOWAIT; SELECT id FROM shipping_templates WHERE id=10 FOR UPDATE NOWAIT; ROLLBACK');
        expect(await businessState()).toEqual(before);
        await holder.exec('COMMIT');
        pending = false;
        expect(await buying).toMatchObject({ ok: true });
      } finally { if (pending) await holder.exec('ROLLBACK'); }
    })));
    const [order] = (await f.snapshot()).orders;
    expect(order).toMatchObject({ type: 1, payPostage: '6.00', payPrice: '18.50' });
    const [child] = await f.db.select({ num: storeSeckill.num }).from(storeSeckill).where(eq(storeSeckill.id, 20));
    expect(child.num).toBe(10);
  }, 40_000);

  it('a committed system pricing edit while type-1 checkout waits rejects every business write', async () => {
    const peer = owned.withPeer;
    if (!peer) throw new Error('Independent PostgreSQL 16 peers required');
    const before = await businessState();
    await peer(holder => peer(buyer => peer(async editor => {
      await holder.exec('BEGIN; SELECT id FROM store_cart WHERE id=1 FOR UPDATE');
      let pending = true;
      try {
        const buying = outcome(create(buyer.db, 'pricing_edit'));
        await waitForFinanceBlock(f.db, buyer.pid, holder.pid);
        await editor.exec("UPDATE system_config SET value='1' WHERE menu_name='whole_free_shipping'");
        await holder.exec('COMMIT');
        pending = false;
        expect(await buying).toMatchObject({ ok: false, error: { message: expect.stringContaining('计价配置') } });
      } finally { if (pending) await holder.exec('ROLLBACK'); }
    })));
    expect(await businessState()).toEqual(before);
    const [config] = await f.db.select({ value: systemConfig.value }).from(systemConfig)
      .where(eq(systemConfig.menuName, 'whole_free_shipping'));
    expect(config.value).toBe('1');
  }, 40_000);

  it('a type-1 buyer holds the old pricing fence through commit while the new rule writer waits', async () => {
    const peer = owned.withPeer;
    if (!peer) throw new Error('Independent PostgreSQL 16 peers required');
    await peer(holder => peer(buyer => peer(async editor => {
      await holder.exec('BEGIN; SELECT pg_advisory_xact_lock(731641, 20)');
      let pending = true;
      try {
        const buying = outcome(withTx(createContainerFromDb(buyer.db), async tx => {
          const result = await create(tx, 'buyer_rule_first');
          await tx.execute(sql`SELECT pg_advisory_xact_lock(731641, 20)`);
          return result;
        }));
        await waitForFinanceBlock(f.db, buyer.pid, holder.pid);
        const editing = outcome(editor.exec("UPDATE system_config SET value='1' WHERE menu_name='whole_free_shipping'"));
        await waitForFinanceBlock(f.db, editor.pid, buyer.pid);
        await holder.exec('COMMIT');
        pending = false;
        expect(await buying).toMatchObject({ ok: true });
        expect(await editing).toMatchObject({ ok: true });
      } finally { if (pending) await holder.exec('ROLLBACK'); }
    })));
    const [order] = (await f.snapshot()).orders;
    expect(order).toMatchObject({ type: 1, payPostage: '6.00', payPrice: '18.50' });
    const [config] = await f.db.select({ value: systemConfig.value }).from(systemConfig)
      .where(eq(systemConfig.menuName, 'whole_free_shipping'));
    expect(config.value).toBe('1');
  }, 40_000);

  it('a real Admin shipping edit committed during a type-1 cart wait invalidates the old delivery quote', async () => {
    const peer = owned.withPeer;
    if (!peer) throw new Error('Independent PostgreSQL 16 peers required');
    const before = await businessState();
    await peer(holder => peer(buyer => peer(async editor => {
      await holder.exec('BEGIN; SELECT id FROM store_cart WHERE id=1 FOR UPDATE');
      let pending = true;
      try {
        const buying = outcome(create(buyer.db, 'shipping_edit'));
        await waitForFinanceBlock(f.db, buyer.pid, holder.pid);
        const revision = (await readAdminShippingSnapshot(editor.db, 10)).revision;
        await saveAdminShippingTemplate(createContainerFromDb(editor.db), { id: 10, expectedRevision: revision,
          regions: [{ region_id: 101, region_name: '测试甲市', first: '2', first_price: '9',
            continue: '1', continue_price: '1' }] });
        await holder.exec('COMMIT');
        pending = false;
        expect(await buying).toMatchObject({ ok: false, error: { message: expect.stringContaining('配送模板') } });
      } finally { if (pending) await holder.exec('ROLLBACK'); }
    })));
    expect(await businessState()).toEqual(before);
    const [region] = await f.db.select({ firstPrice: shippingTemplatesRegion.firstPrice })
      .from(shippingTemplatesRegion).where(eq(shippingTemplatesRegion.templateId, 10));
    expect(region.firstPrice).toBe('9.00');
  }, 40_000);
});
