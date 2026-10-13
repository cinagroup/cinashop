import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DbClient } from '../src/lib/di';
import { createContainerFromDb } from '../src/lib/di';
import { storeProduct, storeProductRelation, shippingTemplates, systemForm, systemRole, systemLog, systemAdmin } from '../src/models/schema';
import { SupplierProductBatchService } from '../src/services/supplier/SupplierProductBatchService';
import { SupplierProductCategoryService, lockSupplierCategoryScope } from '../src/services/supplier/SupplierProductCategoryService';
import { retireShippingTemplate } from '../src/services/product/ShippingTemplateLifecycleService';
import { SystemMetadataService } from '../src/services/system/SystemMetadataService';
import { financePostgres } from './helpers/financePostgres';
import { outcome, waitForFinanceBlock, withFinancePeers } from './helpers/financePeers';
import { seedSupplierBatch, supplierBatchTables, supplierBatchActor } from './helpers/supplierProductBatchFixture';

const batch = (db: DbClient) => new SupplierProductBatchService(createContainerFromDb(db));
const category = (db: DbClient) => new SupplierProductCategoryService(createContainerFromDb(db));
const form = (db: DbClient) => new SystemMetadataService(createContainerFromDb(db));
const body = (type: number, data: unknown, ids = [1]) => ({ type, ids, all: 0, data });
function signal() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function readyOrFailure(ready: ReturnType<typeof signal>, held: Promise<{ ok: boolean; error?: unknown }>) {
  await Promise.race([ready.promise, held.then(result => { if (!result.ok) throw result.error; })]);
}
describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('Supplier batch native PG16 scope, reference and authority protocol', () => {
  let f: Awaited<ReturnType<typeof financePostgres>>;
  beforeAll(async () => { f = await financePostgres(supplierBatchTables); }, 60000);
  afterAll(async () => { await f?.close(); }, 30000);
  beforeEach(async () => { vi.stubGlobal('fetch', vi.fn(async () => { throw Error('External I/O forbidden'); })); await seedSupplierBatch(f); });
  afterEach(() => { expect(fetch).not.toHaveBeenCalled(); vi.unstubAllGlobals(); });
  it('waits for an actual category move then binds the committed parent path', async () => {
    await withFinancePeers(f.db, async ([moving, writing]) => {
      const ready = signal(), release = signal();
      const held = outcome(moving.db.transaction(async tx => { await category(tx as unknown as DbClient).save(20, 101,
        { cate_name: 'child', pid: 110, is_show: 1 }, supplierBatchActor()); ready.resolve(); await release.promise; }));
      await readyOrFailure(ready, held);
      const applied = outcome(batch(writing.db).apply(20, body(1, { cate_id: [101] }), supplierBatchActor()));
      try { await waitForFinanceBlock(f.db, writing.pid, moving.pid); } finally { release.resolve(); }
      expect((await held).ok).toBe(true); expect((await applied).ok).toBe(true);
      expect((await f.db.select().from(storeProductRelation).where(eq(storeProductRelation.productId, 1))).find(row => row.type === 1)).toMatchObject({ relationId: 101, relationPid: 110 });
    });
  });
  it('commits the real batch binding before category deletion rejects its new reference', async () => {
    await withFinancePeers(f.db, async ([writing, deleting]) => {
      const ready = signal(), release = signal();
      const held = outcome(writing.db.transaction(async tx => { await batch(tx as unknown as DbClient).apply(20,
        body(1, { cate_id: [110] }), supplierBatchActor()); ready.resolve(); await release.promise; }));
      await readyOrFailure(ready, held);
      const deleted = outcome(category(deleting.db).delete(20, 110, undefined, supplierBatchActor()));
      try { await waitForFinanceBlock(f.db, deleting.pid, writing.pid); } finally { release.resolve(); }
      expect((await held).ok).toBe(true); expect(await deleted).toMatchObject({ ok: false, error: { code: 400 } });
    });
  });
  it('commits category deletion first and rolls back the later whole batch', async () => {
    await withFinancePeers(f.db, async ([deleting, writing]) => {
      const ready = signal(), release = signal();
      const held = outcome(deleting.db.transaction(async tx => { await category(tx as unknown as DbClient).delete(20, 110,
        undefined, supplierBatchActor()); ready.resolve(); await release.promise; }));
      await readyOrFailure(ready, held);
      const applied = outcome(batch(writing.db).apply(20, body(1, { cate_id: [110] }, [1, 2]), supplierBatchActor()));
      try { await waitForFinanceBlock(f.db, writing.pid, deleting.pid); } finally { release.resolve(); }
      expect((await held).ok).toBe(true); expect(await applied).toMatchObject({ ok: false, error: { code: 400 } });
      expect((await f.db.select().from(storeProduct).where(eq(storeProduct.id, 1)))[0].cateId).toBe('101');
    });
  });
  it('does not hold a global Supplier scope while another Supplier completes a real batch', async () => {
    await withFinancePeers(f.db, async ([holding, writing]) => {
      const ready = signal(), release = signal();
      const held = outcome(holding.db.transaction(async tx => { await lockSupplierCategoryScope(tx as unknown as DbClient, 20); ready.resolve(); await release.promise; }));
      await readyOrFailure(ready, held);
      try { expect((await batch(writing.db).apply(30, body(3, { delivery_type: [2] }, [7]),
        { ...supplierBatchActor(), id: 31 })).verified).toBe(true); } finally { release.resolve(); }
      expect((await held).ok).toBe(true);
    });
  });
  it('refuses a busy actual shipping parent without waiting backwards or binding it', async () => {
    await withFinancePeers(f.db, async ([editing, writing]) => {
      const ready = signal(), release = signal();
      const held = outcome(editing.db.transaction(async tx => { await tx.select().from(shippingTemplates)
        .where(eq(shippingTemplates.id, 60)).for('update'); ready.resolve(); await release.promise; }));
      await readyOrFailure(ready, held);
      try { expect(await outcome(batch(writing.db).apply(20, body(8, { freight: 3, temp_id: 60 }), supplierBatchActor())))
        .toMatchObject({ ok: false, error: { code: 400 } }); } finally { release.resolve(); }
      expect((await held).ok).toBe(true); expect((await f.db.select().from(storeProduct).where(eq(storeProduct.id, 1)))[0].tempId).toBe(0);
    });
  });
  it('pins the shipping parent to commit and actual template retirement then refuses the new binding', async () => {
    await withFinancePeers(f.db, async ([writing, deleting]) => {
      const ready = signal(), release = signal();
      const held = outcome(writing.db.transaction(async tx => { await batch(tx as unknown as DbClient).apply(20,
        body(8, { freight: 3, temp_id: 60 }), supplierBatchActor()); ready.resolve(); await release.promise; }));
      await readyOrFailure(ready, held);
      const removed = outcome(retireShippingTemplate(createContainerFromDb(deleting.db), 60, 20));
      try { await waitForFinanceBlock(f.db, deleting.pid, writing.pid); } finally { release.resolve(); }
      expect((await held).ok).toBe(true); expect(await removed).toMatchObject({ ok: false, error: { code: 400 } });
    });
  });
  it('pins and parses the active form to commit and actual form disabling refuses the new binding', async () => {
    await withFinancePeers(f.db, async ([writing, disabling]) => {
      const ready = signal(), release = signal();
      const held = outcome(writing.db.transaction(async tx => { await batch(tx as unknown as DbClient).apply(20,
        body(7, { system_form_id: 50 }), supplierBatchActor()); ready.resolve(); await release.promise; }));
      await readyOrFailure(ready, held);
      const disabled = outcome(form(disabling.db).setFormStatus(50, 0, { id: 99, name: 'fixture-admin', ip: '', method: 'PUT' }));
      try { await waitForFinanceBlock(f.db, disabling.pid, writing.pid); } finally { release.resolve(); }
      expect((await held).ok).toBe(true); expect(await disabled).toMatchObject({ ok: false, error: { code: 400 } });
      expect((await f.db.select().from(systemForm).where(eq(systemForm.id, 50)))[0].status).toBe(1);
    });
  });
  it('fails closed while a quote-side product SHARE lock is held and never changes its shipping facts', async () => {
    await withFinancePeers(f.db, async ([quoting, writing]) => {
      const ready = signal(), release = signal();
      const held = outcome(quoting.db.transaction(async tx => { const [product] = await tx.select().from(storeProduct)
        .where(eq(storeProduct.id, 1)).for('share'); expect(product.freight).toBe(1); ready.resolve(); await release.promise; }));
      await readyOrFailure(ready, held);
      try { expect(await outcome(batch(writing.db).apply(20, body(8, { freight: 2, postage: '2.00' }), supplierBatchActor())))
        .toMatchObject({ ok: false, error: { code: 409 } }); } finally { release.resolve(); }
      expect((await held).ok).toBe(true); expect(await f.db.select().from(systemLog)).toEqual([]);
    });
  });
  it('holds current role authority until the actual batch commit, then the revoked next write fails', async () => {
    await withFinancePeers(f.db, async ([writing, revoking]) => {
      const ready = signal(), release = signal();
      const held = outcome(writing.db.transaction(async tx => { await batch(tx as unknown as DbClient).apply(20,
        body(3, { delivery_type: [2] }), supplierBatchActor()); ready.resolve(); await release.promise; }));
      await readyOrFailure(ready, held);
      const revoked = outcome(revoking.db.update(systemRole).set({ status: 0 }).where(eq(systemRole.id, 21)));
      try { await waitForFinanceBlock(f.db, revoking.pid, writing.pid); } finally { release.resolve(); }
      expect((await held).ok).toBe(true); expect((await revoked).ok).toBe(true);
      await expect(batch(f.db).apply(20, body(3, { delivery_type: [1] }), supplierBatchActor())).rejects.toMatchObject({ code: 400011 });
    });
  });
  it('recovery reads wait for the in-flight batch commit and return its fresh facts', async () => {
    await withFinancePeers(f.db, async ([writing, reading]) => {
      const ready = signal(), release = signal();
      const held = outcome(writing.db.transaction(async tx => { await batch(tx as unknown as DbClient).apply(20,
        body(3, { delivery_type: [2] }), supplierBatchActor()); ready.resolve(); await release.promise; }));
      await readyOrFailure(ready, held);
      const recovered = outcome(batch(reading.db).selection(20, { ids: [1], all: 0 }, supplierBatchActor()));
      try { await waitForFinanceBlock(f.db, reading.pid, writing.pid); } finally { release.resolve(); }
      expect((await held).ok).toBe(true); expect(await recovered).toMatchObject({ ok: true, value: { products: [{ id: 1, delivery_type: '2' }] } });
    });
  });
  it('rejects a password rotated while the claims wait outside the Supplier scope', async () => {
    await withFinancePeers(f.db, async ([holding, writing, rotating]) => {
      const ready = signal(), release = signal(), actor = supplierBatchActor();
      const held = outcome(holding.db.transaction(async tx => { await lockSupplierCategoryScope(tx as unknown as DbClient, 20); ready.resolve(); await release.promise; }));
      await readyOrFailure(ready, held);
      const applied = outcome(batch(writing.db).apply(20, body(3, { delivery_type: [2] }), actor));
      try { await waitForFinanceBlock(f.db, writing.pid, holding.pid); await rotating.db.update(systemAdmin).set({ pwd: 'rotated' }).where(eq(systemAdmin.id, 21)); }
      finally { release.resolve(); }
      expect((await held).ok).toBe(true); expect(await applied).toMatchObject({ ok: false, error: { code: 410001 } });
      expect(await f.db.select().from(systemLog)).toEqual([]);
    });
  });
});
