import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { randomUUID } from 'node:crypto';
import { createApp } from '@/app';
import type { Env } from '@/env';
import { createContainerFromDb, type DbClient } from '@/lib/di';
import { createToken, md5 } from '@/utils/jwt';
import { storeProduct, storeProductAttrValue, storeCart, systemLog,
  storeOrder, storeOrderCartInfo, storeProductVirtual, storeOrderOutbox } from '@/models/schema';
import { SupplierProductRecycleService } from '@/services/supplier/SupplierProductRecycleService';
import { requiredSupplierPermissions } from '@/services/supplier/SupplierPermissionService';
import { supplierProductRecycleFixture, supplierRecycleActor, supplierRecyclePassword, seedSupplierRecycle, supplierRecycleSnapshot } from './helpers/supplierProductRecycle';
import { validateFinanceFixtureUrl } from './helpers/financePostgres';
import { withFinancePeers, outcome, waitForFinanceBlock } from './helpers/financePeers';
import { lockBargainSourceProductAdmission } from '@/services/activity/BargainSourceProductLifecycle';
import { PRODUCT_SKU_IDENTITY_LOCK_NAMESPACE, PRODUCT_SKU_IDENTITY_LOCK_KEY } from '@/services/product/ProductSkuIdentity';
import { pauseModerationQuery } from './helpers/adminProductModeration';
import { readSupplierPermanentDeletionFact } from '@/services/product/PermanentProductDeletionEvidence';
import { deliverPaidVirtualOrders, parseVirtualDeliveryInfo } from '@/services/order/VirtualProductDeliveryService';

const wiring = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock('@/lib/di', async original => ({ ...await original<typeof import('@/lib/di')>(), createContainer: wiring.open }));
const env = { APP_KEY: 'owned-native-supplier-recycle-jwt', UPSTASH_REDIS_URL: '', UPSTASH_REDIS_TOKEN: '' } as Env;
const app = createApp(), exact = (id: number) => new URLSearchParams({ id: String(id), is_del: 'all', limit: '1' });
function signal() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { resolve, promise }; }
const deletedTables = ['store_product', 'store_product_attr', 'store_product_attr_result', 'store_product_attr_value', 'store_product_description',
  'store_product_relation', 'store_product_coupon', 'user_relation', 'store_product_reply', 'community_relevance'];
const protectedTables = ['store_order', 'store_order_cart_info', 'store_product_virtual', 'store_product_stock_record',
  'system_attachment', 'store_bargain', 'store_seckill', 'store_combination', 'store_integral', 'store_discounts_products', 'user_bill'];

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('Supplier complete recycle lifecycle on owned PG16, real JWT and independent LOGIN', () => {
  let f: Awaited<ReturnType<typeof supplierProductRecycleFixture>>, tokens: Record<number, string>;
  beforeAll(async () => { f = await supplierProductRecycleFixture(); wiring.open.mockImplementation(() => f.container); }, 60000);
  beforeEach(async () => {
    await f.reset(); await seedSupplierRecycle(f.db);
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Supplier recycle forbids external I/O'));
    tokens = {}; for (const id of [21, 22, 23, 29, 31, 39]) tokens[id] = (await createToken(id, 'supplier', md5(supplierRecyclePassword), env.APP_KEY)).token;
  }, 30000);
  afterEach(() => { expect(fetch).not.toHaveBeenCalled(); vi.restoreAllMocks(); });
  afterAll(async () => { await f?.close(); }, 30000);
  const service = (db: DbClient) => new SupplierProductRecycleService(createContainerFromDb(db));
  async function http(method: string, path: string, body?: unknown, actor = 21, raw?: string) {
    const response = await app.request(`/supplierapi${path}`, { method, headers: { ...(actor ? { Authorization: `Bearer ${tokens[actor]}` } : {}),
      'X-Supplier-Id': '30', ...(body !== undefined || raw !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      ...(raw !== undefined ? { body: raw } : body === undefined ? {} : { body: JSON.stringify(body) }) }, env);
    expect(response.headers.get('cache-control')).toContain('private, no-store');
    return { response, body: await response.json<{ status: number; msg: string; data: any }>() };
  }
  async function login<T>(run: (peer: { db: DbClient; role: string; exec(query: string): Promise<unknown> }) => Promise<T>) {
    const base = validateFinanceFixtureUrl(process.env.TEST_FINANCE_POSTGRES_URL ?? '');
    const [origin] = await f.db.execute(sql`SELECT current_database() AS database`);
    const role = `cinashop_recycle_${randomUUID().replaceAll('-', '')}`, password = randomUUID().replaceAll('-', '');
    let client: ReturnType<typeof postgres> | undefined;
    try {
      await f.exec(`CREATE ROLE "${role}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`);
      await f.exec(`GRANT CONNECT ON DATABASE "${origin.database}" TO "${role}"; GRANT USAGE ON SCHEMA public TO "${role}"; GRANT SELECT ON ALL TABLES IN SCHEMA public TO "${role}"`);
      base.pathname = `/${origin.database}`; base.username = role; base.password = password;
      client = postgres(base.href, { max: 1, prepare: false, connect_timeout: 5, idle_timeout: 0, max_lifetime: 0,
        connection: { options: '-c search_path=public,pg_temp -c statement_timeout=10000 -c lock_timeout=2000' } });
      const [identity] = await client`SELECT current_user AS role,session_user AS session,current_setting('server_version_num') AS version`;
      expect(identity).toMatchObject({ role, session: role }); expect(Math.floor(Number(identity.version) / 10000)).toBe(16);
      const owned = client; return await run({ role, db: drizzle(client) as unknown as DbClient, exec: query => owned.unsafe(query) });
    } finally { await client?.end({ timeout: 5 }); await f.exec(`DROP OWNED BY "${role}"; DROP ROLE "${role}"`); }
  }

  it('reads both list aliases, exact owner states and the eight genuine PHP counters including recycled refusal and high-stock police flags', async () => {
    for (const path of ['/product/product', '/product/product/list']) {
      const active = await http('GET', `${path}?is_del=0`, undefined, 22); expect(active.body.status).toBe(200);
      expect(active.body.data.list.map((row: any) => row.id).sort()).toEqual([80, 83, 84, 85, 86]);
      const recycled = await http('GET', `${path}?type=6`); expect(recycled.body.data.list.map((row: any) => row.id).sort()).toEqual([81, 82]);
      expect(recycled.body.data.list.every((row: any) => row.is_del === 1)).toBe(true);
    }
    const header = await http('GET', '/product/type_header', undefined, 22);
    expect(header.body.data.list).toEqual([{ type: 1, name: '销售中', count: 2 }, { type: 2, name: '仓库中', count: 1 },
      { type: 4, name: '已售罄', count: 1 }, { type: 5, name: '库存预警', count: 1 }, { type: 6, name: '回收站', count: 2 },
      { type: 0, name: '待审核', count: 1 }, { type: -1, name: '审核未通过', count: 2 }, { type: -2, name: '强制下架', count: 1 }]);
    expect((await f.service.list(exact(81), supplierRecycleActor())).list[0]).toMatchObject({ id: 81, is_del: 1 });
    expect((await f.service.list(exact(90), supplierRecycleActor())).count).toBe(0);
    expect((await f.service.header(new URLSearchParams({ store_name: 'card' }), supplierRecycleActor())).list.find(row => row.type === 6)?.count).toBe(1);
  });

  it('rejects ambiguous, oversized, duplicate and owner-forged inputs before mutation', async () => {
    const before = await supplierRecycleSnapshot(f.db);
    for (const suffix of ['?is_del=all', '?is_del=all&id=81', '?is_del=all&id=81&limit=1&page=2', '?is_del=all&id=81&limit=1&is_show=0',
      '?is_del=0&type=6', '?is_del=1&is_del=0', '?supplier_id=30', '?id=0', '?limit=101', '?page=0'])
      expect((await http('GET', `/product/product${suffix}`)).body.status).toBe(400);
    for (const raw of ['[]', '{"expected_is_del":1,"expected_is_del":0}', '{"expected_is_del":"1"}', '{"supplier_id":30}', '{"expected_is_del":2}', 'x'.repeat(1025)])
      expect((await http('DELETE', '/product/product/81', undefined, 21, raw)).body.status).toBe(400);
    expect((await http('DELETE', '/product/product/thorough/81?force=1', { expected_is_del: 1 })).body.status).toBe(400);
    expect(await supplierRecycleSnapshot(f.db)).toEqual(before);
  });

  it('keeps view and exact numeric GET grants read-only, denies anonymous callers and isolates supplier/type collisions', async () => {
    expect(requiredSupplierPermissions('GET', '/supplierapi/product/type_header')).toEqual(['supplier.product.view']);
    expect(requiredSupplierPermissions('DELETE', '/supplierapi/product/product/thorough/:id')).toEqual(['supplier.product.manage']);
    expect(requiredSupplierPermissions('POST', '/supplierapi/product/product/thorough/81')).toBeNull();
    const before = await supplierRecycleSnapshot(f.db);
    for (const id of [22, 23]) {
      expect((await http('GET', '/product/type_header', undefined, id)).body.status).toBe(200);
      expect((await http('DELETE', '/product/product/81', { expected_is_del: 1 }, id)).body.status).toBe(400011);
      expect((await http('DELETE', '/product/product/thorough/81', { expected_is_del: 1 }, id)).body.status).toBe(400011);
    }
    expect((await http('GET', '/product/type_header', undefined, 0)).body.status).toBe(410000);
    for (const id of [90, 100, 101, 999]) {
      expect((await http('DELETE', `/product/product/${id}`, { expected_is_del: 1 })).body.status).toBe(404);
      expect((await http('DELETE', `/product/product/thorough/${id}`, { expected_is_del: 1 })).body.status).toBe(404);
    }
    expect(await supplierRecycleSnapshot(f.db)).toEqual(before);
  });

  it('toggles old DELETE in both directions, invalidates every parent cart and preserves verification, SKU and relation facts', async () => {
    const before = await supplierRecycleSnapshot(f.db), [root] = await f.db.select().from(storeProduct).where(eq(storeProduct.id, 81));
    expect((await http('DELETE', '/product/product/81')).body.data).toEqual({ id: 81, operation: 'restore', is_del: 0 });
    expect((await f.db.select().from(storeProduct).where(eq(storeProduct.id, 81)))[0]).toEqual({ ...root, isDel: 0 });
    expect((await http('DELETE', '/product/product/81', { expected_is_del: 0 })).body.data).toEqual({ id: 81, operation: 'recycle', is_del: 1 });
    const after = await supplierRecycleSnapshot(f.db);
    for (const name of ['store_product_attr_value', 'store_product_relation', 'store_product_sku_retirement_log', ...protectedTables]) expect(after[name]).toEqual(before[name]);
    expect((await f.db.select().from(storeCart).where(eq(storeCart.productId, 81))).every(row => row.status === 0)).toBe(true);
    expect((await f.db.select().from(storeProduct).where(eq(storeProduct.id, 81)))[0]).toEqual({ ...root, isShow: 0 });
    expect(await f.db.select().from(systemLog)).toHaveLength(2);
  });

  it('requires the declared prior state and recycled root without fabricating successful repetition', async () => {
    const before = await supplierRecycleSnapshot(f.db);
    expect((await http('DELETE', '/product/product/81', { expected_is_del: 0 })).body.status).toBe(409);
    expect((await http('DELETE', '/product/product/80', { expected_is_del: 1 })).body.status).toBe(409);
    expect((await http('DELETE', '/product/product/thorough/80', { expected_is_del: 1 })).body.status).toBe(409);
    expect((await http('DELETE', '/product/product/thorough/80')).body.status).toBe(400);
    expect(await supplierRecycleSnapshot(f.db)).toEqual(before);
  });

  it('permanently deletes exactly ten PHP scopes including active and retired card SKUs while retaining all current transaction and delivery facts', async () => {
    const before = await supplierRecycleSnapshot(f.db);
    const result = await http('DELETE', '/product/product/thorough/81', { expected_is_del: 1 }); expect(result.body.status, result.body.msg).toBe(200);
    expect(result.body.data).toEqual({ id: 81, operation: 'delete' });
    const after = await supplierRecycleSnapshot(f.db);
    for (const name of protectedTables) expect(after[name]).toEqual(before[name]);
    expect(after.store_product_sku_retirement_log.filter((entry: any) => entry.row.action !== 'permanent_delete')).toEqual(before.store_product_sku_retirement_log);
    expect(after.store_product_sku_retirement_log.filter((entry: any) => entry.row.action === 'permanent_delete')).toHaveLength(2);
    const expected = { productId: 81, skuId: 302, skuUnique: 'card0002', supplierId: 20, productType: 1 };
    expect(await readSupplierPermanentDeletionFact(f.db, expected)).toEqual({ skuId: 302, supplierId: 20, productType: 1 });
    expect(await readSupplierPermanentDeletionFact(f.db, { ...expected, supplierId: undefined })).toEqual({ skuId: 302, supplierId: 20, productType: 1 });
    for (const mismatch of [{ supplierId: 30 }, { productType: 0 }, { skuUnique: 'card0001' }, { skuId: 301 }])
      expect(await readSupplierPermanentDeletionFact(f.db, { ...expected, ...mismatch })).toBeNull();
    expect(after.store_cart).toEqual(before.store_cart);
    expect((await f.db.select().from(storeProductAttrValue)).map(row => row.id).sort()).toEqual([303, 304]);
    expect((await f.db.execute(sql`SELECT type FROM store_product_description WHERE product_id=81`))).toEqual([{ type: 2 }]);
    expect((await f.db.execute(sql`SELECT category FROM user_relation WHERE relation_id=81`))).toEqual([{ category: 'article' }]);
    expect((await f.db.execute(sql`SELECT type FROM community_relevance WHERE right_id=81`))).toEqual([{ type: 'community_topic' }]);
    for (const name of ['store_product_relation', 'store_product_coupon', 'store_product_reply'])
      expect(await f.db.execute(sql`SELECT 1 FROM ${sql.identifier(name)} WHERE product_id=81`)).toEqual([]);
    expect((await f.service.list(exact(81), supplierRecycleActor())).count).toBe(0);
    expect((await http('DELETE', '/product/product/thorough/81', { expected_is_del: 1 })).body.status).toBe(404);
    expect(await f.db.select().from(systemLog)).toHaveLength(1);
  });

  it('also deletes physical and manual-virtual recycled roots without narrowing to an allowed product-type subset', async () => {
    await f.db.update(storeProduct).set({ isDel: 1 }).where(eq(storeProduct.id, 80));
    for (const id of [80, 82]) expect((await http('DELETE', `/product/product/thorough/${id}`, { expected_is_del: 1 })).body.status).toBe(200);
    expect((await f.service.list(exact(80), supplierRecycleActor())).count).toBe(0);
    expect((await f.service.list(exact(82), supplierRecycleActor())).count).toBe(0);
  });

  it('continues actual delayed paid card fulfillment and exact replay from immutable order/cart snapshots after root and every base SKU are permanently deleted', async () => {
    await f.db.insert(storeOrder).values({ id: 502, orderId: 'owned-delayed-card-order', uid: 12, supplierId: 20, paid: 1, status: 0, productType: 1 });
    await f.db.insert(storeOrderCartInfo).values({ id: 502, oid: 502, cartId: 'delayed-card-cart', productId: 81, productType: 1,
      skuUnique: 'card0001', cartNum: 1, surplusNum: 1, cartInfo: JSON.stringify({ sku: { id: 301, disk_info: '' } }) });
    const [issuedBefore] = await f.db.select().from(storeProductVirtual).where(eq(storeProductVirtual.id, 601));
    await f.service.thorough(81, supplierRecycleActor(), { expectedIsDel: 1 });
    const [order] = await f.db.select().from(storeOrder).where(eq(storeOrder.id, 502));
    const [time] = await f.db.execute(sql`SELECT floor(extract(epoch FROM clock_timestamp()))::integer AS now`);
    expect(await f.db.transaction(tx => deliverPaidVirtualOrders(tx as unknown as DbClient, [order], Number(time.now)))).toEqual({ deliveredOrders: 1, deliveredCards: 1 });
    const [delivered] = await f.db.select().from(storeOrder).where(eq(storeOrder.id, 502));
    expect(delivered).toMatchObject({ status: 1, deliveryType: 'fictitious' });
    expect(parseVirtualDeliveryInfo(delivered.virtualInfo)).toEqual([{ card_no: 'unissued', card_pwd: 'unissued-secret', product_id: 81, sku_unique: 'card0001' }]);
    expect((await f.db.select().from(storeProductVirtual).where(eq(storeProductVirtual.id, 601)))[0]).toEqual(issuedBefore);
    const beforeReplay = await supplierRecycleSnapshot(f.db);
    expect(await f.db.transaction(tx => deliverPaidVirtualOrders(tx as unknown as DbClient, [delivered], Number(time.now)))).toEqual({ deliveredOrders: 0, deliveredCards: 0 });
    expect(await supplierRecycleSnapshot(f.db)).toEqual(beforeReplay);
    expect(await f.db.select().from(storeOrderOutbox)).toHaveLength(1);
  });

  it('rolls back the root and every deletion collection when any real BEFORE DELETE trigger suppresses its complete result', async () => {
    for (const table of deletedTables) {
      const before = await supplierRecycleSnapshot(f.db);
      await f.exec(`CREATE FUNCTION recycle_skip() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RETURN NULL; END$$; CREATE TRIGGER recycle_skip BEFORE DELETE ON ${table} FOR EACH ROW EXECUTE FUNCTION recycle_skip()`);
      try { await expect(f.service.thorough(81, supplierRecycleActor(), { expectedIsDel: 1 })).rejects.toMatchObject({ code: 409 });
        expect(await supplierRecycleSnapshot(f.db)).toEqual(before); }
      finally { await f.exec(`DROP TRIGGER recycle_skip ON ${table}; DROP FUNCTION recycle_skip()`); }
    }
  }, 60000);

  it('rolls back a late trigger mutation of SKU/relation state and a late authority withdrawal after the first business readback', async () => {
    for (const statement of ["UPDATE store_product_relation SET status=0 WHERE product_id=81", "UPDATE system_role SET rules='supplier.product.view' WHERE id=21"]) {
      const before = await supplierRecycleSnapshot(f.db);
      await f.exec(`CREATE FUNCTION recycle_late() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN ${statement}; RETURN NEW; END$$; CREATE TRIGGER recycle_late BEFORE INSERT ON system_log FOR EACH ROW EXECUTE FUNCTION recycle_late()`);
      try { await expect(f.service.change(81, supplierRecycleActor(), { expectedIsDel: 1 })).rejects.toBeDefined(); expect(await supplierRecycleSnapshot(f.db)).toEqual(before); }
      finally { await f.exec('DROP TRIGGER recycle_late ON system_log; DROP FUNCTION recycle_late()'); }
    }
  });

  it('rejects current disabled role, supplier, account tenant and changed credential facts with no partial effects', async () => {
    for (const [table, update, restore] of [
      ['system_role', "rules='supplier.product.view'", "rules='supplier.product.manage'"],
      ['system_supplier', 'is_show=0', 'is_show=1'], ['system_admin', 'relation_id=30', 'relation_id=20'],
      ['system_admin', "pwd='changed-password'", `pwd='${supplierRecyclePassword}'`],
    ]) {
      const id = table === 'system_supplier' ? 20 : 21;
      await f.exec(`UPDATE ${table} SET ${update} WHERE id=${id}`); const before = await supplierRecycleSnapshot(f.db);
      await expect(f.service.thorough(81, supplierRecycleActor(), { expectedIsDel: 1 })).rejects.toBeDefined(); expect(await supplierRecycleSnapshot(f.db)).toEqual(before);
      await f.exec(`UPDATE ${table} SET ${restore} WHERE id=${id}`);
    }
  });

  it('rechecks the database clock after audit work and rolls back an otherwise complete deletion when the JWT expires', async () => {
    const [now] = await f.db.execute(sql`SELECT floor(extract(epoch FROM clock_timestamp()))::integer AS now`), before = await supplierRecycleSnapshot(f.db);
    await f.exec("CREATE FUNCTION recycle_expire() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN PERFORM pg_sleep(2.1); RETURN NEW; END$$; CREATE TRIGGER recycle_expire BEFORE INSERT ON system_log FOR EACH ROW EXECUTE FUNCTION recycle_expire()");
    try { await expect(f.service.thorough(81, { ...supplierRecycleActor(), expiresAt: Number(now.now) + 2 }, { expectedIsDel: 1 })).rejects.toMatchObject({ code: 410001 });
      expect(await supplierRecycleSnapshot(f.db)).toEqual(before); }
    finally { await f.exec('DROP TRIGGER recycle_expire ON system_log; DROP FUNCTION recycle_expire()'); }
  }, 10000);

  it('requires real table lock and deletion privileges on independent non-superuser LOGIN without granting immutable facts or trigger EXECUTE', async () => {
    await login(async peer => {
      expect((await service(peer.db).list(exact(81), supplierRecycleActor())).count).toBe(1);
      const before = await supplierRecycleSnapshot(f.db);
      await expect(service(peer.db).change(81, supplierRecycleActor())).rejects.toMatchObject({ httpStatus: 503 });
      expect(await supplierRecycleSnapshot(f.db)).toEqual(before);
      await f.exec(`GRANT UPDATE ON system_admin,system_supplier,system_role,system_menus,${deletedTables.join(',')},store_cart,store_product_sku_retirement_log TO "${peer.role}";
        GRANT DELETE ON ${deletedTables.join(',')} TO "${peer.role}"; GRANT INSERT ON system_log,store_product_sku_retirement_log TO "${peer.role}";
        GRANT USAGE ON SEQUENCE system_log_id_seq,store_product_sku_retirement_log_id_seq TO "${peer.role}"`);
      await expect(peer.exec('SELECT public.guard_retired_product_sku()')).rejects.toMatchObject({ code: '42501' });
      expect(await service(peer.db).thorough(81, supplierRecycleActor(), { expectedIsDel: 1 })).toEqual({ id: 81, operation: 'delete' });
      for (const name of protectedTables) expect((await supplierRecycleSnapshot(f.db))[name]).toEqual(before[name]);
      await expect(peer.exec('DELETE FROM store_order WHERE false')).rejects.toMatchObject({ code: '42501' });
      await expect(peer.exec('UPDATE store_product_virtual SET uid=uid WHERE false')).rejects.toMatchObject({ code: '42501' });
    });
  }, 60000);

  it('refuses actual business and authority table conflicts quickly and succeeds after independent writers release them', async () => {
    await withFinancePeers(f.db, async ([writer, blocker]) => {
      for (const table of [...deletedTables, 'store_cart', 'store_product_sku_retirement_log', 'system_admin', 'system_supplier', 'system_role', 'system_menus']) {
        const before = await supplierRecycleSnapshot(f.db), ready = signal(), release = signal();
        const held = outcome(blocker.db.transaction(async tx => { await tx.execute(sql.raw(`LOCK TABLE ONLY ${table} IN ROW EXCLUSIVE MODE`)); ready.resolve(); await release.promise; }));
        try { await ready.promise; await expect(service(writer.db).thorough(81, supplierRecycleActor())).rejects.toMatchObject({ httpStatus: 409 }); expect(await supplierRecycleSnapshot(f.db)).toEqual(before); }
        finally { release.resolve(); } const result = await held; if (!result.ok) throw result.error;
      }
      expect(await service(writer.db).thorough(81, supplierRecycleActor())).toEqual({ id: 81, operation: 'delete' });
    });
  }, 60000);

  it('honors the product write fence, Supplier per-product reservation and actual global SKU allocator key zero before mutating any row', async () => {
    await withFinancePeers(f.db, async ([writer, blocker]) => {
      const before = await supplierRecycleSnapshot(f.db);
      await blocker.exec('SELECT pg_advisory_lock(731617,81)');
      try { await expect(service(writer.db).thorough(81, supplierRecycleActor())).rejects.toMatchObject({ httpStatus: 409 }); }
      finally { await blocker.exec('SELECT pg_advisory_unlock(731617,81)'); }
      for (const key of [81, PRODUCT_SKU_IDENTITY_LOCK_KEY]) {
        await blocker.exec(`SELECT pg_advisory_lock(${PRODUCT_SKU_IDENTITY_LOCK_NAMESPACE},${key})`);
        try { await expect(service(writer.db).thorough(81, supplierRecycleActor())).rejects.toMatchObject({ httpStatus: 409 }); }
        finally { await blocker.exec(`SELECT pg_advisory_unlock(${PRODUCT_SKU_IDENTITY_LOCK_NAMESPACE},${key})`); }
      }
      expect(await supplierRecycleSnapshot(f.db)).toEqual(before);
    });
  }, 15000);

  it('takes the bargain source fence before cart/product barriers so an admitted cart-first checkout can finish and its changed snapshot is refused', async () => {
    await withFinancePeers(f.db, async ([writer, checkout]) => {
      const ready = signal(), release = signal();
      const held = outcome(checkout.db.transaction(async tx => {
        await lockBargainSourceProductAdmission(tx as unknown as DbClient, 81);
        await tx.execute(sql`SELECT id FROM store_cart WHERE id=401 FOR UPDATE`); ready.resolve(); await release.promise;
        await tx.execute(sql`UPDATE store_product SET stock=stock+1 WHERE id=81`);
      }));
      await ready.promise; const pending = outcome(service(writer.db).thorough(81, supplierRecycleActor()));
      try { await waitForFinanceBlock(f.db, writer.pid, checkout.pid);
        expect(await f.exec(`SELECT 1 FROM pg_locks WHERE pid=${writer.pid} AND relation='public.store_product'::regclass AND mode='ShareRowExclusiveLock' AND granted`)).toEqual([]);
      } finally { release.resolve(); }
      const done = await held; if (!done.ok) throw done.error;
      const result = await pending; expect(result.ok).toBe(false); if (!result.ok) expect(result.error).toMatchObject({ code: 409 });
      expect((await f.db.select().from(storeProduct).where(eq(storeProduct.id, 81)))[0].stock).toBe(10);
      expect(await f.db.select().from(systemLog)).toEqual([]);
    });
  }, 15000);

  it('recovers a genuine committed deletion through one exact all-state snapshot after only the driver response is lost', async () => {
    let drop = true;
    const wrapped = new Proxy(f.db, { get(target, key) {
      if (key === 'transaction') return async (...args: unknown[]) => {
        const result = await Reflect.apply(target.transaction, target, args); if (drop) { drop = false; throw Error('owned COMMIT response was lost'); } return result;
      };
      return Reflect.get(target, key, target);
    } });
    await expect(service(wrapped).thorough(81, supplierRecycleActor(), { expectedIsDel: 1 })).rejects.toThrow('COMMIT response was lost');
    expect((await f.service.list(exact(81), supplierRecycleActor())).count).toBe(0);
    expect(await f.db.select().from(systemLog)).toHaveLength(1);
    await expect(f.service.thorough(81, supplierRecycleActor(), { expectedIsDel: 1 })).rejects.toMatchObject({ code: 404 });
    expect(await f.db.select().from(systemLog)).toHaveLength(1);
  });

  it('keeps list and count in one actual read-only RR snapshot when an independent writer deletes the exact root between both reads', async () => {
    await withFinancePeers(f.db, async ([reader, writer]) => {
      const wrapped = pauseModerationQuery(reader.db, 'store_product', async () => {
        await writer.exec('DELETE FROM public.store_product WHERE id=81');
      });
      const result = await service(wrapped).list(exact(81), supplierRecycleActor());
      expect(result.count).toBe(1); expect(result.list).toMatchObject([{ id: 81, is_del: 1 }]);
      expect((await service(reader.db).list(exact(81), supplierRecycleActor())).count).toBe(0);
    });
  });
});
