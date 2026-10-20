/** Actual App/JWT and newly captured source orders on owned full PG16.
 * Received/payment admission is explicitly synthetic in the mature fixture;
 * repurchase itself only prepares carts and reads current authoritative prices.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createApp } from '@/app';
import { createContainerFromDb, withTx, type Container } from '@/lib/di';
import type { Env } from '@/env';
import { storeCart, storeOrderCartInfo, storeProduct, storeProductAttrValue } from '@/models/schema';
import { customerOrderRepurchaseFixture } from './helpers/customerOrderRepurchase';
import { waitForFinanceBlock } from './helpers/financePeers';

const wiring = vi.hoisted(() => ({ containers: new WeakMap<object, Container>() }));
vi.mock('@/lib/di', async original => ({ ...await original<typeof import('@/lib/di')>(), createContainer: (env: object) => {
  const container = wiring.containers.get(env);
  if (!container) throw Error('Missing owned short-SKU repurchase App boundary');
  return container;
} }));
const app = createApp(), shortUnique = 'short7';
type Fixture = Awaited<ReturnType<typeof customerOrderRepurchaseFixture>>;
type Selection = { cartIds: number[]; cateId: string; sourceOrderId: string; sourceRowId: number };
type Envelope<T> = { status: number; msg: string; data: T };
type Confirmation = { cartInfo: Array<{ id: number; cartNum: number; trueSumPrice: string;
  productInfo: { price: string } }> };

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('Customer short-SKU repurchase actual App JWT owned PG16', () => {
  let f: Fixture | undefined, kvMutations: () => number;
  beforeEach(() => { f = undefined; });
  afterEach(async () => {
    try {
      if (f) {
        expect(fetch).not.toHaveBeenCalled();
        expect(f.r2Reads).toEqual([]); expect(f.r2Writes).toEqual([]); expect(f.r2Deletes).toEqual([]);
      }
    } finally { vi.restoreAllMocks(); await f?.close(); }
  }, 30_000);

  function fixture(): Fixture {
    if (!f) throw Error('Owned short-SKU fixture is not initialized');
    return f;
  }
  async function setup(state: 'received' | 'unpaid' = 'unpaid') {
    f = await customerOrderRepurchaseFixture(state, { skuUnique: shortUnique, requirePurchaseOrigin: true,
      sourceIdentity: { key: `short-repurchase-${state}`, orderId: `short_repurchase_${state}` } });
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Owned short-SKU repurchase forbids provider dispatch'));
    const put = vi.spyOn(f.env.CONFIG_KV, 'put'), remove = vi.spyOn(f.env.CONFIG_KV, 'delete');
    kvMutations = () => put.mock.calls.length + remove.mock.calls.length;
    const [stored] = await f.db.execute(sql`SELECT "unique" AS raw_unique,
      pg_typeof("unique")::text AS storage_type, octet_length("unique") AS bytes
      FROM public.store_product_attr_value WHERE id=1`);
    expect(stored).toMatchObject({ raw_unique: 'short7  ', storage_type: 'character', bytes: 8 });
    expect(String(stored.raw_unique)).toHaveLength(8);
    // The source is produced by actual checkout after the fixture's catalogue
    // edit. No source snapshot or protected receipt is rewritten for success.
    expect(f.selected).toMatchObject({ productId: 70, skuUnique: shortUnique, cartNum: 2 });
    expect(JSON.parse(f.selected.cartInfo!)).toMatchObject({ sku: { id: 1, unique: shortUnique, price: '10.00' } });
    const rootId = f.source.pid > 0 ? f.source.pid : f.source.id;
    const [origin] = await f.db.execute(sql`SELECT lines FROM public.store_order_purchase_origin WHERE order_id=${rootId}`);
    const [physical] = await f.db.execute(sql`SELECT lines FROM public.store_order_purchase_physical_origin WHERE order_id=${rootId}`);
    expect(origin?.lines).toEqual(expect.arrayContaining([expect.objectContaining({ productId: 70,
      skuId: 1, skuUnique: shortUnique, quantity: 2 })]));
    expect(physical?.lines).toEqual(expect.arrayContaining([expect.objectContaining({ productId: 70,
      skuId: 1, skuUnique: shortUnique, quantity: 2, kind: 'charged', gift: null })]));
    return f;
  }
  function request(path: string, init: RequestInit, container = fixture().container) {
    const env: Env = { ...fixture().env }; wiring.containers.set(env, container);
    return app.request(path, { ...init, headers: { Authorization: 'Bearer ' + fixture().tokens.buyer,
      'content-type': 'application/json', ...init.headers } }, env);
  }
  async function prepare(container = fixture().container) {
    const mutations = kvMutations();
    const response = await request('/api/order/again', { method: 'POST',
      body: JSON.stringify({ uni: fixture().ids.publicOrderId }) }, container);
    const body = await response.json<Envelope<Selection>>();
    expect(kvMutations()).toBe(mutations);
    return { response, body };
  }
  async function reject(message: RegExp) {
    const f = fixture(), before = await f.snapshot(), sequences = await f.sequences();
    const { response, body } = await prepare();
    expect(response.status).toBeLessThan(500); expect(body.status, body.msg).toBe(400); expect(body.msg).toMatch(message);
    expect(await f.snapshot()).toEqual(before); expect(await f.sequences()).toEqual(sequences);
  }
  async function onlyCartWrites(before: Awaited<ReturnType<Fixture['snapshot']>>,
    sequences: Awaited<ReturnType<Fixture['sequences']>>, except: string[] = []) {
    const f = fixture(), after = await f.snapshot();
    expect(Object.keys(after)).toHaveLength(283);
    for (const table of Object.keys(before)) if (table !== 'store_cart' && !except.includes(table))
      expect(after[table], table).toEqual(before[table]);
    const next = await f.sequences(); expect(next).toHaveLength(229);
    for (const entry of sequences) if (entry.name !== 'store_cart_id_seq')
      expect(next.find(row => row.name === entry.name), entry.name).toEqual(entry);
  }
  async function assertPrepared(data: Selection) {
    const f = fixture(), rows = await f.prepared(data.cartIds);
    expect(data).toEqual({ cartIds: expect.any(Array), cateId: data.cartIds.join(','),
      sourceOrderId: f.ids.publicOrderId, sourceRowId: f.ids.sourceOrder });
    expect(new Set(data.cartIds).size).toBe(2);
    expect(rows.map(row => [row.productId, row.productAttrUnique, row.cartNum])).toEqual([
      [70, shortUnique, 2], [71, 'runtim71', 1],
    ]);
    for (const row of rows) expect(row).toMatchObject({ uid: 11, type: 0, isNew: 1,
      isPay: 0, isDel: 0, status: 1, activityId: 0, bargainUserId: 0 });
    return rows;
  }
  async function confirmCurrent(data: Selection) {
    const f = fixture(), before = await f.snapshot(), sequences = await f.sequences();
    const response = await request('/api/order/confirm', { method: 'POST',
      body: JSON.stringify({ cartIds: data.cartIds, addressId: 11 }) });
    const body = await response.json<Envelope<Confirmation>>();
    expect(response.status).toBe(200); expect(body.status, body.msg).toBe(200);
    expect(body.data.cartInfo.map(row => row.cartNum)).toEqual([2, 1]);
    expect(body.data.cartInfo.map(row => row.trueSumPrice)).toEqual(['37.76', '30.00']);
    expect(body.data.cartInfo[0].productInfo.price).toBe('18.88');
    expect(await f.snapshot()).toEqual(before); expect(await f.sequences()).toEqual(sequences);
  }

  it.each(['unpaid', 'received'] as const)(
    'prepares an actual %s short-SKU source at current SKU prices without merging old or repeated direct intents', async state => {
      const f = await setup(state);
      await f.db.update(storeProduct).set({ price: '17.00' }).where(eq(storeProduct.id, 70));
      await f.db.update(storeProductAttrValue).set({ price: '18.88' }).where(eq(storeProductAttrValue.id, 1));
      await f.db.insert(storeCart).values([0, 1].map(isNew => ({ uid: 11, productId: 70,
        productAttrUnique: shortUnique, cartNum: 1, isNew, status: 1 })));
      const oldCarts = await f.db.select().from(storeCart), before = await f.snapshot(), sequences = await f.sequences();
      const first = await prepare(); expect(first.response.status).toBe(200); expect(first.body.status, first.body.msg).toBe(200);
      const firstRows = await assertPrepared(first.body.data);
      await onlyCartWrites(before, sequences);
      for (const row of oldCarts) expect((await f.db.select().from(storeCart)).find(item => item.id === row.id)).toEqual(row);
      await confirmCurrent(first.body.data);
      const repeatedBefore = await f.snapshot(), repeatedSequences = await f.sequences();
      const repeated = await prepare(); expect(repeated.body.status, repeated.body.msg).toBe(200);
      await assertPrepared(repeated.body.data);
      expect(repeated.body.data.cartIds.some(id => first.body.data.cartIds.includes(id))).toBe(false);
      expect(await f.prepared(first.body.data.cartIds)).toEqual(firstRows);
      await onlyCartWrites(repeatedBefore, repeatedSequences);
    }, 120_000);

  it.each(['padded coherent aliases', 'conflicting aliases'] as const)(
    'rejects %s in mutable historical source evidence instead of trimming source corruption into validity', async mode => {
      const f = await setup(), snapshot = JSON.parse(f.selected.cartInfo!);
      snapshot.sku.unique = mode === 'padded coherent aliases' ? shortUnique.padEnd(8, ' ') : 'other001';
      await f.db.update(storeOrderCartInfo).set({ cartInfo: JSON.stringify(snapshot),
        ...(mode === 'padded coherent aliases' ? { skuUnique: shortUnique.padEnd(8, ' ') } : {}) })
        .where(eq(storeOrderCartInfo.id, f.selected.id));
      await reject(/原订单商品快照无法核对/);
    }, 60_000);

  it.each(['wrong product', 'wrong type', 'retired'] as const)(
    'rejects a current %s short-key row without writing a new cart or changing the source', async mode => {
      const f = await setup();
      await f.db.update(storeProductAttrValue).set(mode === 'wrong product' ? { productId: 71 }
        : mode === 'wrong type' ? { type: 4 } : { isRetired: 1 }).where(eq(storeProductAttrValue.id, 1));
      await reject(/原订单商品或规格已下架、未审核或失效/);
    }, 60_000);

  it('rejects two live current SKUs with the same canonical product/key instead of selecting one padded row', async () => {
    const f = await setup();
    const [original] = await f.db.select().from(storeProductAttrValue).where(eq(storeProductAttrValue.id, 1));
    // Base type0 identities have a nonunique legacy index. This is an actual
    // second row, not an altered reader or a mocked canonical-key collision.
    await f.db.insert(storeProductAttrValue).values({ ...original, id: 900,
      unique: shortUnique.padEnd(8, ' '), suk: 'Owned duplicate current SKU' });
    const rows = await f.db.execute(sql`SELECT "unique" AS raw_unique FROM public.store_product_attr_value
      WHERE product_id=70 AND type=0 AND is_retired=0 AND "unique"=${shortUnique} ORDER BY id`);
    expect(rows).toEqual([{ raw_unique: 'short7  ' }, { raw_unique: 'short7  ' }]);
    await reject(/原订单商品或规格已下架、未审核或失效/);
  }, 60_000);

  it('observes an actual current-SKU lock wait and prices its committed edit without reversing SKU/product locks', async () => {
    const f = await setup();
    await f.db.update(storeProduct).set({ price: '17.00' }).where(eq(storeProduct.id, 70));
    const before = await f.snapshot(), sequences = await f.sequences(), skus = await f.db.select().from(storeProductAttrValue).orderBy(storeProductAttrValue.id);
    await f.withPeer!(async holder => f.withPeer!(async actor => {
      const [observer] = await f.db.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`);
      expect(new Set([observer.pid, holder.pid, actor.pid]).size).toBe(3);
      let unlock!: () => void, locked!: () => void;
      const ready = new Promise<void>(yes => { locked = yes; }), release = new Promise<void>(yes => { unlock = yes; });
      const holding = withTx(createContainerFromDb(holder.db), async tx => {
        await tx.update(storeProductAttrValue).set({ price: '18.88' }).where(eq(storeProductAttrValue.id, 1));
        locked(); await release;
        // The waiting actor must not hold product SHARE before its SKU lock.
        await tx.execute(sql`SELECT id FROM store_product WHERE id=70 FOR UPDATE NOWAIT`);
      });
      await ready;
      const pending = prepare(createContainerFromDb(actor.db));
      try { await waitForFinanceBlock(f.db, actor.pid, holder.pid); } finally { unlock(); }
      await holding;
      const { response, body } = await pending;
      expect(response.status).toBe(200); expect(body.status, body.msg).toBe(200);
      await assertPrepared(body.data);
      await confirmCurrent(body.data);
    }));
    await onlyCartWrites(before, sequences, ['store_product_attr_value']);
    expect(await f.db.select().from(storeProductAttrValue).orderBy(storeProductAttrValue.id))
      .toEqual(skus.map(row => row.id === 1 ? { ...row, price: '18.88' } : row));
  }, 120_000);
});
