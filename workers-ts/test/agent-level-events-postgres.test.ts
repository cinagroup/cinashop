/** Actual 282-table migrations + current production commissioning + separate
 * non-owner app/Admin LOGINs. Checkout/outbox/grade/financial SQL are real.
 * Payment marking is a synthetic local fixture, not provider HTTP, Queue or
 * deployed Hyperdrive acceptance. No financial/upgrade function is mocked. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import type { OrderMessage, OrderPaidOutboxMessage } from '../src/env';
import { createContainerFromDb, withTx } from '../src/lib/di';
import { runRuntimeBusinessCommissioning } from '../src/migrations/runRuntimeBusinessCommissioning';
import { auditRuntimeBusinessPrivileges } from '../src/migrations/auditRuntimeBusinessPrivileges';
import { agentLevel, agentLevelTask, agentLevelTaskRecord, storeCart, storeOrder, storeOrderCartInfo, storeOrderOutbox, storeOrderStatus,
  storeProduct, supplierFlowingWater, supplierTransactions, systemConfig, user, userAddress } from '../src/models/schema';
import { StoreOrderCreateService } from '../src/services/order/StoreOrderCreateService';
import { enqueueOrderPaidEvent, OrderOutboxService } from '../src/services/order/OrderOutboxService';
import type { SystemConfigEnv } from '../src/services/system/SystemConfigService';
import { refundRuntimeFixture } from './helpers/refundRuntimeFixture';
import { outcome } from './helpers/financePeers';

type Fixture = Awaited<ReturnType<typeof refundRuntimeFixture>>;
type WithRole = NonNullable<Fixture['withRuntimeRole']>;
type Peer = Parameters<Parameters<WithRole>[0]>[0];
const levelId = 1101, taskId = 1101;
const policy: Record<string, string> = { brokerage_func_status: '1', is_self_brokerage: '1', store_brokerage_statu: '1',
  store_brokerage_price: '0', brokerage_level: '1', store_brokerage_ratio: '10', store_brokerage_two: '0', brokerage_compute_type: '1',
  store_brokerage_binding_status: '1', store_brokerage_binding_time: '30', division_status: '0' };
function gate() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
function errorCode(error: unknown): unknown {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current && typeof current === 'object'; depth++) {
    const row = current as { code?: unknown; cause?: unknown }; if (row.code) return row.code; current = row.cause;
  }
  return undefined;
}
function cents(value: string): bigint {
  expect(value).toMatch(/^\d+\.\d{2}$/); return BigInt(value.replace('.', ''));
}

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('paid events upgrade distributor levels before actual idempotent financial effects', () => {
  let f: Fixture;
  let fetchGuard: ReturnType<typeof vi.spyOn>;
  beforeEach(async () => {
    fetchGuard = vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('No provider/payment/media HTTP in owned native event acceptance'));
    f = await refundRuntimeFixture();
    await f.db.update(agentLevel).set({ status: 0, isDel: 1 });
    await f.db.update(agentLevelTask).set({ status: 0, isDel: 1 });
    await f.db.insert(agentLevel).values({ id: levelId, name: '首笔支付升级', grade: 1, image: '/uploads/system/agent_level_1.png',
      color: '#D97E1D', oneBrokerage: 100, twoBrokerage: 50, status: 1, isDel: 0 });
    await f.db.insert(agentLevelTask).values({ id: taskId, levelId, name: '自身支付一单', type: 3, number: 1, status: 1, isDel: 0 });
    await f.db.update(user).set({ agentLevel: 0, isPromoter: 1, spreadOpen: 1 }).where(eq(user.uid, 11));
    // Both selected products use ratio commission rather than the fixture's
    // one fixed SKU commission, so a subsequent real checkout exposes uplift.
    await f.db.update(storeProduct).set({ isSub: 0 }).where(eq(storeProduct.id, 70));
    for (const [menuName, value] of Object.entries(policy)) await setPolicy(menuName, value);
    const original = f.env.CONFIG_KV, brokerageKeys = new Set(Object.keys(policy));
    // A cache miss uses the actual SystemConfigDao SQL authority. This supplies
    // no fake config, grade, order or financial result and retains normal KV
    // behavior for every non-brokerage key in the shared checkout fixture.
    const binding = { get: async (key: string) => brokerageKeys.has(key.replace(/^cfg_/, '')) ? null : original.get(key),
      put: (key: string, value: string, options?: KVNamespacePutOptions) => original.put(key, value, options),
      delete: (key: string) => original.delete(key) } satisfies SystemConfigEnv['CONFIG_KV'];
    Object.assign(f.env, { CONFIG_KV: binding });
  }, 120000);
  afterEach(async () => { try { expect(fetchGuard).not.toHaveBeenCalled(); } finally { fetchGuard?.mockRestore(); await f?.close(); } }, 30000);

  async function setPolicy(menuName: string, value: string) {
    const rows = await f.db.update(systemConfig).set({ value, sort: 10000 }).where(and(eq(systemConfig.menuName, menuName), eq(systemConfig.isStore, 0))).returning({ id: systemConfig.id });
    if (!rows.length) await f.db.insert(systemConfig).values({ menuName, value, sort: 10000, isStore: 0 });
  }
  async function commissioned(run: (app: Peer, admin: Peer) => Promise<void>) {
    const roles = f.withRuntimeRole; if (!roles) throw Error('Events require independent real runtime LOGINs');
    await roles(app => roles(async admin => {
      const [database] = await f.db.execute(sql`SELECT current_database() AS name`);
      const names = { database: String(database.name), maintenance: 'finance_test', app: app.role, admin: admin.role, pricingOwner: f.pricingOwner };
      await runRuntimeBusinessCommissioning(f.db, names);
      for (const [peer, kind] of [[app, 'app'], [admin, 'admin']] as const) {
        expect(await auditRuntimeBusinessPrivileges(peer.db, kind, names)).toMatchObject({ ready: true, failures: [] });
        expect((await peer.exec('SELECT current_user AS role,session_user AS session'))[0]).toEqual({ role: peer.role, session: peer.role });
        expect((await peer.exec("SELECT has_schema_privilege(current_user,'public','CREATE') AS ddl,rolsuper,rolcreatedb,rolcreaterole,rolbypassrls FROM pg_roles WHERE rolname=current_user"))[0]).toEqual({ ddl: false, rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolbypassrls: false });
      }
      expect(app.pid).not.toBe(admin.pid); await run(app, admin);
    }));
  }
  function consumer(app: Peer) {
    const send = vi.fn(async () => { throw Error('processMessage must not dispatch a Queue message'); });
    const queue = { send, sendBatch: send } satisfies Pick<Queue<OrderMessage>, 'send' | 'sendBatch'>;
    // Only the two Queue delivery methods are reachable in this service. This
    // test calls processMessage, not dispatch; the remaining binding is unused.
    const service = new OrderOutboxService(createContainerFromDb(app.db), { ORDER_QUEUE: queue as unknown as Queue<OrderMessage> });
    return { service, send };
  }
  async function paid(app: Peer, name: string) {
    const created = await f.operationsFor(app).checkout({ key: `agent-event-${name}`, orderId: `agent_event_${name}` });
    const [root] = await f.db.select().from(storeOrder).where(eq(storeOrder.orderId, created.orderId));
    expect(root).toMatchObject({ uid: 11, paid: 0, pid: 0, supplierId: 7, oneBrokerage: '5.00', spreadUid: 11 });
    // Maintenance supplies ONLY the test payment marker. The marker and real
    // enqueue helper commit together, matching the payment/outbox boundary.
    const event = await withTx(createContainerFromDb(f.db), async tx => {
      const [marked] = await tx.update(storeOrder).set({ paid: 1, payType: 'yue', payTime: 100, tradeNo: 'OWNED-SYNTHETIC-PAID' })
        .where(and(eq(storeOrder.id, root.id), eq(storeOrder.paid, 0))).returning();
      if (!marked) throw Error('Owned synthetic payment must mark exactly one root');
      return enqueueOrderPaidEvent(tx, marked, Math.floor(Date.now() / 1000) - 1);
    });
    const message: OrderPaidOutboxMessage = { action: 'processOrderPaidOutbox', outboxId: event.id, eventKey: event.eventKey };
    return { root, event, message };
  }
  async function eventRow(id: number) { return (await f.db.select().from(storeOrderOutbox).where(eq(storeOrderOutbox.id, id)))[0]; }
  async function snapshot() {
    const finance = await f.state(); delete finance.store_order_outbox;
    return { finance, records: await f.db.select().from(agentLevelTaskRecord).orderBy(agentLevelTaskRecord.id) };
  }
  async function assertCompleted(id: number, eventId: number, initialPayCount: number) {
    expect(await eventRow(eventId)).toMatchObject({ status: 'COMPLETED', leaseUntil: 0, leaseToken: '', lastError: '' });
    expect((await f.db.select().from(user).where(eq(user.uid, 11)))[0]).toMatchObject({ agentLevel: levelId, payCount: initialPayCount + 1 });
    expect(await f.db.select().from(agentLevelTaskRecord)).toMatchObject([{ uid: 11, levelId, taskId, status: 0 }]);
    expect(await f.db.select().from(agentLevelTaskRecord)).toHaveLength(1);
    const [order] = await f.db.select().from(storeOrder).where(eq(storeOrder.id, id));
    expect(order).toMatchObject({ paid: 1, pid: 0, supplierId: 7, supplierAllocationStatus: 2, status: 0, shippingType: 1,
      totalPrice: '50.00', totalPostage: '6.00', payPostage: '6.00', deductionPrice: '1.00', payPrice: '55.00' });
    const lines = await f.db.select({ productId: storeOrderCartInfo.productId, type: storeOrderCartInfo.type,
      relationId: storeOrderCartInfo.relationId, cartNum: storeOrderCartInfo.cartNum, settlePrice: storeOrderCartInfo.settlePrice })
      .from(storeOrderCartInfo).where(eq(storeOrderCartInfo.oid, id)).orderBy(storeOrderCartInfo.productId);
    expect(lines).toEqual([{ productId: 70, type: 2, relationId: 7, cartNum: 2, settlePrice: '2.50' },
      { productId: 71, type: 2, relationId: 7, cartNum: 1, settlePrice: '20.00' }]);
    const supplierGoods = lines.reduce((sum, line) => sum + cents(line.settlePrice) * BigInt(line.cartNum), 0n);
    expect(supplierGoods).toBe(2500n);
    // The actual fixed freight is 3.00 per item × two units = 6.00. Supplier
    // entitlement is the stored supply prices 25.00 + paid freight 6.00;
    // transactions instead retain the customer's paid/order/postage amounts.
    const common = { supplierId: 7, uid: 11, orderId: `P${order.orderId}`, linkId: order.orderId, pm: 1, type: 1,
      payType: 'yue', payPrice: order.payPrice, totalPrice: order.totalPrice, payPostage: order.payPostage, tradeTime: 100 };
    const flow = await f.db.select().from(supplierFlowingWater).where(eq(supplierFlowingWater.linkId, order.orderId));
    expect(flow).toMatchObject([{ ...common, number: '31.00', status: 0 }]);
    expect(cents(flow[0].number)).toBe(supplierGoods + cents(order.payPostage));
    expect(cents(order.payPrice)).toBe(cents(order.totalPrice) - cents(order.deductionPrice) + cents(order.payPostage));
    expect(await f.db.select().from(supplierFlowingWater)).toHaveLength(1);
    const transactions = await f.db.select().from(supplierTransactions).where(eq(supplierTransactions.linkId, order.orderId));
    expect(transactions).toMatchObject([common]); expect(transactions).toHaveLength(1); expect(await f.db.select().from(supplierTransactions)).toHaveLength(1);
    expect((await f.db.select().from(storeOrderStatus).where(eq(storeOrderStatus.oid, id))).filter(row => row.changeType === 'pay_success')).toHaveLength(1);
  }
  async function assertFailed(eventId: number, expected: Awaited<ReturnType<typeof snapshot>>) {
    const event = await eventRow(eventId);
    expect(event).toMatchObject({ status: 'FAILED', leaseUntil: 0, leaseToken: '', processedTime: 0, attemptCount: 1 });
    expect(event.availableTime).toBeGreaterThan(event.updateTime); expect(event.lastError).not.toBe('');
    expect(await snapshot()).toEqual(expected);
  }

  it('upgrades the actual paid buyer, commits supplier ledgers/pay-count/status once, then consumes the upgraded parent rank in the next actual checkout', async () => commissioned(async app => {
    const task = await paid(app, 'first'), count = (await f.db.select().from(user).where(eq(user.uid, 11)))[0].payCount;
    const { service, send } = consumer(app);
    expect(await service.processMessage(task.message)).toBe('completed'); await assertCompleted(task.root.id, task.event.id, count);
    const after = await snapshot(), savedEvent = await eventRow(task.event.id);
    expect(await service.processMessage(task.message)).toBe('already-completed'); expect(await snapshot()).toEqual(after); expect(await eventRow(task.event.id)).toEqual(savedEvent);
    // New buyer's persisted parent is the upgraded buyer. The ordinary
    // checkout snapshot independently rereads that actual parent and level.
    await setPolicy('is_self_brokerage', '0');
    await f.db.insert(user).values({ uid: 33, account: 'owned-next-buyer', status: 1, spreadUid: 11, spreadTime: Math.floor(Date.now() / 1000) });
    const [sourceAddress] = await f.db.select().from(userAddress).where(eq(userAddress.id, 11));
    await f.db.insert(userAddress).values({ ...sourceAddress, id: 33, uid: 33 });
    const carts = await f.db.select().from(storeCart).orderBy(storeCart.id);
    await f.db.insert(storeCart).values(carts.map((cart, index) => ({ ...cart, id: 101 + index, uid: 33, isPay: 0, isNew: 1, status: 1 })));
    const next = await StoreOrderCreateService.createWithRuntime(createContainerFromDb(app.db), { CONFIG_KV: f.env.CONFIG_KV, nextOrderId: async () => 'agent_event_next_buyer' },
      { uid: 33, key: 'agent-event-next-buyer', cartIds: [101, 102], addressId: 33, userIp: '127.0.0.1', useIntegral: false });
    expect((await f.db.select().from(storeOrder).where(eq(storeOrder.orderId, next.orderId)))[0]).toMatchObject({ uid: 33, paid: 0, pid: 0, spreadUid: 11, oneBrokerage: '10.00', twoBrokerage: '0.00' });
    expect(await f.db.select().from(agentLevelTaskRecord)).toHaveLength(1); expect(send).not.toHaveBeenCalled();
  }), 120000);

  it('leaves the original paid event FAILED without partial rank/records/finance on duplicate active grade, then retries exactly once after repair', async () => commissioned(async app => {
    const task = await paid(app, 'duplicate'), count = (await f.db.select().from(user).where(eq(user.uid, 11)))[0].payCount;
    await f.db.insert(agentLevel).values({ id: 1102, name: '旧重复等级', grade: 1, image: '/uploads/system/agent_level_1.png', color: '#D97E1D', status: 1, isDel: 0 });
    const before = await snapshot(), { service, send } = consumer(app);
    await expect(service.processMessage(task.message)).rejects.toThrow(/重复分销级别/); await assertFailed(task.event.id, before);
    expect((await f.db.select().from(user).where(eq(user.uid, 11)))[0].agentLevel).toBe(0);
    await f.db.update(agentLevel).set({ isDel: 1, status: 0 }).where(eq(agentLevel.id, 1102));
    expect(await service.processMessage(task.message)).toBe('completed'); await assertCompleted(task.root.id, task.event.id, count);
    expect((await eventRow(task.event.id)).attemptCount).toBe(2);
    const after = await snapshot(), completed = await eventRow(task.event.id);
    expect(await service.processMessage(task.message)).toBe('already-completed'); expect(await snapshot()).toEqual(after); expect(await eventRow(task.event.id)).toEqual(completed); expect(send).not.toHaveBeenCalled();
  }), 120000);

  it('records a durable FAILED payment event when another real runtime session holds the buyer row and retries after the lock is released', async () => commissioned(async (app, admin) => {
    const task = await paid(app, 'row_lock'), count = (await f.db.select().from(user).where(eq(user.uid, 11)))[0].payCount;
    const before = await snapshot(), locked = gate(), release = gate(), { service, send } = consumer(app);
    let heldLock: unknown;
    const hold = withTx(createContainerFromDb(admin.db), async tx => {
      expect(await tx.select({ uid: user.uid }).from(user).where(eq(user.uid, 11)).for('update')).toEqual([{ uid: 11 }]);
      [heldLock] = await tx.execute(sql`SELECT pg_backend_pid() AS pid,current_user AS role,
        EXISTS(SELECT 1 FROM pg_locks WHERE pid=pg_backend_pid() AND relation='public.user'::regclass AND mode='RowShareLock' AND granted) AS table_lock,
        EXISTS(SELECT 1 FROM pg_locks WHERE pid=pg_backend_pid() AND locktype='transactionid' AND transactionid::text=txid_current()::text AND mode='ExclusiveLock' AND granted) AS transaction_lock`);
      locked.resolve(); await release.promise;
    });
    await locked.promise;
    const pending = outcome(service.processMessage(task.message));
    try {
      // Real FOR UPDATE returned this exact buyer, and native PG identifies the
      // independent writer/table/transaction locks. The consumer uses NOWAIT,
      // so there is deliberately no fabricated blocked-wait PID assertion.
      expect(heldLock).toEqual({ pid: admin.pid, role: admin.role, table_lock: true, transaction_lock: true });
      const failure = await pending; expect(failure.ok).toBe(false); if (!failure.ok) expect(errorCode(failure.error)).toBe('55P03');
      await assertFailed(task.event.id, before);
    } finally { release.resolve(); await hold; }
    expect(await service.processMessage(task.message)).toBe('completed'); await assertCompleted(task.root.id, task.event.id, count);
    expect((await eventRow(task.event.id)).attemptCount).toBe(2);
    const after = await snapshot(); expect(await service.processMessage(task.message)).toBe('already-completed'); expect(await snapshot()).toEqual(after); expect(send).not.toHaveBeenCalled();
  }), 120000);

  it('refuses paid-root identity drift before upgrade/finance, preserving the original event identity through FAILED and repaired retry', async () => commissioned(async app => {
    const task = await paid(app, 'identity'), count = (await f.db.select().from(user).where(eq(user.uid, 11)))[0].payCount, { service, send } = consumer(app);
    const immutable = { eventKey: task.event.eventKey, aggregateId: task.root.id, payload: { orderId: task.root.id, orderNo: task.root.orderId } };
    // Each independent root defect uses the same original immutable event. The
    // actual replay API resets the failed lease after maintenance repairs it.
    for (const override of [{ paid: 0 }, { pid: -1 }, { orderId: 'owned-mismatched-root-number' }]) {
      await f.db.update(storeOrder).set({ paid: 1, pid: 0, orderId: task.root.orderId, ...override }).where(eq(storeOrder.id, task.root.id));
      const before = await snapshot(); await expect(service.processMessage(task.message)).rejects.toThrow(/actual paid root order/);
      await assertFailed(task.event.id, before); expect(await eventRow(task.event.id)).toMatchObject(immutable);
      await f.db.update(storeOrder).set({ paid: 1, pid: 0, orderId: task.root.orderId }).where(eq(storeOrder.id, task.root.id));
      await service.replay(task.event.id);
    }
    expect(await service.processMessage(task.message)).toBe('completed'); await assertCompleted(task.root.id, task.event.id, count);
    expect((await eventRow(task.event.id)).replayCount).toBe(3); expect(await eventRow(task.event.id)).toMatchObject(immutable);
    const after = await snapshot(); expect(await service.processMessage(task.message)).toBe('already-completed'); expect(await snapshot()).toEqual(after); expect(send).not.toHaveBeenCalled();
  }), 120000);
});
