import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createContainerFromDb } from '../src/lib/di';
import { storeActivity, storeProduct, storeProductAttrValue, storeProductCategory, storeProductLabel, storeProductRelation, storeSeckill, storeSeckillTime, systemAttachment } from '../src/models/schema';
import { AdminSeckillActivityService } from '../src/services/admin/AdminSeckillActivityService';
import { runRuntimeBusinessCommissioning } from '../src/migrations/runRuntimeBusinessCommissioning';
import { auditRuntimeBusinessPrivileges } from '../src/migrations/auditRuntimeBusinessPrivileges';
import { activityEdit, seckillActivityFixture, seckillActivityInput } from './helpers/seckillActivityFixture';
import { outcome, waitForFinanceBlock, withFinancePeers } from './helpers/financePeers';
import { refundRuntimeFixture } from './helpers/refundRuntimeFixture';

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('Seckill parent independent PostgreSQL backends', () => {
  let f: Awaited<ReturnType<typeof seckillActivityFixture>>;
  beforeEach(async () => { f = await seckillActivityFixture(); }, 30000);
  afterEach(async () => { vi.restoreAllMocks(); await f?.close(); }, 30000);
  const actor = { id: 2 }, service = (db: typeof f.db) => new AdminSeckillActivityService(createContainerFromDb(db), f.env.APP_KEY);
  const create = async () => (await service(f.db).mutate('create', 0, seckillActivityInput(), actor)).id;
  it('serializes the same UUID on independent backends and creates one graph and one audit', async () => {
    // Each source SKU has sufficient stock, but their active sum must also fit
    // the independently maintained source product stock.
    await f.db.update(storeProduct).set({ stock: 29 }).where(eq(storeProduct.id, 101));
    const before = await f.snapshot();
    expect(await outcome(service(f.db).mutate('create', 0, seckillActivityInput(), actor)))
      .toMatchObject({ ok: false, error: { message: expect.stringContaining('基础商品库存') } });
    expect(await f.snapshot()).toEqual(before);
    await f.db.update(storeProduct).set({ stock: 100 }).where(eq(storeProduct.id, 101));
    const input = seckillActivityInput();
    await withFinancePeers(f.db, async ([blocker, first, second]) => {
      await blocker.exec('BEGIN; SELECT pg_advisory_xact_lock(731646,1)');
      try {
        const a = outcome(service(first.db).mutate('create', 0, input, actor)); await waitForFinanceBlock(f.db, first.pid, blocker.pid);
        const b = outcome(service(second.db).mutate('create', 0, input, actor)); await waitForFinanceBlock(f.db, second.pid, first.pid);
        await blocker.exec('COMMIT'); const firstResult = await a, secondResult = await b;
        expect(firstResult.ok).toBe(true); expect(secondResult).toEqual(firstResult);
      } finally { await blocker.exec('ROLLBACK'); }
    });
    const after = await f.snapshot(); expect(after.parents).toHaveLength(1); expect(after.children).toHaveLength(1);
    expect(after.skus.filter(row => row.type === 1)).toHaveLength(2); expect(after.logs).toHaveLength(1);
  });
  it.each(['status', 'delete', 'update'] as const)('detects a child append committed while %s waits for the relation fence', async operation => {
    const id = await create(), detail = await service(f.db).detail(id);
    const body = operation === 'update' ? activityEdit(detail) : { revision: detail.revision, request_id: crypto.randomUUID(), ...(operation === 'status' ? { status: 0 } : {}) };
    await withFinancePeers(f.db, async ([writer, admin]) => {
      await writer.exec(`BEGIN; INSERT INTO store_seckill(activity_id,product_id,status) VALUES(${id},102,0)`);
      try {
        const pending = outcome(service(admin.db).mutate(operation, id, body, actor)); await waitForFinanceBlock(f.db, admin.pid, writer.pid);
        await writer.exec('COMMIT'); expect(await pending).toMatchObject({ ok: false, error: { message: expect.stringContaining('已更新') } });
      } finally { await writer.exec('ROLLBACK'); }
    });
    const after = await f.snapshot(); expect(after.parents[0]).toMatchObject({ status: 1, isDel: 0 }); expect(after.logs).toHaveLength(1);
  });
  it('waits for an existing parent reader before locking child/slots and releases all locks on timeout', async () => {
    const id = await create(), revision = (await service(f.db).detail(id)).revision;
    await withFinancePeers(f.db, async ([buyer, admin, observer]) => {
      await buyer.exec(`BEGIN; SELECT id FROM store_activity WHERE id=${id} FOR SHARE`);
      await admin.exec("SET lock_timeout='200ms'");
      try {
        const pending = outcome(service(admin.db).mutate('status', id, { revision, request_id: crypto.randomUUID(), status: 0 }, actor));
        await waitForFinanceBlock(f.db, admin.pid, buyer.pid);
        expect(await observer.exec(`SELECT 1 FROM pg_locks l JOIN pg_class c ON c.oid=l.relation WHERE l.pid=${admin.pid}
          AND l.granted AND c.relname IN('store_seckill','store_seckill_time') AND l.mode IN('ExclusiveLock','RowShareLock')`)).toEqual([]);
        expect((await pending).ok).toBe(false);
        expect(await observer.exec(`SELECT 1 FROM pg_locks WHERE pid=${admin.pid} AND mode='ExclusiveLock'`)).toEqual([]);
      } finally { await buyer.exec('ROLLBACK'); }
    });
    expect((await f.snapshot()).parents[0].status).toBe(1);
  });
  it('never waits backwards on a source SKU already owned by stock restoration', async () => {
    const id = await create(), body = activityEdit(await service(f.db).detail(id)), before = await f.snapshot();
    await withFinancePeers(f.db, async ([restorer, admin]) => {
      await restorer.exec('BEGIN; SELECT id FROM store_product_attr_value WHERE id=11 FOR UPDATE');
      try {
        const result = await outcome(service(admin.db).mutate('update', id, body, actor));
        expect(result).toMatchObject({ ok: false, error: { message: expect.stringContaining('正在变化') } });
      } finally { await restorer.exec('ROLLBACK'); }
    });
    expect(await f.snapshot()).toEqual(before);
  });
  it('rolls back a proposed new SKU save on source contention, then allocates it once after retry', async () => {
    const id = await create();
    const [newBase] = await f.db.insert(storeProductAttrValue).values({ productId: 101, type: 0,
      unique: 'base0004', suk: '绿', stock: 20, price: '13.00', otPrice: '23.00', cost: '4.00' })
      .returning({ id: storeProductAttrValue.id });
    const body = activityEdit(await service(f.db).detail(id));
    body.name = 'should roll back';
    body.products[0].skus[0].quota_total += 1;
    body.products[0].skus.push({ id: null, base_unique: 'base0004', price: '7.00', quota_total: 5, enabled: true });
    const before = await f.snapshot();
    await withFinancePeers(f.db, async ([restorer, admin]) => {
      await restorer.exec(`BEGIN; SELECT id FROM store_product_attr_value WHERE id=${newBase.id} FOR UPDATE`);
      try {
        const result = await outcome(service(admin.db).mutate('update', id, body, actor));
        expect(result).toMatchObject({ ok: false, error: { message: expect.stringContaining('正在变化') } });
        expect(await f.snapshot()).toEqual(before);
      } finally { await restorer.exec('ROLLBACK'); }
    });
    expect(await f.snapshot()).toEqual(before);
    expect(await service(f.db).mutate('update', id, body, actor)).toEqual({ id });
    const after = await f.snapshot();
    const childId = before.children[0].id;
    const active = after.skus.filter(row => row.productId === childId && row.type === 1 && row.isRetired === 0);
    expect(active).toHaveLength(3);
    expect(active.filter(row => !before.skus.some(old => old.id === row.id)))
      .toMatchObject([{ productId: childId, suk: '绿', stock: 5, quota: 5, quotaShow: 5, price: '7.00' }]);
    expect(after.parents[0].name).toBe('should roll back');
    expect(after.children[0]).toMatchObject({ quota: before.children[0].quota + 6,
      quotaShow: before.children[0].quotaShow + 6, stock: before.children[0].stock + 6 });
    expect(after.logs).toHaveLength(before.logs.length + 1);
    expect(await service(f.db).mutate('update', id, body, actor)).toEqual({ id });
    expect(await f.snapshot()).toEqual(after);
  });
  it('rejects a repeatable-read write before snapshots, business changes or audit', async () => {
    await withFinancePeers(f.db, async ([admin]) => {
      await admin.exec("SET default_transaction_isolation='repeatable read'");
      try { expect(await outcome(service(admin.db).mutate('create', 0, seckillActivityInput(), actor)))
        .toMatchObject({ ok: false, error: { message: expect.stringContaining('READ COMMITTED') } }); }
      finally { await admin.exec("SET default_transaction_isolation='read committed'"); }
    });
    expect((await f.snapshot()).parents).toHaveLength(0); expect((await f.snapshot()).logs).toHaveLength(0);
  });
});

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('Real commissioned Admin LOGIN parent management', () => {
  let f: Awaited<ReturnType<typeof refundRuntimeFixture>>;
  beforeEach(async () => { vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('External I/O forbidden')); f = await refundRuntimeFixture(); f.env.APP_KEY = 'local-admin-seckill-media-key'; }, 60000);
  afterEach(async () => { try { expect(fetch).not.toHaveBeenCalled(); } finally { vi.restoreAllMocks(); await f?.close(); } }, 30000);
  it('executes supplier-source create/edit/cascade/archive with exact Admin grants, while app has no parent semantic DML', async () => {
    await f.withRuntimeRole!(app => f.withRuntimeRole!(async admin => {
      const [identity] = await f.exec('SELECT current_database() AS database');
      const names = { app: app.role, admin: admin.role, maintenance: 'finance_test' };
      await runRuntimeBusinessCommissioning(f.db, { ...names, database: String(identity.database), pricingOwner: f.pricingOwner });
      expect(await auditRuntimeBusinessPrivileges(app.db, 'app', names)).toMatchObject({ ready: true, failures: [] });
      expect(await auditRuntimeBusinessPrivileges(admin.db, 'admin', names)).toMatchObject({ ready: true, failures: [] });
      await f.db.insert(storeSeckillTime).values({ id: 101, title: '全天', startTime: '00:00', endTime: '24:00', status: 1 });
      await f.db.update(storeProduct).set({ isVerify: 1, isVipProduct: 0, isPresaleProduct: 0 }).where(eq(storeProduct.id, 70));
      await f.exec("SELECT setval(pg_get_serial_sequence('store_product_attr_value','id'),(SELECT max(id) FROM store_product_attr_value),true)");
      const server = new AdminSeckillActivityService(createContainerFromDb(admin.db), f.env.APP_KEY), actor = { id: 1 };
      // Exercise each newly used read table through this separately authenticated
      // commissioned LOGIN, rather than treating maintenance permissions as proof.
      await f.db.insert(storeProductCategory).values({ id: 201, pid: 0, type: 0, relationId: 0, isShow: 1, cateName: '本机分类' });
      await f.db.insert(storeProductLabel).values({ id: 202, type: 0, relationId: 0, status: 0, isShow: 0, labelName: '本机隐藏标签' });
      await f.db.insert(storeProductRelation).values([{ productId: 70, relationId: 201, type: 1, status: 0 }, { productId: 70, relationId: 202, type: 3, status: 0 }]);
      await f.db.insert(systemAttachment).values({ attId: 81, type: 4, relationId: 7, moduleType: 1, imageType: 8, fileType: 1,
        attType: 'image/png', attDir: '/api/assets/81', name: 'attachments/supplier/7/admin-read-test.png' });
      await f.db.update(storeProductAttrValue).set({ image: '/api/assets/81' }).where(eq(storeProductAttrValue.id, 1));
      const options = await server.options();
      expect(options.categories).toContainEqual({ id: 201, pid: 0, cate_name: '本机分类' });
      expect(options.labels).toContainEqual({ id: 202, label_name: '本机隐藏标签', status: 0, is_show: 0 });
      const filtered = await server.candidates(new URLSearchParams('category_id=201&label_id=202'));
      expect(filtered.list.map(row => row.product_id)).toEqual([70]);
      expect(filtered.list[0].category_name).toBe('本机分类');
      const source = await server.source(70);
      expect(source.skus.find(row => row.base_unique === 'qared001')).toMatchObject({ image: '/api/assets/81', image_preview: expect.stringMatching(/^\/api\/assets\/81\?expires=\d+&signature=/) });
      const input = seckillActivityInput({ image: '', time_ids: [101], products: [{ child_id: null, product_id: 70, status: 1,
        skus: [{ id: null, base_unique: 'qared001', price: '6.25', quota_total: 5, enabled: true }] }] });
      const before = await f.db.select().from(storeProduct), created = await server.mutate('create', 0, input, actor);
      const initial = await server.detail(created.id); expect(initial.valid).toBe(true); expect(initial.products[0].product_id).toBe(70);
      const children = await admin.db.select().from(storeSeckill).where(eq(storeSeckill.activityId, created.id));
      expect(children[0]).toMatchObject({ type: 2, relationId: 7, freight: 2, postage: '3.00' });
      const skus = await admin.db.select().from(storeProductAttrValue).where(eq(storeProductAttrValue.productId, children[0].id));
      expect(skus.find(row => row.type === 1)).toMatchObject({ settlePrice: '2.50', cost: '2.00' });
      const body = activityEdit(initial); body.name = '真实角色改名'; body.products[0].skus[0].quota_total = 6;
      await server.mutate('update', created.id, body, actor);
      for (const status of [0, 1] as const) await server.mutate('status', created.id, { request_id: crypto.randomUUID(), revision: (await server.detail(created.id)).revision, status }, actor);
      await expect(app.exec(`UPDATE store_activity SET name='forbidden' WHERE id=${created.id}`)).rejects.toMatchObject({ code: '42501' });
      await expect(app.exec("INSERT INTO store_activity(name) VALUES('forbidden')")).rejects.toMatchObject({ code: '42501' });
      await expect(admin.exec(`DELETE FROM store_activity WHERE id=${created.id}`)).rejects.toMatchObject({ code: '42501' });
      await server.mutate('delete', created.id, { request_id: crypto.randomUUID(), revision: (await server.detail(created.id)).revision }, actor);
      expect((await admin.db.select().from(storeActivity).where(eq(storeActivity.id, created.id)))[0]).toMatchObject({ isDel: 1, status: 0 });
      expect((await admin.db.select().from(storeSeckill).where(eq(storeSeckill.id, children[0].id)))[0]).toMatchObject({ isDel: 1, status: 0 });
      expect(await f.db.select().from(storeProduct)).toEqual(before);
    }));
  }, 60000);
});
