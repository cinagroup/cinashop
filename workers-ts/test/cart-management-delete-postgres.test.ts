import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { asc, eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import type { AppVariables, Env } from '../src/env';
import { createContainerFromDb } from '../src/lib/di';
import { storeCart, storeOrder, storeProduct, storeProductAttrValue, user, userRelation } from '../src/models/schema';
import { StoreCartService } from '../src/services/order/StoreCartService';
import { cartDel } from '../src/controllers/api/v1/OrderController';
import { ApiException } from '../src/utils/errors';
import { financePostgres } from './helpers/financePostgres';

// Actual controller/service and SQL. Native PG16 proves the independent-session
// lock cases; default PGlite runs business/rollback cases without claiming locks.
// The isolated HTTP app supplies its principal explicitly, not a JWT substitute.
describe('scoped ordinary-cart management deletion, exact atomic SQL set', () => {
  let f: Awaited<ReturnType<typeof financePostgres>>, service: StoreCartService;
  let app: Hono<{ Bindings: Env; Variables: AppVariables }>;
  beforeAll(async () => {
    f = await financePostgres([storeCart, storeProduct, storeProductAttrValue, storeOrder, user, userRelation]);
    const container = createContainerFromDb(f.db);
    service = new StoreCartService(container);
    app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
    app.use('*', async (c, next) => {
      c.set('container', container);
      c.set('uid', c.req.header('x-fixture-user') === '11' ? 11 : 0);
      await next();
    });
    app.onError((error, c) => c.json({ status: error instanceof ApiException ? error.code : 500, msg: error.message, data: null }));
    app.post('/api/cart/del', cartDel);
  }, 30_000);
  afterAll(async () => { await f?.close(); }, 30_000);
  beforeEach(async () => {
    await f.reset();
    await f.db.insert(user).values([{ uid: 11, nickname: 'owned fixture' }, { uid: 22, nickname: 'other fixture' }]);
    await f.db.insert(storeProduct).values({ id: 70, storeName: 'unchanged product', stock: 9, sales: 3, price: '19.99' });
    await f.db.insert(storeProductAttrValue).values({ id: 1, productId: 70, unique: 'scope001', stock: 9, sales: 3 });
    await f.db.insert(storeCart).values([
      { id: 1, uid: 11, productId: 70, productAttrUnique: 'scope001', cartNum: 2 },
      { id: 2, uid: 11, productId: 999, status: 0, cartNum: 0 },
      { id: 3, uid: 11, productId: 70, type: 3, activityId: 800, productAttrUnique: 'expired', cartNum: 1 },
    ]);
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Cart-management SQL tests forbid external I/O'));
  });
  afterEach(() => { expect(fetch).not.toHaveBeenCalled(); vi.restoreAllMocks(); });
  async function snapshot() {
    return { carts: await f.db.select().from(storeCart).orderBy(asc(storeCart.id)), products: await f.db.select().from(storeProduct),
      skus: await f.db.select().from(storeProductAttrValue), orders: await f.db.select().from(storeOrder),
      users: await f.db.select().from(user).orderBy(asc(user.uid)), collections: await f.db.select().from(userRelation) };
  }
  type Snapshot = Awaited<ReturnType<typeof snapshot>>;
  const deleted = (before: Snapshot, ids: number[]): Snapshot => ({
    ...before, carts: before.carts.map(row => ids.includes(row.id) ? { ...row, isDel: 1 } : row),
  });
  async function post(body: unknown, loggedIn = true, raw?: string) {
    const response = await app.request('/api/cart/del', { method: 'POST', headers: {
      'content-type': 'application/json', ...(loggedIn ? { 'x-fixture-user': '11' } : {}),
    }, body: raw ?? JSON.stringify(body) });
    return { response, body: await response.json<{ status: number; msg: string; data: unknown }>() };
  }

  it('removes exactly selected ordinary rows including missing products, status zero and activity carts', async () => {
    const before = await snapshot();
    await service.delOrdinaryCart(11, [3, 2]);
    expect(await snapshot()).toEqual(deleted(before, [2, 3]));
  });

  it.each([
    ['UID', { uid: 22 }], ['staff', { staffId: 8 }], ['tourist', { touristUid: 'other-session' }],
    ['store', { storeId: 7 }], ['paid', { isPay: 1 }], ['deleted', { isDel: 1 }], ['immediate-buy', { isNew: 1 }],
  ] as const)('rejects a mixed set crossing the %s boundary without changing its valid member', async (_name, patch) => {
    await f.db.update(storeCart).set(patch).where(eq(storeCart.id, 2));
    const before = await snapshot();
    await expect(service.delOrdinaryCart(11, [1, 2])).rejects.toThrow('购物车项已变化');
    expect(await snapshot()).toEqual(before);
  });

  it('rejects missing members and stale second deletion rather than silently succeeding', async () => {
    const before = await snapshot();
    await expect(service.delOrdinaryCart(11, [1, 999])).rejects.toThrow('购物车项已变化');
    expect(await snapshot()).toEqual(before);
    await service.delOrdinaryCart(11, [1]);
    const after = await snapshot();
    await expect(service.delOrdinaryCart(11, [1, 2])).rejects.toThrow('购物车项已变化');
    expect(await snapshot()).toEqual(after);
  });

  it('rejects every malformed set and principal before beginning a transaction', async () => {
    const transaction = vi.spyOn(f.db, 'transaction');
    const malformed: unknown[] = [undefined, null, {}, '1', 1, [], [1, 1], [0], [-1], [1.1], [NaN], [Infinity],
      ['1'], [true], [2_147_483_648], [Number.MAX_SAFE_INTEGER], Array(1), Array.from({ length: 201 }, (_, i) => i + 1)];
    for (const ids of malformed) await expect(service.delOrdinaryCart(11, ids)).rejects.toThrow('1至200');
    for (const uid of [0, -1, 1.5, NaN, Infinity, 2_147_483_648]) {
      await expect(service.delOrdinaryCart(uid, [1])).rejects.toThrow('1至200');
    }
    expect(transaction).not.toHaveBeenCalled();
  });

  it('accepts the full 200-ID capacity without truncating and changes only isDel', async () => {
    await f.db.delete(storeCart);
    const ids = Array.from({ length: 200 }, (_, i) => i + 1);
    await f.db.insert(storeCart).values(ids.map(id => ({ id, uid: 11, productId: id, status: id % 2, cartNum: 1 })));
    const before = await snapshot();
    await service.delOrdinaryCart(11, [...ids].reverse());
    expect(await snapshot()).toEqual(deleted(before, ids));
  });

  it('accepts the exact PostgreSQL integer upper boundary', async () => {
    await f.db.insert(user).values({ uid: 2_147_483_647, nickname: 'owned upper-bound actor' });
    await f.db.insert(storeCart).values({ id: 2_147_483_647, uid: 2_147_483_647, productId: 999 });
    const before = await snapshot();
    await service.delOrdinaryCart(2_147_483_647, [2_147_483_647]);
    expect(await snapshot()).toEqual(deleted(before, [2_147_483_647]));
  });

  it('copies the accepted selection before an awaiting caller can mutate its array', async () => {
    const ids = [2, 1], before = await snapshot();
    const pending = service.delOrdinaryCart(11, ids);
    ids.splice(0, ids.length, 3);
    await pending;
    expect(await snapshot()).toEqual(deleted(before, [1, 2]));
  });

  it('rolls back an otherwise successful partial UPDATE when a real trigger skips one locked member', async () => {
    const before = await snapshot();
    await f.exec(`CREATE FUNCTION cart_management_skip_one() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.id = 2 AND NEW.is_del = 1 THEN RETURN NULL; END IF; RETURN NEW; END $$`);
    await f.exec('CREATE TRIGGER cart_management_skip_one BEFORE UPDATE ON store_cart FOR EACH ROW EXECUTE FUNCTION cart_management_skip_one()');
    try {
      await expect(service.delOrdinaryCart(11, [1, 2])).rejects.toThrow('删除未完整确认');
      expect(await snapshot()).toEqual(before);
    } finally {
      await f.exec('DROP TRIGGER cart_management_skip_one ON store_cart');
      await f.exec('DROP FUNCTION cart_management_skip_one()');
    }
  });

  it('runs the actual scoped HTTP branch, returns the legacy null envelope and rereads exact SQL state', async () => {
    const before = await snapshot(), result = await post({ scope: 'cart', ids: [2, 1] });
    expect(result.body, result.body.msg).toEqual({ status: 200, msg: '删除成功', data: null });
    expect(result.response.headers.get('cache-control')).toBe('private, no-store');
    expect(await snapshot()).toEqual(deleted(before, [1, 2]));
  });

  it('never falls back to legacy deletion for unknown scopes, extra scoped keys or invalid IDs', async () => {
    const before = await snapshot(), transaction = vi.spyOn(f.db, 'transaction');
    for (const body of [{ scope: 'buy', ids: [1] }, { scope: '', ids: [1] }, { scope: null, ids: [1] },
      { scope: false, ids: [1] }, { scope: ['cart'], ids: [1] }, { scope: 'cart', ids: [1], uid: 11 },
      { scope: 'cart', ids: [1], ordinary: true }, { scope: 'cart', ids: [] }, { scope: 'cart', ids: [1, 1] },
      { scope: 'cart', ids: ['1'] }, { scope: 'cart', ids: '1' }, { scope: 'cart', ids: [0] },
      { scope: 'cart', ids: [1.5] }, { scope: 'cart', ids: [2_147_483_648] },
      { scope: 'cart', ids: Array.from({ length: 201 }, (_, i) => i + 1) }]) {
      expect((await post(body)).body.status, JSON.stringify(body)).toBe(400);
    }
    expect(transaction).not.toHaveBeenCalled(); expect(await snapshot()).toEqual(before);
  });

  it('rejects anonymous, malformed and over-budget HTTP bodies before any transaction', async () => {
    const before = await snapshot(), transaction = vi.spyOn(f.db, 'transaction');
    expect((await post({ scope: 'cart', ids: [1] }, false)).body.status).not.toBe(200);
    for (const raw of ['null', '[]', '"cart"', '{"scope":']) expect((await post({}, true, raw)).body.status).toBe(400);
    const oversized = await post({}, true, JSON.stringify({ scope: 'cart', ids: [1], padding: 'x'.repeat(65 * 1024) }));
    expect(oversized.body).toMatchObject({ status: 400, msg: '请求体过大' });
    expect(transaction).not.toHaveBeenCalled(); expect(await snapshot()).toEqual(before);
  });

  it('rejects a cross-owner HTTP set atomically without exposing or deleting either row', async () => {
    await f.db.update(storeCart).set({ uid: 22 }).where(eq(storeCart.id, 2));
    const before = await snapshot(), result = await post({ scope: 'cart', ids: [1, 2] });
    expect(result.body).toMatchObject({ status: 400, data: null, msg: '购物车项已变化，请重新读取后操作' });
    expect(await snapshot()).toEqual(before);
  });

  it('preserves ordinary valid unscoped legacy object semantics, including ignored extra keys', async () => {
    await f.db.update(storeCart).set({ isNew: 1, staffId: 8, isPay: 1 }).where(eq(storeCart.id, 2));
    await f.db.update(storeCart).set({ uid: 22 }).where(eq(storeCart.id, 3));
    const before = await snapshot(), result = await post({ ids: [1, 2, 3], legacy: true });
    expect(result.body).toEqual({ status: 200, msg: '删除成功', data: null });
    expect(await snapshot()).toEqual(deleted(before, [1, 2]));
  });

  it.skipIf(!process.env.TEST_FINANCE_POSTGRES_URL)('native: serializes overlapping reversed selections into one full commit and one stale rejection', async () => {
    const before = await snapshot();
    const results = await Promise.allSettled([service.delOrdinaryCart(11, [1, 2]), service.delOrdinaryCart(11, [2, 1])]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    expect(await snapshot()).toEqual(deleted(before, [1, 2]));
  });

  it.skipIf(!process.env.TEST_FINANCE_POSTGRES_URL)('native: rechecks a row paid by another transaction while waiting and rejects the complete set', async () => {
    let release!: () => void, locked!: () => void;
    const hold = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { locked = resolve; });
    const claiming = f.db.transaction(async tx => {
      await tx.update(storeCart).set({ isPay: 1 }).where(eq(storeCart.id, 2));
      locked(); await hold;
    });
    await ready;
    const deletion = service.delOrdinaryCart(11, [1, 2]);
    // Attach rejection immediately so the expected later rejection is observed.
    const outcome = deletion.then(() => ({ rejected: false, message: '' }), error => ({ rejected: true, message: String(error) }));
    try {
      let waiting = false;
      for (let attempt = 0; attempt < 200; attempt++) {
        const [row] = await f.db.execute(sql`SELECT EXISTS(SELECT 1 FROM pg_stat_activity
          WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock'
          AND query ILIKE '%for update%' AND query LIKE '%"store_cart"%') AS waiting`);
        if (row?.waiting === true) { waiting = true; break; }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(waiting, 'deletion must actually wait for this fixture row before claim commit').toBe(true);
    } finally { release(); await claiming; await outcome; }
    const result = await outcome;
    expect(result.rejected).toBe(true); expect(result.message).toContain('购物车项已变化');
    const after = await snapshot();
    expect(after.carts.find(row => row.id === 1)?.isDel).toBe(0);
    expect(after.carts.find(row => row.id === 2)).toMatchObject({ isPay: 1, isDel: 0 });
    expect(after.carts.find(row => row.id === 3)?.isDel).toBe(0);
  }, 10_000);
});
