import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { readFileSync } from 'node:fs';
import { storeProduct } from '@/models/schema';
import type { Env, ProductAutoShelfMessage, ProductAutoShelfScanMessage, ScheduledMaintenanceMessage, OrderMessage } from '@/env';
import { ProductAutoShelfService, isProductAutoShelfMessage, isProductAutoShelfScanMessage, planProductAutoShelf } from '@/services/product/ProductAutoShelfService';
import { prepareOrderQueueDeadLetter } from '@/services/order/OrderQueueDeadLetterService';
import { PRODUCT_AUTO_SHELF_SQL } from '@/migrations/productAutoShelf';
import { stockFixture, stockSnapshot, seedStocks, resetStockSequences } from './helpers/adminProductStocks';

describe('source auto_show and bounded durable product schedule execution', () => {
  let f: Awaited<ReturnType<typeof stockFixture>>;
  let queued: OrderMessage[], service: ProductAutoShelfService, root: ScheduledMaintenanceMessage, now: number;
  beforeAll(async () => { f = await stockFixture(); }, 30000);
  beforeEach(async () => {
    await f.reset(); await seedStocks(f.db); await resetStockSequences(f.exec);
    now = Math.floor(Date.now() / 1000) - 5;
    root = { action: 'runScheduledMaintenance', job: 'product_auto_shelf', runId: `scheduled:${now * 1000}`, scheduledAt: now * 1000, cursor: 0, threshold: null };
    queued = [];
    const queue = { sendBatch: vi.fn(async (messages: Array<{ body: OrderMessage }>) => { queued.push(...messages.map(row => row.body)); return {}; }) } as unknown as Env['ORDER_QUEUE'];
    service = new ProductAutoShelfService(f.container, { ORDER_QUEUE: queue });
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Product schedule tests forbid provider I/O'));
  });
  afterEach(() => { expect(fetch).not.toHaveBeenCalled(); vi.restoreAllMocks(); });
  afterAll(async () => { await f?.close(); });
  const work = (id: number): ProductAutoShelfMessage => ({ action: 'processProductAutoShelf', job: 'product_auto_shelf', runId: root.runId, scheduledAt: root.scheduledAt, productId: id });

  it('preserves <= on, strict < off, on-before-off, uncleared schedules and all source review states', async () => {
    const [product] = await f.db.select().from(storeProduct).where(eq(storeProduct.id, 10));
    expect(planProductAutoShelf({ ...product, isShow: 0, autoOnTime: now }, now)).toEqual({ isShow: 1, transitions: ['on'] });
    expect(planProductAutoShelf({ ...product, isShow: 1, autoOffTime: now }, now)).toEqual({ isShow: 1, transitions: [] });
    expect(planProductAutoShelf({ ...product, isShow: 0, autoOnTime: now, autoOffTime: now - 1, isVerify: -1 }, now)).toEqual({ isShow: 0, transitions: ['on', 'off'] });
    expect(planProductAutoShelf({ ...product, isShow: 2, autoOnTime: now - 1 }, now).transitions).toEqual([]);
    expect(planProductAutoShelf({ ...product, isDel: 1, isShow: 0, autoOnTime: now - 1 }, now).transitions).toEqual([]);
    await f.db.update(storeProduct).set({ isShow: 0, autoOnTime: now, autoOffTime: now - 1, isVerify: -1, refusal: 'source refusal' }).where(eq(storeProduct.id, 10));
    const before = await stockSnapshot(f.db);
    expect(await service.process(work(10))).toMatchObject({ isShow: 0, transitions: ['on', 'off'] });
    expect(await stockSnapshot(f.db)).toEqual(before);
    await service.process(work(10)); expect(await stockSnapshot(f.db)).toEqual(before);
  });

  it('runs a real root/two indexed phase scans/ID-only work through a timestamp+ID keyset without losing equal-time boundaries', async () => {
    await f.db.insert(storeProduct).values(Array.from({ length: 83 }, (_, index) => ({ id: 100 + index, storeName: `scheduled-${index}`, isShow: 0, autoOnTime: now - index % 3, isVerify: index % 2 ? 1 : -1 })));
    await f.db.insert(storeProduct).values([{ id: 201, isShow: 1, autoOffTime: now - 1 }, { id: 202, isShow: 1, autoOffTime: now }, { id: 203, isShow: 0, autoOnTime: now + 1 }]);
    expect(await service.start(root)).toMatchObject({ scans: 2, maximumId: 203 });
    // Insertion beyond the captured upper bound waits for the next root run.
    await f.db.insert(storeProduct).values({ id: 9999, isShow: 0, autoOnTime: now - 1 });
    const references: number[] = [], scans: ProductAutoShelfScanMessage[] = [];
    while (queued.length) {
      const message = queued.shift()!;
      if (isProductAutoShelfScanMessage(message)) { scans.push(message); await service.scan(message); }
      else if (isProductAutoShelfMessage(message)) { references.push(message.productId); await service.process(message); }
      else throw Error('Unexpected scheduled reference');
    }
    expect(scans.filter(scan => scan.phase === 'on')).toHaveLength(2);
    expect(new Set(references).size).toBe(84); expect(references).toHaveLength(84);
    const rows = await f.db.select().from(storeProduct);
    expect(rows.filter(row => row.id >= 100 && row.id <= 182).every(row => row.isShow === 1 && row.autoOnTime > 0)).toBe(true);
    expect(rows.find(row => row.id === 201)?.isShow).toBe(0);
    expect(rows.find(row => row.id === 202)?.isShow).toBe(1);
    expect(rows.find(row => row.id === 203)?.isShow).toBe(0);
    expect(rows.find(row => row.id === 9999)?.isShow).toBe(0);
  });

  it('rechecks delayed references, current deletion and amended schedules and changes no SKU/order/audit/outbox data', async () => {
    await f.db.update(storeProduct).set({ autoOnTime: now - 1, isShow: 0 }).where(eq(storeProduct.id, 20));
    const before = await stockSnapshot(f.db);
    expect(await service.process(work(20))).toMatchObject({ isShow: 1, transitions: ['on'] });
    const after = await stockSnapshot(f.db);
    for (const key of Object.keys(before).filter(key => key !== 'storeProduct')) expect(after[key]).toEqual(before[key]);
    await service.process(work(20)); expect(await stockSnapshot(f.db)).toEqual(after);
    await f.db.update(storeProduct).set({ autoOnTime: now + 100, isShow: 0 }).where(eq(storeProduct.id, 20));
    expect(await service.process(work(20))).toMatchObject({ reason: 'no_longer_eligible' });
    expect(await service.process(work(40))).toMatchObject({ reason: 'no_longer_eligible' });
    expect(await service.process(work(123456))).toMatchObject({ reason: 'no_longer_eligible' });
    await f.db.update(storeProduct).set({ autoOnTime: now - 1, isShow: 0 }).where(eq(storeProduct.id, 60));
    const invalid = await stockSnapshot(f.db); await expect(service.process(work(60))).rejects.toThrow('owner invalid'); expect(await stockSnapshot(f.db)).toEqual(invalid);
  });

  it('does not reopen a product when an older on reference arrives after a newer off run', async () => {
    await f.db.update(storeProduct).set({ isShow: 0, autoOnTime: now - 200, autoOffTime: now - 100 }).where(eq(storeProduct.id,10));
    await service.process(work(10));
    const oldAt=(now-150)*1000, old={...work(10),scheduledAt:oldAt,runId:`scheduled:${oldAt}`};
    expect(await service.process(old)).toMatchObject({isShow:0,transitions:['on','off']});
    expect((await f.db.select().from(storeProduct).where(eq(storeProduct.id,10)))[0].isShow).toBe(0);
  });

  it('rolls back suppressed or rewritten full product receipts and never repairs trigger mutations silently', async () => {
    await f.db.update(storeProduct).set({ autoOnTime: now - 1, isShow: 0 }).where(eq(storeProduct.id, 10));
    for (const body of ['RETURN NULL;', "NEW.refusal := 'trigger rewrite'; RETURN NEW;"]) {
      await f.exec(`CREATE FUNCTION shelf_rewrite() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN ${body} END$$; CREATE TRIGGER shelf_rewrite BEFORE UPDATE ON store_product FOR EACH ROW EXECUTE FUNCTION shelf_rewrite()`);
      try { const before = await stockSnapshot(f.db); await expect(service.process(work(10))).rejects.toThrow('receipt inconsistent'); expect(await stockSnapshot(f.db)).toEqual(before); }
      finally { await f.exec('DROP TRIGGER shelf_rewrite ON store_product; DROP FUNCTION shelf_rewrite()'); }
    }
  });

  it('uses strict reference-only protocols, permits durable DLQ replay, and binds the exact standalone index migration source', async () => {
    const scan: ProductAutoShelfScanMessage = { action: 'scanProductAutoShelf', job: 'product_auto_shelf', runId: root.runId, scheduledAt: root.scheduledAt, phase: 'on', maximumId: 100, cursorTime: 0, cursorId: 0 };
    expect(isProductAutoShelfScanMessage(scan)).toBe(true); expect(isProductAutoShelfMessage(work(10))).toBe(true);
    for (const invalid of [{ ...scan, phase: ['on'] }, { ...scan, cursorId: 101 }, { ...scan, cursorTime: -1 }, { ...scan, extra: true }, { ...scan, runId: 'wrong' }]) expect(isProductAutoShelfScanMessage(invalid)).toBe(false);
    for (const invalid of [{ ...work(10), productId: 0 }, { ...work(10), token: 'not-permitted' }, { ...work(10), scheduledAt: 1.1 }]) expect(isProductAutoShelfMessage(invalid)).toBe(false);
    expect(prepareOrderQueueDeadLetter(work(10))).toMatchObject({ replayPolicy: 'ALLOW', replayMessage: work(10) });
    expect(prepareOrderQueueDeadLetter(scan)).toMatchObject({ replayPolicy: 'ALLOW', replayMessage: scan });
    expect(readFileSync('migrations/0176_product_auto_shelf.sql', 'utf8')).toBe(PRODUCT_AUTO_SHELF_SQL);
  });
});
