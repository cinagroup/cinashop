/** Full registered profiles, real LOGINs and business entrypoints. Metadata
 * commissioning checks precede the actual payment/Queue cases in this file. */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { storeDiscounts, storeDiscountsProducts, storeOrderOutbox, storeProduct, storeProductAttrValue,
  systemAdmin, systemRole, systemSupplier, userLabel, userLabelRelation } from '@/models/schema';
import { StoreDiscountService, resolveDiscountPackageSelection } from '@/services/activity/StoreDiscountService';
import { AdminFullGiftService } from '@/services/admin/AdminFullGiftService';
import { createContainerFromDb } from '@/lib/di';
import { PurchasedProductLabelTaskService } from '@/services/order/PurchasedProductLabelTaskService';
import { readPurchasedLabelIntent, verifyPurchasedLabelIntent } from '@/services/order/PurchasedProductLabelSource';
import { capturePurchasedProductLabelMessage } from '@/services/order/PurchasedProductLabelQueue';
import { customerCashierRuntimeHttpFixture } from './helpers/customerCashierRuntimeHttpFixture';
import { installPurchasedProductLabelStorage } from '@/migrations/installPurchasedProductLabelStorage';
import { inspectPurchasedLabelStorage } from '@/migrations/purchasedProductLabelStorage';
import { upgradePurchasedProductLabelRuntime, upgradePurchasedProductLabelRuntimeInTransaction } from '@/migrations/upgradePurchasedProductLabelRuntime';
import { assertPurchasedLabelRuntimeTx, inspectPurchasedLabelRuntime } from '@/migrations/purchasedProductLabelRuntime';
import { inspectRuntimeBusinessProfileInTransaction } from '@/migrations/auditRuntimeBusinessPrivileges';
import { capturePurchasedLabelRuntimeDeclaration } from '@/services/order/PurchasedProductLabelRuntimeDeclaration';
import type { RuntimeGiftPeerDeclarations } from '@/migrations/customerRuntimeGiftPeers';
// Only platform entrypoint ports are adapted. All Queue routing, paid authors,
// task services and SQL use the real registered App/Admin LOGINs below.
const wiring = vi.hoisted(() => ({ application: vi.fn(), errors: [] as Error[] }));
vi.mock('@/lib/di', async original => ({ ...await original<typeof import('@/lib/di')>(), createContainer: wiring.application }));
vi.mock('@/middleware/error', async original => {
  const actual = await original<typeof import('@/middleware/error')>();
  return { ...actual, errorHandler: (...args: Parameters<typeof actual.errorHandler>) => { wiring.errors.push(args[0]); return actual.errorHandler(...args); } };
});
vi.mock('@/do/TokenBucketDO', () => ({ TokenBucketDO: class {} }));
vi.mock('@/do/OrderLockDO', () => ({ OrderLockDO: class {} }));
vi.mock('@/do/SequenceDO', () => ({ SequenceDO: class {} }));
vi.mock('@/do/ChatRoomDO', () => ({ ChatRoomDO: class {} }));
vi.mock('@/do/StaffNotificationDO', () => ({ StaffNotificationDO: class {} }));
const addon = { purchasedProductLabels: true } as const;
describe.runIf(Boolean(process.env.TEST_FINANCE_POSTGRES_URL))('actual purchased product label author and Queue', () => {
  let f: Awaited<ReturnType<typeof customerCashierRuntimeHttpFixture>>, peers: RuntimeGiftPeerDeclarations;
  let network: ReturnType<typeof vi.spyOn>;
  const desired = () => capturePurchasedLabelRuntimeDeclaration({ ...f.peers, purchasedProductLabels: addon });
  const named = () => ({ database: f.target.database, maintenance: f.target.maintenance });
  const service = () => new PurchasedProductLabelTaskService(createContainerFromDb(f.appRuntime.db), f.env);
  const taskFor = async (orderId: number) => {
    const rows = await f.maintenanceDb.execute<{ taskId: string; eventKey: string }>(sql`SELECT task_id::text AS "taskId",event_key AS "eventKey"
      FROM public.purchased_product_label_intent WHERE order_id=${orderId}`);
    expect(rows).toHaveLength(1);
    return capturePurchasedProductLabelMessage({ action: 'processPurchasedProductLabels', ...rows[0] });
  };
  const resultFor = async (taskId: string) => {
    const [row] = await f.maintenanceDb.execute<{ result: any; status: string }>(sql`SELECT r.result,s.status FROM public.purchased_product_label_state s
      LEFT JOIN public.purchased_product_label_result r ON r.task_id=s.task_id WHERE s.task_id=${taskId}::uuid`);
    return row;
  };
  const queue = async (body: unknown, attempts = 1, queueName = 'owned-purchased-label-queue') => {
    wiring.application.mockReturnValue(createContainerFromDb(f.appRuntime.db));
    const ack = vi.fn(), retry = vi.fn(), worker = (await import('@/index')).default;
    await worker.queue({ queue: queueName, messages: [{ id: crypto.randomUUID(), timestamp: new Date(), body, attempts, ack, retry }] } as unknown as MessageBatch<import('@/env').OrderMessage>, f.env);
    return { ack, retry };
  };
  const admin = async (path: string, body?: unknown, id = 1, realm: 'api'|'admin' = 'admin') => {
    const response = await f.raw(path, { method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: 'Bearer '+await f.bearer(id, realm, realm === 'admin' ? 'offline-native-admin-password' : 'owned-financial-password'),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return await response.json() as { status: number; msg: string; data: any };
  };
  const replay = (taskId: string) => admin('/admin/order/product-label-tasks/'+taskId+'/replay',
    { confirm: 'REPLAY_PURCHASED_LABEL_TASK', reason: '原生验收已维护标签配置' });
  const ordinary = async () => {
    await f.maintenanceDb.update(storeProduct).set({ productType: 0, type: 0, relationId: 0, deliveryType: '1', freight: 1,
      isShow: 1, isDel: 0, stock: 100, isVip: 0 }).where(eq(storeProduct.id,70));
    await f.maintenanceDb.update(storeProductAttrValue).set({ productType: 0, price: '7.00', vipPrice: '7.00', stock: 100 }).where(eq(storeProductAttrValue.id,1));
  };
  const addCart = async (productId: number, unique: string) => {
    const added = await f.request('/cart/add', { productId, unique, cartNum: 1, new: 1 }, undefined, 11);
    expect(added.body.status, added.body.msg).toBe(200); return Number(added.body.data.cartId);
  };
  const checkout = async (cartIds: number[], type = 0) => {
    const selection = { cartIds, type, addressId: 11, shippingType: 1, useIntegral: false, payType: 'yue', from: 'pc' };
    const quote = await f.request('/order/confirm', selection, undefined, 11);
    expect(quote.body.status, quote.body.msg).toBe(200);
    const created = await f.request('/order/create/'+quote.body.data.orderKey, { ...selection, quoteToken: quote.body.data.quoteToken }, undefined, 11);
    if (created.body.status===500) throw Error('Actual customer checkout error', { cause: wiring.errors.at(-1) });
    expect(created.body.status, created.body.msg).toBe(200); expect(created.body.data.paid).toBe(true);
    const order = await createContainerFromDb(f.appRuntime.db).storeOrderDao.findByOrderId(created.body.data.orderId);
    expect(order?.paid).toBe(1);
    const [event] = await f.maintenanceDb.select().from(storeOrderOutbox).where(and(eq(storeOrderOutbox.aggregateId,order!.id),eq(storeOrderOutbox.eventType,'order.paid')));
    expect(event).toBeDefined();
    const parent = await queue({ action: 'processOrderPaidOutbox', outboxId: event!.id, eventKey: event!.eventKey });
    expect(parent.ack).toHaveBeenCalledOnce(); expect(parent.retry).not.toHaveBeenCalled();
    return { order: order!, event: event! };
  };
  beforeAll(async () => {
    network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('External provider transport is forbidden in purchased-label acceptance'));
    f = await customerCashierRuntimeHttpFixture();
    await installPurchasedProductLabelStorage(f.maintenanceDb, named(), addon); peers = desired();
  }, 180000);
  afterAll(async () => { try { expect(network).not.toHaveBeenCalled(); } finally { network?.mockRestore(); await f?.close(); } }, 30000);
  it('keeps owner-only storage denied until the explicit whole five-profile successor is declared', async () => {
    expect(await inspectPurchasedLabelStorage(f.maintenanceDb, named())).toMatchObject({ storageReady: true, runtimeReady: false });
    expect(await inspectPurchasedLabelRuntime(f.maintenanceDb, f.target, addon)).toMatchObject({ ready: false });
    await expect(upgradePurchasedProductLabelRuntime(f.maintenanceDb, f.peers, f.appReaders)).rejects.toThrow('Complete');
    await expect(f.appRuntime.db.execute(sql`SELECT * FROM public.purchased_product_label_intent LIMIT 0`))
      .rejects.toMatchObject({ cause: { code: '42501' } });
  });
  it('rolls complete grants and binding back with the owned maintenance transaction', async () => {
    await expect(f.maintenanceDb.transaction(async tx => {
      expect(await upgradePurchasedProductLabelRuntimeInTransaction(tx, peers, f.appReaders)).toMatchObject({ applied: true });
      expect(await inspectPurchasedLabelRuntime(tx, f.target, addon)).toMatchObject({ ready: true });
      throw Error('owned purchased label commissioning rollback');
    })).rejects.toThrow('owned purchased label commissioning rollback');
    expect(await inspectPurchasedLabelStorage(f.maintenanceDb, named())).toMatchObject({ storageReady: true });
  }, 90000);
  it('commissions once and repeats the exact five-profile binding without changing business rows', async () => {
    const before = await f.facts();
    const first = await upgradePurchasedProductLabelRuntime(f.maintenanceDb, peers, f.appReaders);
    expect(first.applied).toBe(true); expect(first.binding.app).toBe(f.appRuntime.role);
    const repeated = await upgradePurchasedProductLabelRuntime(f.maintenanceDb, peers, f.appReaders);
    expect(repeated.applied).toBe(false); expect(repeated.binding).toEqual(first.binding); expect(await f.facts()).toEqual(before);
    await f.maintenanceDb.transaction(async tx => {
      expect((await inspectRuntimeBusinessProfileInTransaction(tx, 'app', f.target, 'current', peers, f.appReaders)).ready).toBe(true);
      expect((await inspectRuntimeBusinessProfileInTransaction(tx, 'admin', f.target, 'current', peers)).ready).toBe(true);
      expect((await inspectRuntimeBusinessProfileInTransaction(tx, 'app', f.target, 'current', f.peers, f.appReaders)).ready).toBe(false);
    });
  }, 90000);
  it('authenticates actual direct App/Admin sessions and refuses owner or borrowed purpose', async () => {
    await f.appRuntime.db.transaction(async tx => { await assertPurchasedLabelRuntimeTx(tx, f.target, 'consume'); });
    await f.adminRuntime.db.transaction(async tx => { await assertPurchasedLabelRuntimeTx(tx, f.target, 'replay'); });
    await expect(f.appRuntime.db.transaction(tx => assertPurchasedLabelRuntimeTx(tx, f.target, 'consume'),
      { isolationLevel: 'repeatable read' })).rejects.toThrow();
    for (const db of [f.adminRuntime.db, f.maintenanceDb, f.financialRuntime.db, f.managerRuntime.db])
      await expect(db.transaction(tx => assertPurchasedLabelRuntimeTx(tx, f.target, 'consume'))).rejects.toThrow();
    await expect(assertPurchasedLabelRuntimeTx(f.appRuntime.db, f.target, 'consume')).rejects.toThrow('caller transaction');
  });
  it('protects immutable rows, task identity, replay counter and role boundaries with real SQL permissions', async () => {
    for (const db of [f.appRuntime.db, f.adminRuntime.db]) for (const command of [
      'UPDATE public.purchased_product_label_intent SET source=source WHERE false',
      'DELETE FROM public.purchased_product_label_result WHERE false',
      'UPDATE public.purchased_product_label_state SET task_id=task_id WHERE false',
    ]) await expect(db.execute(sql.raw(command))).rejects.toMatchObject({ cause: { code: '42501' } });
    await expect(f.appRuntime.db.execute(sql`UPDATE public.purchased_product_label_state SET replay_count=0 WHERE false`))
      .rejects.toMatchObject({ cause: { code: '42501' } });
    await f.adminRuntime.db.execute(sql`UPDATE public.purchased_product_label_state SET replay_count=0 WHERE false`);
    await expect(f.adminRuntime.db.execute(sql`INSERT INTO public.purchased_product_label_result DEFAULT VALUES`))
      .rejects.toMatchObject({ cause: { code: '42501' } });
    for (const db of [f.financialRuntime.db, f.managerRuntime.db, f.cashierRuntime.db])
      await expect(db.execute(sql`SELECT * FROM public.purchased_product_label_intent LIMIT 0`)).rejects.toMatchObject({ cause: { code: '42501' } });
  });
  it('authors from an actual cashier payment, reads execute-time configuration and completes with its immutable receipt', async () => {
    f.env.PURCHASED_PRODUCT_LABEL_RUNTIME = peers;
    await f.maintenanceDb.insert(userLabel).values([
      { id: 9001, name: '付款时标签', type: 0, relationId: 0 },
      { id: 9002, name: '执行时平台标签', type: 0, relationId: 0 },
      { id: 9003, name: '执行时门店标签', type: 1, relationId: 1 },
      { id: 9004, name: '已停用标签', type: 0, relationId: 0, status: 0 },
    ]);
    await f.maintenanceDb.update(storeProduct).set({ labelId: '9001' }).where(eq(storeProduct.id, 70));
    // Historical scope pollution is retained, but cannot stand in for the
    // platform membership which the current label catalogue actually owns.
    await f.maintenanceDb.insert(userLabelRelation).values({ uid: 11, labelId: 9002, type: 1, relationId: 1 });
    const paid = await f.cashier(11, '7.00', 1), message = await taskFor(paid.order.id);
    const row = await readPurchasedLabelIntent(f.maintenanceDb, message.taskId), source = await verifyPurchasedLabelIntent(row!);
    expect(source).toMatchObject({ userId: 11, financialStoreId: 0, paymentOrderId: paid.order.id, orderId: paid.order.id });
    expect(await resultFor(message.taskId)).toEqual({ result: null, status: 'PENDING' });
    expect(await f.maintenanceDb.select().from(userLabelRelation).where(and(eq(userLabelRelation.uid,11),eq(userLabelRelation.labelId,9001)))).toHaveLength(0);
    // The fixed PHP DAO reads by ID, even when the product is subsequently hidden/deleted.
    await f.maintenanceDb.update(storeProduct).set({ labelId: '9002,9004,9999', isShow: 0, isDel: 1 }).where(eq(storeProduct.id,70));
    expect(await service().process(message)).toBe('completed');
    const first = await resultFor(message.taskId);
    expect(first).toMatchObject({ status: 'COMPLETED', result: { financialStoreId: 0,
      targets: [{ labelId: 9002, type: 0, relationId: 0, added: true }],
      skipped: [{ labelId: 9004, reason: 'retired' }, { labelId: 9999, reason: 'missing' }] } });
    expect(await f.maintenanceDb.select({ labelId: userLabelRelation.labelId, type: userLabelRelation.type, relationId: userLabelRelation.relationId })
      .from(userLabelRelation).where(and(eq(userLabelRelation.uid,11),sql`${userLabelRelation.labelId} BETWEEN 9001 AND 9004`)).orderBy(userLabelRelation.id))
      .toEqual([{ labelId: 9002, type: 1, relationId: 1 }, { labelId: 9002, type: 0, relationId: 0 }]);
    // A completed duplicate restores neither a removed membership nor a new config.
    await f.maintenanceDb.delete(userLabelRelation).where(and(eq(userLabelRelation.uid,11),eq(userLabelRelation.labelId,9002),eq(userLabelRelation.type,0)));
    await f.maintenanceDb.update(storeProduct).set({ labelId: '9001', isShow: 1, isDel: 0 }).where(eq(storeProduct.id,70));
    expect(await service().process(message)).toBe('already-completed');
    expect(await resultFor(message.taskId)).toEqual(first);
    expect(await f.maintenanceDb.select().from(userLabelRelation).where(and(eq(userLabelRelation.uid,11),eq(userLabelRelation.labelId,9002))))
      .toMatchObject([{ type: 1, relationId: 1 }]);
    expect(await paid.consumer.processMessage(paid.message)).toBe('already-completed');
    expect((await f.maintenanceDb.execute(sql`SELECT task_id FROM public.purchased_product_label_intent WHERE payment_event_id=${paid.payment.outbox!.id}`))).toHaveLength(1);
  }, 30000);
  it('fails a mixed foreign-store task atomically, then authorizes maintenance replay through real Admin HTTP and Worker Queue', async () => {
    await f.maintenanceDb.insert(userLabel).values([{ id: 9010, name: '可授予平台标签' }, { id: 9011, name: '其他门店标签', type: 1, relationId: 2 }]);
    await f.maintenanceDb.update(storeProduct).set({ labelId: '9010,9011' }).where(eq(storeProduct.id,70));
    const paid = await f.cashier(11, '7.00', 1), ref = await taskFor(paid.order.id);
    const failed = await queue(ref);
    expect(failed.ack).not.toHaveBeenCalled(); expect(failed.retry).toHaveBeenCalledWith({ delaySeconds: 30 });
    expect(await resultFor(ref.taskId)).toEqual({ status: 'FAILED', result: null });
    expect(await f.maintenanceDb.select().from(userLabelRelation).where(and(eq(userLabelRelation.uid,11),eq(userLabelRelation.labelId,9010)))).toHaveLength(0);
    await f.maintenanceDb.update(storeProduct).set({ labelId: '9010' }).where(eq(storeProduct.id,70));
    const recovered = await replay(ref.taskId);
    expect(recovered).toMatchObject({ status: 200, data: { replayed: true, completed: false } });
    expect(f.messages).toContainEqual(ref);
    const done = await queue(ref);
    expect(done.ack).toHaveBeenCalledOnce(); expect(done.retry).not.toHaveBeenCalled();
    expect(await resultFor(ref.taskId)).toMatchObject({ status: 'COMPLETED', result: { targets: [{ labelId: 9010, type: 0, relationId: 0, added: true }] } });
    const facts = await f.maintenanceDb.execute(sql`SELECT change_message FROM public.store_order_status WHERE oid=${paid.order.id} AND change_type='product_label_replay'`);
    expect(facts).toHaveLength(1); expect(facts[0]?.change_message).toContain('管理员1');
  }, 30000);
  it('rolls memberships, immutable success and completion back together when commit fails after all three writes', async () => {
    await f.maintenanceDb.insert(userLabel).values({ id: 9015, name: '延迟约束原子验收' });
    await f.maintenanceDb.update(storeProduct).set({ labelId: '9015' }).where(eq(storeProduct.id,70));
    const paid = await f.cashier(11, '7.00', 1), ref = await taskFor(paid.order.id);
    await f.exec(`CREATE FUNCTION public.owned_purchased_label_commit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.label_id=9015 THEN RAISE EXCEPTION 'owned deferred membership commit failure'; END IF; RETURN NEW; END $$;
      CREATE CONSTRAINT TRIGGER owned_purchased_label_commit_failure AFTER INSERT ON public.user_label_relation
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.owned_purchased_label_commit_failure()`);
    try {
      await expect(service().process(ref)).rejects.toThrow();
      expect(await resultFor(ref.taskId)).toEqual({ status: 'FAILED', result: null });
      expect(await f.maintenanceDb.select().from(userLabelRelation).where(eq(userLabelRelation.labelId,9015))).toHaveLength(0);
    } finally {
      await f.exec('DROP TRIGGER owned_purchased_label_commit_failure ON public.user_label_relation; DROP FUNCTION public.owned_purchased_label_commit_failure()');
    }
    expect(await replay(ref.taskId)).toMatchObject({ status: 200, data: { replayed: true } });
    expect(await service().process(ref)).toBe('completed');
    expect(await resultFor(ref.taskId)).toMatchObject({ status: 'COMPLETED', result: { targets: [{ labelId: 9015, added: true }] } });
  }, 30000);
  it('serializes two real purchases for one customer and appends an overlapping label once', async () => {
    await f.maintenanceDb.insert(userLabel).values({ id: 9020, name: '并发购买标签' });
    await f.maintenanceDb.update(storeProduct).set({ labelId: '9020' }).where(eq(storeProduct.id,70));
    const a = await f.cashier(11,'7.00',1), b = await f.cashier(11,'7.00',1);
    const refs = [await taskFor(a.order.id), await taskFor(b.order.id)];
    const results = await f.appRuntime.withPeer(peer => Promise.allSettled([
      service().process(refs[0]), new PurchasedProductLabelTaskService(createContainerFromDb(peer),f.env).process(refs[1]),
    ]));
    for (let i=0;i<refs.length;i++) if (results[i]?.status === 'rejected') {
      expect(await replay(refs[i]!.taskId)).toMatchObject({ status: 200 });
      expect(await service().process(refs[i])).toBe('completed');
    }
    const receipts = await Promise.all(refs.map(ref => resultFor(ref.taskId)));
    expect(receipts.map(r => r.result.targets[0].added).sort()).toEqual([false,true]);
    expect(receipts.every(r => r.status==='COMPLETED')).toBe(true);
    expect(await f.maintenanceDb.select().from(userLabelRelation).where(and(eq(userLabelRelation.uid,11),eq(userLabelRelation.labelId,9020)))).toHaveLength(1);
  }, 30000);
  it('recovers a lost post-payment accelerator and ambiguous Queue send without repeating payment effects', async () => {
    await f.maintenanceDb.insert(userLabel).values({ id: 9030, name: '派发恢复标签' });
    await f.maintenanceDb.update(storeProduct).set({ labelId: '9030' }).where(eq(storeProduct.id,70));
    const paid = await f.cashier(11,'7.00',1), ref = await taskFor(paid.order.id), before = await f.facts();
    // Only Queue transport is ambiguous: acceptance occurs and the ACK is lost.
    f.send.mockImplementationOnce(async body => { f.messages.push(body); throw Error('owned Queue send accepted but ACK lost'); });
    const scanner = await queue({ action: 'dispatchPurchasedProductLabels' });
    expect(scanner.ack).toHaveBeenCalledOnce(); expect(f.messages).toContainEqual(ref);
    expect(await resultFor(ref.taskId)).toEqual({ status: 'FAILED', result: null });
    expect(await replay(ref.taskId)).toMatchObject({ status: 200, data: { replayed: true } });
    expect((await queue(ref)).ack).toHaveBeenCalledOnce();
    expect((await queue(ref)).ack).toHaveBeenCalledOnce();
    // Whole paid order/wallet/stock/bills stay fixed except the explicit replay audit.
    const after = await f.facts();
    for (const key of ['orders','users','product','skus','outbox','payments','cards']) expect(after[key]).toEqual(before[key]);
    expect(await resultFor(ref.taskId)).toMatchObject({ status: 'COMPLETED' });
  }, 30000);
  it('enforces JWT realm, active platform administrator and separate Outbox read/write capabilities', async () => {
    await f.maintenanceDb.insert(systemRole).values([{ id: 91, rules: 'order.manage' }, { id: 92, rules: 'outbox.view' }]);
    await f.maintenanceDb.insert(systemAdmin).values([
      { id: 91, account: 'owned-order-manager', pwd: 'offline-native-admin-password', level: 1, roles: '91' },
      { id: 92, account: 'owned-task-reader', pwd: 'offline-native-admin-password', level: 1, roles: '92' },
      { id: 93, account: 'owned-inactive-admin', pwd: 'offline-native-admin-password', level: 0, status: 0 },
    ]);
    const [ref] = await f.maintenanceDb.execute<{ taskId: string }>(sql`SELECT task_id::text AS "taskId" FROM public.purchased_product_label_intent ORDER BY task_id LIMIT 1`);
    const path = '/admin/order/product-label-tasks', body = { confirm: 'REPLAY_PURCHASED_LABEL_TASK', reason: '受控重放' };
    expect((await (await f.raw(path)).json() as any).status).not.toBe(200);
    for (const [id,realm] of [[101,'api'],[91,'admin'],[93,'admin']] as const) expect((await admin(path,undefined,id,realm)).status).not.toBe(200);
    expect(await admin(path,undefined,92)).toMatchObject({ status: 200, data: { items: expect.any(Array) } });
    expect((await admin(path+'/'+ref!.taskId+'/replay',body,92)).status).not.toBe(200);
    expect((await admin(path,undefined,1)).data.items[0]).not.toHaveProperty('leaseToken');
    expect((await admin(path+'/'+ref!.taskId+'/replay',{ ...body, confirm: 'wrong' })).status).not.toBe(200);
  }, 30000);
  it('keeps platform labels platform-wide on a real Manager-paid financial-store order', async () => {
    await f.maintenanceDb.update(storeProduct).set({ productType: 0, freight: 2, deliveryType: '2', labelId: '9002,9003', stock: 100 }).where(eq(storeProduct.id,70));
    await f.maintenanceDb.update(storeProductAttrValue).set({ productType: 0, stock: 100 }).where(eq(storeProductAttrValue.id,1));
    const paid = await f.paid('manager',11,'7.00',1), ref = await taskFor(paid.order.id);
    expect(paid.order.storeId).toBe(1);
    expect(await service().process(ref)).toBe('completed');
    expect(await resultFor(ref.taskId)).toMatchObject({ status: 'COMPLETED', result: { financialStoreId: 1,
      targets: [{ labelId: 9002, type: 0, relationId: 0, added: true }, { labelId: 9003, type: 1, relationId: 1, added: true }] } });
  }, 30000);
  it('does not create customer-label tasks for a genuine guest cashier payment', async () => {
    const paid = await f.cashier(0,'7.00',1);
    expect(paid.order.uid).toBe(0);
    expect(await f.maintenanceDb.execute(sql`SELECT task_id FROM public.purchased_product_label_intent WHERE payment_event_id=${paid.payment.outbox!.id}`)).toHaveLength(0);
    expect(await paid.consumer.processMessage(paid.message)).toBe('already-completed');
  }, 30000);
  it('bounds eight failures and atomically resets a valid original task through authenticated DLQ replay', async () => {
    await f.maintenanceDb.insert(userLabel).values([{ id: 9040, name: '维护前外部门店', type: 1, relationId: 2 }, { id: 9041, name: '维护后平台标签' }]);
    await f.maintenanceDb.update(storeProduct).set({ labelId: '9040' }).where(eq(storeProduct.id,70));
    const paid = await f.cashier(11,'7.00',1), ref = await taskFor(paid.order.id);
    for (let attempt=1;attempt<=8;attempt++) {
      await expect(service().process(ref)).rejects.toThrow('归属');
      // Only operational retry availability is advanced on the real runtime;
      // payment, source, attempts and immutable results are never manufactured.
      if (attempt<8) await f.appRuntime.db.execute(sql`UPDATE public.purchased_product_label_state SET available_at=0 WHERE task_id=${ref.taskId}::uuid`);
    }
    expect(await resultFor(ref.taskId)).toEqual({ status: 'DEAD', result: null });
    expect((await queue(ref,9)).ack).toHaveBeenCalledOnce();
    f.env.ORDER_DLQ_NAME = 'cinashop-order-dlq';
    const wrong = { ...ref, eventKey: 'order.product.labels:1:2' };
    expect((await queue(wrong,1,f.env.ORDER_DLQ_NAME)).ack).toHaveBeenCalledOnce();
    let [archived] = await f.maintenanceDb.execute<{ id: number }>(sql`SELECT id FROM public.system_queue_dead_letter WHERE body->>'taskId'=${ref.taskId} ORDER BY id DESC LIMIT 1`);
    const body = { confirm: 'REPLAY_DEAD_LETTER', reason: '原生验收已维护归属配置' };
    expect((await admin('/admin/order/outbox/dead-letter/'+archived!.id+'/replay',body)).status).not.toBe(200);
    const [unchanged] = await f.maintenanceDb.execute(sql`SELECT status,replay_count FROM public.purchased_product_label_state WHERE task_id=${ref.taskId}::uuid`);
    expect(unchanged).toEqual({ status: 'DEAD', replay_count: 0 });
    expect((await queue(ref,1,f.env.ORDER_DLQ_NAME)).ack).toHaveBeenCalledOnce();
    [archived] = await f.maintenanceDb.execute<{ id: number }>(sql`SELECT id FROM public.system_queue_dead_letter WHERE body->>'taskId'=${ref.taskId} ORDER BY id DESC LIMIT 1`);
    await f.maintenanceDb.update(storeProduct).set({ labelId: '9041' }).where(eq(storeProduct.id,70));
    expect(await admin('/admin/order/outbox/dead-letter/'+archived!.id+'/replay',body)).toMatchObject({ status: 200 });
    expect((await queue(ref)).ack).toHaveBeenCalledOnce();
    expect(await resultFor(ref.taskId)).toMatchObject({ status: 'COMPLETED', result: { targets: [{ labelId: 9041, added: true }] } });
  }, 30000);
  it('creates one task per genuine Supplier allocation leaf from real customer checkout and wallet payment', async () => {
    await ordinary();
    await f.maintenanceDb.insert(systemAdmin).values({ id: 44, account: 'owned-supplier-label', adminType: 2, relationId: 44 });
    await f.maintenanceDb.insert(systemSupplier).values({ id: 44, adminId: 44, supplierName: '原生标签供应商' });
    await f.maintenanceDb.insert(userLabel).values([{ id: 9050, name: '平台商品标签' }, { id: 9051, name: '供应商商品平台标签' }]);
    await f.maintenanceDb.update(storeProduct).set({ labelId: '9050' }).where(eq(storeProduct.id,70));
    await f.maintenanceDb.insert(storeProduct).values({ id: 81, storeName: '原生供应商商品', type: 2, relationId: 44, stock: 20,
      price: '3.00', isShow: 1, isVerify: 1, freight: 1, deliveryType: '1', labelId: '9051' });
    await f.maintenanceDb.insert(storeProductAttrValue).values({ id: 81, productId: 81, type: 0, unique: 'supp0081', suk: '标准', stock: 20, price: '3.00' });
    const paid = await checkout([await addCart(70,'qared001'),await addCart(81,'supp0081')]);
    const tasks = await f.maintenanceDb.execute<{ taskId: string; eventKey: string; orderId: number; source: any }>(sql`SELECT task_id::text AS "taskId",event_key AS "eventKey",order_id AS "orderId",source
      FROM public.purchased_product_label_intent WHERE payment_event_id=${paid.event.id} ORDER BY order_id`);
    expect(tasks).toHaveLength(2); expect(tasks.every(t => t.orderId!==paid.order.id && t.source.paymentOrderId===paid.order.id)).toBe(true);
    expect(tasks.map(t => t.source.supplierId).sort((a,b)=>a-b)).toEqual([0,44]);
    for (const t of tasks) {
      expect(f.messages).toContainEqual({ action: 'processPurchasedProductLabels', taskId: t.taskId, eventKey: t.eventKey });
      expect((await queue({ action: 'processPurchasedProductLabels', taskId: t.taskId, eventKey: t.eventKey })).ack).toHaveBeenCalledOnce();
    }
    expect((await Promise.all(tasks.map(t => resultFor(t.taskId)))).flatMap(r => r.result.targets.map((t:any) => t.labelId)).sort()).toEqual([9050,9051]);
    const [root] = await f.maintenanceDb.execute(sql`SELECT pid,supplier_allocation_status FROM public.store_order WHERE id=${paid.order.id}`);
    expect(root?.pid).toBe(-1);
  }, 30000);
  it('unions current type5 bundle labels with each current product after a genuine package wallet payment', async () => {
    await ordinary();
    await f.maintenanceDb.insert(userLabel).values([9060,9061,9062,9063].map(id => ({ id, name: '原生套餐标签'+id })));
    await f.maintenanceDb.update(storeProduct).set({ labelId: '9060' }).where(eq(storeProduct.id,70));
    await f.maintenanceDb.insert(storeProduct).values({ id: 82, storeName: '原生套餐商品', stock: 20, price: '4.00', isShow: 1,
      isVerify: 1, freight: 1, deliveryType: '1', labelId: '9061' });
    await f.maintenanceDb.insert(storeProductAttrValue).values([
      { id: 82, productId: 82, type: 0, unique: 'base0082', suk: '标准', stock: 20, price: '4.00' },
      { id: 401, productId: 401, type: 5, unique: 'pack0401', suk: '红色,大号', stock: 20, price: '4.00' },
      { id: 402, productId: 402, type: 5, unique: 'pack0402', suk: '标准', stock: 20, price: '4.00' },
    ]);
    await f.maintenanceDb.insert(storeDiscounts).values({ id: 40, title: '原生付款套餐', type: 0, status: 1, isDel: 0, freeShipping: 1, linkIds: '9063' });
    await f.maintenanceDb.insert(storeDiscountsProducts).values([{ id: 401, discountId: 40, productId: 70 }, { id: 402, discountId: 40, productId: 82 }]);
    const carts = await new StoreDiscountService(createContainerFromDb(f.appRuntime.db)).createDirectBuyCarts(11,40,[
      { entryId: 401, productId: 70, unique: 'pack0401' }, { entryId: 402, productId: 82, unique: 'pack0402' },
    ]);
    await expect(f.appRuntime.db.execute(sql`UPDATE public.store_discounts_products SET id=id WHERE false`)).rejects.toMatchObject({ cause: { code: '42501' } });
    await f.appRuntime.db.transaction(async tx => {
      const selected = await resolveDiscountPackageSelection(createContainerFromDb(tx as unknown as import('@/lib/di').DbClient), {
        discountId: 40, selections: [{ entryId: 401, productId: 70, unique: 'pack0401' }, { entryId: 402, productId: 82, unique: 'pack0402' }],
        uniqueKind: 'package', lockRows: true,
      });
      expect(selected.items).toHaveLength(2);
      await expect(f.adminRuntime.db.transaction(peer => peer.execute(sql`SELECT id FROM public.store_discounts WHERE id=40 FOR UPDATE NOWAIT`)))
        .rejects.toMatchObject({ cause: { code: '55P03' } });
    });
    const paid = await checkout(carts.cartIds,5), ref = await taskFor(paid.order.id);
    await f.maintenanceDb.update(storeDiscounts).set({ status: 0, isDel: 1, linkIds: '9060,9062' }).where(eq(storeDiscounts.id,40));
    expect((await queue(ref)).ack).toHaveBeenCalledOnce();
    expect(await resultFor(ref.taskId)).toMatchObject({ status: 'COMPLETED', result: { bundle: { activityId: 40, found: true, linkIds: '9060,9062' },
      targets: [{ labelId: 9060, added: true }, { labelId: 9061, added: true }, { labelId: 9062, added: true }] } });
  }, 30000);
  it('includes actual physical gift carts while keeping the existing paid promotion-label effect atomic and unchanged', async () => {
    await ordinary();
    await f.maintenanceDb.insert(userLabel).values([9070,9071,9072,9073].map(id => ({ id, name: '原生赠品标签'+id })));
    await f.maintenanceDb.update(storeProduct).set({ labelId: '9071' }).where(eq(storeProduct.id,70));
    await f.maintenanceDb.insert(storeProduct).values({ id: 83, storeName: '原生实物赠品', stock: 20, isShow: 1, isVerify: 1, freight: 1, deliveryType: '1', labelId: '9072' });
    await f.maintenanceDb.insert(storeProductAttrValue).values({ id: 83, productId: 83, type: 0, unique: 'gift0083', suk: '礼盒', stock: 20 });
    const shanghai = (hours:number) => new Date(Date.now()+(hours+8)*3600000).toISOString().slice(0,19).replace('T',' ');
    await new AdminFullGiftService(createContainerFromDb(f.adminRuntime.db)).mutate('create',0,{
      name: '真实赠品购买标签', section_time: [shanghai(-1),shanghai(24)], promotions_cate: 2, threshold_type: 1,
      promotions: [{ threshold: 7, give_integral: 0, give_coupon_id: [], give_product_id: [{ give_product_id: 83, unique: 'gift0083', give_product_num: 20 }] }],
      is_label: 1, label_id: [9070], product_partake_type: 2, product_id: [{ product_id: 70, unique: ['qared001'] }],
      brand_id: [], store_label_id: [], status: 1, sort: 0, request_id: crypto.randomUUID(),
    },{ id: 1 });
    const paid = await checkout([await addCart(70,'qared001')]), ref = await taskFor(paid.order.id);
    const source = await verifyPurchasedLabelIntent((await readPurchasedLabelIntent(f.maintenanceDb,ref.taskId))!);
    expect(source.carts.map(c => ({ productId: c.productId, isGift: c.isGift })).sort((a,b)=>a.productId-b.productId))
      .toEqual([{ productId: 70, isGift: 0 },{ productId: 83, isGift: 1 }]);
    expect(await f.maintenanceDb.select().from(userLabelRelation).where(eq(userLabelRelation.labelId,9070))).toHaveLength(1);
    expect(await f.maintenanceDb.select().from(userLabelRelation).where(eq(userLabelRelation.labelId,9071))).toHaveLength(0);
    await f.maintenanceDb.update(storeProduct).set({ labelId: '9073' }).where(eq(storeProduct.id,83));
    expect((await queue(ref)).ack).toHaveBeenCalledOnce();
    expect(await resultFor(ref.taskId)).toMatchObject({ status: 'COMPLETED', result: { targets: [{ labelId: 9071, added: true }, { labelId: 9073, added: true }] } });
    expect(await f.maintenanceDb.select().from(userLabelRelation).where(eq(userLabelRelation.labelId,9070))).toHaveLength(1);
  }, 30000);
});
