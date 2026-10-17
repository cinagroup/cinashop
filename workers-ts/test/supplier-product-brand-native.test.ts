import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, asc, eq, sql } from 'drizzle-orm';
import { createApp } from '@/app';
import { createContainerFromDb, withTx, type Container } from '@/lib/di';
import { storeBrand, storeProduct, storeProductRelation, systemRole } from '@/models/schema';
import { SupplierProductManagementService } from '@/services/supplier/SupplierProductManagementService';
import { supplierProductBrandFixture, supplierProductBrandActor } from './helpers/supplierProductBrand';
import { outcome, waitForFinanceBlock } from './helpers/financePeers';
const wiring = vi.hoisted(() => ({ container: null as Container | null }));
vi.mock('@/lib/di', async original => ({ ...await original<typeof import('@/lib/di')>(), createContainer: () => wiring.container }));
const app = createApp();
function signal() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('Supplier complete brand authoring on owned PG16 real App JWT and independent restricted LOGIN', () => {
  let f: Awaited<ReturnType<typeof supplierProductBrandFixture>>;
  beforeEach(async () => { vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Owned brand evidence forbids outbound I/O'));
    f = await supplierProductBrandFixture(); wiring.container = f.container; }, 30000);
  afterEach(async () => { try { expect(fetch).not.toHaveBeenCalled(); } finally { await f?.close(); vi.restoreAllMocks(); wiring.container = null; } }, 30000);
  async function request(method: string, path: string, body?: unknown, actor: keyof typeof f.tokens | 'anonymous' = 'manager') {
    const response = await app.request('/supplierapi' + path, { method, headers: {
      ...(actor === 'anonymous' ? {} : { Authorization: 'Bearer ' + f.tokens[actor] }), 'X-Supplier-Id': '8',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, f.env);
    expect(response.headers.get('cache-control')).toContain('private, no-store');
    return response.json<{ status: number; msg: string; data: any }>();
  }
  const root = async (id = 80) => (await f.db.select().from(storeProduct).where(eq(storeProduct.id, id)))[0];
  const relations = () => f.db.select().from(storeProductRelation).where(and(eq(storeProductRelation.productId, 80), eq(storeProductRelation.type, 2))).orderBy(asc(storeProductRelation.id));
  async function unchanged(work: () => Promise<unknown>) { const before = await f.snapshot(), sequences = await f.sequences(); const value = await work();
    expect(await f.snapshot()).toEqual(before); expect(await f.sequences()).toEqual(sequences); return value; }
  async function preservesHidden(before: Awaited<ReturnType<typeof root>>, snapshot: Awaited<ReturnType<typeof f.snapshot>>) {
    const after = await root(), current = await f.snapshot();
    for (const key of ['autoOnTime','autoOffTime','ensureId','specsId','specs','labelId','commandWord','systemFormId','addTime','sales','spu'] as const) expect(after[key], key).toEqual(before[key]);
    expect(current.store_product_relation.filter((item: { row: { product_id: number; type: number } }) => item.row.product_id === 80 && ![1,2].includes(item.row.type)))
      .toEqual(snapshot.store_product_relation.filter((item: { row: { product_id: number; type: number } }) => item.row.product_id === 80 && ![1,2].includes(item.row.type)));
    for (const name of Object.keys(snapshot)) if (!['store_product','store_product_attr','store_product_attr_result','store_product_relation'].includes(name)) expect(current[name], name).toEqual(snapshot[name]);
  }

  it('reads the exact stored brand path and consistency state using a pure twelve-table SELECT viewer', async () => f.withReader(async runtime => {
    wiring.container = runtime.container;
    await unchanged(async () => { const result = await request('GET', '/product/product/80', undefined, 'viewer'); expect(result.status).toBe(200);
      expect(result.data).toMatchObject({ brand_id: [101,102], brand_selection: { brand_id: 102, brand_com: '101,102', consistent: true, available: true } }); });
    const [rights] = await runtime.db.execute(sql`SELECT count(*) FILTER(WHERE has_table_privilege(current_user,c.oid,'SELECT'))::int AS selected,
      bool_and(NOT(has_table_privilege(current_user,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR has_any_column_privilege(current_user,c.oid,'INSERT,UPDATE,REFERENCES'))) AS pure
      FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind='r'`);
    expect(rights).toMatchObject({ selected: 12, pure: true });
  }));

  it.each([{ ids: [101] }, { ids: [101,102] }, { ids: [101,102,103] }])('creates and then replaces brand path $ids without losing hidden fields or other associations', async ({ ids }) => f.withWriter(async runtime => {
    wiring.container = runtime.container; const before = await root(), snapshot = await f.snapshot();
    const created = await request('POST', '/product/product', f.body({ brand_id: ids })); expect(created.status).toBe(200);
    expect(await root(created.data.id)).toMatchObject({ brandId: ids.at(-1), brandCom: ids.join(','), isShow: 0, isVerify: 0 });
    const value = await request('POST', '/product/product/80', f.body({ brand_id: ids, is_verify: 1, is_show: 1 })); expect(value.status).toBe(200);
    expect(await root()).toMatchObject({ brandId: ids.at(-1), brandCom: ids.join(','), isShow: 0, isVerify: 0 });
    expect((await relations()).map(row => row.relationId)).toEqual(ids);
    const data = (await request('GET', '/product/product/80')).data; expect(data.brand_id).toEqual(ids); expect(data.brand_selection).toMatchObject({ consistent: true, available: true });
    // The separately created product is an allowed creation, not a side effect
    // of replacing product80. Compare its older unrelated rows independently.
    const current = await f.snapshot();
    for (const key of ['autoOnTime','autoOffTime','ensureId','specsId','specs','labelId','commandWord','systemFormId'] as const) expect((await root())[key], key).toEqual(before[key]);
    expect(current.store_product_relation.filter((item: { row: { product_id: number; type: number } }) => item.row.product_id === 80 && ![1,2].includes(item.row.type)))
      .toEqual(snapshot.store_product_relation.filter((item: { row: { product_id: number; type: number } }) => item.row.product_id === 80 && ![1,2].includes(item.row.type)));
    for (const name of ['supplier_flowing_water','supplier_extract','system_admin','system_role','system_supplier','system_menus','store_brand']) expect(current[name], name).toEqual(snapshot[name]);
  }));

  it.each([{ wire: ['101'], expected: [101] }, { wire: ['101','102'], expected: [101,102] },
    { wire: ['101','102','103'], expected: [101,102,103] }, { wire: [101,'102',103], expected: [101,102,103] }])
    ('accepts the actual PHP string or mixed Cascader wire $wire through App and rereads numeric paths', async ({ wire, expected }) => f.withWriter(async runtime => {
      wiring.container = runtime.container; const before = await root(), snapshot = await f.snapshot();
      expect((await request('POST', '/product/product/80', f.body({ brand_id: wire }))).status).toBe(200);
      expect(await root()).toMatchObject({ brandId: expected.at(-1), brandCom: expected.join(',') });
      expect((await relations()).map(row => row.relationId)).toEqual(expected);
      const read = await request('GET', '/product/product/80'); expect(read.status).toBe(200);
      expect(read.data.brand_id).toEqual(expected); expect(read.data.brand_selection).toMatchObject({ consistent: true, available: true });
      await preservesHidden(before, snapshot);
    }));

  it('keeps malformed missing and inconsistent historical bindings readable and permits an explicit empty repair', async () => f.withWriter(async runtime => {
    wiring.container = runtime.container;
    for (const [brandId,brandCom] of [[999,'999'],[-1,'bad,raw'],[103,'101,102']] as const) {
      await f.db.update(storeProduct).set({ brandId, brandCom }).where(eq(storeProduct.id, 80));
      await unchanged(async () => { const value = await request('GET', '/product/product/80'); expect(value.status).toBe(200);
        expect(value.data.brand_selection).toEqual({ brand_id: brandId, brand_com: brandCom, consistent: false, available: false }); });
    }
    const before = await root(), snapshot = await f.snapshot();
    expect((await request('POST', '/product/product/80', f.body({ brand_id: [] }))).status).toBe(200);
    expect(await root()).toMatchObject({ brandId: 0, brandCom: '' }); expect(await relations()).toEqual([]);
    expect((await request('GET', '/product/product/80')).data).toMatchObject({ brand_id: [], brand_selection: { consistent: true, available: true } });
    await preservesHidden(before, snapshot);
  }));

  it('leaves omitted brand columns and existing type2 row identities untouched during ordinary save', async () => f.withWriter(async runtime => {
    wiring.container = runtime.container; const before = await root(), rows = await relations(), snapshot = await f.snapshot();
    expect((await request('POST', '/product/product/80', f.body())).status).toBe(200);
    expect(await root()).toMatchObject({ brandId: before.brandId, brandCom: before.brandCom }); expect(await relations()).toEqual(rows);
    await preservesHidden(before, snapshot);
  }));

  it('does not overwrite an Admin binding committed while an omitted-field save waits on the actual product row', async () => f.withWriter(async runtime => f.withPeer!(async owner => {
    const held = signal(), release = signal();
    const holding = withTx(createContainerFromDb(owner.db), async tx => {
      await tx.update(storeProduct).set({ brandId: 105, brandCom: '104,105' }).where(eq(storeProduct.id, 80));
      await tx.delete(storeProductRelation).where(and(eq(storeProductRelation.productId, 80), eq(storeProductRelation.type, 2)));
      await tx.insert(storeProductRelation).values([104,105].map(relationId => ({ productId: 80, type: 2, relationId, status: 1 })));
      held.resolve(); await release.promise;
    });
    let saving: Promise<unknown> | undefined;
    try { await held.promise; saving = outcome(new SupplierProductManagementService(runtime.container, f.env).saveProduct(7, 80, f.body()));
      await waitForFinanceBlock(f.db, runtime.pid, owner.pid); release.resolve(); await holding; expect(await saving).toMatchObject({ ok: true });
      expect(await root()).toMatchObject({ brandId: 105, brandCom: '104,105' }); expect((await relations()).map(row => row.relationId)).toEqual([104,105]);
    } finally { release.resolve(); await holding; await saving; }
  })));

  it.each([{ ids: [102] }, { ids: [101,103] }, { ids: [104,102] }, { ids: [106] }, { ids: [107] }, { ids: [108] }, { ids: [109] }, { ids: [106,110] }])('rejects nonselectable or incomplete actual brand path $ids without writing', async ({ ids }) => f.withWriter(async runtime => {
    wiring.container = runtime.container; await unchanged(async () => { expect((await request('POST', '/product/product/80', f.body({ brand_id: ids }))).status).toBe(400); });
  }));

  it('requires current manage and JWT owner rather than caller selected Supplier identity', async () => f.withWriter(async runtime => {
    wiring.container = runtime.container;
    await unchanged(async () => {
      for (const actor of ['viewer','denied'] as const) expect((await request('POST', '/product/product/80', f.body({ brand_id: [104], supplier_id: 8 }), actor)).status).toBe(400011);
      expect((await request('POST', '/product/product/80', f.body({ brand_id: [104] }), 'other')).status).toBe(404);
      expect((await request('POST', '/product/product/80', f.body({ brand_id: [104] }), 'anonymous')).status).toBe(410000);
      const service = new SupplierProductManagementService(runtime.container, f.env);
      await expect(service.saveProduct(7, 80, f.body({ brand_id: [104] }), { ...supplierProductBrandActor(), expiresAt: 1 })).rejects.toThrow();
    });
  }));

  it('refuses an in-flight role revocation NOWAIT and succeeds only after that transaction rolls back', async () => f.withWriter(async runtime => f.withPeer!(async owner => {
    wiring.container = runtime.container; const held = signal(), release = signal();
    const holding = withTx(createContainerFromDb(owner.db), async tx => { await tx.update(systemRole).set({ rules: 'supplier.product.view' }).where(eq(systemRole.id, 21)); held.resolve(); await release.promise; throw Error('owned brand authority rollback'); }).catch(error => { if (error.message !== 'owned brand authority rollback') throw error; });
    try { await held.promise; await unchanged(async () => { expect((await request('POST', '/product/product/80', f.body({ brand_id: [104] }))).status).toBe(409); }); }
    finally { release.resolve(); await holding; }
    expect((await request('POST', '/product/product/80', f.body({ brand_id: [104] }))).status).toBe(200);
    const [rights] = await runtime.db.execute(sql`SELECT has_column_privilege(current_user,'store_brand','id','UPDATE') AS lock_qualification,
      has_column_privilege(current_user,'store_brand','brand_name','UPDATE') AS edit_name,has_table_privilege(current_user,'store_brand','INSERT,DELETE') AS insert_delete`);
    expect(rights).toEqual({ lock_qualification: true, edit_name: false, insert_delete: false });
  })));

  it.each(['hidden','deleted','reparented'] as const)('refuses an actual %s brand writer and rejects the resulting stale path after commit', async change => f.withWriter(async runtime => f.withPeer!(async owner => {
    wiring.container = runtime.container; const held = signal(), release = signal();
    const holding = withTx(createContainerFromDb(owner.db), async tx => {
      await tx.update(storeBrand).set(change === 'hidden' ? { isShow: 0 } : change === 'deleted' ? { isDel: 1 } : { pid: 104 }).where(eq(storeBrand.id, 102));
      held.resolve(); await release.promise;
    });
    try { await held.promise; await unchanged(async () => { expect((await request('POST', '/product/product/80', f.body({ brand_id: [101,102] }))).status).toBe(409); }); }
    finally { release.resolve(); await holding; }
    await unchanged(async () => { expect((await request('POST', '/product/product/80', f.body({ brand_id: [101,102] }))).status).toBe(400);
      const data = (await request('GET', '/product/product/80')).data; expect(data.brand_selection).toMatchObject({ consistent: true, available: false }); });
  })));

  it.each(['skip-main','rewrite-main','skip-relation','deferred-plan'] as const)('rolls back actual %s trigger corruption instead of returning a false success', async mode => f.withWriter(async runtime => {
    const triggers = {
      'skip-main': "CREATE FUNCTION owned_brand_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.brand_id=105 AND NEW.brand_id<>OLD.brand_id THEN RETURN NULL; END IF; RETURN NEW; END $$; CREATE TRIGGER owned_brand_guard BEFORE UPDATE ON public.store_product FOR EACH ROW EXECUTE FUNCTION owned_brand_guard()",
      'rewrite-main': "CREATE FUNCTION owned_brand_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF pg_trigger_depth()=1 AND NEW.brand_id=105 THEN UPDATE public.store_product SET brand_id=104,brand_com='104' WHERE id=NEW.id; END IF; RETURN NEW; END $$; CREATE TRIGGER owned_brand_guard AFTER UPDATE OF brand_id ON public.store_product FOR EACH ROW EXECUTE FUNCTION owned_brand_guard()",
      'skip-relation': "CREATE FUNCTION owned_brand_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.type=2 AND NEW.relation_id=105 THEN RETURN NULL; END IF; RETURN NEW; END $$; CREATE TRIGGER owned_brand_guard BEFORE INSERT ON public.store_product_relation FOR EACH ROW EXECUTE FUNCTION owned_brand_guard()",
      'deferred-plan': "CREATE FUNCTION owned_brand_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.brand_id=105 AND NEW.brand_id<>OLD.brand_id THEN UPDATE public.store_product SET auto_on_time=1 WHERE id=NEW.id; END IF; RETURN NEW; END $$; CREATE CONSTRAINT TRIGGER owned_brand_guard AFTER UPDATE ON public.store_product DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION owned_brand_guard()",
    };
    await f.exec(triggers[mode]); wiring.container = runtime.container; const before = await f.snapshot();
    expect((await request('POST', '/product/product/80', f.body({ brand_id: [104,105] }))).status).toBe(409); expect(await f.snapshot()).toEqual(before);
  }));
});
