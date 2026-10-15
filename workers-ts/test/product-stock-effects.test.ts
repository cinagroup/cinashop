import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { storeOrderOutbox, storeProduct, systemRole, systemLog } from '@/models/schema';
import { OrderOutboxService, isOrderNotificationOutboxMessage } from '@/services/order/OrderOutboxService';
import { deliverProductStockEffects, parseProductStockEffectsPayload, productStockCacheKeys } from '@/services/product/ProductStockEffects';
import { PRODUCT_STOCK_EFFECTS_SQL } from '@/migrations/productStockEffects';
import { assertStaffEventScope, staffPrincipalName } from '@/services/notification/StaffNotificationProtocol';
import * as cache from '@/utils/cache';
import { stockFixture, seedStocks, resetStockSequences, stockActor, stockBody, stockSnapshot } from './helpers/adminProductStocks';
import { parseStockNoticeFrame } from '../../view/common/product-stock-notifications';
import { parseNoticeFrame } from '../../view/common/staff-notifications';

describe('durable product stock effects and isolated invalidation protocol', () => {
  let f: Awaited<ReturnType<typeof stockFixture>>;
  beforeAll(async () => { f = await stockFixture(); }, 30000);
  beforeEach(async () => {
    await f.reset(); await seedStocks(f.db); await resetStockSequences(f.exec);
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Stock effects use local provider fixtures only'));
  });
  afterEach(() => { expect(fetch).not.toHaveBeenCalled(); vi.restoreAllMocks(); });
  afterAll(async () => { await f?.close(); });
  async function event() { await f.service.save(10, stockBody(), stockActor()); return (await f.db.select().from(storeOrderOutbox))[0]; }

  it('uses exact cache keys, strict event identities and isolated stock/withdrawal frames', async () => {
    expect(readFileSync('migrations/0175_product_stock_effects.sql', 'utf8').trim()).toBe(PRODUCT_STOCK_EFFECTS_SQL.trim());
    expect(productStockCacheKeys(10)).toEqual(['product_info_10', ...Array.from({ length: 7 }, (_, i) => `product_info_10_${i + 1}`), 'attr_10_0_0', 'attr_10_0_10', 'attr_value_10_0', 'attr_sku_10_0']);
    for (const value of [null, [], {}, { productId: 10, auditId: 1, warning: 1 }, { productId: 10, auditId: 1, warning: true, token: 'x' }]) expect(() => parseProductStockEffectsPayload(value)).toThrow();
    const row = await event(), stock = { audience: 'admin' as const, id: 101, scope: 'product_stock' as const };
    expect(isOrderNotificationOutboxMessage({ action: 'processOrderNotificationOutbox', outboxId: row.id, eventKey: row.eventKey })).toBe(true);
    expect(staffPrincipalName(stock)).toBe('staff-stock:admin:101');
    expect(staffPrincipalName({ audience: 'admin', id: 101 })).toBe('staff-notice:admin:101');
    expect(() => assertStaffEventScope(stock, row.eventKey)).not.toThrow();
    expect(() => assertStaffEventScope(stock, 'withdrawal.staff.refresh:10')).toThrow();
    expect(() => assertStaffEventScope({ audience: 'admin', id: 101 }, row.eventKey)).toThrow();
    expect(() => staffPrincipalName({ ...stock, audience: 'kefu' })).toThrow();
    const ready = JSON.stringify({ type: 'product_stock_ready', revision: 0, refresh: true });
    const warning = JSON.stringify({ type: 'STORE_STOCK', data: { id: 10 }, revision: 2 });
    expect(parseStockNoticeFrame(ready)).toEqual({ type: 'ready', revision: 0 });
    expect(parseStockNoticeFrame(warning)).toEqual({ type: 'changed', revision: 2, productId: 10 });
    expect(parseNoticeFrame(warning)).toBeNull();
    for (const value of [JSON.stringify({ type: 'staff_notification_ready', revision: 1, refresh: true }), JSON.stringify({ type: 'STORE_STOCK', data: { id: 10, amount: 3 }, revision: 1 }), '{}', 'x'.repeat(257)]) expect(parseStockNoticeFrame(value)).toBeNull();
  });

  it('publishes to current product viewers only and leaves all inventory/audit data unchanged', async () => {
    const row = await event(), deleted = vi.spyOn(cache, 'cacheDelete').mockResolvedValue(false), names: string[] = [];
    const before = await stockSnapshot(f.db);
    await deliverProductStockEffects(f.container, { UPSTASH_REDIS_URL: '', UPSTASH_REDIS_TOKEN: '', STAFF_NOTICE: { getByName: name => ({ publish: async (target, key) => {
      expect(staffPrincipalName(target)).toBe(name); expect(key).toBe(row.eventKey); names.push(name); return { revision: 1, connected: 0 };
    } }) } }, row);
    expect(names.sort()).toEqual([100, 101, 102, 104, 106, 107, 108].map(id => `staff-stock:admin:${id}`).sort());
    expect(deleted.mock.calls.map(call => call[0]).sort()).toEqual(productStockCacheKeys(10).sort());
    expect(await stockSnapshot(f.db)).toEqual(before);
  });

  it('retries a partial provider failure with the same event and current authority without repeating the relative stock adjustment', async () => {
    const row = await event(), deleted = vi.spyOn(cache, 'cacheDelete').mockResolvedValue(true), deliveries: string[] = [];
    const messages: any[] = []; let failing = true;
    const queue = { send: async () => ({}), sendBatch: async (batch: any[]) => { messages.push(...batch.map(item => item.body)); return {}; }, metrics: async () => ({ backlogCount: 0, backlogBytes: 0 }) } as unknown as Queue<any>;
    const service = new OrderOutboxService(f.container, { ORDER_QUEUE: queue, STAFF_NOTICE: { getByName: name => ({ publish: async () => {
      if (name === 'staff-stock:admin:102' && failing) throw Error('local provider unavailable'); deliveries.push(name); return { revision: 1, connected: 0 };
    } }) } });
    const before = await stockSnapshot(f.db);
    await service.dispatchEventKey(row.eventKey); expect(messages).toHaveLength(1);
    await expect(service.processMessage(messages[0])).rejects.toThrow('delivery unconfirmed');
    expect((await f.db.select().from(storeOrderOutbox))[0].status).toBe('FAILED');
    await f.db.update(systemRole).set({ status: 0 }).where(eq(systemRole.id, 2));
    failing = false; deliveries.length = 0; await service.replay(row.id); await service.dispatchEventKey(row.eventKey);
    expect(await service.processMessage(messages[0])).toBe('completed');
    expect(deliveries).not.toContain('staff-stock:admin:102');
    expect(await service.processMessage(messages[0])).toBe('already-completed');
    const after = await stockSnapshot(f.db); for (const table of ['storeProduct', 'storeProductAttrValue', 'storeProductStockRecord', 'systemLog']) expect(after[table]).toEqual(before[table]);
    expect(deleted).toHaveBeenCalledTimes(24);
  });

  it('keeps missing bindings and cache failures retryable and skips stale warnings after recovery', async () => {
    const row = await event(), deleted = vi.spyOn(cache, 'cacheDelete').mockRejectedValue(Error('local cache unavailable'));
    await expect(deliverProductStockEffects(f.container, { UPSTASH_REDIS_URL: '', UPSTASH_REDIS_TOKEN: '' }, row)).rejects.toThrow('local cache unavailable');
    deleted.mockResolvedValue(false);
    await expect(deliverProductStockEffects(f.container, { UPSTASH_REDIS_URL: '', UPSTASH_REDIS_TOKEN: '' }, row)).rejects.toThrow('binding unavailable');
    await f.db.update(storeProduct).set({ isPolices: 0 }).where(eq(storeProduct.id, 10));
    await deliverProductStockEffects(f.container, { UPSTASH_REDIS_URL: '', UPSTASH_REDIS_TOKEN: '' }, row);
    await f.db.update(systemLog).set({ path: 'wrong' }).where(eq(systemLog.id, (row.payload as any).auditId));
    await expect(deliverProductStockEffects(f.container, { UPSTASH_REDIS_URL: '', UPSTASH_REDIS_TOKEN: '' }, row)).rejects.toThrow('business source invalid');
  });
});
