import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createContainerFromDb } from '../src/lib/di';
import { storeActivity, storeSeckill, storeSeckillTime, storeCart, storeOrder, storeOrderCartInfo, storeOrderStatus,
  storeProductAttrValue, systemStore, systemLog, printDocument } from '../src/models/schema';
import { AdminSeckillTimeService } from '../src/services/admin/AdminSeckillTimeService';
import { StoreOrderCreateService } from '../src/services/order/StoreOrderCreateService';
import { outcome, waitForFinanceBlock, withFinancePeers } from './helpers/financePeers';
import { seckillTimeFixture, seckillTimeInput } from './helpers/seckillTimeFixture';
import { createPcCheckoutQuoteFixture } from './helpers/pcCheckoutQuoteFixture';
import { seckillTimeReferenceLockFixture } from './helpers/seckillTimeReferenceLockFixture';

function errorMessages(error: unknown): string {
  const messages: string[] = [];
  for (let depth = 0; depth < 8 && error && typeof error === 'object'; depth++) {
    if ('message' in error) messages.push(String(error.message));
    if (!('cause' in error) || error.cause === error) break;
    error = error.cause;
  }
  return messages.join(' / ');
}

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('Seckill time serialization on owned PostgreSQL 16', () => {
  let f: Awaited<ReturnType<typeof seckillTimeFixture>>;
  beforeEach(async () => { f = await seckillTimeFixture(); }, 30_000);
  afterEach(async () => { vi.restoreAllMocks(); await f?.close(); }, 30_000);
  const actor = { id: 2 };
  const service = (db: typeof f.db) => new AdminSeckillTimeService(createContainerFromDb(db), f.env.APP_KEY);

  it.each(['overlap', 'same-request', 'capacity'] as const)('serializes simultaneous creates: %s', async mode => {
    if (mode === 'capacity') await f.db.insert(storeSeckillTime).values(Array.from({ length: 998 }, (_, n) => ({ id: 200 + n,
      title: '旧可见样本', startTime: '00:00', endTime: '00:01', pic: '/images/legacy.png', describe: '隔离样本', status: 1 })));
    const body = { ...seckillTimeInput, request_id: crypto.randomUUID() };
    await withFinancePeers(f.db, async ([blocker, firstPeer, secondPeer]) => {
      await blocker.exec('BEGIN; SELECT pg_advisory_xact_lock(731643,1)');
      try {
        const first = outcome(service(firstPeer.db).mutate('create', 0, body, actor));
        await waitForFinanceBlock(f.db, firstPeer.pid, blocker.pid);
        const second = outcome(service(secondPeer.db).mutate('create', 0, mode === 'same-request' ? body :
          { ...body, start_time: mode === 'capacity' ? '16:00' : '15:00', end_time: '17:00', request_id: crypto.randomUUID() }, actor));
        await waitForFinanceBlock(f.db, secondPeer.pid, firstPeer.pid);
        await blocker.exec('COMMIT');
        const a = await first, b = await second; expect(a.ok).toBe(true); expect(b.ok).toBe(mode === 'same-request');
        if (a.ok && b.ok) expect(b.value).toEqual(a.value);
      } finally { await blocker.exec('ROLLBACK'); }
    });
    const after = await f.snapshot(); expect(after.slots).toHaveLength(mode === 'capacity' ? 1001 : 3); expect(after.logs).toHaveLength(1);
  });

  it('rejects the second stale competing update/delete confirmation', async () => {
    const revision = await f.revision();
    await withFinancePeers(f.db, async ([blocker, firstPeer, secondPeer]) => {
      await blocker.exec('BEGIN; SELECT pg_advisory_xact_lock(731643,1)');
      try {
        const first = outcome(service(firstPeer.db).mutate('update', 101, { ...seckillTimeInput, start_time: '07:00', end_time: '08:00', revision, request_id: crypto.randomUUID() }, actor));
        await waitForFinanceBlock(f.db, firstPeer.pid, blocker.pid);
        const second = outcome(service(secondPeer.db).mutate('delete', 101, { revision, request_id: crypto.randomUUID() }, actor));
        await waitForFinanceBlock(f.db, secondPeer.pid, firstPeer.pid);
        await blocker.exec('COMMIT'); expect((await first).ok).toBe(true); expect((await second).ok).toBe(false);
      } finally { await blocker.exec('ROLLBACK'); }
    });
    expect((await f.snapshot()).logs).toHaveLength(1);
  });

  it.each(['parent', 'child'] as const)('rechecks committed %s references after its delete relation fence waits', async kind => {
    const today = Math.floor((Date.now() + 28800000) / 86400000) * 86400 - 28800;
    await f.db.insert(storeActivity).values({ id: 9, type: 1, isDel: 0, status: 0, timeId: '999', startDay: today, endDay: today + 86400 });
    await f.db.insert(storeSeckill).values({ id: 20, activityId: 0, timeId: '999', status: 0, isDel: 0 });
    const revision = await f.revision();
    await withFinancePeers(f.db, async ([writer, adminPeer]) => {
      await writer.exec(`BEGIN; UPDATE ${kind === 'parent' ? 'store_activity' : 'store_seckill'} SET time_id='\t101'`);
      try {
        const deletion = outcome(service(adminPeer.db).mutate('delete', 101, { revision, request_id: crypto.randomUUID() }, actor));
        await waitForFinanceBlock(f.db, adminPeer.pid, writer.pid);
        await writer.exec('COMMIT'); const result = await deletion; expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error.message).toContain(kind === 'parent' ? '父活动' : '商品');
      } finally { await writer.exec('ROLLBACK'); }
    });
    expect((await f.snapshot()).slots).toHaveLength(2); expect((await f.snapshot()).logs).toHaveLength(0);
  });

  it('rejects non-READ COMMITTED callers before any write or audit', async () => {
    await withFinancePeers(f.db, async ([peer]) => {
      await peer.exec("SET default_transaction_isolation='repeatable read'");
      const result = await outcome(service(peer.db).mutate('create', 0, { ...seckillTimeInput, request_id: crypto.randomUUID() }, actor));
      expect(result.ok).toBe(false); if (!result.ok) expect(result.error.message).toContain('READ COMMITTED');
      await peer.exec("SET default_transaction_isolation='read committed'");
    });
    expect((await f.snapshot()).logs).toHaveLength(0);
  });

  it('honors stricter caller deadlines and rolls back a blocked write', async () => {
    await withFinancePeers(f.db, async ([blocker, peer]) => {
      await peer.exec("SET statement_timeout='750ms'; SET lock_timeout='100ms'");
      await blocker.exec('BEGIN; SELECT pg_advisory_xact_lock(731643,1)');
      try {
        const result = await outcome(service(peer.db).mutate('create', 0, { ...seckillTimeInput, request_id: crypto.randomUUID() }, actor));
        expect(result.ok).toBe(false); if (!result.ok) expect(errorMessages(result.error)).toContain('lock timeout');
      } finally { await blocker.exec('ROLLBACK'); }
    });
    expect((await f.snapshot()).logs).toHaveLength(0);
  });
});

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('Slot edits versus actual seckill order admission', () => {
  let f: Awaited<ReturnType<typeof createPcCheckoutQuoteFixture>>;
  const actor = { id: 2 };
  beforeEach(async () => {
    f = await seckillTimeReferenceLockFixture({ ...await createPcCheckoutQuoteFixture([storeActivity, storeSeckillTime, storeSeckill, storeOrderCartInfo, storeOrderStatus, systemLog, printDocument]), format: 'pg16' });
    await f.setConfig(Object.fromEntries(Object.keys(f.config).map(key => [key, '0'])));
    // This positive checkout fixture disables discounts, while SQL pickup authority remains enabled.
    await f.setConfig({ store_func_status: '1', store_self_mention: '1' });
    await f.db.update(systemStore).set({ isStore: 1 });
    await f.db.insert(storeSeckillTime).values({ id: 101, title: '测试场', startTime: '00:00', endTime: '24:00', pic: '/images/slot.png', describe: '隔离样本', status: 1 });
    const today = Math.floor((Date.now() + 28800000) / 86400000) * 86400 - 28800;
    await f.db.insert(storeActivity).values({ id: 9, type: 1, status: 1, timeId: '101', startDay: today, endDay: today + 86400 });
    await f.db.insert(storeSeckill).values({ id: 20, activityId: 9, productId: 70, timeId: '101', stock: 7, quota: 6, onceNum: 3, num: 10, status: 1, isShow: 1, isDel: 0 });
    await f.db.insert(storeProductAttrValue).values({ id: 2, productId: 20, type: 1, unique: 'qatime01', suk: '红色,大号', stock: 7, quota: 6, price: '6.25' });
    await f.db.update(storeCart).set({ activityId: 20, type: 1, isNew: 1 }).where(eq(storeCart.id, 1));
  }, 30_000);
  afterEach(async () => { vi.restoreAllMocks(); vi.useRealTimers(); await f?.close(); }, 30_000);

  for (const operation of ['update', 'status', 'delete'] as const) {
    it.each(['admin-first', 'buyer-first'] as const)(`${operation} respects the existing purchase lock order: %s`, async order => {
      // Freeze the application clock at the real owned SQL clock; final admission
      // still uses PostgreSQL clock_timestamp(), so a synthetic noon is insufficient.
      const [clock] = await f.db.execute<{ epoch_ms: string }>(sql`SELECT (extract(epoch FROM clock_timestamp()) * 1000)::text AS epoch_ms`);
      const actualNow = new Date(Number(clock.epoch_ms));
      const localMinute = Math.floor((actualNow.getTime() + 28800000) % 86400000 / 60000);
      const inactiveWindow = localMinute < 720 ? { start_time: '23:00', end_time: '24:00' }
        : { start_time: '00:00', end_time: '00:01' };
      vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(actualNow);
      const service = (db: typeof f.db) => new AdminSeckillTimeService(createContainerFromDb(db), f.env.APP_KEY);
      const revision = (await service(f.db).detail(101)).revision;
      const body = { revision, request_id: crypto.randomUUID(), ...(operation === 'update' ? { ...seckillTimeInput,
        ...inactiveWindow, pic: '/images/slot.png' } : operation === 'status' ? { status: 0 } : {}) };
      const params = { uid: 11, key: `slot_${operation}_${order}`, cartIds: [1], type: 1, seckillId: 20,
        shippingType: 2, storeId: 1, realName: '隔离秒杀样本', userPhone: '00000000000', userIp: '127.0.0.1' };
      if (order === 'buyer-first') await f.exec("CREATE FUNCTION seckill_purchase_barrier() RETURNS trigger AS $$ BEGIN PERFORM pg_advisory_xact_lock(731644,1); RETURN NEW; END $$ LANGUAGE plpgsql; CREATE TRIGGER seckill_purchase_barrier BEFORE INSERT ON store_order FOR EACH ROW EXECUTE FUNCTION seckill_purchase_barrier()");
      await withFinancePeers(f.db, async ([blocker, adminPeer, buyerPeer]) => {
        // A buyer-first test holds the real parent row before opening the
        // transaction. Admin update/status may lock the slot first; delete
        // must wait on parent EXCLUSIVE before it can ever lock that slot.
        await blocker.exec(order === 'buyer-first' ? 'BEGIN; SELECT pg_advisory_xact_lock(731644,1)' : operation === 'delete'
          ? 'BEGIN; SELECT * FROM store_activity WHERE id=9 FOR UPDATE' : 'BEGIN; SELECT * FROM store_seckill_time WHERE id=101 FOR UPDATE');
        try {
          const buy = () => outcome(StoreOrderCreateService.createWithRuntime(createContainerFromDb(buyerPeer.db),
            { CONFIG_KV: f.env.CONFIG_KV, nextOrderId: async () => `owned_${operation}_${order}` }, params));
          let purchase: ReturnType<typeof buy>, admin: ReturnType<typeof outcome<{ id: number }>>;
          if (order === 'admin-first') {
            admin = outcome(service(adminPeer.db).mutate(operation, 101, body, actor));
            await waitForFinanceBlock(f.db, adminPeer.pid, blocker.pid);
            purchase = buy(); await waitForFinanceBlock(f.db, buyerPeer.pid, adminPeer.pid);
            await blocker.exec('COMMIT');
          } else {
            purchase = buy(); await waitForFinanceBlock(f.db, buyerPeer.pid, blocker.pid);
            admin = outcome(service(adminPeer.db).mutate(operation, 101, body, actor));
            await waitForFinanceBlock(f.db, adminPeer.pid, buyerPeer.pid);
            await blocker.exec('COMMIT');
          }
          const a = await admin, b = await purchase;
          expect(a.ok).toBe(operation !== 'delete');
          expect(b.ok, b.ok ? undefined : errorMessages(b.error)).toBe(order === 'buyer-first' || operation === 'delete');
          if (!b.ok) expect(errorMessages(b.error)).toMatch(/当前不在秒杀时段|秒杀没有有效的启用时段/);
        } finally { await blocker.exec('ROLLBACK'); }
      });
      const orders = await f.db.select().from(storeOrder);
      expect(orders).toHaveLength(order === 'buyer-first' || operation === 'delete' ? 1 : 0);
      if (orders.length) expect(orders[0]).toMatchObject({ activityId: 20, type: 1, totalPrice: '12.50', paid: 0 });
      const logs = await f.db.select().from(systemLog); expect(logs).toHaveLength(operation === 'delete' ? 0 : 1);
    });
  }
});
