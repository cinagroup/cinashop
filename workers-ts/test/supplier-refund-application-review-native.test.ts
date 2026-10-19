import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { createApp } from '@/app';
import { createContainerFromDb, type Container, type DbClient } from '@/lib/di';
import { storeOrder, storeOrderCartInfo, storeOrderRefund, storeProduct, storeProductAttrValue,
  systemAdmin, systemRole, systemSupplier, systemMenus, user } from '@/models/schema';
import { SupplierAfterSaleService } from '@/services/supplier/SupplierAfterSaleService';
import * as application from '@/services/supplier/SupplierRefundApplicationReview';
import { StoreOrderRefundService } from '@/services/order/StoreOrderRefundService';
import { readRefundQuantityReservation } from '@/services/order/RefundQuantityReservation';
import { authorizeCustomerWorkActor } from '@/services/customer-work/CustomerWorkScope';
import { financialRevisions } from '@/services/customer-work/CustomerWorkFinancialReadService';
import { CUSTOMER_FINANCIAL_VERSION, CUSTOMER_FINANCIAL_QUOTE_VERSION, type FinancialInput } from '@/services/customer-work/CustomerWorkFinancialProtocol';
import { createToken, md5 } from '@/utils/jwt';
import { ownsFinanceFixtureEndpoint, validateFinanceFixtureUrl } from './helpers/financePostgres';
import { ownsSequenceRunnerEndpoint } from './helpers/kefuSequenceRunnerDatabase';
import { applicationClaim, supplierRefundApplicationReviewFixture } from './helpers/supplierRefundApplicationReview';
import { refundRuntimeFixture } from './helpers/refundRuntimeFixture';
import { customerWorkFinancialFixture } from './helpers/customerWorkFinancialFixture';

const wiring = vi.hoisted(() => ({ container: undefined as Container | undefined }));
vi.mock('@/lib/di', async original => ({ ...await original<typeof import('@/lib/di')>(), createContainer: () => {
  if (!wiring.container) throw Error('Missing actual application-review LOGIN'); return wiring.container;
} }));
const app = createApp();
type Envelope = { status: number; msg: string; data: any };
const route = (id: number) => '/supplierapi/refund/detail/' + id;
const ident = (value: string) => { if (!/^[a-z][a-z0-9_]*$/.test(value)) throw Error('Unowned application fixture identifier'); return '"' + value + '"'; };
async function allState(db: DbClient) {
  const state: Record<string, unknown> = {};
  for (const row of await db.execute<{ tablename: string }>(sql`SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename`))
    state[row.tablename] = await db.execute(sql.raw(`SELECT to_jsonb(t) AS row FROM public.${ident(row.tablename)} t ORDER BY to_jsonb(t)::text`));
  for (const row of await db.execute<{ sequencename: string }>(sql`SELECT sequencename FROM pg_sequences WHERE schemaname='public' ORDER BY sequencename`))
    state['sequence:' + row.sequencename] = await db.execute(sql.raw(`SELECT last_value,is_called FROM public.${ident(row.sequencename)}`));
  return state;
}
/** Only the finite owned DB; production ACLs are neither installed nor changed. */
async function withReadLogin<T>(maintenance: DbClient, exec: (query: string) => Promise<unknown>, work: (container: Container) => Promise<T>) {
  const base = validateFinanceFixtureUrl(process.env.TEST_FINANCE_POSTGRES_URL ?? '');
  const [origin] = await maintenance.execute<{ database: string; host: string; port: number; version: number }>(sql`SELECT current_database() AS database,host(inet_server_addr()) AS host,inet_server_port() AS port,current_setting('server_version_num')::integer AS version`);
  if (Math.floor(origin.version / 10000) !== 16 || !(ownsFinanceFixtureEndpoint(origin.database, 'public', base.href, origin.host, origin.port)
    || ownsSequenceRunnerEndpoint(origin.database, 'public', base.href, origin.host, origin.port))) throw Error('Unowned application LOGIN target');
  const role = 'cinashop_runtime_' + crypto.randomUUID().replaceAll('-', ''), password = crypto.randomUUID().replaceAll('-', '');
  let client: ReturnType<typeof postgres> | undefined;
  await exec(`CREATE ROLE ${ident(role)} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`);
  try {
    await exec(`GRANT USAGE ON SCHEMA public TO ${ident(role)}`);
    await exec(`GRANT SELECT ON public.system_admin,public.system_role,public.system_supplier,public.system_menus,public.store_order,public.store_order_cart_info,public.store_order_refund,public.store_order_refund_payment,public.store_order_refund_split TO ${ident(role)}`);
    const url = new URL(base.href); url.pathname = '/' + origin.database; url.username = role; url.password = password;
    client = postgres(url.href, { max: 1, prepare: false, connect_timeout: 5, idle_timeout: 0, max_lifetime: 0 });
    const db = drizzle(client) as unknown as DbClient;
    const [rights] = await db.execute(sql`SELECT current_user=session_user AS independent,has_any_column_privilege(current_user,'store_order_refund','UPDATE') AS updates,has_table_privilege(current_user,'store_order_cart_info','INSERT') AS inserts`);
    expect(rights).toEqual({ independent: true, updates: false, inserts: false });
    return await work(createContainerFromDb(db));
  } finally { await client?.end({ timeout: 5 }); await exec(`DROP OWNED BY ${ident(role)}; DROP ROLE ${ident(role)}`); }
}

/** Application reads do not dispatch refunds, sign provider requests or write analytics. */
describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('Supplier refund application review actual App JWT SELECT-only PG16', () => {
  let f: Awaited<ReturnType<typeof supplierRefundApplicationReviewFixture>>;
  beforeEach(async () => { f = await supplierRefundApplicationReviewFixture(); wiring.container = f.container;
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Application review must not call providers')); }, 30000);
  afterEach(async () => { try { expect(fetch).not.toHaveBeenCalled(); }
    finally { wiring.container = undefined; vi.restoreAllMocks(); await f?.close(); } }, 30000);
  async function request(id = 100, actor: keyof typeof f.tokens | 'anonymous' = 'viewer') {
    const before = await f.snapshot(), sequences = await f.sequences();
    const response = await app.request(route(id), { headers: actor === 'anonymous' ? {} : { Authorization: 'Bearer ' + f.tokens[actor], 'X-Supplier-Id': '8' } }, f.env);
    expect(response.headers.get('cache-control')).toContain('private'); expect(response.headers.get('cache-control')).toContain('no-store');
    const body = await response.json<Envelope>(); expect(await f.snapshot()).toEqual(before); expect(await f.sequences()).toEqual(sequences); return body;
  }
  async function read(id = 100) { const body = await request(id); expect(body.status, body.msg).toBe(200); return body.data; }
  async function unavailable(id = 100) { expect((await read(id)).application_review).toMatchObject({ state: 'unavailable', basis: null, items: [], error: expect.any(String) }); }

  it.each([100, 201, 301])('reads complete exact application %s and retains only null compatibility raw keys', async id => f.withReader(async peer => {
    wiring.container = peer.container;
    const [rights] = await peer.db.execute(sql`SELECT current_user=session_user AS independent,has_any_column_privilege(current_user,'store_order_refund','UPDATE') AS updates,has_table_privilege(current_user,'store_order_refund','INSERT') AS inserts,has_schema_privilege(current_user,'public','CREATE') AS creates`);
    expect(rights).toEqual({ independent: true, updates: false, inserts: false, creates: false });
    const detail = await read(id); expect(detail.application_review).toEqual(f.expectedApplications.get(id));
    expect(detail.cartInfo).toBeNull(); expect(detail.orderInfo).toBeNull();
    expect(JSON.stringify(detail)).not.toMatch(/PRIVATE-CLAIMED|PRIVATE-LEGACY|PRIVATE-ROOT|PRIVATE-CUSTOMER/);
    if (id === 100) { expect(detail.application_review.items).toHaveLength(1); expect(detail.application_review.items[0]).toMatchObject({ quantity: 1, settlement_unit: '2.50', settlement_subtotal: '2.50' }); }
    if (id === 301) expect(detail.refundHistory).toMatchObject({ itemsError: '', items: [{ quantity: 1 }, { quantity: 1 }] });
  }));
  it.each(['refund-quantity-reservation-v1', 'refund-quantity-materialization-v2', 'refund-quantity-customer-row-v3'])('reads exact %s selectors without alias inference', async version => f.withReader(async peer => {
    wiring.container = peer.container; const [order] = await f.db.select().from(storeOrder).where(eq(storeOrder.id, 100));
    const rows = await f.db.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid, 100));
    await f.db.update(storeOrderRefund).set({ cartInfo: applicationClaim(order, rows, [{ rowId: 1001, quantity: 1 }], version) }).where(eq(storeOrderRefund.id, 100));
    expect((await read()).application_review).toEqual(f.expectedApplications.get(100));
  }));
  it.each([0, 1, 2, 4, 5])('keeps active stage %s tied to the actual held quantity', async refundType => f.withReader(async peer => {
    wiring.container = peer.container; await f.db.update(storeOrderRefund).set({ refundType }).where(eq(storeOrderRefund.id, 100));
    expect((await read()).application_review.items[0].quantity).toBe(1);
  }));
  it.each([{ isCancel: 1, refundType: 0 }, { isCancel: 0, refundType: 3 }])('reads released request history $isCancel/$refundType without demanding an active hold', async state => f.withReader(async peer => {
    wiring.container = peer.container; await f.db.update(storeOrderRefund).set(state).where(eq(storeOrderRefund.id, 100));
    await f.db.update(storeOrderCartInfo).set({ refundNum: 0 }).where(eq(storeOrderCartInfo.id, 1001));
    expect((await read()).application_review).toEqual(f.expectedApplications.get(100));
  }));
  it.each(['cart_id', 'quantity', 'order'])('does not use a changed remainder after cancellation: %s', async fault => f.withReader(async peer => {
    wiring.container = peer.container; await f.db.update(storeOrderRefund).set({ isCancel: 1 }).where(eq(storeOrderRefund.id, 100));
    await f.db.update(storeOrderCartInfo).set(fault === 'cart_id' ? { cartId: 'different' } : fault === 'quantity' ? { cartNum: 1 } : { oid: 201 }).where(eq(storeOrderCartInfo.id, 1001));
    await unavailable();
  }));
  it('does not invent completed v1 history from current rows', async () => f.withReader(async peer => {
    wiring.container = peer.container; const [order] = await f.db.select().from(storeOrder).where(eq(storeOrder.id, 100));
    const rows = await f.db.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid, 100));
    await f.db.update(storeOrderRefund).set({ refundType: 6, cartInfo: applicationClaim(order, rows, [{ rowId: 1001, quantity: 1 }], 'refund-quantity-reservation-v1') }).where(eq(storeOrderRefund.id, 100));
    await unavailable(); expect((await read()).refundHistory).toBeNull();
  }));
  it('keeps complete legacy snapshots over64KiB readable without manufacturing a completed-history error', async () => f.withReader(async peer => {
    wiring.container = peer.container; const [refund] = await f.db.select().from(storeOrderRefund).where(eq(storeOrderRefund.id, 201));
    const legacy = JSON.parse(refund.cartInfo!); legacy[0].unused_historical_payload = 'x'.repeat(70000);
    await f.db.update(storeOrderRefund).set({ refundType: 6, cartInfo: JSON.stringify(legacy) }).where(eq(storeOrderRefund.id, 201));
    const detail = await read(201); expect(detail.application_review).toEqual(f.expectedApplications.get(201)); expect(detail.refundHistory).toBeNull();
  }));
  it('preserves v3 opaque fifty-emoji keys beyond128bytes without changing namespace', async () => f.withReader(async peer => {
    wiring.container = peer.container; const key = '😀'.repeat(50);
    await f.db.update(storeOrderCartInfo).set({ cartId: key }).where(eq(storeOrderCartInfo.id, 1001));
    const [order] = await f.db.select().from(storeOrder).where(eq(storeOrder.id, 100));
    const rows = await f.db.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid, 100));
    await f.db.update(storeOrderRefund).set({ cartInfo: applicationClaim(order, rows, [{ rowId: 1001, quantity: 1 }]) }).where(eq(storeOrderRefund.id, 100));
    expect((await read()).application_review.items[0].cart_id).toBe(key);
  }));
  it('uses legacy single-spec product code for a modern claim while preserving protected gift identity', async () => f.withReader(async peer => {
    wiring.container = peer.container; const [row] = await f.db.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.id, 1001));
    await f.db.update(storeOrderCartInfo).set({ cartInfo: JSON.stringify({ is_gift: 1, productInfo: { id: 70,
      store_name: '旧订单冻结标签', spec_type: 0, code: 'PRODUCT-CODE', attrInfo: { unique: row.skuUnique, suk: '旧规格', code: 'WRONG-ATTR-CODE' } } }) }).where(eq(storeOrderCartInfo.id, row.id));
    expect((await read()).application_review.items[0]).toMatchObject({ code: 'PRODUCT-CODE', is_gift: 0 });
  }));
  it('keeps application labels and settlement independent of live catalog changes', async () => f.withReader(async peer => {
    wiring.container = peer.container; await f.db.update(storeProduct).set({ storeName: 'CURRENT-CHANGED', code: 'CURRENT-CODE' }).where(eq(storeProduct.id, 70));
    await f.db.update(storeProductAttrValue).set({ suk: 'CURRENT-SKU', settlePrice: '99.00' }).where(eq(storeProductAttrValue.productId, 70));
    expect((await read()).application_review).toEqual(f.expectedApplications.get(100)); expect((await read(201)).application_review).toEqual(f.expectedApplications.get(201));
  }));
  it('keeps real modern zero distinct from unpopulated historical zero', async () => f.withReader(async peer => {
    wiring.container = peer.container; expect((await read(111)).application_review.items[0]).toMatchObject({ settlement_unit: '0.00', settlement_subtotal: '0.00' });
    const [row] = await f.db.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.id, 1111)); const snapshot = JSON.parse(row.cartInfo!); delete snapshot.financial_version;
    await f.db.update(storeOrderCartInfo).set({ cartInfo: JSON.stringify(snapshot) }).where(eq(storeOrderCartInfo.id, 1111));
    expect((await read(111)).application_review.items[0]).toMatchObject({ settlement_unit: null, settlement_subtotal: null });
  }));
  it.each(['version', 'uid', 'orderId', 'duplicate', 'opaque-key'])('rejects a corrupt modern claim %s without partial rows', async fault => f.withReader(async peer => {
    wiring.container = peer.container; const [refund] = await f.db.select().from(storeOrderRefund).where(eq(storeOrderRefund.id, 100)); const value = JSON.parse(refund.cartInfo!);
    if (fault === 'duplicate') { value.cartIds.push(value.cartIds[0]); value.quantityReservation.items.push(value.quantityReservation.items[0]); }
    else if (fault === 'opaque-key') value.quantityReservation.items[0].sourceCartId = 'foreign';
    else value.quantityReservation[fault] = fault === 'version' ? 'unknown' : 999;
    await f.db.update(storeOrderRefund).set({ cartInfo: JSON.stringify(value) }).where(eq(storeOrderRefund.id, 100)); await unavailable();
  }));
  it.each(['product', 'sku', 'name', 'uid', 'relation', 'gift'])('rejects corrupt protected cart %s identity', async fault => f.withReader(async peer => {
    wiring.container = peer.container; const [row] = await f.db.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.id, 1001)); const value = JSON.parse(row.cartInfo!);
    if (fault === 'product') value.product.id = 999; if (fault === 'sku') value.sku.unique = 'foreign'; if (fault === 'name') value.product.storeName = '';
    await f.db.update(storeOrderCartInfo).set({ cartInfo: JSON.stringify(value), ...(fault === 'uid' ? { uid: 12 } : fault === 'relation' ? { relationId: 8 } : fault === 'gift' ? { isGift: 2 } : {}) }).where(eq(storeOrderCartInfo.id, 1001)); await unavailable();
  }));
  it('validates the complete collection before selecting only the requested purchase', async () => f.withReader(async peer => {
    wiring.container = peer.container; await f.db.update(storeOrderCartInfo).set({ uid: 12 }).where(eq(storeOrderCartInfo.id, 1002)); await unavailable();
  }));
  it.each(['malformed', 'duplicate', 'quantity', 'gift', 'product'])('rejects unknown or corrupt PHP array %s', async fault => f.withReader(async peer => {
    wiring.container = peer.container; const [refund] = await f.db.select().from(storeOrderRefund).where(eq(storeOrderRefund.id, 201)); const value = JSON.parse(refund.cartInfo!);
    if (fault === 'duplicate') value[1].id = value[0].id; if (fault === 'quantity') value[0].cart_num = 2;
    if (fault === 'gift') value[0].is_gift = true; if (fault === 'product') value[0].productInfo.id = 999;
    await f.db.update(storeOrderRefund).set({ cartInfo: fault === 'malformed' ? '[' : JSON.stringify(value) }).where(eq(storeOrderRefund.id, 201)); await unavailable(201);
  }));
  it('preserves canonical PHP string flags and opaque Unicode cart keys without Number coercion', async () => f.withReader(async peer => {
    wiring.container = peer.container; const [refund] = await f.db.select().from(storeOrderRefund).where(eq(storeOrderRefund.id, 201)); const value = JSON.parse(refund.cartInfo!);
    value[0].id = '😀'.repeat(128); value[0].productInfo.spec_type = '1'; value[0].is_gift = '0'; value[1].productInfo.spec_type = '0'; value[1].is_gift = '1';
    await f.db.update(storeOrderRefund).set({ cartInfo: JSON.stringify(value) }).where(eq(storeOrderRefund.id, 201));
    const items = (await read(201)).application_review.items; expect(items[0]).toMatchObject({ cart_id: value[0].id, code: 'LEGACY-SKU-CODE', is_gift: 0 }); expect(items[1]).toMatchObject({ code: 'LEGACY-PRODUCT-CODE', is_gift: 1 });
  }));
  it('rejects aggregate successful-item JSON over512KiB while each label and the legacy array remain bounded', async () => f.withReader(async peer => {
    wiring.container = peer.container; const rows = Array.from({ length: 100 }, (_, i) => ({ id: 'old-' + i, product_id: 70, cart_num: 1,
      productInfo: { id: 70, store_name: 'n'.repeat(1800), spec_type: 1, attrInfo: { suk: 's'.repeat(1800), code: 'c'.repeat(1800), settle_price: '1.00' } } }));
    const raw = JSON.stringify(rows); expect(Buffer.byteLength(raw)).toBeLessThan(1048576);
    await f.db.update(storeOrderRefund).set({ refundNum: 100, cartInfo: raw }).where(eq(storeOrderRefund.id, 201)); await unavailable(201);
  }));
  it('enforces modern64KiB and legacy1MiB in the actual SQL result before transport', async () => f.withReader(async peer => {
    wiring.container = peer.container;
    for (const [id, raw] of [[100, JSON.stringify({ quantityReservation: {}, extra: 'x'.repeat(65536) })], [201, JSON.stringify([{ id: 'x', extra: 'x'.repeat(1048576) }])]] as const) {
      await f.db.update(storeOrderRefund).set({ cartInfo: raw }).where(eq(storeOrderRefund.id, id));
      const [actual] = await peer.db.select({ raw: application.supplierRefundApplicationCartInfo }).from(storeOrderRefund).where(eq(storeOrderRefund.id, id));
      expect(actual.raw).toBeNull(); await unavailable(id);
    }
  }));
  it.each(['store_order_cart_info', 'store_order_refund_payment', 'store_order_refund_split'])('preserves actual SQL42501 on %s', async table => f.withReader(async peer => {
    wiring.container = peer.container; await f.exec(`REVOKE SELECT ON public.${ident(table)} FROM ${ident(peer.role)}`);
    const id = table === 'store_order_refund_split' ? 301 : 100;
    await expect(new SupplierAfterSaleService(peer.container, f.env).detail(7, id)).rejects.toMatchObject({ cause: { code: '42501' } });
    expect((await request(id)).status).not.toBe(200);
  }));
  it.each([{ actor: 'foreign', id: 100 }, { actor: 'viewer', id: 900 }, { actor: 'denied', id: 100 }, { actor: 'admin', id: 100 },
    { actor: 'customer', id: 100 }, { actor: 'anonymous', id: 100 }] as const)('denies actual actor $actor for application$id', async ({ actor, id }) => f.withReader(async peer => {
    wiring.container = peer.container; const body = await request(id, actor); expect(body.status).not.toBe(200); expect(JSON.stringify(body)).not.toContain('PRIVATE-');
  }));
  it('retains one RR/READONLY snapshot and per-SQL budget across independent quantity changes', async () => f.withReader(async peer => {
    wiring.container = peer.container; const actual = application.readSupplierRefundApplicationReview; let reached = false, committed: unknown;
    const spy = vi.spyOn(application, 'readSupplierRefundApplicationReview').mockImplementationOnce(async (tx, refund, order) => {
      const [settings] = await tx.execute(sql`SELECT current_setting('transaction_isolation') AS isolation,current_setting('transaction_read_only') AS readonly,current_setting('statement_timeout') AS timeout`);
      expect(settings).toEqual({ isolation: 'repeatable read', readonly: 'on', timeout: '5s' }); reached = true;
      await f.db.update(storeOrderCartInfo).set({ cartNum: 3 }).where(eq(storeOrderCartInfo.id, 1001)); committed = await f.snapshot(); return actual(tx, refund, order);
    });
    const seq = await f.sequences(); try {
      const body = await (await app.request(route(100), { headers: { Authorization: 'Bearer ' + f.tokens.viewer } }, f.env)).json<Envelope>();
      expect(body.status, body.msg).toBe(200); expect(body.data.application_review).toEqual(f.expectedApplications.get(100));
    } finally { spy.mockRestore(); }
    expect(reached).toBe(true); expect(await f.snapshot()).toEqual(committed); expect(await f.sequences()).toEqual(seq); await unavailable();
  }), 30000);

  it.each(['customer-v1', 'materialized-v2'] as const)('connects registered checkout and real %s application/terminal writers to readonly Supplier review', async mode => {
    const whole = await refundRuntimeFixture();
    try {
      const password = 'owned-application-reader', key = f.env.APP_KEY;
      await whole.db.insert(systemRole).values({ id: 990, type: 4, relationId: 7, rules: 'supplier.refund.view' });
      await whole.db.insert(systemAdmin).values({ id: 990, account: 'application-actual-reader', pwd: password, adminType: 4, relationId: 7, roles: '990' });
      await whole.db.update(systemSupplier).set({ adminId: 990 }).where(eq(systemSupplier.id, 7));
      await whole.db.update(user).set({ pwd: password }).where(eq(user.uid, 11));
      const supplierToken = (await createToken(990, 'supplier', md5(password), key)).token;
      const buyerToken = (await createToken(11, 'api', md5(password), key)).token;
      const env = { ...whole.env, APP_KEY: key, NODE_ENV: f.env.NODE_ENV };
      await whole.withRuntime(async writer => {
        const source = await writer.createPaid({ key: 'application-' + mode, orderId: 'application_' + mode.replaceAll('-', '_') });
        const original = await writer.carts(source.id), chosen = original.find(row => row.productId === 70)!;
        expect(original.length).toBeGreaterThan(1);
        let refundId: number;
        if (mode === 'customer-v1') {
          // Customer HTTP authentication is real; SQL uses the owned maintenance
          // boundary. Checkout/allocation are actual, payment admission synthetic.
          wiring.container = createContainerFromDb(whole.db);
          const applied = await (await app.request('/api/order/refund/apply/' + source.id, { method: 'POST',
            headers: { Authorization: 'Bearer ' + buyerToken, 'content-type': 'application/json' },
            body: JSON.stringify({ refundReason: '用户只退所选一件', applyType: 1, cart_ids: [{ cart_id: Number(chosen.cartId), cart_num: 1 }] }) }, env)).json<Envelope>();
          expect(applied.status, applied.msg).toBe(200); refundId = applied.data.refundId;
        } else refundId = (await writer.apply(source.id, 70, 1)).refundId;
        const [stored] = await whole.db.select().from(storeOrderRefund).where(eq(storeOrderRefund.id, refundId));
        expect(readRefundQuantityReservation(stored)?.version).toBe(mode === 'customer-v1' ? 'refund-quantity-reservation-v1' : 'refund-quantity-materialization-v2');
        const readActual = async () => withReadLogin(whole.db, whole.exec, async container => {
          wiring.container = container; const before = await allState(whole.db);
          const body = await (await app.request(route(refundId), { headers: { Authorization: 'Bearer ' + supplierToken } }, env)).json<Envelope>();
          expect(body.status, body.msg).toBe(200); expect(body.data.cartInfo).toBeNull(); expect(body.data.orderInfo).toBeNull();
          expect(await allState(whole.db)).toEqual(before); return body.data;
        });
        const pending = await readActual(); expect(pending.application_review).toMatchObject({ state: 'recorded', basis: 'quantity_claim',
          items: [{ row_id: chosen.id, cart_id: chosen.cartId, product_id: 70, quantity: 1, settlement_unit: '2.50', settlement_subtotal: '2.50' }] });
        expect(pending.application_review.items).toHaveLength(1);
        if (mode === 'customer-v1') {
          wiring.container = createContainerFromDb(whole.db);
          const cancelled = await (await app.request('/api/order/refund/cancel/' + refundId, { method: 'POST', headers: { Authorization: 'Bearer ' + buyerToken } }, env)).json<Envelope>();
          expect(cancelled.status, cancelled.msg).toBe(200);
          expect((await readActual()).application_review).toEqual(pending.application_review);
          expect((await writer.carts(source.id)).find(row => row.id === chosen.id)?.refundNum).toBe(0);
        } else {
          await new StoreOrderRefundService(writer.container, env).refuseRefund(refundId, '用户取消此次选择');
          expect((await readActual()).application_review).toEqual(pending.application_review);
          const next = await writer.apply(source.id, 70, 1); expect(await writer.finish(next.refundId)).toBe('completed');
          // The earlier refused request cannot acquire the later remainder rows.
          expect((await readActual()).application_review).toMatchObject({ state: 'unavailable', items: [] });
          await withReadLogin(whole.db, whole.exec, async container => {
            wiring.container = container; const before = await allState(whole.db);
            const body = await (await app.request(route(next.refundId), { headers: { Authorization: 'Bearer ' + supplierToken } }, env)).json<Envelope>();
            expect(body.status, body.msg).toBe(200); expect(body.data.application_review).toMatchObject({ state: 'archived', basis: null, items: [] });
            expect(body.data.refundHistory).toMatchObject({ itemsError: '', items: [{ name: pending.application_review.items[0].product_name, quantity: 1 }] });
            expect(await allState(whole.db)).toEqual(before);
          });
        }
      });
    } finally { await whole.close(); }
  }, 120000);

  it('reads a real v3 CustomerWork quote/revision/receipt application with an independent Supplier LOGIN', async () => {
    // This established actor fixture uses synthetic paid original rows. Its real
    // financial author creates the v3 claim; it is not another checkout proof.
    const whole = await customerWorkFinancialFixture([systemAdmin, systemRole, systemMenus]);
    try {
      const maintenance = whole.maintenanceDb, password = 'owned-v3-application-reader';
      await maintenance.insert(systemSupplier).values({ id: 7, adminId: 990, supplierName: '本地经营申请供应商' }).onConflictDoNothing();
      await maintenance.insert(systemRole).values({ id: 990, type: 4, relationId: 7, rules: 'supplier.refund.view' });
      await maintenance.insert(systemAdmin).values({ id: 990, account: 'v3-application-reader', pwd: password, adminType: 4, relationId: 7, roles: '990' });
      await maintenance.update(storeOrder).set({ supplierId: 7 }).where(eq(storeOrder.id, 1));
      const [cart] = await maintenance.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.id, 1));
      const snapshot = JSON.parse(cart.cartInfo!); snapshot.product.id = 70;
      await maintenance.update(storeOrderCartInfo).set({ type: 2, relationId: 7, cartInfo: JSON.stringify(snapshot) }).where(eq(storeOrderCartInfo.id, 1));
      const [order] = await whole.db.select().from(storeOrder).where(eq(storeOrder.id, 1));
      const actor = whole.actor(), scope = await authorizeCustomerWorkActor(whole.db, actor), revision = await financialRevisions(whole.db, order);
      const base = { version: CUSTOMER_FINANCIAL_VERSION, scope_key: scope.scope_key, order_id: 1,
        expected_order_revision: revision.order_revision, expected_financial_revision: revision.financial_revision } as const;
      const items = [{ cart_row_id: 1, cart_num: 1 }], service = whole.service();
      const quoted = await service.reader.quote(actor, { ...base, version: CUSTOMER_FINANCIAL_QUOTE_VERSION, mode: 'items', items });
      const body: FinancialInput = { ...base, payload: { mode: 'items', items, quoted_price: quoted.data.quoted_price,
        refund_price: quoted.data.quoted_price, quote_fingerprint: quoted.data.quote_fingerprint, reason: '经营已核实的商品申请' } };
      const created = await service.create({ actor, request_key: crypto.randomUUID() }, body);
      expect(created.receipt?.outcome).toBe('refund-created'); const refundId = Number(created.receipt!.evidence.refund_id);
      const [refund] = await whole.db.select().from(storeOrderRefund).where(eq(storeOrderRefund.id, refundId));
      expect(readRefundQuantityReservation(refund)).toMatchObject({ version: 'refund-quantity-customer-row-v3', items: [{ rowId: 1, cartId: 1, sourceCartId: '501', cartNum: 1 }] });
      const token = (await createToken(990, 'supplier', md5(password), whole.env.APP_KEY)).token;
      await withReadLogin(maintenance, whole.exec, async container => {
        wiring.container = container; const before = await allState(maintenance);
        const result = await (await app.request(route(refundId), { headers: { Authorization: 'Bearer ' + token } }, whole.env)).json<Envelope>();
        expect(result.status, result.msg).toBe(200); expect(result.data.application_review).toMatchObject({ state: 'recorded', basis: 'quantity_claim',
          items: [{ row_id: 1, cart_id: '501', product_id: 70, product_name: '实际财务商品', sku: 'Red', quantity: 1 }] });
        expect(result.data.cartInfo).toBeNull(); expect(result.data.orderInfo).toBeNull(); expect(await allState(maintenance)).toEqual(before);
      });
    } finally { await whole.close(); }
  }, 120000);
});
