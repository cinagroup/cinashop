import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, getTableName, sql } from 'drizzle-orm';
import { createApp } from '@/app';
import { errorHandler } from '@/middleware/error';
import type { Env } from '@/env';
import { createContainerFromDb } from '@/lib/di';
import { createToken, md5 } from '@/utils/jwt';
import { storeCart, storeProduct, storeProductCategory, storeProductDescription, storeProductAttr,
  storeProductAttrValue, storeProductAttrResult, storeProductStockRecord, storeProductVirtual, storeProductRelation, systemAdmin, systemRole } from '@/models/schema';
import { supplierLabelTables, seedSupplierLabels } from './helpers/supplierProductLabels';
import { financePostgres } from './helpers/financePostgres';

const wiring = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock('@/lib/di', async original => ({ ...await original<typeof import('@/lib/di')>(), createContainer: wiring.open }));
const env = { APP_KEY: 'owned-supplier-label-binding-http', UPSTASH_REDIS_URL: '', UPSTASH_REDIS_TOKEN: '' } as Env;
const tables = [...supplierLabelTables, storeProductCategory, storeCart, storeProductDescription, storeProductAttr,
  storeProductAttrValue, storeProductAttrResult, storeProductStockRecord, storeProductVirtual];
const input = (changes: Record<string, unknown> = {}) => ({ product_type: 0, store_name: '标签商品实价编辑',
  cate_id: [12], slider_image: ['/isolated.png'], freight: 1, spec_type: 0, attrs: [{ suk: '默认', price: '15.55', settle_price: '8.88', stock: 7 }], ...changes });

describe('Supplier actual product save and detail keep label CSV and real type=3 facts in one transaction', () => {
  let f: Awaited<ReturnType<typeof financePostgres>>, tokens: Record<number, string>;
  let lastError: unknown;
  const app = createApp();
  beforeAll(async () => { f = await financePostgres(tables, { namespace: 'public' });
    // The minimal fixture creates table columns; install the actual 0016
    // description conflict target used by the unchanged product writer.
    await f.exec('CREATE UNIQUE INDEX spd_product_type_unique ON store_product_description(product_id,type)');
    wiring.open.mockImplementation(() => createContainerFromDb(f.db));
    app.onError((error,c) => { lastError=error; return errorHandler(error,c); }); }, 60000);
  afterAll(async () => { await f?.close(); }, 30000);
  beforeEach(async () => {
    await f.reset(); await seedSupplierLabels(f.db); vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('External I/O forbidden'));
    await f.db.insert(storeProductCategory).values({ id: 12, type: 2, relationId: 20, cateName: '商品分类' });
    await f.db.update(storeProduct).set({ storeLabelId: '202,201', cateId: '12', sliderImage: '["/isolated.png"]' }).where(eq(storeProduct.id, 80));
    await f.db.insert(storeProductRelation).values([
      { id: 500, productId: 80, type: 1, relationId: 12 },
      { id: 501, productId: 80, type: 3, relationId: 202, status: 1, addTime: 42 },
      { id: 502, productId: 80, type: 3, relationId: 201, status: 1, addTime: 43 },
    ]);
    await f.exec("SELECT setval(pg_get_serial_sequence('store_product_relation','id'),600,false); SELECT setval(pg_get_serial_sequence('store_product','id'),1000,false)");
    tokens = {}; for (const id of [21,22,31]) tokens[id] = (await createToken(id, 'supplier', md5('supplier-label-password'), env.APP_KEY)).token;
  });
  afterEach(() => { expect(fetch).not.toHaveBeenCalled(); vi.restoreAllMocks(); });
  async function save(body: unknown, id = 80, admin = 21) {
    lastError=undefined;
    const response = await app.request(`/supplierapi/product/product/${id}`, { method: 'POST', headers: { Authorization: `Bearer ${tokens[admin]}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, env);
    const result=await response.json() as { status: number; msg: string; data: { id: number } };
    if(result.status===500){ let cause=lastError; for(let i=0;i<4&&cause instanceof Error;i++){result.msg+=` | ${cause.message}`;cause=cause.cause;} }
    return result;
  }
  const relations = async () => (await f.db.select().from(storeProductRelation).where(eq(storeProductRelation.productId, 80))).filter(row => row.type === 3).sort((a,b) => a.id-b.id);
  async function snapshot() { return await f.db.execute(sql.raw(`SELECT jsonb_build_object(${tables.map(table => {
    const name = getTableName(table); return `'${name}',(SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text) FROM "${name}" t)`;
  }).join(',')}) AS state`)); }
  it('price-only save preserves hidden old CSV and every label relation while updating actual SKU price', async () => {
    const old = await relations(), result = await save(input()); expect(result.status, result.msg).toBe(200);
    expect((await f.db.select().from(storeProduct).where(eq(storeProduct.id, 80)))[0]).toMatchObject({ storeLabelId: '202,201', price: '15.55' });
    expect(await relations()).toEqual(old);
    const detail = await app.request('/supplierapi/product/product/80', { headers: { Authorization: `Bearer ${tokens[21]}` } }, env);
    expect((await detail.json() as any).data.store_label_id).toBe('202,201');
  });
  it('explicit selection accepts platform and own labels in platform groups and preserves common relation identity', async () => {
    const old = (await relations()).find(row => row.relationId === 201);
    const result = await save(input({ store_label_id: [201,101,201] })); expect(result.status, result.msg).toBe(200);
    expect((await f.db.select().from(storeProduct).where(eq(storeProduct.id,80)))[0].storeLabelId).toBe('201,101');
    const rows = await relations(); expect(rows.find(row => row.relationId === 201)).toEqual(old);
    expect(rows.map(row => row.relationId).sort()).toEqual([101,201]); expect(rows.find(row => row.relationId === 101)).toMatchObject({ status: 0, relationPid: 0 });
  });
  it('explicit empty selection clears labels and creation binds in the actual product/SKU transaction', async () => {
    expect((await save(input({ store_label_id: [] }))).status).toBe(200); expect(await relations()).toEqual([]);
    expect((await f.db.select().from(storeProduct).where(eq(storeProduct.id,80)))[0].storeLabelId).toBe('');
    const created = await save(input({ store_label_id: '201,101' }),0); expect(created.status,created.msg).toBe(200);
    expect((await f.db.select().from(storeProduct).where(eq(storeProduct.id,created.data.id)))[0]).toMatchObject({ type: 2, relationId: 20, storeLabelId: '201,101' });
  });
  it('rejects foreign, hidden, orphan and invalid owner/group labels before changing product or SKU facts', async () => {
    const old = await snapshot();
    for (const ids of [[301],[302],[202],[203],[204],[205],[999],[0],[1.2],[true],['0x65'],['1e2'],[2147483648]]) {
      expect((await save(input({store_label_id: ids}))).status).not.toBe(200); expect(await snapshot()).toEqual(old);
    }
  });
  it('actual readonly, foreign and stale-password JWT cannot enter the label binding writer', async () => {
    const old = await snapshot(); for (const admin of [22,31]) { expect((await save(input({store_label_id:[201]}),80,admin)).status).not.toBe(200); expect(await snapshot()).toEqual(old); }
    await f.db.update(systemAdmin).set({pwd:'changed'}).where(eq(systemAdmin.id,21)); const changed = await snapshot();
    expect((await save(input({store_label_id:[201]}))).status).not.toBe(200); expect(await snapshot()).toEqual(changed);
  });
  it('disabled actual role revokes the complete product writer without accepting its earlier JWT', async () => {
    await f.db.update(systemRole).set({status:0}).where(eq(systemRole.id,21)); const old = await snapshot();
    expect((await save(input({store_label_id:[201]}))).status).not.toBe(200); expect(await snapshot()).toEqual(old);
  });
  it('a trigger suppressing product-label relation insertion rolls back price, category, SKU and CSV', async () => {
    await f.exec(`CREATE FUNCTION suppress_label_relation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.type=3 THEN RETURN NULL; END IF; RETURN NEW; END $$;
      CREATE TRIGGER suppress_label_relation BEFORE INSERT ON store_product_relation FOR EACH ROW EXECUTE FUNCTION suppress_label_relation()`);
    const old=await snapshot(); try { expect((await save(input({store_label_id:[101]}))).status).not.toBe(200); expect(await snapshot()).toEqual(old); }
    finally { await f.exec('DROP TRIGGER suppress_label_relation ON store_product_relation; DROP FUNCTION suppress_label_relation()'); }
  });
  it('a trigger rewriting the stored label CSV is detected after the full SKU edit and rolls everything back', async () => {
    await f.exec(`CREATE FUNCTION corrupt_label_csv() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.store_label_id IS DISTINCT FROM OLD.store_label_id THEN NEW.store_label_id='301'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER corrupt_label_csv BEFORE UPDATE ON store_product FOR EACH ROW EXECUTE FUNCTION corrupt_label_csv()`);
    const old=await snapshot(); try { expect((await save(input({store_label_id:[101]}))).status).not.toBe(200); expect(await snapshot()).toEqual(old); }
    finally { await f.exec('DROP TRIGGER corrupt_label_csv ON store_product; DROP FUNCTION corrupt_label_csv()'); }
  });
});
