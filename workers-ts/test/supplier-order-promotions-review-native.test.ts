import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { PostgresJsSession } from 'drizzle-orm/postgres-js/session';
import { createApp } from '@/app';
import { createContainerFromDb, withTx, type Container } from '@/lib/di';
import { storeOrder, storeOrderCartInfo, storeOrderPromotions, storePromotions, storeProduct, systemAdmin, systemRole, systemSupplier } from '@/models/schema';
import { SupplierOrderReadService } from '@/services/supplier/SupplierOrderReadService';
import { SupplierFulfillmentService } from '@/services/supplier/SupplierFulfillmentService';
import { allocatePaidOrderBySupplier } from '@/services/order/OrderSupplierAllocationService';
import { createToken, md5 } from '@/utils/jwt';
import { supplierOrderPromotionReviewFixture, supplierPromotionLine } from './helpers/supplierOrderPromotionReview';
import { refundRuntimeFixture } from './helpers/refundRuntimeFixture';

const wiring = vi.hoisted(() => ({ container: undefined as Container | undefined }));
vi.mock('@/lib/di', async original => ({ ...await original<typeof import('@/lib/di')>(), createContainer: () => {
  if (!wiring.container) throw Error('Missing independent promotion review LOGIN'); return wiring.container;
} }));
type Envelope = { status: number; msg: string; data: any };
const app = createApp();
describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('Supplier named promotion allocation actual App JWT SELECT-only PG16', () => {
  let f: Awaited<ReturnType<typeof supplierOrderPromotionReviewFixture>>;
  beforeEach(async () => { f = await supplierOrderPromotionReviewFixture(); wiring.container = f.container;
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Promotion review must not query providers')); }, 30000);
  afterEach(async () => { try { expect(fetch).not.toHaveBeenCalled(); }
    finally { wiring.container = undefined; vi.restoreAllMocks(); await f?.close(); } }, 30000);
  async function unchanged<T>(work: () => Promise<T>) {
    const before = await f.snapshot(), seq = await f.sequences(); const result = await work();
    expect(await f.snapshot()).toEqual(before); expect(await f.sequences()).toEqual(seq); return result;
  }
  async function request(id: number | string = 100, actor: keyof typeof f.tokens | 'anonymous' = 'viewer') {
    return unchanged(async () => {
      const response = await app.request('/supplierapi/order/info/' + id, { headers: actor === 'anonymous' ? {}
        : { Authorization: 'Bearer ' + f.tokens[actor], 'X-Supplier-Id': '8' } }, f.env);
      expect(response.headers.get('cache-control')).toContain('no-store'); return response.json<Envelope>();
    });
  }
  async function promotions(id = 100) { const result = await request(id); expect(result.status, result.msg).toBe(200); return result.data.review.promotions; }

  it('projects exact modern named allocations separately from current titles using a genuine independent SELECT-only LOGIN and unchanged full SQL rows/sequences', async () => f.withReader(async peer => {
    wiring.container = peer.container; expect(await promotions()).toEqual(f.expectedPromotions);
    const [rights] = await peer.db.execute(sql`SELECT current_user=session_user AS independent,
      has_table_privilege(current_user,'store_order_promotions','SELECT') AS ledger,
      has_any_column_privilege(current_user,'store_order_promotions','UPDATE') AS ledger_write,
      has_any_column_privilege(current_user,'store_promotions','UPDATE') AS catalog_write,
      has_any_column_privilege(current_user,'store_order','UPDATE') AS order_write,
      has_schema_privilege(current_user,'public','CREATE') AS creates,
      (SELECT count(*)::int FROM pg_class WHERE relnamespace='public'::regnamespace AND relowner=(SELECT oid FROM pg_roles WHERE rolname=current_user)) AS owns`);
    expect(rights).toEqual({ independent: true, ledger: true, ledger_write: false, catalog_write: false, order_write: false, creates: false, owns: 0 });
    const detail = await request(); expect(detail.data.review.invoice.record.name).toBe('冻结发票抬头');
    expect(detail.data.review.settlement.total).toBe('8.00');
  }));

  it('sums legitimate same-product different-SKU ledger rows in integer cents instead of choosing one duplicate promotion ID', async () => f.withReader(async peer => {
    wiring.container = peer.container;
    await f.db.update(storeOrderCartInfo).set({ cartNum: 1, skuUnique: 'captured-a', cartInfo: JSON.stringify(supplierPromotionLine(1)) }).where(eq(storeOrderCartInfo.oid, 100));
    await f.db.insert(storeOrderCartInfo).values({ oid: 100, uid: 11, type: 2, relationId: 7, productId: 70, cartId: '1002',
      cartNum: 1, settlePrice: '2.50', skuUnique: 'captured-b', cartInfo: JSON.stringify(supplierPromotionLine(1)) });
    await f.db.delete(storeOrderPromotions).where(eq(storeOrderPromotions.oid, 100));
    await f.db.insert(storeOrderPromotions).values([101, 102].flatMap(promotionsId => Array.from({ length: 2 }, () => ({
      oid: 100, uid: 11, productId: 70, promotionsId, promotionsPrice: promotionsId === 101 ? '2.00' : '1.00' }))));
    expect(await promotions()).toEqual(f.expectedPromotions);
  }));

  it('changes only explicitly current title metadata after catalog name/rule/status/time edits while preserving frozen names and booked amounts', async () => f.withReader(async peer => {
    wiring.container = peer.container; const before = await promotions();
    await f.db.update(storePromotions).set({ name: '当前名字已改', title: '当前标题已改', discount: '10.00', status: 0, stopTime: 1 }).where(eq(storePromotions.id, 101));
    const after = await promotions(); expect(after).toEqual({ ...before, items: [{ ...before.items[0], current_title: '当前标题已改' }, before.items[1]] });
  }));

  it.each(['deleted', 'moved', 'child-definition', 'missing'] as const)('retains the frozen name and exact amount when current metadata is %s', async kind => f.withReader(async peer => {
    wiring.container = peer.container;
    if (kind === 'deleted') await f.db.update(storePromotions).set({ isDel: 1 }).where(eq(storePromotions.id, 101));
    if (kind === 'moved') await f.db.update(storePromotions).set({ type: 2, storeId: 7, title: 'PRIVATE-MOVED-TITLE' }).where(eq(storePromotions.id, 101));
    if (kind === 'child-definition') await f.db.update(storePromotions).set({ pid: 999 }).where(eq(storePromotions.id, 101));
    if (kind === 'missing') await f.db.delete(storePromotions).where(eq(storePromotions.id, 101));
    const result = await promotions(); expect(result).toEqual({ ...f.expectedPromotions, items: [
      { ...f.expectedPromotions.items[0], current_title: null }, f.expectedPromotions.items[1]] });
    expect(JSON.stringify(result)).not.toContain('PRIVATE-MOVED');
  }));

  it('reads full schema-length Unicode titles then hides malformed/oversized metadata without dropping coherent frozen amounts', async () => f.withReader(async peer => {
    wiring.container = peer.container; const title = '🎁'.repeat(255);
    await f.db.update(storePromotions).set({ title }).where(eq(storePromotions.id, 101)); expect((await promotions()).items[0].current_title).toBe(title);
    await f.db.update(storePromotions).set({ title: 'bad\u0001title' }).where(eq(storePromotions.id, 101)); expect((await promotions()).items[0].current_title).toBeNull();
    await f.exec('ALTER TABLE public.store_promotions ALTER COLUMN title TYPE text');
    await f.db.update(storePromotions).set({ title: 'x'.repeat(1025) }).where(eq(storePromotions.id, 101));
    expect(await promotions()).toEqual({ ...f.expectedPromotions, items: [{ ...f.expectedPromotions.items[0], current_title: null }, f.expectedPromotions.items[1]] });
  }));

  it('labels coherent original legacy ledger as record reference, includes expired titles, and never borrows platform root or sibling allocations', async () => f.withReader(async peer => {
    wiring.container = peer.container; expect(await promotions(301)).toEqual({ order_id: 301, state: 'recorded', reason: '', basis: 'legacy', total: '3.00',
      items: [{ promotion_id: 103, promotion_type: 3, frozen_name: null, current_title: '历史满额优惠标题', amount: '3.00' }] });
    expect(await promotions(202)).toEqual({ order_id: 202, state: 'none', reason: '', basis: null, total: null, items: [] });
    expect((await request(300)).status).toBe(404); expect(JSON.stringify(await promotions(301))).not.toMatch(/PRIVATE|99.00/);
  }));

  it('keeps an explicit legacy zero ledger record distinct from no recorded promotion and never trusts header zero alone', async () => f.withReader(async peer => {
    wiring.container = peer.container;
    expect(await promotions(111)).toEqual({ order_id: 111, state: 'none', reason: '', basis: null, total: null, items: [] });
    await f.db.update(storeOrderCartInfo).set({ cartInfo: '{"productInfo":{"id":70,"store_name":"旧零优惠记录"}}' }).where(eq(storeOrderCartInfo.oid, 111));
    await f.db.insert(storeOrderPromotions).values({ oid: 111, uid: 11, productId: 70, promotionsId: 103, promotionsPrice: '0.00' });
    expect(await promotions(111)).toMatchObject({ state: 'recorded', basis: 'legacy', total: '0.00', items: [{ amount: '0.00' }] });
    await f.db.update(storeOrderPromotions).set({ promotionsPrice: '1.00' }).where(eq(storeOrderPromotions.oid, 111));
    expect(await promotions(111)).toMatchObject({ state: 'unavailable', items: [], total: null });
  }));

  it.each([{ legacy: false }, { legacy: true }])('requires missing modern proof instead of relabeling it legacy, while preserving explicit legacy-derived references legacy=$legacy', async ({ legacy }) => f.withReader(async peer => {
    wiring.container = peer.container;
    await f.db.update(storeOrderCartInfo).set({ cartInfo: JSON.stringify({ financial_version: 'refund-order-line-finance-v1',
      ...(legacy ? { legacy_php_financial_source: 'original-php-purchase-facts-v1' } : {}),
      productInfo: { id: 70, store_name: '旧来源字段', attrInfo: { price: '30.00' } } }) }).where(eq(storeOrderCartInfo.oid, 100));
    const current = await promotions();
    if (legacy) expect(current).toMatchObject({ state: 'recorded', basis: 'legacy', total: '6.00', items: [
      { promotion_id: 101, frozen_name: null, amount: '4.00' }, { promotion_id: 102, frozen_name: null, amount: '2.00' }] });
    else expect(current).toMatchObject({ state: 'unavailable', basis: null, items: [] });
  }));

  it.each([
    { marker: null, version: 'refund-order-line-finance-v1' },
    { marker: 'unknown', version: 'refund-order-line-finance-v1' },
    { marker: 'original-php-purchase-facts-v1', version: 'checkout-line-finance-v1' },
  ])('rejects unrecognized legacy source or incompatible financial version $marker/$version', async ({ marker, version }) => f.withReader(async peer => {
    wiring.container = peer.container;
    await f.db.update(storeOrderCartInfo).set({ cartInfo: JSON.stringify({ financial_version: version,
      legacy_php_financial_source: marker, productInfo: { id: 70, store_name: '不可信来源标记' } }) }).where(eq(storeOrderCartInfo.oid, 100));
    expect(await promotions()).toMatchObject({ state: 'unavailable', basis: null, total: null, items: [] });
  }));

  it.each(['uid', 'product', 'header', 'missing-ledger'] as const)('does not pretend an incoherent legacy %s is an identified allocation', async fault => f.withReader(async peer => {
    wiring.container = peer.container;
    if (fault === 'uid') await f.db.update(storeOrderPromotions).set({ uid: 12 }).where(eq(storeOrderPromotions.oid, 301));
    if (fault === 'product') await f.db.update(storeOrderPromotions).set({ productId: 80 }).where(eq(storeOrderPromotions.oid, 301));
    if (fault === 'header') await f.db.update(storeOrder).set({ promotionsPrice: '3.01' }).where(eq(storeOrder.id, 301));
    if (fault === 'missing-ledger') await f.db.delete(storeOrderPromotions).where(eq(storeOrderPromotions.oid, 301));
    expect(await promotions(301)).toMatchObject({ state: 'unavailable', total: null, items: [], basis: null });
  }));

  it.each(['ledger-amount', 'segments', 'quantity', 'name-conflict', 'unknown-version', 'negative-amount'] as const)
    ('rejects modern %s contradictions without repricing or leaking a partial list', async fault => f.withReader(async peer => {
      wiring.container = peer.container;
      if (fault === 'ledger-amount') await f.db.update(storeOrderPromotions).set({ promotionsPrice: '3.99' }).where(eq(storeOrderPromotions.promotionsId, 101));
      if (fault === 'negative-amount') await f.db.update(storeOrderPromotions).set({ promotionsPrice: '-4.00' }).where(eq(storeOrderPromotions.promotionsId, 101));
      if (['segments','quantity','unknown-version'].includes(fault)) {
        const line = supplierPromotionLine(); if (fault === 'segments') line.promotion_segments[0].totalPriceCents++;
        if (fault === 'quantity') line.promotion_segments[0].quantity++;
        if (fault === 'unknown-version') line.promotion_quote_version = 'unknown';
        await f.db.update(storeOrderCartInfo).set({ cartInfo: JSON.stringify(line) }).where(eq(storeOrderCartInfo.oid, 100));
      }
      if (fault === 'name-conflict') {
        const line = supplierPromotionLine(1); line.promotion_allocations[0].name = '冲突的另一冻结名';
        await f.db.insert(storeOrderCartInfo).values({ oid: 100, uid: 11, type: 2, relationId: 7, productId: 70, cartId: '1002', cartNum: 1,
          cartInfo: JSON.stringify(line), settlePrice: '2.50' });
      }
      expect(await promotions()).toMatchObject({ state: 'unavailable', total: null, basis: null, items: [] });
    }));

  it.each([{ patch: { uid: 12 } }, { patch: { supplierId: 8 } }, { patch: { storeId: 2 } },
    { patch: { pid: 0 } }, { patch: { isSystemDel: 1 } }])('does not project child promotion history from an incoherent root $patch', async ({ patch }) => f.withReader(async peer => {
      wiring.container = peer.container; await f.db.update(storeOrder).set(patch).where(eq(storeOrder.id, 200));
      expect(await promotions(201)).toMatchObject({ state: 'unavailable', items: [] });
    }));

  it('retains exact own payment-summary allocations without summing children or falling back from a child', async () => f.withReader(async peer => {
    wiring.container = peer.container; expect(await promotions(200)).toEqual({ ...f.expectedPromotions, order_id: 200 });
    expect(await promotions(201)).toEqual({ ...f.expectedPromotions, order_id: 201, total: '3.00', items: [
      { ...f.expectedPromotions.items[0], amount: '2.00' }, { ...f.expectedPromotions.items[1], amount: '1.00' }] });
  }));

  it('rejects 601 ledger rows instead of silently reading a truncated first600 or running the unbounded writer helper', async () => f.withReader(async peer => {
    wiring.container = peer.container; await f.db.delete(storeOrderPromotions).where(eq(storeOrderPromotions.oid, 100));
    await f.db.insert(storeOrderPromotions).values(Array.from({ length: 601 }, () => ({ oid: 100, uid: 11, productId: 70, promotionsId: 101, promotionsPrice: '0.00' })));
    expect(await promotions()).toMatchObject({ state: 'unavailable', reason: expect.stringMatching(/过多/), items: [] });
  }));

  it('guards actual oversized historical ledger SQL bytes before materializing the numeric text', async () => f.withReader(async peer => {
    wiring.container = peer.container; await f.exec('ALTER TABLE public.store_order_promotions ALTER COLUMN promotions_price TYPE text USING promotions_price::text');
    await f.exec("UPDATE public.store_order_promotions SET promotions_price=repeat('9',131073) WHERE oid=100");
    expect(await promotions()).toMatchObject({ state: 'unavailable', reason: expect.stringMatching(/过大/), items: [] });
  }));

  it.each(['store_order_promotions', 'store_promotions'] as const)('preserves a real SELECT permission error on %s instead of returning none', async table => f.withReader(async peer => {
    wiring.container = peer.container; expect((await promotions()).state).toBe('recorded');
    await f.exec(`REVOKE SELECT ON public.${table} FROM "${peer.role}"`);
    await unchanged(() => expect(new SupplierOrderReadService(peer.container).detail(7, 100, f.env.APP_KEY)).rejects.toMatchObject({ cause: { code: '42501' } }));
    expect((await request()).status).not.toBe(200);
  }));

  it('uses one read-only repeatable-read snapshot and five-second budget across independently committed current-title changes', async () => f.withReader(async peer => {
    wiring.container = peer.container; let reached = false, expected: Awaited<ReturnType<typeof f.snapshot>> | undefined;
    const actual = PostgresJsSession.prototype.prepareQuery;
    const spy = vi.spyOn(PostgresJsSession.prototype, 'prepareQuery').mockImplementation(function (this: InstanceType<typeof PostgresJsSession>, ...args) {
      const prepared = actual.apply(this, args);
      if (/^select .* from "store_order" where /s.test(args[0].sql)) { const execute = prepared.execute.bind(prepared);
        prepared.execute = async values => { const result = await execute(values); if (!reached) { reached = true;
          const [settings] = await this.client.unsafe("SELECT current_setting('transaction_read_only') AS ro,current_setting('transaction_isolation') AS iso,current_setting('statement_timeout') AS timeout");
          expect(settings).toEqual({ ro: 'on', iso: 'repeatable read', timeout: '5s' });
          await f.db.update(storePromotions).set({ title: '下个快照的当前标题' }).where(eq(storePromotions.id, 101)); expected = await f.snapshot();
        } return result; };
      } return prepared;
    });
    const seq = await f.sequences();
    try { const response = await app.request('/supplierapi/order/info/100', { headers: { Authorization: 'Bearer ' + f.tokens.viewer } }, f.env);
      const result = await response.json<Envelope>(); expect(result.status, result.msg).toBe(200); expect(result.data.review.promotions).toEqual(f.expectedPromotions);
    } finally { spy.mockRestore(); }
    expect(reached).toBe(true); expect(await f.snapshot()).toEqual(expected); expect(await f.sequences()).toEqual(seq);
    expect((await promotions()).items[0].current_title).toBe('下个快照的当前标题');
  }));

  it.each([{ actor: 'foreign', id: 100 }, { actor: 'viewer', id: 900 }, { actor: 'denied', id: 100 },
    { actor: 'anonymous', id: 100 }, { actor: 'customer', id: 100 }, { actor: 'admin', id: 100 }] as const)
    ('enforces actual Supplier HTTP permission actor=$actor order=$id', async ({ actor, id }) => f.withReader(async peer => {
      wiring.container = peer.container; expect((await request(id, actor)).status).not.toBe(200);
    }));

  it.each([{ mode: 'fulfillment' }, { mode: 'supplier-allocation' }] as const)
    ('reads nonzero allocations from registered checkout through actual $mode with independent SELECT-only Supplier App JWT and no read writes', async ({ mode }) => {
      const whole = await refundRuntimeFixture();
      try {
        const key = 'owned-real-promotion-review', now = Math.floor(Date.now() / 1000);
        await whole.db.insert(systemRole).values({ id: 990, type: 4, relationId: 7, rules: 'supplier.order.view' });
        await whole.db.insert(systemAdmin).values({ id: 990, account: 'promotion-actual-reader', pwd: key, adminType: 4, relationId: 7, roles: '990' });
        await whole.db.update(systemSupplier).set({ adminId: 990 }).where(eq(systemSupplier.id, 7));
        const [campaign] = await whole.db.insert(storePromotions).values({ type: 1, storeId: 0, pid: 0, promotionsType: 1,
          name: '真实下单九折', title: '真实当前九折标题', discount: '90.00', productPartakeType: 1,
          startTime: now - 60, stopTime: now + 3600, status: 1, isDel: 0 }).returning();
        if (mode === 'supplier-allocation') await whole.db.update(storeProduct).set({ type: 0, relationId: 0 }).where(eq(storeProduct.id, 71));
        const token = (await createToken(990, 'supplier', md5(key), f.env.APP_KEY)).token;
        await whole.withRuntime(async writer => {
          if (!/^cinashop_runtime_[a-f0-9]{32}$/.test(writer.role)) throw Error('Unowned promotion writer');
          // Exact owned-fixture author additions for real nonzero checkout and
          // ledger FOR UPDATE locks. No production role installer or DELETE.
          await whole.exec(`GRANT SELECT ON public.store_promotions_auxiliary TO "${writer.role}"`);
          await whole.exec(`GRANT UPDATE(id) ON public.store_promotions_auxiliary TO "${writer.role}"`);
          const [auxiliaryRights] = await writer.db.execute(sql`SELECT
            has_table_privilege(current_user,'store_promotions_auxiliary','SELECT') AS reads,
            has_column_privilege(current_user,'store_promotions_auxiliary','id','UPDATE') AS locks,
            has_column_privilege(current_user,'store_promotions_auxiliary','surplus_num','UPDATE') AS quota,
            has_table_privilege(current_user,'store_promotions_auxiliary','INSERT') AS inserts,
            has_table_privilege(current_user,'store_promotions_auxiliary','DELETE') AS deletes`);
          expect(auxiliaryRights).toEqual({ reads: true, locks: true, quota: false, inserts: false, deletes: false });
          await whole.exec(`GRANT SELECT,INSERT ON public.store_order_promotions TO "${writer.role}"`);
          await whole.exec(`GRANT UPDATE(id) ON public.store_order_promotions TO "${writer.role}"`);
          await whole.exec(`GRANT USAGE ON SEQUENCE public.store_order_promotions_id_seq TO "${writer.role}"`);
          let targets: Array<typeof storeOrder.$inferSelect>;
          if (mode === 'fulfillment') {
            const source = await writer.createPaid({ key: 'real-promotion-fulfillment', orderId: 'real_promotion_fulfillment' });
            expect(Number(source.promotionsPrice)).toBeGreaterThan(0);
            const split = await new SupplierFulfillmentService(writer.container, whole.env).splitDelivery(7, source.id,
              { deliveryType: 'express', deliveryName: 'Local', deliveryCode: 'local', deliveryId: 'PROMOTION-ONLY', fictitiousContent: '', deliveryUid: 0 },
              [{ cartId: (await writer.carts(source.id)).find(row => row.productId === 70)!.cartId, cartNum: 1 }]);
            targets = [await writer.order(source.id), await writer.order(split.order_id), await writer.order(split.remaining_order_id!)];
          } else {
            const created = await writer.checkout({ key: 'real-promotion-allocation', orderId: 'real_promotion_allocation' });
            // Synthetic paid admission only; actual allocation remains the
            // registered writer and this is not a provider/payment callback.
            const [paid] = await whole.db.update(storeOrder).set({ paid: 1, payType: 'yue', payTime: 100, tradeNo: 'LOCAL-ONLY' })
              .where(eq(storeOrder.orderId, created.orderId)).returning();
            expect(Number(paid.promotionsPrice)).toBeGreaterThan(0);
            const allocated = await withTx(writer.container, tx => allocatePaidOrderBySupplier(tx, paid.id, paid.orderId, 100));
            expect(allocated.split).toBe(true); targets = allocated.fulfillmentOrders.filter(order => order.supplierId === 7); expect(targets).toHaveLength(1);
          }
          const ledgers = await whole.db.select().from(storeOrderPromotions).orderBy(storeOrderPromotions.id);
          await whole.db.update(storePromotions).set({ name: '已变更的当前名称', title: '已变更的当前标题', discount: '10.00', status: 0, stopTime: 1 }).where(eq(storePromotions.id, campaign.id));
          await whole.withRuntimeRole!(async peer => {
            await whole.exec(`GRANT SELECT ON public.system_admin,public.system_role,public.system_supplier,public.system_menus,public.store_order,public.store_order_cart_info,public.store_order_invoice,public.store_order_promotions,public.store_promotions,public."user",public.system_attachment TO "${peer.role}"`);
            wiring.container = createContainerFromDb(peer.db);
            const [rights] = await peer.db.execute(sql`SELECT current_user=session_user AS independent,
              has_any_column_privilege(current_user,'store_order_promotions','UPDATE') AS writes`);
            expect(rights).toEqual({ independent: true, writes: false });
            const allState = async () => {
              const result: Record<string, unknown> = {};
              for (const table of (await whole.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows) {
                if (!/^[a-z][a-z0-9_]*$/.test(table.tablename)) throw Error('Unowned promotion table');
                result[table.tablename] = (await whole.query(`SELECT to_jsonb(t) AS row FROM public."${table.tablename}" t ORDER BY to_jsonb(t)::text`)).rows;
              }
              for (const sequence of (await whole.query("SELECT sequencename FROM pg_sequences WHERE schemaname='public' ORDER BY sequencename")).rows) {
                if (!/^[a-z][a-z0-9_]*$/.test(sequence.sequencename)) throw Error('Unowned promotion sequence');
                result['sequence:' + sequence.sequencename] = (await whole.query(`SELECT last_value,is_called FROM public."${sequence.sequencename}"`)).rows;
              } return result;
            };
            for (const target of targets) {
              const before = await allState(), response = await app.request('/supplierapi/order/info/' + target.id,
                { headers: { Authorization: 'Bearer ' + token } }, { ...whole.env, APP_KEY: f.env.APP_KEY, NODE_ENV: 'test' });
              const result = await response.json<Envelope>(); expect(result.status, result.msg).toBe(200);
              const sum = ledgers.filter(row => row.oid === target.id).reduce((total, row) => total + Math.round(Number(row.promotionsPrice) * 100), 0);
              expect(result.data.review.promotions).toEqual({ order_id: target.id, state: 'recorded', reason: '', basis: 'modern', total: (sum / 100).toFixed(2),
                items: [{ promotion_id: campaign.id, promotion_type: 1, frozen_name: '真实下单九折', current_title: '已变更的当前标题', amount: (sum / 100).toFixed(2) }] });
              expect((sum / 100).toFixed(2)).toBe(target.promotionsPrice); expect(await allState()).toEqual(before);
            }
            expect(await whole.db.select().from(storeOrderPromotions).orderBy(storeOrderPromotions.id)).toEqual(ledgers);
          });
        });
      } finally { await whole.close(); }
    }, 120000);
});
