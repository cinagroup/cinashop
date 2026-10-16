import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, getTableName, sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { randomUUID } from 'node:crypto';
import { createApp } from '@/app';
import type { Env } from '@/env';
import { createContainerFromDb, type DbClient } from '@/lib/di';
import { createToken, md5 } from '@/utils/jwt';
import { storeProduct, storeProductAttrValue, storeProductRelation, storeProductCoupon, storeProductVirtual, systemAttachment,
  systemLog, storeOrderOutbox } from '@/models/schema';
import { SupplierProductCopyService } from '@/services/supplier/SupplierProductCopyService';
import { requiredSupplierPermissions } from '@/services/supplier/SupplierPermissionService';
import { supplierProductCopyFixture, supplierProductCopyAppKey, supplierProductCopyPassword, supplierCopyActor } from './helpers/supplierProductCopy';
import { validateFinanceFixtureUrl } from './helpers/financePostgres';
import { outcome, waitForFinanceBlock, withFinancePeers } from './helpers/financePeers';
import { pauseModerationExecute } from './helpers/adminProductModeration';

const wiring = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock('@/lib/di', async original => ({ ...await original<typeof import('@/lib/di')>(), createContainer: wiring.open }));
const app = createApp(), env = { APP_KEY: supplierProductCopyAppKey, UPSTASH_REDIS_URL: '', UPSTASH_REDIS_TOKEN: '' } as Env;
const service = (db: DbClient) => new SupplierProductCopyService(createContainerFromDb(db), supplierProductCopyAppKey);
function signal() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { resolve, promise }; }
function wrapTx(db: DbClient, wrap: (tx: DbClient) => DbClient): DbClient {
  return new Proxy(db, { get(target, key) {
    const operation = Reflect.get(target, key);
    if (key === 'transaction') return (work: (tx: DbClient) => unknown, ...options: unknown[]) =>
      Reflect.apply(operation, target, [(tx: DbClient) => work(wrap(tx)), ...options]);
    return typeof operation === 'function' ? operation.bind(target) : operation;
  } });
}

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('Supplier trusted complete copy on owned PG16, real JWT and independent LOGIN', () => {
  let f: Awaited<ReturnType<typeof supplierProductCopyFixture>>, tokens: Record<number, string>;
  beforeAll(async () => { f = await supplierProductCopyFixture(); wiring.open.mockImplementation(() => f.container); }, 60000);
  beforeEach(async () => {
    await f.reset();
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Supplier local copy forbids outbound I/O'));
    tokens = {}; for (const id of [21, 22, 23, 29, 31, 39]) tokens[id] = (await createToken(id, 'supplier', md5(supplierProductCopyPassword), env.APP_KEY)).token;
  }, 60000);
  afterEach(() => { expect(fetch).not.toHaveBeenCalled(); vi.restoreAllMocks(); });
  afterAll(async () => { await f?.close(); }, 30000);
  async function http(method: string, path: string, body?: unknown, actor = 21, raw?: string) {
    const response = await app.request(`/supplierapi${path}`, { method, headers: { ...(actor ? { Authorization: `Bearer ${tokens[actor]}` } : {}),
      'X-Supplier-Id': '30', ...(body !== undefined || raw !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      ...(raw !== undefined ? { body: raw } : body === undefined ? {} : { body: JSON.stringify(body) }) }, env);
    expect(response.headers.get('cache-control')).toContain('private, no-store');
    return { response, body: await response.json<{ status: number; msg: string; data: any }>() };
  }
  const root = async (id: number) => (await f.db.select().from(storeProduct).where(eq(storeProduct.id, id)))[0];
  const skus = (id: number) => f.db.select().from(storeProductAttrValue).where(and(eq(storeProductAttrValue.productId, id), eq(storeProductAttrValue.type, 0))).orderBy(storeProductAttrValue.id);
  async function preserved(before: Awaited<ReturnType<typeof f.snapshot>>) {
    const after = await f.snapshot();
    for (const [table, rows] of Object.entries(before)) for (const row of rows) expect(after[table], `existing ${table} row`).toContainEqual(row);
  }

  it('copies the complete physical source with hidden configuration and associations, fresh identities and an atomic terminal receipt', async () => {
    const before = await f.snapshot(), source = await root(80), sourceSkus = await skus(80), body = await f.body(80);
    body.product.store_name = 'Supplier complete copied product';
    const saved = await f.service.save(80, body, supplierCopyActor());
    expect(saved).toMatchObject({ operation_id: body.operation_id, actor_id: 21, supplier_id: 20, source_id: 80, state: 'committed', result: { is_show: 0, is_verify: 0 } });
    const id = saved.result!.id, copied = await root(id), copiedSkus = await skus(id);
    expect(id).toBeGreaterThan(82); expect(copied).toMatchObject({ type: 2, relationId: 20, productType: 0, isShow: 0, isVerify: 0, isDel: 0,
      storeName: 'Supplier complete copied product', sales: 0, soureLink: '', codePath: '', stock: 7 });
    expect(copied.spu).not.toBe(source.spu); expect(copied.spu).toMatch(/^\d{13}$/);
    for (const key of ['brandId', 'brandCom', 'storeLabelId', 'ensureId', 'specsId', 'specs', 'labelId', 'isVip', 'isSub', 'giveIntegral',
      'isHot', 'isBenefit', 'isBest', 'isNew', 'isGood', 'isVipProduct', 'commandWord', 'isPresaleProduct', 'presaleStartTime',
      'presaleEndTime', 'presaleDay', 'autoOnTime', 'autoOffTime', 'customForm', 'systemFormId', 'recommendList', 'freight', 'tempId', 'activity'] as const)
      expect(copied[key], key).toEqual(source[key]);
    expect(copiedSkus).toHaveLength(1); expect(copiedSkus[0]).toMatchObject({ stock: 7, sumStock: 7, sales: 0, settlePrice: '3.00', code: 'source-sku-code', diskInfo: '', isRetired: 0 });
    expect(copiedSkus[0].id).not.toBe(sourceSkus[0].id); expect(copiedSkus[0].unique).not.toBe(sourceSkus[0].unique);
    const associations = async (productId: number) => (await f.db.select().from(storeProductRelation).where(eq(storeProductRelation.productId, productId)))
      .map(({ type, relationId, relationPid }) => ({ type, relationId, relationPid })).sort((a, b) => a.type - b.type || a.relationId - b.relationId);
    expect(await associations(id)).toEqual(await associations(80));
    expect((await f.db.select().from(storeProductCoupon).where(eq(storeProductCoupon.productId, id))).map(row => row.issueCouponId)).toEqual([71]);
    expect(await f.service.receipt(body.operation_id, supplierCopyActor())).toEqual(saved);
    await preserved(before);
  });

  it('reads recycled card and manual sources without selecting card rows or exposing fixed material, SKU identities or retired inventory', async () => {
    const observed: string[] = [];
    const guarded = wrapTx(f.db, tx => new Proxy(tx, { get(target, key) {
      const operation = Reflect.get(target, key);
      if (key === 'select') return (...args: unknown[]) => {
        const builder = Reflect.apply(operation, target, args);
        if (!builder || typeof builder !== 'object') throw Error('Actual Drizzle select builder must be an object');
        return new Proxy(builder, { get(selection, property) {
          const next = Reflect.get(selection, property);
          if (property === 'from') return (table: Parameters<typeof getTableName>[0]) => {
            const name = getTableName(table); observed.push(name); expect(name).not.toBe('store_product_virtual');
            return Reflect.apply(next, selection, [table]);
          };
          return typeof next === 'function' ? next.bind(selection) : next;
        } });
      };
      return typeof operation === 'function' ? operation.bind(target) : operation;
    } }));
    const before = await f.snapshot(), card = await service(guarded).seed(81, supplierCopyActor());
    expect(card.copy).toMatchObject({ source_id: 81, destination: { type: 2, relation_id: 20 } });
    expect(card.copy.token).toMatch(/^[a-f0-9]{64}$/); expect(card.product).toMatchObject({ id: 0, product_type: 1, retired_attrs: [] });
    const encoded = JSON.stringify(card); expect(encoded).not.toMatch(/SYNTHETIC-SOURCE|SOURCE-CARD|SOURCE-PASSWORD|oldcopy1|retained-source-issued-order|original_disk_info|virtual_list|sum_stock|cards_count/);
    const product = card.product as Record<string, unknown>, attrs = product.attrs;
    expect(Array.isArray(attrs)).toBe(true);
    if (!Array.isArray(attrs)) throw Error('Actual copy seed must contain an attrs array');
    for (const attr of attrs) {
      if (!attr || typeof attr !== 'object' || Array.isArray(attr)) throw Error('Actual copy SKU must be an object');
      expect(attr).toMatchObject({ stock: 0, disk_info: '' }); expect(attr).not.toHaveProperty('id'); expect(attr).not.toHaveProperty('unique');
    }
    expect(observed).toContain('store_product_attr_value'); expect(await f.snapshot()).toEqual(before);
    expect((await f.service.seed(82, supplierCopyActor())).product).toMatchObject({ product_type: 3 });
  });

  it('creates card and manual copies without inheriting issued/unissued credentials, fixed material, retired SKUs, source sales or provenance', async () => {
    const before = await f.snapshot();
    for (const sourceId of [81, 82]) {
      const body = await f.body(sourceId), receipt = await f.service.save(sourceId, body, supplierCopyActor());
      const id = receipt.result!.id, source = await root(sourceId), destination = await root(id), rows = await skus(id);
      expect(destination).toMatchObject({ type: 2, relationId: 20, productType: source.productType, isDel: 0, isShow: 0, isVerify: 0, sales: 0, soureLink: '', codePath: '' });
      expect(rows.every(row => row.isRetired === 0 && row.diskInfo === '' && row.sales === 0)).toBe(true);
      expect(await f.db.select().from(storeProductVirtual).where(eq(storeProductVirtual.productId, id))).toEqual([]);
      if (sourceId === 81) { expect(rows).toHaveLength(2); expect(rows.every(row => row.stock === 0 && row.sumStock === 0)).toBe(true); expect(destination.stock).toBe(0); }
      else { expect(rows).toHaveLength(1); expect(destination.stock).toBe(7); }
      expect(rows.map(row => row.unique).some(unique => (before.store_product_attr_value as any[]).some(entry => entry.row.unique === unique))).toBe(false);
    }
    await preserved(before);
  });

  it('preserves a disabled source video switch when its stable link is unchanged, and derives the switch only for an explicit link change', async () => {
    await f.exec("UPDATE store_product SET video_open=0,video_link='https://owned-video.example/source.mp4' WHERE id=80");
    const unchanged = await f.body(80), first = await f.service.save(80, unchanged, supplierCopyActor());
    expect(await root(first.result!.id)).toMatchObject({ videoOpen: 0, videoLink: 'https://owned-video.example/source.mp4' });
    const changed = await f.body(80); changed.product.video_link = 'https://owned-video.example/replaced.mp4';
    const second = await f.service.save(80, changed, supplierCopyActor());
    expect(await root(second.result!.id)).toMatchObject({ videoOpen: 1, videoLink: 'https://owned-video.example/replaced.mp4' });
    const removed = await f.body(80); removed.product.video_link = '';
    const third = await f.service.save(80, removed, supplierCopyActor());
    expect(await root(third.result!.id)).toMatchObject({ videoOpen: 0, videoLink: '' });
    expect(await root(80)).toMatchObject({ videoOpen: 0, videoLink: 'https://owned-video.example/source.mp4' });
  });

  it('inherits omitted labels but treats an explicit empty label set as a deliberate replacement while preserving other hidden associations', async () => {
    const inherited = await f.body(80); expect(inherited.product).not.toHaveProperty('store_label_id');
    const first = await f.service.save(80, inherited, supplierCopyActor());
    expect((await root(first.result!.id)).storeLabelId).toBe('31');
    const cleared = await f.body(80); cleared.product.store_label_id = [];
    const second = await f.service.save(80, cleared, supplierCopyActor());
    expect((await root(second.result!.id)).storeLabelId).toBe('');
    expect(await f.db.select().from(storeProductRelation).where(and(eq(storeProductRelation.productId, second.result!.id), eq(storeProductRelation.type, 3)))).toEqual([]);
    expect((await f.db.select().from(storeProductRelation).where(eq(storeProductRelation.productId, second.result!.id))).map(row => row.type).sort()).toEqual([1, 2, 4, 5, 6]);
    expect((await root(80)).storeLabelId).toBe('31');
  });

  it('canonicalizes the effective legacy user-label relation without rewriting the historical empty source scalar or its association', async () => {
    await f.exec("UPDATE store_product SET label_id='' WHERE id=80");
    const before = await f.snapshot(), body = await f.body(80), saved = await f.service.save(80, body, supplierCopyActor());
    expect((await root(saved.result!.id)).labelId).toBe('61'); expect((await root(80)).labelId).toBe('');
    expect((await f.db.select().from(storeProductRelation).where(and(eq(storeProductRelation.productId, saved.result!.id), eq(storeProductRelation.type, 4)))).map(row => row.relationId)).toEqual([61]);
    await preserved(before);
  });

  it('requires actual Supplier manage authority, isolates owner/type collisions and never lets a numeric GET grant authorize copy writes', async () => {
    const body = await f.body(80), before = await f.snapshot();
    expect(requiredSupplierPermissions('GET', '/supplierapi/product/product/copy/80')).toEqual(['supplier.product.view']);
    expect(requiredSupplierPermissions('POST', '/supplierapi/product/product/copy/80')).toEqual(['supplier.product.manage']);
    expect(requiredSupplierPermissions('GET', `/supplierapi/product/product/copy_operations/${body.operation_id}`)).toEqual([]);
    for (const actor of [22, 23]) {
      expect((await http('GET', '/product/product/copy/80', undefined, actor)).body.status).toBe(400011);
      expect((await http('POST', '/product/product/copy/80', body, actor)).body.status).toBe(400011);
    }
    expect((await http('GET', '/product/product/copy/80', undefined, 0)).body.status).toBe(410000);
    expect((await http('GET', '/product/product/copy/80', undefined, 31)).body.status).toBe(404);
    await expect(f.service.seed(80, { ...supplierCopyActor(), supplierId: 30 })).rejects.toBeDefined();
    await f.exec('UPDATE store_product SET type=0,relation_id=0 WHERE id=82');
    expect((await http('GET', '/product/product/copy/82')).body.status).toBe(404);
    await f.exec('UPDATE store_product SET type=2,relation_id=20 WHERE id=82');
    expect(await f.snapshot()).toEqual(before);
  });

  it('rejects forged context, SKU identities, delivery material, card stock and malformed envelopes without any receipt or business mutation', async () => {
    const valid = await f.body(81), before = await f.snapshot();
    const cases: unknown[] = [
      { ...valid, supplier_id: 30 }, { ...valid, product: { ...valid.product, id: 81 } },
      { ...valid, product: { ...valid.product, supplier_id: 30 } }, { ...valid, product: { ...valid.product, is_show: 1 } },
      { ...valid, product: { ...valid.product, product_type: 2 } }, { ...valid, product: { ...valid.product, retired_attrs: [] } },
      { ...valid, product: { ...valid.product, store_label_id: [31, 31] } },
      { ...valid, operation_id: randomUUID().toUpperCase() }, { ...valid, copy_token: '0'.repeat(63) },
    ];
    for (const addition of [{ id: 1 }, { unique: 'source99' }, { disk_info: 'new secret' }, { virtual_list: [] }, { stock: 1 }, { sales: 1 }, { sum_stock: 1 }])
      cases.push({ ...valid, product: { ...valid.product, attrs: (valid.product.attrs as any[]).map((row, i) => i === 0 ? { ...row, ...addition } : row) } });
    for (const candidate of cases) expect((await http('POST', '/product/product/copy/81', candidate)).body.status).toBe(400);
    for (const raw of ['[]', '{"operation_id":"x","operation_id":"y"}', 'x'.repeat(1024 * 1024 + 1)])
      expect((await http('POST', '/product/product/copy/81', undefined, 21, raw)).body.status).toBe(400);
    for (const suffix of ['?copyMode=1', '?supplier_id=30', '?type=2']) expect((await http('GET', `/product/product/copy/81${suffix}`)).body.status).toBe(400);
    const changedType = await f.body(80); changedType.product.product_type = 3;
    expect((await http('POST', '/product/product/copy/80', changedType)).body.status).toBe(400);
    expect(await f.snapshot()).toEqual(before);
  });

  it('rejects every stale source collection including hidden config and immutable delivery metadata, with no destination or receipt', async () => {
    for (const [sourceId, change] of [
      [80, "UPDATE store_product SET command_word=command_word||'-changed' WHERE id=80"],
      [80, 'UPDATE store_product_attr_value SET weight=weight+1 WHERE product_id=80 AND type=0'],
      [80, "UPDATE store_product_description SET description=description||'<p>changed</p>' WHERE product_id=80 AND type=0"],
      [80, 'UPDATE store_product_relation SET relation_pid=relation_pid+1 WHERE product_id=80 AND type=2'],
      [80, 'UPDATE store_product_coupon SET add_time=add_time+1 WHERE product_id=80'],
      [81, "UPDATE store_product_attr_value SET disk_info=disk_info||'-changed' WHERE product_id=81 AND disk_info<>''"],
    ] as const) {
      const body = await f.body(sourceId); await f.exec(change); const before = await f.snapshot();
      await expect(f.service.save(sourceId, body, supplierCopyActor())).rejects.toMatchObject({ code: 409 });
      expect(await f.snapshot()).toEqual(before);
    }
  });

  it('validates inherited enabled configuration and ERP admission instead of silently dropping stale brands, labels, templates or form bindings', async () => {
    for (const [change, restore] of [
      ['UPDATE store_brand SET is_show=0 WHERE id=12', 'UPDATE store_brand SET is_show=1 WHERE id=12'],
      ['UPDATE store_product_label SET status=0 WHERE id=31', 'UPDATE store_product_label SET status=1 WHERE id=31'],
      ['UPDATE category SET is_show=0 WHERE id=21', 'UPDATE category SET is_show=1 WHERE id=21'],
      ['UPDATE shipping_templates SET status=0 WHERE id=91', 'UPDATE shipping_templates SET status=1 WHERE id=91'],
      ['UPDATE system_form SET status=0 WHERE id=81', 'UPDATE system_form SET status=1 WHERE id=81'],
      ['UPDATE user_label SET status=0 WHERE id=61', 'UPDATE user_label SET status=1 WHERE id=61'],
    ]) {
      await f.exec(change); const body = await f.body(80), before = await f.snapshot();
      try { await expect(f.service.save(80, body, supplierCopyActor())).rejects.toBeDefined(); expect(await f.snapshot()).toEqual(before); }
      finally { await f.exec(restore); }
    }
    await f.exec("INSERT INTO system_config(menu_name,value) VALUES('erp_open','1')");
    const body = await f.body(80), before = await f.snapshot();
    await expect(f.service.save(80, body, supplierCopyActor())).rejects.toBeDefined(); expect(await f.snapshot()).toEqual(before);
    const manual = await f.body(82), saved = await f.service.save(82, manual, supplierCopyActor());
    expect((await root(saved.result!.id)).productType).toBe(3); await preserved(before);
  });

  it('round-trips owned private media through real JWT copy while keeping signed previews out of persistence, and wholly refuses revoked hidden or visible references', async () => {
    await f.db.insert(systemAttachment).values([
      { attId: 501, type: 4, relationId: 20, moduleType: 1, fileType: 1, imageType: 8, name: 'attachments/supplier/20/owned-copy.png', attDir: '/api/assets/501', attType: 'image/png' },
      { attId: 502, type: 4, relationId: 20, moduleType: 1, fileType: 2, imageType: 8, name: 'attachments/supplier/20/owned-copy.mp4', attDir: '/api/assets/502', attType: 'video/mp4' },
    ]);
    await f.exec(`UPDATE store_product SET image='/api/assets/501',slider_image='["/api/assets/501"]',recommend_image='/api/assets/501',video_link='/api/assets/502',video_open=1 WHERE id=80;
      UPDATE store_product_attr_value SET image='/api/assets/501' WHERE product_id=80;
      UPDATE store_product_description SET description='<p><img src="/api/assets/501"></p>' WHERE product_id=80 AND type=0`);
    const seed = await http('GET', '/product/product/copy/80'); expect(seed.body.status, seed.body.msg).toBe(200);
    expect(seed.body.data.product.video_link).toBe('/api/assets/502'); expect(seed.body.data.product.video_preview_url).toMatch(/^\/api\/assets\/502\?expires=\d+&signature=/);
    const body = await f.body(80), before = await f.snapshot(), response = await http('POST', '/product/product/copy/80', body);
    expect(response.body.status, response.body.msg).toBe(200); const id = response.body.data.result.id;
    expect(await root(id)).toMatchObject({ videoLink: '/api/assets/502', videoOpen: 1, image: '/api/assets/501', recommendImage: '/api/assets/501' });
    expect((await skus(id))[0].image).toBe('/api/assets/501'); await preserved(before);
    expect(JSON.stringify(await f.snapshot())).not.toMatch(/signature=|expires=/);
    for (const [change, restore] of [
      ["UPDATE system_attachment SET relation_id=30,name='attachments/supplier/30/owned-copy.png' WHERE att_id=501", "UPDATE system_attachment SET relation_id=20,name='attachments/supplier/20/owned-copy.png' WHERE att_id=501"],
      ["UPDATE system_attachment SET att_type='text/html' WHERE att_id=502", "UPDATE system_attachment SET att_type='video/mp4' WHERE att_id=502"],
    ]) {
      const valid = await f.body(80); await f.exec(change); const current = await f.snapshot();
      try {
        await expect(f.service.seed(80, supplierCopyActor())).rejects.toMatchObject({ code: 409 });
        await expect(f.service.save(80, valid, supplierCopyActor())).rejects.toMatchObject({ code: 409 }); expect(await f.snapshot()).toEqual(current);
      } finally { await f.exec(restore); }
    }
    // A denied hidden recommendation slot must reject the whole copy even
    // when all editable image fields remain valid.
    await f.exec("UPDATE store_product SET recommend_image='/api/assets/999' WHERE id=80");
    const current = await f.snapshot(); await expect(f.service.seed(80, supplierCopyActor())).rejects.toMatchObject({ code: 409 }); expect(await f.snapshot()).toEqual(current);
  });

  it('replays the exact committed UUID without a second product, SKU, audit or outbox even after the source changes or disappears', async () => {
    const body = await f.body(80), receipt = await f.service.save(80, body, supplierCopyActor()), committed = await f.snapshot();
    expect(await f.service.save(80, body, supplierCopyActor())).toEqual(receipt); expect(await f.snapshot()).toEqual(committed);
    await f.exec("UPDATE store_product SET store_name='source changed after commit' WHERE id=80");
    const changed = await f.snapshot(); expect(await f.service.save(80, body, supplierCopyActor())).toEqual(receipt); expect(await f.snapshot()).toEqual(changed);
    await f.exec('DELETE FROM store_product WHERE id=80');
    const absent = await f.snapshot(); expect(await f.service.save(80, body, supplierCopyActor())).toEqual(receipt); expect(await f.snapshot()).toEqual(absent);
    expect((await f.db.select().from(systemLog))).toHaveLength(4); expect((await f.db.select().from(storeOrderOutbox))).toHaveLength(4);
  });

  it('binds receipt replay to the exact actor, supplier, source, MAC and editable body rather than accepting a caller-selected existing result', async () => {
    const body = await f.body(80); await f.service.save(80, body, supplierCopyActor()); const before = await f.snapshot();
    for (const candidate of [{ ...body, product: { ...body.product, store_name: 'changed' } }, { ...body, copy_token: 'a'.repeat(64) }])
      await expect(f.service.save(80, candidate, supplierCopyActor())).rejects.toMatchObject({ code: 409 });
    await expect(f.service.save(82, body, supplierCopyActor())).rejects.toMatchObject({ code: 409 });
    await expect(f.service.receipt(body.operation_id, supplierCopyActor(31))).rejects.toMatchObject({ code: 400011 });
    await expect(f.service.receipt(body.operation_id, supplierCopyActor(29))).rejects.toMatchObject({ code: 400011 });
    await expect(f.service.resolve(body.operation_id, 82, supplierCopyActor())).rejects.toMatchObject({ code: 409 });
    expect(await f.snapshot()).toEqual(before);
  });

  it('recovers a genuine COMMIT with a lost driver response from the original receipt, and never reapplies the copy', async () => {
    const body = await f.body(80); let dropped = false;
    const lost = new Proxy(f.db, { get(target, key) {
      const operation = Reflect.get(target, key);
      if (key === 'transaction') return async (...args: unknown[]) => {
        const result = await Reflect.apply(operation, target, args);
        if (!dropped) { dropped = true; throw Error('owned transport dropped after actual COMMIT'); } return result;
      };
      return typeof operation === 'function' ? operation.bind(target) : operation;
    } });
    await expect(service(lost).save(80, body, supplierCopyActor())).rejects.toThrow('after actual COMMIT');
    const receipt = await f.service.receipt(body.operation_id, supplierCopyActor()); expect(receipt.state).toBe('committed');
    expect(await root(receipt.result!.id)).toMatchObject({ type: 2, relationId: 20, isShow: 0, isVerify: 0 });
    const before = await f.snapshot(); expect(await f.service.save(80, body, supplierCopyActor())).toEqual(receipt); expect(await f.snapshot()).toEqual(before);
  });

  it('returns unknown without DML and durably seals not-applied resolution with the same UUID/source, including after manage is withdrawn', async () => {
    const body = await f.body(80), before = await f.snapshot();
    expect(await f.service.receipt(body.operation_id, supplierCopyActor())).toEqual({ operation_id: body.operation_id, actor_id: 21, supplier_id: 20, source_id: null, state: 'unknown', result: null });
    expect(await f.snapshot()).toEqual(before);
    await f.exec("UPDATE system_role SET rules='supplier.product.view' WHERE id=21");
    const sealed = await http('POST', `/product/product/copy_operations/${body.operation_id}/resolve`, { source_id: 80 });
    expect(sealed.body.status, sealed.body.msg).toBe(200); expect(sealed.body.data).toMatchObject({ source_id: 80, state: 'not_applied', result: null });
    expect((await http('GET', `/product/product/copy_operations/${body.operation_id}`)).body.data).toEqual(sealed.body.data);
    expect((await http('POST', `/product/product/copy_operations/${body.operation_id}/resolve`, { source_id: 80 })).body.data).toEqual(sealed.body.data);
    expect((await http('POST', `/product/product/copy_operations/${body.operation_id}/resolve`, { source_id: 82 })).body.status).toBe(409);
    await f.exec("UPDATE system_role SET rules='supplier.product.manage' WHERE id=21");
    const terminal = await f.snapshot(); await expect(f.service.save(80, body, supplierCopyActor())).rejects.toMatchObject({ code: 409 }); expect(await f.snapshot()).toEqual(terminal);
    expect(await f.db.select().from(storeProduct)).toHaveLength(3);
  });

  it('allows self-service committed recovery after manage revocation but still rejects moved, disabled, deleted and credential-changed live identities', async () => {
    const body = await f.body(80), receipt = await f.service.save(80, body, supplierCopyActor());
    await f.exec("UPDATE system_role SET rules='supplier.product.view' WHERE id=21");
    expect((await http('GET', `/product/product/copy_operations/${body.operation_id}`)).body.data).toEqual(receipt);
    expect((await http('POST', `/product/product/copy_operations/${body.operation_id}/resolve`, { source_id: 80 })).body.data).toEqual(receipt);
    expect((await http('GET', '/product/product/copy/80')).body.status).toBe(400011);
    for (const [change, restore] of [
      ['UPDATE system_admin SET status=0 WHERE id=21', 'UPDATE system_admin SET status=1 WHERE id=21'],
      ['UPDATE system_admin SET is_del=1 WHERE id=21', 'UPDATE system_admin SET is_del=0 WHERE id=21'],
      ['UPDATE system_admin SET relation_id=30 WHERE id=21', 'UPDATE system_admin SET relation_id=20 WHERE id=21'],
      ["UPDATE system_admin SET pwd='changed' WHERE id=21", `UPDATE system_admin SET pwd='${supplierProductCopyPassword}' WHERE id=21`],
      ['UPDATE system_supplier SET is_show=0 WHERE id=20', 'UPDATE system_supplier SET is_show=1 WHERE id=20'],
    ]) {
      await f.exec(change); const before = await f.snapshot();
      try { await expect(f.service.receipt(body.operation_id, supplierCopyActor())).rejects.toBeDefined(); expect(await f.snapshot()).toEqual(before); }
      finally { await f.exec(restore); }
    }
    await expect(f.service.receipt(body.operation_id, { ...supplierCopyActor(), expiresAt: 1 })).rejects.toMatchObject({ code: 410001 });
  });

  it('refuses independently held authority, configuration and source collection DML through real NOWAIT barriers with zero partial copy', async () => {
    const body = await f.body(80), before = await f.snapshot();
    await withFinancePeers(f.db, async ([writer, blocker]) => {
      for (const [table, statement] of [
        ['system_role', 'UPDATE system_role SET rules=rules WHERE id=21'],
        ['system_menus', 'UPDATE system_menus SET menu_name=menu_name WHERE id=930081'],
        ['system_attachment', 'LOCK TABLE system_attachment IN ROW EXCLUSIVE MODE'],
        ['store_product', 'UPDATE store_product SET sales=sales WHERE id=80'],
        ['store_product_attr_value', 'UPDATE store_product_attr_value SET stock=stock WHERE product_id=80'],
        ['store_product_relation', 'UPDATE store_product_relation SET status=status WHERE product_id=80'],
        ['store_product_virtual', 'UPDATE store_product_virtual SET uid=uid WHERE product_id=81'],
      ]) {
        const ready = signal(), release = signal();
        const held = outcome(blocker.db.transaction(async tx => { await tx.execute(sql.raw(statement)); ready.resolve(); await release.promise; }));
        try {
          await Promise.race([ready.promise, held.then(result => { if (!result.ok) throw result.error; throw Error('DML holder exited before admission'); })]);
          expect(await f.exec(`SELECT mode,granted FROM pg_locks WHERE pid=${blocker.pid} AND relation='public.${table}'::regclass`))
            .toEqual(expect.arrayContaining([expect.objectContaining({ mode: 'RowExclusiveLock', granted: true })]));
          await expect(service(writer.db).save(80, body, supplierCopyActor())).rejects.toMatchObject({ code: 409 });
          expect(await f.snapshot()).toEqual(before);
        } finally { release.resolve(); const done = await held; if (!done.ok) throw done.error; }
      }
    });
  }, 60000);

  it('serializes an absent source-relation phantom behind the executed full table barrier and preserves the later independent writer', async () => {
    const body = await f.body(80);
    await withFinancePeers(f.db, async ([writer, peer]) => {
      const ready = signal(), release = signal();
      const hooked = pauseModerationExecute(writer.db, /LOCK TABLE ONLY[\s\S]*store_product_attr_value[\s\S]*SHARE ROW EXCLUSIVE MODE NOWAIT/i,
        async () => { ready.resolve(); await release.promise; });
      const pending = outcome(service(hooked).save(80, body, supplierCopyActor()));
      let phantom: ReturnType<typeof outcome<unknown>> | undefined;
      try {
        await Promise.race([ready.promise, pending.then(result => { if (!result.ok) throw result.error; throw Error('Copy did not reach source table fence'); })]);
        phantom = outcome(peer.exec('INSERT INTO store_product_relation(product_id,type,relation_id) VALUES(80,8,999)'));
        await waitForFinanceBlock(f.db, peer.pid, writer.pid);
        expect(await f.db.select().from(storeProductRelation).where(and(eq(storeProductRelation.productId, 80), eq(storeProductRelation.type, 8)))).toEqual([]);
      } finally { release.resolve(); await pending; if (phantom) await phantom; }
      const saved = await pending; if (!saved.ok) throw saved.error;
      expect(saved.value.state).toBe('committed'); expect(phantom).toBeDefined(); const inserted = await phantom!; if (!inserted.ok) throw inserted.error;
      expect(await f.db.select().from(storeProductRelation).where(and(eq(storeProductRelation.productId, saved.value.result!.id), eq(storeProductRelation.type, 8)))).toEqual([]);
      expect(await f.db.select().from(storeProductRelation).where(and(eq(storeProductRelation.productId, 80), eq(storeProductRelation.type, 8)))).toHaveLength(1);
    });
  });

  it('never resolves an in-flight UUID to not-applied, then exposes exactly the original committed result after the held transaction releases', async () => {
    const body = await f.body(80);
    await withFinancePeers(f.db, async ([writer, resolver]) => {
      const ready = signal(), release = signal();
      const hooked = pauseModerationExecute(writer.db, /pg_try_advisory_xact_lock\(731743,hashtext/i, async () => { ready.resolve(); await release.promise; });
      const pending = outcome(service(hooked).save(80, body, supplierCopyActor()));
      try {
        await Promise.race([ready.promise, pending.then(result => { if (!result.ok) throw result.error; throw Error('Copy did not hold original UUID'); })]);
        await expect(service(resolver.db).resolve(body.operation_id, 80, supplierCopyActor())).rejects.toMatchObject({ code: 409 });
        expect((await service(resolver.db).receipt(body.operation_id, supplierCopyActor())).state).toBe('unknown');
        expect(await f.db.execute(sql`SELECT 1 FROM supplier_product_copy_operation_v1 WHERE operation_id=${body.operation_id}::uuid`)).toEqual([]);
      } finally { release.resolve(); await pending; }
      const done = await pending; if (!done.ok) throw done.error;
      expect(await service(resolver.db).resolve(body.operation_id, 80, supplierCopyActor())).toEqual(done.value);
      const before = await f.snapshot(); expect(await service(resolver.db).save(80, body, supplierCopyActor())).toEqual(done.value); expect(await f.snapshot()).toEqual(before);
    });
  });

  it('rolls back complete copy DML and its receipt if a real insertion trigger suppresses any required business, association, audit or outbox row', async () => {
    for (const table of ['store_product', 'store_product_attr_value', 'store_product_attr_result', 'store_product_description',
      'store_product_relation', 'store_product_coupon', 'store_product_stock_record', 'system_log', 'store_order_outbox', 'store_product_attr']) {
      const sourceId = table === 'store_product_attr' ? 81 : 80, body = await f.body(sourceId), before = await f.snapshot();
      await f.exec(`CREATE FUNCTION copy_skip() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RETURN NULL; END$$; CREATE TRIGGER copy_skip BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION copy_skip()`);
      try { await expect(f.service.save(sourceId, body, supplierCopyActor())).rejects.toBeDefined(); expect(await f.snapshot()).toEqual(before); }
      finally { await f.exec(`DROP TRIGGER copy_skip ON ${table}; DROP FUNCTION copy_skip()`); }
    }
  }, 60000);

  it('rechecks hidden source, destination, inherited config and current authority after audit writes instead of trusting earlier readbacks', async () => {
    for (const statement of [
      "UPDATE store_product SET command_word='tampered source' WHERE id=80",
      "UPDATE store_product SET store_name='tampered destination' WHERE id>82",
      'UPDATE store_product_relation SET relation_pid=999 WHERE product_id>82',
      'UPDATE store_brand SET is_show=0 WHERE id=12',
      "UPDATE system_role SET rules='supplier.product.view' WHERE id=21",
    ]) {
      const body = await f.body(80), before = await f.snapshot();
      await f.exec(`CREATE FUNCTION copy_late() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN ${statement}; RETURN NEW; END$$; CREATE TRIGGER copy_late BEFORE INSERT ON system_log FOR EACH ROW EXECUTE FUNCTION copy_late()`);
      try { await expect(f.service.save(80, body, supplierCopyActor())).rejects.toBeDefined(); expect(await f.snapshot()).toEqual(before); }
      finally { await f.exec('DROP TRIGGER copy_late ON system_log; DROP FUNCTION copy_late()'); }
    }
  }, 60000);

  it('rechecks the actual database clock after late outbox work and rolls back destination, audit and receipt when the JWT expires', async () => {
    const body = await f.body(80), before = await f.snapshot();
    const [time] = await f.db.execute(sql`SELECT floor(extract(epoch FROM clock_timestamp()))::integer AS now`);
    await f.exec('CREATE FUNCTION copy_expiry() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN PERFORM pg_sleep(2.1); RETURN NEW; END$$; CREATE TRIGGER copy_expiry BEFORE INSERT ON store_order_outbox FOR EACH ROW EXECUTE FUNCTION copy_expiry()');
    try { await expect(f.service.save(80, body, { ...supplierCopyActor(), expiresAt: Number(time.now) + 2 })).rejects.toMatchObject({ code: 410001 }); expect(await f.snapshot()).toEqual(before); }
    finally { await f.exec('DROP TRIGGER copy_expiry ON store_order_outbox; DROP FUNCTION copy_expiry()'); }
  });

  it('keeps caller repeatable-read/read-only and stricter timeout requirements, and rejects absent or drifted receipt maintenance without business DML', async () => {
    const seen: Array<Record<string, string>> = [], dialect = new PgDialect();
    const hooked = wrapTx(f.db, tx => new Proxy(tx, { get(target, key) {
      const operation = Reflect.get(target, key);
      if (key === 'execute') return async (...args: unknown[]) => {
        const query = dialect.sqlToQuery(args[0] as Parameters<PgDialect['sqlToQuery']>[0]).sql;
        const result = await Reflect.apply(operation, target, args);
        if (/set_config\('idle_in_transaction_session_timeout'/.test(query)) {
          const [config] = await target.execute(sql`SELECT current_setting('transaction_isolation') AS isolation,current_setting('transaction_read_only') AS readonly,
            current_setting('statement_timeout') AS statement,current_setting('lock_timeout') AS lock`);
          seen.push(config as Record<string, string>);
        }
        return result;
      };
      return typeof operation === 'function' ? operation.bind(target) : operation;
    } }));
    await service(hooked).seed(80, supplierCopyActor());
    expect(seen).toContainEqual({ isolation: 'repeatable read', readonly: 'on', statement: '5s', lock: '2s' });
    const body = await f.body(80), before = await f.snapshot();
    await f.exec('CREATE INDEX copy_receipt_drift ON supplier_product_copy_operation_v1(actor_id)');
    try { await expect(f.service.save(80, body, supplierCopyActor())).rejects.toMatchObject({ code: 503 }); expect(await f.snapshot()).toEqual(before); }
    finally { await f.exec('DROP INDEX copy_receipt_drift'); }
    await f.exec('ALTER TABLE supplier_product_copy_operation_v1 RENAME TO supplier_product_copy_operation_missing');
    try { await expect(f.service.save(80, body, supplierCopyActor())).rejects.toMatchObject({ code: 503 }); }
    finally { await f.exec('ALTER TABLE supplier_product_copy_operation_missing RENAME TO supplier_product_copy_operation_v1'); }
    expect(await f.snapshot()).toEqual(before);
  });

  it('executes the complete copy using a real independent non-owner LOGIN with explicit feature grants, and fails closed after a required grant is removed', async () => {
    const base = validateFinanceFixtureUrl(process.env.TEST_FINANCE_POSTGRES_URL ?? ''), [origin] = await f.db.execute(sql`SELECT current_database() AS database`);
    const role = `cinashop_supplier_copy_${randomUUID().replaceAll('-', '')}`, password = randomUUID().replaceAll('-', '');
    let client: ReturnType<typeof postgres> | undefined;
    try {
      await f.exec(`CREATE ROLE "${role}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`);
      await f.exec(`GRANT CONNECT ON DATABASE "${origin.database}" TO "${role}"; GRANT USAGE ON SCHEMA public TO "${role}"; GRANT SELECT ON ALL TABLES IN SCHEMA public TO "${role}"; GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO "${role}"`);
      // Maintenance grants for this feature only. Real SHARE/SRE table locks
      // need table-level UPDATE on the complete writer's exact lock surface;
      // immutable order, payment and historical retirement tables stay SELECT.
      const locked = ['system_admin', 'system_supplier', 'system_role', 'system_menus', 'system_config', 'shipping_templates', 'system_form', 'user_label',
        'store_product_category', 'store_brand', 'store_product_label', 'store_product_ensure', 'category', 'store_product_specs', 'store_coupon_issue', 'system_attachment',
        'store_product', 'store_product_attr_value', 'store_cart', 'store_product_relation', 'store_product_attr', 'store_product_attr_result', 'store_product_description',
        'store_product_virtual', 'store_product_stock_record', 'store_product_coupon', 'store_discounts_products', 'store_seckill', 'store_combination', 'store_bargain', 'store_integral', 'system_log', 'store_order_outbox'];
      await f.exec(`GRANT UPDATE ON ${locked.join(',')} TO "${role}"; GRANT INSERT ON store_product,store_product_attr_value,store_product_relation,store_product_attr,store_product_attr_result,store_product_description,store_product_stock_record,store_product_coupon,system_log,store_order_outbox,supplier_product_copy_operation_v1 TO "${role}"; GRANT DELETE ON store_product_attr,store_product_attr_result,store_product_description,store_product_relation,store_product_coupon TO "${role}"`);
      base.pathname = `/${origin.database}`; base.username = role; base.password = password;
      client = postgres(base.href, { max: 1, prepare: false, connect_timeout: 5, idle_timeout: 0, max_lifetime: 0,
        connection: { options: '-c search_path=public,pg_temp -c statement_timeout=10000 -c lock_timeout=2000' } });
      const [identity] = await client`SELECT current_user AS role,session_user AS session,current_setting('server_version_num') AS version`;
      expect(identity).toMatchObject({ role, session: role }); expect(Math.floor(Number(identity.version) / 10000)).toBe(16);
      const runtime = service(drizzle(client) as unknown as DbClient), body = await f.body(80), before = await f.snapshot();
      await f.exec(`REVOKE INSERT ON supplier_product_copy_operation_v1 FROM "${role}"`);
      await expect(runtime.save(80, body, supplierCopyActor())).rejects.toMatchObject({ code: 503 }); expect(await f.snapshot()).toEqual(before);
      await f.exec(`GRANT INSERT ON supplier_product_copy_operation_v1 TO "${role}"`);
      const saved = await runtime.save(80, body, supplierCopyActor()); expect(saved.state).toBe('committed');
      expect(await runtime.receipt(body.operation_id, supplierCopyActor())).toEqual(saved); await preserved(before);
      const second = await f.body(80), committed = await f.snapshot();
      await f.exec(`REVOKE INSERT ON store_product_description FROM "${role}"`);
      await expect(runtime.save(80, second, supplierCopyActor())).rejects.toMatchObject({ code: 503 }); expect(await f.snapshot()).toEqual(committed);
      await f.exec(`GRANT INSERT ON store_product_description TO "${role}"`);
      const [permissions] = await client`SELECT has_table_privilege(current_user,'supplier_product_copy_operation_v1','INSERT') AS receipt_insert,
        has_table_privilege(current_user,'supplier_product_copy_operation_v1','UPDATE') AS receipt_update,
        has_table_privilege(current_user,'supplier_product_copy_operation_v1','DELETE') AS receipt_delete,
        has_table_privilege(current_user,'store_order','UPDATE') AS order_update,
        has_table_privilege(current_user,'user_bill','INSERT') AS financial_insert`;
      expect(permissions).toEqual({ receipt_insert: true, receipt_update: false, receipt_delete: false, order_update: false, financial_insert: false });
    } finally { await client?.end({ timeout: 5 }); await f.exec(`DROP OWNED BY "${role}"; DROP ROLE "${role}"`); }
  }, 60000);
});
