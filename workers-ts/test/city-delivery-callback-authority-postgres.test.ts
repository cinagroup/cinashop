import { sql } from 'drizzle-orm';
import { setTimeout as delay } from 'node:timers/promises';
import { createContainerFromDb, withTx } from '../src/lib/di';
import { auditRuntimeBusinessPrivileges } from '../src/migrations/auditRuntimeBusinessPrivileges';
import { runRuntimeBusinessCommissioning } from '../src/migrations/runRuntimeBusinessCommissioning';
import { cityDeliveryCallbackEvent, cityDeliveryCallbackOutbox, cityDeliveryCallbackWatermark, cityDeliveryReconciliationCase,
  storeOrderCartInfo, storeOrderStatus, supplierFlowingWater,
  supplierTransactions, user, userBill, userBrokerage } from '../src/models/schema';
import { lockOrderSettlement } from '../src/services/order/OrderBrokerageService';
import { recordSupplierPayment } from '../src/services/supplier/SupplierFinanceService';
import type { SystemConfigEnv } from '../src/services/system/SystemConfigService';
import type { CityDeliveryProvider } from '../src/services/delivery/DadaCityDeliveryCallback';
import { refundRuntimeFixture } from './helpers/refundRuntimeFixture';
import { callbackAuthorityWatermark, type CallbackAuthorityRuntimePeer,
  type CallbackAuthoritySubject } from './helpers/cityDeliveryCallbackAuthorityFixture';
import { observeCityDeliveryRecordDb } from './helpers/cityDeliveryRecordFixture';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { storeDeliveryOrder, storeOrder } from '../src/models/schema';
import { callbackAuthorityHarness, callbackAuthorityRows, cityDeliveryAuthorityEvent,
  cityDeliveryCallbackAuthorityFixture, type CallbackAuthoritySource } from './helpers/cityDeliveryCallbackAuthorityFixture';

const matrix = [['dada', 'callback'], ['dada', 'query'], ['uu', 'callback'], ['uu', 'query']] as const;
const clock = Math.floor(Date.now() / 1000);
const defects = [
  { name: 'foreign buyer UID', original: { uid: 77 }, delivery: { uid: 88 } },
  { name: 'zero buyer cannot establish ownership', original: { uid: 0 }, delivery: { uid: 0 } },
  { name: 'different typed owner with the same numeric ID', original: { storeId: 7, supplierId: 7 }, delivery: { type: 2, relationId: 7 } },
  { name: 'supplier cannot override the fulfillment store', original: { storeId: 7, supplierId: 42 }, delivery: { type: 2, relationId: 42 } },
  { name: 'platform pickup has no proof of legacy platform fulfillment', original: { storeId: 7, supplierId: 0, shippingType: 2 }, delivery: { type: 0, relationId: 0 } },
] as const;

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('native callback authority checks buyer, typed fulfillment owner and unique attempt', () => {
  let f: Awaited<ReturnType<typeof cityDeliveryCallbackAuthorityFixture>>;
  beforeEach(async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('No provider network I/O'));
    f = await cityDeliveryCallbackAuthorityFixture();
  }, 30_000);
  afterEach(async () => {
    try { expect(fetch).not.toHaveBeenCalled(); } finally { vi.restoreAllMocks(); await f?.close(); }
  }, 30_000);

  for (const defect of defects) it.each(matrix)(`%s/%s rejects ${defect.name} before rider, cancellation or watermark writes`, async (provider, source) =>
    f.profiles(async (app, admin) => {
      const subject = await f.seed(provider, 2001, defect.original, defect.delivery), before = await f.snapshot();
      const harness = callbackAuthorityHarness(provider === 'dada' ? app.db : admin.db);
      // Run both real SQL projections before assertions: the baseline records
      // the rider overwrite followed by a wrong business rollback, not only a
      // missing guard or an isolated watermark value.
      const pickup = await harness.process(cityDeliveryAuthorityEvent(subject, source, provider === 'dada' ? 2 : 3, clock - 100));
      const afterPickup = await f.snapshot();
      const cancellation = await harness.process(cityDeliveryAuthorityEvent(subject, source, provider === 'dada' ? 5 : -1, clock - 90));
      expect(await f.snapshot()).toEqual(before); expect(afterPickup).toEqual(before);
      for (const received of [pickup, cancellation]) {
        expect(received.result).toBe('conflict');
        const terminal = await callbackAuthorityRows(f.db, received);
        expect(terminal.event).toMatchObject({ status: 'CONFLICT', finishCode: '', riderName: '', riderMobile: '', reasonText: '', leaseToken: '', leaseUntil: 0 });
        expect(terminal.outbox).toMatchObject({ status: 'DEAD', leaseToken: '', leaseUntil: 0 });
      }
      const after = await f.snapshot();
      expect(await harness.service.processMessage(pickup.message)).toBe('conflict');
      expect(await harness.service.receive(cityDeliveryAuthorityEvent(subject, source, provider === 'dada' ? 5 : -1, clock - 90)))
        .toMatchObject({ duplicate: true, eventId: cancellation.eventId, outboxId: cancellation.outboxId });
      expect(await f.snapshot()).toEqual(after);
    }));

  it.each(matrix)('%s/%s rejects either subject when two attempts refer to the same original order, including historical terminal attempts', async (provider, source) =>
    f.profiles(async (app, admin) => {
      const historical = await f.seed(provider, 2101), currentId = 2102;
      const current = { ...historical, id: currentId, providerId: `${provider}-auth-${currentId}`, code: `${provider}-auth-${currentId}-code` };
      await f.db.update(storeDeliveryOrder).set({ status: -1 }).where(eq(storeDeliveryOrder.id, historical.id));
      await f.db.insert(storeDeliveryOrder).values({ id: current.id, oid: historical.oid, uid: 77,
        stationType: provider === 'dada' ? 1 : 2, type: 0, relationId: 0, orderId: current.providerId, deliveryNo: current.code, status: 0, addTime: 200 });
      const before = await f.snapshot(), harness = callbackAuthorityHarness(provider === 'dada' ? app.db : admin.db);
      const newer = await harness.process(cityDeliveryAuthorityEvent(current, source, provider === 'dada' ? 2 : 3, clock - 100));
      const afterNewer = await f.snapshot();
      const older = await harness.process(cityDeliveryAuthorityEvent(historical, source, provider === 'dada' ? 5 : -1, clock - 90));
      expect(await f.snapshot()).toEqual(before); expect(afterNewer).toEqual(before);
      for (const received of [newer, older]) {
        expect(received.result).toBe('conflict');
        expect((await callbackAuthorityRows(f.db, received)).event.status).toBe('CONFLICT');
        expect((await callbackAuthorityRows(f.db, received)).outbox.status).toBe('DEAD');
      }
      expect((await f.db.select().from(storeOrder).where(eq(storeOrder.id, historical.oid)))[0])
        .toMatchObject({ status: 1, deliveryType: 'city_delivery', deliveryName: '已登记骑手', deliveryId: '13700137000', deliveryUid: 91 });
    }));

  it.each(matrix)('%s/%s still applies a single platform/store/supplier attempt and gives store_id priority over supplier_id', async (provider, source) =>
    f.profiles(async (app, admin) => {
      const harness = callbackAuthorityHarness(provider === 'dada' ? app.db : admin.db);
      const owners = [
        { order: { storeId: 0, supplierId: 0, type: 3 }, delivery: { type: 0, relationId: 0 } },
        { order: { storeId: 7, supplierId: 0, type: 2 }, delivery: { type: 1, relationId: 7 } },
        { order: { storeId: 0, supplierId: 42, type: 1 }, delivery: { type: 2, relationId: 42 } },
        { order: { storeId: 7, supplierId: 42, type: 0 }, delivery: { type: 1, relationId: 7 } },
      ];
      for (const [index, owner] of owners.entries()) {
        const subject = await f.seed(provider, 2201 + index, owner.order, owner.delivery);
        const pickup = await harness.process(cityDeliveryAuthorityEvent(subject, source, provider === 'dada' ? 2 : 3, clock - 100));
        expect(pickup.result).toBe('completed'); expect((await callbackAuthorityRows(f.db, pickup)).event.status).toBe('APPLIED');
        expect((await f.db.select().from(storeDeliveryOrder).where(eq(storeDeliveryOrder.id, subject.id)))[0].status).toBe(2);
        expect((await f.db.select().from(storeOrder).where(eq(storeOrder.id, subject.oid)))[0])
          .toMatchObject({ status: 1, deliveryType: 'city_delivery', deliveryName: provider === 'dada' ? '新确认骑手' : '新确认跑男',
            deliveryId: provider === 'dada' ? '13800138000' : '13900139000' });
        const cancellation = await harness.process(cityDeliveryAuthorityEvent(subject, source, provider === 'dada' ? 5 : -1, clock - 90));
        expect(cancellation.result).toBe('completed'); expect((await callbackAuthorityRows(f.db, cancellation)).event.status).toBe('APPLIED');
        expect((await f.db.select().from(storeDeliveryOrder).where(eq(storeDeliveryOrder.id, subject.id)))[0].status).toBe(-1);
        expect((await f.db.select().from(storeOrder).where(eq(storeOrder.id, subject.oid)))[0])
          .toMatchObject({ status: 0, deliveryType: '', deliveryName: '', deliveryId: '', deliveryUid: 0 });
        const after = await f.snapshot(); expect(await harness.service.processMessage(cancellation.message)).toBe('already-completed');
        expect(await f.snapshot()).toEqual(after);
      }
    }));

  it.each(['second-attempt', 'buyer-drift'] as const)('revalidates same-event-key retry after simulated finishClaim failure: %s', async drift =>
    f.profiles(async (app, admin) => {
      const provider = drift === 'second-attempt' ? 'dada' : 'uu', source = provider === 'dada' ? 'callback' : 'query';
      const subject = await f.seed(provider, 2401, { status: 2 });
      const harness = callbackAuthorityHarness(provider === 'dada' ? app.db : admin.db);
      const evidence = cityDeliveryAuthorityEvent(subject, source, provider === 'dada' ? 4 : 10, clock - 100);
      const completed = await harness.process(evidence);
      expect(completed.result).toBe('completed'); expect((await callbackAuthorityRows(f.db, completed)).event.status).toBe('APPLIED_NOOP');
      // Model the durable recovery boundary after projection commit but before
      // finishClaim succeeded. Authority rows are genuine prior service writes;
      // only the event/outbox retry status is seeded by the owned coordinator.
      await f.db.update(cityDeliveryCallbackEvent).set({ status: 'FAILED', processedTime: 0,
        lastErrorCode: 'owned_finish_claim_failure' }).where(eq(cityDeliveryCallbackEvent.id, completed.eventId));
      await f.db.update(cityDeliveryCallbackOutbox).set({ status: 'FAILED', processedTime: 0, availableTime: 0,
        lastErrorCode: 'owned_finish_claim_failure' }).where(eq(cityDeliveryCallbackOutbox.id, completed.outboxId));
      await f.db.insert(cityDeliveryReconciliationCase).values({ provider, subjectKeyHash: evidence.subjectKeyHash,
        deliveryOrderId: subject.id, status: 'PENDING', nextAttemptTime: clock, addTime: clock, updateTime: clock });
      if (drift === 'second-attempt') await f.db.insert(storeDeliveryOrder).values({ id: 2402, oid: subject.oid, uid: 77,
        stationType: 1, type: 0, relationId: 0, orderId: 'dada-auth-second-attempt', deliveryNo: 'second-attempt-code', status: 0 });
      else await f.db.update(storeOrder).set({ uid: 88 }).where(eq(storeOrder.id, subject.oid));
      const before = await f.snapshot(), reconciliation = await f.db.select().from(cityDeliveryReconciliationCase);
      expect(await harness.service.processMessage(completed.message)).toBe('conflict');
      expect(await f.snapshot()).toEqual(before);
      expect(await f.db.select().from(cityDeliveryReconciliationCase)).toEqual(reconciliation);
      expect((await callbackAuthorityRows(f.db, completed)).event).toMatchObject({ status: 'CONFLICT', riderName: '', riderMobile: '', finishCode: '', reasonText: '' });
      expect((await callbackAuthorityRows(f.db, completed)).outbox.status).toBe('DEAD');
      expect(await harness.service.processMessage(completed.message)).toBe('conflict');
      expect(await f.snapshot()).toEqual(before); expect(await f.db.select().from(cityDeliveryReconciliationCase)).toEqual(reconciliation);
    }));
});

const receiptGuards = [
  { name: 'refund pending', order: { refundStatus: 1 } },
  { name: 'not paid', order: { paid: 0 } },
  { name: 'split parent', order: { pid: -1 } },
  { name: 'allocation incomplete', order: { supplierAllocationStatus: 1 } },
  { name: 'pickup requires writeoff', order: { shippingType: 2 } },
  { name: 'send requires assigned delivery writeoff', order: { deliveryType: 'send' } },
  { name: 'system deleted original', order: { isSystemDel: 1 } },
  { name: 'already completed later express shipment', order: { status: 2, deliveryType: 'express', deliveryName: '后来快递', deliveryId: 'later-express' } },
] as const;

describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('city delivery completes real financial receipt in one original-order authority transaction', () => {
  let full: Awaited<ReturnType<typeof refundRuntimeFixture>>;
  beforeEach(async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('No external provider or payment I/O'));
    full = await refundRuntimeFixture();
  }, 120_000);
  afterEach(async () => {
    try { expect(fetch).not.toHaveBeenCalled(); } finally { vi.restoreAllMocks(); await full?.close(); }
  }, 30_000);

  async function commissioned(run: (app: CallbackAuthorityRuntimePeer, admin: CallbackAuthorityRuntimePeer) => Promise<void>) {
    const withRuntimeRole = full.withRuntimeRole;
    if (!withRuntimeRole) throw Error('Full financial authority requires independent LOGINs');
    await withRuntimeRole(app => withRuntimeRole(async admin => {
      const [identity] = await full.db.execute(sql`SELECT current_database() AS name`);
      const names = { app: app.role, admin: admin.role, maintenance: 'finance_test',
        database: String(identity.name), pricingOwner: full.pricingOwner };
      await runRuntimeBusinessCommissioning(full.db, names);
      for (const [peer, profile] of [[app, 'app'], [admin, 'admin']] as const) {
        expect(await auditRuntimeBusinessPrivileges(peer.db, profile, names)).toMatchObject({ ready: true, failures: [] });
        expect((await peer.exec('SELECT current_user AS role,session_user AS session'))[0]).toEqual({ role: peer.role, session: peer.role });
        expect((await peer.exec("SELECT has_schema_privilege(current_user,'public','CREATE') AS ddl,rolsuper,rolcreatedb,rolcreaterole,rolbypassrls FROM pg_roles WHERE rolname=current_user"))[0])
          .toEqual({ ddl: false, rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolbypassrls: false });
      }
      expect(app.pid).not.toBe(admin.pid);
      await run(app, admin);
    }));
  }
  function receiptEnvironment(gate?: () => Promise<void>): SystemConfigEnv {
    const values: Record<string, string> = { extract_time: '0', brokerage_func_status: '1', store_brokerage_statu: '1',
      store_brokerage_price: '0', order_give_integral: '1', order_give_exp: '0', member_func_status: '0' };
    return { CONFIG_KV: { ...full.env.CONFIG_KV, get: async key => {
      // This is a real shared receipt-context binding boundary in both old
      // cross-transaction and new atomic implementations. No method spy relies
      // on a removed projector call or supplies a forged query/receipt result.
      if (gate && key === 'cfg_extract_time') await gate();
      const name = key.replace(/^cfg_/, '');
      return values[name] ?? full.env.CONFIG_KV.get(key);
    } } };
  }
  async function seedFinancial(peer: CallbackAuthorityRuntimePeer, provider: CityDeliveryProvider, id: number,
    overrides: Partial<typeof storeOrder.$inferInsert> = {}): Promise<CallbackAuthoritySubject> {
    const providerId = `${provider}-financial-${id}`, code = `${providerId}-code`;
    // Synthetic paid/shipped marker only. Registered schema and real receipt,
    // supplier ledger, reward and brokerage SQL execute under the actual LOGIN.
    const [original] = await full.db.insert(storeOrder).values({ id, uid: 11, orderId: `financial-${id}`,
      type: 0, supplierId: 7, storeId: 0, paid: 1, status: 1, pid: 0, supplierAllocationStatus: 2,
      shippingType: 1, deliveryType: 'city_delivery', deliveryName: '已登记骑手', deliveryId: '13700137000',
      deliveryUid: 91, refundStatus: 0, payType: 'yue', payTime: 100, totalPrice: '10.00', payPrice: '10.00',
      payPostage: '1.00', gainIntegral: '7.00', spreadUid: 22, oneBrokerage: '3.00', twoBrokerage: '0.00', ...overrides }).returning();
    await full.db.insert(storeOrderCartInfo).values({ oid: id, uid: 11, cartId: 'financial-line', productId: 70,
      cartNum: 2, settlePrice: '4.00', unique: `financial-line-${id}`, cartInfo: '{}' });
    await full.db.insert(storeDeliveryOrder).values({ id, oid: id, uid: 11, type: 2, relationId: 7,
      stationType: provider === 'dada' ? 1 : 2, orderId: providerId, deliveryNo: code, status: 0 });
    await withTx(createContainerFromDb(peer.db), tx => recordSupplierPayment(tx, original, 100));
    expect((await full.db.select().from(supplierFlowingWater).where(eq(supplierFlowingWater.linkId, original.orderId)))[0])
      .toMatchObject({ supplierId: 7, number: overrides.shippingType === 2 ? '8.00' : '9.00', status: 0 });
    return { id, oid: id, provider, providerId, code };
  }
  const financialSnapshot = async () => ({ finance: await full.state(),
    deliveries: await full.db.select().from(storeDeliveryOrder).orderBy(storeDeliveryOrder.id) });

  it.each(matrix)('%s/%s completes supplier income, real points and brokerage once, with duplicate/repeated completion unchanged', async (provider, source) =>
    commissioned(async (app, admin) => {
      const peer = provider === 'dada' ? app : admin, subject = await seedFinancial(peer, provider, 3001);
      const harness = callbackAuthorityHarness(peer.db, receiptEnvironment());
      const evidence = cityDeliveryAuthorityEvent(subject, source, provider === 'dada' ? 4 : 10, clock - 100);
      const completed = await harness.process(evidence);
      expect(completed.result).toBe('completed'); expect((await callbackAuthorityRows(full.db, completed)).event.status).toBe('APPLIED');
      expect((await callbackAuthorityRows(full.db, completed)).outbox.status).toBe('COMPLETED');
      expect((await full.db.select().from(storeOrder).where(eq(storeOrder.id, subject.oid)))[0]).toMatchObject({ status: 2, deliveryType: 'city_delivery' });
      expect((await full.db.select().from(storeDeliveryOrder).where(eq(storeDeliveryOrder.id, subject.id)))[0]).toMatchObject({ status: 4, reason: '' });
      expect((await full.db.select().from(user).where(eq(user.uid, 11)))[0]).toMatchObject({ integral: 117, exp: '0.00' });
      expect((await full.db.select().from(user).where(eq(user.uid, 22)))[0]).toMatchObject({ brokeragePrice: '3.00' });
      expect(await full.db.select().from(userBill).where(eq(userBill.linkId, String(subject.oid))).orderBy(userBill.id))
        .toMatchObject([{ eventKey: 'pay_give_integral', number: '7.00' }, { eventKey: 'order_give_integral', number: '10.00' }]);
      expect(await full.db.select().from(userBrokerage).where(eq(userBrokerage.linkId, String(subject.oid))))
        .toMatchObject([{ uid: 22, number: '3.00', category: 'one_brokerage' }]);
      expect(await full.db.select().from(supplierFlowingWater).where(eq(supplierFlowingWater.linkId, `financial-${subject.oid}`)))
        .toMatchObject([{ supplierId: 7, number: '9.00', status: 1 }]);
      expect(await full.db.select().from(supplierTransactions).where(eq(supplierTransactions.linkId, `financial-${subject.oid}`))).toHaveLength(1);
      expect((await full.db.select().from(storeOrderStatus).where(eq(storeOrderStatus.oid, subject.oid))).filter(row => row.changeType === 'take_delivery')).toHaveLength(1);
      expect((await callbackAuthorityWatermark(full.db, evidence))[0]).toMatchObject({ lastState: 'DELIVERED', lastRank: 60, terminal: 1 });
      const after = await financialSnapshot();
      expect(await harness.service.receive(evidence)).toMatchObject({ duplicate: true, eventId: completed.eventId, outboxId: completed.outboxId });
      expect(await harness.service.processMessage(completed.message)).toBe('already-completed');
      const repeated = await harness.process(cityDeliveryAuthorityEvent(subject, source === 'callback' ? 'query' : 'callback', provider === 'dada' ? 4 : 10, clock - 90));
      expect(repeated.result).toBe('completed'); expect((await callbackAuthorityRows(full.db, repeated)).event.status).toBe('APPLIED_NOOP');
      expect(await financialSnapshot()).toEqual(after);
    }), 120_000);

  it('rechecks original city attempt after an independent peer cancels it and starts express at the real receipt-context boundary', async () =>
    commissioned(async (app, admin) => {
      const subject = await seedFinancial(app, 'dada', 3101);
      let gates = 0, replaced: Awaited<ReturnType<typeof financialSnapshot>> | undefined;
      const env = receiptEnvironment(async () => {
        if (++gates !== 1) return;
        await withTx(createContainerFromDb(admin.db), async tx => {
          await tx.execute(sql`LOCK TABLE ${storeDeliveryOrder} IN SHARE ROW EXCLUSIVE MODE`);
          await lockOrderSettlement(tx, subject.oid);
          await tx.update(storeOrder).set({ deliveryType: 'express', deliveryName: '新快递承运商', deliveryId: 'NEW-EXPRESS-3101', deliveryUid: 0 })
            .where(eq(storeOrder.id, subject.oid));
          await tx.update(storeDeliveryOrder).set({ status: -1, reason: '原同城尝试已撤销' }).where(eq(storeDeliveryOrder.id, subject.id));
        });
        replaced = await financialSnapshot();
      });
      const harness = callbackAuthorityHarness(app.db, env), evidence = cityDeliveryAuthorityEvent(subject, 'callback', 4, clock - 100);
      const processed = await harness.process(evidence);
      expect(gates).toBe(1); expect(replaced).toBeDefined();
      expect(processed.result).toBe('conflict'); expect((await callbackAuthorityRows(full.db, processed)).event.status).toBe('CONFLICT');
      expect((await callbackAuthorityRows(full.db, processed)).outbox.status).toBe('DEAD');
      expect(await financialSnapshot()).toEqual(replaced); expect(await callbackAuthorityWatermark(full.db, evidence)).toEqual([]);
      expect((await full.db.select().from(storeOrder).where(eq(storeOrder.id, subject.oid)))[0])
        .toMatchObject({ status: 1, deliveryType: 'express', deliveryName: '新快递承运商', deliveryId: 'NEW-EXPRESS-3101' });
    }), 120_000);

  it('rolls back actual supplier settlement, reward and brokerage when the final delivery write fails', async () =>
    commissioned(async (app) => {
      const subject = await seedFinancial(app, 'dada', 3201), before = await financialSnapshot();
      // Test-owned native SQL failure at the final business write. The legacy
      // three-transaction path has already committed receipt finance here.
      await full.exec(`CREATE FUNCTION public.owned_city_final_delivery_failure() RETURNS trigger LANGUAGE plpgsql AS $owned$
        BEGIN IF NEW.id=3201 AND NEW.status=4 THEN RAISE EXCEPTION 'owned final delivery failure' USING ERRCODE='23514'; END IF; RETURN NEW; END $owned$`);
      await full.exec('CREATE TRIGGER owned_city_final_delivery_failure BEFORE UPDATE ON public.store_delivery_order FOR EACH ROW EXECUTE FUNCTION public.owned_city_final_delivery_failure()');
      const harness = callbackAuthorityHarness(app.db, receiptEnvironment()), evidence = cityDeliveryAuthorityEvent(subject, 'callback', 4, clock - 100);
      const processed = await harness.process(evidence);
      expect(processed.result).toMatchObject({ kind: 'deferred' });
      expect((await callbackAuthorityRows(full.db, processed)).event.status).toBe('FAILED');
      expect((await callbackAuthorityRows(full.db, processed)).outbox.status).toBe('FAILED');
      expect(await financialSnapshot()).toEqual(before); expect(await callbackAuthorityWatermark(full.db, evidence)).toEqual([]);
      expect(await full.db.select().from(userBill).where(eq(userBill.linkId, String(subject.oid)))).toEqual([]);
      expect(await full.db.select().from(userBrokerage).where(eq(userBrokerage.linkId, String(subject.oid)))).toEqual([]);
    }), 120_000);

  it.each(receiptGuards)('delivered evidence cannot bypass shared receipt eligibility: $name', async guard =>
    commissioned(async (app, admin) => {
      // Alternate authenticated runtime profiles and evidence sources while
      // retaining each ordinary shared receipt restriction independently.
      const peer = guard.name === 'not paid' || guard.name === 'pickup requires writeoff' ? app : admin;
      const provider = peer === app ? 'dada' : 'uu', source: CallbackAuthoritySource = peer === app ? 'callback' : 'query';
      const subject = await seedFinancial(peer, provider, 3301, guard.order), before = await financialSnapshot();
      const harness = callbackAuthorityHarness(peer.db, receiptEnvironment());
      const evidence = cityDeliveryAuthorityEvent(subject, source, provider === 'dada' ? 4 : 10, clock - 100), processed = await harness.process(evidence);
      expect(await financialSnapshot()).toEqual(before); expect(await callbackAuthorityWatermark(full.db, evidence)).toEqual([]);
      const terminal = await callbackAuthorityRows(full.db, processed);
      // Preserve the existing unmatched-order retry lifecycle for a system-
      // deleted row. Other receipt restrictions are definite state conflicts.
      if (guard.name === 'system deleted original') {
        expect(processed.result).toMatchObject({ kind: 'deferred' });
        expect(terminal.event.status).toBe('FAILED'); expect(terminal.outbox.status).toBe('FAILED');
      } else {
        expect(processed.result).toBe('conflict');
        expect(terminal.event.status).toBe('CONFLICT'); expect(terminal.outbox.status).toBe('DEAD');
      }
      expect(await full.db.select().from(userBill).where(eq(userBill.linkId, String(subject.oid)))).toEqual([]);
      expect(await full.db.select().from(userBrokerage).where(eq(userBrokerage.linkId, String(subject.oid)))).toEqual([]);
    }), 120_000);

  it('holds the delivery table fence through actual receipt commit so another session cannot insert a second attempt phantom', async () =>
    commissioned(async (app, admin) => full.withPeer!(async importer => {
      const subject = await seedFinancial(app, 'dada', 3401);
      for (const runtime of [app, admin]) await expect(runtime.exec('INSERT INTO public.store_delivery_order(oid,uid) VALUES(3401,11)'))
        .rejects.toMatchObject({ code: '42501' });
      expect((await importer.exec('SELECT current_user AS role,session_user AS session'))[0]).toEqual({ role: 'finance_test', session: 'finance_test' });
      expect(importer.pid).not.toBe(app.pid); expect(importer.pid).not.toBe(admin.pid);
      let announce!: () => void, release!: () => void, paused = false;
      const entered = new Promise<void>(resolve => { announce = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
      const observed = observeCityDeliveryRecordDb(app.db, async (_tx, command) => {
        const statement = command.toLowerCase();
        if (!paused && statement.includes('from "store_order"') && statement.includes('for update')) {
          paused = true; announce(); await gate;
        }
      });
      const harness = callbackAuthorityHarness(observed, receiptEnvironment());
      const evidence = cityDeliveryAuthorityEvent(subject, 'callback', 4, clock - 100);
      const projection = harness.process(evidence);
      let insertion: Promise<unknown> | undefined, insertionFinished = false;
      let lockEvidence: { fence: boolean; blocked_insert: boolean; blockers: number[] } | undefined;
      try {
        await entered;
        // This genuine owned maintenance/import session has INSERT; ordinary
        // runtime roles deliberately remain denied and receive no extra ACL.
        insertion = importer.db.insert(storeDeliveryOrder).values({ id: 3402, oid: subject.oid, uid: 11, type: 2,
          relationId: 7, stationType: 1, orderId: 'dada-financial-phantom', deliveryNo: 'phantom-code', status: 0 })
          .then(value => { insertionFinished = true; return value; });
        const deadline = performance.now() + 3500;
        do {
          const [locks] = await full.db.execute(sql`SELECT
            EXISTS(SELECT 1 FROM pg_locks WHERE pid=${app.pid} AND locktype='relation'
              AND relation='public.store_delivery_order'::regclass AND mode='ShareRowExclusiveLock' AND granted) AS fence,
            EXISTS(SELECT 1 FROM pg_locks WHERE pid=${importer.pid} AND locktype='relation'
              AND relation='public.store_delivery_order'::regclass AND mode='RowExclusiveLock' AND NOT granted) AS blocked_insert,
            pg_blocking_pids(${importer.pid}::integer) AS blockers`);
          lockEvidence = { fence: Boolean(locks.fence), blocked_insert: Boolean(locks.blocked_insert), blockers: locks.blockers as number[] };
          if (lockEvidence.fence && lockEvidence.blocked_insert && lockEvidence.blockers.includes(app.pid)) break;
          // The legacy callback has no fence, so the actual INSERT completes
          // here. Completion, rather than elapsed time, proves its red case.
          if (insertionFinished) break;
          await delay(10);
        } while (performance.now() < deadline);
      } finally { release(); }
      const completed = await projection;
      await insertion;
      expect(paused).toBe(true); expect(lockEvidence).toMatchObject({ fence: true, blocked_insert: true });
      expect(lockEvidence?.blockers).toContain(app.pid);
      expect(completed.result).toBe('completed'); expect((await callbackAuthorityRows(full.db, completed)).event.status).toBe('APPLIED');
      expect((await full.db.select().from(storeOrder).where(eq(storeOrder.id, subject.oid)))[0].status).toBe(2);
      expect((await full.db.select().from(user).where(eq(user.uid, 11)))[0].integral).toBe(117);
      expect((await full.db.select().from(user).where(eq(user.uid, 22)))[0].brokeragePrice).toBe('3.00');
      expect((await full.db.select().from(storeDeliveryOrder).where(eq(storeDeliveryOrder.id, 3402)))[0])
        .toMatchObject({ oid: subject.oid, status: 0 });
    })), 120_000);

  it('waits for the delivery table gate before acquiring settlement/subject advisory locks, preserving the stricter real lock timeout', async () =>
    commissioned(async (app, admin) => {
      const subject = await seedFinancial(app, 'dada', 3501), before = await financialSnapshot();
      await app.exec("SET lock_timeout='400ms'; SET statement_timeout='2000ms'");
      let announce!: () => void, release!: () => void;
      const held = new Promise<void>(resolve => { announce = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
      const writer = withTx(createContainerFromDb(admin.db), async tx => {
        await tx.execute(sql`LOCK TABLE ${storeDeliveryOrder} IN ROW EXCLUSIVE MODE`); announce(); await gate;
      });
      let processed: Awaited<ReturnType<ReturnType<typeof callbackAuthorityHarness>['process']>> | undefined;
      let lockEvidence: { waiting_fence: boolean; advisory_count: number; blockers: number[] } | undefined;
      const localTimeouts: { lock_ms: number; statement_ms: number; idle_ms: number }[] = [];
      const observed = observeCityDeliveryRecordDb(app.db, async (tx, command) => {
        if (command !== 'execute') return;
        // Read the real transaction immediately after each successful execute.
        // The projection's set_config statement establishes idle=5000 before
        // its table gate waits; other callback transactions retain idle=0.
        const [settings] = await tx.execute(sql`SELECT
          (SELECT setting::integer FROM pg_settings WHERE name='lock_timeout') AS lock_ms,
          (SELECT setting::integer FROM pg_settings WHERE name='statement_timeout') AS statement_ms,
          (SELECT setting::integer FROM pg_settings WHERE name='idle_in_transaction_session_timeout') AS idle_ms`);
        localTimeouts.push({ lock_ms: Number(settings.lock_ms), statement_ms: Number(settings.statement_ms), idle_ms: Number(settings.idle_ms) });
      });
      try {
        await held;
        const harness = callbackAuthorityHarness(observed, receiptEnvironment());
        let finished = false;
        const projection = harness.process(cityDeliveryAuthorityEvent(subject, 'query', 4, clock - 100)).then(value => { finished = true; return value; });
        const deadline = performance.now() + 2500;
        do {
          const [locks] = await full.db.execute(sql`SELECT
            EXISTS(SELECT 1 FROM pg_locks WHERE pid=${app.pid} AND locktype='relation'
              AND relation='public.store_delivery_order'::regclass AND mode='ShareRowExclusiveLock' AND NOT granted) AS waiting_fence,
            (SELECT count(*)::integer FROM pg_locks WHERE pid=${app.pid} AND locktype='advisory' AND granted) AS advisory_count,
            pg_blocking_pids(${app.pid}::integer) AS blockers`);
          lockEvidence = { waiting_fence: Boolean(locks.waiting_fence), advisory_count: Number(locks.advisory_count), blockers: locks.blockers as number[] };
          if (lockEvidence.waiting_fence && lockEvidence.blockers.includes(admin.pid)) break;
          if (finished) break;
          await delay(10);
        } while (performance.now() < deadline);
        // Keep the writer's genuine RowExclusiveLock until the consumer has
        // hit the 400ms session limit; releasing it early would hide ordering.
        processed = await projection;
      } finally { release(); await writer; }
      expect(lockEvidence).toMatchObject({ waiting_fence: true, advisory_count: 0 }); expect(lockEvidence?.blockers).toContain(admin.pid);
      expect(localTimeouts).toContainEqual({ lock_ms: 400, statement_ms: 2000, idle_ms: 5000 });
      expect(processed?.result).toMatchObject({ kind: 'deferred' });
      if (!processed) throw Error('No actual callback projection result');
      expect((await callbackAuthorityRows(full.db, processed)).event.status).toBe('FAILED');
      expect((await callbackAuthorityRows(full.db, processed)).outbox.status).toBe('FAILED');
      expect(await financialSnapshot()).toEqual(before); expect(await full.db.select().from(cityDeliveryCallbackWatermark)).toEqual([]);
      expect((await app.exec("SELECT (SELECT setting::integer FROM pg_settings WHERE name='lock_timeout') AS lock_ms"))[0].lock_ms).toBe(400);
    }), 120_000);

  it('uses a fresh snapshot after a waited fence even when the authenticated consumer defaults to repeatable read', async () =>
    commissioned(async app => full.withPeer!(async importer => {
      const subject = await seedFinancial(app, 'dada', 3601), before = await financialSnapshot();
      await app.exec("SET default_transaction_isolation='repeatable read'");
      let announce!: () => void, release!: () => void;
      const held = new Promise<void>(resolve => { announce = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
      const writer = withTx(createContainerFromDb(importer.db), async tx => {
        await tx.insert(storeDeliveryOrder).values({ id: 3602, oid: subject.oid, uid: 11, type: 2, relationId: 7,
          stationType: 1, orderId: 'dada-financial-rr-phantom', deliveryNo: 'rr-phantom-code', status: 0 });
        announce(); await gate;
      });
      let waiting = false, advisoryCount = -1;
      const harness = callbackAuthorityHarness(app.db, receiptEnvironment());
      const evidence = cityDeliveryAuthorityEvent(subject, 'query', 4, clock - 100);
      let projection: ReturnType<typeof harness.process> | undefined, finished = false;
      try {
        await held;
        projection = harness.process(evidence).then(value => { finished = true; return value; });
        const deadline = performance.now() + 1500;
        do {
          const [locks] = await full.db.execute(sql`SELECT
            EXISTS(SELECT 1 FROM pg_locks WHERE pid=${app.pid} AND locktype='relation'
              AND relation='public.store_delivery_order'::regclass AND mode='ShareRowExclusiveLock' AND NOT granted) AS waiting_fence,
            (SELECT count(*)::integer FROM pg_locks WHERE pid=${app.pid} AND locktype='advisory' AND granted) AS advisory_count,
            pg_blocking_pids(${app.pid}::integer) AS blockers`);
          if (locks.waiting_fence && (locks.blockers as number[]).includes(importer.pid)) {
            waiting = true; advisoryCount = Number(locks.advisory_count); break;
          }
          if (finished) break;
          await delay(10);
        } while (performance.now() < deadline);
      } finally { release(); await writer; }
      const processed = await projection;
      expect(waiting).toBe(true); expect(advisoryCount).toBe(0);
      if (!processed) throw Error('No actual repeatable-read projection result');
      expect(processed.result).toBe('conflict'); expect((await callbackAuthorityRows(full.db, processed)).event.status).toBe('CONFLICT');
      expect((await callbackAuthorityRows(full.db, processed)).outbox.status).toBe('DEAD');
      const after = await financialSnapshot(); expect(after.finance).toEqual(before.finance);
      expect(after.deliveries.filter(row => row.id !== 3602)).toEqual(before.deliveries);
      expect(after.deliveries.find(row => row.id === 3602)).toMatchObject({ oid: subject.oid, uid: 11, status: 0 });
      expect(await callbackAuthorityWatermark(full.db, evidence)).toEqual([]);
      expect((await app.exec("SELECT current_setting('default_transaction_isolation') AS isolation"))[0].isolation).toBe('repeatable read');
    })), 120_000);
});
