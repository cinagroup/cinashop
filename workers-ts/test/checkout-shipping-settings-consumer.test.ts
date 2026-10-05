import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { cityArea, systemConfig, systemStore } from '../src/models/schema';
import { AdminShippingSettingsService } from '../src/services/admin/AdminShippingSettingsService';
import { StoreOrderCreateService } from '../src/services/order/StoreOrderCreateService';
import { orderCreate } from '../src/controllers/api/v1/OrderController';
import { createPcCheckoutQuoteFixture } from './helpers/pcCheckoutQuoteFixture';
import { sequenceRunnerDatabase } from './helpers/kefuSequenceRunnerDatabase';
import { completePurchaseOriginEvidenceOrm } from '../src/migrations/runPurchaseOriginEvidence';
import { completePurchaseCancellationEvidenceOrm } from '../src/migrations/runPurchaseCancellationEvidence';

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('shipping settings real pickup quote and create consumers', { timeout: 30_000 }, () => {
  let f: Awaited<ReturnType<typeof createPcCheckoutQuoteFixture>>;
  let beforeSequence: (() => Promise<void>) | undefined;
  beforeEach(async () => {
    beforeSequence = undefined;
    f = await createPcCheckoutQuoteFixture([], async () => {
      const owned = await sequenceRunnerDatabase();
      try {
        const api = await import('drizzle-kit/api'), schema = await import('../src/models/schema');
        await owned.exec((await api.generateMigration(api.generateDrizzleJson({}), api.generateDrizzleJson(schema))).join('\n'));
        await completePurchaseOriginEvidenceOrm(owned.db);
        await completePurchaseCancellationEvidenceOrm(owned.db);
        return owned;
      } catch (error) { await owned.close(); throw error; }
    });
    await f.setConfig({ store_self_mention: '1', store_func_status: '1' });
    await f.db.update(systemStore).set({ isStore: 1 }).where(eq(systemStore.id, 1));
    f.app.post('/api/order/create/:key', orderCreate);
    Object.assign(f.env, { SEQUENCE: { idFromName: () => 'isolated', get: () => ({ fetch: async () => {
      await beforeSequence?.(); return new Response('shipping_settings_pickup_order');
    } }) } });
  }, 120_000);
  afterEach(async () => { vi.restoreAllMocks(); await f?.close(); }, 120_000);
  const quote = () => new StoreOrderCreateService(f.container, f.env).quoteOrder({ uid: 11, cartIds: [1], shippingType: 2, storeId: 1 });
  const body = { cartIds: [1], shippingType: 2, storeId: 1, realName: '自提客户', userPhone: '13800138000' };
  const request = async (path: string, data: object) => {
    const response = await f.app.request(path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-fixture-user': '11' }, body: JSON.stringify(data) }, f.env);
    return response.json() as Promise<{ status: number; msg: string; data: { orderKey: string; quoteToken: string; errorCode?: string } }>;
  };
  const receipt = async () => { const r = await request('/api/order/confirm', body); expect(r.status, r.msg).toBe(200); return r.data; };
  const create = (r: { orderKey: string; quoteToken: string }) => request(`/api/order/create/${r.orderKey}`, { ...body, quoteToken: r.quoteToken });
  const disable = () => f.db.update(systemConfig).set({ value: '0' }).where(eq(systemConfig.menuName, 'store_self_mention'));

  it('consumes a real versioned Admin save in subsequent quotes and requires reconfirmation after disabling pickup', async () => {
    for (const [id, level] of [[901, 1], [902, 2], [101, 3]])
      await f.db.update(cityArea).set({ level }).where(eq(cityArea.id, id));
    const admin = new AdminShippingSettingsService(f.container, f.env);
    const raw = { request_id: crypto.randomUUID(), revision: (await admin.get()).revision,
      whole_free_shipping: 1, store_free_postage: '18.00', offline_postage: 0, store_self_mention: 1,
      pickup: { name: '管理员设置的提货点', phone: '13800138000', address_ids: [901, 902, 101],
        detailed_address: '管理员设置的地址', day_time: ['08:00', '20:00'], latitude: '31.2', longitude: '121.4' } };
    await admin.save(raw, { id: 7 });
    const service = new StoreOrderCreateService(f.container, f.env);
    expect((await service.quoteOrder({ uid: 11, cartIds: [1], addressId: 11 })).payPostageCents).toBe(0);
    const r = await receipt(), before = await f.snapshot();
    await admin.save({ ...raw, request_id: crypto.randomUUID(), revision: (await admin.get()).revision,
      whole_free_shipping: 0, store_self_mention: 0, pickup: null }, { id: 7 });
    await expect(quote()).rejects.toThrow('到店自提已关闭');
    expect((await service.quoteOrder({ uid: 11, cartIds: [1], addressId: 11 })).payPostageCents).toBeGreaterThan(0);
    expect((await create(r)).status).toBe(400); expect(await f.snapshot()).toEqual(before);
  }, 30_000);

  it('authorizes pickup from SQL while cache says off, and rejects SQL off while cache says on', async () => {
    f.config.store_self_mention = '0';
    expect((await quote()).payPostageCents).toBe(0);
    await disable(); f.config.store_self_mention = '1';
    await expect(quote()).rejects.toThrow('到店自提已关闭');
  });
  it('uses global sort/id winner even when hidden, and does not accept a non-pickup store', async () => {
    await f.db.insert(systemConfig).values([{ menuName: 'store_self_mention', value: '0', sort: 10, status: 0 },
      { menuName: 'store_self_mention', value: '1', sort: 100, isStore: 1 }]);
    await expect(quote()).rejects.toThrow('到店自提已关闭');
    await f.db.update(systemConfig).set({ value: '1' }).where(eq(systemConfig.menuName, 'store_self_mention'));
    await f.db.update(systemStore).set({ isStore: 0 }).where(eq(systemStore.id, 1));
    await expect(quote()).rejects.toThrow('自提门店不存在');
  });
  it('binds pickup location details in the confirmation and rejects changed information', async () => {
    const r = await receipt(), before = await f.snapshot();
    await f.db.update(systemStore).set({ detailedAddress: '更改后的取货地点' }).where(eq(systemStore.id, 1));
    const result = await create(r);
    expect(result.status).toBe(400); expect(result.data.errorCode).toBe('ORDER_QUOTE_RECONFIRM_REQUIRED');
    expect(await f.snapshot()).toEqual(before);
  });
  it('rolls back the complete order when pickup is disabled after create pricing', async () => {
    const r = await receipt(), before = await f.snapshot();
    beforeSequence = async () => { await disable(); };
    const result = await create(r);
    expect(result.status).toBe(400); expect(result.data.errorCode).toBe('ORDER_QUOTE_RECONFIRM_REQUIRED');
    expect(await f.snapshot()).toEqual(before);
  });
  it('rolls back after a late pickup address edit and creates/replays unchanged accepted pickup once', async () => {
    const r = await receipt(), before = await f.snapshot();
    beforeSequence = async () => { await f.db.update(systemStore).set({ name: '新提货点名称' }).where(eq(systemStore.id, 1)); };
    expect((await create(r)).status).toBe(400); expect(await f.snapshot()).toEqual(before);
    beforeSequence = undefined;
    const current = await receipt(); expect((await create(current)).status).toBe(200);
    const accepted = await f.snapshot(); expect(accepted.orders).toHaveLength(1);
    expect(accepted.orders[0]).toMatchObject({ shippingType: 2, storeId: 1, payPostage: '0.00' });
    await disable(); expect((await create(current)).status).toBe(200); expect(await f.snapshot()).toEqual(accepted);
  });
});
