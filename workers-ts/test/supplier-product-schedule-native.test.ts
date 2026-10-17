import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createApp } from '@/app';
import { createContainerFromDb, withTx, type Container } from '@/lib/di';
import { storeProduct, systemAdmin, systemRole } from '@/models/schema';
import { SupplierProductManagementService } from '@/services/supplier/SupplierProductManagementService';
import { ProductAutoShelfService } from '@/services/product/ProductAutoShelfService';
import { lockProductWrite } from '@/services/product/ProductAssociationService';
import type { Env, ProductAutoShelfMessage, OrderMessage } from '@/env';
import { supplierProductScheduleActor, supplierProductScheduleFixture } from './helpers/supplierProductSchedule';
import { outcome, waitForFinanceBlock } from './helpers/financePeers';

const wiring = vi.hoisted(() => ({ container: null as Container | null }));
vi.mock('@/lib/di', async original => ({ ...await original<typeof import('@/lib/di')>(), createContainer: () => wiring.container }));
const app = createApp();
function signal() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('Supplier schedule author save reread and mature Queue consumer on independent PG16 LOGINs', () => {
  let f: Awaited<ReturnType<typeof supplierProductScheduleFixture>>;
  beforeEach(async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Owned schedule evidence forbids outbound I/O'));
    f = await supplierProductScheduleFixture(); wiring.container = f.container;
  }, 30000);
  afterEach(async () => { try { expect(fetch).not.toHaveBeenCalled(); } finally { await f?.close(); vi.restoreAllMocks(); wiring.container = null; } }, 30000);
  async function request(method: string, path: string, body?: unknown, actor: keyof typeof f.tokens | 'anonymous' = 'manager') {
    const response = await app.request('/supplierapi' + path, { method, headers: {
      ...(actor === 'anonymous' ? {} : { Authorization: 'Bearer ' + f.tokens[actor] }),
      'X-Supplier-Id': '8', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, f.env);
    expect(response.headers.get('cache-control')).toContain('private, no-store');
    return response.json<{ status: number; msg: string; data: any }>();
  }
  const root = async (id = 80) => (await f.db.select().from(storeProduct).where(eq(storeProduct.id, id)))[0];
  const message = (id = 80): ProductAutoShelfMessage => {
    const scheduledAt = (Math.floor(Date.now() / 1000) - 1) * 1000;
    return { action: 'processProductAutoShelf', job: 'product_auto_shelf', runId: `scheduled:${scheduledAt}`, scheduledAt, productId: id };
  };
  async function unchanged(work: () => Promise<unknown>) {
    const before = await f.snapshot(), sequences = await f.sequences(); const result = await work();
    expect(await f.snapshot()).toEqual(before); expect(await f.sequences()).toEqual(sequences); return result;
  }

  it('rereads actual epoch plans with a pure SELECT viewer and no table or sequence change', async () => f.withReader(async runtime => {
    wiring.container = runtime.container;
    await unchanged(async () => {
      const value = await request('GET', '/product/product/80', undefined, 'viewer');
      expect(value.status).toBe(200); expect(value.data).toMatchObject({ auto_on_time: f.initialOn, auto_off_time: f.initialOff });
    });
    const [rights] = await runtime.db.execute(sql`SELECT NOT EXISTS(SELECT 1 FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind='r'
      AND (has_table_privilege(current_user,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR has_any_column_privilege(current_user,c.oid,'INSERT,UPDATE,REFERENCES')))
      AND NOT EXISTS(SELECT 1 FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind='S' AND has_sequence_privilege(current_user,c.oid,'USAGE,SELECT,UPDATE')) AS pure`);
    expect(rights.pure).toBe(true);
  }));

  it('saves future on and off times through the real App without granting approval or mutating unrelated tables', async () => f.withWriter(async runtime => {
    wiring.container = runtime.container; const before = await f.snapshot();
    const on = f.initialOn + 100, off = f.initialOff + 100;
    const value = await request('POST', '/product/product/80', f.body({ auto_on_time: on, auto_off_time: off, is_show: 1, is_verify: 1 }));
    expect(value.status).toBe(200); expect(value.data).toMatchObject({ id: 80, is_show: 0, is_verify: 0 });
    expect(await root()).toMatchObject({ autoOnTime: on, autoOffTime: off, isShow: 0, isVerify: 0, type: 2, relationId: 7 });
    const after = await f.snapshot();
    for (const name of Object.keys(before)) if (!['store_product', 'store_product_attr', 'store_product_attr_result', 'store_product_relation'].includes(name)) expect(after[name], name).toEqual(before[name]);
    expect((await request('GET', '/product/product/80')).data).toMatchObject({ auto_on_time: on, auto_off_time: off });
  }));

  it('keeps omitted plans, changes one provided field, and cancels PHP empty-string or explicit-zero plans', async () => f.withWriter(async runtime => {
    wiring.container = runtime.container;
    expect((await request('POST', '/product/product/80', f.body())).status).toBe(200);
    expect(await root()).toMatchObject({ autoOnTime: f.initialOn, autoOffTime: f.initialOff });
    expect((await request('POST', '/product/product/80', f.body({ auto_on_time: 123 }))).status).toBe(200);
    expect(await root()).toMatchObject({ autoOnTime: 123, autoOffTime: f.initialOff });
    expect((await request('POST', '/product/product/80', f.body({ auto_on_time: '', auto_off_time: 0 }))).status).toBe(200);
    expect(await root()).toMatchObject({ autoOnTime: 0, autoOffTime: 0 });
  }));

  it('creates ordinary products with omitted zero defaults and explicit Shanghai plans on both real save paths', async () => f.withWriter(async runtime => {
    wiring.container = runtime.container;
    const ordinary = await request('POST', '/product/product', f.body()); expect(ordinary.status).toBe(200);
    expect(await root(ordinary.data.id)).toMatchObject({ autoOnTime: 0, autoOffTime: 0, isShow: 0, isVerify: 0 });
    const scheduled = await request('POST', '/product/product/0', f.body({ auto_on_time: '2026-10-17 16:00', auto_off_time: '2026-10-17T09:00:00Z' }));
    expect(scheduled.status).toBe(200); expect(await root(scheduled.data.id)).toMatchObject({ autoOnTime: 1792224000, autoOffTime: 1792227600, isShow: 0, isVerify: 0 });
  }));

  it('rejects invalid schedule wires before any business or sequence write', async () => f.withWriter(async runtime => {
    wiring.container = runtime.container;
    await unchanged(async () => {
      for (const time of [null, true, -1, 2147483648, '0', '2026-02-29 12:00', '2026-10-17T08:00:00']) {
        expect((await request('POST', '/product/product/80', f.body({ auto_on_time: time }))).status).toBe(400);
      }
    });
  }));

  it('rejects view-only denied foreign and anonymous writes using JWT-derived ownership', async () => f.withWriter(async runtime => {
    wiring.container = runtime.container;
    await unchanged(async () => {
      const body = f.body({ auto_on_time: 123, supplier_id: 8, relation_id: 8 });
      expect((await request('POST', '/product/product/80', body, 'viewer')).status).toBe(400011);
      expect((await request('POST', '/product/product/80', body, 'denied')).status).toBe(400011);
      expect((await request('POST', '/product/product/80', body, 'other')).status).toBe(404);
      expect((await request('POST', '/product/product/80', body, 'anonymous')).status).toBe(410000);
    });
  }));

  it('rechecks committed role password and expiry inside the schedule write transaction', async () => f.withWriter(async runtime => {
    const service = new SupplierProductManagementService(runtime.container, f.env), input = f.body({ auto_on_time: 123 });
    await unchanged(async () => { await expect(service.saveProduct(7, 80, input, { ...supplierProductScheduleActor(), expiresAt: 1 })).rejects.toThrow(); });
    await f.db.update(systemRole).set({ rules: 'supplier.product.view' }).where(eq(systemRole.id, 21));
    await unchanged(async () => { await expect(service.saveProduct(7, 80, input, supplierProductScheduleActor())).rejects.toThrow(); });
    await f.db.update(systemRole).set({ rules: 'supplier.product.view,supplier.product.manage' }).where(eq(systemRole.id, 21));
    await f.db.update(systemAdmin).set({ pwd: 'changed-owned-password' }).where(eq(systemAdmin.id, 21));
    await unchanged(async () => { await expect(service.saveProduct(7, 80, input, supplierProductScheduleActor())).rejects.toThrow(); });
  }));

  it('fails NOWAIT on an actual in-flight authority change and succeeds only after rollback', async () => f.withWriter(async runtime => f.withPeer!(async owner => {
    wiring.container = runtime.container; const held = signal(), release = signal();
    const holding = withTx(createContainerFromDb(owner.db), async tx => { await tx.update(systemRole).set({ rules: 'supplier.product.view' }).where(eq(systemRole.id, 21)); held.resolve(); await release.promise; throw Error('rollback owned authority'); }).catch(error => { if (error.message !== 'rollback owned authority') throw error; });
    try { await held.promise; await unchanged(async () => { expect((await request('POST', '/product/product/80', f.body({ auto_on_time: 123 }))).status).toBe(409); }); }
    finally { release.resolve(); await holding; }
    expect((await request('POST', '/product/product/80', f.body({ auto_on_time: 123 }))).status).toBe(200);
  })));

  it('uses the existing product fence so an actual timer or editor owner cannot race an explicit plan', async () => f.withWriter(async runtime => f.withPeer!(async owner => {
    wiring.container = runtime.container; const held = signal(), release = signal();
    const holding = withTx(createContainerFromDb(owner.db), async tx => { await lockProductWrite(tx, 80); held.resolve(); await release.promise; });
    try { await held.promise; await unchanged(async () => { expect((await request('POST', '/product/product/80', f.body({ auto_on_time: 123 }))).status).toBe(409); }); }
    finally { release.resolve(); await holding; }
  })));

  it('does not overwrite a separately committed Admin plan while an old omitted-field save waits on the actual product row', async () => f.withWriter(async runtime => f.withPeer!(async owner => {
    const held = signal(), release = signal(), replacement = f.initialOn + 777;
    const holding = withTx(createContainerFromDb(owner.db), async tx => { await tx.update(storeProduct).set({ autoOnTime: replacement, autoOffTime: replacement + 100 }).where(eq(storeProduct.id, 80)); held.resolve(); await release.promise; });
    let saving: ReturnType<typeof outcome<{ id: number; is_verify: number; is_show: number }>> | undefined;
    try {
      await held.promise;
      saving = outcome(new SupplierProductManagementService(runtime.container, f.env).saveProduct(7, 80, f.body()));
      await waitForFinanceBlock(f.db, runtime.pid, owner.pid); release.resolve(); await holding;
      expect(await saving).toMatchObject({ ok: true, value: { id: 80 } });
      expect(await root()).toMatchObject({ autoOnTime: replacement, autoOffTime: replacement + 100, isVerify: 0 });
    } finally { release.resolve(); await holding; await saving; }
  })));

  it('lets the unchanged live Queue consumer turn a due plan on while keeping review pending and every other row unchanged', async () => {
    await f.withWriter(async runtime => { wiring.container = runtime.container; expect((await request('POST', '/product/product/80', f.body({ auto_on_time: 123, auto_off_time: 0 }))).status).toBe(200); });
    await f.withScheduler(async runtime => {
      const before = await f.snapshot(), sequences = await f.sequences();
      const queue = { sendBatch: vi.fn() }, service = new ProductAutoShelfService(runtime.container, { ORDER_QUEUE: queue as unknown as Env['ORDER_QUEUE'] });
      const value = await service.process(message()); expect(value).toMatchObject({ productId: 80, isShow: 1, transitions: ['on'] });
      expect(await root()).toMatchObject({ isShow: 1, isVerify: 0, autoOnTime: 123, autoOffTime: 0 });
      const after = await f.snapshot();
      for (const key of Object.keys(before)) expect(after[key], key).toEqual(key === 'store_product' ? before[key].map((entry: { row: Record<string, unknown> }) => ({ ...entry, row: entry.row.id === 80 ? { ...entry.row, is_show: 1 } : entry.row })) : before[key]);
      expect(await f.sequences()).toEqual(sequences); expect(queue.sendBatch).not.toHaveBeenCalled();
    });
  });

  it('accepts equal already-due times and preserves the mature on-then-off ordering without automatic approval', async () => {
    await f.withWriter(async runtime => { wiring.container = runtime.container; expect((await request('POST', '/product/product/80', f.body({ auto_on_time: 123, auto_off_time: 123 }))).status).toBe(200); });
    await f.withScheduler(async runtime => {
      const queue = { sendBatch: vi.fn() }, service = new ProductAutoShelfService(runtime.container, { ORDER_QUEUE: queue as unknown as Env['ORDER_QUEUE'] });
      expect(await service.process(message())).toMatchObject({ isShow: 0, transitions: ['on', 'off'] });
      expect(await root()).toMatchObject({ isVerify: 0, autoOnTime: 123, autoOffTime: 123 });
    });
  });

  it('rereads cancellation when stale work is delivered and excludes cancelled plans from actual Queue scans', async () => {
    await f.withWriter(async runtime => { wiring.container = runtime.container; expect((await request('POST', '/product/product/80', f.body({ auto_on_time: 123, auto_off_time: 0 }))).status).toBe(200);
      expect((await request('POST', '/product/product/80', f.body({ auto_on_time: 0 }))).status).toBe(200); });
    await f.withScheduler(async runtime => {
      const sent: OrderMessage[] = [], queue = { sendBatch: vi.fn(async (rows: Array<{ body: OrderMessage }>) => { sent.push(...rows.map(row => row.body)); }) };
      const service = new ProductAutoShelfService(runtime.container, { ORDER_QUEUE: queue as unknown as Env['ORDER_QUEUE'] }), work = message();
      await unchanged(async () => { expect(await service.process(work)).toMatchObject({ reason: 'no_longer_eligible' }); });
      await service.start({ action: 'runScheduledMaintenance', job: 'product_auto_shelf', runId: work.runId, scheduledAt: work.scheduledAt, cursor: 0, threshold: null });
      expect(sent).toHaveLength(2);
      for (const scan of sent.splice(0)) { if (scan.action !== 'scanProductAutoShelf') throw Error('Actual shelf scan expected'); await service.scan(scan); }
      expect(sent).toEqual([]); expect(await root()).toMatchObject({ autoOnTime: 0, autoOffTime: 0, isShow: 0, isVerify: 0 });
    });
  });

  it('rolls back a schedule and all ordinary save rows if an actual deferred failure occurs after the final authority recheck', async () => f.withWriter(async runtime => {
    await f.exec("CREATE FUNCTION owned_schedule_late_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.auto_on_time=123 THEN RAISE EXCEPTION 'owned schedule late rollback'; END IF; RETURN NEW; END $$; CREATE CONSTRAINT TRIGGER owned_schedule_late_failure AFTER UPDATE ON public.store_product DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION owned_schedule_late_failure()");
    wiring.container = runtime.container; const before = await f.snapshot();
    expect((await request('POST', '/product/product/80', f.body({ auto_on_time: 123 }))).status).not.toBe(200);
    expect(await f.snapshot()).toEqual(before); expect(await root()).toMatchObject({ autoOnTime: f.initialOn, autoOffTime: f.initialOff, isVerify: 1 });
  }));

  it.each(['skip', 'rewrite'] as const)('rejects an actual %s trigger instead of returning a false saved-plan receipt', async mode => f.withWriter(async runtime => {
    await f.exec(mode === 'skip'
      ? "CREATE FUNCTION owned_schedule_write_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.auto_on_time=123 AND OLD.auto_on_time<>123 THEN RETURN NULL; END IF; RETURN NEW; END $$; CREATE TRIGGER owned_schedule_write_guard BEFORE UPDATE ON public.store_product FOR EACH ROW EXECUTE FUNCTION owned_schedule_write_guard()"
      : "CREATE FUNCTION owned_schedule_write_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF pg_trigger_depth()=1 AND NEW.auto_on_time=123 THEN UPDATE public.store_product SET auto_on_time=124,is_verify=1 WHERE id=NEW.id; END IF; RETURN NEW; END $$; CREATE TRIGGER owned_schedule_write_guard AFTER UPDATE OF auto_on_time ON public.store_product FOR EACH ROW EXECUTE FUNCTION owned_schedule_write_guard()");
    wiring.container = runtime.container; const before = await f.snapshot();
    expect((await request('POST', '/product/product/80', f.body({ auto_on_time: 123 }))).status).toBe(409);
    expect(await f.snapshot()).toEqual(before);
  }));
});
