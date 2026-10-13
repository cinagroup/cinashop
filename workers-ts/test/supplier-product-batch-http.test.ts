import { eq, and } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/env';
import { createApp } from '../src/app';
import { createContainerFromDb } from '../src/lib/di';
import { storeProduct, storeProductAttrValue, storeProductCategory, storeProductRelation, systemLog, systemRole, systemAdmin, systemMenus } from '../src/models/schema';
import { SupplierProductBatchService } from '../src/services/supplier/SupplierProductBatchService';
import { createToken, md5 } from '../src/utils/jwt';
import * as cache from '../src/utils/cache';
import { financePostgres } from './helpers/financePostgres';
import { seedSupplierBatch, supplierBatchTables, supplierBatchActor } from './helpers/supplierProductBatchFixture';

const wiring = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock('@/lib/di', async original => ({ ...await original<typeof import('@/lib/di')>(), createContainer: wiring.open }));

const base = '/supplierapi/product/batch_process', selectionPath = '/supplierapi/product/product/batch-selection';
const env = { APP_KEY: 'isolated-supplier-batch-http', UPSTASH_REDIS_URL: '', UPSTASH_REDIS_TOKEN: '' } as Env;
describe('Supplier batch registered createApp with actual JWT/RBAC/SQL contracts', () => {
  let f: Awaited<ReturnType<typeof financePostgres>>, app: ReturnType<typeof createApp>, service: SupplierProductBatchService;
  let tokens: Record<string, string>;
  beforeAll(async () => {
    f = await financePostgres(supplierBatchTables); const container = createContainerFromDb(f.db);
    service = new SupplierProductBatchService(container); wiring.open.mockImplementation(() => container); app = createApp();
  }, 60000);
  afterAll(async () => { await f?.close(); }, 30000);
  beforeEach(async () => {
    vi.spyOn(cache, 'getTokenBucket').mockResolvedValue(null); vi.spyOn(cache, 'clearToken').mockResolvedValue(false);
    vi.stubGlobal('fetch', vi.fn(async () => { throw Error('External I/O forbidden'); })); await seedSupplierBatch(f);
    tokens = { manager: (await createToken(21, 'supplier', md5(''), env.APP_KEY)).token,
      reader: (await createToken(22, 'supplier', md5(''), env.APP_KEY)).token, other: (await createToken(31, 'supplier', md5(''), env.APP_KEY)).token };
  }, 30000);
  afterEach(() => { expect(fetch).not.toHaveBeenCalled(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  async function request(method: string, path: string, data?: unknown, role = 'manager') {
    const response = await app.request(path, { method, headers: { ...(tokens[role] ? { Authorization: `Bearer ${tokens[role]}` } : {}),
      'X-Supplier-Id': '30', ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) }, env);
    return { response, body: await response.json<{ status: number; msg: string; data: any }>() };
  }
  async function read(ids: number[] = [1, 2], role = 'manager') { return request('GET', `${selectionPath}?ids=${ids.join(',')}`, undefined, role); }
  const post = (type: number, data: Record<string, unknown>, extra: Record<string, unknown> = {}) => request('POST', base, { type, ids: [1, 2], all: 0, data, ...extra });
  const logs = () => f.db.select().from(systemLog).orderBy(systemLog.id);
  function expectPrivate(response: Response) {
    expect(response.headers.get('cache-control')).toContain('private, no-store');
    expect(response.headers.get('pragma')).toBe('no-cache');
  }
  it('reads complete owned selected facts and revision with view-only authority and no writes', async () => {
    const result = await read([1, 2], 'reader'); expect(result.body.status).toBe(200);
    expectPrivate(result.response);
    expect(result.body.data).toMatchObject({ ids: [1, 2], count: 2, products: [{ id: 1, cate_id: '101', delivery_type: '1' }, { id: 2 }] });
    expect(result.body.data.revision).toMatch(/^[a-f0-9]{64}$/); expect(await logs()).toEqual([]);
  });
  it('replaces only owned category bindings with current parents and each product show state', async () => {
    const before = await f.db.select().from(storeProduct), skus = await f.db.select().from(storeProductAttrValue);
    const result = await post(1, { cate_id: [110, 101] }, { expected_revision: (await read()).body.data.revision });
    expect(result.body.data).toMatchObject({ verified: true, updated: 2 });
    expectPrivate(result.response);
    const after = await f.db.select().from(storeProduct).orderBy(storeProduct.id);
    expect(after.slice(0, 2)).toEqual(before.slice(0, 2).map(row => ({ ...row, cateId: '101,110' })));
    expect(after.slice(2)).toEqual(before.slice(2)); expect(await f.db.select().from(storeProductAttrValue)).toEqual(skus);
    expect((await f.db.select().from(storeProductRelation).where(and(eq(storeProductRelation.productId, 2), eq(storeProductRelation.type, 1)))).map(row => [row.relationId, row.relationPid, row.status])).toEqual([[101, 100, 0], [110, 0, 0]]);
    expect((await f.db.select().from(storeProductRelation).where(eq(storeProductRelation.id, 3)))[0].relationId).toBe(501);
    expect((await logs())[0]).toMatchObject({ method: 'POST', merchantId: 20, type: 'supplier_product_batch' });
  });
  it('updates delivery alone, preserving price, inventory, category and all unrelated columns', async () => {
    const before = await f.db.select().from(storeProduct).orderBy(storeProduct.id);
    expect((await post(3, { delivery_type: [3, 1, 2] })).body.data.verified).toBe(true);
    expect(await f.db.select().from(storeProduct).orderBy(storeProduct.id)).toEqual(before.map(row => row.id <= 2 ? { ...row, deliveryType: '1,2,3' } : row));
  });
  it('pins and parses the active first-party form and supports explicit zero removal', async () => {
    expect((await post(7, { system_form_id: 50 })).body.status).toBe(200);
    expect((await read()).body.data.products.map((row: any) => row.system_form_id)).toEqual([50, 50]);
    expect((await post(7, { system_form_id: 0 })).body.status).toBe(200);
    expect((await read()).body.data.products.map((row: any) => row.system_form_id)).toEqual([0, 0]);
  });
  it('implements all three freight modes and clears unselected incompatible freight columns', async () => {
    expect((await post(8, { freight: 3, temp_id: 60, postage: '9.99' })).body.status).toBe(200);
    expect((await read()).body.data.products[0]).toMatchObject({ freight: 3, temp_id: 60, postage: '0.00' });
    expect((await post(8, { freight: 2, postage: '1.25', temp_id: 61 })).body.status).toBe(200);
    expect((await read()).body.data.products[0]).toMatchObject({ freight: 2, temp_id: 0, postage: '1.25' });
    expect((await post(8, { freight: 1, postage: '10', temp_id: 61 })).body.status).toBe(200);
    expect((await read()).body.data.products[0]).toMatchObject({ freight: 1, temp_id: 0, postage: '0.00' });
  });
  it('supports legacy filtered all selection and ignores request ownership claims', async () => {
    const where = { store_name: 'physical-', type: 1, supplier_id: 30, relation_id: 30, page: 1, limit: 1, sales: 'desc' };
    const result = await post(3, { delivery_type: [2] }, { all: 1, ids: [], where });
    expect(result.body.data.ids).toEqual([1]); expect((await read()).body.data.products[1].delivery_type).toBe('1');
    expect((await f.db.select().from(storeProduct).where(eq(storeProduct.id, 7)))[0].deliveryType).toBe('');
  });
  it('uses real category/brand/label relations, one child expansion, SKU barcode and Shanghai dates', async () => {
    for (const where of [{ cate_id: [100], brand_id: [501], store_label_id: [601] }, { store_name: 'SKUNEEDLE' },
      { store_name: 'needle', data: '2026-08-08 - 2026-08-08' }]) {
      const result = await request('GET', `${selectionPath}?all=1&where=${encodeURIComponent(JSON.stringify(where))}`);
      expect(result.body.data.ids).toEqual([1]);
    }
    const grandchildren = await request('GET', `${selectionPath}?all=1&where=${encodeURIComponent(JSON.stringify({ cate_id: [100] }))}`);
    expect(grandchildren.body.data.ids).toEqual([1]);
  });
  it('rejects the entire batch if any selected ID is foreign, missing, recycled or unsupported', async () => {
    for (const id of [5, 6, 7, 8, 9, 999999]) {
      const result = await post(3, { delivery_type: [2] }, { ids: [1, id] });
      expect([400, 404]).toContain(result.body.status);
    }
    expect((await read([1])).body.data.products[0].delivery_type).toBe('1'); expect(await logs()).toEqual([]);
  });
  it('keeps the legacy primary-brand constraint and never broadens a parent brand to its leaf products', async () => {
    await f.db.update(storeProduct).set({ brandId: 3, brandCom: '1,2,3' }).where(eq(storeProduct.id, 1));
    await f.db.update(storeProductRelation).set({ relationId: 3 }).where(eq(storeProductRelation.id, 3));
    await f.db.insert(storeProductRelation).values([{ id: 6, productId: 1, type: 2, relationId: 1 }, { id: 7, productId: 1, type: 2, relationId: 2 }]);
    expect((await post(3, { delivery_type: [2] }, { all: 1, ids: [], where: { brand_id: [1], store_name: 'alpha' } })).body.status).toBe(400);
    expect((await read([1])).body.data.products[0].delivery_type).toBe('1'); expect(await logs()).toEqual([]);
    expect((await post(3, { delivery_type: [2] }, { all: 1, ids: [], where: { brand_id: [3], store_name: 'alpha' } })).body.data.ids).toEqual([1]);
  });
  it('keeps supported card/manual category and form operations but refuses physical logistics on them', async () => {
    expect((await post(1, { cate_id: [110] }, { ids: [3, 4] })).body.status).toBe(200);
    expect((await post(7, { system_form_id: 50 }, { ids: [3, 4] })).body.status).toBe(200);
    for (const type of [3, 8]) expect((await post(type, { delivery_type: [1], freight: 1 }, { ids: [3] })).body.status).toBe(400);
  });
  it('refuses disabled, foreign, platform and malformed category parents atomically', async () => {
    for (const id of [120, 200, 300, 999999]) expect((await post(1, { cate_id: [id] })).body.status).toBe(400);
    await f.db.update(storeProductCategory).set({ isShow: 0 }).where(eq(storeProductCategory.id, 100));
    expect((await post(1, { cate_id: [101] })).body.status).toBe(400); expect(await logs()).toEqual([]);
  });
  it('refuses foreign/platform/inactive/deleted shipping templates with no partial updates', async () => {
    for (const id of [61, 62, 63, 64, 999999]) expect((await post(8, { freight: 3, temp_id: id })).body.status).toBe(400);
    expect((await read()).body.data.products.map((row: any) => row.freight)).toEqual([1, 1]); expect(await logs()).toEqual([]);
  });
  it('refuses malformed, inactive and missing form definitions and keeps old form IDs', async () => {
    for (const id of [51, 52, 999999]) expect((await post(7, { system_form_id: id })).body.status).toBe(400);
    expect(await logs()).toEqual([]);
  });
  it('rejects stale full selection facts and exposes a separate recovery read after a successful write', async () => {
    const revision = (await read()).body.data.revision;
    expect((await post(3, { delivery_type: [2] }, { expected_revision: revision })).body.status).toBe(200);
    expect((await post(7, { system_form_id: 50 }, { expected_revision: revision })).response.status).toBe(409);
    const recovered = await read(); expect(recovered.body.data.products.map((row: any) => row.delivery_type)).toEqual(['2', '2']);
    expect(recovered.body.data.revision).not.toBe(revision); expect(await logs()).toHaveLength(1);
  });
  it('fails closed on invalid selection/data, unknown operation, SQL-like filters and duplicate queries', async () => {
    for (const body of [{ type: 2, ids: [1], data: {} }, { type: 3, ids: [1], data: { delivery_type: [4] } },
      { type: 8, ids: [1], data: { freight: 2, postage: '1.001' } }, { type: 3, ids: [1], all: 2, data: { delivery_type: [1] } },
      { type: 3, all: 1, where: { sql: 'true' }, data: { delivery_type: [1] } }, { type: 3, ids: [1], expected_revision: 'stale', data: { delivery_type: [1] } }]) {
      expect((await request('POST', base, body)).body.status).toBe(400);
    }
    expect((await request('GET', `${selectionPath}?ids=1&ids=2`)).body.status).toBe(400); expect(await logs()).toEqual([]);
  });
  it('rejects filter-all capacity overflow instead of silently applying a truncated page', async () => {
    await f.db.insert(storeProduct).values(Array.from({ length: 101 }, (_, i) => ({ id: 1000 + i, type: 2, relationId: 20, storeName: 'capacity', freight: 1 })));
    const result = await post(3, { delivery_type: [2] }, { all: 1, ids: [], where: { store_name: 'capacity' } });
    expect(result.response.status).toBe(503); expect(await logs()).toEqual([]);
    expect((await f.db.select().from(storeProduct).where(eq(storeProduct.id, 1000)))[0].deliveryType).toBe('');
  });
  it('gates writes and keeps anonymous failures plus view-only reads private/no-store', async () => {
    const denied = await request('POST', base, { type: 3, ids: [1], data: { delivery_type: [1] } }, 'reader');
    expect(denied.body.status).toBe(400011); expectPrivate(denied.response);
    for (const [method, path] of [['GET', `${selectionPath}?ids=1`], ['POST', base]]) {
      const result = await request(method, path, method === 'POST' ? { type: 3, ids: [1], data: {} } : undefined, 'anonymous');
      expect(result.body.status).toBe(410000); expectPrivate(result.response);
    }
    expect(await logs()).toEqual([]);
  });
  it('rechecks password claims, expiry, and current role after the outer HTTP authorization', async () => {
    const actor = supplierBatchActor(); await f.db.update(systemAdmin).set({ pwd: 'rotated' }).where(eq(systemAdmin.id, 21));
    await expect(service.apply(20, { type: 3, ids: [1], data: { delivery_type: [1] } }, actor)).rejects.toMatchObject({ code: 410001 });
    await expect(service.apply(20, { type: 3, ids: [1], data: { delivery_type: [1] } }, { ...actor, authVersion: md5('rotated'), expiresAt: 1 })).rejects.toMatchObject({ code: 410001 });
    await f.db.update(systemRole).set({ status: 0 }).where(eq(systemRole.id, 21));
    await expect(service.apply(20, { type: 3, ids: [1], data: { delivery_type: [1] } }, { ...actor, authVersion: md5('rotated') })).rejects.toMatchObject({ code: 400011 });
    expect(await logs()).toEqual([]);
  });
  it('does not turn the legacy numeric GET selection menu into product manage', async () => {
    await f.db.insert(systemMenus).values({ id: 900, type: 4, authType: 2, access: 1, apiUrl: selectionPath, methods: 'GET' });
    await f.db.update(systemRole).set({ rules: '900' }).where(eq(systemRole.id, 21));
    expect((await read()).body.status).toBe(200); expect((await post(3, { delivery_type: [2] })).body.status).toBe(400011); expect(await logs()).toEqual([]);
  });
  it('rechecks current claims and view authority in the read-only recovery transaction', async () => {
    const actor = supplierBatchActor();
    await f.db.update(systemAdmin).set({ pwd: 'rotated' }).where(eq(systemAdmin.id, 21));
    await expect(service.selection(20, { ids: [1] }, actor)).rejects.toMatchObject({ code: 410001 });
    await f.db.update(systemRole).set({ status: 0 }).where(eq(systemRole.id, 21));
    await expect(service.selection(20, { ids: [1] }, { ...actor, authVersion: md5('rotated') })).rejects.toMatchObject({ code: 400011 });
    expect(await logs()).toEqual([]);
  });
  it('rolls back products and category relations when the real transactional audit insert fails', async () => {
    const old = await f.db.select().from(storeProduct), relations = await f.db.select().from(storeProductRelation);
    await f.exec("CREATE FUNCTION batch_fixture_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture rollback'; END $$; CREATE TRIGGER batch_fixture_audit_failure BEFORE INSERT ON system_log FOR EACH ROW EXECUTE FUNCTION batch_fixture_audit_failure()");
    try { expect((await post(1, { cate_id: [110] })).body.status).toBe(500);
      expect(await f.db.select().from(storeProduct)).toEqual(old); expect(await f.db.select().from(storeProductRelation)).toEqual(relations);
    } finally { await f.exec('DROP TRIGGER batch_fixture_audit_failure ON system_log; DROP FUNCTION batch_fixture_audit_failure()'); }
  });
  it.each(['skip', 'rewrite'])('rolls back business writes when an audit trigger silently %s the actual insert', async mode => {
    const before = await f.db.select().from(storeProduct), relations = await f.db.select().from(storeProductRelation);
    const behavior = mode === 'skip' ? 'RETURN NULL;' : "NEW.action := 'unexpected audit'; RETURN NEW;";
    await f.exec(`CREATE FUNCTION batch_fixture_audit_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ${behavior} END $$; CREATE TRIGGER batch_fixture_audit_receipt BEFORE INSERT ON system_log FOR EACH ROW EXECUTE FUNCTION batch_fixture_audit_receipt()`);
    try { expect((await post(1, { cate_id: [110] })).body.status).toBe(500);
      expect(await f.db.select().from(storeProduct)).toEqual(before); expect(await f.db.select().from(storeProductRelation)).toEqual(relations); expect(await logs()).toEqual([]);
    } finally { await f.exec('DROP TRIGGER batch_fixture_audit_receipt ON system_log; DROP FUNCTION batch_fixture_audit_receipt()'); }
  });
  it.each(['price', 'stock'])('rejects a real product trigger changing unselected %s and repeatedly rolls back', async field => {
    const before = await f.db.select().from(storeProduct);
    await f.exec(`CREATE FUNCTION batch_fixture_product_tamper() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.${field} := NEW.${field} + 1; RETURN NEW; END $$; CREATE TRIGGER batch_fixture_product_tamper BEFORE UPDATE ON store_product FOR EACH ROW EXECUTE FUNCTION batch_fixture_product_tamper()`);
    try { for (let i = 0; i < 2; i++) { expect((await post(3, { delivery_type: [2] })).body.status).toBe(500);
      expect(await f.db.select().from(storeProduct)).toEqual(before); expect(await logs()).toEqual([]); }
    } finally { await f.exec('DROP TRIGGER batch_fixture_product_tamper ON store_product; DROP FUNCTION batch_fixture_product_tamper()'); }
  });
  it('rechecks the complete product facts after an audit trigger attempts an unselected price mutation', async () => {
    const before = await f.db.select().from(storeProduct);
    await f.exec("CREATE FUNCTION batch_fixture_audit_tamper() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN UPDATE store_product SET price=price+1 WHERE id=1; RETURN NEW; END $$; CREATE TRIGGER batch_fixture_audit_tamper BEFORE INSERT ON system_log FOR EACH ROW EXECUTE FUNCTION batch_fixture_audit_tamper()");
    try { expect((await post(3, { delivery_type: [2] })).body.status).toBe(500);
      expect(await f.db.select().from(storeProduct)).toEqual(before); expect(await logs()).toEqual([]);
    } finally { await f.exec('DROP TRIGGER batch_fixture_audit_tamper ON system_log; DROP FUNCTION batch_fixture_audit_tamper()'); }
  });
});
