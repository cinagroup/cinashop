import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createApp } from '@/app';
import { createContainerFromDb, withTx, type Container } from '@/lib/di';
import type { Env } from '@/env';
import { storeOrder, storeOrderCartInfo, storeOrderRefund } from '@/models/schema';
import { lockOrderSettlement } from '@/services/order/OrderBrokerageService';
import { readRefundQuantityReservation } from '@/services/order/RefundQuantityReservation';
import { customerRefundQuantitiesFixture } from './helpers/customerRefundQuantities';
import { waitForFinanceBlock } from './helpers/financePeers';

// Bind each real App request to its own connection. This also allows two actual
// HTTP applications to wait on independently observed PostgreSQL backend PIDs.
const wiring = vi.hoisted(() => ({ containers: new WeakMap<object, Container>() }));
vi.mock('@/lib/di', async original => ({ ...await original<typeof import('@/lib/di')>(), createContainer: (env: object) => {
  const container = wiring.containers.get(env); if (!container) throw Error('Missing owned quantity App boundary'); return container;
} }));
const app = createApp();
type Envelope = { status: number; msg: string; data: any };
const bearer = (token: string) => ({ Authorization: 'Bearer ' + token });

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('Customer explicit refund quantities actual App JWT owned PG16', () => {
  let f: Awaited<ReturnType<typeof customerRefundQuantitiesFixture>>;
  beforeEach(async () => {
    f = await customerRefundQuantitiesFixture();
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Owned refund quantity acceptance forbids provider dispatch'));
  }, 30000);
  afterEach(async () => {
    try { expect(fetch).not.toHaveBeenCalled(); }
    finally { vi.restoreAllMocks(); await f?.close(); }
  }, 30000);

  function request(path: string, init: RequestInit = {}, container = f.container) {
    const env: Env = { ...f.env }; wiring.containers.set(env, container);
    return app.request(path, init, env);
  }
  function input(quantity: unknown = 1) {
    return { refundReason: '按商品件数申请退款', refundExplain: '实际买家数量合同', applyType: 1,
      cart_ids: [{ cart_id: f.selected.id, cart_num: quantity }] };
  }
  async function apply(value: unknown = input(), token: string | null = f.tokens.buyer, container = f.container) {
    return (await request('/api/order/refund/apply/' + f.ids.sourceOrder, { method: 'POST', headers: {
      ...(token === null ? {} : bearer(token)), 'content-type': 'application/json' }, body: JSON.stringify(value) }, container)).json<Envelope>();
  }
  async function stored(id: number) { return (await f.db.select().from(storeOrderRefund).where(eq(storeOrderRefund.id, id)))[0]; }
  async function carts() { return f.db.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid, f.ids.sourceOrder)).orderBy(storeOrderCartInfo.id); }
  async function noWrites(work: () => Promise<Envelope>, expectedStatus = 400) {
    const before = await f.snapshot(), sequences = await f.sequences(), writes = f.r2Writes.length, deletes = f.r2Deletes.length;
    const result = await work(); expect(result.status, result.msg).toBe(expectedStatus);
    expect(await f.snapshot()).toEqual(before); expect(await f.sequences()).toEqual(sequences);
    expect(f.r2Writes).toHaveLength(writes); expect(f.r2Deletes).toHaveLength(deletes); return result;
  }
  async function upload() {
    const form = new FormData(); form.append('file', new File([f.png], 'quantity-original.png', { type: 'image/png' })); form.append('pid', '0');
    const encoded = new Request('https://owned.invalid', { method: 'POST', body: form }), body = await encoded.arrayBuffer();
    const result = await (await request('/api/upload/image', { method: 'POST', headers: { ...bearer(f.tokens.buyer),
      'content-type': encoded.headers.get('content-type')!, 'content-length': String(body.byteLength) }, body })).json<Envelope>();
    expect(result.status, result.msg).toBe(200); expect(f.r2Writes).toHaveLength(1); return result.data as { url: string; src: string; att_id: number };
  }
  function claim(row: Awaited<ReturnType<typeof stored>>, quantity: number, before = 0) {
    expect(row).toMatchObject({ uid: 11, storeOrderId: f.ids.sourceOrder, refundNum: quantity, refundType: 0, isCancel: 0 });
    expect(readRefundQuantityReservation(row)).toEqual({ version: 'refund-quantity-reservation-v1', orderId: f.ids.sourceOrder, uid: 11,
      items: [{ rowId: f.selected.id, cartId: Number(f.selected.cartId), cartNum: quantity, beforeRefundNum: before, totalNum: 2 }] });
  }
  async function readOwned(id: number, quantity: number, image?: string, returnImagesUnavailable = false) {
    return f.withCustomerReader(async peer => {
      const [rights] = await peer.db.execute(sql`SELECT current_user=session_user AS independent,
        has_table_privilege(current_user,'user','SELECT') AS authenticates,
        has_table_privilege(current_user,'user','UPDATE') AS user_updates,
        has_table_privilege(current_user,'store_order_refund','UPDATE') AS refund_updates,
        has_table_privilege(current_user,'system_attachment','INSERT') AS attachment_inserts,
        has_schema_privilege(current_user,'public','CREATE') AS creates`);
      expect(rights).toEqual({ independent: true, authenticates: true, user_updates: false, refund_updates: false, attachment_inserts: false, creates: false });
      async function get(path: string, token: string) {
        const before = await f.snapshot(), sequences = await f.sequences(), writes = f.r2Writes.length, deletes = f.r2Deletes.length;
        expect(Object.keys(before)).toHaveLength(283); expect(sequences).toHaveLength(229);
        const response = await request(path, { headers: bearer(token) }, peer.container), body = await response.json<Envelope>();
        expect(body.status, body.msg).toBe(200); expect(response.headers.get('Cache-Control')).toContain('no-store');
        expect(await f.snapshot()).toEqual(before); expect(await f.sequences()).toEqual(sequences);
        expect(f.r2Writes).toHaveLength(writes); expect(f.r2Deletes).toHaveLength(deletes); return body.data;
      }
      const customer = await get('/api/order/refund/detail/' + id + '?view=customer', f.tokens.buyer);
      expect(customer).toMatchObject({ id, uid: 11, refundNum: quantity, itemsError: '', requestImagesError: '',
        returnImagesError: returnImagesUnavailable ? '退货凭证暂不可读取，请联系商家核对' : '', returnImages: [] });
      expect(customer.items).toEqual([expect.objectContaining({ id: f.selected.id, quantity })]);
      expect(customer.items[0]).not.toHaveProperty('ordered');
      const supplier = await get('/supplierapi/refund/detail/' + id, f.tokens.viewer);
      expect(supplier).toMatchObject({ id, refund_num: quantity, requestImagesError: '', returnImages: [],
        returnImagesError: returnImagesUnavailable ? '退货凭证暂不可读取，请与用户核对' : '' });
      expect(supplier.application_review).toMatchObject({ state: 'recorded', basis: 'quantity_claim', error: '',
        items: [expect.objectContaining({ row_id: f.selected.id, quantity })] });
      expect(supplier.application_review.items).toHaveLength(1);
      await get('/api/order/refund/list?view=customer', f.tokens.buyer);
      await get('/supplierapi/refund/list', f.tokens.viewer);
      for (const detail of [customer, supplier]) {
        if (!image) { expect(detail.requestImages).toEqual([]); continue; }
        expect(detail.requestImages).toEqual([{ url: image, src: expect.stringContaining(image + '?expires=') }]);
        const before = await f.snapshot(), sequences = await f.sequences(), writes = f.r2Writes.length, deletes = f.r2Deletes.length;
        const asset = await request(detail.requestImages[0].src, {}, peer.container); expect(asset.status).toBe(200);
        expect(asset.headers.get('Cache-Control')).toContain('private, no-store');
        expect([...new Uint8Array(await asset.arrayBuffer())]).toEqual([...f.png]);
        expect(await f.snapshot()).toEqual(before); expect(await f.sequences()).toEqual(sequences);
        expect(f.r2Writes).toHaveLength(writes); expect(f.r2Deletes).toHaveLength(deletes);
      }
      return { customer, supplier };
    });
  }

  it('requests 1 of an actual checkout quantity 2, keeps the other line and finances unchanged, and reads the same uploaded original as both actors', async () => {
    const image = await upload(), before = await f.snapshot(), sequences = await f.sequences();
    const result = await apply({ ...input(), refundImg: JSON.stringify([image.url]) }); expect(result.status, result.msg).toBe(200);
    const row = await stored(result.data.refundId); claim(row, 1); expect(row.refundPrice).toBe('12.80'); expect(row.refundImg).toBe(JSON.stringify([image.url]));
    expect(row.refundGoodsImg).toBeNull();
    const current = await carts(); expect(current.find(row => row.id === f.selected.id)).toEqual({ ...f.selected, refundNum: 1 });
    expect(current.find(row => row.id === f.unselected.id)).toEqual(f.unselected);
    const after = await f.snapshot();
    for (const name of Object.keys(before)) if (!['store_order_cart_info', 'store_order_refund', 'store_order_status'].includes(name)) expect(after[name], name).toEqual(before[name]);
    const nextSequences = await f.sequences();
    for (const entry of sequences) if (!['store_order_refund_id_seq', 'store_order_status_id_seq'].includes(entry.name)) expect(nextSequences.find(row => row.name === entry.name), entry.name).toEqual(entry);
    const detail = await readOwned(row.id, 1, image.url); expect(detail.customer.refundPrice).toBe('12.80'); expect(detail.supplier.refund_price).toBe('12.80');
    expect(f.r2Writes).toHaveLength(1); expect(f.r2Reads).toHaveLength(2); expect(f.r2Deletes).toEqual([]);
  }, 120000);

  it('preserves known empty SQL NULL, old empty text and [] return images while malformed or oversized return evidence cannot erase the original image or selected quantity', async () => {
    const image = await upload(), result = await apply({ ...input(), refundImg: JSON.stringify([image.url]) });
    expect(result.status, result.msg).toBe(200); expect((await stored(result.data.refundId)).refundGoodsImg).toBeNull();
    const cases = [{ raw: null, unavailable: false }, { raw: '', unavailable: false }, { raw: '[]', unavailable: false },
      { raw: '[broken', unavailable: true }, { raw: 'x'.repeat(8193), unavailable: true }];
    for (const { raw, unavailable } of cases) {
      // This exact stored-field variation is fixture maintenance; every actual
      // Customer/Supplier/asset GET gets its own full no-write assertion.
      await f.db.update(storeOrderRefund).set({ refundGoodsImg: raw }).where(eq(storeOrderRefund.id, result.data.refundId));
      await readOwned(result.data.refundId, 1, image.url, unavailable);
      claim(await stored(result.data.refundId), 1);
    }
    expect(f.r2Writes).toHaveLength(1); expect(f.r2Reads).toHaveLength(cases.length * 2); expect(f.r2Deletes).toEqual([]);
  }, 120000);

  it('actual Customer cancellation releases exactly 1 and a new explicit quantity 2 reuses it without settlement', async () => {
    const first = await apply(); expect(first.status, first.msg).toBe(200); claim(await stored(first.data.refundId), 1);
    const beforeCancel = await f.snapshot();
    const cancelled = await (await request('/api/order/refund/cancel/' + first.data.refundId, { method: 'POST', headers: bearer(f.tokens.buyer) })).json<Envelope>();
    expect(cancelled.status, cancelled.msg).toBe(200); expect((await stored(first.data.refundId)).isCancel).toBe(1);
    expect(await carts()).toEqual(f.carts);
    const afterCancel = await f.snapshot();
    for (const name of Object.keys(beforeCancel)) if (!['store_order_cart_info', 'store_order_refund', 'store_order_status'].includes(name)) expect(afterCancel[name], name).toEqual(beforeCancel[name]);
    const second = await apply(input(2)); expect(second.status, second.msg).toBe(200); expect(second.data.refundId).not.toBe(first.data.refundId);
    const row = await stored(second.data.refundId); claim(row, 2); expect(row.refundPrice).toBe('25.60');
    expect((await carts()).find(row => row.id === f.selected.id)?.refundNum).toBe(2); await readOwned(row.id, 2);
  }, 120000);

  it('accepts two explicit physical row selections without silently replacing the first quantity with its purchased total', async () => {
    const result = await apply({ ...input(), cart_ids: [{ cart_id: f.selected.id, cart_num: 1 }, { cart_id: f.unselected.id, cart_num: 1 }] });
    expect(result.status, result.msg).toBe(200); const row = await stored(result.data.refundId); expect(row.refundNum).toBe(2);
    expect(readRefundQuantityReservation(row)?.items.map(item => ({ rowId: item.rowId, cartNum: item.cartNum, totalNum: item.totalNum }))).toEqual(
      f.carts.map(cart => ({ rowId: cart.id, cartNum: 1, totalNum: cart.cartNum })));
    expect((await carts()).map(row => row.refundNum)).toEqual([1, 1]);
  });

  it('retains the existing implicit cartIds contract for the selected line remaining quantity', async () => {
    const result = await apply({ refundReason: '旧客户端选择合同', applyType: 1, cartIds: [f.selected.id] }); expect(result.status, result.msg).toBe(200);
    claim(await stored(result.data.refundId), 2); expect((await carts()).find(row => row.id === f.unselected.id)).toEqual(f.unselected);
  });

  it.each([
    { name: 'missing', quantity: undefined }, { name: 'zero', quantity: 0 }, { name: 'negative', quantity: -1 },
    { name: 'fractional', quantity: 1.5 }, { name: 'larger than purchased', quantity: 3 },
    { name: 'unsafe integer', quantity: Number.MAX_SAFE_INTEGER + 1 }, { name: 'nonnumeric', quantity: 'NaN' }, { name: 'null', quantity: null },
  ])('rejects explicit $name quantity through actual JWT HTTP before any table, sequence or object write', async ({ quantity }) => {
    const value = input(1); (value.cart_ids[0] as { cart_num?: unknown }).cart_num = quantity;
    await noWrites(() => apply(value));
  });

  it.each(['zero', 'negative', 'foreign', 'duplicate'] as const)('rejects %s physical row selections atomically', async mode => {
    let foreignId = 0;
    if (mode === 'foreign') {
      // Negative-case fixture maintenance creates a genuinely stored line of
      // another Customer/order, rather than mistaking a missing ID for one.
      const [other] = await f.db.insert(storeOrder).values({ uid: 22, orderId: 'owned_quantity_foreign', supplierId: 7, paid: 1 }).returning({ id: storeOrder.id });
      const [foreign] = await f.db.insert(storeOrderCartInfo).values({ ...f.selected, id: undefined,
        oid: other.id, uid: 22, cartId: 'owned-quantity-foreign' }).returning({ id: storeOrderCartInfo.id });
      foreignId = foreign.id;
      expect(f.carts.flatMap(row => [row.id, Number(row.cartId)])).not.toContain(foreignId);
    }
    const cart_ids = mode === 'duplicate' ? [{ cart_id: f.selected.id, cart_num: 1 }, { cart_id: f.selected.id, cart_num: 1 }]
      : [{ cart_id: mode === 'zero' ? 0 : mode === 'negative' ? -1 : foreignId, cart_num: 1 }];
    const result = await noWrites(() => apply({ ...input(), cart_ids }));
    if (mode === 'foreign') expect(result.msg).toContain('不属于当前订单');
  });

  it.each(['unauthenticated', 'another real Customer'] as const)('rejects %s before quantity reservation', async mode => {
    await noWrites(() => apply(input(), mode === 'unauthenticated' ? null : f.tokens.foreignBuyer), mode === 'unauthenticated' ? 410000 : 400);
  });

  it('rejects a stale larger intent after another actual application reserved one unit', async () => {
    const first = await apply(); expect(first.status, first.msg).toBe(200);
    const stale = await noWrites(() => apply(input(2))); expect(stale.msg).toContain('进行中');
    claim(await stored(first.data.refundId), 1); expect((await carts()).find(row => row.id === f.selected.id)?.refundNum).toBe(1);
  });

  it('fails closed for an isolated stale counter with no active application instead of over-reserving it', async () => {
    // Deliberate inconsistent historical counter, not a claim created by SQL.
    await f.db.update(storeOrderCartInfo).set({ refundNum: 1 }).where(eq(storeOrderCartInfo.id, f.selected.id));
    const stale = await noWrites(() => apply(input(2))); expect(stale.msg).toBe('拆单财务快照不一致，请先核对订单');
  });

  it('keeps ordinary legacy row/cart aliases ambiguous rather than exposing privileged row-only selection', async () => {
    await f.db.update(storeOrderCartInfo).set({ cartId: String(f.unselected.id) }).where(eq(storeOrderCartInfo.id, f.selected.id));
    const result = await noWrites(() => apply(input())); expect(result.msg).toContain('歧义');
  });

  it('serializes two actual JWT HTTP actors behind an observed order lock to exactly one application and one reserved unit', async () => {
    await f.withPeer!(async holder => f.withPeer!(async first => f.withPeer!(async second => {
      const [observer] = await f.db.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`);
      expect(new Set([observer.pid, holder.pid, first.pid, second.pid]).size).toBe(4);
      let unlock!: () => void, locked!: () => void;
      const ready = new Promise<void>(resolve => locked = resolve), release = new Promise<void>(resolve => unlock = resolve);
      const holding = withTx(createContainerFromDb(holder.db), async tx => { await lockOrderSettlement(tx, f.ids.sourceOrder); locked(); await release; });
      await ready;
      const a = apply(input(), f.tokens.buyer, createContainerFromDb(first.db)); let b!: Promise<Envelope>;
      try {
        await waitForFinanceBlock(f.db, first.pid, holder.pid);
        b = apply(input(2), f.tokens.buyer, createContainerFromDb(second.db));
        await waitForFinanceBlock(f.db, second.pid, holder.pid);
      } finally { unlock(); }
      await holding; const results = await Promise.all([a, b]); expect(results.filter(row => row.status === 200)).toHaveLength(1);
      const successful = results.find(row => row.status === 200)!; claim(await stored(successful.data.refundId), 1);
      expect(results.find(row => row.status !== 200)?.msg).toContain('进行中');
      expect((await carts()).find(row => row.id === f.selected.id)?.refundNum).toBe(1);
      expect(await f.db.select().from(storeOrderRefund)).toHaveLength(1);
    })));
  }, 30000);

  it('rolls back an actual HTTP application and selected counter on an isolated late audit failure', async () => {
    await f.exec("CREATE FUNCTION quantity_http_fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'owned HTTP audit fault'; END $$; CREATE TRIGGER quantity_http_fail_audit BEFORE INSERT ON store_order_status FOR EACH ROW EXECUTE FUNCTION quantity_http_fail_audit()");
    const before = await f.snapshot(), writes = f.r2Writes.length;
    const result = await apply(); expect(result.status).toBe(500); expect(await f.snapshot()).toEqual(before); expect(f.r2Writes).toHaveLength(writes);
    // Native PostgreSQL sequences are intentionally nontransactional: this
    // rollback assertion covers all rows, not a false zero sequence-gap claim.
  });
});
