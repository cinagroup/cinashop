import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, inArray, sql } from 'drizzle-orm';
import { PostgresJsSession } from 'drizzle-orm/postgres-js/session';
import { createApp } from '@/app';
import { createContainerFromDb, withTx, type Container } from '@/lib/di';
import { storeCart, storeOrder, storeOrderCartInfo, storeProduct, storeProductAttrValue, storeProductVirtual,
  systemAdmin, systemRole, systemSupplier, user } from '@/models/schema';
import { deliverPaidVirtualOrders } from '@/services/order/VirtualProductDeliveryService';
import { allocatePaidOrderBySupplier } from '@/services/order/OrderSupplierAllocationService';
import { recordSupplierPayment } from '@/services/supplier/SupplierFinanceService';
import { SupplierOrderReadService } from '@/services/supplier/SupplierOrderReadService';
import { createToken, md5 } from '@/utils/jwt';
import { supplierOrderVirtualReviewFixture } from './helpers/supplierOrderVirtualReview';
import { refundRuntimeFixture } from './helpers/refundRuntimeFixture';

const wiring = vi.hoisted(() => ({ container: undefined as Container | undefined }));
vi.mock('@/lib/di', async original => ({ ...await original<typeof import('@/lib/di')>(), createContainer: () => {
  if (!wiring.container) throw Error('Missing actual virtual-review LOGIN'); return wiring.container;
} }));
const app = createApp();
type Envelope = { status: number; msg: string; data: any };
const surfaces = ['detail', 'shipment', 'pending'] as const;
const path = (surface: typeof surfaces[number], id: number) => `/supplierapi/order/${surface === 'detail' ? 'info' : surface === 'shipment' ? 'split_order' : 'split_cart_info'}/${id}`;

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('Supplier exact virtual delivery record actual App JWT SELECT-only PG16', () => {
  let f: Awaited<ReturnType<typeof supplierOrderVirtualReviewFixture>>;
  beforeEach(async () => { f = await supplierOrderVirtualReviewFixture(); wiring.container = f.container;
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Virtual review must not call providers')); }, 30000);
  afterEach(async () => { try { expect(fetch).not.toHaveBeenCalled(); }
    finally { wiring.container = undefined; vi.restoreAllMocks(); await f?.close(); } }, 30000);
  async function unchanged<T>(work: () => Promise<T>) {
    const before = await f.snapshot(), seq = await f.sequences(); const result = await work();
    expect(await f.snapshot()).toEqual(before); expect(await f.sequences()).toEqual(seq); return result;
  }
  async function request(id = 100, actor: keyof typeof f.tokens | 'anonymous' = 'viewer', surface: typeof surfaces[number] = 'detail') {
    return unchanged(async () => {
      const response = await app.request(path(surface, id), { headers: actor === 'anonymous' ? {}
        : { Authorization: 'Bearer ' + f.tokens[actor], 'X-Supplier-Id': '8' } }, f.env);
      expect(response.headers.get('Cache-Control')).toContain('private'); expect(response.headers.get('Cache-Control')).toContain('no-store');
      return response.json<Envelope>();
    });
  }
  async function read(id = 100, surface: typeof surfaces[number] = 'detail') {
    const r = await request(id, 'viewer', surface); expect(r.status, r.msg).toBe(200); return r.data;
  }
  async function unavailable(id = 100) { expect((await read(id)).review.virtual_delivery).toMatchObject({ state: 'unavailable', basis: null, entries: [] }); }

  it.each([100, 201, 301, 111])('reads exact modern or proven PHP legacy record %s with a genuine SELECT-only LOGIN', async id => f.withReader(async peer => {
    wiring.container = peer.container;
    const [rights] = await peer.db.execute(sql`SELECT current_user=session_user AS independent,
      has_table_privilege(current_user,'store_product_virtual','SELECT') AS reads,
      has_any_column_privilege(current_user,'store_product_virtual','UPDATE') AS updates,
      has_table_privilege(current_user,'store_product_virtual','INSERT') AS inserts,
      has_schema_privilege(current_user,'public','CREATE') AS creates`);
    expect(rights).toEqual({ independent: true, reads: true, updates: false, inserts: false, creates: false });
    const actual = (await read(id)).review.virtual_delivery; expect(actual).toEqual(f.expectedVirtual.get(id));
    if (id === 100) expect(actual.entries[0]).toMatchObject({ card_no: '', card_pwd: '  PASSWORD-100-1001-0\n' });
  }));

  it.each(surfaces)('redacts only known type1 disk paths at the %s output and retains internal fixed-content evidence', async surface => f.withReader(async peer => {
    wiring.container = peer.container;
    for (const id of [301, 111]) {
      if (surface === 'pending') {
        await f.db.update(storeOrder).set({ paid: 1, status: 0, deliveryType: '' }).where(eq(storeOrder.id, id));
        const rows = await f.db.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid, id));
        for (const row of rows) await f.db.update(storeOrderCartInfo).set({ splitStatus: 0, splitSurplusNum: row.cartNum }).where(eq(storeOrderCartInfo.id, row.id));
      }
      const actual = await read(id, surface);
      const carts = surface === 'detail' ? actual.cart_info : surface === 'shipment' ? actual.flatMap((r: any) => r.cart_info) : actual;
      expect(carts).not.toHaveLength(0);
      for (const row of carts) {
        const snapshot = surface === 'detail' ? JSON.parse(row.cartInfo) : row.cart_info;
        if (id === 301) {
          expect(snapshot.productInfo.attrInfo).not.toHaveProperty('disk_info'); expect(snapshot.attrInfo).not.toHaveProperty('disk_info');
          expect(snapshot.productInfo.store_name).toBe('旧分摊商品');
        } else expect(snapshot.sku).not.toHaveProperty('disk_info');
      }
      const [stored] = await f.db.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid, id));
      const frozen = JSON.parse(stored.cartInfo!);
      expect(id === 301 ? frozen.productInfo.attrInfo.disk_info : frozen.sku.disk_info).toBe(id === 301 ? f.virtualContent.legacy : f.virtualContent.modern.trim());
      if (surface === 'detail') expect(actual.review.virtual_delivery).toEqual(f.expectedVirtual.get(id));
    }
  }));

  it.each(surfaces)('does not bypass %s raw redaction when a type1 order has a wrong cart productType', async surface => f.withReader(async peer => {
    wiring.container = peer.container;
    await f.db.update(storeOrderCartInfo).set({ productType: 0 }).where(eq(storeOrderCartInfo.oid, 301));
    if (surface === 'pending') await f.db.update(storeOrder).set({ status: 0, deliveryType: '' }).where(eq(storeOrder.id, 301));
    const actual = await read(301, surface);
    const carts = surface === 'detail' ? actual.cart_info : surface === 'shipment' ? actual.flatMap((r: any) => r.cart_info) : actual;
    expect(carts).not.toHaveLength(0);
    for (const row of carts) {
      const snapshot = surface === 'detail' ? JSON.parse(row.cartInfo) : row.cart_info;
      expect(snapshot.productInfo.attrInfo).not.toHaveProperty('disk_info'); expect(snapshot.attrInfo).not.toHaveProperty('disk_info');
    }
    if (surface === 'detail') expect(actual.review.virtual_delivery).toMatchObject({ state: 'unavailable', entries: [], basis: null });
  }));

  it.each([{ uid: 12 }, { type: 2, relationId: 8 }])('rejects wrong complete-cart ownership before any sensitive payload %#', async patch => f.withReader(async peer => {
    wiring.container = peer.container; await f.db.update(storeOrderCartInfo).set(patch).where(eq(storeOrderCartInfo.id, 1001));
    const response = await request(); expect(response.status).not.toBe(200); expect(response.data).toBeNull();
  }));

  it('keeps type0 raw JSON text exactly compatible and never adds a delivery to list/header', async () => f.withReader(async peer => {
    wiring.container = peer.container;
    await f.db.update(storeOrder).set({ productType: 0 }).where(eq(storeOrder.id, 100));
    const [row] = await f.db.update(storeOrderCartInfo).set({ productType: 0, cartInfo: ' {"product":{"storeName":"旧原文"},"sku":{"suk":"默认","disk_info":"type0 unchanged"}} ' })
      .where(eq(storeOrderCartInfo.id, 1001)).returning();
    const actual = await read(); expect(actual.cart_info.find((r: any) => r.id === 1001).cartInfo).toBe(row.cartInfo);
    expect(actual.review.virtual_delivery).toMatchObject({ state: 'not_applicable', entries: [], basis: null });
    const response = await unchanged(async () => app.request('/supplierapi/order/list?order=tracking-own-100&field_key=order_id', { headers: { Authorization: 'Bearer ' + f.tokens.viewer } }, f.env));
    const data = (await response.json<Envelope>()).data.list[0]; expect(data).not.toHaveProperty('virtual_info'); expect(data).not.toHaveProperty('virtualInfo'); expect(data).not.toHaveProperty('review');
  }));

  it.each([{ paid: 0, status: 1, deliveryType: 'fictitious' }, { paid: 1, status: 0, deliveryType: '' },
    { paid: 1, status: 0, deliveryType: 'fictitious' }])('does not expose a non-delivered record $paid/$status/$deliveryType through a stale payload', async patch => f.withReader(async peer => {
    wiring.container = peer.container; await f.db.update(storeOrder).set(patch).where(eq(storeOrder.id, 111));
    const actual = await read(111); expect(actual.review.virtual_delivery).toMatchObject({ state: 'not_delivered', entries: [], basis: null });
    expect(actual.cart_info[0].cartInfo).not.toContain('disk_info'); expect(actual.cart_info[0].cartInfo).not.toContain('下载地址');
  }));

  it('does not aggregate owned payment-root secrets and validates coherent exact child ancestry', async () => f.withReader(async peer => {
    wiring.container = peer.container; await unavailable(200);
    expect(JSON.stringify((await read(200)).cart_info)).not.toContain('UNDELIVERED-OR-ROOT-PRIVATE');
    await f.db.update(storeOrder).set({ uid: 12 }).where(eq(storeOrder.id, 200)); await unavailable(201);
  }));

  it('keeps already delivered cards after later partial or complete refunded quantities', async () => f.withReader(async peer => {
    wiring.container = peer.container;
    await f.db.update(storeOrderCartInfo).set({ refundNum: 2 }).where(eq(storeOrderCartInfo.id, 1001));
    await f.db.update(storeOrderCartInfo).set({ refundNum: 1 }).where(eq(storeOrderCartInfo.id, 1002));
    await f.db.update(storeOrder).set({ refundStatus: 2 }).where(eq(storeOrder.id, 100));
    expect((await read()).review.virtual_delivery).toEqual(f.expectedVirtual.get(100));
  }));

  it('does not assume passwords or password-only cards are unique when matching the exact claimed multiset', async () => f.withReader(async peer => {
    wiring.container = peer.container;
    const cards = await f.db.select().from(storeProductVirtual).where(eq(storeProductVirtual.orderId, 'tracking-own-100')).orderBy(storeProductVirtual.id);
    await f.db.update(storeProductVirtual).set({ cardNo: '', cardPwd: ' SAME\n' }).where(inArray(storeProductVirtual.id, cards.map(c => c.id)));
    const [order] = await f.db.select().from(storeOrder).where(eq(storeOrder.id, 100));
    const payload = JSON.parse(order.virtualInfo!).map((r: any) => ({ ...r, card_no: '', card_pwd: ' SAME\n' }));
    await f.db.update(storeOrder).set({ virtualInfo: JSON.stringify(payload) }).where(eq(storeOrder.id, 100));
    const delivery = (await read()).review.virtual_delivery; expect(delivery.state).toBe('recorded'); expect(delivery.entries).toHaveLength(3);
  }));

  it.each([{ name: 'null', value: null, omitted: false }, { name: 'string zero', value: '0', omitted: false },
    { name: 'missing', value: undefined, omitted: true }])('preserves actual PHP $name disk_info inventory-card mode', async ({ value, omitted }) => f.withReader(async peer => {
    wiring.container = peer.container;
    const rows = await f.db.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid, 201));
    for (const row of rows) {
      const snapshot = JSON.parse(row.cartInfo!);
      if (omitted) { delete snapshot.productInfo.attrInfo.disk_info; delete snapshot.attrInfo.disk_info; }
      else { snapshot.productInfo.attrInfo.disk_info = value; snapshot.attrInfo.disk_info = value; }
      await f.db.update(storeOrderCartInfo).set({ cartInfo: JSON.stringify(snapshot) }).where(eq(storeOrderCartInfo.id, row.id));
    }
    expect((await read(201)).review.virtual_delivery).toEqual(f.expectedVirtual.get(201));
  }));

  it('retains modern string zero as actual frozen fixed content rather than PHP card-mode coercion', async () => f.withReader(async peer => {
    wiring.container = peer.container;
    const [row] = await f.db.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.id, 1111));
    const snapshot = JSON.parse(row.cartInfo!); snapshot.sku.disk_info = '0';
    await f.db.update(storeOrderCartInfo).set({ cartInfo: JSON.stringify(snapshot) }).where(eq(storeOrderCartInfo.id, row.id));
    await f.db.update(storeOrder).set({ virtualInfo: JSON.stringify([{ disk_info: '0', product_id: row.productId, sku_unique: row.skuUnique, quantity: row.cartNum }]) }).where(eq(storeOrder.id, 111));
    expect((await read(111)).review.virtual_delivery).toMatchObject({ state: 'recorded', basis: 'modern', entries: [{ kind: 'content', content: '0', quantity: 2 }] });
  }));

  it('does not replace frozen content or labels with current product/SKU changes', async () => f.withReader(async peer => {
    wiring.container = peer.container; await f.db.update(storeProduct).set({ storeName: 'CURRENT SECRET', isDel: 1 }).where(eq(storeProduct.id, 70));
    await f.db.update(storeProductAttrValue).set({ diskInfo: 'CURRENT OTHER CONTENT', suk: 'CURRENT SKU' }).where(eq(storeProductAttrValue.productId, 70));
    expect((await read(111)).review.virtual_delivery).toEqual(f.expectedVirtual.get(111));
  }));

  it.each([{ name: 'wrong UID', patch: { uid: 12 } }, { name: 'wrong order type', patch: { orderType: 2 } },
    { name: 'wrong product', patch: { productId: 999 } }, { name: 'wrong SKU', patch: { attrUnique: 'wrongsku' } },
    { name: 'blank password', patch: { cardPwd: ' \n' } }])('refuses claimed-card $name without returning partial secrets', async ({ patch }) => f.withReader(async peer => {
    wiring.container = peer.container; await f.db.update(storeProductVirtual).set(patch).where(eq(storeProductVirtual.id, 10001)); await unavailable();
  }));

  it.each([{ name: 'empty', value: [] }, { name: 'nonarray', value: {} }, { name: 'bad member', value: [null] },
    { name: 'extra keys', value: [{ card_no: '', card_pwd: '  PASSWORD-100-1001-0\n', extra: true }] },
    { name: 'missing modern association', value: [{ card_no: '', card_pwd: '  PASSWORD-100-1001-0\n' }] },
    { name: 'oversized rows', value: Array.from({ length: 2001 }, () => ({})) }])('rejects $name delivery format without secret fallback', async ({ value }) => f.withReader(async peer => {
    wiring.container = peer.container; await f.db.update(storeOrder).set({ virtualInfo: JSON.stringify(value) }).where(eq(storeOrder.id, 100)); await unavailable();
  }));

  it('rejects malformed or oversized JSON and proves SQL withholds oversized payload before transfer', async () => f.withReader(async peer => {
    wiring.container = peer.container; let withheld = false;
    const original = PostgresJsSession.prototype.prepareQuery;
    const spy = vi.spyOn(PostgresJsSession.prototype, 'prepareQuery').mockImplementation(function (this: InstanceType<typeof PostgresJsSession>, ...args) {
      const prepared = original.apply(this, args);
      if (/CASE WHEN octet_length\([^)]*"virtual_info"/.test(args[0].sql)) {
        const execute = prepared.execute.bind(prepared); prepared.execute = async values => {
          const result = await execute(values);
          if (Array.isArray(result) && result.some((row: any) => row.oversized === true && row.raw === null)) withheld = true;
          return result;
        };
      } return prepared;
    });
    try { for (const virtualInfo of ['{', '"' + 'x'.repeat(1048576) + '"']) {
      await f.db.update(storeOrder).set({ virtualInfo }).where(eq(storeOrder.id, 100)); await unavailable();
    } } finally { spy.mockRestore(); }
    expect(withheld).toBe(true);
  }));

  it('rejects missing, duplicated or extra payload cards against the exact claimed multiset', async () => f.withReader(async peer => {
    wiring.container = peer.container; const [order] = await f.db.select().from(storeOrder).where(eq(storeOrder.id, 100)); const cards = JSON.parse(order.virtualInfo!);
    for (const value of [cards.slice(1), [cards[0], cards[0], cards[2]], [...cards, cards[0]]]) {
      await f.db.update(storeOrder).set({ virtualInfo: JSON.stringify(value) }).where(eq(storeOrder.id, 100)); await unavailable();
    }
  }));

  it('rejects an unproven historical activity/base SKU alias rather than reading current SKU metadata', async () => f.withReader(async peer => {
    wiring.container = peer.container; await f.db.update(storeProductVirtual).set({ attrUnique: 'old_base_sku' }).where(eq(storeProductVirtual.id, 10004)); await unavailable(201);
  }));

  it.each([{ financial_version: 'checkout-line-finance-v1' },
    { financial_version: 'refund-order-line-finance-v1', legacy_php_financial_source: null },
    { financial_version: 'refund-order-line-finance-v1', legacy_php_financial_source: 'unknown' },
    { financial_version: 'checkout-line-finance-v1', legacy_php_financial_source: 'original-php-purchase-facts-v1' }])
    ('does not downgrade modern or invalid provenance into bare PHP card-pair authority %#', async patch => f.withReader(async peer => {
      wiring.container = peer.container;
      const [row] = await f.db.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.id, 2002));
      await f.db.update(storeOrderCartInfo).set({ cartInfo: JSON.stringify({ ...JSON.parse(row.cartInfo!), ...patch }) }).where(eq(storeOrderCartInfo.id, row.id));
      await unavailable(201);
    }));

  it('proves claimed SQL byte redaction, bounded2001-row rejection and duplicate physical order-number refusal', async () => f.withReader(async peer => {
    wiring.container = peer.container; let byteBlocked = false, rowBounded = false;
    const original = PostgresJsSession.prototype.prepareQuery;
    const spy = vi.spyOn(PostgresJsSession.prototype, 'prepareQuery').mockImplementation(function (this: InstanceType<typeof PostgresJsSession>, ...args) {
      const prepared = original.apply(this, args);
      if (/from "store_product_virtual"/.test(args[0].sql)) {
        const execute = prepared.execute.bind(prepared); prepared.execute = async values => {
          const result = await execute(values);
          if (Array.isArray(result)) {
            if (result.length === 703 && result.every((row: any) => row.oversized === true && row.cardNo === null && row.cardPwd === null)) byteBlocked = true;
            if (result.length === 2001 && result.every((row: any) => row.oversized === false)) rowBounded = true;
          } return result;
        };
      } return prepared;
    });
    try {
      const long = '密'.repeat(255), oversized = Array.from({ length: 700 }, (_, index) => ({ id: 50000 + index,
        productId: 70, attrUnique: 'tracksku', uid: 11, orderType: 1, orderId: 'tracking-own-100', cardNo: long, cardPwd: long }));
      await f.db.insert(storeProductVirtual).values(oversized); await unavailable(); expect(byteBlocked).toBe(true);
      await f.db.delete(storeProductVirtual).where(inArray(storeProductVirtual.id, oversized.map(row => row.id)));
      const excessive = Array.from({ length: 1998 }, (_, index) => ({ id: 70000 + index,
        productId: 70, attrUnique: 'tracksku', uid: 11, orderType: 1, orderId: 'tracking-own-100', cardNo: '', cardPwd: 'p' }));
      await f.db.insert(storeProductVirtual).values(excessive); await unavailable(); expect(rowBounded).toBe(true);
      await f.db.delete(storeProductVirtual).where(inArray(storeProductVirtual.id, excessive.map(row => row.id)));
      await f.db.update(storeOrder).set({ orderId: 'tracking-own-100' }).where(eq(storeOrder.id, 900));
      expect(await f.db.select({ id: storeOrder.id }).from(storeOrder).where(eq(storeOrder.orderId, 'tracking-own-100'))).toHaveLength(2);
      await unavailable();
    } finally { spy.mockRestore(); }
  }));

  it('preserves a real denied sensitive-column SELECT as SQL42501 and fails the actual App read', async () => f.withReader(async peer => {
    wiring.container = peer.container; await f.exec(`REVOKE SELECT ON public.store_product_virtual FROM "${peer.role}"`);
    await f.exec(`GRANT SELECT(id,product_id,attr_unique,uid,order_type,order_id,card_no) ON public.store_product_virtual TO "${peer.role}"`);
    const [rights] = await peer.db.execute(sql`SELECT has_column_privilege(current_user,'store_product_virtual','card_pwd','SELECT') AS reads`); expect(rights.reads).toBe(false);
    await expect(new SupplierOrderReadService(peer.container).detail(7, 100, f.env.APP_KEY)).rejects.toSatisfy((error: any) => error?.cause?.code === '42501');
    const response = await request(); expect(response.status).not.toBe(200); expect(response.data).toBeNull();
  }));

  it.each([{ actor: 'foreign' }, { actor: 'denied' }, { actor: 'admin' }, { actor: 'customer' }, { actor: 'kefu' }, { actor: 'anonymous' }] as const)
    ('does not expose secrets with $actor authority', async ({ actor }) => f.withReader(async peer => {
      wiring.container = peer.container; const result = await request(100, actor); expect(result.status).not.toBe(200); expect(result.data).toBeNull();
    }));

  it('holds RR/READONLY and five-second budget across an independent card mutation, then rereads changed facts', async () => f.withReader(async peer => {
    wiring.container = peer.container; await peer.exec('SET statement_timeout=0'); let reached = false, committed: unknown;
    const original = PostgresJsSession.prototype.prepareQuery;
    const spy = vi.spyOn(PostgresJsSession.prototype, 'prepareQuery').mockImplementation(function (this: InstanceType<typeof PostgresJsSession>, ...args) {
      const prepared = original.apply(this, args);
      if (/from "store_order_cart_info"/.test(args[0].sql)) {
        const execute = prepared.execute.bind(prepared); prepared.execute = async values => {
          const result = await execute(values);
          if (!reached) { reached = true;
            const [settings] = await this.client.unsafe("SELECT current_setting('transaction_isolation') AS isolation,current_setting('transaction_read_only') AS readonly,current_setting('statement_timeout') AS timeout");
            expect(settings).toEqual({ isolation: 'repeatable read', readonly: 'on', timeout: '5s' });
            await f.db.update(storeProductVirtual).set({ cardPwd: 'CHANGED AFTER SNAPSHOT' }).where(eq(storeProductVirtual.id, 10001)); committed = await f.snapshot();
          } return result;
        };
      } return prepared;
    });
    const sequences = await f.sequences();
    try { const result = await (await app.request(path('detail', 100), { headers: { Authorization: 'Bearer ' + f.tokens.viewer } }, f.env)).json<Envelope>();
      expect(result.status, result.msg).toBe(200); expect(result.data.review.virtual_delivery).toEqual(f.expectedVirtual.get(100));
    } finally { spy.mockRestore(); }
    expect(reached).toBe(true); expect(await f.snapshot()).toEqual(committed); expect(await f.sequences()).toEqual(sequences); await unavailable();
    const [restored] = await peer.db.execute(sql`SELECT current_setting('transaction_read_only') AS readonly,current_setting('statement_timeout') AS timeout`);
    expect(restored).toEqual({ readonly: 'off', timeout: '0' });
  }), 30000);

  it.each([{ mode: 'cards' }, { mode: 'fixed-allocation' }] as const)
    ('connects registered real type1 checkout and delivery to Customer and Supplier $mode histories', async ({ mode }) => {
      const whole = await refundRuntimeFixture();
      try {
        const key = f.env.APP_KEY, password = 'local-virtual-review-reader';
        await whole.db.insert(systemRole).values({ id: 990, type: 4, relationId: 7, rules: 'supplier.order.view' });
        await whole.db.insert(systemAdmin).values({ id: 990, account: 'virtual-actual-reader', pwd: password, adminType: 4, relationId: 7, roles: '990' });
        await whole.db.update(systemSupplier).set({ adminId: 990 }).where(eq(systemSupplier.id, 7));
        await whole.db.update(user).set({ pwd: password }).where(eq(user.uid, 11));
        await whole.db.update(storeProduct).set({ productType: 1, deliveryType: '1', isVerify: 1, freight: 1 })
          .where(inArray(storeProduct.id, [70, 71]));
        await whole.db.update(storeCart).set({ productType: 1 }).where(inArray(storeCart.id, [1, 2]));
        await whole.db.update(storeProductAttrValue).set({ diskInfo: mode === 'cards' ? '' : '实际冻结固定内容\n保持原样' }).where(inArray(storeProductAttrValue.productId, [70, 71]));
        if (mode === 'fixed-allocation') await whole.db.update(storeProduct).set({ type: 0, relationId: 0 }).where(eq(storeProduct.id, 71));
        if (mode === 'cards') for (const [productId, sku] of [[70, 'qared001'], [71, 'runtim71']] as const) {
          await whole.db.insert(storeProductVirtual).values(Array.from({ length: 8 }, (_, i) => ({ productId, attrUnique: sku, cardNo: i ? `REAL-${productId}-${i}` : '', cardPwd: `REAL-PWD-${productId}-${i}` })));
        }
        const supplierToken = (await createToken(990, 'supplier', md5(password), key)).token;
        const buyerToken = (await createToken(11, 'api', md5(password), key)).token;
        await whole.withRuntime(async writer => {
          await whole.exec(`GRANT SELECT ON public.store_product_virtual TO "${writer.role}"`);
          await whole.exec(`GRANT UPDATE(uid,order_id,order_type) ON public.store_product_virtual TO "${writer.role}"`);
          const created = await writer.checkout({ key: 'virtual-' + mode, orderId: mode === 'cards' ? 'virtual_cards' : 'virtual_fixed' });
          const [unpaid] = await whole.db.select().from(storeOrder).where(eq(storeOrder.orderId, created.orderId));
          expect((await writer.carts(unpaid.id)).every(row => row.productType === 1)).toBe(true);
          // Explicit owned synthetic payment admission; allocation, ledger and
          // irreversible delivery are the real registered writers, not a provider.
          const [paid] = await whole.db.update(storeOrder).set({ paid: 1, payType: 'yue', payTime: 100 }).where(eq(storeOrder.id, unpaid.id)).returning();
          const allocated = await withTx(writer.container, async tx => {
            const result = await allocatePaidOrderBySupplier(tx, paid.id, paid.orderId, 100);
            for (const child of result.fulfillmentOrders) await recordSupplierPayment(tx, child, 100);
            expect((await deliverPaidVirtualOrders(tx, result.fulfillmentOrders, 100)).deliveredOrders).toBe(result.fulfillmentOrders.length);
            return result;
          });
          const target = allocated.fulfillmentOrders.find(order => order.supplierId === 7)!; expect(target).toBeDefined();
          if (mode === 'fixed-allocation') expect(allocated.split).toBe(true);
          const state = async () => {
            const result: Record<string, unknown> = {};
            for (const row of (await whole.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows) {
              const table = row.tablename; if (typeof table !== 'string' || !/^[a-z][a-z0-9_]*$/.test(table)) throw Error('Unexpected owned virtual table');
              result[table] = (await whole.query(`SELECT to_jsonb(t) AS row FROM public."${table}" t ORDER BY to_jsonb(t)::text`)).rows;
            }
            for (const row of (await whole.query("SELECT sequencename FROM pg_sequences WHERE schemaname='public' ORDER BY sequencename")).rows) {
              const sequence = row.sequencename; if (typeof sequence !== 'string' || !/^[a-z][a-z0-9_]*$/.test(sequence)) throw Error('Unexpected owned virtual sequence');
              result['sequence:' + sequence] = (await whole.query(`SELECT last_value,is_called FROM public."${sequence}"`)).rows;
            } return result;
          };
          // Actual Customer App/JWT, using the explicitly owned maintenance SQL
          // boundary. Supplier below uses a separate SELECT-only LOGIN.
          wiring.container = createContainerFromDb(whole.db); const beforeCustomer = await state();
          const customer = await (await app.request('/api/order/detail/' + target.orderId, { headers: { Authorization: 'Bearer ' + buyerToken } }, { ...whole.env, APP_KEY: key, NODE_ENV: 'test' })).json<Envelope>();
          expect(customer.status, customer.msg).toBe(200); expect(await state()).toEqual(beforeCustomer);
          await whole.withRuntimeRole!(async peer => {
            await whole.exec(`GRANT SELECT ON public.system_admin,public.system_role,public.system_supplier,public.system_menus,
              public.store_order,public.store_order_cart_info,public.store_order_invoice,public.store_order_promotions,
              public.store_promotions,public."user",public.system_attachment,public.store_product_virtual TO "${peer.role}"`);
            wiring.container = createContainerFromDb(peer.db); const before = await state();
            const response = await (await app.request(path('detail', target.id), { headers: { Authorization: 'Bearer ' + supplierToken } }, { ...whole.env, APP_KEY: key, NODE_ENV: 'test' })).json<Envelope>();
            expect(response.status, response.msg).toBe(200); const virtual = response.data.review.virtual_delivery;
            expect(virtual.state).toBe('recorded'); expect(virtual.basis).toBe('modern');
            expect(virtual.entries.map((entry: any) => entry.kind === 'card'
              ? { card_no: entry.card_no, card_pwd: entry.card_pwd, product_id: entry.product_id, sku_unique: entry.sku_unique }
              : { disk_info: entry.content, product_id: entry.product_id, sku_unique: entry.sku_unique, quantity: entry.quantity })).toEqual(customer.data.virtualInfo);
            expect(response.data.cart_info.every((row: any) => !Object.hasOwn(JSON.parse(row.cartInfo).sku, 'disk_info'))).toBe(true);
            const [rights] = await peer.db.execute(sql`SELECT current_user=session_user AS independent,has_any_column_privilege(current_user,'store_product_virtual','UPDATE') AS writes`);
            expect(rights).toEqual({ independent: true, writes: false }); expect(await state()).toEqual(before);
          });
        });
      } finally { await whole.close(); }
    }, 120000);
});
