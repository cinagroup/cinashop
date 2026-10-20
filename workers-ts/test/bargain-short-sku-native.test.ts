import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { createApp } from '@/app';
import type { Container } from '@/lib/di';
import type { Env } from '@/env';
import { storeBargain, storeBargainUser, storeBargainUserHelp, storeCart, storeOrder, storeOrderCartInfo,
  storeProduct, storeProductAttrValue, systemRole, user, userBill } from '@/models/schema';
import { StoreOrderCreateService } from '@/services/order/StoreOrderCreateService';
import { ApiException } from '@/utils/errors';
import { bargainShortSkuFixture } from './helpers/bargainShortSku';
import { bargainShortSkuRuntimeFixture } from './helpers/bargainShortSkuRuntime';
import { outcome, waitForFinanceBlock } from './helpers/financePeers';

const wiring = vi.hoisted(() => ({ containers: new WeakMap<object, Container>(), opened: 0, closed: 0 }));
vi.mock('@/lib/di', async original => ({ ...await original<typeof import('@/lib/di')>(),
  createContainer: (env: object) => {
    const container = wiring.containers.get(env); if (!container) throw Error('Owned bargain App SQL missing'); return container;
  },
  createAdminDatabaseSession: (env: object) => {
    const container = wiring.containers.get(env); if (!container) throw Error('Owned bargain Admin SQL missing');
    wiring.opened++; return { container, close: async () => { wiring.closed++; } };
  },
}));

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('Bargain short base mounted Admin/JWT and synthetic-principal catalogue on owned PG16', () => {
  let close: (() => Promise<void>) | undefined;
  beforeEach(() => { close = undefined; vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Owned bargain reds forbid providers')); });
  afterEach(async () => { try { expect(fetch).not.toHaveBeenCalled(); } finally { try { await close?.(); } finally { vi.restoreAllMocks(); } } }, 30_000);
  const identity = { raw_unique: 'short7  ', storage_type: 'character', bytes: 8 };
  it('reads canonical short base keys from the actual Admin bargain SKU selector', async () => {
    const f = await bargainShortSkuFixture(); close = f.close; expect(await f.rawIdentity()).toEqual(identity);
    const before = await f.publicSnapshot(), sequences = await f.publicSequences();
    const { response, body } = await f.request('/adminapi/activity/bargain/sku-options?productId=70');
    expect(response.status).toBe(200); expect(body.status, body.msg).toBe(200);
    expect(await f.publicSnapshot()).toEqual(before); expect(await f.publicSequences()).toEqual(sequences);
    expect(body.data.options.find((row: { id: number }) => row.id === 1)).toMatchObject({ unique: 'short7', price: '18.88', suk: '红色,大号' });
  }, 120_000);
  it('saves an actual Admin bargain from a short ordinary base key', async () => {
    const f = await bargainShortSkuFixture(); close = f.close; expect(await f.rawIdentity()).toEqual(identity);
    const before = await f.publicSnapshot(), sequences = await f.publicSequences();
    const { response, body } = await f.request('/adminapi/activity/save', f.adminInput());
    expect(response.status).toBe(200);
    expect((await f.publicSnapshot()).store_product_attr_value.find((row: { id: number }) => row.id === 1))
      .toEqual(before.store_product_attr_value.find((row: { id: number }) => row.id === 1));
    if (body.status !== 200) { expect(await f.publicSnapshot()).toEqual(before); expect(await f.publicSequences()).toEqual(sequences); }
    expect(body.status, body.msg).toBe(200);
    const skus = await f.db.select().from(storeProductAttrValue).where(and(eq(storeProductAttrValue.productId, body.data.id), eq(storeProductAttrValue.type, 2)));
    expect(skus).toHaveLength(1); expect(skus[0]).toMatchObject({ suk: '红色,大号', stock: 6, quota: 5, price: '10.00' });
    expect(skus[0].unique).toMatch(/^[a-f0-9]{8}$/); expect(skus[0].unique).not.toBe('short7');
  }, 120_000);
  it('reads a short base through an independently bootstrapped bargain selection catalogue', async () => {
    const f = await bargainShortSkuFixture(); close = f.close; expect(await f.rawIdentity()).toEqual(identity);
    const before = await f.publicSnapshot(), sequences = await f.publicSequences();
    const response = await f.app.request('/api/bargain/detail/40?view=skus', {}, f.env);
    const body = await response.json<{ status: number; msg: string; data: any }>();
    expect(await f.publicSnapshot()).toEqual(before); expect(await f.publicSequences()).toEqual(sequences);
    expect(response.status).toBe(200); expect(body.status, body.msg).toBe(200);
    expect(body.data.participation).toBeNull(); expect(body.data.can_select).toBe(false);
    expect(body.data.skus.find((row: { unique: string }) => row.unique === 'actred40')).toMatchObject({ base_unique: 'short7', catalog_price: null });
  }, 120_000);
});

/** Full185 registered SQL. Actual JWT Admin/start/help/cart/quote/cancel use
 * owned maintenance connections; strict create/replay use verified LOGIN SQL.
 * The owner's real self-help and a friend's real JWT help produce ready,
 * without a random/ready stub. */
describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('Bargain short base complete App/JWT and independent LOGIN', () => {
  type Fixture = Awaited<ReturnType<typeof bargainShortSkuRuntimeFixture>>;
  type Writer = Parameters<Parameters<Fixture['withBargainRuntime']>[0]>[0];
  type Selection = { activityId: number; participantId: number; sku: typeof storeProductAttrValue.$inferSelect };
  const app = createApp();
  let f: Fixture | undefined;
  beforeEach(() => {
    f = undefined; wiring.opened = 0; wiring.closed = 0;
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Owned bargain full-chain forbids providers'));
  });
  afterEach(async () => {
    try {
      expect(fetch).not.toHaveBeenCalled(); expect(wiring.opened).toBe(wiring.closed);
      if (f) { expect(f.r2Reads).toEqual([]); expect(f.r2Writes).toEqual([]); expect(f.r2Deletes).toEqual([]); }
    } finally { try { await f?.close(); } finally { vi.restoreAllMocks(); } }
  }, 30_000);
  function fixture() { if (!f) throw Error('Owned full bargain fixture missing'); return f; }
  async function request(path: string, body?: object, identity: 'buyer' | 'helper' | 'admin' = 'buyer', method = body ? 'POST' : 'GET') {
    const f = fixture(), env: Env = { ...f.env }; wiring.containers.set(env, f.container);
    const token = identity === 'admin' ? f.adminToken : identity === 'helper' ? f.helperToken : f.token;
    const response = await app.request(path, { method, headers: { Authorization: 'Bearer ' + token,
      'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }, env);
    return { response, body: await response.json<{ status: number; msg: string; data: any }>() };
  }
  async function unchanged(before: Awaited<ReturnType<Fixture['snapshot']>>, sequences: Awaited<ReturnType<Fixture['sequences']>>) {
    expect(Object.keys(before)).toHaveLength(283); expect(sequences).toHaveLength(229);
    expect(await fixture().snapshot()).toEqual(before); expect(await fixture().sequences()).toEqual(sequences);
  }
  async function onlyOrderSequence(before: Awaited<ReturnType<Fixture['sequences']>>) {
    const after = await fixture().sequences(); expect(before).toHaveLength(229); expect(after).toHaveLength(229);
    for (const entry of before) if (entry.name !== 'store_order_id_seq') expect(after.find(row => row.name === entry.name), entry.name).toEqual(entry);
  }
  async function rejected(path: string, body: object | undefined, message: RegExp, identity: 'buyer' | 'helper' | 'admin' = 'buyer') {
    const before = await fixture().snapshot(), sequences = await fixture().sequences();
    const result = await request(path, body, identity);
    expect(result.response.status).toBeLessThan(500); expect(result.body.status).toBeGreaterThanOrEqual(400);
    expect(result.body.status).toBeLessThan(500); expect(result.body.msg).toMatch(message);
    await unchanged(before, sequences);
  }
  async function adminCurrent(activityId: number) {
    const result = await request('/adminapi/activity/bargain/sku-options?productId=70&activityId=' + activityId, undefined, 'admin');
    expect(result.body.status, result.body.msg).toBe(200); expect(result.body.data.current).toHaveLength(1);
    return result.body.data;
  }
  function resave(activityId: number, current: { id: number; unique: string; stock: number; quota: number }) {
    return { type: 'bargain', id: activityId, sku: { baseUnique: fixture().unique,
      expected: { id: current.id, unique: current.unique, stock: current.stock, quota: current.quota } } };
  }
  async function ready(activityId: number, identity: 'buyer' | 'helper' = 'buyer') {
    const owner = identity === 'buyer' ? 11 : 22, other = identity === 'buyer' ? 'helper' : 'buyer';
    const start = await request('/api/bargain/start', { bargain_id: activityId }, identity);
    expect(start.body.status, start.body.msg).toBe(200); const participantId = Number(start.body.data.id);
    expect(participantId).toBeGreaterThan(100); expect(participantId).not.toBe(activityId);
    const [initial] = await fixture().db.select().from(storeBargainUser).where(eq(storeBargainUser.id, participantId));
    expect(initial).toMatchObject({ uid: owner, bargainId: activityId, status: 1, price: '0.00' });
    const beforeRetry = await fixture().snapshot(), sequences = await fixture().sequences();
    expect((await request('/api/bargain/start', { bargain_id: activityId }, identity)).body).toMatchObject({ status: 200, data: { id: participantId } });
    await unchanged(beforeRetry, sequences);
    const self = await request('/api/bargain/help', { bargain_user_id: participantId }, identity);
    expect(self.body.status, self.body.msg).toBe(200); expect(Number(self.body.data.price)).toBeGreaterThan(0);
    const friend = await request('/api/bargain/help', { bargain_user_id: participantId }, other);
    expect(friend.body.status, friend.body.msg).toBe(200); expect(Number(friend.body.data.price)).toBeGreaterThan(0);
    const [record] = await fixture().db.select().from(storeBargainUser).where(eq(storeBargainUser.id, participantId));
    expect(record).toMatchObject({ uid: owner, bargainId: activityId, status: 3, bargainPrice: initial.bargainPrice,
      bargainPriceMin: initial.bargainPriceMin });
    expect(Math.round(Number(record.price) * 100)).toBe(Math.round((Number(initial.bargainPrice) - Number(initial.bargainPriceMin)) * 100));
    const helps = await fixture().db.select().from(storeBargainUserHelp).where(eq(storeBargainUserHelp.bargainUserId, participantId)).orderBy(storeBargainUserHelp.id);
    expect(helps).toHaveLength(2); expect(helps[0]).toMatchObject({ uid: owner, bargainId: activityId, type: 1 });
    expect(helps[1]).toMatchObject({ uid: owner === 11 ? 22 : 11, bargainId: activityId, type: 0 });
    expect(Math.round(helps.reduce((sum, row) => sum + Number(row.price), 0) * 100)).toBe(Math.round(Number(record.price) * 100));
    return participantId;
  }
  async function campaign(options: { unique?: string; ready?: boolean } = {}): Promise<Selection> {
    f = await bargainShortSkuRuntimeFixture({ unique: options.unique });
    const sourceBefore = await f.snapshot(), sourceSequences = await f.sequences();
    const source = await request('/adminapi/activity/bargain/sku-options?productId=70', undefined, 'admin');
    expect(source.body.status, source.body.msg).toBe(200);
    expect(source.body.data.options).toEqual([expect.objectContaining({ id: 1, unique: f.unique, price: '18.88' })]);
    await unchanged(sourceBefore, sourceSequences);
    const saved = await request('/adminapi/activity/save', f.adminInput(), 'admin');
    expect(saved.body.status, saved.body.msg).toBe(200); const activityId = Number(saved.body.data.id);
    const current = await adminCurrent(activityId), selected = current.current[0];
    expect(selected.unique).toMatch(/^[a-f0-9]{8}$/); expect(selected.unique).not.toBe(f.unique);
    const savedAgain = await request('/adminapi/activity/save', resave(activityId, selected), 'admin');
    expect(savedAgain.body.status, savedAgain.body.msg).toBe(200);
    expect((await adminCurrent(activityId)).current[0]).toMatchObject({ id: selected.id, unique: selected.unique });
    // An explicit owned maintenance edit separates activity-SKU price from both
    // Admin activity and base prices; the participation remains authoritative.
    await f.db.update(storeProductAttrValue).set({ price: '777.00' }).where(eq(storeProductAttrValue.id, selected.id));
    const [sku] = await f.db.select().from(storeProductAttrValue).where(eq(storeProductAttrValue.id, selected.id));
    const participantId = options.ready === false ? 0 : await ready(activityId);
    return { activityId, participantId, sku };
  }
  const addInput = (s: Selection) => ({ productId: 70, activityId: s.activityId, type: 2,
    unique: s.sku.unique, cartNum: 1, new: 1, bargainUserId: s.participantId });
  const quoteInput = (s: Selection, id: number) => ({ cartIds: [id], addressId: 11,
    useIntegral: false, type: 2, bargainUserId: s.participantId });
  const cataloguePath = (s: Selection) => '/api/bargain/detail/' + s.activityId + '?view=skus&bargain_user_id=' + s.participantId;
  async function added(s: Selection) {
    const result = await request('/api/cart/add', addInput(s)); expect(result.body.status, result.body.msg).toBe(200);
    return Number(result.body.data.cartId);
  }
  async function quoted(s: Selection, id: number, total = '2.00') {
    const before = await fixture().snapshot(), sequences = await fixture().sequences();
    const result = await request('/api/order/confirm', quoteInput(s, id)); expect(result.body.status, result.body.msg).toBe(200);
    expect(result.body.data.priceGroup).toMatchObject({ total_price: total, pay_price: total, pay_postage: '0.00' });
    await unchanged(before, sequences); return result.body.data;
  }
  function create(writer: Writer, s: Selection, id: number, receipt: any, nextOrderId = async () => 'owned_bargain_boundary') {
    return StoreOrderCreateService.createWithRuntime(writer.container,
      { CONFIG_KV: fixture().env.CONFIG_KV, requireConfirmation: true, requirePurchaseOrigin: true, nextOrderId },
      { uid: 11, key: receipt.orderKey, quoteToken: receipt.quoteToken, ...quoteInput(s, id), userIp: '127.0.0.1' });
  }
  it.each(['x', 'short7', 'qared001'])(
    'completes %s actual Admin, two real JWT helpers, raw-compatible LOGIN receipts, replay and exact once-only cancellation', async unique => {
      const s = await campaign({ unique }), f = fixture(), rawUnique = unique.padEnd(8, ' ');
      expect((await f.db.execute(sql`SELECT "unique" AS raw_unique,pg_typeof("unique")::text AS storage_type,
        octet_length("unique") AS bytes FROM store_product_attr_value WHERE id=1`))[0])
        .toEqual({ raw_unique: rawUnique, storage_type: 'character', bytes: 8 });
      const beforeCatalogue = await f.snapshot(), catalogueSequences = await f.sequences();
      const detail = await request(cataloguePath(s)); expect(detail.body.status, detail.body.msg).toBe(200);
      expect(detail.body.data).toMatchObject({ can_select: true, participation: { id: s.participantId, state: 'ready' } });
      expect(detail.body.data.skus).toEqual([expect.objectContaining({ unique: s.sku.unique, base_unique: unique, catalog_price: '2.00' })]);
      await unchanged(beforeCatalogue, catalogueSequences);
      const id = await added(s); expect(id).toBeGreaterThan(2);
      expect((await f.db.select().from(storeCart).where(eq(storeCart.id, id)))[0]).toMatchObject({ uid: 11,
        type: 2, activityId: s.activityId, bargainUserId: s.participantId, productAttrUnique: rawUnique, cartNum: 1, isNew: 1 });
      const changed = await request('/api/cart/num', { id, cartNum: 2 }); expect(changed.body.status, changed.body.msg).toBe(200);
      const beforeRead = await f.snapshot(), readSequences = await f.sequences();
      const list = await request('/api/cart/list?scope=buy&ids=' + id); expect(list.body.status, list.body.msg).toBe(200);
      expect(list.body.data).toEqual([expect.objectContaining({ id, cartNum: 2, isValid: true, truePrice: '2.00', bargainUserId: s.participantId })]);
      const shipping = await request('/api/order/check_shipping', { cartIds: [id], view: 'bargain' });
      expect(shipping.body.status, shipping.body.msg).toBe(200);
      expect(shipping.body.data).toMatchObject({ kind: 'bargain', activityId: s.activityId, shippingTypes: [1] });
      await unchanged(beforeRead, readSequences);
      let receipt = await quoted(s, id, '4.00');
      const beforeCompute = await f.snapshot(), computeSequences = await f.sequences();
      const computed = await request('/api/order/computed/' + encodeURIComponent(receipt.orderKey),
        { addressId: 11, type: 2, bargainUserId: s.participantId, useIntegral: false });
      expect(computed.body.status, computed.body.msg).toBe(200);
      expect(computed.body.data).toMatchObject({ total_price: '4.00', pay_price: '4.00', pay_postage: '0.00' });
      await unchanged(beforeCompute, computeSequences); receipt = computed.body.data;
      const [beforeProduct] = await f.db.select().from(storeProduct).where(eq(storeProduct.id, 70));
      const [beforeBase] = await f.db.select().from(storeProductAttrValue).where(eq(storeProductAttrValue.id, 1));
      const [beforeActivity] = await f.db.select().from(storeBargain).where(eq(storeBargain.id, s.activityId));
      const [beforeActivitySku] = await f.db.select().from(storeProductAttrValue).where(eq(storeProductAttrValue.id, s.sku.id));
      const [beforeParticipant] = await f.db.select().from(storeBargainUser).where(eq(storeBargainUser.id, s.participantId));
      const helps = await f.db.select().from(storeBargainUserHelp).orderBy(storeBargainUserHelp.id);
      const [beforeUser] = await f.db.select().from(user).where(eq(user.uid, 11));
      const nextOrderId = vi.fn(async () => 'owned_bargain_short_' + unique);
      let created: { orderId: string } | undefined;
      await f.withBargainRuntime(async writer => {
        if (unique === 'short7') await f.withPeer!(async holder => {
          const [observer] = await f.db.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`);
          expect(new Set([observer.pid, writer.pid, holder.pid]).size).toBe(3); await holder.exec('BEGIN');
          try {
            await holder.db.execute(sql`SELECT id FROM store_product_attr_value WHERE id=1 FOR UPDATE`);
            const pending = outcome(create(writer, s, id, receipt, nextOrderId));
            await waitForFinanceBlock(f.db, writer.pid, holder.pid);
            await holder.db.execute(sql`SELECT id FROM store_product WHERE id=70 FOR UPDATE NOWAIT`);
            await holder.exec('COMMIT'); const result = await pending;
            if (!result.ok) throw result.error; created = result.value;
          } finally { await holder.exec('ROLLBACK'); }
        }); else created = await create(writer, s, id, receipt, nextOrderId);
        const afterCreate = await f.snapshot(), createSequences = await f.sequences();
        const writes = [...f.kvWrites], deletes = [...f.kvDeletes];
        expect(await create(writer, s, id, receipt, nextOrderId)).toEqual(created); expect(nextOrderId).toHaveBeenCalledTimes(1);
        await unchanged(afterCreate, createSequences); expect(f.kvWrites).toEqual(writes); expect(f.kvDeletes).toEqual(deletes);
      });
      expect(created).toBeDefined();
      const [root] = await f.db.select().from(storeOrder).where(eq(storeOrder.orderId, created!.orderId));
      expect(root).toMatchObject({ uid: 11, type: 2, activityId: s.activityId, totalNum: 2, totalPrice: '4.00', payPrice: '4.00', paid: 0, pid: 0 });
      const lines = await f.db.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid, root.id));
      expect(lines).toHaveLength(1); expect(lines[0]).toMatchObject({ productId: 70, cartId: String(id), cartNum: 2, skuUnique: rawUnique });
      expect(JSON.parse(lines[0].cartInfo!)).toMatchObject({ sku: { id: 1, unique: rawUnique, price: '2.00' },
        activitySku: { id: s.sku.id, unique: s.sku.unique, price: '777.00' },
        bargainParticipation: { version: 1, participantId: s.participantId, activityId: s.activityId, uid: 11 } });
      const charged = { rowId: lines[0].id, cartId: String(id), productId: 70, skuId: 1, skuUnique: rawUnique, quantity: 2, usedPoints: 0 };
      const [origin] = await f.db.execute(sql`SELECT * FROM store_order_purchase_origin WHERE order_id=${root.id}`);
      const [physical] = await f.db.execute(sql`SELECT * FROM store_order_purchase_physical_origin WHERE order_id=${root.id}`);
      expect(origin).toMatchObject({ order_type: 2, buyer_id: 11, total_num: 2, lines: [charged] });
      expect(physical).toMatchObject({ order_type: 2, buyer_id: 11, total_num: 2, lines: [{ ...charged, kind: 'charged', gift: null }] });
      expect((await f.db.select().from(storeProduct).where(eq(storeProduct.id, 70)))[0]).toEqual({ ...beforeProduct, stock: beforeProduct.stock - 2, sales: beforeProduct.sales + 2 });
      expect((await f.db.select().from(storeProductAttrValue).where(eq(storeProductAttrValue.id, 1)))[0]).toEqual({ ...beforeBase, stock: beforeBase.stock - 2, sales: beforeBase.sales + 2 });
      expect((await f.db.select().from(storeBargain).where(eq(storeBargain.id, s.activityId)))[0]).toEqual({ ...beforeActivity, stock: beforeActivity.stock - 2, quota: beforeActivity.quota - 2, sales: beforeActivity.sales + 2 });
      expect((await f.db.select().from(storeProductAttrValue).where(eq(storeProductAttrValue.id, s.sku.id)))[0]).toEqual({ ...beforeActivitySku, stock: beforeActivitySku.stock - 2, quota: beforeActivitySku.quota - 2, sales: beforeActivitySku.sales + 2 });
      expect((await f.db.select().from(storeBargainUser).where(eq(storeBargainUser.id, s.participantId)))[0]).toEqual({ ...beforeParticipant, status: 4 });
      const cancelled = await request('/api/order/cancel', { order_id: root.orderId }); expect(cancelled.body.status, cancelled.body.msg).toBe(200);
      expect((await f.db.select().from(storeProduct).where(eq(storeProduct.id, 70)))[0]).toEqual(beforeProduct);
      expect((await f.db.select().from(storeProductAttrValue).where(eq(storeProductAttrValue.id, 1)))[0]).toEqual(beforeBase);
      expect((await f.db.select().from(storeBargain).where(eq(storeBargain.id, s.activityId)))[0]).toEqual(beforeActivity);
      expect((await f.db.select().from(storeProductAttrValue).where(eq(storeProductAttrValue.id, s.sku.id)))[0]).toEqual(beforeActivitySku);
      expect((await f.db.select().from(storeBargainUser).where(eq(storeBargainUser.id, s.participantId)))[0]).toEqual(beforeParticipant);
      expect(await f.db.select().from(storeBargainUserHelp).orderBy(storeBargainUserHelp.id)).toEqual(helps);
      expect((await f.db.select().from(user).where(eq(user.uid, 11)))[0]).toEqual(beforeUser); expect(await f.db.select().from(userBill)).toEqual([]);
      expect(await f.db.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid, root.id))).toEqual(lines);
      expect((await f.db.execute(sql`SELECT * FROM store_order_purchase_origin WHERE order_id=${root.id}`))[0]).toEqual(origin);
      expect((await f.db.execute(sql`SELECT * FROM store_order_purchase_physical_origin WHERE order_id=${root.id}`))[0]).toEqual(physical);
      const afterCancel = await f.snapshot(), cancelSequences = await f.sequences();
      await rejected('/api/order/cancel', { order_id: root.orderId }, /订单状态不允许取消/); await unchanged(afterCancel, cancelSequences);
    }, 120_000);

  it('keeps old short-SKU participation at two after real Admin repricing and prices a new real two-helper participation at five', async () => {
    const s = await campaign(), id = await added(s), originalQuote = await quoted(s, id), f = fixture();
    const [original] = await f.db.select().from(storeBargainUser).where(eq(storeBargainUser.id, s.participantId));
    const helps = await f.db.select().from(storeBargainUserHelp).where(eq(storeBargainUserHelp.bargainUserId, s.participantId));
    const edit = await request('/adminapi/activity/save', { type: 'bargain', id: s.activityId, price: '20.00', minPrice: '5.00' }, 'admin');
    expect(edit.body.status, edit.body.msg).toBe(200);
    const reread = await adminCurrent(s.activityId); expect(reread.current[0]).toMatchObject({ id: s.sku.id, unique: s.sku.unique, price: '777.00' });
    expect((await f.db.select().from(storeBargainUser).where(eq(storeBargainUser.id, s.participantId)))[0]).toEqual(original);
    const old = await request(cataloguePath(s)); expect(old.body.status, old.body.msg).toBe(200);
    expect(old.body.data).toMatchObject({ activity_price: '20.00', minimum_price: '5.00', participation: { id: s.participantId, state: 'ready' } });
    expect(old.body.data.skus[0].catalog_price).toBe('2.00'); await quoted(s, id);
    const newId = await ready(s.activityId, 'helper'); expect(newId).not.toBe(s.participantId);
    const fresh = await request('/api/bargain/detail/' + s.activityId + '?view=skus&bargain_user_id=' + newId, undefined, 'helper');
    expect(fresh.body.status, fresh.body.msg).toBe(200);
    expect(fresh.body.data).toMatchObject({ can_select: true, participation: { id: newId, state: 'ready' } });
    expect(fresh.body.data.skus[0].catalog_price).toBe('5.00');
    expect((await f.db.select().from(storeBargainUser).where(eq(storeBargainUser.id, newId)))[0])
      .toMatchObject({ uid: 22, bargainId: s.activityId, bargainPrice: '20.00', bargainPriceMin: '5.00', price: '15.00', status: 3 });
    await f.withBargainRuntime(async writer => {
      const made = await create(writer, s, id, originalQuote, async () => 'owned_bargain_frozen_participant');
      const [root] = await f.db.select().from(storeOrder).where(eq(storeOrder.orderId, made.orderId));
      expect(root).toMatchObject({ type: 2, activityId: s.activityId, payPrice: '2.00', totalPrice: '2.00' });
      const lines = await f.db.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid, root.id));
      expect(JSON.parse(lines[0].cartInfo!).bargainParticipation).toEqual({ version: 1, participantId: s.participantId, activityId: s.activityId, uid: 11 });
    });
    const cancelled = await request('/api/order/cancel', { order_id: 'owned_bargain_frozen_participant' }); expect(cancelled.body.status, cancelled.body.msg).toBe(200);
    expect((await f.db.select().from(storeBargainUser).where(eq(storeBargainUser.id, s.participantId)))[0]).toEqual(original);
    expect((await f.db.select().from(storeBargainUser).where(eq(storeBargainUser.id, newId)))[0]).toMatchObject({ uid: 22, status: 3, price: '15.00' });
    expect(await f.db.select().from(storeBargainUserHelp).where(eq(storeBargainUserHelp.bargainUserId, s.participantId))).toEqual(helps);
  }, 120_000);

  it('preserves a retained server-padded type2 cart and binds its exact real participant in strict receipts', async () => {
    const s = await campaign(), f = fixture();
    await f.db.update(storeCart).set({ type: 2, activityId: s.activityId, bargainUserId: s.participantId,
      productAttrUnique: 'short7  ', cartNum: 1 }).where(eq(storeCart.id, 1));
    const receipt = await quoted(s, 1);
    await f.withBargainRuntime(async writer => {
      const made = await create(writer, s, 1, receipt);
      const [root] = await f.db.select().from(storeOrder).where(eq(storeOrder.orderId, made.orderId));
      const lines = await f.db.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid, root.id));
      expect(lines).toHaveLength(1); expect(lines[0]).toMatchObject({ cartId: '1', cartNum: 1, skuUnique: 'short7  ' });
      expect(JSON.parse(lines[0].cartInfo!)).toMatchObject({ sku: { id: 1, unique: 'short7  ' },
        bargainParticipation: { version: 1, participantId: s.participantId, activityId: s.activityId, uid: 11 } });
      expect((await f.db.execute(sql`SELECT * FROM store_order_purchase_origin WHERE order_id=${root.id}`))[0])
        .toMatchObject({ order_type: 2, total_num: 1, lines: [expect.objectContaining({ skuUnique: 'short7  ', quantity: 1 })] });
      expect((await f.db.execute(sql`SELECT * FROM store_order_purchase_physical_origin WHERE order_id=${root.id}`))[0])
        .toMatchObject({ order_type: 2, total_num: 1, lines: [expect.objectContaining({ skuUnique: 'short7  ', quantity: 1, kind: 'charged' })] });
    });
    expect((await f.db.select().from(storeCart).where(eq(storeCart.id, 1)))[0]).toMatchObject({ productAttrUnique: 'short7  ', isPay: 1 });
  }, 120_000);

  it.each(['        ', ' short7', 'short7\t', 'short7\n'])(
    'rejects malformed DB base identity %j through real Admin and public selection', async unique => {
      const s = await campaign(), f = fixture();
      await f.db.update(storeProductAttrValue).set({ unique }).where(eq(storeProductAttrValue.id, 1));
      await rejected('/adminapi/activity/save', resave(s.activityId, s.sku), /规格|基础|标识/, 'admin');
      await rejected(cataloguePath(s), undefined, /规格|基础|标识/);
    }, 120_000);

  it.each(['foreign product', 'wrong type', 'retired', 'missing'] as const)(
    'rejects a current %s base through Admin, catalogue, add and retained confirmation without price fallback', async mode => {
      const s = await campaign(), id = await added(s), f = fixture();
      if (mode === 'missing') await f.db.delete(storeProductAttrValue).where(eq(storeProductAttrValue.id, 1));
      else await f.db.update(storeProductAttrValue).set(mode === 'foreign product' ? { productId: 71 }
        : mode === 'wrong type' ? { type: 3 } : { isRetired: 1 }).where(eq(storeProductAttrValue.id, 1));
      await rejected('/adminapi/activity/save', resave(s.activityId, s.sku), /规格|基础|标识/, 'admin');
      await rejected(cataloguePath(s), undefined, /规格|基础|标识/);
      await rejected('/api/cart/add', addInput(s), /规格|商品|失效/);
      await rejected('/api/order/confirm', quoteInput(s, id), /规格|商品|失效/);
    }, 120_000);

  it.each(['base unique', 'base SUK'] as const)(
    'rejects current duplicate %s on both actual activity-key add and retained raw-base confirmation', async mode => {
      const s = await campaign(), id = await added(s), f = fixture();
      const [base] = await f.db.select().from(storeProductAttrValue).where(eq(storeProductAttrValue.id, 1));
      await f.db.insert(storeProductAttrValue).values({ ...base, id: 900,
        unique: mode === 'base unique' ? base.unique : 'DUPKEY01', suk: mode === 'base SUK' ? base.suk : 'Other combination' });
      const before = await f.snapshot(), sequences = await f.sequences();
      const catalogue = await request(cataloguePath(s));
      const add = await request('/api/cart/add', addInput(s));
      const confirm = await request('/api/order/confirm', quoteInput(s, id));
      process.stdout.write('BARGAIN_SHORT_CURRENT_IDENTITY_OBSERVED ' + JSON.stringify({ mode,
        catalogue_status: catalogue.body.status, add_status: add.body.status, confirm_status: confirm.body.status }) + '\n');
      for (const result of [catalogue, add, confirm]) {
        expect(result.response.status).toBeLessThan(500); expect(result.body.status).toBeGreaterThanOrEqual(400);
        expect(result.body.status).toBeLessThan(500); expect(result.body.msg).toMatch(/规格|标识|组合|唯一|重复|冲突/);
      }
      await unchanged(before, sequences);
    }, 120_000);

  it('rejects a current activity/base namespace collision even through a retained raw-base cart', async () => {
    const s = await campaign(), id = await added(s), f = fixture();
    const [base] = await f.db.select().from(storeProductAttrValue).where(eq(storeProductAttrValue.id, 1));
    await f.db.insert(storeProductAttrValue).values({ ...base, id: 900, unique: s.sku.unique, suk: 'Other combination' });
    const before = await f.snapshot(), sequences = await f.sequences();
    const catalogue = await request(cataloguePath(s));
    const add = await request('/api/cart/add', addInput(s));
    const confirm = await request('/api/order/confirm', quoteInput(s, id));
    process.stdout.write('BARGAIN_SHORT_CURRENT_IDENTITY_OBSERVED ' + JSON.stringify({ mode: 'crossnamespace',
      catalogue_status: catalogue.body.status, add_status: add.body.status, confirm_status: confirm.body.status }) + '\n');
    for (const result of [catalogue, add, confirm]) {
      expect(result.response.status).toBeLessThan(500); expect(result.body.status).toBeGreaterThanOrEqual(400);
      expect(result.body.status).toBeLessThan(500); expect(result.body.msg).toMatch(/规格|标识|组合|唯一|重复|冲突/);
    }
    await unchanged(before, sequences);
  }, 120_000);

  it.each(['anonymous', 'customer token', 'view-only role'] as const)(
    'rejects actual Admin writes for %s without opening a maintenance Admin session', async mode => {
      f = await bargainShortSkuRuntimeFixture(); const env: Env = { ...f.env }; wiring.containers.set(env, f.container);
      if (mode === 'view-only role') await f.db.update(systemRole).set({ rules: 'activity.view' }).where(eq(systemRole.id, f.adminRoleId));
      const before = await f.snapshot(), sequences = await f.sequences();
      const token = mode === 'anonymous' ? '' : mode === 'customer token' ? f.token : f.adminToken;
      const result = await app.request('/adminapi/activity/save', { method: 'POST', headers: { Authorization: 'Bearer ' + token,
        'content-type': 'application/json' }, body: JSON.stringify(f.adminInput()) }, env);
      const body = await result.json<{ status: number; msg: string }>();
      expect(body.status).not.toBe(200); expect(result.status).toBeLessThan(500); expect(body.msg).toMatch(/权限|登录/);
      expect(wiring.opened).toBe(0); await unchanged(before, sequences);
    }, 120_000);

  it('keeps a real cutting participant unbuyable until both real helpers finish', async () => {
    const s = await campaign({ ready: false }), f = fixture();
    const started = await request('/api/bargain/start', { bargain_id: s.activityId }); expect(started.body.status, started.body.msg).toBe(200);
    s.participantId = Number(started.body.data.id);
    const self = await request('/api/bargain/help', { bargain_user_id: s.participantId }); expect(self.body.status, self.body.msg).toBe(200);
    const before = await f.snapshot(), sequences = await f.sequences();
    const detail = await request(cataloguePath(s)); expect(detail.body.status, detail.body.msg).toBe(200);
    expect(detail.body.data).toMatchObject({ can_select: false, participation: { id: s.participantId, state: 'cutting' } });
      await rejected('/api/cart/add', addInput(s), /未.*完成|未成功|未砍|参与|最低价/); await unchanged(before, sequences);
  }, 120_000);

  it.each(['foreign owner', 'used participant', 'wrong activity'] as const)(
    'refuses exact participant %s at new add and bound confirmation without a namespace fallback', async mode => {
      const s = await campaign(), id = await added(s), f = fixture();
      await f.db.update(storeBargainUser).set(mode === 'foreign owner' ? { uid: 22 }
        : mode === 'used participant' ? { status: 4 } : { bargainId: s.activityId + 1000 }).where(eq(storeBargainUser.id, s.participantId));
      await rejected('/api/cart/add', addInput(s), /参与|记录|砍价|完成/);
      await rejected('/api/order/confirm', quoteInput(s, id), /参与|记录|砍价|完成|立即购买商品或规格已失效，请重新选择/);
    }, 120_000);

  it('refuses participant-ID substitution while an explicit bound short-SKU participation remains selectable amid ambiguity', async () => {
    const s = await campaign(), id = await added(s), f = fixture();
    const [original] = await f.db.select().from(storeBargainUser).where(eq(storeBargainUser.id, s.participantId));
    await f.db.insert(storeBargainUser).values({ ...original, id: 900 });
    await rejected('/api/cart/add', { ...addInput(s), bargainUserId: undefined }, /不唯一|参与记录/);
    await rejected('/api/order/confirm', { ...quoteInput(s, id), bargainUserId: 900 }, /参与|记录|不匹配/);
    // An activity ID must not silently select a coincident participation ID.
    await rejected('/api/order/confirm', { ...quoteInput(s, id), bargainUserId: s.activityId }, /参与|记录|不匹配/);
    await quoted(s, id);
  }, 120_000);

  it('rolls back a strict author when the frozen participant quote changes at the real next-order-id boundary', async () => {
    const s = await campaign(), id = await added(s), receipt = await quoted(s, id), f = fixture();
    let edited: Awaited<ReturnType<Fixture['snapshot']>> | undefined;
    let editedSequences: Awaited<ReturnType<Fixture['sequences']>> | undefined;
    await f.withBargainRuntime(async writer => {
      const result = await outcome(create(writer, s, id, receipt, async () => {
        await f.db.update(storeBargainUser).set({ bargainPrice: '20.00', bargainPriceMin: '5.00', price: '15.00' })
          .where(eq(storeBargainUser.id, s.participantId));
        edited = await f.snapshot(); editedSequences = await f.sequences(); return 'owned_stale_bargain_participant';
      }));
      expect(edited).toBeDefined(); expect(result.ok).toBe(false);
      if (!result.ok) { expect(result.error).toBeInstanceOf(ApiException); expect(result.error.message).toMatch(/参与报价已变化|报价|重新确认/); }
    });
    expect(await f.snapshot()).toEqual(edited!); await onlyOrderSequence(editedSequences!);
  }, 120_000);

  it('rejects committed sold-out base stock after a genuine independent SKU wait and leaves the participation ready', async () => {
    const s = await campaign(), id = await added(s), receipt = await quoted(s, id), f = fixture();
    const before = await f.snapshot(), sequences = await f.sequences();
    const skus = await f.db.select().from(storeProductAttrValue).orderBy(storeProductAttrValue.id);
    await f.withBargainRuntime(async writer => f.withPeer!(async holder => {
      const [observer] = await f.db.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`);
      expect(new Set([observer.pid, writer.pid, holder.pid]).size).toBe(3); await holder.exec('BEGIN');
      try {
        await holder.db.execute(sql`SELECT id FROM store_product_attr_value WHERE id=1 FOR UPDATE`);
        await holder.db.update(storeProductAttrValue).set({ stock: 0 }).where(eq(storeProductAttrValue.id, 1));
        const pending = outcome(create(writer, s, id, receipt)); await waitForFinanceBlock(f.db, writer.pid, holder.pid);
        await holder.exec('COMMIT'); const result = await pending; expect(result.ok).toBe(false);
        if (!result.ok) { expect(result.error).toBeInstanceOf(ApiException); expect(result.error.message).toMatch(/库存|变化|不足/); }
      } finally { await holder.exec('ROLLBACK'); }
    }));
    const after = await f.snapshot();
    for (const table of Object.keys(before)) if (table !== 'store_product_attr_value') expect(after[table], table).toEqual(before[table]);
    expect(await f.db.select().from(storeProductAttrValue).orderBy(storeProductAttrValue.id))
      .toEqual(skus.map(row => row.id === 1 ? { ...row, stock: 0 } : row));
    await onlyOrderSequence(sequences);
  }, 120_000);

  it.each(['base unique', 'base SUK'] as const)(
    'rejects late duplicate %s after a proven independent base-SKU wait in genuine LOGIN creation', async mode => {
      const s = await campaign(), id = await added(s), receipt = await quoted(s, id), f = fixture();
      const before = await f.snapshot(), sequences = await f.sequences();
      const skus = await f.db.select().from(storeProductAttrValue).orderBy(storeProductAttrValue.id), base = skus.find(row => row.id === 1)!;
      const duplicate = { ...base, id: 900, unique: mode === 'base unique' ? base.unique : 'DUPKEY01',
        suk: mode === 'base SUK' ? base.suk : 'Other combination' };
      await f.withBargainRuntime(async writer => f.withPeer!(async holder => {
        const [observer] = await f.db.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`);
        expect(new Set([observer.pid, holder.pid, writer.pid]).size).toBe(3); await holder.exec('BEGIN');
        try {
          await holder.db.execute(sql`SELECT id FROM store_product_attr_value WHERE id=1 FOR UPDATE`);
          await holder.db.insert(storeProductAttrValue).values(duplicate);
          const pending = outcome(create(writer, s, id, receipt, async () => 'owned_late_bargain_' + (mode === 'base unique' ? 'unique' : 'suk')));
          await waitForFinanceBlock(f.db, writer.pid, holder.pid);
          await holder.db.execute(sql`SELECT id FROM store_product WHERE id=70 FOR UPDATE NOWAIT`);
          await holder.exec('COMMIT'); const result = await pending;
          const after = await f.snapshot(), afterSequences = await f.sequences();
          const changedTables = Object.keys(before).filter(table => JSON.stringify(before[table]) !== JSON.stringify(after[table]));
          const changedSequences = sequences.filter(row => JSON.stringify(afterSequences.find(entry => entry.name === row.name)) !== JSON.stringify(row)).map(row => row.name);
          process.stdout.write('BARGAIN_SHORT_BASE_WAIT_OBSERVED ' + JSON.stringify({ mode, observer_pid: observer.pid,
            writer_pid: writer.pid, holder_pid: holder.pid, actual_blocking_gate_passed: true,
            holder_committed_duplicate: true, create_succeeded: result.ok, error_name: result.ok ? null : result.error.name,
            changed_tables: changedTables, changed_sequences: changedSequences,
            order_rows: (after.store_order as unknown[]).length, origin_rows: (after.store_order_purchase_origin as unknown[]).length,
            physical_rows: (after.store_order_purchase_physical_origin as unknown[]).length }) + '\n');
          expect(result.ok).toBe(false);
          if (!result.ok) { expect(result.error).toBeInstanceOf(ApiException); expect(result.error.message).toMatch(/规格|标识|组合|唯一|重复|变化/); }
          expect(changedTables).toEqual(['store_product_attr_value']); expect(changedSequences.every(name => name === 'store_order_id_seq')).toBe(true);
        } finally { await holder.exec('ROLLBACK'); }
      }));
      const after = await f.snapshot();
      for (const table of Object.keys(before)) if (table !== 'store_product_attr_value') expect(after[table], table).toEqual(before[table]);
      expect(await f.db.select().from(storeProductAttrValue).orderBy(storeProductAttrValue.id)).toEqual([...skus, duplicate]);
    }, 120_000);

  it('keeps cumulative base history incomplete in actual confirmation and strict LOGIN author', async () => {
    const s = await campaign(), id = await added(s), receipt = await quoted(s, id), f = fixture();
    await f.db.update(storeProduct).set({ isLimit: 1, limitType: 2, limitNum: 10 }).where(eq(storeProduct.id, 70));
    const before = await f.snapshot(), sequences = await f.sequences();
    await rejected('/api/order/confirm', quoteInput(s, id), /累计|历史/);
    await f.withBargainRuntime(async writer => {
      const result = await outcome(create(writer, s, id, receipt)); expect(result.ok).toBe(false);
      if (!result.ok) { expect(result.error).toBeInstanceOf(ApiException); expect(result.error.message).toMatch(/累计|历史/); }
    });
    await unchanged(before, sequences);
  }, 120_000);
});
