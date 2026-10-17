import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, asc, eq, sql } from 'drizzle-orm';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { randomUUID } from 'node:crypto';
import { createApp } from '@/app';
import { createContainerFromDb, withTx, type Container, type DbClient } from '@/lib/di';
import { legacyCategory, storeProduct, storeProductRelation, systemRole } from '@/models/schema';
import { SupplierProductManagementService } from '@/services/supplier/SupplierProductManagementService';
import { integralDetailSpecs } from '@/services/activity/IntegralProductDetailData';
import { SUPPLIER_PARAMETER_RAW_POINTS, supplierProductParameterRows } from '@/services/supplier/SupplierProductParameterBindings';
import { supplierProductParametersFixture, supplierProductParametersActor } from './helpers/supplierProductParameters';
import { outcome, waitForFinanceBlock } from './helpers/financePeers';
import { supplierProductCopyFixture, supplierCopyActor } from './helpers/supplierProductCopy';
import { validateFinanceFixtureUrl } from './helpers/financePostgres';
import { SupplierProductCopyService } from '@/services/supplier/SupplierProductCopyService';
import { captureSupplierProductParameterCopy, assertSupplierProductParameterCopy, supplierProductParameterCopyRows } from '@/services/supplier/SupplierProductParameterCopyCapability';
import { ProductAssociationService } from '@/services/product/ProductAssociationService';
import { normalizeAdminLegacyProductInput } from '@/services/admin/AdminLegacyProductInput';
import { AdminLegacyProductSaveService } from '@/services/admin/AdminLegacyProductSaveService';
import { legacySaveActor } from './helpers/adminLegacyProductSave';
import { editorProduct } from './helpers/adminProductEditor';
import { lockProductSaveTables } from '@/services/admin/AdminLegacyProductSaveState';
const wiring = vi.hoisted(() => ({ container: null as Container | null }));
vi.mock('@/lib/di', async original => ({ ...await original<typeof import('@/lib/di')>(), createContainer: () => wiring.container }));
const app = createApp();
function signal() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
const freeRows = () => [{ id: '311', temp_id: '301', name: ' 自写材质 ', value: ' 0 ', sort: '-3', status: 0, relation_id: 999 },
  { name: '新增参数', value: '新值', sort: 9 }, { name: '新增参数', value: '第二值', sort: 2 }];
type SnapshotRow = { row: { product_id: number; type: number } };
describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('Supplier PHP free parameter authoring on PG16 real App JWT and minimal independent LOGIN', () => {
  let f: Awaited<ReturnType<typeof supplierProductParametersFixture>>;
  beforeEach(async () => { vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Owned parameter authoring forbids outbound I/O'));
    f = await supplierProductParametersFixture(); wiring.container = f.container; }, 30000);
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
  const relations = () => f.db.select().from(storeProductRelation).where(and(eq(storeProductRelation.productId, 80), eq(storeProductRelation.type, 6))).orderBy(asc(storeProductRelation.id));
  async function unchanged(work: () => Promise<unknown>) { const before = await f.snapshot(), sequences = await f.sequences(); const value = await work();
    expect(await f.snapshot()).toEqual(before); expect(await f.sequences()).toEqual(sequences); return value; }
  async function preservesHidden(before: Awaited<ReturnType<typeof root>>, snapshot: Awaited<ReturnType<typeof f.snapshot>>) {
    const after = await root(), current = await f.snapshot();
    for (const key of ['autoOnTime','autoOffTime','brandId','brandCom','ensureId','labelId','commandWord','systemFormId','addTime','sales','spu'] as const) expect(after[key], key).toEqual(before[key]);
    expect(current.store_product_relation.filter((item: SnapshotRow) => item.row.product_id === 80 && ![1,6].includes(item.row.type)))
      .toEqual(snapshot.store_product_relation.filter((item: SnapshotRow) => item.row.product_id === 80 && ![1,6].includes(item.row.type)));
    for (const name of Object.keys(snapshot)) if (!['store_product','store_product_attr','store_product_attr_result','store_product_relation'].includes(name)) expect(current[name], name).toEqual(snapshot[name]);
  }
  it('reads exact five-key metadata and the unchanged owner-safe all_specs catalog using a fifteen-table SELECT-only viewer', async () => f.withReader(async runtime => {
    wiring.container = runtime.container;
    await unchanged(async () => {
      const read = await request('GET', '/product/product/80', undefined, 'viewer'); expect(read.status).toBe(200);
      expect(read.data.specs_id).toBe(51); expect(read.data.specs).toEqual([{ id: 0, temp_id: 0, name: '材质', value: '棉', sort: 0 }]);
      expect(read.data.specs_selection).toEqual({ specs_id: 51, specs: '[{"name":"材质","value":"棉"}]', consistent: true, available: true, truncated: false });
      expect(Object.keys(read.data.specs_selection).sort()).toEqual(['available','consistent','specs','specs_id','truncated']);
      const catalog = await request('GET', '/product/all_specs', undefined, 'viewer'); expect(catalog.status).toBe(200);
      expect(catalog.data.map((row: { id: number }) => row.id).sort((a: number, b: number) => a - b)).toEqual([51,301,302,307]);
      for (const row of catalog.data) { expect(Object.keys(row).sort()).toEqual(['id','name','specs']); for (const item of row.specs) expect(Object.keys(item).sort()).toEqual(['add_time','id','name','relation_id','sort','status','temp_id','type','value']); }
      expect(catalog.data.find((row: { id: number }) => row.id === 302).specs.map((row: { id: number }) => row.id)).toEqual([321]);
      expect(JSON.stringify(catalog.data)).not.toMatch(/外店私有|归属错配|已停用子项/);
    });
    const [rights] = await runtime.db.execute(sql`SELECT count(*) FILTER(WHERE has_table_privilege(current_user,c.oid,'SELECT'))::int AS selected,
      bool_and(NOT(has_table_privilege(current_user,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR has_any_column_privilege(current_user,c.oid,'INSERT,UPDATE,REFERENCES'))) AS pure
      FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind='r'`);
    expect(rights).toEqual({ selected: 15, pure: true });
    const [sequences] = await runtime.db.execute(sql`SELECT bool_and(NOT has_sequence_privilege(current_user,c.oid,'USAGE,SELECT,UPDATE')) AS pure FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind='S'`); expect(sequences).toEqual({ pure: true });
  }));
  it.each([301, '301', 302, 307])('saves a real platform or own template %s while allowing rename add delete duplicates signed order and raw text', async specsId => f.withWriter(async runtime => {
    wiring.container = runtime.container; const before = await root(), snapshot = await f.snapshot(), specs = freeRows();
    const saved = await request('POST', '/product/product/80', f.body({ specs_id: specsId, specs, is_show: 1, is_verify: 1 })); expect(saved.status, saved.msg).toBe(200);
    expect(await root()).toMatchObject({ specsId: Number(specsId), specs: JSON.stringify(supplierProductParameterRows(specs)), isShow: 0, isVerify: 0 });
    expect(await relations()).toMatchObject([{ relationId: Number(specsId), relationPid: 0, status: 1 }]);
    const read = await request('GET', '/product/product/80'); expect(read.data).toMatchObject({ specs_id: Number(specsId), specs: supplierProductParameterRows(specs), specs_selection: { consistent: true, available: true } });
    const issues: string[] = []; const snapshotBefore = await f.snapshot(), sequencesBefore = await f.sequences();
    expect(integralDetailSpecs((await root()).specs, issues)).toEqual([{ name: '新增参数', value: '新值', sort: 9 }, { name: '新增参数', value: '第二值', sort: 2 }, { name: ' 自写材质 ', value: ' 0 ', sort: -3 }]);
    expect(issues).toEqual([]); expect(await f.snapshot()).toEqual(snapshotBefore); expect(await f.sequences()).toEqual(sequencesBefore); await preservesHidden(before, snapshot);
  }));
  it('persists all one hundred maximum Unicode rows and exposes them completely through the actual detail consumer', async () => f.withWriter(async runtime => {
    wiring.container = runtime.container;
    const specs = Array.from({ length: 100 }, (_, index) => ({ id: 0, temp_id: 0, name: '😀'.repeat(255), value: '🧵'.repeat(255), sort: index - 50 }));
    const saved = await request('POST', '/product/product/80', f.body({ specs_id: 0, specs })); expect(saved.status, saved.msg).toBe(200);
    const source = await root(); expect(source.specs!.length).toBeGreaterThan(100000);
    const issues: string[] = [], consumed = integralDetailSpecs(source.specs, issues); expect(issues).toEqual([]); expect(consumed).toHaveLength(100);
    expect(consumed).toEqual([...specs].sort((a, b) => b.sort - a.sort).map(({ name, value, sort }) => ({ name, value, sort })));
    const escaped = source.specs!.replace(/😀/gu, '\\ud83d\\ude00').replace(/🧵/gu, '\\ud83e\\uddf5');
    await f.db.update(storeProduct).set({ specs: escaped }).where(eq(storeProduct.id, 80));
    const escapedIssues: string[] = []; expect(integralDetailSpecs((await root()).specs, escapedIssues)).toEqual(consumed); expect(escapedIssues).toEqual([]);
  }));
  it('creates free parameters without a template, then clears all both columns and exact type6 only', async () => f.withWriter(async runtime => {
    wiring.container = runtime.container;
    const created = await request('POST', '/product/product', f.body({ specs_id: 0, specs: freeRows() })); expect(created.status, created.msg).toBe(200);
    expect(await root(created.data.id)).toMatchObject({ specsId: 0, specs: JSON.stringify(supplierProductParameterRows(freeRows())), isShow: 0, isVerify: 0 });
    const before = await root(), snapshot = await f.snapshot();
    expect((await request('POST', '/product/product/80', f.body({ specs_id: 0, specs: [] }))).status).toBe(200);
    expect(await root()).toMatchObject({ specsId: 0, specs: '' }); expect(await relations()).toEqual([]);
    expect((await request('GET', '/product/product/80')).data).toMatchObject({ specs_id: 0, specs: [], specs_selection: { specs_id: 0, specs: '', consistent: true, available: true, truncated: false } });
    await preservesHidden(before, snapshot);
  }));
  it('clears the template selector while retaining a deliberately submitted snapshot and never rewrites it on later omission', async () => f.withWriter(async runtime => {
    wiring.container = runtime.container; expect((await request('POST', '/product/product/80', f.body({ specs_id: 0, specs: freeRows() }))).status).toBe(200);
    expect(await relations()).toEqual([]); const before = await root(), rows = await relations();
    expect((await request('GET', '/product/product/80')).data.specs_selection).toMatchObject({ specs_id: 0, consistent: true, available: true });
    expect((await request('POST', '/product/product/80', f.body())).status).toBe(200); expect((await root()).specs).toBe(before.specs); expect((await root()).specsId).toBe(0); expect(await relations()).toEqual(rows);
  }));
  it('omits parameter SQL targets and exact type6 identities in ordinary legacy saves', async () => f.withWriter(async runtime => {
    wiring.container = runtime.container; await f.exec("CREATE FUNCTION owned_parameter_omit_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'omitted parameters entered SQL target'; END $$; CREATE TRIGGER owned_parameter_omit_guard BEFORE UPDATE OF specs,specs_id ON public.store_product FOR EACH ROW EXECUTE FUNCTION owned_parameter_omit_guard()");
    const before = await root(), rows = await relations(); expect((await request('POST', '/product/product/80', f.body())).status).toBe(200);
    expect((await root()).specs).toBe(before.specs); expect((await root()).specsId).toBe(before.specsId); expect(await relations()).toEqual(rows);
  }));
  it('preserves an Admin parameter snapshot update committed while an omitted save waits on the actual product row', async () => f.withWriter(async runtime => f.withPeer!(async peer => {
    const held = signal(), release = signal(), specs = JSON.stringify(supplierProductParameterRows(freeRows()));
    const holding = withTx(createContainerFromDb(peer.db), async tx => {
      await tx.update(storeProduct).set({ specsId: 0, specs }).where(eq(storeProduct.id, 80));
      await tx.delete(storeProductRelation).where(and(eq(storeProductRelation.productId, 80), eq(storeProductRelation.type, 6))); held.resolve(); await release.promise;
    });
    let saving: Promise<unknown> | undefined;
    try { await held.promise; saving = outcome(new SupplierProductManagementService(runtime.container, f.env).saveProduct(7, 80, f.body()));
      await waitForFinanceBlock(f.db, runtime.pid, peer.pid); release.resolve(); await holding; expect(await saving).toMatchObject({ ok: true }); expect(await root()).toMatchObject({ specsId: 0, specs }); expect(await relations()).toEqual([]);
    } finally { release.resolve(); await holding; await saving; }
  })));
  it.each([303,304,305,306,999])('rejects foreign wrong-type wrong-group child or missing template %i without writing', async specsId => f.withWriter(async runtime => {
    wiring.container = runtime.container; await unchanged(async () => expect((await request('POST', '/product/product/80', f.body({ specs_id: specsId, specs: freeRows() }))).status).toBe(400));
  }));
  it.each(['malformed','oversized','foreign','bad-negative','bad-parent','bad-status','duplicate-relation'] as const)('keeps %s history readable without granting authority and permits an explicit repair', async mode => f.withWriter(async runtime => {
    wiring.container = runtime.container;
    if (mode === 'malformed' || mode === 'oversized') await f.db.update(storeProduct).set({ specs: mode === 'malformed' ? '{broken' : '😀'.repeat(SUPPLIER_PARAMETER_RAW_POINTS + 1) }).where(eq(storeProduct.id, 80));
    else if (mode === 'bad-negative') await f.db.update(storeProduct).set({ specsId: -1 }).where(eq(storeProduct.id, 80));
    else if (mode === 'foreign') { await f.db.update(storeProduct).set({ specsId: 303 }).where(eq(storeProduct.id, 80)); await f.db.update(storeProductRelation).set({ relationId: 303 }).where(and(eq(storeProductRelation.productId, 80), eq(storeProductRelation.type, 6))); }
    else if (mode === 'duplicate-relation') await f.db.insert(storeProductRelation).values({ productId: 80, type: 6, relationId: 51, status: 1 });
    else await f.db.update(storeProductRelation).set(mode === 'bad-parent' ? { relationPid: 1 } : { status: 0 }).where(and(eq(storeProductRelation.productId, 80), eq(storeProductRelation.type, 6)));
    await unchanged(async () => { const read = await request('GET', '/product/product/80'); expect(read.status).toBe(200); expect(read.data.specs_selection.available).toBe(false);
      expect(read.data.specs_selection.consistent).toBe(mode === 'foreign'); expect(read.data.specs_selection.truncated).toBe(mode === 'oversized'); if (mode === 'bad-negative') { expect(read.data.specs_id).toBe(0); expect(read.data.specs_selection.specs_id).toBe(-1); } expect(JSON.stringify(read.data)).not.toMatch(/外店私有参数模板|外店私有参数名|外店私有参数值/); });
    expect((await request('POST', '/product/product/80', f.body({ specs_id: 0, specs: [] }))).status).toBe(200);
    expect((await request('GET', '/product/product/80')).data.specs_selection).toEqual({ specs_id: 0, specs: '', consistent: true, available: true, truncated: false });
  }));
  it('atomically composes parameter edits with guarantee brand label and schedule writes while preserving other hidden fields', async () => f.withWriter(async runtime => {
    wiring.container = runtime.container; const before = await root(), snapshot = await f.snapshot();
    const saved = await request('POST', '/product/product/80', f.body({ specs_id: 301, specs: freeRows(), ensure_id: [201,202], brand_id: [101,102,103], store_label_id: [31], auto_on_time: 1, auto_off_time: 2 })); expect(saved.status, saved.msg).toBe(200);
    expect(await root()).toMatchObject({ specsId: 301, specs: JSON.stringify(supplierProductParameterRows(freeRows())), ensureId: '201,202', brandId: 103, brandCom: '101,102,103', storeLabelId: '31', autoOnTime: 1, autoOffTime: 2, isShow: 0, isVerify: 0 });
    for (const key of ['labelId','commandWord','systemFormId'] as const) expect((await root())[key]).toBe(before[key]);
    expect((await f.snapshot()).store_product_relation.filter((item: SnapshotRow) => item.row.product_id === 80 && item.row.type === 4)).toEqual(snapshot.store_product_relation.filter((item: SnapshotRow) => item.row.product_id === 80 && item.row.type === 4));
    expect((await request('GET', '/product/product/80')).data).toMatchObject({ specs_id: 301, brand_id: [101,102,103], ensure_id: [201,202], specs_selection: { consistent: true, available: true } });
  }));
  it.each(['ensure','brand'] as const)('rechecks the admitted template after a later actual %s author whose executable trigger changes its owner', async mode => f.withWriter(async runtime => {
    wiring.container = runtime.container;
    // This case alone adds the catalog column the adverse trigger really uses.
    // The normal minimum writer and production privilege plan are unchanged.
    await f.exec(`GRANT UPDATE(relation_id) ON public.category TO "${runtime.role}"`);
    const [rights] = await runtime.db.execute(sql`SELECT has_column_privilege(current_user,'category','relation_id','UPDATE') AS can_move`);
    expect(rights).toEqual({ can_move: true });
    const column = mode === 'ensure' ? 'ensure_id' : 'brand_id', selected = mode === 'ensure' ? "NEW.ensure_id='201'" : 'NEW.brand_id=103';
    const author = mode === 'ensure' ? { ensure_id: [201] } : { brand_id: [101,102,103] };
    await f.exec(`CREATE FUNCTION owned_parameter_late_template() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE changed integer; BEGIN IF NEW.id=80 AND ${selected} THEN UPDATE public.category SET relation_id=8 WHERE id=302; GET DIAGNOSTICS changed=ROW_COUNT; IF changed<>1 OR NOT EXISTS(SELECT 1 FROM public.category WHERE id=302 AND relation_id=8) THEN RAISE EXCEPTION 'owned template mutation did not execute'; END IF; END IF; RETURN NEW; END $$; CREATE TRIGGER owned_parameter_late_template AFTER UPDATE OF ${column} ON public.store_product FOR EACH ROW EXECUTE FUNCTION owned_parameter_late_template()`);
    try {
      // Positive control: omission preserves old parameters, the later author
      // succeeds, and its real trigger demonstrably moves the unused template.
      const control = await request('POST', '/product/product/80', f.body(author)); expect(control.status, control.msg).toBe(200);
      expect((await f.db.select().from(legacyCategory).where(eq(legacyCategory.id, 302)))[0].relationId).toBe(8);
      await f.db.update(legacyCategory).set({ relationId: 7 }).where(eq(legacyCategory.id, 302));
      const before = await f.snapshot();
      const rejected = await request('POST', '/product/product/80', f.body({ ...author, specs_id: 302, specs: freeRows() }));
      expect(rejected.status, rejected.msg).toBe(409); expect(rejected.msg).toBe('商品参数或关联已变化，请刷新后重试'); expect(await f.snapshot()).toEqual(before);
    } finally {
      await f.exec('DROP TRIGGER owned_parameter_late_template ON public.store_product; DROP FUNCTION owned_parameter_late_template()');
      await f.exec(`REVOKE UPDATE(relation_id) ON public.category FROM "${runtime.role}"`);
    }
  }));
  it.each(['name','value'] as const)('rejects a lone surrogate in the actual ordinary POST parameter %s before any persistent write', async key => f.withWriter(async runtime => {
    wiring.container = runtime.container;
    const row = { name: '材质', value: '棉', sort: 0, [key]: key === 'name' ? '\ud800' : '\udfff' };
    await unchanged(async () => { const rejected = await request('POST', '/product/product/80', f.body({ specs_id: 0, specs: [row] })); expect(rejected.status).toBe(400); });
  }));
  it('requires current manage ownership and an unexpired actor for explicit parameters and ignores caller selected Supplier ids', async () => f.withWriter(async runtime => {
    wiring.container = runtime.container;
    await unchanged(async () => {
      for (const actor of ['viewer','denied'] as const) expect((await request('POST', '/product/product/80', f.body({ specs_id: 301, specs: freeRows(), supplier_id: 8 }), actor)).status).toBe(400011);
      expect((await request('POST', '/product/product/80', f.body({ specs_id: 301, specs: freeRows() }), 'other')).status).toBe(404);
      expect((await request('POST', '/product/product/80', f.body({ specs_id: 301, specs: freeRows() }), 'anonymous')).status).toBe(410000);
      await expect(new SupplierProductManagementService(runtime.container, f.env).saveProduct(7, 80, f.body({ specs_id: 301, specs: freeRows() }), { ...supplierProductParametersActor(), expiresAt: 1 })).rejects.toThrow();
    });
  }));
  it('rejects live role revocation NOWAIT and grants only category lock-column authority', async () => f.withWriter(async runtime => f.withPeer!(async peer => {
    wiring.container = runtime.container; const held = signal(), release = signal();
    const holding = withTx(createContainerFromDb(peer.db), async tx => { await tx.update(systemRole).set({ rules: 'supplier.product.view' }).where(eq(systemRole.id, 21)); held.resolve(); await release.promise; throw Error('owned parameter authority rollback'); }).catch(error => { if (error.message !== 'owned parameter authority rollback') throw error; });
    try { await held.promise; await unchanged(async () => expect((await request('POST', '/product/product/80', f.body({ specs_id: 301, specs: freeRows() }))).status).toBe(409)); }
    finally { release.resolve(); await holding; }
    const [rights] = await runtime.db.execute(sql`SELECT has_column_privilege(current_user,'category','id','UPDATE') AS lock_qualification,
      has_column_privilege(current_user,'category','name','UPDATE') AS edit_name,has_table_privilege(current_user,'category','INSERT,DELETE') AS insert_delete`);
    expect(rights).toEqual({ lock_qualification: true, edit_name: false, insert_delete: false });
  })));
  it.each(['moved','regrouped','nested','deleted'] as const)('rejects an actual concurrent %s template update and its committed unavailable binding', async mode => f.withWriter(async runtime => f.withPeer!(async peer => {
    wiring.container = runtime.container; const held = signal(), release = signal();
    const holding = withTx(createContainerFromDb(peer.db), async tx => {
      if (mode === 'deleted') await tx.delete(legacyCategory).where(eq(legacyCategory.id, 302));
      else await tx.update(legacyCategory).set(mode === 'moved' ? { relationId: 8 } : mode === 'regrouped' ? { group: 2 } : { ownerId: 9 }).where(eq(legacyCategory.id, 302)); held.resolve(); await release.promise;
    });
    try { await held.promise; await unchanged(async () => expect((await request('POST', '/product/product/80', f.body({ specs_id: 302, specs: freeRows() }))).status).toBe(409)); }
    finally { release.resolve(); await holding; }
    await unchanged(async () => expect((await request('POST', '/product/product/80', f.body({ specs_id: 302, specs: freeRows() }))).status).toBe(400));
  })));
  it.each(['skip-main','rewrite-main','skip-relation','deferred-plan','deferred-hidden'] as const)('rolls back actual %s trigger corruption and never returns partial parameter success', async mode => f.withWriter(async runtime => {
    const triggers = {
      'skip-main': "CREATE FUNCTION owned_parameter_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.specs_id=301 AND NEW.specs IS DISTINCT FROM OLD.specs THEN RETURN NULL; END IF; RETURN NEW; END $$; CREATE TRIGGER owned_parameter_guard BEFORE UPDATE ON public.store_product FOR EACH ROW EXECUTE FUNCTION owned_parameter_guard()",
      'rewrite-main': "CREATE FUNCTION owned_parameter_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF pg_trigger_depth()=1 AND NEW.specs_id=301 THEN UPDATE public.store_product SET specs='[]' WHERE id=NEW.id; END IF; RETURN NEW; END $$; CREATE TRIGGER owned_parameter_guard AFTER UPDATE OF specs ON public.store_product FOR EACH ROW EXECUTE FUNCTION owned_parameter_guard()",
      'skip-relation': "CREATE FUNCTION owned_parameter_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.type=6 AND NEW.relation_id=301 THEN RETURN NULL; END IF; RETURN NEW; END $$; CREATE TRIGGER owned_parameter_guard BEFORE INSERT ON public.store_product_relation FOR EACH ROW EXECUTE FUNCTION owned_parameter_guard()",
      'deferred-plan': "CREATE FUNCTION owned_parameter_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.specs_id=301 AND NEW.specs IS DISTINCT FROM OLD.specs THEN UPDATE public.store_product SET auto_on_time=1 WHERE id=NEW.id; END IF; RETURN NEW; END $$; CREATE CONSTRAINT TRIGGER owned_parameter_guard AFTER UPDATE ON public.store_product DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION owned_parameter_guard()",
      'deferred-hidden': "CREATE FUNCTION owned_parameter_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.specs_id=301 AND NEW.specs IS DISTINCT FROM OLD.specs THEN UPDATE public.store_product_relation SET status=0 WHERE product_id=NEW.id AND type=5; END IF; RETURN NEW; END $$; CREATE CONSTRAINT TRIGGER owned_parameter_guard AFTER UPDATE ON public.store_product DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION owned_parameter_guard()",
    };
    if (mode === 'deferred-hidden') await f.exec(`GRANT UPDATE(status) ON public.store_product_relation TO "${runtime.role}"`);
    await f.exec(triggers[mode]); wiring.container = runtime.container; const before = await f.snapshot();
    expect((await request('POST', '/product/product/80', f.body({ specs_id: 301, specs: freeRows() }))).status).toBe(409); expect(await f.snapshot()).toEqual(before);
  }));
});

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('Supplier newly authored free snapshots compose with actual complete-copy and keep default generic contracts', () => {
  let f: Awaited<ReturnType<typeof supplierProductCopyFixture>>;
  beforeAll(async () => { f = await supplierProductCopyFixture();
    // The ordinary writer uses this existing ORM composite conflict identity.
    // Add it only to this new owned composition fixture, never production.
    await f.exec('CREATE UNIQUE INDEX owned_parameter_copy_description ON public.store_product_description(product_id,type)');
  }, 60000);
  beforeEach(async () => { await f.reset(); vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Owned parameter copy forbids outbound I/O')); }, 60000);
  afterEach(() => { expect(fetch).not.toHaveBeenCalled(); vi.restoreAllMocks(); });
  afterAll(async () => { await f?.close(); }, 30000);
  const root = async (id = 80) => (await f.db.select().from(storeProduct).where(eq(storeProduct.id, id)))[0];
  async function authored(template = 51) {
    const seed = await f.service.seed(80, supplierCopyActor());
    await new SupplierProductManagementService(f.container, { APP_KEY: 'owned-native-supplier-product-copy-key' }).saveProduct(20, 80,
      { ...seed.product, specs_id: template, specs: freeRows() }, supplierCopyActor());
    return root();
  }
  it.each([51, 0])('copies the actual ordinary writer free five-field snapshot with template %i, retains source bytes, then replays the original UUID', async template => {
    const source = await authored(template), before = await f.snapshot(), body = await f.body(80);
    const saved = await f.service.save(80, body, supplierCopyActor()); expect(saved.state).toBe('committed');
    const copied = await root(saved.result!.id); expect(copied).toMatchObject({ specsId: template, specs: source.specs, isShow: 0, isVerify: 0, type: 2, relationId: 20 });
    const relations = await f.db.select().from(storeProductRelation).where(and(eq(storeProductRelation.productId, copied.id), eq(storeProductRelation.type, 6)));
    expect(relations.map(row => ({ id: row.relationId, pid: row.relationPid, status: row.status }))).toEqual(template ? [{ id: template, pid: 0, status: 1 }] : []);
    expect(await root()).toEqual(source); const after = await f.snapshot(); for (const [name, rows] of Object.entries(before)) for (const row of rows) expect(after[name], name).toContainEqual(row);
    expect(await f.service.save(80, body, supplierCopyActor())).toEqual(saved); expect(await f.service.receipt(body.operation_id, supplierCopyActor())).toEqual(saved); expect(await f.snapshot()).toEqual(after);
  });
  it('copies a deliberately empty authored snapshot without requiring the template seed names to return', async () => {
    const seed = await f.service.seed(80, supplierCopyActor());
    await new SupplierProductManagementService(f.container, { APP_KEY: 'owned-native-supplier-product-copy-key' }).saveProduct(20, 80,
      { ...seed.product, specs_id: 51, specs: [] }, supplierCopyActor());
    const source = await root(), body = await f.body(80); expect(source).toMatchObject({ specsId: 51, specs: '' });
    await withTx(f.container, async tx => {
      await lockProductSaveTables(tx); const empty = await captureSupplierProductParameterCopy(tx, 20, source); expect(empty).toBeDefined();
      expect(() => supplierProductParameterCopyRows(empty!, 51, '{broken')).toThrow();
      expect(() => supplierProductParameterCopyRows(empty!, 51, '0')).toThrow();
    });
    const receipt = await f.service.save(80, body, supplierCopyActor()); expect(await root(receipt.result!.id)).toMatchObject({ specsId: 51, specs: '' }); expect(await root()).toEqual(source);
  });
  it('copies a newly authored free snapshot through an independent non-owner LOGIN using the existing complete-writer grant surface', async () => {
    const source = await authored(0), originUrl = validateFinanceFixtureUrl(process.env.TEST_FINANCE_POSTGRES_URL ?? '');
    const [origin] = await f.db.execute(sql`SELECT current_database() AS database`);
    const role = 'owned_parameter_copy_' + randomUUID().replaceAll('-', ''), password = randomUUID().replaceAll('-', '');
    let client: ReturnType<typeof postgres> | undefined;
    try {
      await f.exec(`CREATE ROLE "${role}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`);
      await f.exec(`GRANT CONNECT ON DATABASE "${origin.database}" TO "${role}"; GRANT USAGE ON SCHEMA public TO "${role}"; GRANT SELECT ON ALL TABLES IN SCHEMA public TO "${role}"; GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO "${role}"`);
      const locked = ['system_admin','system_supplier','system_role','system_menus','system_config','shipping_templates','system_form','user_label',
        'store_product_category','store_brand','store_product_label','store_product_ensure','category','store_product_specs','store_coupon_issue','system_attachment',
        'store_product','store_product_attr_value','store_cart','store_product_relation','store_product_attr','store_product_attr_result','store_product_description',
        'store_product_virtual','store_product_stock_record','store_product_coupon','store_discounts_products','store_seckill','store_combination','store_bargain','store_integral','system_log','store_order_outbox'];
      await f.exec(`GRANT UPDATE ON ${locked.join(',')} TO "${role}"; GRANT INSERT ON store_product,store_product_attr_value,store_product_relation,store_product_attr,store_product_attr_result,store_product_description,store_product_stock_record,store_product_coupon,system_log,store_order_outbox,supplier_product_copy_operation_v1 TO "${role}"; GRANT DELETE ON store_product_attr,store_product_attr_result,store_product_description,store_product_relation,store_product_coupon TO "${role}"`);
      originUrl.pathname = '/' + origin.database; originUrl.username = role; originUrl.password = password;
      client = postgres(originUrl.href, { max: 1, prepare: false, connect_timeout: 5, idle_timeout: 0, max_lifetime: 0,
        connection: { options: '-c search_path=public,pg_temp -c statement_timeout=10000 -c lock_timeout=2000' } });
      const [identity] = await client`SELECT current_user AS role,session_user AS session,current_setting('server_version_num') AS version`;
      expect(identity).toMatchObject({ role, session: role }); expect(Math.floor(Number(identity.version) / 10000)).toBe(16);
      const runtime = new SupplierProductCopyService(createContainerFromDb(drizzle(client) as unknown as DbClient), 'owned-native-supplier-product-copy-key');
      const body = await f.body(80), receipt = await runtime.save(80, body, supplierCopyActor()); expect(receipt.state).toBe('committed');
      expect(await root(receipt.result!.id)).toMatchObject({ specsId: 0, specs: source.specs }); expect(await root()).toEqual(source);
      const [rights] = await client`SELECT has_table_privilege(current_user,'supplier_product_copy_operation_v1','INSERT') AS receipt_insert,
        has_table_privilege(current_user,'supplier_product_copy_operation_v1','UPDATE,DELETE') AS receipt_rewrite,
        has_table_privilege(current_user,'store_order','UPDATE') AS order_update,has_table_privilege(current_user,'user_bill','INSERT') AS financial_insert`;
      expect(rights).toEqual({ receipt_insert: true, receipt_rewrite: false, order_update: false, financial_insert: false });
    } finally { await client?.end({ timeout: 5 }); await f.exec(`DROP OWNED BY "${role}"; DROP ROLE "${role}"`); }
  }, 60000);
  it('keeps both generic and ordinary Admin duplicate/signed/template0 rejection with no body mode or fake object granting copy authority', async () => {
    await authored(0); const before = await f.snapshot();
    await expect(new ProductAssociationService(f.container).save(0, { store_name: 'generic', cate_id: [11], specs_id: 0, specs: freeRows(), supplierParameterCopy: {}, price: '1.00', stock: 0 }, { id: 1, name: '', ip: '' })).rejects.toThrow();
    await expect(new AdminLegacyProductSaveService(f.container).save(0, editorProduct({ supplier_id: 20, cate_id: [11], specs_id: 0, specs: freeRows(), supplierParameterCopy: {} }), legacySaveActor())).rejects.toThrow();
    expect(() => normalizeAdminLegacyProductInput(editorProduct({ supplier_id: 20, cate_id: [11], specs_id: 0, specs: freeRows() }), { supplierParameterCopy: {} as never })).toThrow();
    expect(await f.snapshot()).toEqual(before);
  });
  it('binds actual copy to full source MAC and rejects changed parameters, a fake token, foreign identity and hidden author payload overrides', async () => {
    const source = await authored(), body = await f.body(80);
    await f.db.update(storeProduct).set({ specs: JSON.stringify(supplierProductParameterRows([{ name: '变化来源', value: '新值' }])) }).where(eq(storeProduct.id, 80));
    const changed = await f.snapshot(); await expect(f.service.save(80, body, supplierCopyActor())).rejects.toMatchObject({ code: 409 }); expect(await f.snapshot()).toEqual(changed);
    await f.db.update(storeProduct).set({ specs: source.specs }).where(eq(storeProduct.id, 80));
    const before = await f.snapshot(); await expect(f.service.save(80, { ...body, copy_token: 'a'.repeat(64) }, supplierCopyActor())).rejects.toMatchObject({ code: 409 });
    await expect(f.service.save(80, body, supplierCopyActor(31))).rejects.toThrow();
    await expect(f.service.save(80, { ...body, product: { ...body.product, specs_id: 0, specs: [] } }, supplierCopyActor())).rejects.toThrow(); expect(await f.snapshot()).toEqual(before);
  });
  it('checks an opaque capability against the same actual transaction, target zero, exact owner and unchanged locked source', async () => {
    const source = await authored(); let captured: Awaited<ReturnType<typeof captureSupplierProductParameterCopy>>;
    await withTx(f.container, async tx => {
      await lockProductSaveTables(tx);
      captured = await captureSupplierProductParameterCopy(tx, 20, source); expect(captured).toBeDefined(); expect(JSON.stringify(captured)).toBe('{}');
      expect(supplierProductParameterCopyRows(captured!, 51, JSON.parse(source.specs!))).toEqual(supplierProductParameterRows(freeRows()));
      await expect(assertSupplierProductParameterCopy(tx, captured!, { type: 2, relationId: 30 }, 0, 51, JSON.parse(source.specs!))).rejects.toThrow();
      await expect(assertSupplierProductParameterCopy(tx, captured!, { type: 2, relationId: 20 }, 80, 51, JSON.parse(source.specs!))).rejects.toThrow();
      expect(() => supplierProductParameterCopyRows(JSON.parse(JSON.stringify(captured)) as never, 51, JSON.parse(source.specs!))).toThrow();
      await tx.update(storeProduct).set({ specs: '[]' }).where(eq(storeProduct.id, 80));
      await expect(assertSupplierProductParameterCopy(tx, captured!, { type: 2, relationId: 20 }, 0, 51, JSON.parse(source.specs!))).rejects.toMatchObject({ code: 409 });
    });
    await withTx(f.container, async tx => { await expect(assertSupplierProductParameterCopy(tx, captured!, { type: 2, relationId: 20 }, 0, 51, JSON.parse(source.specs!))).rejects.toThrow(); });
  });
  it.each(['main','relation','template-moved','template-group','template-nested','template-deleted','ensure-disabled','ensure-moved','audit','outbox'] as const)('rolls back a deferred %s mutation after the actual free-parameter copy receipt is inserted', async mode => {
    await authored(); const body = await f.body(80), before = await f.snapshot();
    const mutations = {
      main: "UPDATE public.store_product SET specs='[]' WHERE id=NEW.id",
      'template-moved': "UPDATE public.category SET relation_id=30 WHERE id=51",
      'template-group': "UPDATE public.category SET \"group\"=2 WHERE id=51",
      'template-nested': "UPDATE public.category SET owner_id=1 WHERE id=51",
      'template-deleted': "DELETE FROM public.category WHERE id=51",
      'ensure-disabled': "UPDATE public.store_product_ensure SET status=0 WHERE id=41",
      'ensure-moved': "UPDATE public.store_product_ensure SET type=2,relation_id=30 WHERE id=41",
      audit: "UPDATE public.system_log SET action='deferred-audit-corruption' WHERE path='product/product/0' AND type='product_save' AND (action::jsonb->>'productId')::integer=NEW.id",
      outbox: "UPDATE public.store_order_outbox SET last_error='deferred-outbox-corruption' WHERE aggregate_type='product' AND aggregate_id=NEW.id",
    };
    const relation = mode === 'relation', table = relation ? 'public.store_product_relation' : 'public.store_product';
    const statements = mode === 'relation'
      ? "CREATE FUNCTION owned_parameter_copy_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.product_id>82 AND NEW.type=6 THEN UPDATE public.store_product_relation SET status=0 WHERE product_id=NEW.product_id AND type=5; END IF; RETURN NEW; END $$; CREATE CONSTRAINT TRIGGER owned_parameter_copy_guard AFTER INSERT ON public.store_product_relation DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION owned_parameter_copy_guard()"
      : `CREATE FUNCTION owned_parameter_copy_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id>82 AND NEW.specs LIKE '%新增参数%' THEN ${mutations[mode]}; END IF; RETURN NEW; END $$; CREATE CONSTRAINT TRIGGER owned_parameter_copy_guard AFTER INSERT ON public.store_product DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION owned_parameter_copy_guard()`;
    await f.exec(statements);
    try {
      await expect(f.service.save(80, body, supplierCopyActor())).rejects.toMatchObject({ code: 409 }); expect(await f.snapshot()).toEqual(before);
      const [receipt] = await f.db.execute(sql`SELECT count(*)::integer AS count FROM public.supplier_product_copy_operation_v1 WHERE operation_id=${body.operation_id}::uuid`);
      expect(receipt).toEqual({ count: 0 }); expect((await f.service.receipt(body.operation_id, supplierCopyActor())).state).toBe('unknown'); expect(await f.snapshot()).toEqual(before);
    } finally { await f.exec('DROP TRIGGER owned_parameter_copy_guard ON ' + table + '; DROP FUNCTION owned_parameter_copy_guard()'); }
  });
  it('retains the mature disabled-assurance new-copy rejection after free parameter authoring', async () => {
    await authored(); await f.exec('UPDATE store_product_ensure SET status=0 WHERE id=41'); const before = await f.snapshot(), body = await f.body(80);
    await expect(f.service.save(80, body, supplierCopyActor())).rejects.toThrow('保障服务已停用'); expect(await f.snapshot()).toEqual(before);
  });
  it('recovers actual committed free parameters after a lost transport response without a second product or snapshot write', async () => {
    const source = await authored(0), body = await f.body(80); let dropped = false;
    const lost = new Proxy(f.db, { get(target, key) { const operation = Reflect.get(target, key);
      if (key === 'transaction') return async (...args: unknown[]) => { const result = await Reflect.apply(operation, target, args); if (!dropped) { dropped = true; throw Error('owned parameter COMMIT response lost'); } return result; };
      return typeof operation === 'function' ? operation.bind(target) : operation;
    } });
    await expect(new SupplierProductCopyService(createContainerFromDb(lost), 'owned-native-supplier-product-copy-key').save(80, body, supplierCopyActor())).rejects.toThrow('COMMIT response lost');
    const receipt = await f.service.receipt(body.operation_id, supplierCopyActor()); expect(receipt.state).toBe('committed'); expect(await root(receipt.result!.id)).toMatchObject({ specsId: 0, specs: source.specs });
    const before = await f.snapshot(); expect(await f.service.save(80, body, supplierCopyActor())).toEqual(receipt); expect(await f.snapshot()).toEqual(before);
  });
});
