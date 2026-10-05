import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createContainerFromDb } from '../src/lib/di';
import { storeCombination, storePink, storeProduct, storeProductAttrValue } from '../src/models/schema';
import { AdminCombinationService } from '../src/services/admin/AdminCombinationService';
import { runRuntimeBusinessCommissioning } from '../src/migrations/runRuntimeBusinessCommissioning';
import { auditRuntimeBusinessPrivileges } from '../src/migrations/auditRuntimeBusinessPrivileges';
import { combinationAdminFixture, combinationEdit, combinationInput } from './helpers/combinationAdminFixture';
import { outcome, waitForFinanceBlock, waitForFinanceClock, withFinancePeers } from './helpers/financePeers';
import { refundRuntimeFixture } from './helpers/refundRuntimeFixture';

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('Combination independent PostgreSQL lock protocol', () => {
  let f: Awaited<ReturnType<typeof combinationAdminFixture>>;
  const actor = { id: 2 };
  beforeEach(async () => { f = await combinationAdminFixture(); }, 30000);
  afterEach(async () => { vi.restoreAllMocks(); await f?.close(); }, 30000);
  const server = (db: typeof f.db) => new AdminCombinationService(createContainerFromDb(db), f.appKey);
  const create = async () => (await f.service.mutate('create', 0, combinationInput(), actor)).id;
  it('serializes identical UUIDs across independent backends into one complete graph and one audit', async () => {
    const input = combinationInput();
    await withFinancePeers(f.db, async ([blocker, first, second]) => {
      await blocker.exec('BEGIN; SELECT pg_advisory_xact_lock(731647,1)');
      try {
        const a = outcome(server(first.db).mutate('create', 0, input, actor)); await waitForFinanceBlock(f.db, first.pid, blocker.pid);
        const b = outcome(server(second.db).mutate('create', 0, input, actor)); await waitForFinanceBlock(f.db, second.pid, first.pid);
        await blocker.exec('COMMIT'); const result = await a; expect(result.ok).toBe(true); expect(await b).toEqual(result);
      } finally { await blocker.exec('ROLLBACK'); }
    });
    const snapshot = await f.snapshot(); expect(snapshot.combinations).toHaveLength(1); expect(snapshot.skus.filter(row => row.type === 3)).toHaveLength(2); expect(snapshot.logs).toHaveLength(1);
  });
  it.each(['status', 'delete', 'update'] as const)('%s uses NOWAIT UPDATE against payment KEY SHARE and immediately rolls back all changes', async operation => {
    const id = await create(), row = await f.service.detail(id), before = await f.snapshot();
    const body = operation === 'update' ? combinationEdit(row, { status: 0 }) : { revision: row.revision, request_id: crypto.randomUUID(), ...(operation === 'status' ? { status: 0 } : {}) };
    await withFinancePeers(f.db, async ([payment, admin, observer]) => {
      await payment.exec(`BEGIN; SELECT id FROM store_combination WHERE id=${id} FOR KEY SHARE`);
      try {
        const result = await outcome(server(admin.db).mutate(operation, id, body, actor));
        expect(result).toMatchObject({ ok: false, error: { message: expect.stringContaining('正在变化') } });
        expect(await observer.exec(`SELECT 1 FROM pg_locks WHERE pid=${admin.pid} AND mode='ExclusiveLock'`)).toEqual([]);
      } finally { await payment.exec('ROLLBACK'); }
    }); expect(await f.snapshot()).toEqual(before);
  });
  it('ordinary inventory editing retains the NKU boundary compatible with a payment KEY SHARE reader', async () => {
    const id = await create(), body = combinationEdit(await f.service.detail(id)); body.title = '兼容支付快照读';
    await withFinancePeers(f.db, async ([payment, admin]) => {
      await payment.exec(`BEGIN; SELECT id FROM store_combination WHERE id=${id} FOR KEY SHARE`);
      try { expect(await outcome(server(admin.db).mutate('update', id, body, actor))).toMatchObject({ ok: true }); }
      finally { await payment.exec('ROLLBACK'); }
    }); expect((await f.service.detail(id)).title).toBe('兼容支付快照读');
  });
  it('never waits on a pink or source SKU after obtaining the combination inventory boundary', async () => {
    const id = await create(); await f.db.insert(storePink).values({ id: 1, combinationId: id, productId: 101, people: 3, status: 1, stopTime: new Date(Date.now() + 86400000) });
    await withFinancePeers(f.db, async ([worker, admin]) => {
      for (const kind of ['pink', 'source'] as const) {
        const before = await f.snapshot(), detail = await f.service.detail(id);
        await worker.exec(kind === 'pink' ? 'BEGIN; SELECT id FROM store_pink WHERE id=1 FOR UPDATE' : 'BEGIN; SELECT id FROM store_product_attr_value WHERE id=11 FOR UPDATE');
        try {
          const result = await outcome(kind === 'pink' ? server(admin.db).mutate('status', id, { revision: detail.revision, request_id: crypto.randomUUID(), status: 0 }, actor)
            : server(admin.db).mutate('update', id, combinationEdit(detail), actor));
          expect(result).toMatchObject({ ok: false, error: { message: expect.stringContaining('正在变化') } });
        } finally { await worker.exec('ROLLBACK'); }
        expect(await f.snapshot()).toEqual(before);
      }
    });
  });
  it('soft deletion succeeds while an existing pink is locked and preserves its original deadline and activity flags', async () => {
    const id = await create(); await f.db.insert(storePink).values({ id: 1, combinationId: id, productId: 101, people: 3, status: 1, stopTime: new Date(Date.now() + 86400000) });
    const before = await f.snapshot(), detail = await f.service.detail(id);
    await withFinancePeers(f.db, async ([worker, admin]) => {
      await worker.exec('BEGIN; SELECT id FROM store_pink WHERE id=1 FOR UPDATE');
      try {
        expect(await outcome(server(admin.db).mutate('delete', id, { revision: detail.revision, request_id: crypto.randomUUID() }, actor))).toMatchObject({ ok: true, value: { id } });
      } finally { await worker.exec('ROLLBACK'); }
    });
    const after = await f.snapshot(); expect(after.combinations).toEqual(before.combinations.map(row => ({ ...row, isDel: 1 })));
    expect(after.pinks).toEqual(before.pinks); expect(after.skus).toEqual(before.skus); expect(after.logs).toHaveLength(before.logs.length + 1);
  });
  it('detects inventory writes committed while normal edit waits for the combination row', async () => {
    const id = await create(), body = combinationEdit(await f.service.detail(id)), before = await f.snapshot();
    await withFinancePeers(f.db, async ([buyer, admin]) => {
      await buyer.exec(`BEGIN; SELECT id FROM store_combination WHERE id=${id} FOR NO KEY UPDATE; UPDATE store_combination SET quota=quota-1,stock=stock-1,sales=sales+1 WHERE id=${id}`);
      try {
        const pending = outcome(server(admin.db).mutate('update', id, body, actor)); await waitForFinanceBlock(f.db, admin.pid, buyer.pid);
        const skuId = (await f.service.detail(id)).skus[0].id;
        await buyer.exec(`UPDATE store_product_attr_value SET quota=quota-1,stock=stock-1,sales=sales+1 WHERE id=${skuId}; COMMIT`);
        expect(await pending).toMatchObject({ ok: false, error: { message: expect.stringContaining('已更新') } });
      } finally { await buyer.exec('ROLLBACK'); }
    }); const after = await f.snapshot(); expect(after.logs).toEqual(before.logs); expect(after.combinations[0].sales).toBe(1);
  });
  it('rechecks the database clock after a bounded advisory wait and rejects an expired incoming schedule', async () => {
    const deadline = Date.now() + 800, input = combinationInput({ end_time: new Date(deadline).toISOString() });
    await withFinancePeers(f.db, async ([blocker, admin]) => {
      await blocker.exec('BEGIN; SELECT pg_advisory_xact_lock(731647,1)');
      try {
        const pending = outcome(server(admin.db).mutate('create', 0, input, actor)); await waitForFinanceBlock(f.db, admin.pid, blocker.pid);
        await waitForFinanceClock(f.db, deadline); await blocker.exec('COMMIT');
        expect(await pending).toMatchObject({ ok: false, error: { message: expect.stringContaining('当前时间') } });
      } finally { await blocker.exec('ROLLBACK'); }
    }); expect((await f.snapshot()).combinations).toHaveLength(0); expect((await f.snapshot()).logs).toHaveLength(0);
  });
  it('rejects repeatable-read writes before taking stale snapshots or changing any business rows', async () => {
    await withFinancePeers(f.db, async ([admin]) => {
      await admin.exec("SET default_transaction_isolation='repeatable read'");
      try { expect(await outcome(server(admin.db).mutate('create', 0, combinationInput(), actor)))
        .toMatchObject({ ok: false, error: { message: expect.stringContaining('READ COMMITTED') } }); }
      finally { await admin.exec("SET default_transaction_isolation='read committed'"); }
    }); expect((await f.snapshot()).combinations).toHaveLength(0);
  });
});

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('Actual commissioned Admin LOGIN combination configuration', () => {
  let f: Awaited<ReturnType<typeof refundRuntimeFixture>>;
  beforeEach(async () => { vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('External I/O forbidden')); f = await refundRuntimeFixture(); f.env.APP_KEY = 'local-combination-admin-key'; }, 60000);
  afterEach(async () => { try { expect(fetch).not.toHaveBeenCalled(); } finally { vi.restoreAllMocks(); await f?.close(); } }, 30000);
  it('uses the existing exact Admin grants for full supplier-source CRUD, preserved SKU identities and display-cache I/D', async () => {
    await f.withRuntimeRole!(app => f.withRuntimeRole!(async admin => {
      const [identity] = await f.exec('SELECT current_database() AS database'), names = { app: app.role, admin: admin.role, maintenance: 'finance_test' };
      await runRuntimeBusinessCommissioning(f.db, { ...names, database: String(identity.database), pricingOwner: f.pricingOwner });
      expect(await auditRuntimeBusinessPrivileges(admin.db, 'admin', names)).toMatchObject({ ready: true, failures: [] });
      await f.db.update(storeProduct).set({ isVerify: 1, isVipProduct: 0, isPresaleProduct: 0, sliderImage: '["/images/owned.png"]' }).where(eq(storeProduct.id, 70));
      await f.exec("SELECT setval(pg_get_serial_sequence('store_product_attr_value','id'),(SELECT max(id) FROM store_product_attr_value),true)");
      const service = new AdminCombinationService(createContainerFromDb(admin.db), f.env.APP_KEY), actor = { id: 1 };
      expect((await service.options()).max_skus).toBe(500); expect((await service.candidates(new URLSearchParams())).list.some(row => row.product_id === 70)).toBe(true);
      const source = await service.source(70); expect(source.owner).toEqual({ type: 2, relation_id: 7 });
      const input = combinationInput({ product_id: 70, shipping: { delivery_type: [1], freight: 2, postage: '3.00', temp_id: 0 },
        skus: [{ id: null, base_unique: 'qared001', enabled: true, price: '6.25', quota_total: 5, image: '/images/owned-sku.png' }] });
      const before = await f.db.select().from(storeProduct), created = await service.mutate('create', 0, input, actor), initial = await service.detail(created.id);
      expect(initial).toMatchObject({ valid: true, owner: { type: 2, relation_id: 7 }, shipping: { freight: 2, postage: '3.00' } });
      expect(initial.skus[0]).toMatchObject({ settle_price: '2.50', cost: '2.00' });
      const edit = combinationEdit(initial); edit.title = '实际Admin原位编辑'; edit.skus[0].quota_total = 6;
      await service.mutate('update', created.id, edit, actor); const edited = await service.detail(created.id);
      expect(edited.skus[0]).toMatchObject({ id: initial.skus[0].id, unique: initial.skus[0].unique, quota_total: 6 });
      for (const status of [0, 1] as const) await service.mutate('status', created.id, { revision: (await service.detail(created.id)).revision, request_id: crypto.randomUUID(), status }, actor);
      await expect(app.exec("INSERT INTO store_combination(store_name) VALUES('forbidden')")).rejects.toMatchObject({ code: '42501' });
      await expect(admin.exec(`UPDATE store_product_attr_result SET result='{}' WHERE product_id=${created.id} AND type=3`)).rejects.toMatchObject({ code: '42501' });
      await service.mutate('delete', created.id, { revision: (await service.detail(created.id)).revision, request_id: crypto.randomUUID() }, actor);
      expect((await admin.db.select().from(storeCombination).where(eq(storeCombination.id, created.id)))[0]).toMatchObject({ isDel: 1, status: 1, isShow: 1 });
      expect((await admin.db.select().from(storeProductAttrValue).where(eq(storeProductAttrValue.id, initial.skus[0].id)))[0].unique).toBe(initial.skus[0].unique);
      expect(await f.db.select().from(storeProduct)).toEqual(before);
    }));
  }, 60000);
});
