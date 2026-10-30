import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { createContainerFromDb } from '../../src/lib/di';
import { installCashierSecondCardPromotionLock } from '../../src/migrations/cashierSecondCardPromotionLock';
import { installCustomerManualRefund } from '../../src/migrations/runCustomerManualRefund';
import { runManagerOrderOperation } from '../../src/migrations/runManagerOrderOperation';
import { inspectCustomerFinancialManualRefundRuntime } from '../../src/migrations/customerFinancialManualRefundRuntime';
import { CUSTOMER_FINANCIAL_RUNTIME_ROLE } from '../../src/migrations/customerFinancialRuntimePlan';
import { customerFinancialRuntimeFixture } from './customerFinancialRuntimeFixture';
import { StoreCartService } from '../../src/services/order/StoreCartService';
import { StoreOrderCreateService } from '../../src/services/order/StoreOrderCreateService';
import { OrderOutboxService } from '../../src/services/order/OrderOutboxService';
import { CustomerWorkFinancialReadService } from '../../src/services/customer-work/CustomerWorkFinancialReadService';
import { CUSTOMER_FINANCIAL_QUOTE_VERSION, CUSTOMER_FINANCIAL_VERSION, type FinancialInput,
  type FinancialReceipt } from '../../src/services/customer-work/CustomerWorkFinancialProtocol';
import type { CustomerJson } from '../../src/services/customer-work/CustomerWorkOperationRequest';
import { storeOrder, storeOrderOutbox, storeOrderRefund, storeProduct, storeProductAttrValue, systemConfig } from '../../src/models/schema';

/** Extends the canonical185 owned PG16 fixture through explicit source-owned
 * installers. The fixed Financial LOGIN is first commissioned with its exact
 * base profile. No addon grant, manager-source SELECT or forward happens here.
 * The real paid consumer below uses that actual independently logged-in role;
 * maintenance only supplies product/config inputs and installs protocols. */
export async function customerFinancialManualRuntimeFixture() {
  const f = await customerFinancialRuntimeFixture();
  try {
    await f.commission();
    const runtime = f.login();
    await installCashierSecondCardPromotionLock(f.db, CUSTOMER_FINANCIAL_RUNTIME_ROLE);
    const manualOwner = await f.createOwnedRole('manual');
    const [deadlines] = await f.db.execute<{ statement: string; lock: string; idle: string }>(sql`SELECT
      current_setting('statement_timeout') AS statement,current_setting('lock_timeout') AS lock,
      current_setting('idle_in_transaction_session_timeout') AS idle`);
    try {
      // The published guest-identity owner installer requires explicit bounded
      // maintenance. These owned fixture session settings preserve any tighter
      // existing bound and are restored after this explicit installation.
      await f.db.execute(sql`SELECT
        set_config('statement_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='statement_timeout'),0),5000)::text||'ms',false),
        set_config('lock_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='lock_timeout'),0),1000)::text||'ms',false),
        set_config('idle_in_transaction_session_timeout',LEAST(NULLIF((SELECT setting::bigint FROM pg_settings WHERE name='idle_in_transaction_session_timeout'),0),5000)::text||'ms',false)`);
      await installCustomerManualRefund(f.db, manualOwner.role);
    } finally {
      await f.db.execute(sql`SELECT set_config('statement_timeout',${deadlines.statement},false),
        set_config('lock_timeout',${deadlines.lock},false),set_config('idle_in_transaction_session_timeout',${deadlines.idle},false)`);
    }
    await runManagerOrderOperation(f.db);
    const addon = { promotionOwner: manualOwner.role };
    const pre = await inspectCustomerFinancialManualRefundRuntime(f.db, {
      role: CUSTOMER_FINANCIAL_RUNTIME_ROLE, promotionOwner: manualOwner.role, requirePrivileges: false,
    });
    if (!pre.ready || !pre.catalogReady) throw Error('Explicit installed manual source prerequisites refused: ' + pre.failures.join(','));
    const container = createContainerFromDb(runtime);
    const reader = new CustomerWorkFinancialReadService(container, f.environment);
    const input = async (id: number, payload: CustomerJson = {}): Promise<FinancialInput> => {
      const rows = await f.db.select().from(storeOrder).where(eq(storeOrder.id, id));
      if (rows.length !== 1) throw Error('Owned financial input order missing');
      const response = await f.request('/mobile/work/financial/orders/' + id + '?order_no=' + rows[0].orderId);
      if (response.response.status !== 200 || response.body.status !== 200) throw Error('Actual fixed Financial order route refused: ' + response.body.msg);
      const envelope = response.body.data as Awaited<ReturnType<CustomerWorkFinancialReadService['order']>>;
      return { version: CUSTOMER_FINANCIAL_VERSION, scope_key: envelope.scope_key, order_id: id,
        expected_order_revision: envelope.data.order_revision, expected_financial_revision: envelope.data.financial_revision, payload };
    };
    const newUnpaid = async (price = '7.00', quantity = 1) => {
      await f.db.update(storeProduct).set({ type: 0, relationId: 0, productType: 0, isPresaleProduct: 0,
        freight: 2, tempId: 0, postage: '0.00', giveIntegral: '0.00', isSub: 0 }).where(eq(storeProduct.id, 70));
      await f.db.update(storeProductAttrValue).set({ price, vipPrice: price, settlePrice: '0.00', cost: '0.00', brokerage: '0.00' })
        .where(eq(storeProductAttrValue.id, 1));
      for (const key of ['first_order_status', 'newcomer_status', 'member_func_status', 'member_card_status',
        'svip_price_status', 'order_give_integral', 'order_give_exp', 'brokerage_func_status', 'store_brokerage_statu']) {
        await f.db.delete(systemConfig).where(eq(systemConfig.menuName, key));
        await f.db.insert(systemConfig).values({ menuName: key, value: '0' });
      }
      const cart = await new StoreCartService(container, f.environment).add({ uid: 11, productId: 70,
        unique: 'qared001', cartNum: quantity, isNew: 1 });
      const created = await StoreOrderCreateService.createWithRuntime(container,
        { CONFIG_KV: f.environment.CONFIG_KV, requirePurchaseOrigin: true,
          nextOrderId: async () => 'cfm_' + randomUUID().replaceAll('-', '').slice(0, 25) },
        { uid: 11, key: randomUUID(), cartIds: [cart.id], addressId: 11, userIp: '127.0.0.1', useIntegral: false });
      const rows = await runtime.select().from(storeOrder).where(eq(storeOrder.orderId, created.orderId));
      if (rows.length !== 1 || rows[0].paid !== 0 || rows[0].pid !== 0) throw Error('Real Financial manual checkout root missing');
      return rows[0];
    };
    const paidOffline = async (price = '7.00', quantity = 1) => {
      const unpaid = await newUnpaid(price, quantity), paymentInput = await input(unpaid.id), key = randomUUID();
      const response = await f.request('/mobile/work/financial/confirm-offline', paymentInput, key);
      const result = response.body.data as { receipt?: FinancialReceipt };
      if (response.response.status !== 200 || response.body.status !== 200 || result.receipt?.outcome !== 'offline-paid')
        throw Error('Actual Financial offline route did not commit: ' + response.body.msg);
      const outboxId = Number(result.receipt.evidence.outbox_id);
      const events = await runtime.select().from(storeOrderOutbox).where(eq(storeOrderOutbox.id, outboxId));
      if (events.length !== 1 || events[0].eventType !== 'order.paid' || events[0].aggregateId !== unpaid.id)
        throw Error('Actual Financial paid event identity missing');
      const consumer = new OrderOutboxService(container, f.environment);
      const message = { action: 'processOrderPaidOutbox' as const, outboxId, eventKey: events[0].eventKey };
      const consumed = await consumer.processMessage(message);
      if (consumed !== 'completed') throw Error('Actual fixed Financial paid consumer refused: ' + consumed);
      const [event] = await runtime.select().from(storeOrderOutbox).where(eq(storeOrderOutbox.id, outboxId));
      const [order] = await runtime.select().from(storeOrder).where(eq(storeOrder.id, unpaid.id));
      if (event.status !== 'COMPLETED' || order.paid !== 1 || order.payType !== 'offline' || order.pid !== 0)
        throw Error('Real manual source did not remain a completed ordinary paid root');
      return { order, paymentInput, paymentKey: key, paymentReceipt: result.receipt, event, consumer, message };
    };
    const creation = async (id: number, items: Array<{ cart_row_id: number; cart_num: number }> = []) => {
      const base = await input(id), mode = items.length ? 'items' as const : 'remaining' as const;
      const quoted = await f.request('/mobile/work/financial/refund-quote', {
        version: CUSTOMER_FINANCIAL_QUOTE_VERSION, scope_key: base.scope_key, order_id: id,
        expected_order_revision: base.expected_order_revision, expected_financial_revision: base.expected_financial_revision, mode, items,
      });
      if (quoted.response.status !== 200 || quoted.body.status !== 200) throw Error('Actual Financial manual quote refused: ' + quoted.body.msg);
      const envelope = quoted.body.data as Awaited<ReturnType<CustomerWorkFinancialReadService['quote']>>;
      return input(id, { mode, items, quoted_price: envelope.data.quoted_price, refund_price: envelope.data.quoted_price,
        quote_fingerprint: envelope.data.quote_fingerprint, reason: '原生独立客服已核对实际线下退款' });
    };
    const create = async (id: number, items: Array<{ cart_row_id: number; cart_num: number }> = []) => {
      const body = await creation(id, items), key = randomUUID(), response = await f.request('/mobile/work/financial/refund-create', body, key);
      const result = response.body.data as { receipt?: FinancialReceipt };
      if (response.response.status !== 200 || response.body.status !== 200 || result.receipt?.outcome !== 'refund-created')
        throw Error('Actual Financial manual creation refused: ' + response.body.msg);
      return { id: Number(result.receipt.evidence.refund_id), key, body, receipt: result.receipt, response };
    };
    const decision = async (refundId: number) => {
      const rows = await runtime.select().from(storeOrderRefund).where(eq(storeOrderRefund.id, refundId));
      if (rows.length !== 1) throw Error('Actual created refund missing');
      const read = await f.request('/mobile/work/financial/refunds/' + refundId + '?refund_no=' + rows[0].orderId);
      if (read.response.status !== 200 || read.body.status !== 200) throw Error('Actual Financial refund review refused: ' + read.body.msg);
      const review = (read.body.data as Awaited<ReturnType<CustomerWorkFinancialReadService['review']>>).data;
      return input(review.order_id, { refund_id: refundId, refund_no: review.refund_no,
        expected_refund_revision: review.refund_revision, review_fingerprint: review.review_fingerprint,
        decision: { apply_type: review.apply_type, refund_type: review.refund_type, received: false,
          ...(review.refund_settlement === 'cash' ? { cash_returned: true } : {}) }, refund_price: review.refund_price });
    };
    const execute = async (refundId: number) => {
      const body = await decision(refundId), key = randomUUID(), response = await f.request('/mobile/work/financial/refund-execute', body, key);
      return { body, key, response, result: response.body.data as { receipt: FinancialReceipt; execution: { status: string; completed: boolean; verified: boolean } } };
    };
    const financialAcl = () => f.db.execute(sql`SELECT c.relname,c.relowner::text,c.relacl::text,
      ARRAY(SELECT a.attacl::text FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 ORDER BY a.attnum) AS columns
      FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relname IN('customer_financial_manual_refund_v1',
        'store_order_promotions','store_order_promotions_id_seq','manager_order_operation_request') ORDER BY c.relname`);
    const manualRows = () => f.db.execute(sql`SELECT * FROM public.customer_financial_manual_refund_v1 ORDER BY refund_id`);
    const ledger = () => f.db.execute(sql`SELECT * FROM public.customer_financial_operation_request ORDER BY actor_uid,request_key`);
    const credential = async () => (await f.db.execute(sql`SELECT oid::text AS oid,
      encode(sha256(convert_to(rolpassword,'UTF8')),'hex') AS credential_fingerprint FROM pg_authid
      WHERE rolname=${CUSTOMER_FINANCIAL_RUNTIME_ROLE}`))[0];
    return { ...f, runtime, container, reader, addon, manualOwner: manualOwner.role, input, newUnpaid, paidOffline,
      creation, create, decision, execute, financialAcl, manualRows, ledger, credential };
  } catch (error) { await f.close(); throw error; }
}
