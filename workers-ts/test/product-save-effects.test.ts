import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { withTx } from '@/lib/di';
import { storeOrderOutbox, storeProduct, systemLog, systemRole } from '@/models/schema';
import { MigrationService } from '@/services/MigrationService';
import { OrderOutboxService, isOrderNotificationOutboxMessage } from '@/services/order/OrderOutboxService';
import {
  deliverProductSaveEffects, enqueueProductSaveEffects, parseProductSaveEffectsPayload,
  productSaveRelationCacheKeys,
} from '@/services/product/ProductSaveEffects';
import { PRODUCT_SAVE_EFFECTS_SQL } from '@/migrations/productSaveEffects';
import { assertStaffEventScope, parseStaffEventKey, staffPrincipalName } from '@/services/notification/StaffNotificationProtocol';
import { productStockCacheKeys } from '@/services/product/ProductStockEffects';
import { PRODUCT_RECYCLE_TAG_CLEAR_LUA, productRecycleTagKeys } from '@/services/product/ProductRecycleEffects';
import * as cache from '@/utils/cache';
import { stockFixture, seedStocks, resetStockSequences, stockSnapshot } from './helpers/adminProductStocks';
import type { OrderMessage, OrderNotificationOutboxMessage } from '@/env';

const env = { UPSTASH_REDIS_URL: 'https://owned-fixture.invalid', UPSTASH_REDIS_TOKEN: 'local-provider-fixture',
  REDIS_PREFIX: 'tenant:', CACHE_TAG_PREFIX: 'cache:' };
const relationKeys = ['cate', 'brand', 'product_label', 'user_label', 'ensure', 'specs']
  .map(type => `cache_product_relation_${type}_10`);

/** Real SQL under the owned PGlite fixture, or PG16 when the dedicated native
 * runner provides its loopback URL. Redis/Lua and socket providers are explicit
 * local doubles; these tests do not establish real provider execution. */
describe('dedicated durable complete-product-save effects and Queue leases', () => {
  let f: Awaited<ReturnType<typeof stockFixture>>;
  beforeAll(async () => { f = await stockFixture(); }, 30_000);
  beforeEach(async () => {
    await f.reset(); await seedStocks(f.db); await resetStockSequences(f.exec);
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('No external provider I/O in save effects fixture'));
  });
  afterEach(() => { expect(fetch).not.toHaveBeenCalled(); vi.restoreAllMocks(); });
  afterAll(async () => { await f?.close(); });

  async function event(requestedId = 10, warning = false) {
    return withTx(f.container, async tx => {
      await tx.update(storeProduct).set({ isPolices: warning ? 1 : 0 }).where(eq(storeProduct.id, 10));
      const [audit] = await tx.insert(systemLog).values({ adminId: 101, type: 'product_save', method: 'POST',
        path: `product/product/${requestedId}`, action: JSON.stringify({ operation: 'save', productId: 10, requestedId, warning }) }).returning();
      return enqueueProductSaveEffects(tx, { productId: 10, requestedId, auditId: audit.id, warning }, Math.floor(Date.now() / 1000));
    });
  }
  function provider() {
    const evaluate = vi.fn().mockResolvedValue(4), del = vi.fn().mockResolvedValue(6);
    vi.spyOn(cache, 'getRedis').mockReturnValue({ eval: evaluate, del } as unknown as NonNullable<ReturnType<typeof cache.getRedis>>);
    const deleted = vi.spyOn(cache, 'cacheDelete').mockResolvedValue(false);
    return { evaluate, del, deleted };
  }
  function queueFixture() {
    const messages: OrderNotificationOutboxMessage[] = [];
    const queue = { sendBatch: async (batch: Array<{ body: OrderNotificationOutboxMessage }>) => {
      messages.push(...batch.map(item => item.body)); return {};
    } } as unknown as Queue<OrderMessage>;
    return { messages, queue };
  }

  it('matches the standalone and embedded artifact, with strict bounded payloads and stock-scope save event keys', () => {
    expect(readFileSync('migrations/0178_product_save_effects.sql', 'utf8').trim()).toBe(PRODUCT_SAVE_EFFECTS_SQL.trim());
    expect(new MigrationService(f.container).productSaveEffectsSqlForVerification()).toBe(PRODUCT_SAVE_EFFECTS_SQL);
    for (const value of [null, [], {}, { productId: 10, requestedId: -1, auditId: 1, warning: false },
      { productId: 10, requestedId: 0, auditId: 1, warning: 1 },
      { productId: 10, requestedId: 0, auditId: 1, warning: false, token: 'x' },
      { productId: 2_147_483_648, requestedId: 0, auditId: 1, warning: false }]) {
      expect(() => parseProductSaveEffectsPayload(value)).toThrow();
    }
    const key = 'product.save.effects:10:01863c9b-5ae1-4583-bb49-983341f6d1c8';
    const target = { audience: 'admin' as const, id: 101, scope: 'product_stock' as const };
    expect(parseStaffEventKey(key)).toBe(key);
    expect(() => assertStaffEventScope(target, key)).not.toThrow();
    expect(() => assertStaffEventScope({ audience: 'admin', id: 101 }, key)).toThrow();
    expect(() => assertStaffEventScope(target, 'withdrawal.staff.refresh:10')).toThrow();
    for (const prefix of ['recycle', 'saveStocks', 'saveX']) expect(() => parseStaffEventKey(key.replace('save', prefix))).toThrow();
    expect(() => parseStaffEventKey(key.replace(':10:', ':2147483648:'))).toThrow();
    expect(isOrderNotificationOutboxMessage({ action: 'processOrderNotificationOutbox', outboxId: 1, eventKey: key })).toBe(true);
    expect(isOrderNotificationOutboxMessage({ action: 'processOrderNotificationOutbox', outboxId: 1, eventKey: key.replace('save', 'saveX') })).toBe(false);
  });

  it('commits exact pending save receipts for create/edit paths and clears proven global, six relation and detail/SKU keys', async () => {
    const { evaluate, del, deleted } = provider();
    expect(productSaveRelationCacheKeys(10)).toEqual(relationKeys);
    for (const requestedId of [0, 10]) {
      const row = await event(requestedId), before = await stockSnapshot(f.db);
      expect(row).toMatchObject({ aggregateType: 'product', aggregateId: 10, eventType: 'product.save.effects', status: 'PENDING',
        dispatchCount: 0, attemptCount: 0, replayCount: 0, leaseUntil: 0, leaseToken: '', lastError: '', enqueuedTime: 0, processedTime: 0,
        payload: { productId: 10, requestedId, warning: false } });
      await deliverProductSaveEffects(f.container, env, row);
      expect(await stockSnapshot(f.db)).toEqual(before);
    }
    expect(evaluate).toHaveBeenCalledTimes(2);
    expect(evaluate).toHaveBeenCalledWith(PRODUCT_RECYCLE_TAG_CLEAR_LUA, productRecycleTagKeys(env).keys, productRecycleTagKeys(env).prefixes);
    expect(del).toHaveBeenCalledWith(...relationKeys.map(key => `tenant:${key}`));
    expect(deleted.mock.calls.map(call => call[0]).sort()).toEqual([...productStockCacheKeys(10), ...relationKeys,
      ...productStockCacheKeys(10), ...relationKeys].sort());
  });

  it('rejects forged event, domain, audit path/method/type and complete save action identity before any provider call', async () => {
    const { evaluate, del, deleted } = provider(), row = await event();
    for (const patch of [{ eventKey: row.eventKey.replace('save', 'stock') }, { aggregateType: 'order' }, { aggregateId: 20 },
      { payload: { ...row.payload, requestedId: 0 } }, { payload: { ...row.payload, warning: true } }]) {
      await expect(deliverProductSaveEffects(f.container, env, { ...row, ...patch })).rejects.toThrow();
    }
    const [before] = await f.db.select().from(systemLog);
    for (const patch of [{ method: 'PUT' }, { path: 'product/product/20' }, { type: 'product_stock_adjustment' },
      { action: JSON.stringify({ operation: 'saveStocks', productId: 10, requestedId: 10, warning: false }) },
      { action: JSON.stringify({ operation: 'save', productId: 10, requestedId: 0, warning: false }) },
      { action: JSON.stringify({ operation: 'save', productId: 10, requestedId: 10, warning: true }) }]) {
      await f.db.update(systemLog).set(patch).where(eq(systemLog.id, before.id));
      await expect(deliverProductSaveEffects(f.container, env, row)).rejects.toThrow();
      await f.db.update(systemLog).set(before).where(eq(systemLog.id, before.id));
    }
    expect(evaluate).not.toHaveBeenCalled(); expect(del).not.toHaveBeenCalled(); expect(deleted).not.toHaveBeenCalled();
  });

  it('validates the immutable default-state INSERT RETURNING receipt and atomically rolls back its linked audit', async () => {
    const before = await stockSnapshot(f.db);
    await f.exec(`CREATE FUNCTION save_effects_mutate_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN NEW.replay_count:=1; RETURN NEW; END $$;
      CREATE TRIGGER save_effects_mutate_receipt BEFORE INSERT ON store_order_outbox FOR EACH ROW EXECUTE FUNCTION save_effects_mutate_receipt()`);
    try { await expect(event()).rejects.toThrow('full receipt inconsistent'); }
    finally { await f.exec('DROP TRIGGER save_effects_mutate_receipt ON store_order_outbox; DROP FUNCTION save_effects_mutate_receipt()'); }
    expect(await stockSnapshot(f.db)).toEqual(before);
  });

  it('publishes current warning products only to current platform product viewers, with the save key for deduplication', async () => {
    provider(); const row = await event(0, true), names: string[] = [], before = await stockSnapshot(f.db);
    await deliverProductSaveEffects(f.container, { ...env, STAFF_NOTICE: { getByName: name => ({ publish: async (target, key) => {
      expect(staffPrincipalName(target)).toBe(name); expect(key).toBe(row.eventKey); names.push(name); return { revision: 1, connected: 0 };
    } }) } }, row);
    expect(names.sort()).toEqual([100, 101, 102, 104, 106, 107, 108].map(id => `staff-stock:admin:${id}`).sort());
    expect(await stockSnapshot(f.db)).toEqual(before);
    await f.db.update(storeProduct).set({ isPolices: 0 }).where(eq(storeProduct.id, 10));
    await deliverProductSaveEffects(f.container, env, row);
  });

  it('keeps failed provider receipts retryable, rechecks recipients on replay and never repeats the product save', async () => {
    const { evaluate } = provider(), { messages, queue } = queueFixture(), row = await event(10, true);
    const names: string[] = []; let fail = true;
    const service = new OrderOutboxService(f.container, { ...env, ORDER_QUEUE: queue, STAFF_NOTICE: { getByName: name => ({ publish: async () => {
      if (fail && name === 'staff-stock:admin:102') throw Error('local socket unavailable');
      names.push(name); return { revision: 1, connected: 0 };
    } }) } });
    const before = await stockSnapshot(f.db);
    await service.dispatchEventKey(row.eventKey);
    await expect(service.processMessage(messages[0])).rejects.toThrow('delivery unconfirmed');
    expect((await f.db.select().from(storeOrderOutbox))[0].status).toBe('FAILED');
    await f.db.update(systemRole).set({ status: 0 }).where(eq(systemRole.id, 2));
    names.length = 0; fail = false;
    await service.replay(row.id); await service.dispatchEventKey(row.eventKey);
    expect(await service.processMessage(messages.at(-1)!)).toBe('completed');
    expect(names).not.toContain('staff-stock:admin:102');
    expect(await service.processMessage(messages[0])).toBe('already-completed');
    const after = await stockSnapshot(f.db);
    for (const table of ['storeProduct', 'storeProductAttrValue', 'storeProductStockRecord', 'systemLog']) expect(after[table]).toEqual(before[table]);
    expect(evaluate).toHaveBeenCalledTimes(2);
    expect((await f.db.select().from(storeOrderOutbox))[0]).toMatchObject({ status: 'COMPLETED', leaseToken: '', leaseUntil: 0 });
  });

  it('rejects altered claim identity or stolen lease before provider execution', async () => {
    const { evaluate } = provider(), { queue } = queueFixture(), service = new OrderOutboxService(f.container, { ...env, ORDER_QUEUE: queue });
    const internal = service as unknown as {
      claimForProcessing(message: OrderNotificationOutboxMessage): Promise<unknown>;
      runClaimedEvent(claim: unknown): Promise<unknown>;
    };
    for (const patch of [{ aggregateId: 20 }, { aggregateType: 'order' }, { eventType: 'product.stock.effects' },
      { payload: { productId: 10, requestedId: 0, auditId: 1, warning: false } }, { leaseToken: 'stolen' }, { status: 'COMPLETED' }]) {
      const row = await event(), claim = await internal.claimForProcessing({ action: 'processOrderNotificationOutbox', outboxId: row.id, eventKey: row.eventKey });
      await f.db.update(storeOrderOutbox).set(patch).where(eq(storeOrderOutbox.id, row.id));
      await expect(internal.runClaimedEvent(claim)).rejects.toThrow('lease or immutable identity invalid');
    }
    expect(evaluate).not.toHaveBeenCalled();
  });

  it('refuses completion when its lease changes during provider delivery', async () => {
    const { evaluate } = provider(), { queue, messages } = queueFixture(), row = await event();
    const service = new OrderOutboxService(f.container, { ...env, ORDER_QUEUE: queue });
    evaluate.mockImplementationOnce(async () => {
      await f.db.update(storeOrderOutbox).set({ leaseToken: 'stolen-after-provider' }).where(eq(storeOrderOutbox.id, row.id));
      return 4;
    });
    await service.dispatchEventKey(row.eventKey);
    await expect(service.processMessage(messages[0])).rejects.toThrow('completion lease invalid');
    expect((await f.db.select().from(storeOrderOutbox))[0]).toMatchObject({ status: 'PROCESSING', leaseToken: 'stolen-after-provider' });
  });

  it('requires configured providers and validates both global and relation deletion receipts', async () => {
    const { evaluate, del } = provider(), row = await event();
    await expect(deliverProductSaveEffects(f.container, { ...env, UPSTASH_REDIS_URL: '', UPSTASH_REDIS_TOKEN: '' }, row)).rejects.toThrow('binding unavailable');
    expect(evaluate).not.toHaveBeenCalled();
    for (const receipt of [null, true, '6', -1, 7]) {
      del.mockResolvedValueOnce(receipt);
      await expect(deliverProductSaveEffects(f.container, env, row)).rejects.toThrow('relation cache receipt invalid');
    }
    evaluate.mockRejectedValueOnce(Error('local Lua outcome unknown'));
    await expect(deliverProductSaveEffects(f.container, env, row)).rejects.toThrow('outcome unknown');
    const warning = await event(10, true);
    await expect(deliverProductSaveEffects(f.container, env, warning)).rejects.toThrow('notification binding unavailable');
  });
});
