import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { PostgresJsSession } from 'drizzle-orm/postgres-js/session';
import { createApp } from '@/app';
import { createContainerFromDb, type Container } from '@/lib/di';
import { storeOrder, storeOrderCartInfo, storeProduct, storeProductAttrValue, systemAdmin, systemRole, systemSupplier, user, userAddress, systemAttachment } from '@/models/schema';
import { createToken, md5 } from '@/utils/jwt';
import { SupplierFulfillmentService } from '@/services/supplier/SupplierFulfillmentService';
import { supplierOrderReviewFixture, supplierReviewForm, supplierReviewLine } from './helpers/supplierOrderReview';
import { refundRuntimeFixture } from './helpers/refundRuntimeFixture';

const wiring = vi.hoisted(() => ({ container: undefined as Container | undefined }));
vi.mock('@/lib/di', async original => ({ ...await original<typeof import('@/lib/di')>(), createContainer: () => {
  if (!wiring.container) throw Error('Missing independent order review LOGIN'); return wiring.container;
} }));
type Envelope = { status: number; msg: string; data: any };
const app = createApp();
describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('Supplier ordinary order review actual App/JWT SELECT-only owned PG16', () => {
  let f: Awaited<ReturnType<typeof supplierOrderReviewFixture>>;
  beforeEach(async () => { f = await supplierOrderReviewFixture(); wiring.container = f.container;
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Order review must never call provider')); }, 30000);
  afterEach(async () => { try { expect(fetch).not.toHaveBeenCalled(); }
    finally { wiring.container = undefined; vi.restoreAllMocks(); await f?.close(); } }, 30000);
  const request = async (target: number | string = 100, actor: keyof typeof f.tokens | 'anonymous' = 'viewer') => {
    const response = await app.request('/supplierapi/order/info/' + target, { headers: actor === 'anonymous' ? {}
      : { Authorization: 'Bearer ' + f.tokens[actor], 'X-Supplier-Id': '8' } }, f.env);
    expect(response.headers.get('cache-control')).toContain('no-store'); return response.json<Envelope>();
  };
  async function unchanged<T>(work: () => Promise<T>) { const before = await f.snapshot(), seq = await f.sequences();
    const result = await work(); expect(await f.snapshot()).toEqual(before); expect(await f.sequences()).toEqual(seq); return result; }
  async function read(id = 100) { const response = await unchanged(() => request(id)); expect(response.status, response.msg).toBe(200); return response.data; }

  it('projects frozen recipient requirements settlement and separate customer money through genuine SELECT-only LOGIN without business writes', async () => f.withReader(async peer => {
    wiring.container = peer.container; const detail = await read();
    expect(detail).toMatchObject({ real_name: '冻结收货人', pay_price: '63.00', review: { version: 1, order_kind: 'order', original_order_id: null,
      recipient: { name: '冻结收货人', phone: '13800138000', address: f.expectedReview.address, mark: f.expectedReview.mark },
      buyer: { uid: 11, nickname: '当前买家昵称', phone: '13955556666', available: true },
      amounts: { quantity: 2, total_price: '60.00', total_postage: '3.00', pay_postage: '3.00', pay_price: '63.00', change_price: '0.00' },
      settlement: { items_total: '5.00', postage: '3.00', total: '8.00', availability: 'recorded' },
      items: [{ id: 1001, product_id: 70, product_name: '冻结核对商品', sku: '冻结红色,S', code: 'FROZEN-CODE', bar_code: 'FROZEN-BAR',
        quantity: 2, refund_quantity: 0, settlement_unit: '2.50', settlement_subtotal: '5.00' }] } });
    expect(typeof detail.cart_info[0].cartInfo).toBe('string'); expect(detail.cart_info[0].settlePrice).toBe('2.50');
    expect(Object.keys(detail.review).sort()).toEqual(['version','order_kind','original_order_id','recipient','buyer','amounts','items','settlement','form','invoice','promotions','virtual_delivery'].sort());
    expect(detail.review.invoice).toEqual({ state: 'none', reason: '', record: null });
    expect(detail.review.promotions).toEqual({ order_id: 100, state: 'none', reason: '', basis: null, total: null, items: [] });
    expect(detail.review.virtual_delivery).toEqual({ order_id: 100, state: 'not_applicable', basis: null, reason: '', entries: [] });
    expect(detail).not.toHaveProperty('user_address'); expect(detail).not.toHaveProperty('customForm');
    expect(JSON.stringify(detail.review)).not.toMatch(/costPrice|pwd|trade_no|user_ip|PRIVATE-UNCHANGED-ANSWER|spread_uid|余额|已到账/);
    const [rights] = await peer.db.execute(sql`SELECT current_user=session_user AS independent,
      has_schema_privilege(current_user,'public','CREATE') AS creates,has_table_privilege(current_user,'store_order','UPDATE') AS writes,
      has_any_column_privilege(current_user,'store_product_attr_value','UPDATE') AS stock,
      has_table_privilege(current_user,'system_form_data','SELECT') AS answer_catalog,
      has_table_privilege(current_user,'system_admin','UPDATE') AS auth_write,
      (SELECT count(*)::int FROM pg_class WHERE relnamespace='public'::regnamespace AND relowner=(SELECT oid FROM pg_roles WHERE rolname=current_user)) AS owns`);
    expect(rights).toEqual({ independent: true, creates: false, writes: false, stock: false, answer_catalog: false, auth_write: false, owns: 0 });
  }));

  it('keeps frozen address mark products and prices independent from current buyer address catalog SKU and form-data edits', async () => f.withReader(async peer => {
    wiring.container = peer.container; const before = await read();
    await f.db.update(userAddress).set({ realName: '现在的地址联系人', detail: '现在的可变地址' }).where(eq(userAddress.uid, 11));
    await f.db.update(user).set({ nickname: '当前资料已更新', phone: '13900001111' }).where(eq(user.uid, 11));
    await f.db.update(storeProduct).set({ storeName: '现在的目录标题', price: '999.00', settlePrice: '888.00' }).where(eq(storeProduct.id, 70));
    await f.db.update(storeProductAttrValue).set({ price: '777.00', settlePrice: '666.00', code: 'CURRENT', barCode: 'CURRENT' }).where(eq(storeProductAttrValue.id, 70));
    const current = await read(); expect(current.review.recipient).toEqual(before.review.recipient); expect(current.review.items).toEqual(before.review.items);
    expect(current.review.settlement).toEqual(before.review.settlement); expect(current.review.buyer).toMatchObject({ nickname: '当前资料已更新', phone: '13900001111' });
    expect(current.review.form.map((row: any) => [row.title, row.value])).toEqual(before.review.form.map((row: any) => [row.title, row.value]));
  }));

  it('signs only actual order-owner form images and serves the real signed owned asset without granting answer catalog access', async () => f.withReader(async peer => {
    wiring.container = peer.container; const detail = await read(), form = detail.review.form;
    expect(form.slice(0, 2)).toEqual([{ id: 'requirements', title: '收货要求', value: '请保留原包装\n工作日配送', images: [] },
      { id: 'date', title: '预约日期', value: '2026-10-20 / 2026-10-21', images: [] }]);
    expect(form[2]).toMatchObject({ id: 'photo', title: '客户上传凭证', value: '', images: [expect.stringMatching(/^\/api\/assets\/31\?expires=\d+&signature=/)] });
    expect(JSON.stringify(form)).not.toMatch(/assets\/32|ImageScope|digest|PRIVATE/);
    await unchanged(async () => { const asset = await app.request(form[2].images[0], {}, f.env); expect(asset.status).toBe(200);
      expect(asset.headers.get('content-type')).toBe('image/png'); expect((await asset.arrayBuffer()).byteLength).toBeGreaterThan(0); });
    expect(f.r2Reads).toEqual([f.images.ownedKey]);
    await f.db.update(systemAttachment).set({ relationId: 12 }).where(eq(systemAttachment.attId, 31));
    expect((await read()).review.form[2].images).toEqual([]);
  }));

  it.each([{ id: 201, original: 'tracking-own-200' }, { id: 301, original: 'tracking-own-300' }])
    ('returns only coherent original-number scalar and actual child quantity for order$id', async ({ id, original }) => f.withReader(async peer => {
      wiring.container = peer.container; const current = await read(id); expect(current.review.original_order_id).toBe(original);
      expect(current.review.items[0].quantity).toBe(1); expect(JSON.parse(current.cart_info[0].cartInfo).cart_num).toBe(999);
      expect(current.review.settlement).toEqual({ items_total: '2.50', postage: '1.50', total: '4.00', availability: 'recorded' });
      expect(JSON.stringify(current.review)).not.toMatch(/tracking-own-900|supplier_id|PRIVATE/);
    }));

  it.each([{ patch: { uid: 12 } }, { patch: { supplierId: 8 } }, { patch: { storeId: 2 } },
    { patch: { pid: 0 } }, { patch: { isSystemDel: 1 } }])('does not expose an incoherent parent number $patch', async ({ patch }) => f.withReader(async peer => {
      wiring.container = peer.container; await f.db.update(storeOrder).set(patch).where(eq(storeOrder.id, 200));
      expect((await read(201)).review.original_order_id).toBeNull();
    }));

  it('distinguishes retained own payment summary from leaf orders without combining money twice', async () => f.withReader(async peer => {
    wiring.container = peer.container; expect((await read(200)).review).toMatchObject({ order_kind: 'payment_summary', original_order_id: null,
      amounts: { quantity: 2, pay_price: '63.00' }, settlement: { total: '8.00' } });
    expect((await request(300)).status).toBe(404);
  }));

  it.each([{ info: null }, { info: '' }, { info: '{}' }, { info: JSON.stringify({ productInfo: { store_name: '旧商品' } }) },
    { info: JSON.stringify({ financial_version: 'refund-order-line-finance-v1', legacy_php_financial_source: 'original-php-purchase-facts-v1', sku: { price: '30.00' } }) }])
    ('preserves legal legacy raw value $info but never promotes unknown zero to a known settlement', async ({ info }) => f.withReader(async peer => {
      wiring.container = peer.container; await f.db.update(storeOrderCartInfo).set({ type: 0, relationId: 0, settlePrice: '0.00', cartInfo: info }).where(eq(storeOrderCartInfo.oid, 100));
      const current = await read(); expect(current.cart_info[0].cartInfo).toBe(info); expect(current.review.items[0]).toMatchObject({ settlement_unit: null, settlement_subtotal: null });
      expect(current.review.settlement).toEqual({ items_total: null, postage: '3.00', total: null, availability: 'incomplete' });
    }));

  it.each([{ info: { ...supplierReviewLine(), sku: { price: '30.00' } } },
    { info: { financial_version: 'refund-order-line-finance-v1', sku: { price: '30.00' } } },
    { info: { productInfo: { store_name: '旧冻结零价商品', attrInfo: { settle_price: '0.00' } } } }])
    ('keeps an explicitly recorded true zero distinct from unknown legacy zero', async ({ info }) => f.withReader(async peer => {
      wiring.container = peer.container; await f.db.update(storeOrderCartInfo).set({ settlePrice: '0.00', cartInfo: JSON.stringify(info) }).where(eq(storeOrderCartInfo.oid, 100));
      expect((await read()).review.settlement).toEqual({ items_total: '0.00', postage: '3.00', total: '3.00', availability: 'recorded' });
    }));

  it('does not declare empty lines a known zero and preserves signed change price and actual refund quantities', async () => f.withReader(async peer => {
    wiring.container = peer.container; await f.db.update(storeOrder).set({ changePrice: '-1.50' }).where(eq(storeOrder.id, 100));
    await f.db.update(storeOrderCartInfo).set({ refundNum: 1 }).where(eq(storeOrderCartInfo.oid, 100));
    expect((await read()).review).toMatchObject({ amounts: { change_price: '-1.50' }, items: [{ quantity: 2, refund_quantity: 1, settlement_subtotal: '5.00' }] });
    await f.db.delete(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid, 100)); expect((await read()).review.settlement).toMatchObject({ availability: 'incomplete', total: null });
  }));

  it.each([{ shipping: 2 }, { shipping: 4 }])('does not include collection or cashier postage in settlement shipping$shipping', async ({ shipping }) => f.withReader(async peer => {
    wiring.container = peer.container; await f.db.update(storeOrder).set({ shippingType: shipping }).where(eq(storeOrder.id, 100));
    expect((await read()).review).toMatchObject({ amounts: { pay_postage: '3.00' }, settlement: { items_total: '5.00', postage: '0.00', total: '5.00' } });
  }));

  it('keeps private review detail out of the shared list payload', async () => f.withReader(async peer => {
    wiring.container = peer.container; const result = await unchanged(async () => (await app.request('/supplierapi/order/list?order=tracking-own-100',
      { headers: { Authorization: 'Bearer ' + f.tokens.viewer } }, f.env)).json<Envelope>());
    expect(result.status, result.msg).toBe(200); expect(result.data.list).toHaveLength(1);
    expect(result.data.list[0]).not.toHaveProperty('review'); expect(JSON.stringify(result.data.list)).not.toMatch(/冻结省市区|买家冻结备注|custom_form|system_form_data/);
  }));

  it('does not allow one legacy cart to hide a mixed foreign-owned sibling', async () => f.withReader(async peer => {
    wiring.container = peer.container; await f.db.update(storeOrderCartInfo).set({ type: 0, relationId: 0 }).where(eq(storeOrderCartInfo.oid, 100));
    await f.db.insert(storeOrderCartInfo).values({ oid: 100, uid: 11, type: 2, relationId: 8, cartNum: 1, settlePrice: '1.00', cartInfo: '{}' });
    expect((await unchanged(() => request())).status).toBe(400);
  }));

  it('rejects an aggregate above eight MiB even when every one of the bounded 129 snapshots is exactly sixty-four KiB', async () => f.withReader(async peer => {
    wiring.container = peer.container;
    const info = JSON.stringify({ padding: 'x'.repeat(65536 - JSON.stringify({ padding: '' }).length) });
    expect(new TextEncoder().encode(info).length).toBe(65536);
    await f.db.delete(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid, 100));
    await f.db.insert(storeOrderCartInfo).values(Array.from({ length: 129 }, (_, index) => ({ id: 10000 + index,
      oid: 100, uid: 11, type: 2, relationId: 7, cartId: String(10000 + index), cartNum: 1, settlePrice: '1.00', cartInfo: info })));
    expect((await unchanged(() => request())).status).toBe(400);
  }));

  it.each([{ value: null }, { value: '' }, { value: 'not-json' }, { value: '[]' }, { value: '[{"name":"texts","value":{}}]' }])
    ('does not let malformed optional historical forms break ordinary detail $value', async ({ value }) => f.withReader(async peer => {
      wiring.container = peer.container; await f.db.update(storeOrder).set({ customForm: value }).where(eq(storeOrder.id, 100)); expect((await read()).review.form).toEqual([]);
    }));

  it('reads guest or missing-current-buyer orders without borrowing a shared identity', async () => f.withReader(async peer => {
    wiring.container = peer.container; await f.db.update(storeOrder).set({ uid: 0, customForm: JSON.stringify(supplierReviewForm()) }).where(eq(storeOrder.id, 100));
    await f.db.update(storeOrderCartInfo).set({ uid: 0 }).where(eq(storeOrderCartInfo.oid, 100));
    expect((await read()).review).toMatchObject({ buyer: { uid: 0, nickname: '', phone: '', available: false }, form: [{}, {}, { images: [] }] });
    await f.db.update(storeOrder).set({ uid: 99 }).where(eq(storeOrder.id, 100)); await f.db.update(storeOrderCartInfo).set({ uid: 99 }).where(eq(storeOrderCartInfo.oid, 100));
    expect((await read()).review.buyer).toEqual({ uid: 99, nickname: '', phone: '', available: false });
  }));

  it('does not expose deleted buyer profile while keeping inactive profile facts distinct from account authority', async () => f.withReader(async peer => {
    wiring.container = peer.container; await f.db.update(user).set({ status: 0 }).where(eq(user.uid, 11));
    expect((await read()).review.buyer).toMatchObject({ uid: 11, available: true, nickname: '当前买家昵称' });
    await f.db.update(user).set({ isDel: 1 }).where(eq(user.uid, 11));
    expect((await read()).review.buyer).toEqual({ uid: 11, nickname: '', phone: '', available: false });
  }));

  it('preserves a legal sixty-codepoint current buyer nickname and fifteen-codepoint phone without UTF16 truncation', async () => f.withReader(async peer => {
    wiring.container = peer.container; const nickname = '😀'.repeat(60), phone = '📞'.repeat(15);
    await f.db.update(user).set({ nickname, phone }).where(eq(user.uid, 11));
    expect((await read()).review.buyer).toEqual({ uid: 11, nickname, phone, available: true });
  }));

  it('reads a coherent thirty-two-codepoint original order number without UTF16 rejection', async () => f.withReader(async peer => {
    wiring.container = peer.container; const number = '📦'.repeat(32);
    await f.db.update(storeOrder).set({ orderId: number }).where(eq(storeOrder.id, 200));
    expect((await read(201)).review.original_order_id).toBe(number);
  }));

  it.each([{ patch: { uid: 12 } }, { patch: { type: 2, relationId: 8 } }, { patch: { cartInfo: '{' } },
    { patch: { cartInfo: '[]' } }, { patch: { cartInfo: JSON.stringify({ padding: 'x'.repeat(65536) }) } }, { patch: { settlePrice: '-0.01' } },
    { patch: { refundNum: 3 } }])('rejects corrupt or foreign core cart facts $patch with zero writes', async ({ patch }) => f.withReader(async peer => {
      wiring.container = peer.container; await f.db.update(storeOrderCartInfo).set(patch).where(eq(storeOrderCartInfo.oid, 100));
      const rejected = await unchanged(() => request()); expect(rejected.status).toBe(400);
    }));

  it('requires genuine Supplier view authority and preserves customer-deleted history while denying foreign system-deleted orders', async () => f.withReader(async peer => {
    wiring.container = peer.container;
    for (const actor of ['anonymous','admin','customer','kefu','denied','foreign'] as const) expect((await unchanged(() => request(100, actor))).status).not.toBe(200);
    expect((await unchanged(() => request(900))).status).toBe(404);
    await f.db.update(storeOrder).set({ isDel: 1 }).where(eq(storeOrder.id, 100)); expect((await read()).id).toBe(100);
    await f.db.update(storeOrder).set({ isSystemDel: 1 }).where(eq(storeOrder.id, 100)); expect((await unchanged(() => request())).status).toBe(404);
  }));

  it('keeps profile and attachment SQL failures honest instead of returning fabricated unavailable data', async () => f.withReader(async peer => {
    wiring.container = peer.container;
    await f.exec(`REVOKE SELECT ON public.system_attachment FROM "${peer.role}"`); expect((await unchanged(() => request())).status).not.toBe(200);
    await f.exec(`GRANT SELECT ON public.system_attachment TO "${peer.role}"; REVOKE SELECT ON public."user" FROM "${peer.role}"`);
    expect((await unchanged(() => request())).status).not.toBe(200);
  }));

  it('uses one read-only repeatable snapshot for header lines current buyer and form while a real independent writer commits', async () => f.withReader(async peer => {
    wiring.container = peer.container; const sequence = await f.sequences(); let reached = false, expected: Awaited<ReturnType<typeof f.snapshot>> | undefined;
    const actual = PostgresJsSession.prototype.prepareQuery;
    const spy = vi.spyOn(PostgresJsSession.prototype, 'prepareQuery').mockImplementation(function (this: InstanceType<typeof PostgresJsSession>, ...args) {
      const prepared = actual.apply(this, args);
      if (/^select .* from "store_order" where /s.test(args[0].sql)) {
        const execute = prepared.execute.bind(prepared); prepared.execute = async values => { const result = await execute(values);
          if (!reached) { reached = true; const [settings] = await this.client.unsafe("SELECT current_setting('transaction_read_only') AS readonly,current_setting('statement_timeout') AS timeout");
            expect(settings).toEqual({ readonly: 'on', timeout: '5s' });
            await f.db.update(storeOrder).set({ mark: '已独立提交的新备注' }).where(eq(storeOrder.id, 100));
            await f.db.update(user).set({ nickname: '已独立提交的新昵称' }).where(eq(user.uid, 11)); expected = await f.snapshot(); }
          return result; };
      }
      return prepared;
    });
    try { const response = await request(); expect(response.status, response.msg).toBe(200); expect(response.data.review.recipient.mark).toBe(f.expectedReview.mark);
      expect(response.data.review.buyer.nickname).toBe('当前买家昵称'); } finally { spy.mockRestore(); }
    expect(reached).toBe(true); expect(await f.snapshot()).toEqual(expected); expect(await f.sequences()).toEqual(sequence);
    expect((await read()).review.buyer.nickname).toBe('已独立提交的新昵称');
  }));

  it.each([{ zero: false }, { zero: true }])('connects actual checkout and fulfillment split to Supplier review using recorded settlement rather than procurement or current retail; genuine zero=$zero', async ({ zero }) => {
    const whole = await refundRuntimeFixture();
    try {
      const key = 'owned-review-actual-checkout';
      await whole.db.insert(systemRole).values({ id: 990, type: 4, relationId: 7, rules: 'supplier.order.view' });
      await whole.db.insert(systemAdmin).values({ id: 990, account: 'review-actual-reader', pwd: key, adminType: 4, relationId: 7, roles: '990' });
      await whole.db.update(systemSupplier).set({ adminId: 990 }).where(eq(systemSupplier.id, 7));
      const token = (await createToken(990, 'supplier', md5(key), f.env.APP_KEY)).token;
      if (zero) {
        await whole.db.update(storeProduct).set({ settlePrice: '0.00' }).where(eq(storeProduct.id, 70));
        await whole.db.update(storeProductAttrValue).set({ settlePrice: '0.00' }).where(eq(storeProductAttrValue.id, 1));
      }
      await whole.withRuntime(async writer => {
        const original = await writer.createPaid({ key: 'actual-review-checkout', orderId: 'actual_review_checkout' });
        const split = await new SupplierFulfillmentService(writer.container, whole.env).splitDelivery(7, original.id,
          { deliveryType: 'express', deliveryName: 'Local', deliveryCode: 'local', deliveryId: 'REVIEW-ONLY', fictitiousContent: '', deliveryUid: 0 },
          [{ cartId: (await writer.carts(original.id)).find(row => row.productId === 70)!.cartId, cartNum: 1 }]);
        const saved = await writer.order(split.order_id); const lines = await writer.carts(saved.id);
        const frozen = lines.map(row => ({ id: row.id, quantity: row.cartNum, unit: row.settlePrice }));
        await whole.db.update(storeProductAttrValue).set({ settlePrice: '888.00', price: '999.00', cost: '777.00' }).where(eq(storeProductAttrValue.id, 1));
        await whole.withRuntimeRole!(async peer => {
          await whole.exec(`GRANT SELECT ON public.system_admin,public.system_role,public.system_supplier,public.system_menus,public.store_order,public.store_order_cart_info,public.store_order_invoice,public.store_order_promotions,public.store_promotions,public."user",public.system_attachment TO "${peer.role}"`);
          wiring.container = createContainerFromDb(peer.db);
          const allRows = async () => {
            const result: Record<string, unknown> = {};
            for (const table of (await whole.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows) {
              if (!/^[a-z][a-z0-9_]*$/.test(table.tablename)) throw Error('Unowned review runtime table');
              result[table.tablename] = (await whole.query(`SELECT to_jsonb(t) AS row FROM public."${table.tablename}" t ORDER BY to_jsonb(t)::text`)).rows;
            }
            for (const sequence of (await whole.query("SELECT sequencename FROM pg_sequences WHERE schemaname='public' ORDER BY sequencename")).rows) {
              if (!/^[a-z][a-z0-9_]*$/.test(sequence.sequencename)) throw Error('Unowned review runtime sequence');
              result['sequence:' + sequence.sequencename] = (await whole.query(`SELECT last_value,is_called FROM public."${sequence.sequencename}"`)).rows;
            }
            return result;
          };
          const before = await allRows(), response = await app.request('/supplierapi/order/info/' + saved.id,
            { headers: { Authorization: 'Bearer ' + token } }, { ...whole.env, APP_KEY: f.env.APP_KEY, NODE_ENV: 'test' });
          const result = await response.json<Envelope>(); expect(result.status, result.msg).toBe(200);
          expect(result.data.review.original_order_id).toBe(original.orderId); expect(result.data.review.order_kind).toBe('order');
          expect(result.data.review.items.map((row: any) => ({ id: row.id, quantity: row.quantity, unit: row.settlement_unit }))).toEqual(frozen);
          const cents = lines.reduce((sum, row) => sum + Math.round(Number(row.settlePrice) * 100) * row.cartNum, 0);
          expect(result.data.review.settlement.items_total).toBe((cents / 100).toFixed(2));
          expect(result.data.review.items[0].settlement_unit).toBe(zero ? '0.00' : '2.50'); expect(result.data.review.items[0].settlement_unit).not.toBe('2.00');
          if (zero) {
            const snapshot = JSON.parse(lines[0].cartInfo!);
            expect(snapshot.financial_version).toBe('checkout-line-finance-v1');
            expect(snapshot.sku).not.toHaveProperty('settlePrice'); expect(snapshot.sku).not.toHaveProperty('settle_price');
            expect(result.data.review.settlement.availability).toBe('recorded');
          }
          expect(await allRows()).toEqual(before);
        });
      });
    } finally { await whole.close(); }
  }, 120000);
});
