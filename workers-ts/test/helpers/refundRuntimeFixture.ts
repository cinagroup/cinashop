/** Local PG16 acceptance only, not a production role installer. Complete
 * registered schema and a separately authenticated non-owner LOGIN. */
import { and, eq, sql } from 'drizzle-orm';
import { expect } from 'vitest';
import { checkoutPricingMigrationDatabase as sequenceRunnerDatabase, type SequenceRunnerPeer } from './checkoutPricingMigrationDatabase';
import { createPcCheckoutQuoteFixture } from './pcCheckoutQuoteFixture';
import { createContainerFromDb, withTx } from '../../src/lib/di';
import { MigrationService } from '../../src/services/MigrationService';
import { runInvoiceEvidence } from '../../src/migrations/runInvoiceEvidence';
import { runRefundOrderSplit } from '../../src/migrations/runRefundOrderSplit';
import { runPurchaseOriginEvidence } from '../../src/migrations/runPurchaseOriginEvidence';
import { runPurchaseCancellationEvidence } from '../../src/migrations/runPurchaseCancellationEvidence';
import { StoreOrderCreateService } from '../../src/services/order/StoreOrderCreateService';
import { StoreOrderInvoiceService } from '../../src/services/order/StoreOrderInvoiceService';
import { applyOrderRefundWithMaterialization, finalizeStoreOrderRefund } from '../../src/services/order/StoreOrderRefundService';
import { allocatePaidOrderBySupplier } from '../../src/services/order/OrderSupplierAllocationService';
import { recordSupplierPayment } from '../../src/services/supplier/SupplierFinanceService';
import { memberRight, storeCart, storeOrder, storeOrderCartInfo, storeOrderRefundSplit, storeProduct,
  storeProductAttrValue, systemSupplier, user, userInvoice } from '../../src/models/schema';

// Exact service-scenario profile. No ALL/default privileges, no new authority on
// missing-permission errors. Pricing sources remain SELECT-only; the reviewed
// fixed function provides locking, with EXECUTE granted explicitly below.
export const runtimeTablePrivileges: Record<string, readonly string[]> = {
  user: ['SELECT', 'UPDATE'], store_cart: ['SELECT', 'UPDATE'],
  store_product: ['SELECT', 'UPDATE'], store_product_attr_value: ['SELECT', 'UPDATE'],
  store_order: ['SELECT', 'INSERT', 'UPDATE'],
  store_order_cart_info: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
  store_order_refund: ['SELECT', 'INSERT', 'UPDATE'],
  store_order_invoice: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
  store_order_status: ['SELECT', 'INSERT'], store_order_outbox: ['SELECT', 'INSERT'],
  user_bill: ['SELECT', 'INSERT', 'UPDATE'], user_brokerage: ['SELECT', 'INSERT', 'UPDATE'],
  supplier_flowing_water: ['SELECT', 'INSERT', 'UPDATE'], supplier_transactions: ['SELECT', 'INSERT'],
  member_right: ['SELECT'], system_config: ['SELECT'], payment_reconciliation_case: ['SELECT', 'INSERT', 'UPDATE'],
  user_address: ['SELECT'], city_area: ['SELECT'], system_user_level: ['SELECT'], agent_level: ['SELECT'],
  system_supplier: ['SELECT'], system_store: ['SELECT'], user_invoice: ['SELECT'],
  shipping_templates: ['SELECT'], shipping_templates_region: ['SELECT'],
  shipping_templates_free: ['SELECT'], shipping_templates_no_delivery: ['SELECT'],
  print_document: ['SELECT'], supplier_extract: ['SELECT'], order_waybill_job: ['SELECT'],
  store_order_refund_payment: ['SELECT'],
  // These are commissioned by the actual reviewed maintenance protocols.
  store_order_purchase_origin: ['SELECT', 'INSERT'],
  store_order_purchase_cancellation: ['SELECT', 'INSERT'],
  store_order_invoice_evidence: ['SELECT'], store_order_invoice_allocation: ['SELECT', 'INSERT'],
  store_order_refund_split: ['SELECT', 'INSERT'], store_order_fulfillment_branch: ['SELECT', 'INSERT'],
};
export const runtimeRowLockTables = ['user_address', 'city_area', 'system_user_level', 'agent_level',
  'system_supplier', 'user_invoice', 'supplier_transactions', 'order_waybill_job'] as const;
const protectedTables = new Set(['store_order_invoice_evidence', 'store_order_invoice_allocation',
  'store_order_refund_split', 'store_order_fulfillment_branch', 'store_order_purchase_origin', 'store_order_purchase_cancellation']);
export const runtimeSequenceTables = ['store_order', 'store_order_cart_info', 'store_order_refund',
  'store_order_invoice', 'store_order_status', 'store_order_outbox', 'user_bill', 'user_brokerage',
  'supplier_flowing_water', 'supplier_transactions', 'payment_reconciliation_case'] as const;
export const shipping = { deliveryType: 'express', deliveryName: 'Local', deliveryCode: 'local',
  deliveryId: 'NO-SHIPMENT', fictitiousContent: '', deliveryUid: 0 } as const;

export async function refundRuntimeFixture() {
  if (!process.env.TEST_FINANCE_POSTGRES_URL) throw Error('Native isolated PG16 is required');
  const whole = await sequenceRunnerDatabase();
  try {
    if (!whole.withRuntimeRole) throw Error('Independent runtime LOGIN is required');
    await whole.exec('SET client_min_messages=warning');
    expect(await new MigrationService(createContainerFromDb(whole.db)).runAll()).toEqual({
      executed: Array.from({ length: 173 }, (_, i) => String(i).padStart(4, '0')), errors: [],
    });
    const [catalog] = await whole.db.execute(sql`SELECT count(*)::integer AS tables FROM pg_class
      WHERE relnamespace='public'::regnamespace AND relkind='r'`);
    expect(catalog.tables).toBe(279);
    // The fresh migration seeds integral at id=1; the existing quote fixture
    // owns ids 1/2. Relocate that one synthetic default, retaining its content.
    const moved = await whole.db.update(memberRight).set({ id: 3 })
      .where(and(eq(memberRight.id, 1), eq(memberRight.rightType, 'integral'))).returning({ id: memberRight.id });
    expect(moved).toEqual([{ id: 3 }]);
    const f = await createPcCheckoutQuoteFixture([], async () => ({ db: whole.db, exec: whole.exec, close: async () => {} }));
    await f.setConfig(Object.fromEntries(Object.keys(f.config).map(key => [key, '0'])));
    await f.setConfig({ integral_ratio_status: '1', integral_ratio: '0.01', integral_max_type: '1', integral_max_num: '100' });
    Object.assign(f.config, { brokerage_func_status: '1', store_brokerage_statu: '1', brokerage_level: '1',
      brokerage_compute_type: '1', store_brokerage_ratio: '10' });
    await f.db.update(user).set({ spreadUid: 22 }).where(eq(user.uid, 11));
    await f.db.insert(user).values({ uid: 22, account: 'Local runtime referrer', status: 1, isPromoter: 1, spreadOpen: 1 });
    await f.db.insert(systemSupplier).values({ id: 7, adminId: 7, supplierName: 'Local runtime supplier' });
    await f.db.update(storeProduct).set({ type: 2, relationId: 7, freight: 2, tempId: 0,
      postage: '3.00', giveIntegral: '100.00', isSub: 1 }).where(eq(storeProduct.id, 70));
    await f.db.update(storeProductAttrValue).set({ settlePrice: '2.50', cost: '2.00', brokerage: '0.30' })
      .where(eq(storeProductAttrValue.id, 1));
    await f.db.insert(storeProduct).values({ id: 71, type: 2, relationId: 7, storeName: 'Local runtime remainder',
      price: '30.00', stock: 8, isShow: 1, freight: 1 });
    await f.db.insert(storeProductAttrValue).values({ id: 2, productId: 71, unique: 'runtim71',
      suk: 'Standard', price: '30.00', settlePrice: '20.00', stock: 8 });
    await f.db.insert(storeCart).values({ id: 2, uid: 11, productId: 71, productAttrUnique: 'runtim71', cartNum: 1, status: 1, isNew: 1 });
    await f.db.insert(userInvoice).values({ id: 1, uid: 11, name: 'Local test title', dutyNumber: 'LOCAL-ONLY' });

    const withRuntime = <T>(callback: (runtime: ReturnType<typeof operations>) => Promise<T>) =>
      whole.withRuntimeRole!(async peer => {
        for (const [table, privileges] of Object.entries(runtimeTablePrivileges)) {
          if (!protectedTables.has(table)) await whole.exec(`GRANT ${privileges.join(',')} ON public."${table}" TO "${peer.role}"`);
        }
        for (const table of runtimeRowLockTables)
          await whole.exec(`GRANT UPDATE(id) ON public."${table}" TO "${peer.role}"`);
        for (const table of runtimeSequenceTables)
          await whole.exec(`GRANT USAGE ON SEQUENCE public."${table}_id_seq" TO "${peer.role}"`);
        await whole.exec(`GRANT EXECUTE ON FUNCTION public.checkout_lock_pricing_v1() TO "${peer.role}"`);
        expect((await runInvoiceEvidence(whole.db, peer.role)).runtimeReady).toBe(true);
        expect((await runRefundOrderSplit(whole.db, peer.role)).runtimeReady).toBe(true);
        expect((await runPurchaseOriginEvidence(whole.db, peer.role)).runtimeReady).toBe(true);
        expect((await runPurchaseCancellationEvidence(whole.db, peer.role)).runtimeReady).toBe(true);
        return callback(operations(peer));
      });
    const state = async () => {
      // All rows of the finite synthetic scenario, including deferred outbox and
      // immutable evidence; sequence gaps on rollback are intentionally normal.
      const rows: Record<string, unknown> = {};
      for (const table of Object.keys(runtimeTablePrivileges).sort()) {
        const result = await whole.query(`SELECT to_jsonb(t) AS row FROM public."${table}" t ORDER BY to_jsonb(t)::text`);
        rows[table] = result.rows;
      }
      return rows;
    };
    function operations(peer: SequenceRunnerPeer & { role: string }) {
      const container = createContainerFromDb(peer.db);
      let applicationNumber = 0;
      const order = async (id: number) => (await peer.db.select().from(storeOrder).where(eq(storeOrder.id, id)))[0];
      const carts = (id: number) => peer.db.select().from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid, id)).orderBy(storeOrderCartInfo.id);
      const checkout = (identity = { key: 'runtime-checkout', orderId: 'runtime_checkout' }) => StoreOrderCreateService.createWithRuntime(container,
        { CONFIG_KV: f.env.CONFIG_KV, nextOrderId: async () => identity.orderId },
        { uid: 11, key: identity.key, cartIds: [1, 2], addressId: 11, userIp: '127.0.0.1', useIntegral: true });
      const createPaid = async (identity?: { key: string; orderId: string }) => {
        const created = await checkout(identity);
        // Synthetic payment fixture, NOT provider/callback/Hyperdrive acceptance.
        const [paid] = await whole.db.update(storeOrder).set({ paid: 1, payType: 'yue', payTime: 100, tradeNo: 'LOCAL-ONLY' })
          .where(eq(storeOrder.orderId, created.orderId)).returning();
        return withTx(container, async tx => {
          const allocated = await allocatePaidOrderBySupplier(tx, paid.id, paid.orderId, 100);
          for (const child of allocated.fulfillmentOrders) await recordSupplierPayment(tx, child, 100);
          expect(allocated.fulfillmentOrders).toHaveLength(1);
          return allocated.fulfillmentOrders[0];
        });
      };
      const apply = async (id: number, productId = 70, quantity = 1) => {
        const current = await order(id), line = (await carts(id)).find(row => row.productId === productId);
        if (!line) throw Error('Required synthetic cart not found');
        return applyOrderRefundWithMaterialization(container, { uid: 11, orderId: current.orderId,
          applyType: 1, refundReason: 'Local runtime test', refundExplain: '', applicationOrderId: `runtime_refund_${++applicationNumber}`,
          cartSelections: [{ cartId: Number(line.cartId), cartNum: quantity }] });
      };
      const receipt = async (id: number) => (await peer.db.select().from(storeOrderRefundSplit).where(eq(storeOrderRefundSplit.refundId, id)))[0];
      return { ...peer, container, order, carts, checkout, createPaid, apply, receipt,
        finish: (id: number) => finalizeStoreOrderRefund(container, id),
        invoice: (id: number) => new StoreOrderInvoiceService(container).makeUp(11, id, 1) };
    }
    return { ...whole, env: f.env, withRuntime, state };
  } catch (error) { await whole.close(); throw error; }
}
