import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { storeProduct, storeProductCategory, storeProductAttrValue, storeProductRelation, outProductWriteReplay, storeProductCoupon, systemForm } from '@/models/schema';
import { createContainerFromDb, type DbClient } from '@/lib/di';
import { ProductAutoShelfService } from '@/services/product/ProductAutoShelfService';
import { runProductAutoShelf } from '@/migrations/runProductAutoShelf';
import { PRODUCT_AUTO_SHELF_SQL } from '@/migrations/productAutoShelf';
import { lockProductWrite } from '@/services/product/ProductAssociationService';
import { lockBargainSourceProductAdmission } from '@/services/activity/BargainSourceProductLifecycle';
import { stockFixture, seedStocks, stockSnapshot } from './helpers/adminProductStocks';
import { Hono } from 'hono';
import type { AppVariables } from '@/env';
import { productCreate, productInfo, productUpdate } from '@/controllers/out/OutApiController';
import { normalizeOutPhysicalProductInput } from '@/services/out/OutProductService';
import { outRequestHash } from '@/services/out/OutIdempotency';
import { createPcCheckoutQuoteFixture } from './helpers/pcCheckoutQuoteFixture';
import { sequenceRunnerDatabase, type SequenceRunnerPeer } from './helpers/kefuSequenceRunnerDatabase';
import { completePurchaseOriginEvidenceOrm } from '@/migrations/runPurchaseOriginEvidence';
import { completePurchaseCancellationEvidenceOrm } from '@/migrations/runPurchaseCancellationEvidence';
import { runtimeBusinessPrivilegePlan } from '@/migrations/runtimeBusinessPrivilegePlan';
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


describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('Out shelf schedule author and actual consumer on owned PG16', () => {
  let f: Awaited<ReturnType<typeof createPcCheckoutQuoteFixture>>;
  let owned: Awaited<ReturnType<typeof sequenceRunnerDatabase>>;
  let network: ReturnType<typeof vi.spyOn>;
  const body = { product_type: 0, supplier_id: 0, cate_id: [9], store_name: 'Out scheduled product',
    slider_image: ['/isolated.png'], delivery_type: [1], freight: 3, temp_id: 10, spec_type: 1, is_show: 1,
    items: [{ value: '颜色', detail: ['红色'] }, { value: '尺码', detail: ['大号'] }],
    attrs: [{ suk: '红色,大号', detail: { 颜色: '红色', 尺码: '大号' }, unique: 'qared001', price: '10.00', stock: 999, bar_code: 'OUT-A' }] };
  const app = (db: DbClient) => {
    const a = new Hono<{ Bindings: Env; Variables: AppVariables }>();
    a.use('*', async (c, next) => { c.set('container', createContainerFromDb(db));
      c.set('outInfo', { id: 7, appid: 'isolated-out-schedule', title: 'isolated', rules: [] }); await next(); });
    a.onError((e, c) => c.json({ status: 400, msg: e.message, data: null }));
    a.post('/outapi/product', productCreate); a.put('/outapi/product/:id', productUpdate); a.get('/outapi/product/:id', productInfo);
    return a;
  };
  beforeEach(async () => {
    network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Out schedule acceptance forbids external I/O'));
    f = await createPcCheckoutQuoteFixture([], async () => {
      owned = await sequenceRunnerDatabase();
      try { const api = await import('drizzle-kit/api'), schema = await import('@/models/schema');
        await owned.exec((await api.generateMigration(api.generateDrizzleJson({}), api.generateDrizzleJson(schema))).join('\n'));
        await completePurchaseOriginEvidenceOrm(owned.db); await completePurchaseCancellationEvidenceOrm(owned.db); return owned;
      } catch (error) { await owned.close(); throw error; }
    });
    await f.setConfig(Object.fromEntries(Object.keys(f.config).map(name => [name, '0'])));
    await f.db.insert(storeProductCategory).values({ id: 9, cateName: 'isolated', isShow: 1 });
    await f.db.update(storeProduct).set({ cateId: '9', specType: 1 }).where(eq(storeProduct.id, 70));
    await f.db.update(storeProductAttrValue).set({ barCode: 'OUT-A' }).where(eq(storeProductAttrValue.id, 1));
    await f.db.insert(storeProductRelation).values({ productId: 70, relationId: 9, type: 1, status: 1 });
  }, 120_000);
  afterEach(async () => { try { expect(network).not.toHaveBeenCalled(); } finally { network?.mockRestore(); await f?.close(); } }, 120_000);
  const request = async (db: DbClient, data?: object, key = crypto.randomUUID(), path = '/outapi/product/70', method = 'PUT') => {
    const response = await app(db).request(path, { method, headers: { 'content-type': 'application/json', 'Idempotency-Key': key },
      ...(data ? { body: JSON.stringify(data) } : {}) }, f.env);
    return response.json() as Promise<{ status: number; msg: string; data: { id: number; idempotent: boolean; stock_preserved: boolean } }>;
  };
  const state = async () => ({ ...await f.snapshot(), replays: await f.db.select().from(outProductWriteReplay),
    relations: await f.db.select().from(storeProductRelation), coupons: await f.db.select().from(storeProductCoupon), forms: await f.db.select().from(systemForm) });
  const worker = (db = f.db) => { const queue = { sendBatch: vi.fn() } as unknown as Env['ORDER_QUEUE'];
    return { service: new ProductAutoShelfService(createContainerFromDb(db), { ORDER_QUEUE: queue }), queue }; };
  const message = (at: number, productId = 70): ProductAutoShelfMessage => ({ action: 'processProductAutoShelf', job: 'product_auto_shelf',
    scheduledAt: at * 1000, runId: `scheduled:${at * 1000}`, productId });
  const peers = async (fn: (holder: SequenceRunnerPeer, writer: SequenceRunnerPeer) => Promise<void>) => {
    if (!owned.withPeer) throw Error('Distinct PG16 peers required'); await owned.withPeer(a => owned.withPeer!(b => fn(a, b)));
  };

  it('commits a scheduled hide, runs the real on/off consumer, and replays without undoing it', async () => {
    const now = Math.floor(Date.now() / 1000) - 2, key = crypto.randomUUID();
    const selected = { ...body, auto_on_time: now - 1, auto_off_time: 0 };
    const before = await state(), saved = await request(f.db, selected, key); expect(saved.status, saved.msg).toBe(200);
    let after = await state(); expect(after.products[0]).toMatchObject({ isShow: 0, autoOnTime: now - 1, autoOffTime: 0, stock: 8 });
    expect(after.carts[0].status).toBe(0); expect(after.relations[0].status).toBe(0);
    expect(after.skus.map(row => [row.id, row.unique, row.stock, row.sumStock, row.sales])).toEqual(before.skus.map(row => [row.id, row.unique, row.stock, row.sumStock, row.sales]));
    const read = await request(f.db, undefined, key, '/outapi/product/70', 'GET'); expect(read.status, read.msg).toBe(200);
    expect(read.data).toMatchObject({ auto_on_time: now - 1, auto_off_time: 0 });
    const { service, queue } = worker(); expect(await service.process(message(now))).toMatchObject({ isShow: 1, transitions: ['on'] });
    const postOn = await state(); expect(postOn.carts[0].status).toBe(0); expect(postOn.relations[0].status).toBe(0);
    const replay = await request(f.db, selected, key); expect(replay.status, replay.msg).toBe(200); expect(replay.data.idempotent).toBe(true); expect(await state()).toEqual(postOn);
    const off = await request(f.db, { ...body, auto_on_time: 0, auto_off_time: now - 1 }); expect(off.status, off.msg).toBe(200);
    expect(await service.process(message(now))).toMatchObject({ isShow: 0, transitions: ['off'] });
    after = await state(); expect(after.products[0]).toMatchObject({ isShow: 0, autoOnTime: 0, autoOffTime: now - 1 });
    expect(after.carts[0].status).toBe(1); expect(after.relations[0].status).toBe(1); expect(queue.sendBatch).not.toHaveBeenCalled();
  }, 30_000);

  it('preserves omitted plans, respects the prior manual-show rule, and rejects legacy zero-time receipts', async () => {
    await f.db.update(storeProduct).set({ autoOnTime: 100, autoOffTime: 200, isShow: 0 }).where(eq(storeProduct.id, 70));
    const omitted = await request(f.db, { ...body, is_show: 0 }); expect(omitted.status, omitted.msg).toBe(200);
    expect((await state()).products[0]).toMatchObject({ autoOnTime: 100, autoOffTime: 200, isShow: 0 });
    const shown = await request(f.db, body); expect(shown.status, shown.msg).toBe(200);
    expect((await state()).products[0]).toMatchObject({ autoOnTime: 100, autoOffTime: 0, isShow: 1 });
    await f.db.update(storeProduct).set({ autoOnTime: 100, autoOffTime: 200, isShow: 0 }).where(eq(storeProduct.id, 70));
    const input = { ...body, is_show: 0, auto_on_time: 0, auto_off_time: 0 }, old = normalizeOutPhysicalProductInput(input);
    delete old.scheduleIntentVersion;
    const key = crypto.randomUUID(), hash = await outRequestHash({ operation: 'product_update', productId: 70, input: old });
    await f.db.insert(outProductWriteReplay).values({ outAccountId: 7, operation: 'product_update', requestKey: key, requestHash: hash, productId: 70 });
    const before = await state(), conflict = await request(f.db, input, key); expect(conflict.status).not.toBe(200); expect(await state()).toEqual(before);
    const clear = await request(f.db, input); expect(clear.status, clear.msg).toBe(200);
    expect((await state()).products[0]).toMatchObject({ autoOnTime: 0, autoOffTime: 0, isShow: 0 });
  });

  it('creates a scheduled product in the same receipt and projects the live Shanghai wall time', async () => {
    await f.exec("SELECT setval(pg_get_serial_sequence('store_product','id'),70,true); SELECT setval(pg_get_serial_sequence('store_product_attr_value','id'),1,true)");
    const key = crypto.randomUUID(), data = { ...body, auto_on_time: '2026-10-17 16:00', auto_off_time: '2026-10-17T09:00:00Z',
      attrs: body.attrs.map(row => ({ ...row, unique: 'sched001', bar_code: 'SCHEDULE-NEW' })) };
    const created = await request(f.db, data, key, '/outapi/product', 'POST'); expect(created.status, created.msg).toBe(200);
    const [row] = await f.db.select().from(storeProduct).where(eq(storeProduct.id, created.data.id));
    expect(row).toMatchObject({ isShow: 0, autoOnTime: 1792224000, autoOffTime: 1792227600 });
    const detail = await request(f.db, undefined, key, `/outapi/product/${created.data.id}`, 'GET');
    expect(detail.status, detail.msg).toBe(200); expect(detail.data).toMatchObject({ auto_on_time: 1792224000, auto_off_time: 1792227600,
      productInfo: { auto_on_time: '2026-10-17 16:00:00', auto_off_time: '' } });
    const after = await state(), replay = await request(f.db, data, key, '/outapi/product', 'POST');
    expect(replay.status, replay.msg).toBe(200); expect(replay.data.idempotent).toBe(true); expect(await state()).toEqual(after);
  });

  it('rolls back receipt and business data when a deferred trigger changes or rewrites schedule state', async () => {
    const before = await state();
    for (const mutation of ['auto_on_time=123', 'auto_on_time=auto_on_time']) {
      await f.exec(`CREATE FUNCTION test_out_schedule_damage() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN UPDATE store_product SET ${mutation} WHERE id=70; RETURN NEW; END $$; CREATE CONSTRAINT TRIGGER test_out_schedule_damage AFTER INSERT ON out_product_write_replay DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION test_out_schedule_damage()`);
      for (const patch of [{}, { auto_on_time: 100, auto_off_time: 200 }]) {
        const result = await request(f.db, { ...body, ...patch }); expect(result.status).not.toBe(200); expect(result.msg).toContain('定时'); expect(await state()).toEqual(before);
      }
      await f.exec('DROP TRIGGER test_out_schedule_damage ON out_product_write_replay; DROP FUNCTION test_out_schedule_damage()');
    }
  });

  it('refuses a busy parent row rather than racing the real scheduler', async () => {
    const before = await state();
    await peers(async (holder, writer) => { await holder.exec('BEGIN; SELECT id FROM store_product WHERE id=70 FOR UPDATE');
      try { const result = await request(writer.db, { ...body, auto_on_time: 100 }); expect(result.status).not.toBe(200); expect(result.msg).toContain('正在变化'); }
      finally { await holder.exec('COMMIT'); }
    });
    expect(await state()).toEqual(before);
  }, 20_000);

  it('saves and reads an actual schedule using only existing restricted App privileges', async () => {
    if (!owned.withRuntimeRole) throw Error('Native restricted LOGIN required');
    await owned.withRuntimeRole(async runtime => {
      const plan = runtimeBusinessPrivilegePlan('app'), quote = (name: string) => {
        if (!/^[a-z_][a-z_0-9]*$/.test(name)) throw Error('Invalid owned grant identifier'); return `"${name}"`;
      };
      const tables = await f.db.execute<{ name: string }>(sql`SELECT relname AS name FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind='r' ORDER BY relname`);
      for (const { name } of tables) { const rights = plan.tables[name]; if (!rights) continue;
        await f.exec(`GRANT ${rights.join(',')} ON public.${quote(name)} TO ${quote(runtime.role)}`);
        const columns = plan.updateColumns[name]; if (columns?.length) await f.exec(`GRANT UPDATE(${columns.map(quote).join(',')}) ON public.${quote(name)} TO ${quote(runtime.role)}`);
      }
      const sequences = await f.db.execute<{ table_name: string; sequence_name: string | null }>(sql`SELECT c.relname AS table_name,
        pg_get_serial_sequence('public.'||quote_ident(c.relname),a.attname) AS sequence_name FROM pg_class c
        JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
        WHERE c.relnamespace='public'::regnamespace AND c.relkind='r'`);
      for (const row of sequences) if (row.sequence_name && plan.tables[row.table_name]?.includes('INSERT')) {
        const parts = row.sequence_name.split('.'); if (parts.length !== 2 || parts[0] !== 'public') throw Error('Unexpected owned sequence');
        await f.exec(`GRANT USAGE ON SEQUENCE public.${quote(parts[1])} TO ${quote(runtime.role)}`);
      }
      const result = await request(runtime.db, { ...body, auto_on_time: 100, auto_off_time: 200 });
      expect(result.status, result.msg).toBe(200);
      const read = await request(runtime.db, undefined, crypto.randomUUID(), '/outapi/product/70', 'GET');
      expect(read.status, read.msg).toBe(200); expect(read.data).toMatchObject({ auto_on_time: 100, auto_off_time: 200 });
    });
  }, 30_000);
});
