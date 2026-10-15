import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { storeProduct } from '@/models/schema';
import { createContainerFromDb, type DbClient } from '@/lib/di';
import { ProductAutoShelfService } from '@/services/product/ProductAutoShelfService';
import { runProductAutoShelf } from '@/migrations/runProductAutoShelf';
import { PRODUCT_AUTO_SHELF_SQL } from '@/migrations/productAutoShelf';
import { lockProductWrite } from '@/services/product/ProductAssociationService';
import { lockBargainSourceProductAdmission } from '@/services/activity/BargainSourceProductLifecycle';
import { stockFixture, seedStocks, stockSnapshot } from './helpers/adminProductStocks';
import { outcome, waitForFinanceBlock, withFinancePeers } from './helpers/financePeers';
import type { Env, ProductAutoShelfMessage } from '@/env';
const on = 'sp_auto_on_due_idx', off = 'sp_auto_off_due_idx';
function signal() { let resolve!: () => void; return { promise: new Promise<void>(done => { resolve = done; }), resolve: () => resolve() }; }
function messages(error: unknown): string { return error instanceof Error ? `${error.message} ${messages(error.cause)}` : String(error); }

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('PG16 explicit shelf index upgrade and independent scheduler transaction boundaries', () => {
  let f: Awaited<ReturnType<typeof stockFixture>>;
  beforeAll(async () => { f = await stockFixture(); }, 30000);
  beforeEach(async () => { await f.reset(); await seedStocks(f.db); await f.exec(`DROP INDEX IF EXISTS ${on}; DROP INDEX IF EXISTS ${off}`); });
  afterAll(async () => { await f?.close(); });
  const catalog = () => f.db.select({ id: sql<string>`c.oid::text`, name: sql<string>`c.relname`, file: sql<string>`c.relfilenode::text`, definition: sql<string>`pg_get_indexdef(c.oid)` })
    .from(sql`pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace`).where(sql`n.nspname='public' AND c.relname IN (${on},${off})`).orderBy(sql`c.relname`);
  it('installs the exact external indexes, repeats without replacing OIDs, and accepts actual ORM predicates without any business/sequence mutation', async () => {
    const before = await stockSnapshot(f.db), sequence = await f.exec('SELECT last_value,is_called FROM store_product_id_seq');
    await runProductAutoShelf(f.db); const installed = await catalog(); expect(installed).toHaveLength(2);
    await runProductAutoShelf(f.db); expect(await catalog()).toEqual(installed);
    await f.exec(`DROP INDEX ${on}; DROP INDEX ${off}`);
    for (const { config } of getTableConfig(storeProduct).indexes.filter(row => [on,off].includes(row.config.name!))) {
      expect(config.unique).toBe(false); expect(config.columns.map(column => 'name' in column ? column.name : null)).toEqual([config.name === on ? 'auto_on_time' : 'auto_off_time','id']);
      await f.db.execute(sql`CREATE INDEX ${sql.identifier(config.name!)} ON public.store_product (${sql.identifier(config.name === on ? 'auto_on_time' : 'auto_off_time')},id) WHERE ${config.where!}`);
    }
    const orm = await catalog(); await runProductAutoShelf(f.db); expect(await catalog()).toEqual(orm);
    expect(await stockSnapshot(f.db)).toEqual(before); expect(await f.exec('SELECT last_value,is_called FROM store_product_id_seq')).toEqual(sequence);
  });
  it('refuses wrong existing index predicates and rolls back an earlier new index without repairing the conflicting object', async () => {
    await f.exec(`CREATE INDEX ${off} ON store_product(auto_off_time,id) WHERE is_del=0 AND is_show=1`);
    const before = await catalog(), rows = await stockSnapshot(f.db);
    const failed = await outcome(runProductAutoShelf(f.db)); expect(failed.ok).toBe(false); if (!failed.ok) expect(messages(failed.error)).toContain('index drift');
    expect(await catalog()).toEqual(before); expect(await stockSnapshot(f.db)).toEqual(rows);
  });
  it('fails bounded maintenance admission on a concurrent writer, preserves stricter caller budgets and restores all transaction-local settings', async () => {
    await withFinancePeers(f.db, async ([writer, maintainer]) => {
      const held = signal(), release = signal();
      const holding = writer.db.transaction(async tx => { await tx.update(storeProduct).set({ sort: 8 }).where(eq(storeProduct.id,10)); held.resolve(); await release.promise; });
      try {
        await held.promise; const result = await outcome(runProductAutoShelf(maintainer.db)); expect(result.ok).toBe(false);
        if (!result.ok) expect(messages(result.error)).toMatch(/lock|55P03/);
        expect(await catalog()).toEqual([]);
      } finally { release.resolve(); await holding; }
      await maintainer.db.transaction(async tx => {
        await tx.execute(sql`SET LOCAL statement_timeout='900ms'`); await tx.execute(sql`SET LOCAL lock_timeout='700ms'`); await tx.execute(sql`SET LOCAL idle_in_transaction_session_timeout='800ms'`);
        const probe = () => tx.execute(sql`SELECT current_setting('statement_timeout') s,current_setting('lock_timeout') l,current_setting('idle_in_transaction_session_timeout') i`);
        const initial = await probe(); await tx.execute(sql.raw(PRODUCT_AUTO_SHELF_SQL)); expect(await probe()).toEqual(initial);
      });
      expect(await catalog()).toHaveLength(2);
    });
  });
  it('serializes with bargain admission before the product row, retries row/fence conflicts and rechecks amended schedules after waiting', async () => {
    const now = Math.floor(Date.now()/1000)-5;
    const work: ProductAutoShelfMessage = { action:'processProductAutoShelf',job:'product_auto_shelf',runId:`scheduled:${now*1000}`,scheduledAt:now*1000,productId:10 };
    const queue = { sendBatch: vi.fn() } as unknown as Env['ORDER_QUEUE'];
    await f.db.update(storeProduct).set({isShow:0,autoOnTime:now-1}).where(eq(storeProduct.id,10));
    await withFinancePeers(f.db, async ([holder,worker]) => {
      const service = new ProductAutoShelfService(createContainerFromDb(worker.db), { ORDER_QUEUE:queue });
      for (const kind of ['fence','row']) {
        const held=signal(), release=signal();
        const holding=holder.db.transaction(async tx=>{ if(kind==='fence') await lockProductWrite(tx as unknown as DbClient,10); else await tx.select().from(storeProduct).where(eq(storeProduct.id,10)).for('update'); held.resolve(); await release.promise; });
        try { await held.promise; const before=await stockSnapshot(f.db); expect((await outcome(service.process(work))).ok).toBe(false); expect(await stockSnapshot(f.db)).toEqual(before); }
        finally { release.resolve(); await holding; }
      }
      const held=signal(), release=signal();
      const holding=holder.db.transaction(async tx=>{ await lockBargainSourceProductAdmission(tx as unknown as DbClient,10); held.resolve(); await release.promise; await tx.update(storeProduct).set({autoOnTime:now+100}).where(eq(storeProduct.id,10)); });
      try {
        await held.promise; const pending=outcome(service.process(work)); await waitForFinanceBlock(f.db,worker.pid,holder.pid);
        release.resolve(); await holding; expect(await pending).toMatchObject({ok:true,value:{reason:'no_longer_eligible'}});
      } finally { release.resolve(); await holding; }
      await f.db.update(storeProduct).set({autoOnTime:now-1}).where(eq(storeProduct.id,10));
      expect(await service.process(work)).toMatchObject({isShow:1,transitions:['on']}); const after=await stockSnapshot(f.db);
      await service.process(work); expect(await stockSnapshot(f.db)).toEqual(after); expect(queue.sendBatch).not.toHaveBeenCalled();
    });
  });
});
