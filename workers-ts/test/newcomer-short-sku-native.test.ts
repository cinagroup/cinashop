/** Actual App/AdminJWT/userJWT and full registered owned PG16. SQL injection
 * is limited to the owned maintenance DI boundary, not authentication or route
 * permission. No production Admin binding, Redis login or provider claim. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { createApp } from '@/app';
import type { Env } from '@/env';
import type { Container } from '@/lib/di';
import { storeCart, storeNewcomer, storeOrder, storeOrderCartInfo, storeProduct,
  storeProductAttrValue, systemConfig, systemRole, user, userBill } from '@/models/schema';
import { StoreOrderCreateService } from '@/services/order/StoreOrderCreateService';
import { ApiException } from '@/utils/errors';
import { outcome, waitForFinanceBlock } from './helpers/financePeers';
import { newcomerShortCatalogInput, newcomerShortSkuFixture } from './helpers/newcomerShortSku';

const wiring = vi.hoisted(() => ({ containers: new WeakMap<object, Container>(), opened: 0, closed: 0 }));
vi.mock('@/lib/di', async original => ({ ...await original<typeof import('@/lib/di')>(),
  createContainer: (env: object) => {
    const container = wiring.containers.get(env);
    if (!container) throw Error('Missing owned newcomer App SQL boundary');
    return container;
  },
  createAdminDatabaseSession: (env: object) => {
    const container = wiring.containers.get(env);
    if (!container) throw Error('Missing owned newcomer Admin SQL boundary');
    wiring.opened++;
    return { container, close: async () => { wiring.closed++; } };
  },
}));
const app = createApp();
type Fixture = Awaited<ReturnType<typeof newcomerShortSkuFixture>>;
type Envelope<T> = { status: number; msg: string; data: T | null };
type ProductOption = { id: number; attr: Array<{ unique: string; price: string; suk: string }> };
type Catalog = { product: Array<{ id: number; product_id: number;
  attr: Array<{ unique: string; activity_unique: string; price: string }> }> };
type Campaign = Catalog['product'][number];
type Confirmation = { orderKey: string; quoteToken: string;
  priceGroup: { total_price: string; pay_price: string; pay_postage: string };
  cartInfo: Array<{ id: number; cartNum: number; truePrice: string }> };
type Writer = Parameters<Parameters<Fixture['withNewcomerRuntime']>[0]>[0];

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('Newcomer short base SKU actual Admin/buyer JWT owned PG16', () => {
  let f: Fixture | undefined;
  beforeEach(() => { f = undefined; wiring.opened = 0; wiring.closed = 0; });
  afterEach(async () => {
    try {
      if (f) {
        expect(fetch).not.toHaveBeenCalled();
        expect(f.r2Reads).toEqual([]); expect(f.r2Writes).toEqual([]); expect(f.r2Deletes).toEqual([]);
        expect(wiring.opened).toBe(wiring.closed);
      }
    } finally { vi.restoreAllMocks(); await f?.close(); }
  }, 30_000);
  async function setup(options: Parameters<typeof newcomerShortSkuFixture>[0] = {}) {
    f = await newcomerShortSkuFixture(options);
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Owned newcomer short-SKU scenario forbids providers'));
    const [raw] = await f.db.execute(sql`SELECT "unique" AS raw_unique,
      pg_typeof("unique")::text AS storage_type,octet_length("unique") AS bytes
      FROM public.store_product_attr_value WHERE id=1`);
    expect(raw).toEqual({ raw_unique: f.unique.padEnd(8, ' '), storage_type: 'character', bytes: 8 });
    return f;
  }
  function request(path: string, init: RequestInit = {}) {
    if (!f) throw Error('Owned newcomer fixture is not initialized');
    const env: Env = { ...f.env }; wiring.containers.set(env, f.container);
    return app.request(path, { ...init, headers: { Authorization: 'Bearer ' + f.adminToken,
      'content-type': 'application/json', ...init.headers } }, env);
  }
  function fixture() {
    if (!f) throw Error('Owned newcomer fixture is not initialized');
    return f;
  }
  async function buyer<T>(path: string, input?: object) {
    const response = await request(path, { method: input ? 'POST' : 'GET',
      headers: { Authorization: 'Bearer ' + fixture().token },
      ...(input ? { body: JSON.stringify(input) } : {}) });
    return { response, body: await response.json<Envelope<T>>() };
  }
  async function saved(price = '8.00') {
    const response = await request('/adminapi/config/user/register', { method: 'POST',
      body: JSON.stringify(newcomerShortCatalogInput(fixture().unique, price)) });
    const body = await response.json<Envelope<Catalog>>();
    expect(response.status).toBe(200); expect(body.status, body.msg).toBe(200);
    const campaign = body.data!.product.find(row => row.product_id === 70);
    expect(campaign).toBeDefined();
    expect(campaign!.attr).toEqual([expect.objectContaining({ unique: fixture().unique, price,
      activity_unique: expect.stringMatching(/^[A-Z2-9]{8}$/) })]);
    return campaign!;
  }
  async function unchanged(before: Awaited<ReturnType<Fixture['snapshot']>>,
    sequences?: Awaited<ReturnType<Fixture['sequences']>>) {
    expect(Object.keys(before)).toHaveLength(283);
    expect(await fixture().snapshot()).toEqual(before);
    if (sequences) { expect(sequences).toHaveLength(229); expect(await fixture().sequences()).toEqual(sequences); }
  }
  async function onlyTables(before: Awaited<ReturnType<Fixture['snapshot']>>, allowed: string[]) {
    const after = await fixture().snapshot();
    for (const table of Object.keys(before)) if (!allowed.includes(table)) expect(after[table], table).toEqual(before[table]);
  }
  const addInput = (campaign: Campaign) => ({ productId: 70, type: 7, activityId: campaign.id,
    uniqueId: campaign.attr[0].activity_unique, cartNum: 1, new: 1 });
  async function add(campaign: Campaign) {
    const result = await buyer<{ cartId: number }>('/api/cart/add', addInput(campaign));
    expect(result.response.status).toBe(200); expect(result.body.status, result.body.msg).toBe(200);
    const id = result.body.data!.cartId;
    expect(id).toBeGreaterThan(2);
    const [row] = await fixture().db.select().from(storeCart).where(eq(storeCart.id, id));
    expect(row).toMatchObject({ uid: 11, type: 7, activityId: campaign.id, productId: 70,
      productAttrUnique: fixture().unique, cartNum: 1, isNew: 1, isPay: 0 });
    return id;
  }
  async function confirm(id: number, price = '8.00') {
    const before = await fixture().snapshot(), sequences = await fixture().sequences();
    const result = await buyer<Confirmation>('/api/order/confirm', { cartIds: [id], addressId: 11, useIntegral: false });
    expect(result.response.status).toBe(200); expect(result.body.status, result.body.msg).toBe(200);
    expect(result.body.data!.orderKey).toBeTruthy(); expect(result.body.data!.quoteToken).toBeTruthy();
    expect(result.body.data!.priceGroup).toMatchObject({ total_price: price, pay_postage: '3.00',
      pay_price: (Number(price) + 3).toFixed(2) });
    await unchanged(before, sequences);
    return result.body.data!;
  }
  const create = (writer: Writer, receipt: Confirmation, id: number,
    nextOrderId = async () => 'owned_newcomer_short_order') =>
    StoreOrderCreateService.createWithRuntime(writer.container, { CONFIG_KV: fixture().env.CONFIG_KV,
      requireConfirmation: true, requirePurchaseOrigin: true, nextOrderId },
    { uid: 11, key: receipt.orderKey, quoteToken: receipt.quoteToken, cartIds: [id],
      addressId: 11, type: 7, userIp: '127.0.0.1', useIntegral: false });
  async function captured(orderId: string, id: number, campaign: Campaign) {
    const f = fixture(), [root] = await f.db.select().from(storeOrder).where(eq(storeOrder.orderId, orderId));
    expect(root).toMatchObject({ uid: 11, type: 7, activityId: campaign.id, totalNum: 1,
      pid: 0, paid: 0, cartId: String(id), totalPrice: '8.00', payPrice: '11.00' });
    const lines = await f.db.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid, root.id));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ productId: 70, cartId: String(id), skuUnique: f.unique, cartNum: 1 });
    const snapshot = JSON.parse(lines[0].cartInfo!);
    const [activity] = await f.db.select().from(storeProductAttrValue).where(and(
      eq(storeProductAttrValue.productId, campaign.id), eq(storeProductAttrValue.type, 7),
      eq(storeProductAttrValue.unique, campaign.attr[0].activity_unique)));
    expect(snapshot).toMatchObject({ financial_version: 'checkout-line-finance-v1',
      sku: { id: 1, unique: f.unique, price: '8.00' },
      activitySku: { id: activity.id, unique: campaign.attr[0].activity_unique, price: '8.00' } });
    const charged = { rowId: lines[0].id, cartId: String(id), productId: 70, skuId: 1,
      skuUnique: f.unique, quantity: 1, usedPoints: 0 };
    const [origin] = await f.db.execute(sql`SELECT * FROM store_order_purchase_origin WHERE order_id=${root.id}`);
    const [physical] = await f.db.execute(sql`SELECT * FROM store_order_purchase_physical_origin WHERE order_id=${root.id}`);
    expect(origin).toMatchObject({ version: 'purchase-origin-v1', buyer_id: 11, order_type: 7,
      total_num: 1, lines: [charged] });
    expect(physical).toMatchObject({ version: 'purchase-physical-origin-v1', buyer_id: 11, order_type: 7,
      total_num: 1, lines: [{ ...charged, kind: 'charged', gift: null }] });
    return { root, lines, origin, physical, activity };
  }
  async function rejected(path: string, input: object, message: RegExp) {
    const before = await fixture().snapshot(), sequences = await fixture().sequences();
    const result = await buyer(path, input);
    expect(result.response.status).toBeLessThan(500); expect(result.body.status, result.body.msg).toBe(400);
    expect(result.body.msg).toMatch(message); await unchanged(before, sequences);
  }

  it('reads a canonical short base SKU through actual Admin product options without SQL writes', async () => {
    const f = await setup(), before = await f.snapshot(), sequences = await f.sequences();
    expect(Object.keys(before)).toHaveLength(283); expect(sequences).toHaveLength(229);
    const response = await request('/adminapi/config/user/register/products?keyword=70');
    const body = await response.json<Envelope<{ list: ProductOption[] }>>();
    expect(response.status).toBe(200); expect(body.status, body.msg).toBe(200);
    expect(wiring.opened).toBe(1); expect(wiring.closed).toBe(1);
    expect(await f.snapshot()).toEqual(before); expect(await f.sequences()).toEqual(sequences);
    expect(body.data!.list.find(row => row.id === 70)?.attr).toEqual([
      expect.objectContaining({ unique: f.unique, price: '18.88' }),
    ]);
  }, 120_000);

  it('saves a newcomer catalog through actual Admin JWT from a canonical short base SKU', async () => {
    const f = await setup();
    const before = await f.snapshot();
    const [base] = await f.db.select().from(storeProductAttrValue).where(eq(storeProductAttrValue.id, 1));
    const response = await request('/adminapi/config/user/register', { method: 'POST',
      body: JSON.stringify(newcomerShortCatalogInput(f.unique)) });
    const body = await response.json<Envelope<Catalog>>();
    expect(wiring.opened).toBe(1); expect(wiring.closed).toBe(1);
    expect(response.status).toBe(200); expect(body.status, body.msg).toBe(200);
    const campaign = body.data!.product.find(row => row.product_id === 70);
    expect(campaign?.attr).toEqual([expect.objectContaining({ unique: f.unique, price: '8.00',
      activity_unique: expect.stringMatching(/^[A-Z2-9]{8}$/) })]);
    expect((await f.db.select().from(storeProductAttrValue).where(eq(storeProductAttrValue.id, 1)))[0]).toEqual(base);
    const after = await f.snapshot();
    for (const table of Object.keys(before))
      if (!['system_config', 'cache', 'store_newcomer', 'store_product_attr_value'].includes(table))
        expect(after[table], table).toEqual(before[table]);
  }, 120_000);

  it.each(['short7', 'x', 'qared001'])(
    'completes %s actual Admin round-trip, buyer checkout, independent LOGIN receipts, replay and once-only cancellation', async unique => {
      const f = await setup({ unique }), first = await saved();
      const beforeRead = await f.snapshot(), beforeReadSequences = await f.sequences();
      const read = await request('/adminapi/config/user/register');
      const config = await read.json<Envelope<Catalog>>();
      expect(config.status, config.msg).toBe(200);
      expect(config.data!.product.find(row => row.product_id === 70)?.attr).toEqual(first.attr);
      const options = await request('/adminapi/config/user/register/products?keyword=70');
      expect((await options.json<Envelope<{ list: ProductOption[] }>>()).data!.list
        .find(row => row.id === 70)?.attr).toEqual([expect.objectContaining({ unique, price: '18.88' })]);
      await unchanged(beforeRead, beforeReadSequences);
      const campaign = await saved();
      expect(campaign.attr[0].activity_unique).toBe(first.attr[0].activity_unique);
      const id = await add(campaign);
      const beforeList = await f.snapshot(), beforeListSequences = await f.sequences();
      const list = await buyer<Array<{ id: number; isValid: boolean; truePrice: string }>>(`/api/cart/list?scope=buy&ids=${id}`);
      expect(list.body.status, list.body.msg).toBe(200);
      expect(list.body.data).toEqual([expect.objectContaining({ id, isValid: true, truePrice: '8.00' })]);
      await unchanged(beforeList, beforeListSequences);
      const receipt = await confirm(id), [beforeProduct] = await f.db.select().from(storeProduct).where(eq(storeProduct.id, 70)),
        [beforeSku] = await f.db.select().from(storeProductAttrValue).where(eq(storeProductAttrValue.id, 1)),
        [beforeUser] = await f.db.select().from(user).where(eq(user.uid, 11));
      const nextOrderId = vi.fn(async () => 'owned_newcomer_' + unique);
      let proof: Awaited<ReturnType<typeof captured>> | undefined;
      await f.withNewcomerRuntime(async writer => {
        let created: Awaited<ReturnType<typeof create>> | undefined;
        if (unique === 'short7') {
          await f.withPeer!(async holder => {
            const [observer] = await f.db.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`);
            expect(new Set([observer.pid, holder.pid, writer.pid]).size).toBe(3);
            await holder.exec('BEGIN');
            try {
              await holder.db.execute(sql`SELECT id FROM store_product_attr_value WHERE id=1 FOR UPDATE`);
              const pending = outcome(create(writer, receipt, id, nextOrderId));
              await waitForFinanceBlock(f.db, writer.pid, holder.pid);
              // The genuine writer is waiting on the SKU, without owning the
              // later product row. This one path is not a global deadlock proof.
              await holder.db.execute(sql`SELECT id FROM store_product WHERE id=70 FOR UPDATE NOWAIT`);
              await holder.exec('COMMIT');
              const result = await pending;
              if (!result.ok) throw result.error;
              created = result.value;
            } finally { await holder.exec('ROLLBACK'); }
          });
        } else created = await create(writer, receipt, id, nextOrderId);
        proof = await captured(created!.orderId, id, campaign);
        const afterCreate = await f.snapshot(), afterCreateSequences = await f.sequences();
        const writes = [...f.kvWrites], deletes = [...f.kvDeletes];
        expect(await create(writer, receipt, id, nextOrderId)).toEqual(created!);
        expect(nextOrderId).toHaveBeenCalledTimes(1);
        await unchanged(afterCreate, afterCreateSequences);
        expect(f.kvWrites).toEqual(writes); expect(f.kvDeletes).toEqual(deletes);
      });
      expect(proof).toBeDefined();
      expect((await f.db.select().from(user).where(eq(user.uid, 11)))[0]).toEqual({ ...beforeUser, isNewcomer: 1 });
      expect((await f.db.select().from(storeProduct).where(eq(storeProduct.id, 70)))[0]).toEqual({
        ...beforeProduct, stock: beforeProduct.stock - 1, sales: beforeProduct.sales + 1 });
      expect((await f.db.select().from(storeProductAttrValue).where(eq(storeProductAttrValue.id, 1)))[0]).toEqual({
        ...beforeSku, stock: beforeSku.stock - 1, sales: beforeSku.sales + 1 });
      expect((await f.db.select().from(storeProductAttrValue).where(eq(storeProductAttrValue.id, proof!.activity.id)))[0])
        .toEqual(proof!.activity);
      const cancel = await buyer('/api/order/cancel', { order_id: proof!.root.orderId });
      expect(cancel.body.status, cancel.body.msg).toBe(200);
      expect((await f.db.select().from(storeProduct).where(eq(storeProduct.id, 70)))[0]).toEqual(beforeProduct);
      expect((await f.db.select().from(storeProductAttrValue).where(eq(storeProductAttrValue.id, 1)))[0]).toEqual(beforeSku);
      expect((await f.db.select().from(user).where(eq(user.uid, 11)))[0]).toEqual({ ...beforeUser, isNewcomer: 1 });
      expect(await f.db.select().from(userBill)).toEqual([]);
      expect(await f.db.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid, proof!.root.id))).toEqual(proof!.lines);
      expect((await f.db.execute(sql`SELECT * FROM store_order_purchase_origin WHERE order_id=${proof!.root.id}`))[0]).toEqual(proof!.origin);
      expect((await f.db.execute(sql`SELECT * FROM store_order_purchase_physical_origin WHERE order_id=${proof!.root.id}`))[0]).toEqual(proof!.physical);
      // PHP consumes newcomer eligibility on creation; unpaid cancellation
      // restores stock, not eligibility. Neither a second cancel nor add writes.
      await rejected('/api/order/cancel', { order_id: proof!.root.orderId }, /订单状态不允许取消/);
      await rejected('/api/cart/add', addInput(campaign), /无法享受新人专享价/);
    }, 120_000);

  it('stores a canonical new buyer cart for an explicitly bootstrapped activity without pretending Admin saved it', async () => {
    const f = await setup();
    for (const [menuName, value] of Object.entries({ newcomer_status: '1', register_price_status: '1',
      newcomer_limit_status: '0', newcomer_limit_time: '0' })) {
      const rows = await f.db.update(systemConfig).set({ value: JSON.stringify(value) })
        .where(and(eq(systemConfig.menuName, menuName), eq(systemConfig.isStore, 0))).returning({ id: systemConfig.id });
      if (!rows.length) await f.db.insert(systemConfig).values({ menuName, value: JSON.stringify(value) });
    }
    const [base] = await f.db.select().from(storeProductAttrValue).where(eq(storeProductAttrValue.id, 1));
    await f.db.insert(storeNewcomer).values({ id: 40, productId: 70, price: '8.00' });
    await f.db.insert(storeProductAttrValue).values({ ...base, id: 900, productId: 40,
      type: 7, unique: 'NEW00040', price: '8.00' });
    const campaign: Campaign = { id: 40, product_id: 70,
      attr: [{ unique: f.unique, activity_unique: 'NEW00040', price: '8.00' }] };
    const before = await f.snapshot(); await add(campaign);
    await onlyTables(before, ['store_cart']);
    expect(wiring.opened).toBe(0);
  }, 120_000);

  it('preserves a legacy server-padded type7 cart while new strict order rows and both receipts freeze the canonical base key', async () => {
    const f = await setup(), campaign = await saved();
    await f.db.update(storeCart).set({ type: 7, activityId: campaign.id, cartNum: 1,
      productAttrUnique: f.unique.padEnd(8, ' ') }).where(eq(storeCart.id, 1));
    const receipt = await confirm(1);
    await f.withNewcomerRuntime(async writer => {
      const created = await create(writer, receipt, 1);
      await captured(created.orderId, 1, campaign);
    });
    expect((await f.db.select().from(storeCart).where(eq(storeCart.id, 1)))[0])
      .toMatchObject({ productAttrUnique: 'short7  ', isPay: 1 });
  }, 120_000);

  it.each(['        ', ' short7', 'short7\t', 'short7\n'])(
    'rejects a malformed DB-selected base key %j in actual Admin save without persistent configuration or financial changes', async bad => {
      const f = await setup();
      await f.db.update(storeProductAttrValue).set({ unique: bad }).where(eq(storeProductAttrValue.id, 1));
      const before = await f.snapshot(), deletes = [...f.kvDeletes];
      const response = await request('/adminapi/config/user/register', { method: 'POST',
        body: JSON.stringify(newcomerShortCatalogInput(f.unique)) });
      const body = await response.json<Envelope<Catalog>>();
      expect(body.status, body.msg).toBe(400); expect(body.msg).toMatch(/规格|标识/);
      await unchanged(before); expect(f.kvDeletes).toEqual(deletes);
      // Admin may have attempted an INSERT before rollback; sequence gaps are
      // intentionally not described as transactional business-row changes.
    }, 120_000);

  it.each(['foreign product', 'wrong type', 'retired', 'missing'] as const)(
    'rejects a current %s base SKU through Admin and buyer entry points without falling back to product price', async mode => {
      const f = await setup(), campaign = await saved(), id = await add(campaign);
      if (mode === 'missing') await f.db.delete(storeProductAttrValue).where(eq(storeProductAttrValue.id, 1));
      else await f.db.update(storeProductAttrValue).set(mode === 'foreign product' ? { productId: 71 }
        : mode === 'wrong type' ? { type: 1 } : { isRetired: 1 }).where(eq(storeProductAttrValue.id, 1));
      const before = await f.snapshot(), deletes = [...f.kvDeletes];
      const response = await request('/adminapi/config/user/register', { method: 'POST',
        body: JSON.stringify(newcomerShortCatalogInput(f.unique)) });
      const body = await response.json<Envelope<Catalog>>();
      expect(body.status, body.msg).toBe(400); expect(body.msg).toMatch(/规格|标识/);
      await unchanged(before); expect(f.kvDeletes).toEqual(deletes);
      await rejected('/api/cart/add', addInput(campaign), /规格|商品/);
      await rejected('/api/order/confirm', { cartIds: [id], addressId: 11 }, /规格|失效|商品/);
    }, 120_000);

  it.each(['base unique', 'base suk'] as const)(
    'rejects a real current ambiguous %s in Admin replacement and fresh buyer admission', async mode => {
      const f = await setup(), campaign = await saved(), id = await add(campaign);
      const [base] = await f.db.select().from(storeProductAttrValue).where(eq(storeProductAttrValue.id, 1));
      await f.db.insert(storeProductAttrValue).values({ ...base, id: 900,
        unique: mode === 'base unique' ? f.unique.padEnd(8, ' ') : 'DUPKEY01',
        suk: mode === 'base unique' ? 'Owned other combination' : base.suk });
      const before = await f.snapshot(), deletes = [...f.kvDeletes];
      const response = await request('/adminapi/config/user/register', { method: 'POST',
        body: JSON.stringify(newcomerShortCatalogInput(f.unique)) });
      const body = await response.json<Envelope<Catalog>>();
      expect(body.status, body.msg).toBe(400); expect(body.msg).toMatch(/规格.*重复|唯一/);
      await unchanged(before); expect(f.kvDeletes).toEqual(deletes);
      await rejected('/api/cart/add', addInput(campaign), /规格.*重复|唯一/);
      if (mode === 'base unique') await rejected('/api/order/confirm', { cartIds: [id], addressId: 11 }, /规格|失效|商品/);
    }, 120_000);

  it('rejects a real duplicated activity combination after Admin save without silently choosing its price', async () => {
    const f = await setup(), campaign = await saved(), id = await add(campaign);
    const [activity] = await f.db.select().from(storeProductAttrValue).where(and(
      eq(storeProductAttrValue.productId, campaign.id), eq(storeProductAttrValue.type, 7)));
    await f.db.insert(storeProductAttrValue).values({ ...activity, id: 900, unique: 'DUPACT01', price: '1.00' });
    await rejected('/api/cart/add', addInput(campaign), /规格.*重复/);
    await rejected('/api/order/confirm', { cartIds: [id], addressId: 11 }, /规格|失效|商品/);
  }, 120_000);

  it.each(['anonymous', 'buyer JWT', 'read-only Admin role'] as const)(
    'rejects %s before opening an Admin SQL session or mutating any table', async principal => {
      const f = await setup();
      if (principal === 'read-only Admin role') await f.db.update(systemRole).set({ rules: 'config.view' })
        .where(eq(systemRole.id, f.adminRoleId));
      const before = await f.snapshot(), sequences = await f.sequences();
      const authorization = principal === 'anonymous' ? '' : 'Bearer ' + (principal === 'buyer JWT' ? f.token : f.adminToken);
      const response = await request('/adminapi/config/user/register', { method: 'POST',
        headers: { Authorization: authorization }, body: JSON.stringify(newcomerShortCatalogInput(f.unique)) });
      const body = await response.json<Envelope<Catalog>>();
      expect(body.status).not.toBe(200); expect(body.msg).toMatch(/登录|权限/);
      expect(wiring.opened).toBe(0); await unchanged(before, sequences);
    }, 120_000);

  it('keeps cumulative base purchase admission incomplete after an otherwise valid actual Admin campaign', async () => {
    const f = await setup(), campaign = await saved();
    await f.db.update(storeProduct).set({ isLimit: 1, limitType: 2, limitNum: 10 }).where(eq(storeProduct.id, 70));
    await rejected('/api/cart/add', addInput(campaign), /累计|历史/);
  }, 120_000);

  it.each(['activity price', 'eligibility policy'] as const)(
    'rolls back a genuine LOGIN create after actual Admin changes %s in the next-order-id boundary', async mode => {
      const f = await setup(), campaign = await saved(), id = await add(campaign), receipt = await confirm(id);
      let edited: Awaited<ReturnType<Fixture['snapshot']>> | undefined;
      await f.withNewcomerRuntime(async writer => {
        const result = await outcome(create(writer, receipt, id, async () => {
          const input = newcomerShortCatalogInput(f.unique, mode === 'activity price' ? '9.00' : '8.00');
          if (mode === 'eligibility policy') input.newcomer_status = 0;
          const response = await request('/adminapi/config/user/register', { method: 'POST', body: JSON.stringify(input) });
          const body = await response.json<Envelope<Catalog>>(); expect(body.status, body.msg).toBe(200);
          edited = await f.snapshot(); return 'owned_newcomer_stale_quote';
        }));
        expect(edited).toBeDefined(); expect(result.ok).toBe(false);
        if (!result.ok) { expect(result.error).toBeInstanceOf(ApiException); expect(result.error.message).toMatch(/重新确认|新人|活动|变化/); }
      });
      await unchanged(edited!);
      expect(await f.db.select().from(storeOrder)).toEqual([]);
      expect((await f.db.select().from(user).where(eq(user.uid, 11)))[0].isNewcomer).toBe(0);
    }, 120_000);

  it.each(['stock', 'duplicate'] as const)(
    'rejects a committed %s change after an observed SKU wait in independent LOGIN create', async mode => {
      const f = await setup(), campaign = await saved(), id = await add(campaign), receipt = await confirm(id);
      const before = await f.snapshot(), skus = await f.db.select().from(storeProductAttrValue).orderBy(storeProductAttrValue.id);
      await f.withNewcomerRuntime(async writer => f.withPeer!(async holder => {
        const [observer] = await f.db.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`);
        expect(new Set([observer.pid, holder.pid, writer.pid]).size).toBe(3);
        await holder.exec('BEGIN');
        try {
          await holder.db.execute(sql`SELECT id FROM store_product_attr_value WHERE id=1 FOR UPDATE`);
          if (mode === 'stock') await holder.db.update(storeProductAttrValue).set({ stock: 0 }).where(eq(storeProductAttrValue.id, 1));
          else await holder.db.insert(storeProductAttrValue).values({ ...skus.find(row => row.id === 1)!,
            id: 900, suk: 'Committed new duplicate' });
          const pending = outcome(create(writer, receipt, id));
          await waitForFinanceBlock(f.db, writer.pid, holder.pid);
          await holder.exec('COMMIT');
          const result = await pending; expect(result.ok).toBe(false);
          if (!result.ok) { expect(result.error).toBeInstanceOf(ApiException); expect(result.error.message).toMatch(/规格|身份|库存|重新确认/); }
        } finally { await holder.exec('ROLLBACK'); }
      }));
      await onlyTables(before, ['store_product_attr_value']);
      const expected = mode === 'stock' ? skus.map(row => row.id === 1 ? { ...row, stock: 0 } : row)
        : [...skus, { ...skus.find(row => row.id === 1)!, id: 900, suk: 'Committed new duplicate' }];
      expect(await f.db.select().from(storeProductAttrValue).orderBy(storeProductAttrValue.id)).toEqual(expected);
    }, 120_000);

  it('does not repair a stored non-padding cart alias or let a prior quote authorize a different identity', async () => {
    const f = await setup(), campaign = await saved(), id = await add(campaign), receipt = await confirm(id);
    await f.db.update(storeCart).set({ productAttrUnique: f.unique + '\t' }).where(eq(storeCart.id, id));
    const before = await f.snapshot();
    await rejected('/api/order/confirm', { cartIds: [id], addressId: 11 }, /规格|失效|商品/);
    await f.withNewcomerRuntime(async writer => {
      const result = await outcome(create(writer, receipt, id)); expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBeInstanceOf(ApiException);
    });
    await unchanged(before);
  }, 120_000);
});
