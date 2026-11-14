import { withTx } from '@/lib/di';
import { allocatePaidOrderBySupplier } from '@/services/order/OrderSupplierAllocationService';
import { describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { withBuyerInvoices } from './helpers/buyerInvoices';
import { storeOrder, storeOrderInvoice, storeProduct, storeProductAttrValue, systemSupplier, user, userInvoice } from '@/models/schema';
import { buyerInvoiceQuery, parseBuyerInvoicePage, buyerInvoiceDraft, type BuyerInvoiceTitle } from '../../view/common/buyerInvoices';
import { StoreOrderCreateService } from '@/services/order/StoreOrderCreateService';
import { applyStoreOrderBalancePayment } from '@/services/order/StoreOrderPayService';
import { md5 } from '@/utils/jwt';
import { ROUTINE_PAYMENT_ATTEMPT_SQL, inspectRoutinePaymentAttempt } from '@/migrations/routinePaymentAttempt';
import { outcome, waitForFinanceBlock } from './helpers/financePeers';
type S = Parameters<Parameters<typeof withBuyerInvoices>[0]>[0];
const selection = (t: BuyerInvoiceTitle) => ({ invoiceId: t.id, invoiceRevision: t.revision });
const options = { cartIds: [1, 2], addressId: 11, shippingType: 1, couponId: 0, useIntegral: false };
function sequence(s: S) {
  let counter = 0;
  Object.assign(s.env, { SEQUENCE: { idFromName: () => 'owned-checkout-sequence', get: () => ({ fetch: async () => new Response('checkout_invoice_' + ++counter) }) } });
}
async function title(s: S, special = false) {
  const r = await s.request('/api/invoice/save?view=buyer', { id: 0, revision: '', headerType: special ? 2 : 1, type: special ? 2 : 1,
    name: special ? '本机开票公司' : '本机买家', dutyNumber: special ? 'A'.repeat(18) : '', drawerPhone: '13800000000', email: 'buyer@example.invalid',
    tell: special ? '010-00000000' : '', address: special ? '本机注册地址' : '', bank: special ? '本机银行' : '', cardNumber: special ? '000123456789' : '', isDefault: true });
  expect(r.status, r.msg).toBe(200);
  const list = await s.request('/api/invoice?view=buyer'); expect(list.status, list.msg).toBe(200);
  return (parseBuyerInvoicePage(list.data, buyerInvoiceQuery('titles'), 11).items as BuyerInvoiceTitle[]).find(t => t.id === r.data.id)!;
}
async function quote(s: S, selected: object = {}, changes: object = {}) {
  const r = await s.request('/api/order/confirm', { ...options, ...selected, ...changes }); expect(r.status, r.msg).toBe(200); return r.data as { orderKey: string; quoteToken: string; invoiceSelection?: { id: number; revision: string } };
}
const create = (s: S, q: Awaited<ReturnType<typeof quote>>, selected: object = {}, changes: object = {}) => s.request('/api/order/create/' + q.orderKey, { ...options, quoteToken: q.quoteToken, ...selected, ...changes });
const invoices = (s: S) => s.f.db.select().from(storeOrderInvoice);

/** The sequence adapter returns only declared local identifiers. Every buyer
 * business response below comes from actual App/UserJWT and commissioned LOGIN.
 * The optional balance transition uses only local fixture money, no provider or Queue. */
describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('checkout invoice actual App, immutable receipt and independently authenticated PG16', () => {
  it.each([false, true])('atomically captures the selected ordinary/special title with an unpaid order (special=%s)', async special => withBuyerInvoices(async s => {
    sequence(s); const t = await title(s, special), selected = selection(t), before = await s.f.state(), q = await quote(s, selected);
    expect(q.invoiceSelection).toEqual({ id: t.id, revision: t.revision }); expect(await s.f.state()).toEqual(before);
    const computed = await s.request('/api/order/computed/' + q.orderKey, { ...options, ...selected }); expect(computed.status, computed.msg).toBe(200); expect(computed.data.invoiceSelection).toEqual(q.invoiceSelection);
    const made = await create(s, q, selected); expect(made.status, made.msg).toBe(200);
    const [o] = await s.f.db.select().from(storeOrder).where(eq(storeOrder.orderId, made.data.orderId));
    expect(o).toMatchObject({ uid: 11, paid: 0, payPrice: '56.00' });
    const [i] = await invoices(s); expect(i).toMatchObject({ uid: 11, orderId: o.id, invoiceId: t.id, isPay: 0, isInvoice: 0, invoiceAmount: o.payPrice,
      name: t.name, dutyNumber: t.dutyNumber, bank: t.bank, cardNumber: t.cardNumber, email: t.email });
    const evidence = await s.f.exec(`SELECT invoice_id,kind,snapshot FROM public.store_order_invoice_evidence WHERE invoice_id=${i.id} ORDER BY kind`);
    expect(evidence).toHaveLength(1); expect(evidence[0].kind).toBe('created');
    const edit = await s.request('/api/invoice/save?view=buyer', { ...buyerInvoiceDraft(t), name: special ? '本机后改公司' : '本机后改' }); expect(edit.status, edit.msg).toBe(200);
    const viewed = await s.request('/api/order/invoice_detail/' + o.orderId + '?view=buyer'); expect(viewed.status, viewed.msg).toBe(200); expect(viewed.data.invoice).toMatchObject({ name: t.name, amount: '56.00', paid: false, state: 0 });
    expect(await s.f.exec(`SELECT invoice_id,kind,snapshot FROM public.store_order_invoice_evidence WHERE invoice_id=${i.id} ORDER BY kind`)).toEqual(evidence);
  }), 120000);
  it('retains the unpaid invoice and immutable evidence after an actual owner cancellation', async () => withBuyerInvoices(async s => {
    sequence(s); const t = await title(s), q = await quote(s, selection(t)), made = await create(s, q, selection(t)); expect(made.status, made.msg).toBe(200);
    const [order] = await s.f.db.select().from(storeOrder), captured = await invoices(s), evidence = await s.f.exec('SELECT * FROM public.store_order_invoice_evidence ORDER BY invoice_id,kind,document_number');
    const cancelled = await s.request('/api/order/cancel', { id: order.orderId }); expect(cancelled.status, cancelled.msg).toBe(200);
    const viewed = await s.request('/api/order/invoice_detail/' + order.orderId + '?view=buyer'); expect(viewed.status).toBe(404);
    const [deleted] = await s.f.db.select().from(storeOrder).where(eq(storeOrder.id, order.id)); expect(deleted).toMatchObject({ status: -2, paid: 0, isDel: 1 });
    expect(await invoices(s)).toEqual(captured); expect(await s.f.exec('SELECT * FROM public.store_order_invoice_evidence ORDER BY invoice_id,kind,document_number')).toEqual(evidence);
  }), 120000);
  it('honors PHP late invoice_id selection while versioned selection requires an invoice-bearing quote', async () => withBuyerInvoices(async s => {
    sequence(s); const t = await title(s), q = await quote(s), before = await s.f.state();
    expect((await create(s,q,selection(t))).status).not.toBe(200); expect(await s.f.state()).toEqual(before);
    const late = await create(s,q,{ invoice_id:t.id }); expect(late.status,late.msg).toBe(200);
    expect((await invoices(s))[0]).toMatchObject({ invoiceId:t.id,name:t.name,isPay:0,invoiceAmount:'56.00' });
  }), 120000);
  it('preserves no-invoice checkout and never backfills a replayed existing order from a later selection', async () => withBuyerInvoices(async s => {
    sequence(s); const t = await title(s), q = await quote(s); expect(q.invoiceSelection).toBeUndefined();
    const a = await create(s, q); expect(a.status, a.msg).toBe(200); const before = await s.f.state();
    const b = await create(s, q, selection(t)); expect(b.status, b.msg).toBe(200); expect(b.data).toEqual(a.data); expect(await s.f.state()).toEqual(before); expect(await invoices(s)).toEqual([]);
  }), 120000);
  it('replays a committed invoice order without reading a changed/deleted title or disabled rules', async () => withBuyerInvoices(async s => {
    sequence(s); const t = await title(s), q = await quote(s, selection(t)), a = await create(s, q, selection(t)); expect(a.status, a.msg).toBe(200);
    const deleted = await s.request('/api/invoice/del/' + t.id + '?view=buyer', { revision: t.revision }, undefined, 'DELETE'); expect(deleted.status, deleted.msg).toBe(200); await s.flags('0');
    const before = await s.f.state(), b = await create(s, q, { invoice_id: 'malformed-replay-input' }); expect(b.status, b.msg).toBe(200); expect(b.data).toEqual(a.data); expect(await s.f.state()).toEqual(before); expect(await invoices(s)).toHaveLength(1);
  }), 120000);
  it('rejects foreign/deleted/malformed selections and conflicting aliases before any business write', async () => withBuyerInvoices(async s => {
    sequence(s); const t = await title(s); await s.f.db.insert(userInvoice).values({ uid: 22, name: '本机他人', drawerPhone: '13800000000', email: 'foreign@example.invalid' });
    const [foreign] = await s.f.db.select().from(userInvoice).where(eq(userInvoice.uid,22)), before = await s.f.state();
    for (const bad of [{ invoice_id: foreign.id }, { invoiceId: t.id, invoice_id: foreign.id }, { invoiceId: null }, { invoiceId: true }, { invoiceId: t.id, invoiceRevision: 'b'.repeat(64) }]) {
      expect((await s.request('/api/order/confirm', { ...options, ...bad })).status).not.toBe(200); expect(await s.f.state()).toEqual(before);
    }
    const q = await quote(s, { invoice_id: t.id });
    await s.request('/api/invoice/del/' + t.id + '?view=buyer', { revision: t.revision }, undefined, 'DELETE'); const deleted = await s.f.state();
    expect((await create(s, q, { invoice_id: t.id })).status).not.toBe(200); expect(await s.f.state()).toEqual(deleted);
  }), 120000);
  it('binds invoice presence/id/revision and current SQL rules into the immutable quote', async () => withBuyerInvoices(async s => {
    sequence(s); const t = await title(s), q = await quote(s, selection(t)), before = await s.f.state();
    expect((await create(s, q)).status).not.toBe(200); expect(await s.f.state()).toEqual(before);
    const edited = await s.request('/api/invoice/save?view=buyer', { ...buyerInvoiceDraft(t), name: '本机改抬头' }); expect(edited.status, edited.msg).toBe(200); const changed = await s.f.state();
    expect((await create(s, q, { invoice_id: t.id })).status).not.toBe(200); expect(await s.f.state()).toEqual(changed);
    const fresh = await quote(s, { invoice_id: t.id }); await s.flags('0'); const disabled = await s.f.state();
    expect((await create(s, fresh, { invoice_id: t.id })).status).not.toBe(200); expect(await s.f.state()).toEqual(disabled);
  }), 120000);
  it('rejects zero-amount applications without reserving the cart or stock', async () => withBuyerInvoices(async s => {
    sequence(s); const t = await title(s); await s.f.db.update(storeProduct).set({ freight: 1 }).where(eq(storeProduct.id,70)); await s.f.db.update(storeProductAttrValue).set({ price:'0.00',vipPrice:'0.00' }).where(eq(storeProductAttrValue.id,1));
    const before = await s.f.state(), r = await s.request('/api/order/confirm', { ...options, cartIds:[1], ...selection(t) }); expect(r.status).not.toBe(200); expect(r.msg).toContain('0'); expect(await s.f.state()).toEqual(before);
  }), 120000);
  it.each(['live','deleted'] as const)('rejects an orphan invoice association before adopting a new order PK (%s)', async kind => withBuyerInvoices(async s => {
    sequence(s); const t = await title(s), q = await quote(s,selection(t));
    const [orphan] = await s.f.db.insert(storeOrderInvoice).values({ uid:22,orderId:1,invoiceId:0,name:'本机历史遗留',invoiceAmount:'9.00' }).returning();
    if (kind === 'deleted') await s.f.db.delete(storeOrderInvoice).where(eq(storeOrderInvoice.id,orphan.id));
    const before = await s.f.state(); expect((await create(s,q,selection(t))).status).not.toBe(200); expect(await s.f.state()).toEqual(before);
  }), 120000);
  it.each([{table:'store_order_invoice',trigger:'soi_capture_evidence'},{table:'store_order_invoice_evidence',trigger:'soie_no_rewrite'}])('rejects drifted invoice storage at $trigger without retaining order resources', async ({table,trigger}) => withBuyerInvoices(async s => {
    sequence(s); const t = await title(s), q = await quote(s,selection(t)), before = await s.f.state();
    await s.f.exec(`ALTER TABLE public.${table} DISABLE TRIGGER ${trigger}`);
    try { expect((await create(s,q,selection(t))).status).not.toBe(200); expect(await s.f.state()).toEqual(before); }
    finally { await s.f.exec(`ALTER TABLE public.${table} ENABLE TRIGGER ${trigger}`); }
  }), 120000);
  it('rolls back all prior order resource writes when the application lacks invoice INSERT authority', async () => withBuyerInvoices(async s => {
    sequence(s); const t = await title(s), q = await quote(s, selection(t)), before = await s.f.state();
    expect(s.appRole).toMatch(/^[a-z_][a-z0-9_]{0,62}$/);
    const [original] = await s.f.exec(`SELECT has_table_privilege('${s.appRole}','public.store_order_invoice','INSERT') AS allowed`); expect(original.allowed).toBe(true);
    await s.f.exec(`REVOKE INSERT ON TABLE public.store_order_invoice FROM "${s.appRole}"`);
    try { expect((await create(s,q,selection(t))).status).not.toBe(200); expect(await s.f.state()).toEqual(before); }
    finally { await s.f.exec(`GRANT INSERT ON TABLE public.store_order_invoice TO "${s.appRole}"`); }
    const retry = await create(s,q,selection(t)); expect(retry.status,retry.msg).toBe(200); expect(await invoices(s)).toHaveLength(1);
  }), 120000);
  it('fails without waiting behind a title writer and leaves all order resources unchanged', async () => withBuyerInvoices(async s => {
    sequence(s); const t = await title(s), q = await quote(s,selection(t)), before = await s.f.state();
    await s.f.withRuntime(async holder => {
      await holder.exec('BEGIN'); await holder.db.select({ id:userInvoice.id }).from(userInvoice).where(eq(userInvoice.id,t.id)).for('update');
      try { const rejected = await create(s,q,selection(t)); expect(rejected.status).not.toBe(200); expect(rejected.data?.errorCode).toBe('ORDER_QUOTE_RECONFIRM_REQUIRED'); }
      finally { await holder.exec('ROLLBACK'); }
    });
    expect(await s.f.state()).toEqual(before);
  }), 120000);
  it('serializes concurrent valid receipts on independent LOGINs into one order and one invoice', async () => withBuyerInvoices(async s => {
    sequence(s); const t = await title(s), q = await quote(s,selection(t));
    const [account] = await s.f.db.select().from(user).where(eq(user.uid,11));
    await s.f.withRuntime(holder => s.f.withRuntime(first => s.f.withRuntime(async second => {
      await holder.exec('BEGIN'); await holder.db.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`cinashop:create-order:11:${q.orderKey}`},0::bigint))`);
      const run = (r: typeof first, suffix: string) => StoreOrderCreateService.createWithRuntime(r.container,{ CONFIG_KV:s.env.CONFIG_KV, requireConfirmation:true, requirePurchaseOrigin:true,
        checkoutInvoiceActor:{ uid:11,authVersion:md5(account.pwd),expiresAt:Math.floor(Date.now()/1000)+300 }, nextOrderId:async()=> 'concurrent_invoice_'+suffix }, { ...options, ...selection(t), uid:11, key:q.orderKey, quoteToken:q.quoteToken, userIp:'127.0.0.1' });
      const a=outcome(run(first,'a')), b=outcome(run(second,'b'));
      try { await waitForFinanceBlock(s.f.db,first.pid,holder.pid); await waitForFinanceBlock(s.f.db,second.pid,holder.pid); }
      finally { await holder.exec('COMMIT'); }
      const results=await Promise.all([a,b]); expect(results[0].ok).toBe(true); expect(results[1]).toEqual(results[0]);
    })));
    expect(await s.f.db.select().from(storeOrder)).toHaveLength(1); expect(await invoices(s)).toHaveLength(1);
  }), 120000);
  it('uses the existing local balance transition to mark the captured application paid without issuing a document', async () => withBuyerInvoices(async s => {
    sequence(s); await s.f.db.insert(systemSupplier).values({ id:8,adminId:8,supplierName:'Local invoice second supplier' }); await s.f.db.update(storeProduct).set({ relationId:8 }).where(eq(storeProduct.id,71));
    await s.f.db.update(user).set({ nowMoney:'1000.00' }).where(eq(user.uid,11)); const t=await title(s,true), q=await quote(s,selection(t)), made=await create(s,q,selection(t)); expect(made.status,made.msg).toBe(200);
    const [i]=await invoices(s), before=await s.f.exec(`SELECT snapshot FROM public.store_order_invoice_evidence WHERE invoice_id=${i.id} AND kind='created'`);
    // Explicit optional receipt-store commissioning in this disposable fixture.
    // Preserve the production local-payment readiness gate and all its checks.
    const [ledger] = await s.f.exec("SELECT to_regclass('public.routine_payment_attempt') AS name"); expect(ledger.name).toBeNull();
    await s.f.exec(ROUTINE_PAYMENT_ATTEMPT_SQL); expect(await inspectRoutinePaymentAttempt(s.f.db)).toBe(true);
    expect(s.appRole).toMatch(/^[a-z_][a-z0-9_]{0,62}$/); await s.f.exec(`GRANT SELECT ON TABLE public.routine_payment_attempt TO "${s.appRole}"`);
    const result=await applyStoreOrderBalancePayment(s.appContainer,{ uid:11,orderId:made.data.orderId }); expect(result.outcome).toBe('paid');
    expect((await invoices(s))[0]).toMatchObject({ id:i.id,isPay:1,isInvoice:0,name:t.name,invoiceAmount:'56.00' });
    expect(await s.f.exec(`SELECT snapshot FROM public.store_order_invoice_evidence WHERE invoice_id=${i.id} AND kind='created'`)).toEqual(before);
    const [account]=await s.f.db.select().from(user).where(eq(user.uid,11)); expect(account.nowMoney).toBe('944.00');
    const replay=await applyStoreOrderBalancePayment(s.appContainer,{ uid:11,orderId:made.data.orderId }); expect(replay.outcome).toBe('already-paid');
    expect((await s.f.db.select().from(user).where(eq(user.uid,11)))[0].nowMoney).toBe('944.00');
    expect(await s.f.exec('SELECT order_no FROM public.routine_payment_attempt')).toHaveLength(0);
    const [root] = await s.f.db.select().from(storeOrder).where(eq(storeOrder.orderId,made.data.orderId));
    const allocated = await withTx(s.appContainer,tx => allocatePaidOrderBySupplier(tx,root.id,root.orderId,Math.floor(Date.now()/1000)));
    expect(allocated.fulfillmentOrders).toHaveLength(2);
    const active = (await invoices(s)).filter(row => !row.isDel); expect(active).toHaveLength(2);
    expect(active.map(row=>row.invoiceAmount).sort()).toEqual(['26.00','30.00']);
    for (const row of active) expect(row).toMatchObject({ invoiceId:t.id,isPay:1,isInvoice:0,name:t.name,bank:t.bank,cardNumber:'000123456789' });
    expect(await s.f.exec(`SELECT snapshot FROM public.store_order_invoice_evidence WHERE invoice_id=${i.id} AND kind='created'`)).toEqual(before);

  }), 120000);
});
