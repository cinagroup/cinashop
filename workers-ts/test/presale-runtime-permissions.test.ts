/** Owned native PG16 only. Full registered schema and a separately authenticated
 * non-owner LOGIN. No production installer, SET ROLE, provider or Queue I/O.
 * The paid marker is synthetic, but all following service transactions are real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import type { OrderMessage } from '@/env';
import { withTx } from '@/lib/di';
import { refundRuntimeFixture, runtimeTablePrivileges, runtimeRowLockTables, runtimeSequenceTables } from './helpers/refundRuntimeFixture';
import { cancelStoreOrder, StoreOrderCreateService } from '@/services/order/StoreOrderCreateService';
import { enqueueOrderPaidEvent, OrderOutboxService } from '@/services/order/OrderOutboxService';
import { allocatePaidOrderBySupplier } from '@/services/order/OrderSupplierAllocationService';
import { recordSupplierPayment } from '@/services/supplier/SupplierFinanceService';
import { readRefundQuantityReservation, MATERIALIZED_REFUND_VERSION } from '@/services/order/RefundQuantityReservation';
import { storeCart, storeOrder, storeOrderOutbox, storeOrderStatus, storeOrderRefund,
  storeProduct, storeProductVirtual, supplierFlowingWater, supplierTransactions, user } from '@/models/schema';

// Reviewed scenario additions, declared BEFORE execution. Never grant whatever
// a failed query asks for. Existing refund-profile permissions stay unchanged.
const tables: Record<string, readonly string[]> = {
  store_product_virtual: ['SELECT'], store_product_coupon: ['SELECT'], luck_lottery: ['SELECT'],
};
const columns: Record<string, readonly string[]> = {
  store_order_outbox: ['status', 'available_time', 'dispatch_count', 'lease_token', 'lease_until', 'update_time',
    'enqueued_time', 'last_error', 'attempt_count', 'replay_count', 'processed_time'],
  store_product_virtual: ['uid', 'order_id', 'order_type'],
};
type Fixture = Awaited<ReturnType<typeof refundRuntimeFixture>>;
type Runtime = Parameters<Parameters<Fixture['withRuntime']>[0]>[0];
const queue = {
  async metrics() { throw Error('Unexpected Queue I/O'); },
  async send() { throw Error('Unexpected Queue I/O'); },
  async sendBatch() { throw Error('Unexpected Queue I/O'); },
} satisfies Queue<OrderMessage>;

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('presale atomic refund / paid / due with independent LOGIN', () => {
  let f: Fixture, endsAt: number;
  beforeEach(async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('External I/O forbidden'));
    f = await refundRuntimeFixture();
    await f.db.update(storeProduct).set({ productType: 1, freight: 1, tempId: 0, isPresaleProduct: 1,
      presaleStartTime: 0, presaleEndTime: 2147483647, presaleDay: 7, isLimit: 0 }).where(eq(storeProduct.id, 70));
    await f.db.update(storeCart).set({ type: 6, productType: 1, cartNum: 3 }).where(eq(storeCart.id, 1));
    await f.db.insert(storeProductVirtual).values([1, 2, 3].map(n => ({ productId: 70, attrUnique: 'qared001',
      cardNo: `LOCAL-RUNTIME-${n}`, cardPwd: `LOCAL-NO-PROVIDER-${n}` })));
    const [clock] = await f.db.execute(sql`SELECT floor(extract(epoch FROM clock_timestamp()))::integer AS now`);
    endsAt = Number(clock.now) + 10;
    await f.db.update(storeProduct).set({ presaleEndTime: endsAt }).where(eq(storeProduct.id, 70));
  }, 45000);
  afterEach(async () => {
    try { expect(fetch).not.toHaveBeenCalled(); } finally { vi.restoreAllMocks(); await f?.close(); }
  }, 45000);
  const withRuntime = <T>(fn: (r: Runtime) => Promise<T>) => f.withRuntime(async r => {
    for (const [table, grants] of Object.entries(tables)) await f.exec(`GRANT ${grants.join(',')} ON public."${table}" TO "${r.role}"`);
    for (const [table, fields] of Object.entries(columns)) await f.exec(`GRANT UPDATE(${fields.join(',')}) ON public."${table}" TO "${r.role}"`);
    return fn(r);
  });
  const service = (r: Runtime) => new OrderOutboxService(r.container, { ORDER_QUEUE: queue });
  const state = async (): Promise<Record<string, unknown>> => ({ ...await f.state(),
    virtual: await f.db.select().from(storeProductVirtual).orderBy(storeProductVirtual.id) });
  const business = async () => { const { store_order_outbox: _events, ...rows } = await state(); return rows; };
  async function createPaid(r: Runtime, preexistingIncome: boolean, useIntegral = false) {
    const created = await StoreOrderCreateService.createWithRuntime(r.container,
      { CONFIG_KV: f.env.CONFIG_KV, nextOrderId: async () => 'presale_runtime_checkout' },
      { uid: 11, key: 'presale-runtime', type: 6, cartIds: [1], addressId: 11, useIntegral, userIp: '127.0.0.1' });
    return withTx(r.container, async tx => {
      const [order] = await tx.update(storeOrder).set({ paid: 1, payType: 'yue', payTime: endsAt - 10, tradeNo: 'LOCAL-SYNTHETIC' })
        .where(and(eq(storeOrder.orderId, created.orderId), eq(storeOrder.paid, 0))).returning();
      if (!order) throw Error('Missing owned synthetic payment');
      const event = await enqueueOrderPaidEvent(tx, order);
      // Explicit old/interrupted accounting scenario, NOT a completed paid outbox.
      // The normal path leaves both allocation/accounting to the real consumer.
      if (preexistingIncome) {
        const allocation = await allocatePaidOrderBySupplier(tx, order.id, order.orderId);
        for (const child of allocation.fulfillmentOrders) await recordSupplierPayment(tx, child, order.payTime);
      }
      return { id: order.id, message: { action: 'processOrderPaidOutbox' as const, outboxId: event.id, eventKey: event.eventKey } };
    });
  }
  async function refund(r: Runtime, id: number, quantity: number) {
    const application = await r.apply(id, 70, quantity);
    const [row] = await r.db.select().from(storeOrderRefund).where(eq(storeOrderRefund.id, application.refundId));
    expect(readRefundQuantityReservation(row)?.version).toBe(MATERIALIZED_REFUND_VERSION);
    expect(await r.finish(application.refundId)).toBe('completed');
    const receipt = await r.receipt(application.refundId);
    expect(receipt).toMatchObject({ refundId: application.refundId, sourceOrderId: id });
    const done = await state(); expect(await r.finish(application.refundId)).toBe('already-completed');
    expect(await state()).toEqual(done);
    return receipt;
  }
  async function waitUntilDue(r: Runtime) {
    const deadline = performance.now() + 20000;
    while (performance.now() < deadline) {
      const [clock] = await r.db.execute(sql`SELECT clock_timestamp() >= to_timestamp(${endsAt}) AS ready`);
      if (clock.ready === true) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw Error('Owned PostgreSQL clock did not reach presale end');
  }
  const dueMessages = async (r: Runtime) => (await r.db.select().from(storeOrderOutbox))
    .filter(event => event.eventType === 'order.presale.fulfillment')
    .map(event => ({ action: 'processPresaleDeliveryOutbox' as const, outboxId: event.id, eventKey: event.eventKey }));

  it('deducts presale points and returns exactly those points across two atomic refunds using the same LOGIN', async () => {
    await withRuntime(async r => {
      const [before] = await r.db.select().from(user).where(eq(user.uid, 11));
      const root = await createPaid(r, false, true);
      expect(await r.order(root.id)).toMatchObject({ useIntegral: '100.00', deductionPrice: '1.00', payPrice: '29.00' });
      expect((await r.db.select().from(user).where(eq(user.uid, 11)))[0].integral).toBe(before.integral - 100);
      expect(await service(r).processMessage(root.message)).toBe('completed');
      const first = await refund(r, root.id, 1);
      await refund(r, first.remainingOrderId!, 2);
      expect((await r.db.select().from(user).where(eq(user.uid, 11)))[0].integral).toBe(before.integral);
      const [message] = await dueMessages(r); await waitUntilDue(r);
      expect(await service(r).processMessage(message)).toBe('completed');
      expect((await r.db.select().from(storeProductVirtual)).every(card => card.uid === 0)).toBe(true);
      const done = await state(); expect(await service(r).processMessage(root.message)).toBe('already-completed');
      expect(await service(r).processMessage(message)).toBe('already-completed'); expect(await state()).toEqual(done);
    });
  }, 45000);

  it.each(['create', 'cancel'] as const)('does not keep points or inventory writes if %s cannot insert its points bill', async operation => {
    await withRuntime(async r => {
      const checkout = () => StoreOrderCreateService.createWithRuntime(r.container,
        { CONFIG_KV: f.env.CONFIG_KV, nextOrderId: async () => 'presale_runtime_points_cancel' },
        { uid: 11, key: 'presale-points-cancel', type: 6, cartIds: [1], addressId: 11, useIntegral: true, userIp: '127.0.0.1' });
      const created = operation === 'cancel' ? await checkout() : null;
      const before = await state(); await f.exec(`REVOKE INSERT ON public.user_bill FROM "${r.role}"`);
      await expect(created ? cancelStoreOrder(r.container, { uid: 11, orderId: created.orderId }) : checkout())
        .rejects.toMatchObject({ cause: { code: '42501' } });
      expect(await state()).toEqual(before);
      await f.exec(`GRANT INSERT ON public.user_bill TO "${r.role}"`);
      const order = created ?? await checkout();
      await cancelStoreOrder(r.container, { uid: 11, orderId: order.orderId });
      expect((await r.db.select().from(user).where(eq(user.uid, 11)))[0].integral).toBe(100);
      const done = await state(); await expect(cancelStoreOrder(r.container, { uid: 11, orderId: order.orderId })).rejects.toThrow('状态不允许取消');
      expect(await state()).toEqual(done);
    });
  }, 45000);

  it('has exactly the declared grants and cannot change event identity, secrets or maintenance state', async () => {
    await withRuntime(async r => {
      const grants = await r.db.execute(sql`SELECT c.relname AS name,p.priv FROM pg_class c
        CROSS JOIN (VALUES ('SELECT'),('INSERT'),('UPDATE'),('DELETE'),('TRUNCATE'),('REFERENCES'),('TRIGGER')) p(priv)
        WHERE c.relnamespace='public'::regnamespace AND c.relkind='r' AND has_table_privilege(current_user,c.oid,p.priv)`);
      expect(grants.map(row => `${row.name}:${row.priv}`).sort()).toEqual(Object.entries({ ...runtimeTablePrivileges, ...tables })
        .flatMap(([table, values]) => values.map(value => `${table}:${value}`)).sort());
      const updates = await r.db.execute(sql`SELECT c.relname AS name,a.attname AS col FROM pg_class c JOIN pg_attribute a ON a.attrelid=c.oid
        WHERE c.relnamespace='public'::regnamespace AND c.relkind='r' AND a.attnum>0 AND NOT a.attisdropped
        AND NOT has_table_privilege(current_user,c.oid,'UPDATE') AND has_column_privilege(current_user,c.oid,a.attnum,'UPDATE')`);
      expect(updates.map(row => `${row.name}:${row.col}`).sort()).toEqual([
        ...runtimeRowLockTables.map(table => `${table}:id`), ...Object.entries(columns).flatMap(([table, fields]) => fields.map(field => `${table}:${field}`)),
      ].sort());
      const sequences = await r.db.execute(sql`SELECT c.relname AS name,p.priv FROM pg_class c
        CROSS JOIN (VALUES ('SELECT'),('UPDATE'),('USAGE')) p(priv) WHERE c.relnamespace='public'::regnamespace
        AND c.relkind='S' AND has_sequence_privilege(current_user,c.oid,p.priv)`);
      expect(sequences.map(row => `${row.name}:${row.priv}`).sort()).toEqual(runtimeSequenceTables.map(table => `${table}_id_seq:USAGE`).sort());
      const [identity] = await r.db.execute(sql`SELECT current_user=session_user AS direct_login,rolsuper,rolcreatedb,rolcreaterole,
        rolinherit,rolreplication,rolbypassrls,has_schema_privilege(current_user,'public','CREATE') AS schema_create,
        EXISTS(SELECT 1 FROM pg_class WHERE relowner=r.oid AND relnamespace='public'::regnamespace) AS owns_objects,
        EXISTS(SELECT 1 FROM pg_auth_members WHERE member=r.oid) AS membership FROM pg_roles r WHERE rolname=current_user`);
      expect(identity).toEqual({ direct_login: true, rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolinherit: false,
        rolreplication: false, rolbypassrls: false, schema_create: false, owns_objects: false, membership: false });
      const before = await state();
      for (const command of ["UPDATE store_order_outbox SET payload='{}'", "UPDATE store_order_outbox SET event_key='forbidden'",
        "DELETE FROM store_order_outbox", "UPDATE store_product_virtual SET card_pwd='forbidden'", 'DELETE FROM store_product_virtual',
        'UPDATE store_order_refund_split SET fingerprint=fingerprint', 'TRUNCATE store_order_refund_split',
        'ALTER TABLE store_order_refund_split DISABLE TRIGGER ALL', 'SET ROLE finance_test', 'SET session_replication_role=replica',
        "SELECT setval('store_order_outbox_id_seq',1,false)", 'CREATE TABLE public.forbidden_presale(id integer)']) {
        await expect(r.exec(command)).rejects.toMatchObject({ code: '42501' });
      }
      await r.exec('RESET ROLE');
      const [reset] = await r.db.execute(sql`SELECT current_user AS role,session_user AS session,pg_backend_pid() AS pid`);
      expect(reset).toEqual({ role: r.role, session: r.role, pid: r.pid }); expect(await state()).toEqual(before);
    });
  }, 45000);

  it.each(['partial', 'twice', 'whole', 'partial-whole'])('atomically materializes refunds before late paid recovery: %s', async scenario => {
    await withRuntime(async r => {
      const root = await createPaid(r, true), first = await refund(r, root.id, scenario === 'whole' ? 3 : 1);
      if (scenario === 'twice' || scenario === 'partial-whole') await refund(r, first.remainingOrderId!, scenario === 'twice' ? 1 : 2);
      const flows = await r.db.select().from(supplierFlowingWater).orderBy(supplierFlowingWater.id);
      const transactions = await r.db.select().from(supplierTransactions).orderBy(supplierTransactions.id);
      const before = await r.db.select().from(user).where(eq(user.uid, 11));
      expect(await service(r).processMessage(root.message)).toBe('completed');
      expect(await r.db.select().from(supplierFlowingWater).orderBy(supplierFlowingWater.id)).toEqual(flows);
      expect(await r.db.select().from(supplierTransactions).orderBy(supplierTransactions.id)).toEqual(transactions);
      expect((await r.db.select().from(user).where(eq(user.uid, 11)))[0].payCount).toBe(before[0].payCount + 1);
      expect((await r.db.select().from(storeOrderStatus)).filter(row => row.changeType === 'pay_success')).toHaveLength(1);
      const quantity = scenario === 'partial' ? 2 : scenario === 'twice' ? 1 : 0, messages = await dueMessages(r);
      expect(messages).toHaveLength(quantity ? 1 : 0);
      expect((await r.db.select().from(storeProductVirtual)).every(card => card.uid === 0)).toBe(true);
      if (quantity) {
        expect(await service(r).processMessage(messages[0])).toBe('deferred');
        await waitUntilDue(r); expect(await service(r).processMessage(messages[0])).toBe('completed');
        expect((await r.db.select().from(storeProductVirtual)).filter(card => card.uid === 11)).toHaveLength(quantity);
        expect(await service(r).processMessage(messages[0])).toBe('already-completed');
      }
      const done = await state(); expect(await service(r).processMessage(root.message)).toBe('already-completed');
      expect(await state()).toEqual(done);
    });
  }, 45000);

  it('uses normal paid accounting, two later atomic refunds and the original due intent', async () => {
    await withRuntime(async r => {
      const root = await createPaid(r, false); expect(await service(r).processMessage(root.message)).toBe('completed');
      const [message] = await dueMessages(r), first = await refund(r, root.id, 1);
      await refund(r, first.remainingOrderId!, 1);
      expect(await service(r).processMessage(message)).toBe('deferred');
      const before = await r.db.select().from(user).where(eq(user.uid, 11));
      await waitUntilDue(r); expect(await service(r).processMessage(message)).toBe('completed');
      const cards = (await r.db.select().from(storeProductVirtual)).filter(card => card.uid === 11);
      expect(cards).toHaveLength(1); expect(cards[0].orderId).toBe((await r.order(first.remainingOrderId!)).orderId);
      expect(await r.db.select().from(user).where(eq(user.uid, 11))).toEqual(before);
      const done = await state(); expect(await service(r).processMessage(message)).toBe('already-completed'); expect(await state()).toEqual(done);
    });
  }, 45000);

  it.each(['store_order_refund_split', 'store_order_status'])('rolls back money, inventory and orders when atomic refund loses INSERT on %s', async table => {
    await withRuntime(async r => {
      const root = await createPaid(r, false); await service(r).processMessage(root.message);
      const application = await r.apply(root.id, 70, 1), before = await state();
      await f.exec(`REVOKE INSERT ON public.${table} FROM "${r.role}"`);
      await expect(r.finish(application.refundId)).rejects.toMatchObject({ cause: { code: '42501' } });
      expect(await state()).toEqual(before);
      await f.exec(`GRANT INSERT ON public.${table} TO "${r.role}"`);
      expect(await r.finish(application.refundId)).toBe('completed'); expect(await r.receipt(application.refundId)).toBeDefined();
    });
  }, 45000);

  it('rolls back all late paid effects without its final completion-column privilege, then retries once', async () => {
    await withRuntime(async r => {
      const root = await createPaid(r, true); await refund(r, root.id, 1); const before = await business();
      await f.exec(`REVOKE UPDATE(processed_time) ON public.store_order_outbox FROM "${r.role}"`);
      await expect(service(r).processMessage(root.message)).rejects.toMatchObject({ cause: { code: '42501' } });
      expect(await business()).toEqual(before);
      expect(await r.db.select().from(storeOrderOutbox)).toEqual([expect.objectContaining({ id: root.message.outboxId, status: 'FAILED' })]);
      await f.exec(`GRANT UPDATE(processed_time) ON public.store_order_outbox TO "${r.role}"`);
      expect(await service(r).processMessage(root.message)).toBe('completed');
      const done = await state(); expect(await service(r).processMessage(root.message)).toBe('already-completed'); expect(await state()).toEqual(done);
    });
  }, 45000);

  it('rolls back due delivery without card-assignment privilege, then claims each remaining card once', async () => {
    await withRuntime(async r => {
      const root = await createPaid(r, false); await service(r).processMessage(root.message);
      await refund(r, root.id, 1); const [message] = await dueMessages(r); await waitUntilDue(r);
      await f.exec(`REVOKE UPDATE(uid) ON public.store_product_virtual FROM "${r.role}"`);
      const before = await business();
      await expect(service(r).processMessage(message)).rejects.toMatchObject({ cause: { code: '42501' } });
      expect(await business()).toEqual(before);
      await f.exec(`GRANT UPDATE(uid) ON public.store_product_virtual TO "${r.role}"`);
      await service(r).replay(message.outboxId);
      expect(await service(r).processMessage(message)).toBe('completed');
      expect((await r.db.select().from(storeProductVirtual)).filter(card => card.uid === 11)).toHaveLength(2);
      const done = await state(); expect(await service(r).processMessage(message)).toBe('already-completed'); expect(await state()).toEqual(done);
    });
  }, 45000);
});
