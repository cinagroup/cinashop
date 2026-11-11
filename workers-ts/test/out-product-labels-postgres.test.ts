import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, getTableName, sql } from 'drizzle-orm';
import { createHmac } from 'node:crypto';
import { Hono } from 'hono';
import type { AppVariables, Env } from '../src/env';
import type { DbClient } from '../src/lib/di';
import { createContainerFromDb } from '../src/lib/di';
import { productCreate, productInfo, productUpdate, productSetShow } from '../src/controllers/out/OutApiController';
import { orderCreate } from '../src/controllers/api/v1/OrderController';
import { createPcCheckoutQuoteFixture } from './helpers/pcCheckoutQuoteFixture';
import { completePurchaseOriginEvidenceOrm } from '../src/migrations/runPurchaseOriginEvidence';
import { completePurchaseCancellationEvidenceOrm } from '../src/migrations/runPurchaseCancellationEvidence';
import { sequenceRunnerDatabase, type SequenceRunnerPeer } from './helpers/kefuSequenceRunnerDatabase';
import { waitForFinanceBlock } from './helpers/financePeers';
import { runtimeBusinessPrivilegePlan } from '../src/migrations/runtimeBusinessPrivilegePlan';
import { readPublicProductLabelMap, publicProductLabelIds } from '../src/services/product/PublicProductLabelData';
import { legacyCategory, storeProduct, storeProductAttrValue, storeProductCategory, storeProductRelation,
  outProductWriteReplay, storeProductStockRecord, storeProductAttr, storeProductAttrResult, storeProductDescription,
  storeBrand, storeProductEnsure, storeProductLabel, userLabel, userLabelRelation, storeProductLabelAuxiliary,
  shippingTemplates, storeCouponIssue, storeProductCoupon, systemForm, systemAttachment, systemConfig, storeProductVirtual } from '../src/models/schema';

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('real PG16 Out product and user label authors', () => {
  let f: Awaited<ReturnType<typeof createPcCheckoutQuoteFixture>>;
  let owned: Awaited<ReturnType<typeof sequenceRunnerDatabase>>;
  let network: ReturnType<typeof vi.spyOn>;
  let operationId: string;
  const body = { product_type: 0, supplier_id: 0, cate_id: [9], store_name: 'Out label author',
    slider_image: ['/isolated.png'], delivery_type: [1], freight: 3, temp_id: 10, spec_type: 1, is_show: 1,
    items: [{ value: '颜色', detail: ['红色'] }, { value: '尺码', detail: ['大号'] }],
    attrs: [{ suk: '红色,大号', detail: { 颜色: '红色', 尺码: '大号' }, unique: 'qared001', price: '10.00', vip_price: '9.00', stock: 999, bar_code: 'OUT-A' }] };
  const combined = () => ({ ...body, brand_id: [30, 31], ensure_id: [92], store_label_id: [101, 102], label_id: [201, 202] });
  const app = (db: DbClient) => {
    const a = new Hono<{ Bindings: Env; Variables: AppVariables }>();
    a.use('*', async (c, next) => {
      c.set('container', createContainerFromDb(db)); c.set('uid', 11);
      // Synthetic Out account and Sequence; real handlers, services and SQL.
      c.set('outInfo', { id: 7, appid: 'isolated-out-labels', title: 'isolated', rules: [] }); await next();
    });
    a.onError((e, c) => c.json({ status: 400, msg: e.message, data: null }));
    a.post('/api/order/create/:key', orderCreate); a.post('/outapi/product', productCreate);
    a.get('/outapi/product/:id', productInfo); a.put('/outapi/product/:id', productUpdate);
    a.put('/outapi/product/set_show/:id/:is_show', productSetShow);
    return a;
  };
  beforeEach(async () => {
    operationId = crypto.randomUUID();
    network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Actual provider HTTP is forbidden in Out label acceptance'));
    f = await createPcCheckoutQuoteFixture([], async () => {
      owned = await sequenceRunnerDatabase();
      try {
        const api = await import('drizzle-kit/api'), schema = await import('../src/models/schema');
        await owned.exec((await api.generateMigration(api.generateDrizzleJson({}), api.generateDrizzleJson(schema))).join('\n'));
        await completePurchaseOriginEvidenceOrm(owned.db); await completePurchaseCancellationEvidenceOrm(owned.db);
        return owned;
      } catch (e) { await owned.close(); throw e; }
    });
    await f.setConfig(Object.fromEntries(Object.keys(f.config).map(name => [name, '0'])));
    await f.db.insert(storeProductCategory).values({ id: 9, cateName: 'isolated', isShow: 1 });
    await f.db.update(storeProduct).set({ cateId: '9', specType: 1, brandId: 40, brandCom: '40', ensureId: '91', storeLabelId: '1101', labelId: '1201' }).where(eq(storeProduct.id, 70));
    await f.db.update(storeProductAttrValue).set({ barCode: 'OUT-A' }).where(eq(storeProductAttrValue.id, 1));
    await f.db.insert(storeBrand).values([{ id: 30, brandName: '新父品牌', pid: 0, isShow: 1 }, { id: 31, brandName: '新子品牌', pid: 30, isShow: 1 }, { id: 40, brandName: '原品牌', pid: 0, isShow: 1 }]);
    await f.db.insert(storeProductEnsure).values([{ id: 91, name: '原保障', status: 1 }, { id: 92, name: '新保障', status: 1 }]);
    await f.db.insert(legacyCategory).values([
      { id: 300, name: '商品标签组', group: 2 }, { id: 301, name: '隐藏组', group: 2, isShow: 0 },
      { id: 302, name: '供应商组', group: 2, type: 2, relationId: 44 }, { id: 303, name: '用户标签组', group: 0 },
      { id: 304, name: '有其他维护归属的组', group: 2, ownerId: 9 }, { id: 305, name: '另一商品标签组', group: 2 },
    ]);
    await f.db.insert(storeProductLabel).values([
      { id: 101, labelName: '新品', labelCate: 300 }, { id: 102, labelName: '精选', labelCate: 305 },
      { id: 103, labelName: '供应商商品标签', labelCate: 300, type: 2, relationId: 44 },
      { id: 104, labelName: '隐藏标签', labelCate: 300, isShow: 0 }, { id: 105, labelName: '停用标签', labelCate: 300, status: 0 },
      { id: 106, labelName: '无分组标签', labelCate: 399 }, { id: 107, labelName: '隐藏组标签', labelCate: 301 },
      { id: 108, labelName: '跨组标签', labelCate: 302 }, { id: 109, labelName: '错误组类型', labelCate: 303 },
      { id: 110, labelName: '错误维护归属', labelCate: 304 }, { id: 111, labelName: '错误平台标签', labelCate: 300, relationId: 44 },
      { id: 112, labelName: '错误供应商标签', labelCate: 300, type: 2, relationId: 0 }, { id: 1101, labelName: '原商品标签', labelCate: 300 },
    ]);
    await f.db.insert(userLabel).values([
      { id: 201, name: '兴趣用户', labelCate: 0 }, { id: 202, name: '长期用户', labelCate: 303 },
      { id: 203, name: '供应商用户标签', type: 2, relationId: 44 }, { id: 204, name: '停用用户标签', status: 0 },
      { id: 205, name: '错误平台用户标签', relationId: 44 }, { id: 206, name: '错误供应商用户标签', type: 2, relationId: 0 },
      { id: 1201, name: '原用户标签' },
    ]);
    await f.db.insert(storeProductRelation).values([
      { id: 1000, productId: 70, relationId: 9, type: 1, status: 1 },
      { id: 1001, productId: 70, relationId: 40, type: 2, status: 1 },
      { id: 1002, productId: 70, relationId: 1101, type: 3, status: 1 },
      { id: 1003, productId: 70, relationId: 1201, type: 4, status: 1 },
      { id: 1004, productId: 70, relationId: 91, type: 5, status: 1 },
      { id: 1005, productId: 70, relationId: 600, type: 6, status: 1 },
      { id: 1006, productId: 70, relationId: 900, type: 9, status: 0 },
    ]);
    await f.db.insert(storeProductLabelAuxiliary).values({ id: 500, productId: 70, labelId: 1101 });
    await f.db.insert(userLabelRelation).values({ uid: 11, labelId: 1201 });
    await f.exec("SELECT setval(pg_get_serial_sequence('store_product_relation','id'),1006,true)");
    Object.assign(f.env, { SEQUENCE: { idFromName: () => 'isolated', get: () => ({ fetch: async () => new Response('out_product_labels_order') }) } });
  }, 120_000);
  afterEach(async () => { try { expect(network).not.toHaveBeenCalled(); } finally { network?.mockRestore(); await f?.close(); } }, 120_000);
  const request = async (db: DbClient, input?: object, requestId = operationId, path = '/outapi/product/70', method = 'PUT') => {
    const response = await app(db).request(path, { method, headers: { 'content-type': 'application/json', 'x-fixture-user': '11', 'Idempotency-Key': requestId },
      ...(input ? { body: JSON.stringify(input) } : {}) }, f.env);
    return response.json() as Promise<{ status: number; msg: string; data: { id: number; idempotent: boolean; stock_preserved: boolean } }>;
  };
  const detail = (db = f.db) => request(db, undefined, operationId, '/outapi/product/70', 'GET');
  const state = async () => ({ ...await f.snapshot(), replays: await f.db.select().from(outProductWriteReplay),
    relations: await f.db.select().from(storeProductRelation).orderBy(storeProductRelation.id),
    stocks: await f.db.select().from(storeProductStockRecord), attrs: await f.db.select().from(storeProductAttr),
    results: await f.db.select().from(storeProductAttrResult), descriptions: await f.db.select().from(storeProductDescription),
    brands: await f.db.select().from(storeBrand).orderBy(storeBrand.id), ensures: await f.db.select().from(storeProductEnsure).orderBy(storeProductEnsure.id),
    labels: await f.db.select().from(storeProductLabel).orderBy(storeProductLabel.id), userLabels: await f.db.select().from(userLabel).orderBy(userLabel.id),
    groups: await f.db.select().from(legacyCategory).orderBy(legacyCategory.id),
    auxiliary: await f.db.select().from(storeProductLabelAuxiliary), customerLabels: await f.db.select().from(userLabelRelation) });
  const protectedRows = (types: number[]) => f.db.execute(sql`SELECT id,xmin::text AS version,to_jsonb(r) AS data
    FROM store_product_relation r WHERE product_id=70 AND type NOT IN(${sql.join(types.map(n => sql`${n}`), sql`,`)}) ORDER BY id`);
  const peers = async (run: (peers: [SequenceRunnerPeer, SequenceRunnerPeer, SequenceRunnerPeer]) => Promise<void>) => {
    if (!owned.withPeer) throw Error('Real separate PG16 peers required');
    await owned.withPeer(a => owned.withPeer!(b => owned.withPeer!(async c => {
      expect(new Set([a.pid, b.pid, c.pid]).size).toBe(3); await run([a, b, c]);
    })));
  };

  it('commits both label sets with brand and ensure edits after real checkout, renders public labels and replays before catalog admission', async () => {
    const quote = await f.app.request('/api/order/confirm', { method: 'POST', headers: { 'content-type': 'application/json', 'x-fixture-user': '11' },
      body: JSON.stringify({ cartIds: [1], addressId: 11, couponId: 0, type: 0 }) }, f.env);
    const confirmed = await quote.json() as { status: number; data: { orderKey: string; quoteToken: string } };
    expect(confirmed.status).toBe(200);
    const order = await app(f.db).request(`/api/order/create/${confirmed.data.orderKey}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-fixture-user': '11', 'Idempotency-Key': operationId },
      body: JSON.stringify({ cartIds: [1], addressId: 11, couponId: 0, type: 0, quoteToken: confirmed.data.quoteToken }) }, f.env);
    expect((await order.json() as { status: number }).status).toBe(200);
    const before = await state(), untouched = await protectedRows([1, 2, 3, 4, 5]);
    const result = await request(f.db, combined()); expect(result.status, result.msg).toBe(200); expect(result.data.stock_preserved).toBe(true);
    const after = await state(); expect(after.products[0]).toMatchObject({ brandId: 31, brandCom: '30,31', ensureId: '92', storeLabelId: '101,102', labelId: '201,202', stock: 6, sales: 2 });
    expect(after.orders).toEqual(before.orders); expect(after.bills).toEqual(before.bills);
    expect(after.skus.map(row => [row.id, row.unique, row.stock, row.sumStock, row.sales])).toEqual(before.skus.map(row => [row.id, row.unique, row.stock, row.sumStock, row.sales]));
    expect(after.relations.filter(row => row.type === 3).map(row => row.relationId)).toEqual([101, 102]);
    expect(after.relations.filter(row => row.type === 4).map(row => row.relationId)).toEqual([201, 202]);
    expect(await protectedRows([1, 2, 3, 4, 5])).toEqual(untouched); expect(after.auxiliary).toEqual(before.auxiliary); expect(after.customerLabels).toEqual(before.customerLabels);
    const rendered = await readPublicProductLabelMap(f.db, undefined, publicProductLabelIds(after.products[0].storeLabelId));
    expect([...rendered.values()].map(row => row.id)).toEqual([101, 102]);
    await f.db.update(storeProductLabel).set({ status: 0 }).where(eq(storeProductLabel.id, 101));
    await f.db.update(userLabel).set({ status: 0 }).where(eq(userLabel.id, 201));
    const changed = await state(), replay = await request(f.db, combined());
    expect(replay.status, replay.msg).toBe(200); expect(replay.data.idempotent).toBe(true); expect(await state()).toEqual(changed);
    const conflict = await request(f.db, { ...combined(), label_id: [202] });
    expect(conflict.status).not.toBe(200); expect(await state()).toEqual(changed);
  }, 20_000);

  it('clears each explicit label set with a fresh intent while preserving the omitted set and independent auxiliary/customer relations', async () => {
    const untouched = await protectedRows([1, 3]), before = await state();
    const product = await request(f.db, { ...body, store_label_id: [] }); expect(product.status, product.msg).toBe(200);
    const middle = await state(); expect(middle.products[0]).toMatchObject({ storeLabelId: '', labelId: '1201' });
    expect(middle.relations.filter(row => row.type === 3)).toEqual([]); expect(await protectedRows([1, 3])).toEqual(untouched);
    expect((await readPublicProductLabelMap(f.db, undefined, publicProductLabelIds(middle.products[0].storeLabelId))).size).toBe(0);
    const user = await request(f.db, { ...body, label_id: [] }, crypto.randomUUID()); expect(user.status, user.msg).toBe(200);
    const after = await state(); expect(after.products[0]).toMatchObject({ storeLabelId: '', labelId: '' }); expect(after.relations.filter(row => row.type === 4)).toEqual([]);
    expect(after.auxiliary).toEqual(before.auxiliary); expect(after.customerLabels).toEqual(before.customerLabels);
  });

  it('preserves unresolved omitted labels without consulting either label catalog or its group catalog', async () => {
    await f.db.update(storeProduct).set({ storeLabelId: 'bad-legacy-product-label', labelId: 'bad-legacy-user-label' }).where(eq(storeProduct.id, 70));
    const untouched = await protectedRows([1, 2, 5]);
    await f.exec('ALTER TABLE store_product_label RENAME TO hidden_out_product_labels; ALTER TABLE user_label RENAME TO hidden_out_user_labels; ALTER TABLE category RENAME TO hidden_out_label_groups');
    const result = await request(f.db, { ...body, brand_id: [30, 31], ensure_id: [92] }); expect(result.status, result.msg).toBe(200);
    expect((await f.db.select().from(storeProduct).where(eq(storeProduct.id, 70)))[0]).toMatchObject({ storeLabelId: 'bad-legacy-product-label', labelId: 'bad-legacy-user-label' });
    expect(await protectedRows([1, 2, 5])).toEqual(untouched);
  });

  it.each([{ ids: [103] }, { ids: [104] }, { ids: [105] }, { ids: [106] }, { ids: [107] }, { ids: [108] },
    { ids: [109] }, { ids: [110] }, { ids: [111] }, { ids: [112] }, { ids: [999] }])(
    'rejects unavailable product labels or invalid platform groups $ids before business or replay mutation', async ({ ids }) => {
      const before = await state(), result = await request(f.db, { ...body, store_label_id: ids });
      expect(result.status).not.toBe(200); expect(result.msg).toContain('标签'); expect(await state()).toEqual(before);
    });
  it.each([{ ids: [203] }, { ids: [204] }, { ids: [205] }, { ids: [206] }, { ids: [999] }])(
    'rejects foreign missing or disabled user labels $ids before business or replay mutation', async ({ ids }) => {
      const before = await state(), result = await request(f.db, { ...body, label_id: ids });
      expect(result.status).not.toBe(200); expect(result.msg).toContain('标签'); expect(await state()).toEqual(before);
    });

  it('uses authoritative user label ownership rather than forged legacy echo metadata and accepts canonical owned echoes', async () => {
    const before = await state(), result = await request(f.db, { ...body, label_id: [{ id: 203, type: 0, relation_id: 0, status: 1, label_name: '平台标签' }] });
    expect(result.status).not.toBe(200); expect(await state()).toEqual(before);
    const valid = await request(f.db, { ...body, label_id: [{ id: '201', label_name: '旧名称', type: 2, relation_id: 99 }] });
    expect(valid.status, valid.msg).toBe(200); expect((await state()).products[0].labelId).toBe('201');
    const replay = await request(f.db, { ...body, label_id: [201] }); expect(replay.data.idempotent).toBe(true);
  });
  it('refuses either label writer on a Supplier product without changing historical references', async () => {
    await f.db.update(storeProduct).set({ type: 2, relationId: 44 }).where(eq(storeProduct.id, 70));
    const before = await state(), result = await request(f.db, combined());
    expect(result.status).not.toBe(200); expect(result.msg).toContain('不属于平台'); expect(await state()).toEqual(before);
  });
  it('creates exactly one complete four-metadata product and one receipt for concurrent same-key requests', async () => {
    await f.exec("SELECT setval(pg_get_serial_sequence('store_product','id'),70,true); SELECT setval(pg_get_serial_sequence('store_product_attr_value','id'),1,true)");
    await peers(async ([_holder, first, second]) => {
      const results = await Promise.all([request(first.db, combined(), operationId, '/outapi/product', 'POST'), request(second.db, combined(), operationId, '/outapi/product', 'POST')]);
      for (const result of results) expect(result.status, result.msg).toBe(200);
      expect(results.filter(row => row.data.idempotent)).toHaveLength(1); expect(results[0].data.id).toBe(results[1].data.id);
      const id = results[0].data.id;
      expect((await f.db.select().from(storeProduct).where(eq(storeProduct.id, id)))[0]).toMatchObject({ brandId: 31, ensureId: '92', storeLabelId: '101,102', labelId: '201,202' });
      expect((await state()).relations.filter(row => row.productId === id && [2, 3, 4, 5].includes(row.type))).toHaveLength(7);
      expect((await state()).replays).toHaveLength(1);
    });
  }, 20_000);

  it.each([{ target: 'product', query: 'SELECT id FROM store_product_label WHERE id=102 FOR UPDATE' },
    { target: 'group', query: 'SELECT id FROM category WHERE id=305 FOR UPDATE' },
    { target: 'user', query: 'SELECT id FROM user_label WHERE id=202 FOR UPDATE' }])(
    'releases all earlier catalog SKU and replay locks when a later $target row is busy, then reuses the uncommitted key', async ({ query }) => {
      const before = await state();
      await peers(async ([holder, editor, probe]) => {
        await holder.exec('BEGIN; ' + query);
        try {
          const result = await request(editor.db, combined()); expect(result.status).not.toBe(200); expect(result.msg).toContain('正在变化'); expect(await state()).toEqual(before);
          await probe.exec('BEGIN; SELECT id FROM store_brand WHERE id=31 FOR UPDATE NOWAIT; SELECT id FROM store_product_attr_value WHERE id=1 FOR UPDATE NOWAIT; SELECT id FROM store_product_label WHERE id=101 FOR UPDATE NOWAIT; SELECT id FROM category WHERE id=300 FOR UPDATE NOWAIT; SELECT id FROM user_label WHERE id=201 FOR UPDATE NOWAIT; ROLLBACK');
        } finally { await holder.exec('COMMIT'); }
        const retry = await request(editor.db, combined()); expect(retry.status, retry.msg).toBe(200); expect(retry.data.idempotent).toBe(false);
      });
    }, 20_000);
  it('pins both real label catalogs and product group rows throughout the blocked ordinary product write', async () => {
    await f.exec("CREATE FUNCTION test_out_labels_gate() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id=70 THEN PERFORM pg_advisory_xact_lock(744220092,1); END IF; RETURN NEW; END $$; CREATE TRIGGER test_out_labels_gate BEFORE UPDATE ON store_product FOR EACH ROW EXECUTE FUNCTION test_out_labels_gate()");
    await peers(async ([holder, editor, probe]) => {
      await holder.exec('BEGIN; SELECT pg_advisory_xact_lock(744220092,1)'); const pending = request(editor.db, combined());
      try {
        await waitForFinanceBlock(f.db, editor.pid, holder.pid);
        for (const query of ['SELECT id FROM store_product_label WHERE id=101 FOR UPDATE NOWAIT', 'SELECT id FROM category WHERE id=300 FOR UPDATE NOWAIT', 'SELECT id FROM user_label WHERE id=201 FOR UPDATE NOWAIT']) {
          await probe.exec('BEGIN'); try { await expect(probe.exec(query)).rejects.toMatchObject({ code: '55P03' }); } finally { await probe.exec('ROLLBACK'); }
        }
      } finally { await holder.exec('COMMIT'); }
      const result = await pending; expect(result.status, result.msg).toBe(200);
    });
  }, 20_000);

  it.each([{ target: 'unowned relation', change: 'UPDATE store_product_relation SET status=status WHERE id=1006;' },
    { target: 'product label', change: 'UPDATE store_product_label SET status=0 WHERE id=101;' },
    { target: 'user label', change: 'UPDATE user_label SET status=0 WHERE id=201;' },
    { target: 'group', change: "UPDATE category SET name='changed group' WHERE id=300;" },
    { target: 'receipt failure', change: "RAISE EXCEPTION 'isolated label receipt failure';" }])(
    'rolls back all business results when the final receipt interferes with $target', async ({ change }) => {
      const before = await state(), untouched = await protectedRows([1, 2, 3, 4, 5]);
      await f.exec(`CREATE FUNCTION test_out_labels_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ${change} RETURN NEW; END $$; CREATE TRIGGER test_out_labels_receipt AFTER INSERT ON out_product_write_replay FOR EACH ROW EXECUTE FUNCTION test_out_labels_receipt()`);
      const result = await request(f.db, combined()); expect(result.status).not.toBe(200); expect(await state()).toEqual(before); expect(await protectedRows([1, 2, 3, 4, 5])).toEqual(untouched);
    });
  it.each([{ target: 'brand', change: 'brand_id=999' }, { target: 'ensure', change: "ensure_id='999'" },
    { target: 'product label', change: "store_label_id='999'" }])(
    'rejects a late user-label trigger rewriting an already-authored $target', async ({ change }) => {
      const before = await state();
      await f.exec(`CREATE FUNCTION test_out_labels_late() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN UPDATE store_product SET ${change} WHERE id=70; RETURN NEW; END $$; CREATE TRIGGER test_out_labels_late AFTER INSERT ON store_product_relation FOR EACH ROW WHEN(NEW.type=4) EXECUTE FUNCTION test_out_labels_late()`);
      const result = await request(f.db, combined()); expect(result.status).not.toBe(200); expect(await state()).toEqual(before);
    });
  it.each([{ field: 'store_label_id' }, { field: 'label_id' }])('preserves the omitted $field scalar against a brand trigger', async ({ field }) => {
    const before = await state();
    await f.exec(`CREATE FUNCTION test_out_labels_omitted() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN UPDATE store_product SET ${field}='999' WHERE id=70; RETURN NEW; END $$; CREATE TRIGGER test_out_labels_omitted AFTER INSERT ON store_product_relation FOR EACH ROW WHEN(NEW.type=2) EXECUTE FUNCTION test_out_labels_omitted()`);
    const result = await request(f.db, { ...body, brand_id: [30, 31] }); expect(result.status).not.toBe(200); expect(await state()).toEqual(before);
  });

  it('reads id/name arrays and explicit consistency, availability and bounded history without repairing or disclosing foreign names', async () => {
    expect((await request(f.db, combined())).status).toBe(200);
    expect((await request(f.db, undefined, crypto.randomUUID(), '/outapi/product/set_show/70/0')).status).toBe(200);
    const before = await state(), first = await detail(); expect(first.status, first.msg).toBe(200);
    expect(first.data).toMatchObject({ store_label_id: [{ id: 101, label_name: '新品' }, { id: 102, label_name: '精选' }],
      label_id: [{ id: 201, label_name: '兴趣用户' }, { id: 202, label_name: '长期用户' }],
      store_label_selection: { ids: [101, 102], consistent: true, available: true }, label_selection: { ids: [201, 202], consistent: true, available: true } });
    expect(await state()).toEqual(before);
    await f.db.update(storeProductLabel).set({ isShow: 0 }).where(eq(storeProductLabel.id, 101));
    await f.db.update(userLabel).set({ status: 0 }).where(eq(userLabel.id, 201));
    const hidden = await state(), next = await detail(); expect(next.data).toMatchObject({ store_label_selection: { consistent: true, available: false }, label_selection: { consistent: true, available: false } }); expect(await state()).toEqual(hidden);
    await f.db.update(storeProduct).set({ storeLabelId: '103', labelId: '203' }).where(eq(storeProduct.id, 70));
    const foreign = await state(), read = await detail(); expect(read.data).toMatchObject({ store_label_id: [], label_id: [], store_label_selection: { ids: [103], available: false }, label_selection: { ids: [203], available: false } }); expect(await state()).toEqual(foreign);
    await f.db.update(storeProduct).set({ storeLabelId: '1,'.repeat(2100), labelId: 'bad legacy label' }).where(eq(storeProduct.id, 70));
    const bad = await state(), truncated = await detail(); expect(truncated.data).toMatchObject({ store_label_id: [], label_id: [], store_label_selection: { consistent: false, truncated: true }, label_selection: { consistent: false, truncated: false } }); expect(await state()).toEqual(bad);
  }, 20_000);
  it('uses one real repeatable-read snapshot for both label CSVs and both relationship sets across a concurrent replacement', async () => {
    await peers(async ([holder, reader]) => {
      await holder.exec('BEGIN; LOCK TABLE store_product_relation IN ACCESS EXCLUSIVE MODE'); const pending = detail(reader.db);
      try {
        await waitForFinanceBlock(f.db, reader.pid, holder.pid);
        await holder.exec("UPDATE store_product SET store_label_id='101',label_id='201' WHERE id=70; DELETE FROM store_product_relation WHERE product_id=70 AND type IN(3,4); INSERT INTO store_product_relation(product_id,relation_id,type,status) VALUES(70,101,3,1),(70,201,4,1)");
      } finally { await holder.exec('COMMIT'); }
      const old = await pending; expect(old.status, old.msg).toBe(200);
      expect(old.data).toMatchObject({ store_label_id: [{ id: 1101, label_name: '原商品标签' }], label_id: [{ id: 1201, label_name: '原用户标签' }], store_label_selection: { consistent: true }, label_selection: { consistent: true } });
      const current = await detail(reader.db); expect(current.data).toMatchObject({ store_label_id: [{ id: 101, label_name: '新品' }], label_id: [{ id: 201, label_name: '兴趣用户' }], store_label_selection: { consistent: true }, label_selection: { consistent: true } });
    });
  }, 20_000);
  it('uses the unchanged App plan on a genuine restricted LOGIN and cannot mutate either label catalog', async () => {
    if (!owned.withRuntimeRole) throw Error('Actual restricted LOGIN required');
    await owned.withRuntimeRole(async runtime => {
      const plan = runtimeBusinessPrivilegePlan('app'), quote = (name: string) => { if (!/^[a-z_][a-z_0-9]*$/.test(name)) throw Error('Unexpected owned identifier'); return `"${name}"`; };
      const tables = await f.db.execute<{ name: string }>(sql`SELECT relname AS name FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind='r' ORDER BY relname`);
      for (const { name } of tables) {
        const rights = plan.tables[name]; if (!rights) continue;
        await f.exec(`GRANT ${rights.join(',')} ON public.${quote(name)} TO ${quote(runtime.role)}`);
        const columns = plan.updateColumns[name]; if (columns?.length) await f.exec(`GRANT UPDATE(${columns.map(quote).join(',')}) ON public.${quote(name)} TO ${quote(runtime.role)}`);
      }
      const sequences = await f.db.execute<{ table_name: string; sequence_name: string | null }>(sql`SELECT c.relname AS table_name,pg_get_serial_sequence('public.'||quote_ident(c.relname),a.attname) AS sequence_name FROM pg_class c JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped WHERE c.relnamespace='public'::regnamespace AND c.relkind='r'`);
      for (const row of sequences) if (row.sequence_name && plan.tables[row.table_name]?.includes('INSERT')) {
        const parts = row.sequence_name.split('.'); if (parts.length !== 2 || parts[0] !== 'public') throw Error('Unexpected owned sequence');
        await f.exec(`GRANT USAGE ON SEQUENCE public.${quote(parts[1])} TO ${quote(runtime.role)}`);
      }
      const [identity] = await runtime.db.execute(sql`SELECT current_user AS role,session_user AS session,(SELECT rolsuper OR rolcreatedb OR rolcreaterole OR rolinherit OR rolbypassrls FROM pg_roles WHERE rolname=current_user) AS elevated,
        has_column_privilege(current_user,'public.store_product_label','id','UPDATE') AS lock_product,
        has_column_privilege(current_user,'public.user_label','id','UPDATE') AS lock_user,
        has_column_privilege(current_user,'public.store_product_label','status','UPDATE') AS mutate_product,
        has_column_privilege(current_user,'public.user_label','status','UPDATE') AS mutate_user`);
      expect(identity).toEqual({ role: runtime.role, session: runtime.role, elevated: false, lock_product: true, lock_user: true, mutate_product: false, mutate_user: false });
      const result = await request(runtime.db, combined()); expect(result.status, result.msg).toBe(200);
      const read = await detail(runtime.db); expect(read.status, read.msg).toBe(200); expect(read.data).toMatchObject({ store_label_selection: { consistent: true, available: true }, label_selection: { consistent: true, available: true } });
      await expect(runtime.exec('UPDATE store_product_label SET status=0 WHERE id=101')).rejects.toMatchObject({ code: '42501' });
      await expect(runtime.exec('UPDATE user_label SET status=0 WHERE id=201')).rejects.toMatchObject({ code: '42501' });
    });
  }, 30_000);
  type LegacyData = { productInfo: Record<string, unknown>; tempList: Array<{ id: number; name: string }>;
    cateList: unknown[]; editor: { media_previews: Record<string, string>; video_preview: string; description_preview: string; retired_attrs: unknown[] } } & Record<string, unknown>;
  const richDetail = async (db = f.db) => await detail(db) as unknown as { status: number; msg: string; data: LegacyData };
  const rows = (value: unknown) => value as Array<Record<string, unknown>>;

  it('authenticates the real varchar64 column and atomically accepts64/rejects65 user label CSV characters', async () => {
    const [column] = await f.db.execute(sql`SELECT character_maximum_length AS capacity FROM information_schema.columns WHERE table_schema='public' AND table_name='store_product' AND column_name='label_id'`);
    expect(column.capacity).toBe(64);
    const fits = [100000000, 1000000001, 1000000002, 1000000003, 1000000004, 1000000005], exceeds = [1000000000, ...fits.slice(1)];
    expect(fits.join(',')).toHaveLength(64); expect(exceeds.join(',')).toHaveLength(65);
    await f.db.insert(userLabel).values([...new Set([...fits, ...exceeds])].map(id => ({ id, name: `边界${id}` })));
    const accepted = await request(f.db, { ...body, label_id: fits }); expect(accepted.status, accepted.msg).toBe(200);
    const before = await state(); expect(before.products[0].labelId).toBe(fits.join(','));
    expect(before.relations.filter(row => row.type === 4).map(row => row.relationId)).toEqual(fits);
    const denied = await request(f.db, { ...body, label_id: exceeds }, crypto.randomUUID()); expect(denied.status).not.toBe(200); expect(denied.msg).toContain('64');
    expect(await state()).toEqual(before);
  });

  it('returns the full source envelope and option directories while retaining the real flat TS contract and every scalar transformation', async () => {
    expect((await request(f.db, combined())).status).toBe(200);
    await f.db.update(storeProduct).set({ image: '/main.png', sliderImage: '["/one.png","/two.png"]',
      deliveryType: '1,3', price: '12.30', cost: '4.20', postage: '2.50', giveIntegral: '7.00', isSub: 1, isVip: 1,
      isLimit: 1, videoOpen: 1, videoLink: '/legacy.mp4', isShow: 0, autoOnTime: 1704067200, autoOffTime: 1704153600,
      isPresaleProduct: 1, presaleStartTime: 1704067200, presaleEndTime: 1704153600, presaleDay: 3,
      activity: '3,0,1,2', specs: '[{"name":"材质","value":"陶瓷"}]', recommendList: '71,72,999',
      systemFormId: 800, customForm: '[{"stored":"original"}]' }).where(eq(storeProduct.id, 70));
    await f.db.insert(storeProduct).values([{ id: 71, image: '/owned.png' }, { id: 72, type: 2, relationId: 44, image: '/foreign.png' }]);
    await f.db.insert(systemConfig).values({ menuName: 'site_url', value: '"https://shop.example.test"' });
    await f.db.insert(shippingTemplates).values([{ id: 20, name: '历史平台模板', sort: 9, status: 0, isDel: 1 }, { id: 30, ownerType: 2, relationId: 44, name: '供应商模板', sort: 99 }]);
    await f.db.insert(storeProductCategory).values([{ id: 12, pid: 9, cateName: '子分类', isShow: 1 },
      { id: 13, type: 2, relationId: 44, cateName: '供应商分类', isShow: 1 }, { id: 14, pid: 9, cateName: '隐藏分类', isShow: 0 }, { id: 15, pid: 14, cateName: '隐藏父级子分类', isShow: 1 }]);
    await f.db.insert(storeCouponIssue).values([{ id: 800, title: '赠券' }, { id: 801, title: '历史停用券', status: 0, isDel: 1 }]);
    await f.db.insert(storeProductCoupon).values([{ productId: 70, issueCouponId: 801 }, { productId: 70, issueCouponId: 800 }]);
    await f.db.insert(systemForm).values({ id: 800, value: '[{"id":"city","name":"selects","titleConfig":{"value":"城市"},"wordsConfig":{"list":["上海"]},"titleShow":{"val":true}}]' });
    await f.db.update(storeProductDescription).set({ description: '<p>完整说明</p>' }).where(eq(storeProductDescription.productId, 70));
    await f.db.insert(storeProductDescription).values({ productId: 70, type: 1, description: '<p>独立活动描述</p>' });
    const before = await state(), response = await app(f.db).request('/outapi/product/70', undefined, f.env);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    const value = await response.json() as { status: number; msg: string; data: LegacyData }; expect(value.status, value.msg).toBe(200);
    expect(value.data).not.toHaveProperty('temp_list'); expect(value.data).not.toHaveProperty('cate_list'); expect(value.data).not.toHaveProperty('product_info');
    expect(value.data.tempList).toEqual([{ id: 20, name: '历史平台模板' }, { id: 10, name: '本地运费' }]);
    expect(value.data.cateList).toEqual([{ value: 9, label: 'isolated', pid: 0, children: [{ value: 12, label: '子分类', pid: 9 }] }]);
    expect(value.data).toMatchObject({ id: 70, store_name: 'Out label author', price: '12.30', slider_image: '["/one.png","/two.png"]', cate_id: [9] });
    expect(value.data.productInfo).toMatchObject({ id: 70, store_name: 'Out label author', price: 12.3, cost: 4.2, postage: 2.5,
      give_integral: 7, slider_image: ['/one.png', '/two.png'], delivery_type: ['1', '3'], cate_id: ['9'],
      brand_id: [30, 31], ensure_id: [92], label_id: [{ id: 201, label_name: '兴趣用户' }, { id: 202, label_name: '长期用户' }],
      store_label_id: [{ id: 101, label_name: '新品' }, { id: 102, label_name: '精选' }], is_sub: [1, 0], is_limit: true,
      video_open: true, video_link: 'https://shop.example.test/legacy.mp4', recommend: [],
      presale_time: ['2024-01-01 08:00:00', '2024-01-02 08:00:00'], auto_on_time: '2024-01-01 08:00:00', auto_off_time: '',
      activity: ['拼团', '默认', '秒杀', '砍价'], specs: [{ name: '材质', value: '陶瓷' }], description: '<p>完整说明</p>',
      coupons: [{ id: 800, title: '赠券' }, { id: 801, title: '历史停用券' }],
      recommend_list: [{ product_id: '71', image: '/owned.png' }, { product_id: '72', image: '' }, { product_id: '999', image: '' }],
      custom_form_info: [{ id: 'city', type: 'selects', name: '下拉框', title: '城市', list: ['上海'], require: true }],
      items: [{ value: '颜色', detail: ['红色'] }, { value: '尺码', detail: ['大号'] }],
      attrs: [{ id: 1, unique: 'qared001', value1: '红色', value2: '大号', price: 10, stock: 8, detail: { 颜色: '红色', 尺码: '大号' } }], sku_repair_required: false });
    expect(await state()).toEqual(before);
  }, 20_000);

  it('returns the actual single SKU editor fields and separates retired identities without mutating their stock or history', async () => {
    await f.db.update(storeProduct).set({ specType: 0 }).where(eq(storeProduct.id, 70));
    await f.db.update(storeProductAttrValue).set({ suk: '默认', price: '12.30', weight: '1.50', volume: '2.25',
      diskInfo: 'legacy disk metadata', writeTimes: 3, writeValid: 2, writeDays: 5, writeStart: 1704067200, writeEnd: 1704153600 }).where(eq(storeProductAttrValue.id, 1));
    await f.db.insert(storeProductAttrValue).values({ id: 2, productId: 70, unique: 'retire01', suk: '停产', isRetired: 1, stock: 9 });
    const before = await state(), result = await richDetail(); expect(result.status, result.msg).toBe(200);
    expect(result.data.productInfo).toMatchObject({ items: [], attrs: [], sku_repair_required: false,
      attr: { id: 1, unique: 'qared001', price: 12.3, stock: 8, weight: 1.5, volume: 2.25, disk_info: 'legacy disk metadata',
        write_times: 3, write_valid: 2, days: 5, section_time: ['2024-01-01', '2024-01-02'] } });
    expect(result.data.editor.retired_attrs).toMatchObject([{ id: 2, unique: 'retire01', is_retired: 1, stock: 9 }]);
    expect(rows(result.data.attrs)).toHaveLength(2); expect(await state()).toEqual(before);
  });

  it('returns virtual counts on a real read-only LOGIN denied both credential columns without materializing cards', async () => {
    await f.db.update(storeProduct).set({ productType: 1, specType: 0 }).where(eq(storeProduct.id, 70));
    await f.db.update(storeProductAttrValue).set({ suk: '默认' }).where(eq(storeProductAttrValue.id, 1));
    await f.db.insert(storeProductVirtual).values([0, 0, 11].map((uid, index) => ({
      productId: 70, attrUnique: 'qared001', uid,
      cardNo: `fixture-card-${index}`, cardPwd: `fixture-only-value-${index}`,
    })));
    await f.db.insert(storeProductVirtual).values({ productId: 71, attrUnique: 'qared001', cardNo: 'fixture-foreign-card' });
    const before = await state(), cards = await f.db.select().from(storeProductVirtual).orderBy(storeProductVirtual.id);
    if (!owned.withRuntimeRole) throw Error('Actual restricted LOGIN required');
    await owned.withRuntimeRole(async runtime => {
      const quote = (name: string) => { if (!/^[a-z_][a-z_0-9]*$/.test(name)) throw Error('Unexpected owned identifier'); return `"${name}"`; };
      const tables = [storeProduct, storeProductAttr, storeProductAttrValue, storeProductDescription,
        storeProductRelation, storeProductCoupon, shippingTemplates, storeProductCategory, systemConfig,
        storeCouponIssue, systemForm, storeBrand, storeProductEnsure, storeProductLabel, userLabel,
        legacyCategory, systemAttachment];
      for (const table of tables) await f.exec(`GRANT SELECT ON public.${quote(getTableName(table))} TO ${quote(runtime.role)}`);
      await f.exec(`GRANT SELECT(product_id,attr_unique,uid) ON public.store_product_virtual TO ${quote(runtime.role)}`);
      const [identity] = await runtime.db.execute(sql`SELECT current_user AS role,session_user AS session,
        (SELECT rolsuper OR rolcreatedb OR rolcreaterole OR rolinherit OR rolbypassrls FROM pg_roles WHERE rolname=current_user) AS elevated,
        has_table_privilege(current_user,'public.store_product_virtual','SELECT') AS all_cards,
        has_column_privilege(current_user,'public.store_product_virtual','card_no','SELECT') AS number,
        has_column_privilege(current_user,'public.store_product_virtual','card_pwd','SELECT') AS password,
        has_column_privilege(current_user,'public.store_product_virtual','uid','SELECT') AS count_state,
        has_table_privilege(current_user,'public.store_product','UPDATE') AS mutation`);
      expect(identity).toEqual({ role: runtime.role, session: runtime.role, elevated: false,
        all_cards: false, number: false, password: false, count_state: true, mutation: false });
      await expect(runtime.exec('SELECT card_no,card_pwd FROM store_product_virtual')).rejects.toMatchObject({ code: '42501' });
      const result = await richDetail(runtime.db); expect(result.status, result.msg).toBe(200);
      expect(result.data.productInfo).toMatchObject({ product_type: 1, sku_repair_required: false,
        attr: { unique: 'qared001', virtual_list: [], virtual_available: 2, virtual_total: 3 } });
      for (const forbidden of ['card_no', 'card_pwd', 'fixture-card-', 'fixture-only-value-', 'fixture-foreign-card'])
        expect(JSON.stringify(result)).not.toContain(forbidden);
    });
    expect(await state()).toEqual(before);
    expect(await f.db.select().from(storeProductVirtual).orderBy(storeProductVirtual.id)).toEqual(cards);
  }, 20_000);

  it('reports absent default SKU repair needs without executing the old GET-side repair or consuming SKU identities', async () => {
    await f.db.update(storeProduct).set({ specType: 0 }).where(eq(storeProduct.id, 70)); await f.db.delete(storeProductAttrValue);
    const before = await state(), result = await richDetail(); expect(result.status, result.msg).toBe(200);
    expect(result.data.productInfo).toMatchObject({ items: [], attrs: [], sku_repair_required: true, attr: { stock: 8, price: 10, virtual_list: [] } });
    expect(result.data.productInfo.attr).not.toHaveProperty('unique'); expect(await state()).toEqual(before);
  });

  it('keeps durable owned media in the legacy form and signs only validated image/video previews without provider HTTP', async () => {
    f.env.APP_KEY = 'x'.repeat(32);
    await f.db.insert(systemAttachment).values([
      { attId: 301, type: 1, relationId: 0, moduleType: 1, imageType: 8, fileType: 1, attType: 'image/png', name: 'attachments/admin/1/detail.png', attDir: '/api/assets/301' },
      { attId: 302, type: 4, relationId: 44, moduleType: 1, imageType: 8, fileType: 1, attType: 'image/png', name: 'attachments/supplier/44/foreign.png', attDir: '/api/assets/302' },
      { attId: 303, type: 1, relationId: 0, moduleType: 1, imageType: 8, fileType: 2, attType: 'video/mp4', name: 'attachments/admin/1/detail.mp4', attDir: '/api/assets/303' },
    ]);
    await f.db.update(storeProduct).set({ image: '/api/assets/301', sliderImage: '["/api/assets/301","/api/assets/302"]', videoOpen: 1, videoLink: '/api/assets/303' }).where(eq(storeProduct.id, 70));
    await f.db.update(storeProductAttrValue).set({ image: '/api/assets/302' }).where(eq(storeProductAttrValue.id, 1));
    await f.db.insert(storeProductDescription).values({ productId: 70, description: '<p onclick="bad()"><img src="/api/assets/301"><img src="/api/assets/302"></p>' });
    const before = await state(), result = await richDetail(); expect(result.status, result.msg).toBe(200);
    expect(result.data.productInfo).toMatchObject({ image: '/api/assets/301', slider_image: ['/api/assets/301', ''], video_link: '/api/assets/303', attrs: [{ pic: '' }] });
    expect(result.data.editor.media_previews).not.toHaveProperty('/api/assets/302');
    for (const [path, signed] of [['/api/assets/301', result.data.editor.media_previews['/api/assets/301']], ['/api/assets/303', result.data.editor.video_preview]]) {
      const url = new URL(signed, 'https://local.invalid'), expires = Number(url.searchParams.get('expires'));
      expect(url.pathname).toBe(path); expect(expires).toBeGreaterThan(Math.floor(Date.now() / 1000));
      expect(url.searchParams.get('signature')).toBe(createHmac('sha256', f.env.APP_KEY).update(`GET\n${path}\n${expires}`).digest('base64url'));
    }
    expect(result.data.editor.description_preview).not.toContain('onclick'); expect(result.data.editor.description_preview).not.toContain('/api/assets/302');
    expect(await state()).toEqual(before);
    for (const reference of ['/api/assets/302', 'http://legacy.example.test/old.mp4']) {
      await f.db.update(storeProduct).set({ videoLink: reference }).where(eq(storeProduct.id, 70));
      const unchanged = await state(), unavailable = await richDetail(); expect(unavailable.status, unavailable.msg).toBe(200);
      expect(unavailable.data.productInfo.video_link).toBe(reference);
      expect(unavailable.data.editor).toMatchObject({ video_preview: '', video_selection: { stored: reference, available: false } });
      expect(await state()).toEqual(unchanged);
    }
  });

  it('rejects ambiguous site configuration and oversized complete source data without returning partial forms or changing rows', async () => {
    await f.db.insert(systemConfig).values([{ menuName: 'site_url', value: '"https://one.example.test"' }, { menuName: 'site_url', value: '"https://two.example.test"' }]);
    let before = await state(), result = await richDetail(); expect(result.status).not.toBe(200); expect(result.msg).toContain('重复'); expect(await state()).toEqual(before);
    await f.db.delete(systemConfig).where(eq(systemConfig.menuName, 'site_url'));
    await f.db.insert(storeProductDescription).values({ productId: 70, description: '长'.repeat(400000) });
    before = await state(); result = await richDetail(); expect(result.status).not.toBe(200); expect(result.msg).toContain('容量'); expect(await state()).toEqual(before);
  });

  it('refuses a complete directory over capacity instead of silently returning its first10000 rows', async () => {
    await f.exec("INSERT INTO store_product_category(id,cate_name,is_show,type,relation_id) SELECT 10000+i,'extra-'||i,1,0,0 FROM generate_series(1,10001) i");
    const before = await state(), result = await richDetail(); expect(result.status).not.toBe(200); expect(result.msg).toContain('容量'); expect(await state()).toEqual(before);
  });

  it('reads product, coupon, form, SKU and directory expansions from one real snapshot across a concurrent replacement', async () => {
    await f.db.insert(storeCouponIssue).values({ id: 800, title: '旧券' }); await f.db.insert(storeProductCoupon).values({ productId: 70, issueCouponId: 800 });
    await f.db.insert(systemForm).values({ id: 800, value: '[{"id":"old","name":"texts"}]' }); await f.db.update(storeProduct).set({ systemFormId: 800 }).where(eq(storeProduct.id, 70));
    await peers(async ([holder, reader]) => {
      await holder.exec('BEGIN; LOCK TABLE store_product_relation IN ACCESS EXCLUSIVE MODE'); const pending = richDetail(reader.db);
      try {
        await waitForFinanceBlock(f.db, reader.pid, holder.pid);
        await holder.exec("UPDATE store_product SET store_name='并发新值',price='99.00' WHERE id=70; UPDATE store_product_attr_value SET price='88.00' WHERE id=1; UPDATE store_coupon_issue SET title='新券' WHERE id=800; UPDATE system_form SET value='[{\"id\":\"new\",\"name\":\"texts\"}]' WHERE id=800; UPDATE shipping_templates SET name='新模板' WHERE id=10; UPDATE store_product_category SET cate_name='新目录' WHERE id=9");
      } finally { await holder.exec('COMMIT'); }
      const old = await pending; expect(old.status, old.msg).toBe(200);
      expect(old.data.productInfo).toMatchObject({ store_name: '完整报价隔离样本', price: 10, coupons: [{ id: 800, title: '旧券' }], custom_form: [{ id: 'old' }], attrs: [{ price: 10 }] });
      expect(old.data.tempList).toEqual([{ id: 10, name: '本地运费' }]); expect(old.data.cateList).toMatchObject([{ label: 'isolated' }]);
      const current = await richDetail(reader.db); expect(current.status, current.msg).toBe(200);
      expect(current.data.productInfo).toMatchObject({ store_name: '并发新值', price: 99, coupons: [{ id: 800, title: '新券' }], custom_form: [{ id: 'new' }], attrs: [{ price: 88 }] });
      expect(current.data.tempList).toEqual([{ id: 10, name: '新模板' }]); expect(current.data.cateList).toMatchObject([{ label: '新目录' }]);
    });
  }, 20_000);

  it('rejects deleted or foreign products before consulting a missing expansion catalog', async () => {
    await f.exec('ALTER TABLE shipping_templates RENAME TO hidden_out_detail_templates');
    for (const extra of [{ type: 2, relationId: 44, isDel: 0 }, { type: 0, relationId: 44, isDel: 0 }, { type: 0, relationId: 0, isDel: 1 }]) {
      await f.db.update(storeProduct).set(extra).where(eq(storeProduct.id, 70)); const before = await state();
      const result = await richDetail(); expect(result.status).not.toBe(200); expect(result.msg).toContain('不属于平台'); expect(await state()).toEqual(before);
    }
  });

  // Continue the existing admitted Out metadata acceptance file. The original
  // label/detail assertions above remain intact; no runner admission changes.
  const parameters = [{ id: 999, temp_id: 888, name: ' 材质 ', value: ' 自写棉 ', sort: -2 }];
  const parameterBody = () => ({ ...combined(), specs_id: 600, specs: parameters });
  const seedParameters = () => f.db.insert(legacyCategory).values([
    { id: 600, name: '平台参数', group: 3 }, { id: 601, name: '供应商参数', group: 3, type: 2, relationId: 44 },
    { id: 602, name: '错误分组', group: 2 }, { id: 603, name: '错误维护归属', group: 3, ownerId: 7 },
    { id: 604, name: '错误平台归属', group: 3, relationId: 44 }, { id: 605, name: '伪平台供应商', group: 3, type: 2 },
    { id: 606, name: '隐藏的参数模板', group: 3, isShow: 0 },
  ]);
  it('creates a genuine Out product with a five-key parameter snapshot and a type6 relation in its original receipt', async () => {
    await seedParameters();
    await f.exec("SELECT setval(pg_get_serial_sequence('store_product','id'),70,true); SELECT setval(pg_get_serial_sequence('store_product_attr_value','id'),1,true)");
    const input = { ...parameterBody(), attrs: body.attrs.map(row => ({ ...row, unique: 'parmnew1', bar_code: 'PARAM-NEW' })) };
    const saved = await request(f.db, input, operationId, '/outapi/product', 'POST'); expect(saved.status, saved.msg).toBe(200);
    const created = await f.db.select().from(storeProduct).where(eq(storeProduct.id, saved.data.id));
    expect(created[0]).toMatchObject({ specsId: 600, specs: JSON.stringify(parameters), stock: 999 });
    const read = await request(f.db, undefined, operationId, '/outapi/product/'+saved.data.id, 'GET');
    expect(read.status, read.msg).toBe(200); expect(read.data).toMatchObject({ specs_id: 600, specs_selection: { consistent: true, available: true }, productInfo: { specs_id: 600, specs: parameters } });
    const before = await state(), replay = await request(f.db, input, operationId, '/outapi/product', 'POST');
    expect(replay.data).toMatchObject({ id: saved.data.id, idempotent: true }); expect(await state()).toEqual(before);
  }, 20_000);
  it('atomically replaces parameters with all metadata, preserves existing stock and replays before later template admission', async () => {
    await seedParameters(); const before = await state(), untouched = await protectedRows([1, 2, 3, 4, 5, 6]);
    const saved = await request(f.db, parameterBody()); expect(saved.status, saved.msg).toBe(200);
    const after = await state(); expect(after.products[0]).toMatchObject({ specsId: 600, specs: JSON.stringify(parameters), brandCom: '30,31', ensureId: '92', storeLabelId: '101,102', labelId: '201,202' });
    expect(after.skus.map(row => [row.id, row.unique, row.stock, row.sumStock, row.sales])).toEqual(before.skus.map(row => [row.id, row.unique, row.stock, row.sumStock, row.sales]));
    expect(after.orders).toEqual(before.orders); expect(after.bills).toEqual(before.bills); expect(await protectedRows([1, 2, 3, 4, 5, 6])).toEqual(untouched);
    await f.db.update(legacyCategory).set({ type: 2, relationId: 44 }).where(eq(legacyCategory.id, 600));
    const retained = await state(), replay = await request(f.db, parameterBody()); expect(replay.status, replay.msg).toBe(200); expect(replay.data.idempotent).toBe(true); expect(await state()).toEqual(retained);
    const conflict = await request(f.db, { ...parameterBody(), specs: [{ ...parameters[0], value: '不同意图' }] }); expect(conflict.status).not.toBe(200); expect(await state()).toEqual(retained);
    const fresh = await request(f.db, parameterBody(), crypto.randomUUID()); expect(fresh.status).not.toBe(200); expect(await state()).toEqual(retained);
  }, 20_000);
  it('preserves omitted parameter bytes and relation versions without reading the template catalog', async () => {
    await seedParameters(); const saved = await request(f.db, parameterBody()); expect(saved.status, saved.msg).toBe(200);
    const before = await protectedRows([1]), product = (await state()).products[0];
    await f.exec('ALTER TABLE category RENAME TO hidden_out_parameter_category');
    try {
      const result = await request(f.db, body, crypto.randomUUID()); expect(result.status, result.msg).toBe(200);
      expect(await protectedRows([1])).toEqual(before);
      const [after] = await f.db.select().from(storeProduct).where(eq(storeProduct.id, 70)); expect([after.specsId, after.specs]).toEqual([product.specsId, product.specs]);
    } finally { await f.exec('ALTER TABLE hidden_out_parameter_category RENAME TO category'); }
  }, 20_000);
  it('clears only the explicit type6 selection and also accepts unbound custom snapshots and hidden platform templates', async () => {
    await seedParameters(); const before = await protectedRows([1, 6]);
    for (const input of [{ specs_id: 0, specs: [] }, { specs_id: 0, specs: parameters }, { specs_id: 606, specs: parameters }]) {
      const result = await request(f.db, { ...body, ...input }, crypto.randomUUID()); expect(result.status, result.msg).toBe(200);
      expect(await protectedRows([1, 6])).toEqual(before);
      const read = await detail(); expect(read.status, read.msg).toBe(200); expect(read.data).toMatchObject({ specs_id: input.specs_id, specs_selection: { consistent: true, available: true }, productInfo: { specs: input.specs } });
    }
    for (const show of [0, 1]) {
      const changed = await request(f.db, undefined, crypto.randomUUID(), '/outapi/product/set_show/70/'+show, 'PUT'); expect(changed.status, changed.msg).toBe(200);
      const read = await detail(); expect(read.status, read.msg).toBe(200); expect(read.data).toMatchObject({ specs_selection: { consistent: true, available: true } });
    }
  }, 20_000);
  it.each([601, 602, 603, 604, 605, 999])('rejects missing or foreign parameter template %i with no partial writes', async id => {
    await seedParameters(); const before = await state();
    const result = await request(f.db, { ...parameterBody(), specs_id: id }); expect(result.status).not.toBe(200); expect(result.msg).toContain('参数模板'); expect(await state()).toEqual(before);
  });
  it('fails refreshably on a real separate-session parameter template lock without changing the business snapshot', async () => {
    await seedParameters(); await peers(async ([holder, writer]) => {
      await holder.exec('BEGIN; SELECT id FROM category WHERE id=600 FOR UPDATE'); const before = await state();
      try { const result = await request(writer.db, parameterBody()); expect(result.status).not.toBe(200); expect(result.msg).toMatch(/变化|重试/); expect(await state()).toEqual(before); }
      finally { await holder.exec('ROLLBACK'); }
    });
  }, 20_000);
  it.each(['template', 'snapshot', 'unowned relation', 'owned brand'])('rolls the entire save and receipt back when the parameter writer corrupts %s', async kind => {
    await seedParameters(); const before = await state();
    const damage = kind === 'template' ? "UPDATE category SET name='被触发器改写' WHERE id=600;"
      : kind === 'snapshot' ? "UPDATE store_product SET specs='[]' WHERE id=70;" : kind === 'owned brand' ? "UPDATE store_product SET brand_id=40,brand_com='40' WHERE id=70;" : 'UPDATE store_product_relation SET status=1 WHERE id=1006;';
    await f.exec(`CREATE FUNCTION test_out_parameters_damage() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ${damage} RETURN NEW; END $$; CREATE TRIGGER test_out_parameters_damage AFTER INSERT ON store_product_relation FOR EACH ROW WHEN(NEW.type=6) EXECUTE FUNCTION test_out_parameters_damage()`);
    const result = await request(f.db, parameterBody()); expect(result.status).not.toBe(200); expect(await state()).toEqual(before);
  });
  it('detects parameter damage by the final receipt writer, including an omitted-field update', async () => {
    await seedParameters(); const saved = await request(f.db, parameterBody()); expect(saved.status, saved.msg).toBe(200);
    await f.exec("CREATE FUNCTION test_out_parameters_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN UPDATE store_product SET specs_id=606,specs='[]' WHERE id=70; RETURN NEW; END $$; CREATE CONSTRAINT TRIGGER test_out_parameters_receipt AFTER INSERT ON out_product_write_replay DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION test_out_parameters_receipt()");
    const before = await state();
    for (const input of [parameterBody(), body]) { const result = await request(f.db, input, crypto.randomUUID()); expect(result.status).not.toBe(200); expect(await state()).toEqual(before); }
  }, 20_000);
  it('keeps raw legacy parameter history and reports inconsistent or foreign selections without read repair', async () => {
    await seedParameters();
    for (const value of [{ specsId: 600, specs: 'broken snapshot' }, { specsId: 601, specs: JSON.stringify(parameters) }]) {
      await f.db.update(storeProduct).set(value).where(eq(storeProduct.id, 70));
      await f.db.update(storeProductRelation).set({ relationId: value.specsId }).where(eq(storeProductRelation.id, 1005));
      const before = await state(), read = await detail(); expect(read.status, read.msg).toBe(200);
      expect(read.data).toMatchObject({ specs: value.specs, specs_selection: { specs_id: value.specsId, specs: value.specs, available: false } }); expect(await state()).toEqual(before);
    }
  });
  it('reads parameter snapshots, type6 identity and template authority from one real repeatable-read snapshot', async () => {
    await seedParameters(); const saved = await request(f.db, parameterBody()); expect(saved.status, saved.msg).toBe(200);
    await peers(async ([holder, reader]) => {
      await holder.exec('BEGIN; LOCK TABLE store_product_relation IN ACCESS EXCLUSIVE MODE'); const pending = detail(reader.db);
      try { await waitForFinanceBlock(f.db, reader.pid, holder.pid); await holder.exec("UPDATE store_product SET specs_id=606,specs='[]' WHERE id=70; UPDATE store_product_relation SET relation_id=606 WHERE product_id=70 AND type=6; UPDATE category SET type=2,relation_id=44 WHERE id=600"); }
      finally { await holder.exec('COMMIT'); }
      const old = await pending; expect(old.status, old.msg).toBe(200); expect(old.data).toMatchObject({ specs_id: 600, specs: JSON.stringify(parameters), specs_selection: { consistent: true, available: true } });
      const current = await detail(reader.db); expect(current.status, current.msg).toBe(200); expect(current.data).toMatchObject({ specs_id: 606, specs: '[]', specs_selection: { consistent: true, available: true } });
    });
  }, 20_000);
  it('refuses reusing an omitted-field receipt key for an explicit parameter clear after upgrade', async () => {
    const saved = await request(f.db, body); expect(saved.status, saved.msg).toBe(200); const before = await state();
    const cleared = await request(f.db, { ...body, specs_id: 0, specs: [] }); expect(cleared.status).not.toBe(200); expect(await state()).toEqual(before);
  });
  it('uses the existing App plan on a genuine independent LOGIN for parameter save and read without changing catalog contents', async () => {
    await seedParameters(); if (!owned.withRuntimeRole) throw Error('Actual restricted LOGIN required');
    const catalog = await f.db.select().from(legacyCategory).orderBy(legacyCategory.id);
    await owned.withRuntimeRole(async runtime => {
      const plan = runtimeBusinessPrivilegePlan('app'), quote = (name: string) => { if (!/^[a-z_][a-z_0-9]*$/.test(name)) throw Error('Unexpected owned identifier'); return `"${name}"`; };
      const tables = await f.db.execute<{ name: string }>(sql`SELECT relname AS name FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind='r' ORDER BY relname`);
      for (const { name } of tables) {
        const rights = plan.tables[name]; if (!rights) continue;
        await f.exec(`GRANT ${rights.join(',')} ON public.${quote(name)} TO ${quote(runtime.role)}`);
        const columns = plan.updateColumns[name]; if (columns?.length) await f.exec(`GRANT UPDATE(${columns.map(quote).join(',')}) ON public.${quote(name)} TO ${quote(runtime.role)}`);
      }
      const sequences = await f.db.execute<{ table_name: string; sequence_name: string | null }>(sql`SELECT c.relname AS table_name,pg_get_serial_sequence('public.'||quote_ident(c.relname),a.attname) AS sequence_name FROM pg_class c JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped WHERE c.relnamespace='public'::regnamespace AND c.relkind='r'`);
      for (const row of sequences) if (row.sequence_name && plan.tables[row.table_name]?.includes('INSERT')) { const parts = row.sequence_name.split('.'); if (parts.length !== 2 || parts[0] !== 'public') throw Error('Unexpected owned sequence'); await f.exec(`GRANT USAGE ON SEQUENCE public.${quote(parts[1])} TO ${quote(runtime.role)}`); }
      const [identity] = await runtime.db.execute(sql`SELECT current_user AS role,session_user AS session,(SELECT rolsuper OR rolcreatedb OR rolcreaterole OR rolinherit OR rolbypassrls FROM pg_roles WHERE rolname=current_user) AS elevated`);
      expect(identity).toEqual({ role: runtime.role, session: runtime.role, elevated: false });
      const saved = await request(runtime.db, parameterBody()); expect(saved.status, saved.msg).toBe(200);
      const read = await detail(runtime.db); expect(read.status, read.msg).toBe(200); expect(read.data).toMatchObject({ specs_id: 600, specs_selection: { consistent: true, available: true } });
    });
    expect(await f.db.select().from(legacyCategory).orderBy(legacyCategory.id)).toEqual(catalog);
  }, 20_000);

});
