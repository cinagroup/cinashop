import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { PostgresJsSession } from 'drizzle-orm/postgres-js/session';
import { createApp } from '@/app';
import { createContainerFromDb, withTx, type Container } from '@/lib/di';
import { storeOrder, storeOrderInvoice, storeProduct, systemAdmin, systemRole, systemSupplier, userInvoice } from '@/models/schema';
import { StoreOrderInvoiceService } from '@/services/order/StoreOrderInvoiceService';
import { allocatePaidOrderBySupplier } from '@/services/order/OrderSupplierAllocationService';
import { SupplierFulfillmentService } from '@/services/supplier/SupplierFulfillmentService';
import { SupplierOrderReadService } from '@/services/supplier/SupplierOrderReadService';
import { createToken, md5 } from '@/utils/jwt';
import { supplierOrderInvoiceReviewFixture, supplierInvoiceFields } from './helpers/supplierOrderInvoiceReview';
import { refundRuntimeFixture } from './helpers/refundRuntimeFixture';

const wiring = vi.hoisted(() => ({ container: undefined as Container | undefined }));
vi.mock('@/lib/di', async original => ({ ...await original<typeof import('@/lib/di')>(), createContainer: () => {
  if (!wiring.container) throw Error('Missing independent invoice review LOGIN'); return wiring.container;
} }));
type Envelope = { status: number; msg: string; data: any };
const app = createApp();
describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('Supplier invoice application review actual App JWT SELECT-only PG16', () => {
  let f: Awaited<ReturnType<typeof supplierOrderInvoiceReviewFixture>>;
  beforeEach(async () => { f = await supplierOrderInvoiceReviewFixture(); wiring.container = f.container;
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Invoice review must never issue tax/provider/email requests')); }, 30000);
  afterEach(async () => { try { expect(fetch).not.toHaveBeenCalled(); }
    finally { wiring.container = undefined; vi.restoreAllMocks(); await f?.close(); } }, 30000);
  async function unchanged<T>(work: () => Promise<T>) {
    const rows = await f.snapshot(), seq = await f.sequences(); const result = await work();
    expect(await f.snapshot()).toEqual(rows); expect(await f.sequences()).toEqual(seq); return result;
  }
  async function request(id: number | string = 100, actor: keyof typeof f.tokens | 'anonymous' = 'viewer') {
    return unchanged(async () => {
      const response = await app.request('/supplierapi/order/info/' + id, { headers: actor === 'anonymous' ? {}
        : { Authorization: 'Bearer ' + f.tokens[actor], 'X-Supplier-Id': '8' } }, f.env);
      expect(response.headers.get('cache-control')).toContain('no-store'); return response.json<Envelope>();
    });
  }
  async function invoice(id = 100) { const response = await request(id); expect(response.status, response.msg).toBe(200); return response.data.review.invoice; }

  it('reads exactly the eight PHP invoice fields and recorded facts using an independent SELECT-only LOGIN with all SQL rows and sequences unchanged', async () => f.withReader(async peer => {
    wiring.container = peer.container; expect(await invoice()).toEqual({ state: 'recorded', reason: '', record: f.expectedInvoice });
    const [rights] = await peer.db.execute(sql`SELECT current_user=session_user AS independent,
      has_table_privilege(current_user,'store_order_invoice','SELECT') AS reads,
      has_any_column_privilege(current_user,'store_order_invoice','UPDATE') AS writes,
      has_table_privilege(current_user,'user_invoice','SELECT') AS templates,
      has_any_column_privilege(current_user,'store_order','UPDATE') AS orders,
      has_schema_privilege(current_user,'public','CREATE') AS creates,
      (SELECT count(*)::int FROM pg_class WHERE relnamespace='public'::regnamespace AND relowner=(SELECT oid FROM pg_roles WHERE rolname=current_user)) AS owns`);
    expect(rights).toEqual({ independent: true, reads: true, writes: false, templates: false, orders: false, creates: false, owns: 0 });
    expect(JSON.stringify(await invoice())).not.toMatch(/PRIVATE|card_number|cardNumber|tell|invoice_id|invoiceId/);
  }));

  it('retains frozen application fields after mutable customer invoice template edits without reading that template', async () => f.withReader(async peer => {
    wiring.container = peer.container; const before = await invoice();
    await f.db.update(userInvoice).set({ name: '新的可变抬头', dutyNumber: 'CURRENT', email: 'current@example.invalid',
      bank: '当前银行', address: '当前企业地址', drawerPhone: '000000', isDel: 1 }).where(eq(userInvoice.id, 1));
    expect(await invoice()).toEqual(before);
  }));

  it('shows the exact owned payment summary archived application without adding child applications or claiming tax validation', async () => f.withReader(async peer => {
    wiring.container = peer.container; expect(await invoice(200)).toEqual({ state: 'recorded', reason: '',
      record: { ...f.expectedInvoice, id: 502, order_id: 200, archived: true } });
    expect((await request(300)).status).toBe(404);
  }));

  it('prefers the one active exact application over archived history without choosing an arbitrary archived record', async () => f.withReader(async peer => {
    wiring.container = peer.container;
    await f.db.insert(storeOrderInvoice).values({ uid: 11, orderId: 100, ...supplierInvoiceFields, isDel: 1, name: '旧归档抬头' });
    expect((await invoice()).record).toEqual(f.expectedInvoice);
  }));

  it.each([{ archived: false }, { archived: true }])('rejects duplicate candidate applications rather than LIMIT-one selection archived=$archived', async ({ archived }) => f.withReader(async peer => {
    wiring.container = peer.container;
    await f.db.update(storeOrderInvoice).set({ isDel: archived ? 1 : 0 }).where(eq(storeOrderInvoice.id, 501));
    await f.db.insert(storeOrderInvoice).values({ uid: 11, orderId: 100, ...supplierInvoiceFields, isDel: archived ? 1 : 0 });
    expect(await invoice()).toMatchObject({ state: 'unavailable', reason: expect.stringMatching(/多条/), record: null });
  }));

  it('reads a child only from its own application and exposes only unresolved parent existence when the child has none', async () => f.withReader(async peer => {
    wiring.container = peer.container; expect((await invoice(201)).record).toMatchObject({ id: 503, order_id: 201, recorded_amount: '31.50', archived: false });
    expect(await invoice(202)).toEqual({ state: 'none', reason: '', record: null });
    const pending = await invoice(301); expect(pending).toMatchObject({ state: 'unavailable', record: null, reason: expect.stringMatching(/归属处理/) });
    expect(JSON.stringify(pending)).not.toContain('PRIVATE-PLATFORM-ROOT-TAX');
  }));

  it.each([{ patch: { uid: 12 } }, { patch: { category: 'member' } }])('never borrows a mismatched invoice identity $patch', async ({ patch }) => f.withReader(async peer => {
    wiring.container = peer.container; await f.db.update(storeOrderInvoice).set({ ...patch, name: 'PRIVATE-OTHER-INVOICE' }).where(eq(storeOrderInvoice.id, 501));
    const result = await invoice(); expect(result).toMatchObject({ state: 'unavailable', record: null }); expect(JSON.stringify(result)).not.toMatch(/PRIVATE/);
  }));

  it.each([{ patch: { type: 3 } }, { patch: { headerType: 0 } }, { patch: { isInvoice: 2 } },
    { patch: { invoiceAmount: '-1.00' } }, { patch: { name: '坏\u0001抬头' } }])
    ('reports malformed historical invoice fields as unavailable $patch', async ({ patch }) => f.withReader(async peer => {
      wiring.container = peer.container; await f.db.update(storeOrderInvoice).set(patch).where(eq(storeOrderInvoice.id, 501));
      expect(await invoice()).toMatchObject({ state: 'unavailable', record: null });
    }));

  it.each([-1, 0, 1])('returns recorded issuance state %s and genuine recorded zero without interpreting tax-provider validity', async state => f.withReader(async peer => {
    wiring.container = peer.container; await f.db.update(storeOrderInvoice).set({ isInvoice: state, invoiceAmount: '0.00' }).where(eq(storeOrderInvoice.id, 501));
    expect((await invoice()).record).toMatchObject({ recorded_amount: '0.00', issuance_state: state });
  }));

  it.each([-1, 2])('does not mislabel malformed historical deletion state %s as no application', async state => f.withReader(async peer => {
    wiring.container = peer.container; await f.db.update(storeOrderInvoice).set({ isDel: state }).where(eq(storeOrderInvoice.id, 501));
    expect(await invoice()).toMatchObject({ state: 'unavailable', record: null, reason: expect.stringMatching(/历史状态/) });
  }));

  it('accepts complete schema-length Unicode application text instead of counting surrogate pairs as extra characters', async () => f.withReader(async peer => {
    wiring.container = peer.container; const name = '😀'.repeat(100), address = '😀'.repeat(255);
    await f.db.update(storeOrderInvoice).set({ name, address, drawerPhone: '😀'.repeat(30) }).where(eq(storeOrderInvoice.id, 501));
    expect((await invoice()).record).toMatchObject({ name, address, drawer_phone: '😀'.repeat(30) });
  }));

  it.each([{ patch: { uid: 12 } }, { patch: { supplierId: 8 } }, { patch: { storeId: 2 } },
    { patch: { pid: 0 } }, { patch: { isSystemDel: 1 } }])('refuses child invoice projection for an incoherent root $patch', async ({ patch }) => f.withReader(async peer => {
      wiring.container = peer.container; await f.db.update(storeOrder).set(patch).where(eq(storeOrder.id, 200));
      expect(await invoice(201)).toMatchObject({ state: 'unavailable', record: null });
    }));

  it.each([{ actor: 'foreign', id: 100 }, { actor: 'viewer', id: 900 }, { actor: 'denied', id: 100 },
    { actor: 'anonymous', id: 100 }, { actor: 'customer', id: 100 }, { actor: 'admin', id: 100 } ] as const)
    ('does not bypass real Supplier HTTP authorization actor=$actor order=$id', async ({ actor, id }) => f.withReader(async peer => {
      wiring.container = peer.container; expect((await request(id, actor)).status).not.toBe(200);
    }));

  it('keeps invoice private detail out of every list response', async () => f.withReader(async peer => {
    wiring.container = peer.container; const response = await unchanged(async () => (await app.request('/supplierapi/order/list?limit=100',
      { headers: { Authorization: 'Bearer ' + f.tokens.viewer } }, f.env)).json<Envelope>());
    expect(response.status, response.msg).toBe(200); expect(JSON.stringify(response.data)).not.toMatch(/FROZEN-TAX|冻结发票|recorded_amount|issuance_state|invoice/);
  }));

  it('propagates real SQL SELECT denial instead of disguising it as no invoice', async () => f.withReader(async peer => {
    wiring.container = peer.container; expect((await invoice()).state).toBe('recorded');
    await f.exec(`REVOKE SELECT ON public.store_order_invoice FROM "${peer.role}"`);
    await unchanged(() => expect(new SupplierOrderReadService(peer.container).detail(7, 100, f.env.APP_KEY))
      .rejects.toMatchObject({ cause: { code: '42501' } }));
    expect((await request()).status).not.toBe(200);
  }));

  it('uses the same bounded repeatable-read read-only transaction for order and frozen invoice after an independent commit', async () => f.withReader(async peer => {
    wiring.container = peer.container; let reached = false, expected: Awaited<ReturnType<typeof f.snapshot>> | undefined;
    const original = PostgresJsSession.prototype.prepareQuery;
    const spy = vi.spyOn(PostgresJsSession.prototype, 'prepareQuery').mockImplementation(function (this: InstanceType<typeof PostgresJsSession>, ...args) {
      const prepared = original.apply(this, args);
      if (/^select .* from "store_order" where /s.test(args[0].sql)) {
        const execute = prepared.execute.bind(prepared); prepared.execute = async values => { const result = await execute(values);
          if (!reached) { reached = true;
            const [settings] = await this.client.unsafe("SELECT current_setting('transaction_read_only') AS ro,current_setting('transaction_isolation') AS iso,current_setting('statement_timeout') AS timeout");
            expect(settings).toEqual({ ro: 'on', iso: 'repeatable read', timeout: '5s' });
            await f.db.update(storeOrderInvoice).set({ name: '下一快照的新申请抬头' }).where(eq(storeOrderInvoice.id, 501));
            expected = await f.snapshot();
          } return result; };
      }
      return prepared;
    });
    const seq = await f.sequences();
    try {
      const response = await app.request('/supplierapi/order/info/100', { headers: { Authorization: 'Bearer ' + f.tokens.viewer } }, f.env);
      const result = await response.json<Envelope>(); expect(result.status, result.msg).toBe(200); expect(result.data.review.invoice.record.name).toBe(supplierInvoiceFields.name);
    } finally { spy.mockRestore(); }
    expect(reached).toBe(true); expect(await f.snapshot()).toEqual(expected); expect(await f.sequences()).toEqual(seq);
    expect((await invoice()).record.name).toBe('下一快照的新申请抬头');
  }));

  it.each([{ mode: 'fulfillment' }, { mode: 'supplier-allocation' }] as const)
    ('connects real checkout and Customer makeUp to actual $mode then exact Supplier invoice reads with every table and sequence unchanged', async ({ mode }) => {
      const whole = await refundRuntimeFixture();
      try {
        const password = 'owned-actual-invoice-review';
        await whole.db.insert(systemRole).values({ id: 990, type: 4, relationId: 7, rules: 'supplier.order.view' });
        await whole.db.insert(systemAdmin).values({ id: 990, account: 'invoice-actual-reader', pwd: password, adminType: 4, relationId: 7, roles: '990' });
        await whole.db.update(systemSupplier).set({ adminId: 990 }).where(eq(systemSupplier.id, 7));
        await whole.db.update(userInvoice).set(supplierInvoiceFields).where(eq(userInvoice.id, 1));
        const token = (await createToken(990, 'supplier', md5(password), f.env.APP_KEY)).token;
        if (mode === 'supplier-allocation') await whole.db.update(storeProduct).set({ type: 0, relationId: 0 }).where(eq(storeProduct.id, 71));
        await whole.withRuntime(async writer => {
          let targets: Array<typeof storeOrder.$inferSelect>, archivedRoot: typeof storeOrder.$inferSelect | undefined;
          if (mode === 'fulfillment') {
            const source = await writer.createPaid({ key: 'invoice-review-fulfillment', orderId: 'invoice_review_fulfillment' });
            await new StoreOrderInvoiceService(writer.container).makeUp(11, source.id, 1);
            const split = await new SupplierFulfillmentService(writer.container, whole.env).splitDelivery(7, source.id,
              { deliveryType: 'express', deliveryName: 'Local', deliveryCode: 'local', deliveryId: 'INVOICE-ONLY', fictitiousContent: '', deliveryUid: 0 },
              [{ cartId: (await writer.carts(source.id)).find(row => row.productId === 70)!.cartId, cartNum: 1 }]);
            targets = [await writer.order(split.order_id), await writer.order(split.remaining_order_id!)];
            archivedRoot = await writer.order(source.id);
          } else {
            const created = await writer.checkout({ key: 'invoice-review-allocation', orderId: 'invoice_review_allocation' });
            // Fixture-only payment admission. Allocation and application below
            // are real writers; this does not certify a payment callback.
            const [paid] = await whole.db.update(storeOrder).set({ paid: 1, payType: 'yue', payTime: 100, tradeNo: 'LOCAL-ONLY' })
              .where(eq(storeOrder.orderId, created.orderId)).returning();
            const allocation = await withTx(writer.container, tx => allocatePaidOrderBySupplier(tx, paid.id, paid.orderId, 100));
            expect(allocation.split).toBe(true); targets = allocation.fulfillmentOrders.filter(order => order.supplierId === 7);
            expect(targets).toHaveLength(1);
            await new StoreOrderInvoiceService(writer.container).makeUp(11, targets[0].id, 1);
          }
          const frozen = await whole.db.select().from(storeOrderInvoice).orderBy(storeOrderInvoice.id);
          await whole.db.update(userInvoice).set({ name: '当前模板已彻底改变', bank: '当前银行', isDel: 1 }).where(eq(userInvoice.id, 1));
          await whole.withRuntimeRole!(async peer => {
            await whole.exec(`GRANT SELECT ON public.system_admin,public.system_role,public.system_supplier,public.system_menus,public.store_order,public.store_order_cart_info,public.store_order_invoice,public.store_order_promotions,public.store_promotions,public."user",public.system_attachment TO "${peer.role}"`);
            wiring.container = createContainerFromDb(peer.db);
            const [rights] = await peer.db.execute(sql`SELECT current_user=session_user AS independent,
              has_table_privilege(current_user,'store_order_invoice','UPDATE') AS writes,
              has_table_privilege(current_user,'user_invoice','SELECT') AS templates`);
            expect(rights).toEqual({ independent: true, writes: false, templates: false });
            const allState = async () => {
              const state: Record<string, unknown> = {};
              for (const table of (await whole.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows) {
                if (!/^[a-z][a-z0-9_]*$/.test(table.tablename)) throw Error('Unowned invoice table');
                state[table.tablename] = (await whole.query(`SELECT to_jsonb(t) AS row FROM public."${table.tablename}" t ORDER BY to_jsonb(t)::text`)).rows;
              }
              for (const sequence of (await whole.query("SELECT sequencename FROM pg_sequences WHERE schemaname='public' ORDER BY sequencename")).rows) {
                if (!/^[a-z][a-z0-9_]*$/.test(sequence.sequencename)) throw Error('Unowned invoice sequence');
                state['sequence:' + sequence.sequencename] = (await whole.query(`SELECT last_value,is_called FROM public."${sequence.sequencename}"`)).rows;
              }
              return state;
            };
            for (const order of [...targets, ...(archivedRoot ? [archivedRoot] : [])]) {
              const before = await allState(), response = await app.request('/supplierapi/order/info/' + order.id,
                { headers: { Authorization: 'Bearer ' + token } }, { ...whole.env, APP_KEY: f.env.APP_KEY, NODE_ENV: 'test' });
              const result = await response.json<Envelope>(); expect(result.status, result.msg).toBe(200);
              const row = frozen.find(row => row.orderId === order.id)!;
              expect(result.data.review.invoice).toMatchObject({ state: 'recorded', reason: '', record: {
                id: row.id, order_id: order.id, archived: row.isDel === 1, name: supplierInvoiceFields.name,
                recorded_amount: row.invoiceAmount, duty_number: supplierInvoiceFields.dutyNumber, issuance_state: 0 } });
              expect(row.invoiceAmount).toBe(order.payPrice); expect(await allState()).toEqual(before);
            }
            expect(await whole.db.select().from(storeOrderInvoice).orderBy(storeOrderInvoice.id)).toEqual(frozen);
          });
        });
      } finally { await whole.close(); }
    }, 120000);
});
