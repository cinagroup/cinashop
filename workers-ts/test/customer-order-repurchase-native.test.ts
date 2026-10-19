import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createApp } from '@/app';
import { createContainerFromDb, withTx, type Container } from '@/lib/di';
import type { Env } from '@/env';
import { storeCart, storeOrder, storeOrderCartInfo, storeProduct, storeProductAttrValue, systemConfig, user } from '@/models/schema';
import { customerOrderRepurchaseFixture } from './helpers/customerOrderRepurchase';
import { waitForFinanceBlock } from './helpers/financePeers';

const wiring = vi.hoisted(() => ({ containers: new WeakMap<object, Container>() }));
vi.mock('@/lib/di', async original => ({ ...await original<typeof import('@/lib/di')>(), createContainer: (env: object) => {
  const container = wiring.containers.get(env); if (!container) throw Error('Missing owned repurchase App boundary'); return container;
} }));
const app = createApp();
type Envelope = { status: number; msg: string; data: any };
const bearer = (token: string) => ({ Authorization: 'Bearer ' + token });

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('Customer repurchase actual App JWT owned PG16', () => {
  let f: Awaited<ReturnType<typeof customerOrderRepurchaseFixture>>;
  beforeEach(async () => {
    f = await customerOrderRepurchaseFixture();
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Owned repurchase acceptance forbids provider dispatch'));
  }, 30000);
  afterEach(async () => {
    try { expect(fetch).not.toHaveBeenCalled(); expect(f.r2Writes).toEqual([]); expect(f.r2Deletes).toEqual([]); expect(f.r2Reads).toEqual([]); }
    finally { vi.restoreAllMocks(); await f?.close(); }
  }, 30000);
  function request(path: string, init: RequestInit = {}, container = f.container) {
    const env: Env = { ...f.env }; wiring.containers.set(env, container); return app.request(path, init, env);
  }
  async function prepare(value: unknown = { uni: f.ids.publicOrderId }, token: string | null = f.tokens.buyer, container = f.container) {
    const response = await request('/api/order/again', { method: 'POST', headers: {
      ...(token === null ? {} : bearer(token)), 'content-type': 'application/json' }, body: JSON.stringify(value) }, container);
    return { response, body: await response.json<Envelope>() };
  }
  async function reject(work: () => ReturnType<typeof prepare>, code = 400) {
    const before = await f.snapshot(), sequences = await f.sequences();
    const { response, body } = await work(); expect(response.status).toBeLessThan(500); expect(body.status, body.msg).toBe(code);
    expect(await f.snapshot()).toEqual(before); expect(await f.sequences()).toEqual(sequences); return body;
  }
  async function read(path: string, init: RequestInit = {}) {
    const before = await f.snapshot(), sequences = await f.sequences();
    expect(Object.keys(before)).toHaveLength(282); expect(sequences).toHaveLength(229);
    const response = await request(path, { ...init, headers: { ...bearer(f.tokens.buyer), 'content-type': 'application/json', ...init.headers } });
    const body = await response.json<Envelope>(); expect(response.status).toBeLessThan(500); expect(body.status, body.msg).toBe(200);
    expect(await f.snapshot()).toEqual(before); expect(await f.sequences()).toEqual(sequences); return body.data;
  }
  async function fresh() {
    const { response, body } = await prepare(); expect(response.status).toBe(200); expect(body.status, body.msg).toBe(200);
    const data = body.data as { cartIds: number[]; cateId: string; sourceOrderId: string; sourceRowId: number };
    expect(data).toEqual({ cartIds: expect.any(Array), cateId: data.cartIds.join(','), sourceOrderId: f.ids.publicOrderId, sourceRowId: f.ids.sourceOrder });
    expect(new Set(data.cartIds).size).toBe(data.cartIds.length); return { data, rows: await f.prepared(data.cartIds) };
  }

  it('prepares Supplier-origin ordinary 2+1 selections independently, preserves claimed and unrelated carts, and quotes current prices through actual buy-scope APIs', async () => {
    expect(f.carts.map(row => row.type)).toEqual([2, 2]); expect(f.source).toMatchObject({ uid: 11, type: 0, paid: 1, status: 2 });
    await f.db.update(storeProductAttrValue).set({ price: '18.88' }).where(eq(storeProductAttrValue.productId, 70));
    await f.db.insert(storeCart).values([0, 1].map(isNew => ({ uid: 11, productId: 70, productAttrUnique: f.selected.skuUnique, cartNum: 1, isNew, status: 1 })));
    const preserved = await f.db.select().from(storeCart), before = await f.snapshot(), sequences = await f.sequences();
    const { data, rows } = await fresh(); expect(rows.map(row => [row.productId, row.productAttrUnique, row.cartNum])).toEqual(f.carts.map(row => [row.productId, row.skuUnique, row.cartNum]));
    for (const row of rows) expect(row).toMatchObject({ uid: 11, type: 0, isNew: 1, isPay: 0, isDel: 0, status: 1, activityId: 0, bargainUserId: 0 });
    const all = await f.db.select().from(storeCart); for (const row of preserved) expect(all.find(item => item.id === row.id)).toEqual(row);
    const after = await f.snapshot(); for (const name of Object.keys(before)) if (name !== 'store_cart') expect(after[name], name).toEqual(before[name]);
    const next = await f.sequences(); for (const entry of sequences) if (entry.name !== 'store_cart_id_seq') expect(next.find(row => row.name === entry.name)).toEqual(entry);
    const detail = await read('/api/order/detail/' + f.ids.publicOrderId); expect(detail.order_id ?? detail.orderId).toBe(f.ids.publicOrderId);
    const buy = await read('/api/cart/list?scope=buy&ids=' + data.cateId); expect(buy.map((row: any) => row.id)).toEqual(data.cartIds);
    expect(buy.map((row: any) => row.cartNum)).toEqual([2, 1]); expect(buy[0].productInfo.price).toBe('18.88');
    const ordinary = await read('/api/cart/list?scope=cart'); expect(ordinary.some((row: any) => data.cartIds.includes(row.id))).toBe(false);
    const quote = await read('/api/order/confirm', { method: 'POST', body: JSON.stringify({ cartIds: data.cartIds, addressId: 11 }) });
    expect(quote.cartInfo.map((row: any) => row.trueSumPrice)).toEqual(['37.76', '30.00']); expect(quote.cartInfo[0].productInfo.price).toBe('18.88');
  }, 120000);

  it('keeps explicit repeated preparations disjoint and supports the existing order_id alias without merging', async () => {
    const first = await fresh(); const { body } = await prepare({ order_id: f.ids.publicOrderId, uni: f.ids.publicOrderId });
    expect(body.status, body.msg).toBe(200); expect(body.data.cartIds.some((id: number) => first.data.cartIds.includes(id))).toBe(false);
    expect(await f.prepared(first.data.cartIds)).toEqual(first.rows);
  });
  it('does not impose a paid or completed API restriction absent from PHP', async () => {
    await f.close(); f = await customerOrderRepurchaseFixture('unpaid'); expect(f.source).toMatchObject({ paid: 0, status: 0, type: 0 });
    expect((await fresh()).rows).toHaveLength(2);
  }, 30000);
  it('retains gift products as fresh ordinary-price selections without copying historical gift entitlement', async () => {
    await f.db.update(storeOrderCartInfo).set({ isGift: 1, cartInfo: JSON.stringify({ ...JSON.parse(f.selected.cartInfo!), is_gift: 1, truePrice: '0.00' }) }).where(eq(storeOrderCartInfo.id, f.selected.id));
    const { data, rows } = await fresh(); expect(rows).toHaveLength(2); expect(rows[0]).toMatchObject({ productId: 70, cartNum: 2, type: 0, activityId: 0 });
    const buy = await read('/api/cart/list?scope=buy&ids=' + data.cateId); expect(buy[0].productInfo.price).toBe('10');
  });
  it('uses exact legacy SKU identity and physical quantity rather than stale JSON quantity', async () => {
    await f.db.update(storeOrderCartInfo).set({ skuUnique: '', cartInfo: JSON.stringify({ type: 0, product_id: 70, cart_num: 999,
      productInfo: { id: 70, attrInfo: { unique: f.selected.skuUnique } } }) }).where(eq(storeOrderCartInfo.id, f.selected.id));
    expect((await fresh()).rows[0]).toMatchObject({ productId: 70, productAttrUnique: f.selected.skuUnique, cartNum: 2 });
  });
  it('filters legacy activity cart type rather than physical Supplier merchant origin', async () => {
    await f.db.update(storeOrderCartInfo).set({ cartInfo: JSON.stringify({ ...JSON.parse(f.selected.cartInfo!), type: 7 }) }).where(eq(storeOrderCartInfo.id, f.selected.id));
    const { rows } = await fresh(); expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({ productId: 71, cartNum: 1, type: 0 });
  });
  it.each([1, 2, 3, 4, 5])('rejects PHP excluded source activity type %i before all writes', async type => {
    await f.db.update(storeOrder).set({ type }).where(eq(storeOrder.id, f.ids.sourceOrder)); await reject(() => prepare());
  });
  it.each(['unauthenticated', 'foreign Customer'] as const)('rejects %s with real JWT ownership and no writes', async mode => {
    await reject(() => prepare({ uni: f.ids.publicOrderId }, mode === 'unauthenticated' ? null : f.tokens.foreignBuyer), mode === 'unauthenticated' ? 410000 : 404);
  });
  it.each(['isDel', 'isSystemDel'] as const)('rejects a source marked %s', async field => {
    await f.db.update(storeOrder).set({ [field]: 1 }).where(eq(storeOrder.id, f.ids.sourceOrder)); await reject(() => prepare(), 404);
  });
  it.each([{ name: 'conflicting aliases', body: { uni: 'different', order_id: 'repurchase_source' } },
    { name: 'missing reference', body: {} }, { name: 'numeric reference', body: { uni: 123 } },
    { name: 'padded reference', body: { uni: ' repurchase_source' } }, { name: 'oversized reference', body: { uni: 'x'.repeat(33) } },
    { name: 'array body', body: [] }, { name: 'oversized body', body: { uni: 'repurchase_source', ignored: 'x'.repeat(65537) } },
  ])('rejects $name without ignored client fields becoming selections', async ({ body }) => { await reject(() => prepare(body)); });
  it.each([0, 32768])('rejects invalid physical quantity %i before inserting direct-buy rows', async cartNum => {
    await f.db.update(storeOrderCartInfo).set({ cartNum }).where(eq(storeOrderCartInfo.id, f.selected.id)); await reject(() => prepare());
  });
  it.each(['retired SKU', 'hidden product', 'deleted product', 'unapproved product', 'product stock', 'SKU stock'] as const)('rejects current %s atomically', async mode => {
    if (mode === 'retired SKU') await f.db.update(storeProductAttrValue).set({ isRetired: 1 }).where(eq(storeProductAttrValue.productId, 70));
    else if (mode === 'SKU stock') await f.db.update(storeProductAttrValue).set({ stock: 1 }).where(eq(storeProductAttrValue.productId, 70));
    else await f.db.update(storeProduct).set(mode === 'hidden product' ? { isShow: 0 } : mode === 'deleted product' ? { isDel: 1 } : mode === 'unapproved product' ? { isVerify: 0 } : { stock: 1 }).where(eq(storeProduct.id, 70));
    await reject(() => prepare());
  });
  it.each(['malformed', 'missing SKU', 'conflicting SKU', 'foreign product', 'oversized'] as const)('rejects a %s protected snapshot without guessing a replacement', async mode => {
    const snapshot = JSON.parse(f.selected.cartInfo!);
    const cartInfo = mode === 'malformed' ? '{' : mode === 'missing SKU' ? JSON.stringify({ type: 0, product_id: 70 })
      : mode === 'conflicting SKU' ? JSON.stringify({ ...snapshot, product_attr_unique: 'other001' })
      : mode === 'foreign product' ? JSON.stringify({ ...snapshot, product_id: 71 }) : 'x'.repeat(32769);
    await f.db.update(storeOrderCartInfo).set({ cartInfo, ...(mode === 'missing SKU' ? { skuUnique: '' } : {}) }).where(eq(storeOrderCartInfo.id, f.selected.id));
    await reject(() => prepare());
  });
  it('enforces a current per-order limit on aggregate source quantity and permits a corrected limit', async () => {
    await f.db.update(storeProduct).set({ isLimit: 1, limitType: 1, limitNum: 1 }).where(eq(storeProduct.id, 70));
    await reject(() => prepare());
    await f.db.update(storeProduct).set({ limitNum: 2 }).where(eq(storeProduct.id, 70)); expect((await fresh()).rows).toHaveLength(2);
  });
  it('fails closed for cumulative history rather than double-counting a paid allocation parent and child or assuming missing history is zero', async () => {
    await f.db.update(storeProduct).set({ isLimit: 1, limitType: 2, limitNum: 100 }).where(eq(storeProduct.id, 70));
    const result = await reject(() => prepare()); expect(result.msg).toContain('累计限购历史');
  });
  async function memberProduct(enabled = true) {
    await f.db.update(storeProduct).set({ isVipProduct: 1 }).where(eq(storeProduct.id, 70));
    await f.db.update(systemConfig).set({ value: enabled ? '1' : '0' }).where(eq(systemConfig.menuName, 'member_card_status'));
  }
  it.each(['absent', 'expired', 'function disabled'] as const)('rejects current %s paid membership before preparing rows', async mode => {
    await memberProduct(mode !== 'function disabled');
    await f.db.update(user).set(mode === 'function disabled' ? { isEverLevel: 1 } : { isEverLevel: 0, isMoneyLevel: mode === 'expired' ? 1 : 0, overdueTime: Math.floor(Date.now() / 1000) - 1 }).where(eq(user.uid, 11));
    await reject(() => prepare());
  });
  it.each(['current fixed-term', 'lifetime'] as const)('accepts %s paid membership when price discounts are disabled and keeps account/financial rows unchanged', async mode => {
    await memberProduct();
    await f.db.update(user).set(mode === 'lifetime' ? { isEverLevel: 1 } : { isEverLevel: 0, isMoneyLevel: 1, overdueTime: Math.floor(Date.now() / 1000) + 3600 }).where(eq(user.uid, 11));
    const before = await f.snapshot(); expect((await fresh()).rows).toHaveLength(2); const after = await f.snapshot();
    for (const name of Object.keys(before)) if (name !== 'store_cart') expect(after[name], name).toEqual(before[name]);
  });
  it('uses the database clock after cart INSERT waits so expiring membership rolls back the entire preparation', async () => {
    await memberProduct();
    await f.db.execute(sql`UPDATE "user" SET is_ever_level=0,is_money_level=1,overdue_time=floor(extract(epoch FROM clock_timestamp()))::integer+2 WHERE uid=11`);
    await f.exec("CREATE FUNCTION repurchase_member_delay() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.product_id=70 THEN PERFORM pg_sleep(2.1); END IF; RETURN NEW; END $$; CREATE TRIGGER repurchase_member_delay BEFORE INSERT ON store_cart FOR EACH ROW EXECUTE FUNCTION repurchase_member_delay()");
    const before = await f.snapshot(), sequences = await f.sequences(); const { response, body } = await prepare(); expect(response.status).toBeLessThan(500); expect(body.status).toBe(400); expect(body.msg).toContain('付费会员');
    expect(await f.snapshot()).toEqual(before);
    const previous = sequences.find(row => row.name === 'store_cart_id_seq')!, next = (await f.sequences()).find(row => row.name === 'store_cart_id_seq')!;
    expect(Number((next as unknown as Record<string, unknown>).last_value)).toBeGreaterThan(Number((previous as unknown as Record<string, unknown>).last_value));
    // INSERT sequence allocation is nontransactional even on a late policy refusal.
  });
  it('bounds source lines to the checkout selection limit without partial preparation', async () => {
    await f.db.insert(storeOrderCartInfo).values(Array.from({ length: 99 }, (_, index) => ({ ...f.selected, id: undefined, unique: ('repurchase' + String(index).padStart(3, '0')).padEnd(32, '0') })));
    await reject(() => prepare());
  });
  it('checks aggregate current stock across repeated source SKU rows without reserving inventory', async () => {
    await f.db.insert(storeOrderCartInfo).values({ ...f.selected, id: undefined, unique: 'owned_repurchase_repeated_sku' });
    await f.db.update(storeProductAttrValue).set({ stock: 3 }).where(eq(storeProductAttrValue.productId, 70));
    await reject(() => prepare());
  });
  it('rejects a protected line with another Customer identity instead of treating order ownership as sufficient', async () => {
    await f.db.update(storeOrderCartInfo).set({ uid: 22 }).where(eq(storeOrderCartInfo.id, f.selected.id)); await reject(() => prepare());
  });
  it('ignores caller product, SKU and quantity fields and derives every selection from the owned order', async () => {
    const { body } = await prepare({ uni: f.ids.publicOrderId, cartIds: [999999], productId: 999999, unique: 'fake0001', cartNum: 1 });
    expect(body.status, body.msg).toBe(200); expect((await f.prepared(body.data.cartIds)).map(row => [row.productId, row.cartNum])).toEqual([[70, 2], [71, 1]]);
  });
  it('rolls back all prepared rows on a genuinely late second-line SQL failure', async () => {
    await f.exec("CREATE FUNCTION repurchase_late_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.product_id=71 AND NEW.is_new=1 THEN RAISE EXCEPTION 'owned second repurchase row fault'; END IF; RETURN NEW; END $$; CREATE TRIGGER repurchase_late_fault AFTER INSERT ON store_cart FOR EACH ROW EXECUTE FUNCTION repurchase_late_fault()");
    const before = await f.snapshot(); const { body } = await prepare(); expect(body.status).toBe(500); expect(await f.snapshot()).toEqual(before);
    // PostgreSQL SERIAL sequences are nontransactional: rollback proves rows,
    // not an invented promise that an attempted INSERT leaves no sequence gap.
  });
  it.each(['active', 'expired'] as const)('retains mature current presale conversion and %s window admission in the same atomic request', async mode => {
    const now = Math.floor(Date.now() / 1000);
    await f.db.update(storeProduct).set({ isPresaleProduct: 1, presaleStartTime: now - 3600,
      presaleEndTime: mode === 'active' ? now + 3600 : now - 10, presaleDay: 7 }).where(eq(storeProduct.id, 70));
    if (mode === 'active') { const { rows } = await fresh(); expect(rows.map(row => row.type)).toEqual([6, 0]); expect(rows.every(row => row.isNew === 1)).toBe(true); }
    else { const before = await f.snapshot(); const { response, body } = await prepare(); expect(response.status).toBeLessThan(500); expect(body.status).toBe(400); expect(body.msg).toContain('结束'); expect(await f.snapshot()).toEqual(before); }
  });
  it('waits on a current SKU before taking a product lock, allowing the mature SKU-then-product writer to complete', async () => {
    await f.withPeer!(async holder => f.withPeer!(async actor => {
      const [observer] = await f.db.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`); expect(new Set([observer.pid, holder.pid, actor.pid]).size).toBe(3);
      let unlock!: () => void, locked!: () => void; const ready = new Promise<void>(yes => locked = yes), release = new Promise<void>(yes => unlock = yes);
      const holding = withTx(createContainerFromDb(holder.db), async tx => {
        await tx.select().from(storeProductAttrValue).where(eq(storeProductAttrValue.productId, 70)).for('update'); locked(); await release;
        // NOWAIT would fail if repurchase held product SHARE while waiting for SKU.
        await tx.execute(sql`SELECT id FROM store_product WHERE id=70 FOR UPDATE NOWAIT`);
      });
      await ready; const pending = prepare(undefined, f.tokens.buyer, createContainerFromDb(actor.db));
      try { await waitForFinanceBlock(f.db, actor.pid, holder.pid); } finally { unlock(); }
      await holding; const { body } = await pending; expect(body.status, body.msg).toBe(200);
    }));
  }, 30000);
  it('rechecks ownership/deletion after an observed source-row lock wait before preparing any cart', async () => {
    await f.withPeer!(async holder => f.withPeer!(async actor => {
      const before = await f.db.select().from(storeCart);
      let unlock!: () => void, locked!: () => void; const ready = new Promise<void>(yes => locked = yes), release = new Promise<void>(yes => unlock = yes);
      const holding = withTx(createContainerFromDb(holder.db), async tx => { await tx.update(storeOrder).set({ isDel: 1 }).where(eq(storeOrder.id, f.ids.sourceOrder)); locked(); await release; });
      await ready; const pending = prepare(undefined, f.tokens.buyer, createContainerFromDb(actor.db));
      try { await waitForFinanceBlock(f.db, actor.pid, holder.pid); } finally { unlock(); }
      await holding; const { response, body } = await pending; expect(response.status).toBeLessThan(500); expect(body.status).toBe(404);
      expect(await f.db.select().from(storeCart)).toEqual(before);
    }));
  }, 30000);
});
