import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, asc, eq, sql } from 'drizzle-orm';
import { createApp } from '@/app';
import { createContainerFromDb, withTx, type Container } from '@/lib/di';
import { storeProduct, storeProductEnsure, storeProductRelation, systemRole } from '@/models/schema';
import { SupplierProductManagementService } from '@/services/supplier/SupplierProductManagementService';
import { readDetailEnsures } from '@/services/product/ProductDetailDesignData';
import { supplierProductEnsuresFixture, supplierProductEnsuresActor } from './helpers/supplierProductEnsures';
import { outcome, waitForFinanceBlock } from './helpers/financePeers';
const wiring = vi.hoisted(() => ({ container: null as Container | null }));
vi.mock('@/lib/di', async original => ({ ...await original<typeof import('@/lib/di')>(), createContainer: () => wiring.container }));
const app = createApp();
function signal() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
type SnapshotRow = { row: { product_id: number; type: number } };
describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('Supplier complete assurance authoring on owned PG16 real App JWT and independent restricted LOGIN', () => {
  let f: Awaited<ReturnType<typeof supplierProductEnsuresFixture>>;
  beforeEach(async () => { vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Owned assurance evidence forbids outbound I/O'));
    f = await supplierProductEnsuresFixture(); wiring.container = f.container; }, 30000);
  afterEach(async () => { try { expect(fetch).not.toHaveBeenCalled(); } finally { await f?.close(); wiring.container = null; vi.restoreAllMocks(); } }, 30000);
  async function request(method: string, path: string, body?: unknown, actor: keyof typeof f.tokens | 'anonymous' = 'manager') {
    const response = await app.request('/supplierapi' + path, { method, headers: {
      ...(actor === 'anonymous' ? {} : { Authorization: 'Bearer ' + f.tokens[actor] }), 'X-Supplier-Id': '8',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, f.env);
    expect(response.headers.get('cache-control')).toContain('private, no-store');
    return response.json<{ status: number; msg: string; data: any }>();
  }
  const root = async (id = 80) => (await f.db.select().from(storeProduct).where(eq(storeProduct.id, id)))[0];
  const relations = () => f.db.select().from(storeProductRelation).where(and(eq(storeProductRelation.productId, 80), eq(storeProductRelation.type, 5))).orderBy(asc(storeProductRelation.id));
  async function unchanged(work: () => Promise<unknown>) { const before = await f.snapshot(), sequences = await f.sequences(); const value = await work();
    expect(await f.snapshot()).toEqual(before); expect(await f.sequences()).toEqual(sequences); return value; }
  async function preservesHidden(before: Awaited<ReturnType<typeof root>>, snapshot: Awaited<ReturnType<typeof f.snapshot>>) {
    const after = await root(), current = await f.snapshot();
    for (const key of ['autoOnTime','autoOffTime','brandId','brandCom','specsId','specs','labelId','commandWord','systemFormId','addTime','sales','spu'] as const) expect(after[key], key).toEqual(before[key]);
    expect(current.store_product_relation.filter((item: SnapshotRow) => item.row.product_id === 80 && ![1,5].includes(item.row.type)))
      .toEqual(snapshot.store_product_relation.filter((item: SnapshotRow) => item.row.product_id === 80 && ![1,5].includes(item.row.type)));
    for (const name of Object.keys(snapshot)) if (!['store_product','store_product_attr','store_product_attr_result','store_product_relation'].includes(name)) expect(current[name], name).toEqual(snapshot[name]);
  }

  it('reads exact five-key historical metadata through a thirteen-table SELECT-only viewer', async () => f.withReader(async runtime => {
    wiring.container = runtime.container;
    await unchanged(async () => { const result = await request('GET', '/product/product/80', undefined, 'viewer'); expect(result.status).toBe(200);
      expect(result.data.ensure_id).toEqual([41]); expect(result.data.ensure_selection).toEqual({ ensure_id: '41', consistent: true, available: true, retained_ids: [], truncated: false });
      expect(Object.keys(result.data.ensure_selection).sort()).toEqual(['available','consistent','ensure_id','retained_ids','truncated']);
      const catalog = await request('GET', '/product/all_ensure', undefined, 'viewer'); expect(catalog.status).toBe(200);
      expect(catalog.data.map((row: { id: number }) => row.id).sort((a: number, b: number) => a - b)).toEqual([41,201,202]);
      for (const row of catalog.data) expect(Object.keys(row).sort()).toEqual(['add_time','desc','id','image','name','relation_id','sort','status','type']);
      expect(JSON.stringify(catalog.data)).not.toContain('外店私有名称不得泄露'); });
    const [rights] = await runtime.db.execute(sql`SELECT count(*) FILTER(WHERE has_table_privilege(current_user,c.oid,'SELECT'))::int AS selected,
      bool_and(NOT(has_table_privilege(current_user,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR has_any_column_privilege(current_user,c.oid,'INSERT,UPDATE,REFERENCES'))) AS pure
      FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind='r'`);
    expect(rights).toMatchObject({ selected: 13, pure: true });
    const [sequences] = await runtime.db.execute(sql`SELECT bool_and(NOT has_sequence_privilege(current_user,c.oid,'USAGE,SELECT,UPDATE')) AS pure FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind='S'`);
    expect(sequences).toEqual({ pure: true });
  }));

  it.each([{ wire: [201,202] }, { wire: ['201','202'] }, { wire: [201,'202'] }])('saves actual numeric or PHP string selection $wire and preserves all hidden configurations', async ({ wire }) => f.withWriter(async runtime => {
    wiring.container = runtime.container; const before = await root(), snapshot = await f.snapshot();
    expect((await request('POST', '/product/product/80', f.body({ ensure_id: wire, is_show: 1, is_verify: 1 }))).status).toBe(200);
    expect(await root()).toMatchObject({ ensureId: '201,202', isShow: 0, isVerify: 0 }); expect((await relations()).map(row => row.relationId)).toEqual([201,202]);
    const read = await request('GET', '/product/product/80'); expect(read.status).toBe(200); expect(read.data).toMatchObject({ ensure_id: [201,202], ensure_selection: { consistent: true, available: true, retained_ids: [] } });
    await preservesHidden(before, snapshot);
  }));

  it('creates a complete binding and exposes only actual platform and own guarantees to the existing consumer then clears them', async () => f.withWriter(async runtime => {
    wiring.container = runtime.container;
    const created = await request('POST', '/product/product', f.body({ ensure_id: ['201',202] })); expect(created.status).toBe(200);
    expect(await root(created.data.id)).toMatchObject({ ensureId: '201,202', isShow: 0, isVerify: 0 });
    expect((await request('POST', '/product/product/80', f.body({ ensure_id: [201,202] }))).status).toBe(200);
    const selected = await root();
    expect(await withTx(runtime.container, tx => readDetailEnsures(tx, selected))).toEqual([
      { id: 201, name: '平台七天保障', image: '', desc: '平台保障说明' }, { id: 202, name: '本店品质保障', image: '', desc: '自有保障说明' },
    ]);
    const snapshot = await f.snapshot(), before = await root();
    expect((await request('POST', '/product/product/80', f.body({ ensure_id: [] }))).status).toBe(200);
    expect(await root()).toMatchObject({ ensureId: '' }); expect(await relations()).toEqual([]);
    expect(await withTx(runtime.container, tx => readDetailEnsures(tx, { ...selected, ensureId: '' }))).toEqual([]);
    expect((await request('GET', '/product/product/80')).data.ensure_selection).toEqual({ ensure_id: '', consistent: true, available: true, retained_ids: [], truncated: false });
    await preservesHidden(before, snapshot);
  }));

  it('omits both assurance columns and exact type5 row identities when saving other fields', async () => f.withWriter(async runtime => {
    wiring.container = runtime.container; const before = await root(), rows = await relations(), snapshot = await f.snapshot();
    expect((await request('POST', '/product/product/80', f.body())).status).toBe(200);
    expect((await root()).ensureId).toBe(before.ensureId); expect(await relations()).toEqual(rows); await preservesHidden(before, snapshot);
  }));

  it('preserves an Admin assurance update committed while an omitted save waits on the real product row', async () => f.withWriter(async runtime => f.withPeer!(async owner => {
    const held = signal(), release = signal();
    const holding = withTx(createContainerFromDb(owner.db), async tx => {
      await tx.update(storeProduct).set({ ensureId: '202' }).where(eq(storeProduct.id, 80));
      await tx.delete(storeProductRelation).where(and(eq(storeProductRelation.productId, 80), eq(storeProductRelation.type, 5)));
      await tx.insert(storeProductRelation).values({ productId: 80, type: 5, relationId: 202, status: 1 }); held.resolve(); await release.promise;
    });
    let saving: Promise<unknown> | undefined;
    try { await held.promise; saving = outcome(new SupplierProductManagementService(runtime.container, f.env).saveProduct(7, 80, f.body()));
      await waitForFinanceBlock(f.db, runtime.pid, owner.pid); release.resolve(); await holding; expect(await saving).toMatchObject({ ok: true });
      expect((await root()).ensureId).toBe('202'); expect((await relations()).map(row => row.relationId)).toEqual([202]);
    } finally { release.resolve(); await holding; await saving; }
  })));

  it('retains an actually owned disabled historical selection until removed and forbids binding it again', async () => f.withWriter(async runtime => {
    wiring.container = runtime.container; await f.db.update(storeProductEnsure).set({ status: 0 }).where(eq(storeProductEnsure.id, 41));
    await unchanged(async () => { expect((await request('GET', '/product/product/80')).data.ensure_selection).toEqual({ ensure_id: '41', consistent: true, available: false, retained_ids: [41], truncated: false }); });
    expect((await request('POST', '/product/product/80', f.body({ ensure_id: [41,201] }))).status).toBe(200);
    expect((await request('GET', '/product/product/80')).data.ensure_selection.retained_ids).toEqual([41]);
    expect((await request('POST', '/product/product/80', f.body({ ensure_id: [201] }))).status).toBe(200);
    await unchanged(async () => expect((await request('POST', '/product/product/80', f.body({ ensure_id: [201,41] }))).status).toBe(400));
  }));

  it.each([{ ids: [203] }, { ids: [204] }, { ids: [205] }, { ids: [999] }])('rejects foreign wrong-scope disabled-new or missing guarantees $ids without writing', async ({ ids }) => f.withWriter(async runtime => {
    wiring.container = runtime.container; await unchanged(async () => expect((await request('POST', '/product/product/80', f.body({ ensure_id: ids }))).status).toBe(400));
  }));

  it.each([{ label: 'null-with-old-relation', raw: null }, { label: 'malformed-csv', raw: '203,private' }, { label: 'truncated-codepoints', raw: '😀'.repeat(4097) }])('keeps unsupported historical $label readable and permits explicit empty repair', async ({ raw }) => f.withWriter(async runtime => {
    wiring.container = runtime.container; await f.db.update(storeProduct).set({ ensureId: raw }).where(eq(storeProduct.id, 80));
    await unchanged(async () => { const read = await request('GET', '/product/product/80'); expect(read.status).toBe(200); expect(read.data.ensure_id).toEqual([]);
      expect(read.data.ensure_selection).toEqual({ ensure_id: raw === null ? null : [...raw].slice(0,4096).join(''), consistent: false, available: false, retained_ids: [], truncated: raw !== null && [...raw].length > 4096 });
      expect(JSON.stringify(read.data)).not.toContain('外店私有名称不得泄露'); });
    expect((await request('POST', '/product/product/80', f.body({ ensure_id: [] }))).status).toBe(200);
    expect((await request('GET', '/product/product/80')).data.ensure_selection).toMatchObject({ ensure_id: '', consistent: true, available: true });
  }));

  it('does not retain disabled rows from a mismatched type5 status or parent and repairs the full relation', async () => f.withWriter(async runtime => {
    wiring.container = runtime.container; await f.db.update(storeProductEnsure).set({ status: 0 }).where(eq(storeProductEnsure.id, 41));
    await f.db.update(storeProductRelation).set({ status: 0, relationPid: 99 }).where(and(eq(storeProductRelation.productId, 80), eq(storeProductRelation.type, 5)));
    await unchanged(async () => { const read = await request('GET', '/product/product/80'); expect(read.status).toBe(200); expect(read.data.ensure_selection).toMatchObject({ consistent: false, available: false, retained_ids: [] });
      expect((await request('POST', '/product/product/80', f.body({ ensure_id: [41] }))).status).toBe(400); });
    expect((await request('POST', '/product/product/80', f.body({ ensure_id: [201] }))).status).toBe(200);
    expect(await relations()).toMatchObject([{ relationId: 201, relationPid: 0, status: 1 }]);
  }));

  it('atomically composes guarantees with brand path explicit labels and schedules without changing other hidden associations', async () => f.withWriter(async runtime => {
    wiring.container = runtime.container; const before = await root(), snapshot = await f.snapshot();
    expect((await request('POST', '/product/product/80', f.body({ ensure_id: ['201',202], brand_id: ['101',102,'103'], store_label_id: [31], auto_on_time: 1, auto_off_time: 2 }))).status).toBe(200);
    expect(await root()).toMatchObject({ ensureId: '201,202', brandId: 103, brandCom: '101,102,103', storeLabelId: '31', autoOnTime: 1, autoOffTime: 2, isShow: 0, isVerify: 0 });
    const current = await f.snapshot(); expect(current.store_product_relation.filter((item: SnapshotRow) => item.row.product_id === 80 && [4,6].includes(item.row.type)))
      .toEqual(snapshot.store_product_relation.filter((item: SnapshotRow) => item.row.product_id === 80 && [4,6].includes(item.row.type)));
    for (const key of ['specsId','specs','labelId','commandWord','systemFormId'] as const) expect((await root())[key]).toEqual(before[key]);
    const read = await request('GET', '/product/product/80'); expect(read.data).toMatchObject({ brand_id: [101,102,103], ensure_id: [201,202], ensure_selection: { consistent: true, available: true } });
  }));

  it('requires current manage owner and unexpired real actor rather than a caller selected Supplier', async () => f.withWriter(async runtime => {
    wiring.container = runtime.container;
    await unchanged(async () => {
      for (const actor of ['viewer','denied'] as const) expect((await request('POST', '/product/product/80', f.body({ ensure_id: [201], supplier_id: 8 }), actor)).status).toBe(400011);
      expect((await request('POST', '/product/product/80', f.body({ ensure_id: [201] }), 'other')).status).toBe(404);
      expect((await request('POST', '/product/product/80', f.body({ ensure_id: [201] }), 'anonymous')).status).toBe(410000);
      await expect(new SupplierProductManagementService(runtime.container, f.env).saveProduct(7, 80, f.body({ ensure_id: [201] }), { ...supplierProductEnsuresActor(), expiresAt: 1 })).rejects.toThrow();
    });
  }));

  it('rejects an in-flight actual role revocation NOWAIT and grants ensure locking without catalog edit authority', async () => f.withWriter(async runtime => f.withPeer!(async owner => {
    wiring.container = runtime.container; const held = signal(), release = signal();
    const holding = withTx(createContainerFromDb(owner.db), async tx => { await tx.update(systemRole).set({ rules: 'supplier.product.view' }).where(eq(systemRole.id, 21)); held.resolve(); await release.promise; throw Error('owned ensure authority rollback'); }).catch(error => { if (error.message !== 'owned ensure authority rollback') throw error; });
    try { await held.promise; await unchanged(async () => expect((await request('POST', '/product/product/80', f.body({ ensure_id: [201] }))).status).toBe(409)); }
    finally { release.resolve(); await holding; }
    expect((await request('POST', '/product/product/80', f.body({ ensure_id: [201] }))).status).toBe(200);
    const [rights] = await runtime.db.execute(sql`SELECT has_column_privilege(current_user,'store_product_ensure','id','UPDATE') AS lock_qualification,
      has_column_privilege(current_user,'store_product_ensure','name','UPDATE') AS edit_name,has_table_privilege(current_user,'store_product_ensure','INSERT,DELETE') AS insert_delete`);
    expect(rights).toEqual({ lock_qualification: true, edit_name: false, insert_delete: false });
  })));

  it.each(['disabled','moved','deleted'] as const)('refuses an actual concurrent %s guarantee writer then rejects its committed unselectable new binding', async mode => f.withWriter(async runtime => f.withPeer!(async owner => {
    wiring.container = runtime.container; const held = signal(), release = signal();
    const holding = withTx(createContainerFromDb(owner.db), async tx => {
      if (mode === 'deleted') await tx.delete(storeProductEnsure).where(eq(storeProductEnsure.id, 202));
      else await tx.update(storeProductEnsure).set(mode === 'disabled' ? { status: 0 } : { relationId: 8 }).where(eq(storeProductEnsure.id, 202)); held.resolve(); await release.promise;
    });
    try { await held.promise; await unchanged(async () => expect((await request('POST', '/product/product/80', f.body({ ensure_id: [201,202] }))).status).toBe(409)); }
    finally { release.resolve(); await holding; }
    await unchanged(async () => expect((await request('POST', '/product/product/80', f.body({ ensure_id: [201,202] }))).status).toBe(400));
  })));

  it.each(['skip-main','rewrite-main','skip-relation','deferred-plan','deferred-hidden'] as const)('rolls back actual %s trigger corruption instead of returning an incomplete assurance receipt', async mode => f.withWriter(async runtime => {
    const triggers = {
      'skip-main': "CREATE FUNCTION owned_ensure_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.ensure_id='201,202' AND NEW.ensure_id IS DISTINCT FROM OLD.ensure_id THEN RETURN NULL; END IF; RETURN NEW; END $$; CREATE TRIGGER owned_ensure_guard BEFORE UPDATE ON public.store_product FOR EACH ROW EXECUTE FUNCTION owned_ensure_guard()",
      'rewrite-main': "CREATE FUNCTION owned_ensure_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF pg_trigger_depth()=1 AND NEW.ensure_id='201,202' THEN UPDATE public.store_product SET ensure_id='201' WHERE id=NEW.id; END IF; RETURN NEW; END $$; CREATE TRIGGER owned_ensure_guard AFTER UPDATE OF ensure_id ON public.store_product FOR EACH ROW EXECUTE FUNCTION owned_ensure_guard()",
      'skip-relation': "CREATE FUNCTION owned_ensure_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.type=5 AND NEW.relation_id=202 THEN RETURN NULL; END IF; RETURN NEW; END $$; CREATE TRIGGER owned_ensure_guard BEFORE INSERT ON public.store_product_relation FOR EACH ROW EXECUTE FUNCTION owned_ensure_guard()",
      'deferred-plan': "CREATE FUNCTION owned_ensure_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.ensure_id='201,202' AND NEW.ensure_id IS DISTINCT FROM OLD.ensure_id THEN UPDATE public.store_product SET auto_on_time=1 WHERE id=NEW.id; END IF; RETURN NEW; END $$; CREATE CONSTRAINT TRIGGER owned_ensure_guard AFTER UPDATE ON public.store_product DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION owned_ensure_guard()",
      'deferred-hidden': "CREATE FUNCTION owned_ensure_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.ensure_id='201,202' AND NEW.ensure_id IS DISTINCT FROM OLD.ensure_id THEN UPDATE public.store_product_relation SET status=0 WHERE product_id=NEW.id AND type=2; END IF; RETURN NEW; END $$; CREATE CONSTRAINT TRIGGER owned_ensure_guard AFTER UPDATE ON public.store_product DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION owned_ensure_guard()",
    };
    // Only this owned adverse writer needs the column it corrupts. The normal
    // role and production profiles are unchanged.
    if (mode === 'deferred-hidden') await f.exec(`GRANT UPDATE(status) ON public.store_product_relation TO "${runtime.role}"`);
    await f.exec(triggers[mode]); wiring.container = runtime.container; const before = await f.snapshot();
    expect((await request('POST', '/product/product/80', f.body({ ensure_id: [201,202] }))).status).toBe(409); expect(await f.snapshot()).toEqual(before);
  }));
});
