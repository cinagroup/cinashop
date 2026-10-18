import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createApp } from '@/app';
import type { Container } from '@/lib/di';
import { storeProduct, storeProductAttrValue, storeOrder, storeOrderCartInfo } from '@/models/schema';
import { supplierProductShippingEditorFixture, type SupplierShippingEditorState } from './helpers/supplierProductShippingEditor';

const wiring = vi.hoisted(() => ({ container: undefined as Container | undefined, moderator: undefined as Container | undefined }));
vi.mock('@/lib/di', async original => ({ ...await original<typeof import('@/lib/di')>(),
  createContainer: () => { if (!wiring.container) throw Error('Missing owned shipping-editor HTTP SQL session'); return wiring.container; },
  createAdminDatabaseSession: () => { if (!wiring.moderator) throw Error('Missing owned shipping-editor reviewer LOGIN'); return { container: wiring.moderator, close: async () => {} }; },
}));
type Envelope = { status: number; msg: string; data: any };
const app = createApp(), shippingTables = new Set(['shipping_templates', 'shipping_templates_region', 'shipping_templates_free', 'shipping_templates_no_delivery']);

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('Supplier inline shipping template actual App author and Customer quote/create on owned PG16', () => {
  let f: Awaited<ReturnType<typeof supplierProductShippingEditorFixture>>;
  beforeEach(async () => { vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Owned shipping-editor fixture forbids provider I/O')); f = await supplierProductShippingEditorFixture(); wiring.container = f.container; }, 30000);
  afterEach(async () => { try { expect(fetch).not.toHaveBeenCalled(); } finally { await f?.close(); wiring.container = undefined; wiring.moderator = undefined; vi.restoreAllMocks(); } }, 30000);
  async function supplier(method: string, path: string, body?: unknown, actor: keyof typeof f.tokens | 'anonymous' = 'manager', extra: Record<string, string> = {}) {
    const response = await app.request('/supplierapi' + path, { method, headers: {
      ...(actor === 'anonymous' ? {} : { Authorization: 'Bearer ' + f.tokens[actor] }), 'X-Supplier-Id': '8', ...extra,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, f.env);
    expect(response.headers.get('cache-control')).toContain('private, no-store'); return response.json<Envelope>();
  }
  async function unchanged(work: () => Promise<unknown>) {
    const before = await f.snapshot(), seq = await f.sequences(); await work(); expect(await f.snapshot()).toEqual(before); expect(await f.sequences()).toEqual(seq);
  }
  function onlyShippingChanged(before: SupplierShippingEditorState, after: SupplierShippingEditorState, createdId?: number) {
    const target = createdId ?? 60;
    expect(Object.keys(after)).toEqual(Object.keys(before));
    for (const name of Object.keys(before)) if (!shippingTables.has(name) && !(createdId && name === 'shipping_template_create_replay')) expect(after[name], name).toEqual(before[name]);
    // An update may replace only60's grouped rules; creation may add only the
    // returned new parent's rules. Foreign, retired and every other row survive.
    expect(after.shipping_templates.filter(item => item.row.id !== target))
      .toEqual(before.shipping_templates.filter(item => item.row.id !== target));
    expect(after.shipping_templates.filter(item => item.row.id === target)).toHaveLength(1);
    if (createdId) expect(before.shipping_templates.some(item => item.row.id === target)).toBe(false);
    else {
      const prior = before.shipping_templates.find(item => item.row.id === target)!.row;
      const fresh = after.shipping_templates.find(item => item.row.id === target)!.row;
      const writable = new Set(['add_time']); // These fee-only edits keep every parent field except its write timestamp.
      expect(Object.fromEntries(Object.entries(fresh).filter(([key]) => !writable.has(key))))
        .toEqual(Object.fromEntries(Object.entries(prior).filter(([key]) => !writable.has(key))));
    }
    for (const [name, reference, count] of [['shipping_templates_region', 'template_id', 2], ['shipping_templates_free', 'temp_id', 1], ['shipping_templates_no_delivery', 'temp_id', 1]] as const) {
      expect(after[name].filter(item => item.row[reference] !== target), name)
        .toEqual(before[name].filter(item => item.row[reference] !== target));
      expect(after[name].filter(item => item.row[reference] === target), name).toHaveLength(count);
      if (createdId) expect(before[name].some(item => item.row[reference] === target), name).toBe(false);
    }
  }
  const createHeaders = (key: string, actorId = 21) => ({ 'Idempotency-Key': key, 'X-Shipping-Creation-Scope': `v1:2:7:${actorId}` });
  async function opened() { const result = await supplier('GET', '/setting/shipping_templates/60/edit'); expect(result.status, result.msg).toBe(200); expect(result.data.revision).toMatch(/^shipping-v1:[a-f0-9]{64}$/); return result.data; }
  function projectRegion(row: Record<string, any>) { return { city_ids: row.city_ids, first: row.first, first_price: row.first_price, continue: row.continue, continue_price: row.continue_price }; }

  it('reads coherent owned detail and all three rule groups with a genuinely SELECT-only Supplier LOGIN and performs zero SQL writes', async () => f.withShippingReader(async runtime => {
    wiring.container = runtime.container;
    await unchanged(async () => {
      const detail = await supplier('GET', '/setting/shipping_templates/60/edit?supplier_id=8', undefined, 'viewer'); expect(detail.status, detail.msg).toBe(200);
      expect(detail.data.formData).toEqual({ name: '商品内联运费模板', type: 1, appoint_check: 1, no_delivery_check: 1, sort: 12 });
      expect(detail.data.revision).toMatch(/^shipping-v1:[a-f0-9]{64}$/); expect(detail.data.templateList.map(projectRegion)).toEqual(f.shippingBody().region_info);
      expect(detail.data.appointList[0]).toMatchObject(f.shippingBody().appoint_info[0]); expect(detail.data.noDeliveryList[0]).toMatchObject(f.shippingBody().no_delivery_info[0]);
      const cities = await supplier('GET', '/setting/shipping_templates/city_list', undefined, 'viewer'); expect(cities.status, cities.msg).toBe(200); expect(cities.data.map((row: any) => row.city_id)).toEqual([44, 11]);
    });
    const [rights] = await runtime.db.execute(sql`SELECT current_user=session_user AS independent,
      has_table_privilege(current_user,'shipping_templates','SELECT') AS template_read,
      has_any_column_privilege(current_user,'shipping_templates','UPDATE') AS template_update,
      has_table_privilege(current_user,'shipping_templates_region','INSERT,DELETE') AS rule_write,
      has_table_privilege(current_user,'store_order','SELECT,INSERT,UPDATE,DELETE') AS order_access,
      has_table_privilege(current_user,'system_form_data','SELECT,INSERT,UPDATE,DELETE') AS answers_access`);
    expect(rights).toEqual({ independent: true, template_read: true, template_update: false, rule_write: false, order_access: false, answers_access: false });
  }));

  it('updates the real owned template from first fee8 to12 and rereads the new complete revision while preserving persisted product rows SKU stock history and answers', async () => f.withShippingWriter(async runtime => {
    wiring.container = runtime.container; const detail = await opened(), before = await f.snapshot(), seq = await f.sequences();
    const result = await supplier('POST', '/setting/shipping_templates/save/60', { ...f.shippingBody('12.00'), expectedRevision: detail.revision }); expect(result.status, result.msg).toBe(200); expect(result.data).toEqual({ id: 60 });
    const after = await f.snapshot(); onlyShippingChanged(before, after);
    expect(after.shipping_templates.find(item => item.row.id === 60)?.row).toMatchObject({ owner_type: 2, relation_id: 7, type: 1, status: 1, is_del: 0 });
    await unchanged(async () => { const readback = await opened(); expect(readback.revision).not.toBe(detail.revision); expect(readback.templateList.map(projectRegion)).toEqual(f.shippingBody('12.00').region_info); expect(readback.appointList[0]).toMatchObject(f.shippingBody().appoint_info[0]); expect(readback.noDeliveryList[0]).toMatchObject(f.shippingBody().no_delivery_info[0]); });
    const allowed = new Set(['shipping_templates_region_id_seq', 'shipping_templates_free_id_seq', 'shipping_templates_no_delivery_id_seq']); expect((await f.sequences()).filter(row => !allowed.has(row.name))).toEqual(seq.filter(row => !allowed.has(row.name)));
    const [rights] = await runtime.db.execute(sql`SELECT current_user=session_user AS independent,
      has_any_column_privilege(current_user,'store_product','UPDATE') AS product_write,
      has_table_privilege(current_user,'store_product_attr_value','UPDATE') AS sku_write,
      has_table_privilege(current_user,'shipping_template_create_replay','UPDATE,DELETE') AS receipt_mutable,
      has_table_privilege(current_user,'store_order','SELECT,INSERT,UPDATE,DELETE') AS order_access,
      has_table_privilege(current_user,'system_form_data','SELECT,INSERT,UPDATE,DELETE') AS answers_access`);
    expect(rights).toEqual({ independent: true, product_write: false, sku_write: false, receipt_mutable: false, order_access: false, answers_access: false });
  }));

  it.each(['anonymous', 'viewer', 'productOnly'] as const)('refuses %s template update creation and receipt lookup without any row or sequence mutation', async actor => f.withShippingWriter(async runtime => {
    wiring.container = runtime.container; const detail = await opened(), key = crypto.randomUUID(), actorId = actor === 'viewer' ? 22 : actor === 'productOnly' ? 23 : 21;
    await unchanged(async () => {
      expect((await supplier('POST', '/setting/shipping_templates/save/60', { ...f.shippingBody('12.00'), expectedRevision: detail.revision }, actor)).status).not.toBe(200);
      expect((await supplier('POST', '/setting/shipping_templates/save/0', f.shippingBody(), actor, createHeaders(key, actorId))).status).not.toBe(200);
      expect((await supplier('POST', '/setting/shipping_templates/creation-receipt', {}, actor, createHeaders(key, actorId))).status).not.toBe(200);
    });
  }));

  it.each([61, 62, 999])('does not disclose or overwrite foreign retired or missing template%i through real scoped HTTP authoring', async id => f.withShippingWriter(async runtime => {
    wiring.container = runtime.container; const detail = await opened();
    await unchanged(async () => {
      for (const result of [await supplier('GET', `/setting/shipping_templates/${id}/edit`), await supplier('POST', `/setting/shipping_templates/save/${id}`, { ...f.shippingBody('12.00'), expectedRevision: detail.revision })]) {
        expect(result.status).not.toBe(200); expect(result.msg).toMatch(/不存在|不属于/);
      }
      const other = await supplier('POST', '/setting/shipping_templates/save/60', { ...f.shippingBody('12.00'), expectedRevision: detail.revision }, 'other'); expect(other.status).not.toBe(200); expect(other.msg).toMatch(/不存在|不属于/);
    });
  }));

  it('rejects the stale shipping-v1 revision without reverting a newer committed template or touching rows and sequences', async () => f.withShippingWriter(async runtime => {
    wiring.container = runtime.container; const detail = await opened();
    const first = await supplier('POST', '/setting/shipping_templates/save/60', { ...f.shippingBody('12.00'), expectedRevision: detail.revision }); expect(first.status, first.msg).toBe(200);
    await unchanged(async () => { const stale = await supplier('POST', '/setting/shipping_templates/save/60', { ...f.shippingBody('14.00'), expectedRevision: detail.revision }); expect(stale.status).toBe(400); expect(stale.msg).toContain('其他操作修改'); });
    expect((await opened()).templateList[0].first_price).toBe('12.00');
  }));

  it('uses the mature real UUID creation receipt scope and replay without minting duplicates or making the immutable receipt editable', async () => f.withShippingWriter(async runtime => {
    wiring.container = runtime.container; const before = await f.snapshot(), key = crypto.randomUUID(), headers = createHeaders(key), body = f.shippingBody('4.00', '独立新建模板');
    const first = await supplier('POST', '/setting/shipping_templates/save/0', body, 'manager', headers); expect(first.status, first.msg).toBe(200);
    const id = first.data.id; expect(id).toBeGreaterThan(62); expect(first.data).toEqual({ version: 'shipping-create-v1', requestKey: key, requestHash: expect.stringMatching(/^[a-f0-9]{64}$/), id, replayed: false });
    const after = await f.snapshot(); onlyShippingChanged(before, after, id); expect(after.shipping_templates.find(item => item.row.id === id)?.row).toMatchObject({ owner_type: 2, relation_id: 7, name: body.name, status: 1 }); expect(after.shipping_template_create_replay).toHaveLength(1);
    await unchanged(async () => {
      const replay = await supplier('POST', '/setting/shipping_templates/save/0', body, 'manager', headers); expect(replay.status, replay.msg).toBe(200); expect(replay.data).toEqual({ ...first.data, replayed: true });
      const receipt = await supplier('POST', '/setting/shipping_templates/creation-receipt', {}, 'manager', headers); expect(receipt.status, receipt.msg).toBe(200); expect(receipt.data).toEqual({ version: first.data.version, requestKey: key, requestHash: first.data.requestHash, id });
      const conflict = await supplier('POST', '/setting/shipping_templates/save/0', { ...body, name: '不同内容禁止重用' }, 'manager', headers); expect(conflict.status).toBe(409);
      for (const scope of ['v1:2:8:21', 'v1:2:7:22']) { const denied = await supplier('POST', '/setting/shipping_templates/save/0', body, 'manager', { ...headers, 'X-Shipping-Creation-Scope': scope }); expect(denied.status).toBe(412); }
    });
  }));

  it('reconfirms actual Customer JWT quantity2 postage10 to14 after Supplier fee8 to12 rejects the old quote and freezes real orders without rewriting historical lines', async () => {
    const checkout = await f.prepareCheckout();
    // Evidence boundary: genuine HTTP/JWT/checkout SQL, but Buyer SQL is owned
    // maintenance. Only the Supplier and independent reviewer use limited LOGINs.
    expect(f.buyerSqlBoundary).toBe('owned finance_test maintenance connection'); const [buyerSql] = await f.db.execute(sql`SELECT current_user AS role`); expect(buyerSql.role).toBe('finance_test');
    await f.withModerator(async moderator => {
      wiring.container = f.container; wiring.moderator = moderator.container;
      const response = await app.request('/adminapi/product/product/set_verify/80', { method: 'POST', headers: { Authorization: 'Bearer ' + f.adminToken, 'Content-Type': 'application/json' }, body: JSON.stringify({ is_verify: 1, is_show: 1, refusal: '', auto_on_time: '' }) }, f.env);
      const review = await response.json<Envelope>(); expect(review.status, review.msg).toBe(200);
    });
    const customer = async (path: string, body: unknown) => { wiring.container = f.container; const response = await app.request('/api' + path, { method: 'POST', headers: { Authorization: 'Bearer ' + checkout.token, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, f.env); return response.json<Envelope>(); };
    const createCart = async () => { const cart = await customer('/cart/add', { productId: 80, unique: 'sbtblu01', cartNum: 2, type: 0, new: 1 }); expect(cart.status, cart.msg).toBe(200); return Number(cart.data.id); };
    const selection = (cartId: number) => ({ cartIds: [cartId], addressId: 11, shippingType: 1, useIntegral: false });
    const historicalSeed = await f.snapshot(), initialSku = (await f.db.select().from(storeProductAttrValue).where(eq(storeProductAttrValue.unique, 'sbtblu01')))[0]; expect(initialSku.stock).toBe(7);
    const firstInput = selection(await createCart()), firstQuote = await customer('/order/confirm', firstInput); expect(firstQuote.status, firstQuote.msg).toBe(200); expect(firstQuote.data.priceGroup).toMatchObject({ pay_postage: '10.00', total_postage: '10.00' });
    const firstCreated = await customer('/order/create/' + firstQuote.data.orderKey, { ...firstInput, quoteToken: firstQuote.data.quoteToken, customForm: [] }); expect(firstCreated.status, firstCreated.msg).toBe(200);
    const [oldOrder] = await f.db.select().from(storeOrder).where(eq(storeOrder.orderId, firstCreated.data.orderId)), oldLines = await f.db.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid, oldOrder.id)); expect(oldOrder).toMatchObject({ payPostage: '10.00', totalPostage: '10.00', totalNum: 2 }); expect(oldLines).toHaveLength(1); expect(oldLines[0]).toMatchObject({ skuUnique: 'sbtblu01', cartNum: 2 });
    const input = selection(await createCart()), oldQuote = await customer('/order/confirm', input); expect(oldQuote.status, oldQuote.msg).toBe(200); expect(oldQuote.data.priceGroup.pay_postage).toBe('10.00');
    await f.withShippingWriter(async runtime => { wiring.container = runtime.container; const detail = await opened(), before = await f.snapshot();
      const saved = await supplier('POST', '/setting/shipping_templates/save/60', { ...f.shippingBody('12.00'), expectedRevision: detail.revision }); expect(saved.status, saved.msg).toBe(200); onlyShippingChanged(before, await f.snapshot()); });
    await unchanged(async () => { const stale = await customer('/order/create/' + oldQuote.data.orderKey, { ...input, quoteToken: oldQuote.data.quoteToken, customForm: [] }); expect(stale.status).toBe(400); expect(stale.data).toMatchObject({ errorCode: 'ORDER_QUOTE_RECONFIRM_REQUIRED', orderKey: oldQuote.data.orderKey }); });
    const fresh = await customer('/order/confirm', input); expect(fresh.status, fresh.msg).toBe(200); expect(fresh.data.priceGroup).toMatchObject({ pay_postage: '14.00', total_postage: '14.00' });
    const created = await customer('/order/create/' + fresh.data.orderKey, { ...input, quoteToken: fresh.data.quoteToken, customForm: [] }); expect(created.status, created.msg).toBe(200);
    const [order] = await f.db.select().from(storeOrder).where(eq(storeOrder.orderId, created.data.orderId)); expect(order).toMatchObject({ payPostage: '14.00', totalPostage: '14.00', totalNum: 2, uid: 11 });
    expect((await f.db.select().from(storeOrder).where(eq(storeOrder.id, oldOrder.id)))[0]).toEqual(oldOrder); expect(await f.db.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid, oldOrder.id))).toEqual(oldLines);
    const after = await f.snapshot(); expect(after.store_order.filter(item => item.row.uid === 999)).toEqual(historicalSeed.store_order.filter(item => item.row.uid === 999)); expect(after.store_order_cart_info.filter(item => item.row.uid === 999)).toEqual(historicalSeed.store_order_cart_info.filter(item => item.row.uid === 999)); expect(after.system_form_data).toEqual(historicalSeed.system_form_data);
    const [sku] = await f.db.select().from(storeProductAttrValue).where(eq(storeProductAttrValue.id, initialSku.id)); expect(sku).toMatchObject({ unique: initialSku.unique, stock: initialSku.stock - 4, price: initialSku.price, cost: initialSku.cost, settlePrice: initialSku.settlePrice });
    expect((await f.db.select().from(storeProduct).where(eq(storeProduct.id, 80)))[0].stock).toBe(historicalSeed.store_product.find(item => item.row.id === 80)!.row.stock - 4);
  }, 90000);
});
