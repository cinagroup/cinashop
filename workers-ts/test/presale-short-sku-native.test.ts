/** Real PG16 bpchar padding, actual App/JWT, and full registered schema.
 * The injected SQL container is owned maintenance, not production authority. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { createApp } from '@/app';
import { createContainerFromDb, withTx, type Container } from '@/lib/di';
import type { Env } from '@/env';
import { storeCart, storeOrder, storeOrderCartInfo, storeProduct, storeProductAttrValue, systemConfig, user, userBill } from '@/models/schema';
import { StoreOrderCreateService } from '@/services/order/StoreOrderCreateService';
import { ApiException } from '@/utils/errors';
import { presaleShortSkuFixture } from './helpers/presaleShortSku';
import { outcome, waitForFinanceBlock } from './helpers/financePeers';

const wiring = vi.hoisted(() => ({ containers: new WeakMap<object, Container>() }));
vi.mock('@/lib/di', async original => ({ ...await original<typeof import('@/lib/di')>(), createContainer: (env: object) => {
  const container = wiring.containers.get(env);
  if (!container) throw Error('Missing owned presale short-SKU App boundary');
  return container;
} }));
const app = createApp();
type Fixture = Awaited<ReturnType<typeof presaleShortSkuFixture>>;
type Envelope<T> = { status: number; msg: string; data: T };
type Confirmation = { orderKey: string; quoteToken: string; priceGroup: { total_price: string; pay_price: string };
  cartInfo: Array<{ id: number; cartNum: number; trueSumPrice: string; productInfo: { price: string } }> };
type Selection = { cartIds: number[]; sourceOrderId: string; sourceRowId: number };

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('Presale short base SKU actual App JWT owned PG16', () => {
  let f: Fixture | undefined, identifiers: number;
  beforeEach(() => { f = undefined; identifiers = 0; });
  afterEach(async () => {
    try {
      if (f) {
        expect(fetch).not.toHaveBeenCalled();
        expect(f.r2Reads).toEqual([]); expect(f.r2Writes).toEqual([]); expect(f.r2Deletes).toEqual([]);
      }
    } finally { vi.restoreAllMocks(); vi.useRealTimers(); await f?.close(); }
  }, 30_000);
  function fixture(): Fixture {
    if (!f) throw Error('Owned presale fixture is not initialized');
    return f;
  }
  async function setup(options: Parameters<typeof presaleShortSkuFixture>[0] = {}) {
    f = await presaleShortSkuFixture(options);
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Owned presale short-SKU scenario forbids providers'));
    const [raw] = await f.db.execute(sql`SELECT "unique" AS raw_unique,
      pg_typeof("unique")::text AS storage_type,octet_length("unique") AS bytes
      FROM public.store_product_attr_value WHERE id=1`);
    expect(raw).toEqual({ raw_unique: f.unique.padEnd(8, ' '), storage_type: 'character', bytes: 8 });
    return f;
  }
  function request(path: string, init: RequestInit = {}, container = fixture().container) {
    const env: Env = { ...fixture().env }; wiring.containers.set(env, container);
    return app.request(path, { ...init, headers: { Authorization: 'Bearer ' + fixture().token,
      'content-type': 'application/json', ...init.headers } }, env);
  }
  async function post<T>(path: string, body: object, container = fixture().container) {
    const response = await request(path, { method: 'POST', body: JSON.stringify(body) }, container);
    return { response, body: await response.json<Envelope<T>>() };
  }
  async function unchanged(before: Awaited<ReturnType<Fixture['snapshot']>>, sequences: Awaited<ReturnType<Fixture['sequences']>>) {
    expect(Object.keys(before)).toHaveLength(283); expect(sequences).toHaveLength(229);
    expect(await fixture().snapshot()).toEqual(before); expect(await fixture().sequences()).toEqual(sequences);
  }
  async function onlyTables(before: Awaited<ReturnType<Fixture['snapshot']>>, allowed: string[]) {
    const after = await fixture().snapshot();
    expect(Object.keys(after)).toHaveLength(283);
    for (const table of Object.keys(before)) if (!allowed.includes(table)) expect(after[table], table).toEqual(before[table]);
  }
  async function confirm(ids = [1], useIntegral = false) {
    const before = await fixture().snapshot(), sequences = await fixture().sequences();
    const { response, body } = await post<Confirmation>('/api/order/confirm', { cartIds: ids, addressId: 11, useIntegral });
    expect(response.status).toBe(200); expect(body.status, body.msg).toBe(200);
    expect(body.data.orderKey).toBeTruthy(); expect(body.data.quoteToken).toBeTruthy();
    await unchanged(before, sequences); return body.data;
  }
  const create = (writer: { container: Container }, receipt: Confirmation, ids = [1], useIntegral = false,
    nextOrderId = async () => `presale_short_${++identifiers}`) =>
    StoreOrderCreateService.createWithRuntime(writer.container, { CONFIG_KV: fixture().env.CONFIG_KV,
      requireConfirmation: true, requirePurchaseOrigin: true, nextOrderId },
    { uid: 11, key: receipt.orderKey, quoteToken: receipt.quoteToken, cartIds: ids,
      addressId: 11, userIp: '127.0.0.1', useIntegral, type: 6 });
  async function protectedOrder(orderId: string, cartId: number, unique: string, type = 6, points = 0) {
    const f = fixture(), [root] = await f.db.select().from(storeOrder).where(eq(storeOrder.orderId, orderId));
    expect(root).toMatchObject({ uid: 11, type, pid: 0, paid: 0, totalNum: 2, cartId: String(cartId) });
    const lines = await f.db.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid, root.id));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ productId: 70, cartId: String(cartId), skuUnique: unique, cartNum: 2 });
    const snapshot = JSON.parse(lines[0].cartInfo!);
    expect(snapshot).toMatchObject({ financial_version: 'checkout-line-finance-v1', sku: { id: 1, unique } });
    if (type === 6) expect(snapshot.presale).toMatchObject({ version: 'presale-full-payment-v1', productId: 70,
      shippingDaysAfterEnd: 7 });
    else expect(snapshot.presale).toBeUndefined();
    const [origin] = await f.db.execute(sql`SELECT * FROM store_order_purchase_origin WHERE order_id=${root.id}`);
    const [physical] = await f.db.execute(sql`SELECT * FROM store_order_purchase_physical_origin WHERE order_id=${root.id}`);
    const charged = { rowId: lines[0].id, cartId: String(cartId), productId: 70, skuId: 1,
      skuUnique: unique, quantity: 2, usedPoints: points };
    expect(origin).toMatchObject({ version: 'purchase-origin-v1', buyer_id: 11, order_type: type,
      total_num: 2, lines: [charged] });
    expect(physical).toMatchObject({ version: 'purchase-physical-origin-v1', buyer_id: 11, order_type: type,
      total_num: 2, lines: [{ ...charged, kind: 'charged', gift: null }] });
    return { root, lines, snapshot, origin, physical };
  }
  async function ordinarySource() {
    const f = await setup({ presale: false });
    const created = await f.withRuntime(writer => StoreOrderCreateService.createWithRuntime(writer.container,
      { CONFIG_KV: f.env.CONFIG_KV, requirePurchaseOrigin: true, nextOrderId: async () => 'presale_ordinary_source' },
      { uid: 11, key: 'presale-ordinary-source', cartIds: [1], addressId: 11, userIp: '127.0.0.1', useIntegral: false }));
    const source = await protectedOrder(created.orderId, 1, f.unique, 0);
    await f.db.update(storeProduct).set({ isPresaleProduct: 1 }).where(eq(storeProduct.id, 70));
    await f.db.update(storeProductAttrValue).set({ price: '22.22' }).where(eq(storeProductAttrValue.id, 1));
    return { f, source };
  }
  async function rejected(path: string, input: object, message: RegExp) {
    const f = fixture(), before = await f.snapshot(), sequences = await f.sequences();
    const { response, body } = await post(path, input);
    expect(response.status).toBeLessThan(500); expect(body.status, body.msg).toBe(400); expect(body.msg).toMatch(message);
    await unchanged(before, sequences);
  }

  it('reads a padded short base SKU through actual presale detail without SQL writes', async () => {
    const f = await setup(), before = await f.snapshot(), sequences = await f.sequences();
    const response = await request('/api/product/detail/70?view=presale');
    const body = await response.json<Envelope<{ type: number; product_id: number;
      skus: Array<{ unique: string; base_unique: string; catalog_price: string }> }>>();
    expect(response.status).toBe(200); expect(body.status, body.msg).toBe(200);
    expect(body.data).toMatchObject({ type: 6, product_id: 70, skus: [
      { unique: f.unique, base_unique: f.unique, catalog_price: '18.88' },
    ] });
    await unchanged(before, sequences);
  }, 120_000);

  it('adds a canonical short base SKU through actual App JWT as a fresh type6 intent', async () => {
    const f = await setup(), before = await f.snapshot(), sequences = await f.sequences();
    const { response, body } = await post<{ cartId: number }>('/api/cart/add',
      { productId: 70, uniqueId: f.unique, type: 6, cartNum: 2, new: 1 });
    expect(response.status).toBe(200); expect(body.status, body.msg).toBe(200);
    const after = await f.snapshot(), afterSequences = await f.sequences();
    for (const table of Object.keys(before)) if (table !== 'store_cart') expect(after[table], table).toEqual(before[table]);
    for (const sequence of sequences) if (sequence.name !== 'store_cart_id_seq')
      expect(afterSequences.find(row => row.name === sequence.name)).toEqual(sequence);
    const rows = await f.db.select().from(storeCart);
    expect(rows.filter(row => row.id !== body.data.cartId)).toHaveLength(2);
    expect(rows.find(row => row.id === body.data.cartId)).toMatchObject({ uid: 11, productId: 70,
      productAttrUnique: f.unique, type: 6, isNew: 1, cartNum: 2, isPay: 0, activityId: 0 });
  }, 120_000);

  it('confirms a retained canonical type6 short-SKU intent at the current SKU price', async () => {
    const f = await setup(), before = await f.snapshot(), sequences = await f.sequences();
    // This owned persisted selection isolates quote admission from the public
    // add gate. It is not a rewritten historical order or receipt.
    const { response, body } = await post<Confirmation>('/api/order/confirm',
      { cartIds: [1], addressId: 11, useIntegral: false });
    expect(response.status).toBe(200); expect(body.status, body.msg).toBe(200);
    expect(body.data.cartInfo).toMatchObject([{ id: 1, cartNum: 2, trueSumPrice: '37.76',
      productInfo: { price: '18.88' } }]);
    expect(body.data.orderKey).toBeTruthy(); expect(body.data.quoteToken).toBeTruthy();
    await unchanged(before, sequences);
  }, 120_000);

  it.each(['short7', 'qared001', 'x'])(
    'completes %s App selection, independent LOGIN checkout, protected replay and once-only unpaid compensation', async unique => {
      const f = await setup({ unique }), selectedBefore = await f.snapshot();
      const added = await post<{ cartId: number }>('/api/cart/add',
        { productId: 70, uniqueId: unique, cartNum: 1, new: 1 });
      expect(added.body.status, added.body.msg).toBe(200);
      const id = added.body.data.cartId;
      const edited = await post('/api/cart/num', { id, cartNum: 2 });
      expect(edited.body.status, edited.body.msg).toBe(200);
      const buy = await request(`/api/cart/list?scope=buy&ids=${id}`);
      expect(await buy.json()).toMatchObject({ status: 200, data: [{ id, type: 6, isValid: true,
        truePrice: '18.88', trueSumPrice: '37.76' }] });
      await onlyTables(selectedBefore, ['store_cart']);
      const [beforeProduct] = await f.db.select().from(storeProduct).where(eq(storeProduct.id, 70));
      const [beforeSku] = await f.db.select().from(storeProductAttrValue).where(eq(storeProductAttrValue.id, 1));
      const [beforeUser] = await f.db.select().from(user).where(eq(user.uid, 11));
      const receipt = await confirm([id], true), beforeCreate = await f.snapshot();
      const created = await f.withRuntime(async writer => {
        const nextOrderId = vi.fn(async () => `presale_full_${unique}`);
        const created = await create(writer, receipt, [id], true, nextOrderId);
        expect(nextOrderId).toHaveBeenCalledTimes(1);
        const purchased = await f.snapshot(), sequences = await f.sequences();
        const put = vi.spyOn(f.env.CONFIG_KV, 'put'), remove = vi.spyOn(f.env.CONFIG_KV, 'delete');
        try {
          expect(await create(writer, receipt, [id], true, nextOrderId)).toEqual(created);
          expect(nextOrderId).toHaveBeenCalledTimes(1);
          expect(put).not.toHaveBeenCalled(); expect(remove).not.toHaveBeenCalled();
          await unchanged(purchased, sequences);
        } finally { put.mockRestore(); remove.mockRestore(); }
        return created;
      });
      await onlyTables(beforeCreate, ['store_cart', 'store_order', 'store_order_cart_info', 'store_product',
        'store_product_attr_value', 'user', 'user_bill', 'store_order_status', 'store_order_purchase_origin',
        'store_order_purchase_physical_origin']);
      const captured = await protectedOrder(created.orderId, id, unique, 6, 100);
      expect(captured.root).toMatchObject({ totalPrice: '37.76', payPrice: '42.76',
        totalPostage: '6.00', payPostage: '6.00', deductionPrice: '1.00', useIntegral: '100.00' });
      expect(captured.snapshot.sku.price).toBe('18.88');
      expect((await f.db.select().from(storeProduct).where(eq(storeProduct.id, 70)))[0].stock).toBe(beforeProduct.stock - 2);
      expect((await f.db.select().from(storeProductAttrValue).where(eq(storeProductAttrValue.id, 1)))[0].stock).toBe(beforeSku.stock - 2);
      expect((await f.db.select().from(user).where(eq(user.uid, 11)))[0].integral).toBe(beforeUser.integral - 100);
      let expectedProduct = beforeProduct, expectedSku = beforeSku;
      if (unique === 'short7') {
        // Owned maintenance edits current policy/catalogue only. The captured
        // order, line JSON and both protected receipts remain untouched.
        await f.db.update(storeProduct).set({ price: '27.00', isPresaleProduct: 0,
          presaleEndTime: 1, presaleDay: 99 }).where(eq(storeProduct.id, 70));
        await f.db.update(storeProductAttrValue).set({ price: '25.25' }).where(eq(storeProductAttrValue.id, 1));
        const policies = { integral_ratio: '0.50', integral_ratio_status: '0' };
        for (const [menuName, value] of Object.entries(policies)) {
          const changed = await f.db.update(systemConfig).set({ value })
            .where(and(eq(systemConfig.menuName, menuName), eq(systemConfig.isStore, 0)))
            .returning({ menuName: systemConfig.menuName, value: systemConfig.value });
          expect(changed).toEqual([{ menuName, value }]);
        }
        // refundRuntimeFixture intentionally exposes env rather than the inner
        // quote fixture's config/setConfig closure. Its KV get reads cfg_* from
        // that closure, so KV.put would NOT change the policy mirror. Override
        // only the two owned cfg reads; preserve every other real KV operation.
        const originalKv = f.env.CONFIG_KV;
        f.env.CONFIG_KV = new Proxy(originalKv, { get(target, property, receiver) {
          if (property === 'get') return (key: string, ...options: unknown[]) => {
            if (key === 'cfg_integral_ratio') return Promise.resolve(policies.integral_ratio);
            if (key === 'cfg_integral_ratio_status') return Promise.resolve(policies.integral_ratio_status);
            return Reflect.apply(Reflect.get(target, property, receiver), target, [key, ...options]);
          };
          return Reflect.get(target, property, receiver);
        } });
        expect(await f.env.CONFIG_KV.get('cfg_integral_ratio')).toBe('0.50');
        expect(await f.env.CONFIG_KV.get('cfg_integral_ratio_status')).toBe('0');
        const [editedProduct] = await f.db.select().from(storeProduct).where(eq(storeProduct.id, 70));
        const [editedSku] = await f.db.select().from(storeProductAttrValue).where(eq(storeProductAttrValue.id, 1));
        expect(editedProduct).toMatchObject({ price: '27.00', isPresaleProduct: 0, presaleEndTime: 1, presaleDay: 99,
          stock: beforeProduct.stock - 2, sales: beforeProduct.sales + 2 });
        expect(editedSku).toMatchObject({ price: '25.25', stock: beforeSku.stock - 2, sales: beforeSku.sales + 2 });
        expectedProduct = { ...editedProduct, stock: beforeProduct.stock, sales: beforeProduct.sales };
        expectedSku = { ...editedSku, stock: beforeSku.stock, sales: beforeSku.sales };
      }
      const beforeCancel = await f.snapshot();
      const cancelled = await post('/api/order/cancel', { order_id: created.orderId });
      expect(cancelled.body.status, cancelled.body.msg).toBe(200);
      expect((await f.db.select().from(storeProduct).where(eq(storeProduct.id, 70)))[0]).toEqual(expectedProduct);
      expect((await f.db.select().from(storeProductAttrValue).where(eq(storeProductAttrValue.id, 1)))[0]).toEqual(expectedSku);
      if (unique === 'short7') {
        expect(await f.db.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid, captured.root.id))).toEqual(captured.lines);
        expect((await f.db.execute(sql`SELECT * FROM store_order_purchase_origin WHERE order_id=${captured.root.id}`))[0]).toEqual(captured.origin);
        expect((await f.db.execute(sql`SELECT * FROM store_order_purchase_physical_origin WHERE order_id=${captured.root.id}`))[0]).toEqual(captured.physical);
        expect(await f.env.CONFIG_KV.get('cfg_integral_ratio')).toBe('0.50');
        expect(await f.env.CONFIG_KV.get('cfg_integral_ratio_status')).toBe('0');
      }
      expect((await f.db.select().from(user).where(eq(user.uid, 11)))[0]).toEqual(beforeUser);
      expect((await f.db.select().from(storeCart)).find(row => row.id === id)?.isPay).toBe(0);
      expect((await f.db.select().from(storeOrder)).find(row => row.id === captured.root.id))
        .toMatchObject({ status: -2, isDel: 1, paid: 0 });
      const bills = await f.db.select().from(userBill).where(eq(userBill.uid, 11)).orderBy(userBill.id);
      expect(bills.map(row => ({ event: row.eventKey, number: row.number, pm: row.pm }))).toEqual([
        { event: 'order_integral_deduction', number: '100.00', pm: 0 },
        { event: 'order_cancel_integral_back', number: '100.00', pm: 1 },
      ]);
      await onlyTables(beforeCancel, ['store_cart', 'store_order', 'store_product', 'store_product_attr_value',
        'user', 'user_bill', 'store_order_status', 'store_order_purchase_cancellation']);
      await rejected('/api/order/cancel', { order_id: created.orderId }, /订单状态不允许取消/);
    }, 120_000);

  it('repurchases a genuine single-line ordinary source into current presale without rewriting historical JSON or receipts', async () => {
    const { f, source } = await ordinarySource(), before = await f.snapshot(), sequences = await f.sequences();
    const prepared = await post<Selection>('/api/order/again', { uni: source.root.orderId });
    expect(prepared.body.status, prepared.body.msg).toBe(200);
    expect(prepared.body.data).toMatchObject({ sourceOrderId: source.root.orderId, sourceRowId: source.root.id });
    expect(prepared.body.data.cartIds).toHaveLength(1);
    const id = prepared.body.data.cartIds[0];
    const [row] = await f.db.select().from(storeCart).where(eq(storeCart.id, id));
    expect(row).toMatchObject({ uid: 11, type: 6, isNew: 1, cartNum: 2, productId: 70, productAttrUnique: f.unique });
    await onlyTables(before, ['store_cart']);
    const afterSequences = await f.sequences();
    for (const entry of sequences) if (entry.name !== 'store_cart_id_seq')
      expect(afterSequences.find(row => row.name === entry.name)).toEqual(entry);
    const receipt = await confirm([id]);
    expect(receipt.cartInfo).toMatchObject([{ cartNum: 2, trueSumPrice: '44.44', productInfo: { price: '22.22' } }]);
    const created = await f.withRuntime(writer => create(writer, receipt, [id]));
    const current = await protectedOrder(created.orderId, id, f.unique);
    expect(current.snapshot.sku.price).toBe('22.22');
    expect((await f.db.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid, source.root.id)))).toEqual(source.lines);
    expect((await f.db.select().from(storeOrder).where(eq(storeOrder.id, source.root.id)))[0]).toEqual(source.root);
    expect((await f.db.execute(sql`SELECT * FROM store_order_purchase_origin WHERE order_id=${source.root.id}`))[0]).toEqual(source.origin);
    expect((await f.db.execute(sql`SELECT * FROM store_order_purchase_physical_origin WHERE order_id=${source.root.id}`))[0]).toEqual(source.physical);
    expect((await f.db.select().from(user).where(eq(user.uid, 11)))[0].integral).toBe(100);
  }, 120_000);

  it.each([
    { label: 'blank', unique: '', type: 6 },
    { label: 'leading on explicit type6', unique: ' short7', type: 6 },
    { label: 'leading on default ordinary-to-presale conversion', unique: ' short7', type: undefined },
    { label: 'trailing on explicit type6', unique: 'short7 ', type: 6 },
    { label: 'trailing on default ordinary-to-presale conversion', unique: 'short7 ', type: undefined },
    { label: 'internal whitespace', unique: 'sho rt7', type: 6 },
    { label: 'control', unique: 'sho\nrt7', type: 6 },
  ])('rejects $label HTTP selection instead of normalizing untrusted input', async entry => {
    await setup();
    await rejected('/api/cart/add', { productId: 70, uniqueId: entry.unique,
      type: entry.type, cartNum: 1, new: 1 }, /参数|规格|商品/);
  }, 120_000);

  it.each(['wrong product', 'wrong type', 'retired', 'missing'] as const)(
    'rejects a current %s base SKU in actual add and retained-intent confirmation without fallback or writes', async mode => {
      const f = await setup();
      if (mode === 'missing') await f.db.delete(storeProductAttrValue).where(eq(storeProductAttrValue.id, 1));
      else await f.db.update(storeProductAttrValue).set(mode === 'wrong product' ? { productId: 71 }
        : mode === 'wrong type' ? { type: 6 } : { isRetired: 1 }).where(eq(storeProductAttrValue.id, 1));
      await rejected('/api/cart/add', { productId: 70, uniqueId: f.unique, type: 6, cartNum: 2, new: 1 }, /规格/);
      await rejected('/api/order/confirm', { cartIds: [1], addressId: 11 }, /规格|失效|商品/);
    }, 120_000);

  it('rejects two real live base rows with the same canonical short key in catalogue, add, edit and scoped list', async () => {
    const f = await setup(), [sku] = await f.db.select().from(storeProductAttrValue).where(eq(storeProductAttrValue.id, 1));
    await f.db.insert(storeProductAttrValue).values({ ...sku, id: 900, unique: f.unique.padEnd(8, ' '), suk: 'Owned duplicate' });
    const rows = await f.db.execute(sql`SELECT "unique" AS raw_unique FROM store_product_attr_value
      WHERE product_id=70 AND type=0 AND is_retired=0 AND "unique"=${f.unique} ORDER BY id`);
    expect(rows).toEqual([{ raw_unique: 'short7  ' }, { raw_unique: 'short7  ' }]);
    const before = await f.snapshot(), sequences = await f.sequences();
    expect(await (await request('/api/product/detail/70?view=presale')).json()).toMatchObject({ status: 400 });
    expect(await (await request('/api/cart/list?scope=buy&ids=1')).json()).toMatchObject({ status: 400 });
    await unchanged(before, sequences);
    await rejected('/api/cart/add', { productId: 70, uniqueId: f.unique, type: 6, cartNum: 2, new: 1 }, /规格/);
    await rejected('/api/cart/num', { id: 1, cartNum: 1 }, /规格/);
    await rejected('/api/order/confirm', { cartIds: [1], addressId: 11 }, /规格|失效|商品/);
  }, 120_000);

  it('keeps padded historical source aliases invalid when the current product becomes presale', async () => {
    const { f, source } = await ordinarySource(), snapshot = JSON.parse(source.lines[0].cartInfo!);
    snapshot.sku.unique = f.unique.padEnd(8, ' ');
    await f.db.update(storeOrderCartInfo).set({ skuUnique: f.unique.padEnd(8, ' '), cartInfo: JSON.stringify(snapshot) })
      .where(eq(storeOrderCartInfo.id, source.lines[0].id));
    await rejected('/api/order/again', { uni: source.root.orderId }, /原订单商品快照无法核对/);
  }, 120_000);

  it('keeps cumulative presale allowance incomplete across detail, add, edit, confirmation and strict author', async () => {
    const f = await setup();
    await f.db.update(storeProduct).set({ isLimit: 1, limitType: 2, limitNum: 3 }).where(eq(storeProduct.id, 70));
    const before = await f.snapshot(), sequences = await f.sequences();
    expect(await (await request('/api/product/detail/70?view=presale')).json()).toMatchObject({ status: 200,
      data: { purchase_limits: { mode: 'cumulative', quantity: 3 }, skus: [{ unique: f.unique, max_quantity: 0 }] } });
    await rejected('/api/cart/add', { productId: 70, uniqueId: f.unique, type: 6, cartNum: 1, new: 1 }, /累计限购预售暂未开放/);
    await rejected('/api/cart/num', { id: 1, cartNum: 1 }, /累计限购预售暂未开放/);
    await rejected('/api/order/confirm', { cartIds: [1], addressId: 11 }, /累计限购|失效/);
    await f.withRuntime(async writer => {
      const result = await outcome(StoreOrderCreateService.createWithRuntime(writer.container,
        { CONFIG_KV: f.env.CONFIG_KV, requirePurchaseOrigin: true, nextOrderId: async () => 'forbidden_cumulative' },
        { uid: 11, key: 'forbidden-cumulative', cartIds: [1], addressId: 11, userIp: '127.0.0.1', type: 6 }));
      expect(result.ok).toBe(false);
      if (!result.ok) { expect(result.error).toBeInstanceOf(ApiException); expect(result.error.message).toMatch(/累计限购预售暂未开放/); }
    });
    await unchanged(before, sequences);
  }, 120_000);

  it('waits on an independent base SKU writer and quotes its committed current price after actual add', async () => {
    const f = await setup(), before = await f.snapshot(), sequences = await f.sequences();
    await f.withPeer!(async holder => f.withPeer!(async actor => {
      const [observer] = await f.db.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`);
      expect(new Set([observer.pid, holder.pid, actor.pid]).size).toBe(3);
      let unlock!: () => void, locked!: () => void;
      const ready = new Promise<void>(yes => { locked = yes; }), release = new Promise<void>(yes => { unlock = yes; });
      const holding = withTx(createContainerFromDb(holder.db), async tx => {
        await tx.update(storeProductAttrValue).set({ price: '22.22' }).where(eq(storeProductAttrValue.id, 1));
        locked(); await release;
        await tx.execute(sql`SELECT id FROM store_product WHERE id=70 FOR UPDATE NOWAIT`);
      });
      await ready;
      const pending = post<{ cartId: number }>('/api/cart/add',
        { productId: 70, uniqueId: f.unique, type: 6, cartNum: 2, new: 1 }, createContainerFromDb(actor.db));
      try { await waitForFinanceBlock(f.db, actor.pid, holder.pid); } finally { unlock(); }
      await holding;
      const result = await pending; expect(result.body.status, result.body.msg).toBe(200);
      expect((await confirm([result.body.data.cartId])).cartInfo).toMatchObject([
        { cartNum: 2, trueSumPrice: '44.44', productInfo: { price: '22.22' } },
      ]);
    }));
    await onlyTables(before, ['store_cart', 'store_product_attr_value']);
    const after = await f.sequences();
    for (const entry of sequences) if (entry.name !== 'store_cart_id_seq')
      expect(after.find(row => row.name === entry.name)).toEqual(entry);
  }, 120_000);

  it.each(['stock', 'window', 'duplicate'] as const)(
    'rejects a committed %s change after a real SKU wait in independent LOGIN create and rolls back all claims', async mode => {
      const f = await setup(), receipt = await confirm();
      const before = await f.snapshot(), products = await f.db.select().from(storeProduct).orderBy(storeProduct.id),
        skus = await f.db.select().from(storeProductAttrValue).orderBy(storeProductAttrValue.id);
      let editedEnd: number | undefined;
      await f.withRuntime(async writer => f.withPeer!(async holder => {
        const [observer] = await f.db.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`);
        expect(new Set([observer.pid, holder.pid, writer.pid]).size).toBe(3);
        await holder.exec('BEGIN');
        try {
          await holder.db.execute(sql`SELECT id FROM store_product_attr_value WHERE id=1 FOR UPDATE`);
          if (mode === 'stock') await holder.db.update(storeProductAttrValue).set({ stock: 1 }).where(eq(storeProductAttrValue.id, 1));
          if (mode === 'duplicate') {
            const [sku] = await holder.db.select().from(storeProductAttrValue).where(eq(storeProductAttrValue.id, 1));
            await holder.db.insert(storeProductAttrValue).values({ ...sku, id: 900, suk: 'Committed duplicate after quote' });
          }
          const pending = outcome(create(writer, receipt));
          await waitForFinanceBlock(f.db, writer.pid, holder.pid);
          if (mode === 'window') {
            editedEnd = Math.floor(Date.now() / 1000) - 1;
            await holder.db.update(storeProduct).set({ presaleEndTime: editedEnd }).where(eq(storeProduct.id, 70));
          }
          await holder.exec('COMMIT');
          const result = await pending;
          expect(result.ok).toBe(false);
          if (!result.ok) {
            expect(result.error).toBeInstanceOf(ApiException);
            if (mode === 'window') expect(result.error.message).toBe('配送商品归属或规则已变化，请刷新后重试');
            else expect(result.error.message).toMatch(/重新确认|规格|库存/);
          }
          expect(await f.db.select().from(storeOrder)).toEqual([]);
          expect(await f.db.select().from(storeOrderCartInfo)).toEqual([]);
          expect((await f.db.select().from(storeProduct).where(eq(storeProduct.id, 70)))[0].stock).toBe(8);
          expect((await f.db.select().from(user).where(eq(user.uid, 11)))[0].integral).toBe(100);
          expect(await f.db.select().from(userBill)).toEqual([]);
          expect((await f.db.select().from(storeCart)).find(row => row.id === 1)?.isPay).toBe(0);
        } finally { await holder.exec('ROLLBACK'); }
      }));
      // Compare every public table, permitting only the exact committed writer
      // edit. PostgreSQL sequence gaps after rolled-back INSERTs are not writes
      // to business rows and are deliberately not claimed to rewind here.
      await onlyTables(before, [mode === 'window' ? 'store_product' : 'store_product_attr_value']);
      expect(await f.db.select().from(storeProduct).orderBy(storeProduct.id)).toEqual(
        products.map(row => mode === 'window' && row.id === 70 ? { ...row, presaleEndTime: editedEnd } : row));
      const expectedSkus = mode === 'duplicate'
        ? [...skus, { ...skus.find(row => row.id === 1)!, id: 900, suk: 'Committed duplicate after quote' }]
        : skus.map(row => mode === 'stock' && row.id === 1 ? { ...row, stock: 1 } : row);
      expect(await f.db.select().from(storeProductAttrValue).orderBy(storeProductAttrValue.id)).toEqual(expectedSkus);
    }, 120_000);

  it.each(['price', 'shipping terms'] as const)(
    'rejects changed %s between receipt validation and actual write admission without persistent business changes', async mode => {
      const f = await setup(), receipt = await confirm();
      await f.withRuntime(async writer => {
        let edited: Awaited<ReturnType<Fixture['snapshot']>> | undefined;
        const nextOrderId = vi.fn(async () => {
          if (mode === 'price') await f.db.update(storeProductAttrValue).set({ price: '22.22' }).where(eq(storeProductAttrValue.id, 1));
          else await f.db.update(storeProduct).set({ presaleDay: 8 }).where(eq(storeProduct.id, 70));
          edited = await f.snapshot(); return 'presale_drift_rejected';
        });
        const result = await outcome(create(writer, receipt, [1], false, nextOrderId));
        expect(nextOrderId).toHaveBeenCalledTimes(1); expect(edited).toBeDefined();
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error).toBeInstanceOf(ApiException);
        expect(await f.snapshot()).toEqual(edited);
      });
    }, 120_000);
});
