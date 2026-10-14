import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createContainerFromDb, type DbClient } from '@/lib/di';
import { storeProductUnit, storeProduct, storeProductCategory, storeProductAttrValue, systemLog, systemRole } from '@/models/schema';
import { AdminProductUnitService } from '@/services/admin/AdminProductUnitService';
import { ProductAssociationService } from '@/services/product/ProductAssociationService';
import { SupplierProductManagementService } from '@/services/supplier/SupplierProductManagementService';
import { lockProductUnitLifecycle } from '@/services/product/ProductUnitLifecycle';
import { productUnitFixture, unitActor } from './helpers/adminProductUnits';
import { outcome, waitForFinanceBlock, waitForFinanceClock, withFinancePeers } from './helpers/financePeers';
function signal() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
const service = (db: DbClient) => new AdminProductUnitService(createContainerFromDb(db));
const productActor = { id: 101, name: 'fixture', ip: '127.0.0.1' };
describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('native PG16 unit metadata and actual product-save synchronization', () => {
  let f: Awaited<ReturnType<typeof productUnitFixture>>;
  beforeEach(async () => { vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('External I/O forbidden')); f = await productUnitFixture(true); }, 30000);
  afterEach(async () => { try { expect(fetch).not.toHaveBeenCalled(); } finally { vi.restoreAllMocks(); await f?.close(); } }, 30000);
  it('serializes duplicate creations to one unit and one atomic audit', async () => {
    await withFinancePeers(f.db, async ([left, right]) => {
      const results = await Promise.allSettled([service(left.db).save(0, { name: '同时新增' }, unitActor()), service(right.db).save(0, { name: '同时新增' }, unitActor())]);
      expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
      expect(await f.db.select().from(storeProductUnit).where(eq(storeProductUnit.name, '同时新增'))).toHaveLength(1);
      expect(await f.db.select().from(systemLog)).toHaveLength(1);
    });
  });
  it('waits for the real Admin product update, then rejects deleting its committed global reference', async () => {
    await f.db.insert(storeProduct).values({ id: 80, storeName: '原生平台商品', unitName: '未归类自由文本', price: '10.00' });
    await withFinancePeers(f.db, async ([writer, deleting]) => {
      const ready = signal(), release = signal();
      const held = outcome(writer.db.transaction(async tx => {
        await new ProductAssociationService(createContainerFromDb(tx as unknown as DbClient)).save(80, { unit_name: '箱' }, productActor);
        ready.resolve(); await release.promise;
      }));
      await Promise.race([ready.promise, held.then(result => { if (!result.ok) throw result.error; })]);
      const removal = outcome(service(deleting.db).remove(2, new URLSearchParams(), unitActor()));
      try { await waitForFinanceBlock(f.db, deleting.pid, writer.pid); } finally { release.resolve(); }
      expect((await held).ok).toBe(true); const result = await removal; expect(result.ok).toBe(false);
      if (!result.ok) expect(String(result.error)).toContain('正在使用');
      expect((await f.db.select().from(storeProduct).where(eq(storeProduct.id, 80)))[0].unitName).toBe('箱');
      expect((await f.db.select().from(storeProductUnit).where(eq(storeProductUnit.id, 2)))[0].isDel).toBe(0);
    });
  });
  it('waits for a real Supplier product/SKU save before rejecting platform unit deletion', async () => {
    await f.db.insert(storeProductCategory).values({ id: 20, cateName: 'Supplier分类', type: 2, relationId: 20 });
    await withFinancePeers(f.db, async ([writer, deleting]) => {
      const ready = signal(), release = signal();
      const held = outcome(writer.db.transaction(async tx => {
        await new SupplierProductManagementService(createContainerFromDb(tx as unknown as DbClient)).saveProduct(20, 0, {
          store_name: '真实供应商产品', unit_name: '箱', cate_id: [20], slider_image: ['https://images.example/unit.png'],
          spec_type: 0, attrs: [{ suk: '默认', image: 'https://images.example/unit.png', price: '10.00', settle_price: '8.00', stock: 3 }],
          description: '<p>fixture</p>', freight: 1, is_postage: 1,
        }); ready.resolve(); await release.promise;
      }));
      await Promise.race([ready.promise, held.then(result => { if (!result.ok) throw result.error; })]);
      const removal = outcome(service(deleting.db).remove(2, new URLSearchParams(), unitActor()));
      try { await waitForFinanceBlock(f.db, deleting.pid, writer.pid); } finally { release.resolve(); }
      expect((await held).ok).toBe(true); expect((await removal).ok).toBe(false);
      expect((await f.db.select().from(storeProduct))[0]).toMatchObject({ type: 2, relationId: 20, unitName: '箱' });
      expect(await f.db.select().from(storeProductAttrValue)).toHaveLength(1);
    });
  });
  it('deletion may commit first and a later real product preserves historical free text by contract', async () => {
    await f.db.insert(storeProduct).values({ id: 80, storeName: '原生平台商品', unitName: '原自由文本', price: '10.00' });
    await withFinancePeers(f.db, async ([deleting, writer]) => {
      const ready = signal(), release = signal();
      const held = outcome(deleting.db.transaction(async tx => {
        await service(tx as unknown as DbClient).remove(2, new URLSearchParams(), unitActor()); ready.resolve(); await release.promise;
      }));
      await Promise.race([ready.promise, held.then(result => { if (!result.ok) throw result.error; })]);
      const binding = outcome(new ProductAssociationService(createContainerFromDb(writer.db)).save(80, { unit_name: '箱' }, productActor));
      try { await waitForFinanceBlock(f.db, writer.pid, deleting.pid); } finally { release.resolve(); }
      expect((await held).ok).toBe(true); expect((await binding).ok).toBe(true);
      expect((await f.db.select().from(storeProductUnit).where(eq(storeProductUnit.id, 2)))[0].isDel).toBe(1);
      expect((await f.db.select().from(storeProduct).where(eq(storeProduct.id, 80)))[0].unitName).toBe('箱');
    });
  });
  it('orders a concurrent current-role revoke after the fenced commit and rejects all subsequent writes', async () => {
    await withFinancePeers(f.db, async ([blocker, writer, revoking]) => {
      await blocker.exec('SELECT pg_advisory_lock(731611,0)');
      const operation = outcome(service(writer.db).save(0, { name: '迟到候选' }, unitActor()));
      let revocation: ReturnType<typeof outcome> | undefined;
      try {
        await waitForFinanceBlock(f.db, writer.pid, blocker.pid);
        revocation = outcome(revoking.db.update(systemRole).set({ rules: 'product.view' }).where(eq(systemRole.id, 1)));
        await waitForFinanceBlock(f.db, revoking.pid, writer.pid);
      } finally { await blocker.exec('SELECT pg_advisory_unlock(731611,0)'); }
      // Authority tables are locked for the full transaction: a parallel revoke
      // is ordered after a committed write, never between its check and commit.
      expect((await operation).ok).toBe(true);
      expect((await revocation!).ok).toBe(true);
      await expect(service(writer.db).save(0, { name: '已撤权' }, unitActor())).rejects.toThrow('权限');
      expect(await f.db.select().from(storeProductUnit).where(eq(storeProductUnit.name, '已撤权'))).toEqual([]);
    });
  });
  it('rolls back the complete unit and audit if the original session expires during a proven lock wait', async () => {
    await withFinancePeers(f.db, async ([blocker, writer]) => {
      await blocker.exec('SELECT pg_advisory_lock(731611,0)');
      const actor = { ...unitActor(), expiresAt: Math.ceil((Date.now() + 500) / 1000) };
      const operation = outcome(service(writer.db).save(0, { name: '过期候选' }, actor));
      try { await waitForFinanceBlock(f.db, writer.pid, blocker.pid); await waitForFinanceClock(f.db, actor.expiresAt * 1000); }
      finally { await blocker.exec('SELECT pg_advisory_unlock(731611,0)'); }
      const result = await operation; expect(result.ok).toBe(false); if (!result.ok) expect(String(result.error)).toContain('过期');
      expect(await f.db.select().from(storeProductUnit).where(eq(storeProductUnit.name, '过期候选'))).toEqual([]);
      expect(await f.db.select().from(systemLog)).toEqual([]);
    });
  });
  it('returns bounded lock conflict with no effects, then succeeds once the real unit fence is available', async () => {
    await withFinancePeers(f.db, async ([blocker, writer]) => {
      await blocker.exec('SELECT pg_advisory_lock(731611,0)');
      try { await expect(service(writer.db).save(0, { name: '锁超时' }, unitActor())).rejects.toMatchObject({ code: 409 }); }
      finally { await blocker.exec('SELECT pg_advisory_unlock(731611,0)'); }
      expect(await f.db.select().from(systemLog)).toEqual([]);
      await service(writer.db).save(0, { name: '锁超时' }, unitActor());
      expect(await f.db.select().from(storeProductUnit).where(eq(storeProductUnit.name, '锁超时'))).toHaveLength(1);
    });
  });
  it('preserves stricter caller lock bounds and restores session settings after real unit-fence commit and rollback', async () => {
    await withFinancePeers(f.db, async ([peer]) => {
      type Setting = { name: string; setting: string };
      const settingsQuery = "SELECT name,setting FROM pg_catalog.pg_settings WHERE name IN ('lock_timeout','statement_timeout','idle_in_transaction_session_timeout') ORDER BY name";
      const initialRows = await peer.exec(settingsQuery) as unknown as Setting[];
      expect(initialRows).toHaveLength(3);
      const initial: Record<string, string> = Object.fromEntries(initialRows.map(row => [row.name, row.setting]));
      const sessionSettings = async (): Promise<Record<string, string>> => Object.fromEntries((await peer.exec(settingsQuery) as unknown as Setting[]).map(row => [row.name, row.setting]));
      try {
        for (const [input, expected] of [[0, 2000], [750, 750], [2000, 2000], [5000, 2000]] as const) {
          for (const phase of ['commit', 'rollback'] as const) {
            await peer.exec(`SELECT pg_catalog.set_config('lock_timeout','${input}ms',false)`);
            const original = await sessionSettings();
            expect(original).toEqual({ ...initial, lock_timeout: String(input) });
            const rollback = new Error('Owned unit-bound rollback');
            const result = await outcome(peer.db.transaction(async rawTx => {
              const tx = rawTx as unknown as DbClient;
              await lockProductUnitLifecycle(tx);
              const rows = await tx.execute(sql`SELECT name,setting FROM pg_catalog.pg_settings
                WHERE name IN ('lock_timeout','statement_timeout','idle_in_transaction_session_timeout') ORDER BY name`) as unknown as Setting[];
              expect(rows).toHaveLength(3);
              expect(Object.fromEntries(rows.map(row => [row.name, row.setting]))).toEqual({ ...original, lock_timeout: String(expected) });
              const locks = await tx.execute(sql`SELECT classid,objid,objsubid,mode,granted FROM pg_catalog.pg_locks
                WHERE pid=${peer.pid} AND locktype='advisory' AND classid=731611 AND objid=0 AND objsubid=2`) as unknown as Array<{ classid: number; objid: number; objsubid: number; mode: string; granted: boolean }>;
              expect(locks).toEqual([{ classid: 731611, objid: 0, objsubid: 2, mode: 'ExclusiveLock', granted: true }]);
              if (phase === 'rollback') throw rollback;
            }));
            if (phase === 'rollback') { expect(result.ok).toBe(false); if (!result.ok) expect(result.error).toBe(rollback); }
            else expect(result.ok).toBe(true);
            expect(await sessionSettings()).toEqual(original);
          }
        }
      } finally {
        if (!/^\d+$/.test(initial.lock_timeout)) throw Error('Unexpected owned peer lock setting');
        await peer.exec(`SELECT pg_catalog.set_config('lock_timeout','${initial.lock_timeout}ms',false)`);
      }
      expect(await sessionSettings()).toEqual(initial);
    });
  });
});
