import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { financePostgres } from './helpers/financePostgres';
import { createBargainSelectionFixture } from './helpers/bargainSelectionFixture';
import { withFinancePeers } from './helpers/financePeers';
import { createContainerFromDb } from '../src/lib/di';
import { saveBargain } from '../src/services/activity/BargainAdminService';
import { adminActivitySave } from '../src/controllers/api/v1/AdminCrudController';
import { PRODUCT_SKU_IDENTITY_LOCK_NAMESPACE, PRODUCT_SKU_IDENTITY_LOCK_KEY } from '../src/services/product/ProductSkuIdentity';

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('finance fixture database-level advisory isolation', () => {
  const body = (f: Awaited<ReturnType<typeof createBargainSelectionFixture>>) => ({
    type: 'bargain', productId: 70, storeName: 'independent fixture creation', price: '10', minPrice: '2.5',
    stock: 6, quota: 5, people: 3, num: 2, status: 0, sku: { baseUnique: 'qared001' },
    startTime: f.startTime.toISOString(), stopTime: f.stopTime.toISOString(),
  });

  it('an unrelated fixture holding the real SKU identity lock cannot break positive admin creation', async () => {
    const unrelated = await financePostgres([]);
    const f = await createBargainSelectionFixture().catch(async error => { await unrelated.close(); throw error; });
    try {
      f.app.post('/admin/save', adminActivitySave);
      await unrelated.db.transaction(async tx => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(${PRODUCT_SKU_IDENTITY_LOCK_NAMESPACE},${PRODUCT_SKU_IDENTITY_LOCK_KEY})`);
        const [holder] = Array.from(await tx.execute(sql`SELECT pg_backend_pid() AS pid,current_database() AS database,current_schema() AS schema`));
        const [editor] = Array.from(await f.db.execute(sql`SELECT pg_backend_pid() AS pid,current_database() AS database,current_schema() AS schema`));
        expect(editor.pid).not.toBe(holder.pid);
        expect(editor.schema).not.toBe(holder.schema);
        const locks = Array.from(await tx.execute(sql`SELECT granted FROM pg_locks WHERE pid=pg_backend_pid()
          AND locktype='advisory' AND classid=${PRODUCT_SKU_IDENTITY_LOCK_NAMESPACE}::oid AND objid=${PRODUCT_SKU_IDENTITY_LOCK_KEY}::oid AND objsubid=2`));
        expect(locks).toEqual([{ granted: true }]);
        const response = await f.app.request('/admin/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body(f)) }, f.env);
        const result = await response.json();
        expect(result, JSON.stringify(result)).toMatchObject({ status: 200 });
        expect(editor.database).not.toBe(holder.database);
      });
      expect((await f.snapshot()).bargains).toHaveLength(2);
    } finally { await f.close(); await unrelated.close(); }
  }, 30000);

  it('same-fixture independent peers still reject the real lock conflict and recover after release', async () => {
    const f = await createBargainSelectionFixture();
    try {
      const snapshot = async () => ({ ...await f.snapshot(), sequences: undefined });
      const before = await snapshot();
      await withFinancePeers(f.db, async ([holder, editor]) => {
        await holder.exec(`BEGIN; SELECT pg_advisory_xact_lock(${PRODUCT_SKU_IDENTITY_LOCK_NAMESPACE},${PRODUCT_SKU_IDENTITY_LOCK_KEY})`);
        const start = performance.now();
        await expect(saveBargain(createContainerFromDb(editor.db), body(f))).rejects.toThrow('商品规格正在更新，请稍后重试');
        expect(performance.now() - start).toBeLessThan(1500);
        expect(await snapshot()).toEqual(before);
        await holder.exec('ROLLBACK');
        await expect(saveBargain(createContainerFromDb(editor.db), body(f))).resolves.toBeGreaterThan(0);
      });
    } finally { await f.close(); }
  }, 30000);
});
